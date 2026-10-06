using System;
using System.Collections;
using System.Collections.Generic;
using System.Threading.Tasks;
using Unity.XR.XREAL;
using UnityEngine;
using ZXing;
using ZXing.Common;

namespace Intelligenti
{
    /// <summary>
    /// Decodes Intelligenti shelf QR markers from the XREAL Eye luminance plane
    /// and turns each sighting into a 6DoF world-space shelf anchor.
    /// </summary>
    public sealed class ShelfMarkerTracker : MonoBehaviour
    {
        public event Action<string> StatusChanged;
        public event Action<Shelf> LocationRecognized;
        public event Action<MarkerObservation> MarkerPoseRecognized;

        private const string MarkerPrefix = "INTELLIGENTI:";
        private const float MarkerSizeMeters = 0.16f;
        private const float DecodeIntervalSeconds = 0.22f;
        private const float FinderSpanRatio = 0.72f;
        private const int AnchorLockDetectionCount = 4;
        private const float ShelfConfirmationSeconds = 1.25f;
        private const float MarkerLostSeconds = 1.2f;
        private const string LastDecodedMarkerPreference = "intelligenti.marker.lastDecoded";
        private const string LastResolvedMarkerPreference = "intelligenti.marker.lastResolved";
        private const string LastResolvedShelfPreference = "intelligenti.marker.lastShelf";
        private const string LastRecognitionTimePreference = "intelligenti.marker.lastRecognitionUtc";

        private readonly Dictionary<string, MarkerLookup> markerLookups = new();
        private readonly HashSet<string> pendingLookups = new();
        private readonly Dictionary<string, float> markerRetryAfter = new();
        private readonly Dictionary<string, string> markerLookupErrors = new();
        private readonly MultiFormatReader qrReader = new();

        private ProductApiClient apiClient;
        private XREALRGBCameraTexture rgbCamera;
        private bool ownsCapture;
        private bool decodeInFlight;
        private float nextDecodeAt;
        private Product targetProduct;
        private string visibleMarkerId = "";
        private float visibleDistance;
        private GameObject anchorRoot;
        private Transform shelfFrame;
        private Transform targetFrame;
        private Material shelfMaterial;
        private Material targetMaterial;
        private string lastStatus = "";
        private bool announcedRgbFrames;
        private int stableDetectionCount;
        private bool anchorPoseLocked;
        private float shelfFrameHideAt;
        private float lastMarkerSeenAt = -1f;
        private bool markerObservationAnnounced;

        private sealed class DecodedMarker
        {
            public string id;
            public Vector2[] points;
        }

        private readonly struct CapturedPose
        {
            public readonly Vector3 rgbPosition;
            public readonly Quaternion rgbRotation;
            public readonly Vector2 focal;
            public readonly Vector2 principal;

            public CapturedPose(Vector3 rgbPosition, Quaternion rgbRotation,
                Vector2 focal, Vector2 principal)
            {
                this.rgbPosition = rgbPosition;
                this.rgbRotation = rgbRotation;
                this.focal = focal;
                this.principal = principal;
            }
        }

        public void Initialize(ProductApiClient client)
        {
            apiClient = client;
        }

        public void SetTarget(Product product)
        {
            targetProduct = product;
            RefreshAnchorContent();
        }

        private IEnumerator Start()
        {
            yield return new WaitForSecondsRealtime(2f);
#if UNITY_EDITOR
            PublishStatus("Marker: Editor疑似動作 / Eye実機でQRを検出");
#else
            AttachToCamera();
#endif
        }

        private void AttachToCamera()
        {
            rgbCamera = XREALRGBCameraTexture.CreateSingleton();
            rgbCamera.OnRGBCameraUpdate -= OnRgbCameraFrame;
            rgbCamera.OnRGBCameraUpdate += OnRgbCameraFrame;
            if (!rgbCamera.IsCapturing)
            {
                ownsCapture = rgbCamera.StartCapture();
                if (!ownsCapture)
                    PublishStatus("Marker: Eye RGBを開始できません");
            }
            PublishStatus("Marker: 棚マーカーを探索中");
        }

        private async void OnRgbCameraFrame()
        {
            if (!announcedRgbFrames)
            {
                announcedRgbFrames = true;
                PublishStatus("Marker: Eye RGB受信 / QR探索中");
            }
            if (decodeInFlight || Time.realtimeSinceStartup < nextDecodeAt)
                return;
            nextDecodeAt = Time.realtimeSinceStartup + DecodeIntervalSeconds;

            Texture2D[] textures = rgbCamera.GetYUVFormatTextures();
            Texture2D luminance = textures != null && textures.Length > 0 ? textures[0] : null;
            if (luminance == null || luminance.width <= 0 || luminance.height <= 0)
                return;
            if (!TryCapturePose(out CapturedPose capturedPose))
                return;

            byte[] frame = new byte[luminance.width * luminance.height];
            var raw = luminance.GetRawTextureData<byte>();
            if (raw.Length < frame.Length) return;
            raw.CopyTo(frame);

            decodeInFlight = true;
            try
            {
                DecodedMarker decoded = await Task.Run(() =>
                    Decode(frame, luminance.width, luminance.height));
                if (decoded != null)
                    ApplyDetection(decoded, capturedPose);
            }
            catch (Exception exception)
            {
                Debug.LogWarning($"[ShelfMarkerTracker] Decode failed: {exception.Message}");
            }
            finally
            {
                decodeInFlight = false;
            }
        }

        private bool TryCapturePose(out CapturedPose capturedPose)
        {
            capturedPose = default;
            Camera headCamera = Camera.main;
            if (headCamera == null) return false;

            Vector2 focal = Vector2.zero;
            Vector2 principal = Vector2.zero;
            Pose rgbFromHead = Pose.identity;
            bool hasIntrinsics = XREALPlugin.GetCameraIntrinsic(
                XREALComponent.XREAL_COMPONENT_RGB_CAMERA, ref focal, ref principal);
            bool hasExtrinsics = XREALPlugin.GetDevicePoseFromHead(
                XREALComponent.XREAL_COMPONENT_RGB_CAMERA, ref rgbFromHead);
            if (!hasIntrinsics || !hasExtrinsics || focal.x <= 0f || focal.y <= 0f)
                return false;

            Transform head = headCamera.transform;
            Vector3 rgbPosition = head.TransformPoint(rgbFromHead.position);
            Quaternion rgbRotation = head.rotation * rgbFromHead.rotation;
            capturedPose = new CapturedPose(rgbPosition, rgbRotation, focal, principal);
            return true;
        }

        private DecodedMarker Decode(byte[] frame, int width, int height)
        {
            LuminanceSource source = new PlanarYUVLuminanceSource(
                frame, width, height, 0, 0, width, height, false);
            BinaryBitmap bitmap = new(new HybridBinarizer(source));
            var hints = new Dictionary<DecodeHintType, object>
            {
                { DecodeHintType.POSSIBLE_FORMATS, new List<BarcodeFormat> { BarcodeFormat.QR_CODE } },
                { DecodeHintType.TRY_HARDER, true },
                { DecodeHintType.CHARACTER_SET, "UTF-8" },
            };
            Result result = qrReader.decode(bitmap, hints);
            qrReader.reset();
            if (result == null || !TryParseMarkerId(result.Text, out string markerId) ||
                result.ResultPoints == null || result.ResultPoints.Length < 3)
                return null;

            Vector2[] points = new Vector2[result.ResultPoints.Length];
            for (int i = 0; i < points.Length; i++)
                points[i] = new Vector2(result.ResultPoints[i].X, result.ResultPoints[i].Y);
            return new DecodedMarker { id = markerId, points = points };
        }

        private static bool TryParseMarkerId(string payload, out string markerId)
        {
            markerId = "";
            if (string.IsNullOrWhiteSpace(payload) ||
                !payload.StartsWith(MarkerPrefix, StringComparison.OrdinalIgnoreCase))
                return false;
            string candidate = payload.Substring(MarkerPrefix.Length).Trim().ToUpperInvariant();
            if (candidate.Length == 0 || candidate.Length > 64) return false;
            foreach (char character in candidate)
            {
                if (!(character is >= 'A' and <= 'Z') &&
                    !(character is >= '0' and <= '9') && character != '-' && character != '_')
                    return false;
            }
            markerId = candidate;
            return true;
        }

        private void ApplyDetection(DecodedMarker decoded, CapturedPose capturedPose)
        {
            if (!TryEstimatePose(decoded.points, capturedPose,
                    out Vector3 position, out Quaternion rotation, out float distance))
                return;

            EnsureAnchorVisual();
            bool sameMarker = visibleMarkerId == decoded.id && anchorRoot.activeSelf;
            if (!sameMarker)
            {
                anchorRoot.transform.SetPositionAndRotation(position, rotation);
                stableDetectionCount = 1;
                anchorPoseLocked = false;
                markerObservationAnnounced = false;
                shelfFrame.gameObject.SetActive(true);
                shelfFrameHideAt = Time.realtimeSinceStartup + ShelfConfirmationSeconds;
                PersistDecodedMarker(decoded.id);
                Debug.Log($"[ShelfMarkerTracker] QR decoded: {decoded.id}");
            }
            else if (!anchorPoseLocked)
            {
                anchorRoot.transform.SetPositionAndRotation(
                    Vector3.Lerp(anchorRoot.transform.position, position, 0.32f),
                    Quaternion.Slerp(anchorRoot.transform.rotation, rotation, 0.32f));
                stableDetectionCount++;
                anchorPoseLocked = stableDetectionCount >= AnchorLockDetectionCount;
            }
            anchorRoot.SetActive(true);
            visibleMarkerId = decoded.id;
            visibleDistance = distance;
            lastMarkerSeenAt = Time.realtimeSinceStartup;

            RequestMarkerLookup(decoded.id);
            if (!sameMarker && markerLookups.TryGetValue(decoded.id, out MarkerLookup cachedLookup))
                ConfirmLocation(decoded.id, cachedLookup);
            TryAnnounceMarkerObservation(decoded.id);
            RefreshAnchorContent();
        }

        private void Update()
        {
            if (shelfFrame != null && shelfFrame.gameObject.activeSelf &&
                shelfFrameHideAt > 0f && Time.realtimeSinceStartup >= shelfFrameHideAt)
            {
                shelfFrame.gameObject.SetActive(false);
                shelfFrameHideAt = 0f;
            }

            // The confirmation frame is intentionally short-lived, but the marker
            // recognition state must also be released after the QR leaves view.
            // Otherwise the same physical marker can only be confirmed once per app run.
            if (!string.IsNullOrWhiteSpace(visibleMarkerId) && lastMarkerSeenAt >= 0f &&
                Time.realtimeSinceStartup - lastMarkerSeenAt >= MarkerLostSeconds)
            {
                Debug.Log($"[ShelfMarkerTracker] QR lost: {visibleMarkerId}; re-armed");
                visibleMarkerId = "";
                visibleDistance = 0f;
                stableDetectionCount = 0;
                anchorPoseLocked = false;
                markerObservationAnnounced = false;
                lastMarkerSeenAt = -1f;
                shelfFrameHideAt = 0f;
                if (anchorRoot != null) anchorRoot.SetActive(false);
                PublishStatus("Marker: 棚マーカーを探索中");
            }
        }

        private static bool TryEstimatePose(Vector2[] points, CapturedPose camera,
            out Vector3 position, out Quaternion rotation, out float distance)
        {
            position = Vector3.zero;
            rotation = Quaternion.identity;
            distance = 0f;
            if (points == null || points.Length < 3) return false;

            // ZXing may append an alignment-pattern point for larger QR codes.
            // Pose geometry must use the first three finder-pattern points only.
            int geometryPointCount = Mathf.Min(3, points.Length);
            float minX = float.MaxValue;
            float maxX = float.MinValue;
            float minY = float.MaxValue;
            float maxY = float.MinValue;
            List<float> pairDistances = new();
            for (int i = 0; i < geometryPointCount; i++)
            {
                minX = Mathf.Min(minX, points[i].x);
                maxX = Mathf.Max(maxX, points[i].x);
                minY = Mathf.Min(minY, points[i].y);
                maxY = Mathf.Max(maxY, points[i].y);
                for (int j = i + 1; j < geometryPointCount; j++)
                    pairDistances.Add(Vector2.Distance(points[i], points[j]));
            }
            pairDistances.Sort();
            if (pairDistances.Count < 2 || pairDistances[0] < 8f) return false;
            float finderPixelSpan = (pairDistances[0] + pairDistances[1]) * 0.5f;
            float averageFocal = (camera.focal.x + camera.focal.y) * 0.5f;
            distance = Mathf.Clamp(
                averageFocal * (MarkerSizeMeters * FinderSpanRatio) / finderPixelSpan,
                0.25f, 5f);

            Vector2 center = new((minX + maxX) * 0.5f, (minY + maxY) * 0.5f);
            Vector3 cameraPoint = new(
                (center.x - camera.principal.x) / camera.focal.x * distance,
                -(center.y - camera.principal.y) / camera.focal.y * distance,
                distance);
            position = camera.rgbPosition + camera.rgbRotation * cameraPoint;

            Vector3 topLeft = CameraPixelToWorld(points[1], distance, camera);
            Vector3 bottomLeft = CameraPixelToWorld(points[0], distance, camera);
            Vector3 topRight = CameraPixelToWorld(points[2], distance, camera);
            // The XREAL Eye luminance plane is vertically inverted relative to
            // the RGB camera pose coordinates. Correct the marker's local up
            // axis so labels and shelf offsets are not rendered upside down.
            Vector3 up = (bottomLeft - topLeft).normalized;
            Vector3 right = (topRight - topLeft).normalized;
            Vector3 awayFromCamera = (position - camera.rgbPosition).normalized;
            Vector3 planeNormal = Vector3.Cross(right, up).normalized;
            if (up.sqrMagnitude < 0.5f || right.sqrMagnitude < 0.5f ||
                planeNormal.sqrMagnitude < 0.5f || awayFromCamera.sqrMagnitude < 0.5f)
                return false;
            // Keep local +Z behind the printed face. Local -Z is therefore the
            // QR's physical front direction used to align the store map.
            if (Vector3.Dot(planeNormal, awayFromCamera) < 0f)
                planeNormal = -planeNormal;
            rotation = Quaternion.LookRotation(planeNormal, up);
            return true;
        }

        private static Vector3 CameraPixelToWorld(Vector2 point, float distance,
            CapturedPose camera)
        {
            Vector3 cameraPoint = new(
                (point.x - camera.principal.x) / camera.focal.x * distance,
                -(point.y - camera.principal.y) / camera.focal.y * distance,
                distance);
            return camera.rgbPosition + camera.rgbRotation * cameraPoint;
        }

        private void RequestMarkerLookup(string markerId)
        {
            if (apiClient == null || markerLookups.ContainsKey(markerId) ||
                pendingLookups.Contains(markerId)) return;
            if (markerRetryAfter.TryGetValue(markerId, out float retryAt) &&
                Time.realtimeSinceStartup < retryAt) return;

            markerRetryAfter.Remove(markerId);
            markerLookupErrors.Remove(markerId);
            pendingLookups.Add(markerId);
            apiClient.GetMarker(markerId,
                lookup =>
                {
                    pendingLookups.Remove(markerId);
                    markerRetryAfter.Remove(markerId);
                    markerLookupErrors.Remove(markerId);
                    markerLookups[markerId] = lookup;
                    if (visibleMarkerId == markerId)
                    {
                        ConfirmLocation(markerId, lookup);
                        RefreshAnchorContent();
                    }
                },
                error =>
                {
                    pendingLookups.Remove(markerId);
                    markerRetryAfter[markerId] = Time.realtimeSinceStartup + 5f;
                    markerLookupErrors[markerId] = error;
                    if (visibleMarkerId == markerId) PublishStatus($"Marker: {error}");
                });
        }

        private void ConfirmLocation(string markerId, MarkerLookup lookup)
        {
            if (lookup?.shelf == null) return;
            PlayerPrefs.SetString(LastResolvedMarkerPreference, markerId);
            PlayerPrefs.SetString(LastResolvedShelfPreference, lookup.shelf.id ?? "");
            PlayerPrefs.SetString(LastRecognitionTimePreference, DateTime.UtcNow.ToString("O"));
            PlayerPrefs.Save();
            Debug.Log($"[ShelfMarkerTracker] Marker resolved: {markerId} -> {lookup.shelf.id}");
            LocationRecognized?.Invoke(lookup.shelf);
            TryAnnounceMarkerObservation(markerId);
        }

        private void TryAnnounceMarkerObservation(string markerId)
        {
            if (markerObservationAnnounced || !anchorPoseLocked ||
                anchorRoot == null || !anchorRoot.activeSelf ||
                !string.Equals(visibleMarkerId, markerId,
                    StringComparison.OrdinalIgnoreCase) ||
                !markerLookups.TryGetValue(markerId, out MarkerLookup lookup) ||
                lookup?.shelf == null)
                return;

            Camera headCamera = Camera.main;
            if (headCamera == null) return;
            Vector3 scanForward = Vector3.ProjectOnPlane(
                headCamera.transform.forward, Vector3.up).normalized;
            if (scanForward.sqrMagnitude < 0.5f) return;
            markerObservationAnnounced = true;
            MarkerPoseRecognized?.Invoke(new MarkerObservation
            {
                markerId = markerId,
                shelf = lookup.shelf,
                scanPosition = headCamera.transform.position,
                scanForward = scanForward,
            });
            Debug.Log($"[ShelfMarkerTracker] Scan pose captured: {markerId} / " +
                      $"position={headCamera.transform.position:F2} / " +
                      $"forward={scanForward:F2}");
        }

        private static void PersistDecodedMarker(string markerId)
        {
            PlayerPrefs.SetString(LastDecodedMarkerPreference, markerId);
            PlayerPrefs.SetString(LastRecognitionTimePreference, DateTime.UtcNow.ToString("O"));
            PlayerPrefs.Save();
        }

        private void RefreshAnchorContent()
        {
            if (anchorRoot == null || string.IsNullOrWhiteSpace(visibleMarkerId)) return;
            markerLookups.TryGetValue(visibleMarkerId, out MarkerLookup lookup);
            bool isTarget = targetProduct != null &&
                string.Equals(targetProduct.markerId, visibleMarkerId,
                    StringComparison.OrdinalIgnoreCase);
            Vector3 offset = isTarget && targetProduct.shelfOffset != null
                ? new Vector3(targetProduct.shelfOffset.x, targetProduct.shelfOffset.y,
                    targetProduct.shelfOffset.z)
                : Vector3.zero;
            shelfFrame.localPosition = Vector3.zero;
            shelfFrame.localScale = Vector3.one;
            targetFrame.gameObject.SetActive(isTarget);
            targetFrame.localPosition = offset;
            targetFrame.localScale = Vector3.one * 1.2f;

            string mapping;
            if (lookup?.shelf != null)
                mapping = $"{visibleMarkerId} -> {lookup.shelf.id}";
            else if (markerLookupErrors.TryGetValue(visibleMarkerId, out string lookupError) &&
                     markerRetryAfter.TryGetValue(visibleMarkerId, out float retryAt) &&
                     Time.realtimeSinceStartup < retryAt)
                mapping = lookupError;
            else
                mapping = $"{visibleMarkerId} / DB確認中";
            string target = isTarget ? $" / 対象 {targetProduct.id}" : "";
            PublishStatus($"Marker: {mapping} / {visibleDistance:0.00}m{target}");
        }

        private void EnsureAnchorVisual()
        {
            if (anchorRoot != null) return;
            anchorRoot = new GameObject("Intelligenti Shelf Marker Anchor");
            DontDestroyOnLoad(anchorRoot);
            shelfMaterial = CreateMaterial(new Color(0.12f, 0.95f, 1f, 1f));
            targetMaterial = CreateMaterial(new Color(1f, 0.36f, 0.12f, 1f));

            GameObject shelf = new("Shelf marker frame");
            shelf.transform.SetParent(anchorRoot.transform, false);
            shelfFrame = shelf.transform;
            CreateFrameBars(shelfFrame, shelfMaterial, 0.105f, 0.105f);

            GameObject target = new("Product target frame");
            target.transform.SetParent(anchorRoot.transform, false);
            targetFrame = target.transform;
            CreateFrameBars(targetFrame, targetMaterial, 0.09f, 0.065f);
            targetFrame.gameObject.SetActive(false);

            anchorRoot.SetActive(false);
        }

        private static Material CreateMaterial(Color color)
        {
            Shader shader = Shader.Find("Unlit/Color") ?? Shader.Find("Sprites/Default") ??
                            Shader.Find("Standard");
            return new Material(shader) { color = color };
        }

        private static void CreateFrameBars(Transform parent, Material material,
            float halfWidth, float halfHeight)
        {
            const float thickness = 0.008f;
            CreateBar(parent, new Vector3(0f, halfHeight, 0f),
                new Vector3(halfWidth * 2f, thickness, thickness), material);
            CreateBar(parent, new Vector3(0f, -halfHeight, 0f),
                new Vector3(halfWidth * 2f, thickness, thickness), material);
            CreateBar(parent, new Vector3(-halfWidth, 0f, 0f),
                new Vector3(thickness, halfHeight * 2f, thickness), material);
            CreateBar(parent, new Vector3(halfWidth, 0f, 0f),
                new Vector3(thickness, halfHeight * 2f, thickness), material);
        }

        private static void CreateBar(Transform parent, Vector3 position,
            Vector3 scale, Material material)
        {
            GameObject bar = GameObject.CreatePrimitive(PrimitiveType.Cube);
            bar.name = "AR shelf bracket";
            bar.transform.SetParent(parent, false);
            bar.transform.localPosition = position;
            bar.transform.localScale = scale;
            bar.GetComponent<Renderer>().sharedMaterial = material;
            Collider collider = bar.GetComponent<Collider>();
            if (collider != null) Destroy(collider);
        }

        private void PublishStatus(string message)
        {
            if (lastStatus == message) return;
            lastStatus = message;
            Debug.Log($"[ShelfMarkerTracker] {message}");
            StatusChanged?.Invoke(message);
        }

        private void OnDisable()
        {
            if (rgbCamera != null)
            {
                rgbCamera.OnRGBCameraUpdate -= OnRgbCameraFrame;
                if (ownsCapture && rgbCamera.IsCapturing) rgbCamera.StopCapture();
            }
            ownsCapture = false;
        }

        private void OnDestroy()
        {
            if (anchorRoot != null) Destroy(anchorRoot);
            if (shelfMaterial != null) Destroy(shelfMaterial);
            if (targetMaterial != null) Destroy(targetMaterial);
        }
    }
}
