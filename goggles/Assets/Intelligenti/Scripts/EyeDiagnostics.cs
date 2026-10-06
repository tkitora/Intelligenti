using System;
using System.Collections;
using System.Threading.Tasks;
using Unity.XR.XREAL;
using UnityEngine;

namespace Intelligenti
{
    /// <summary>
    /// Runtime diagnostics for XREAL Eye. It verifies 6DoF position tracking,
    /// receives RGB camera frames, reads camera calibration values, and creates
    /// a world-space target that deliberately does not follow the user's head.
    /// </summary>
    public sealed class EyeDiagnostics : MonoBehaviour
    {
        public event Action<string> StatusChanged;

        private const float WorldLockDistance = 1.5f;
        private const float StatusIntervalSeconds = 0.5f;

        private XREALRGBCameraTexture rgbCamera;
        private GameObject worldLockTarget;
        private Material worldLockMaterial;
        private XREALDeviceType deviceType = XREALDeviceType.XREAL_DEVICE_TYPE_INVALID;
        private Vector2Int rgbResolution;
        private Vector2 focalLength;
        private Vector2 principalPoint;
        private bool positionTrackingSupported;
        private bool rgbCameraSupported;
        private bool hasCameraIntrinsics;
        private bool startedRgbCapture;
        private bool ownsRgbCapture;
        private bool switchingTracking;
        private int framesInWindow;
        private int totalFrames;
        private float measuredFps;
        private float fpsWindowStartedAt;
        private float nextStatusAt;
        private float nextPoseLogAt;

        private void OnEnable()
        {
            XREALPlugin.OnTrackingTypeChanged += OnTrackingTypeChanged;
            XREALCallbackHandler.OnXREALGlassesRGBCameraPlugState += OnRgbCameraPlugStateChanged;
        }

        private void Start()
        {
            fpsWindowStartedAt = Time.realtimeSinceStartup;
            StartCoroutine(InitializeAfterXr());
        }

        private IEnumerator InitializeAfterXr()
        {
            yield return new WaitForSecondsRealtime(1.5f);

#if UNITY_EDITOR
            PlaceWorldLock();
            PublishStatus("Eye: Editor疑似動作 / 実機では6DoF・RGBを検査");
            yield break;
#else
            RefreshCapabilities();
            if (XREALPlugin.GetTrackingType() != TrackingType.MODE_6DOF && positionTrackingSupported)
                RequestSixDof();

            if (rgbCameraSupported)
                StartRgbCapture();

            PublishCurrentStatus();
#endif
        }

        private void Update()
        {
            if (worldLockMaterial != null)
            {
                float pulse = 0.78f + Mathf.Sin(Time.unscaledTime * 2.4f) * 0.22f;
                worldLockMaterial.color = new Color(0.12f * pulse, 0.95f * pulse, 1f, 1f);
            }

            if (Time.realtimeSinceStartup < nextStatusAt) return;
            nextStatusAt = Time.realtimeSinceStartup + StatusIntervalSeconds;

#if !UNITY_EDITOR
            RefreshCapabilities();
            UpdateMeasuredFps();
            PublishCurrentStatus();
            if (Time.realtimeSinceStartup >= nextPoseLogAt)
            {
                nextPoseLogAt = Time.realtimeSinceStartup + 2f;
                Camera headCamera = Camera.main;
                string pose = headCamera == null
                    ? "camera=none"
                    : $"position={headCamera.transform.position:F3} rotation={headCamera.transform.eulerAngles:F1}";
                Debug.Log($"[EyeDiagnostics] tracking={XREALPlugin.GetTrackingType()} " +
                          $"positionSupport={positionTrackingSupported} {pose}");
            }
#endif
        }

        public void PlaceWorldLock()
        {
            Camera xrCamera = Camera.main;
            if (xrCamera == null)
            {
                PublishStatus("Eye: Main Camera待機中");
                return;
            }

            if (worldLockTarget == null)
                worldLockTarget = CreateWorldLockTarget();

            Transform cameraTransform = xrCamera.transform;
            worldLockTarget.transform.SetPositionAndRotation(
                cameraTransform.position + cameraTransform.forward * WorldLockDistance,
                Quaternion.LookRotation(cameraTransform.forward, cameraTransform.up));
            worldLockTarget.SetActive(true);
        }

        public void RequestSixDof()
        {
            if (switchingTracking) return;
            _ = RequestSixDofAsync();
        }

        public void RestartRgbCapture()
        {
#if UNITY_EDITOR
            PublishStatus("Eye: RGB取得はBeam Pro実機で確認します");
#else
            StopRgbCapture();
            RefreshCapabilities();
            if (rgbCameraSupported)
                StartRgbCapture();
            else
                PublishStatus("Eye: RGBカメラが認識されていません");
#endif
        }

        private async Task RequestSixDofAsync()
        {
#if UNITY_EDITOR
            PublishStatus("Eye: Editorでは6DoF切替を実行しません");
            await Task.CompletedTask;
#else
            switchingTracking = true;
            PublishStatus("Eye: 6DoFへ切替中…");
            try
            {
                bool succeeded = await XREALPlugin.SwitchTrackingTypeAsync(TrackingType.MODE_6DOF);
                PublishStatus(succeeded ? "Eye: 6DoFへ切替完了" : "Eye: 6DoF切替に失敗");
            }
            catch (Exception exception)
            {
                Debug.LogException(exception);
                PublishStatus($"Eye: 6DoF切替エラー {exception.Message}");
            }
            finally
            {
                switchingTracking = false;
            }
#endif
        }

        private void RefreshCapabilities()
        {
            deviceType = XREALPlugin.GetDeviceType();
            positionTrackingSupported = XREALPlugin.IsHMDFeatureSupported(
                XREALSupportedFeature.XREAL_FEATURE_PERCEPTION_HEAD_TRACKING_POSITION);
            rgbCameraSupported = XREALPlugin.IsHMDFeatureSupported(
                XREALSupportedFeature.XREAL_FEATURE_RGB_CAMERA);

            if (!hasCameraIntrinsics && rgbCameraSupported)
            {
                Vector2Int resolution = Vector2Int.zero;
                Vector2 focal = Vector2.zero;
                Vector2 principal = Vector2.zero;
                bool hasResolution = XREALPlugin.GetDeviceResolution(
                    XREALComponent.XREAL_COMPONENT_RGB_CAMERA, ref resolution);
                bool hasIntrinsic = XREALPlugin.GetCameraIntrinsic(
                    XREALComponent.XREAL_COMPONENT_RGB_CAMERA, ref focal, ref principal);
                if (hasResolution && hasIntrinsic)
                {
                    rgbResolution = resolution;
                    focalLength = focal;
                    principalPoint = principal;
                    hasCameraIntrinsics = true;
                }
            }
        }

        private void StartRgbCapture()
        {
            if (startedRgbCapture) return;
            rgbCamera = XREALRGBCameraTexture.CreateSingleton();
            rgbCamera.OnRGBCameraUpdate -= OnRgbCameraFrame;
            rgbCamera.OnRGBCameraUpdate += OnRgbCameraFrame;
            if (rgbCamera.IsCapturing)
            {
                startedRgbCapture = true;
                ownsRgbCapture = false;
            }
            else
            {
                startedRgbCapture = rgbCamera.StartCapture();
                ownsRgbCapture = startedRgbCapture;
            }
            fpsWindowStartedAt = Time.realtimeSinceStartup;
            framesInWindow = 0;
            totalFrames = 0;
            if (!startedRgbCapture)
                PublishStatus("Eye: RGBカメラを開始できませんでした");
        }

        private void StopRgbCapture()
        {
            if (rgbCamera == null) return;
            rgbCamera.OnRGBCameraUpdate -= OnRgbCameraFrame;
            if (ownsRgbCapture && rgbCamera.IsCapturing)
                rgbCamera.StopCapture();
            startedRgbCapture = false;
            ownsRgbCapture = false;
        }

        private void OnRgbCameraFrame()
        {
            framesInWindow++;
            totalFrames++;
            Vector2Int latestResolution = rgbCamera.GetResolution();
            if (latestResolution.x > 0 && latestResolution.y > 0)
                rgbResolution = latestResolution;
        }

        private void UpdateMeasuredFps()
        {
            float now = Time.realtimeSinceStartup;
            float elapsed = now - fpsWindowStartedAt;
            if (elapsed < 1f) return;
            measuredFps = framesInWindow / elapsed;
            framesInWindow = 0;
            fpsWindowStartedAt = now;
        }

        private void OnTrackingTypeChanged(bool succeeded, TrackingType targetTrackingType)
        {
            PublishCurrentStatus();
        }

        private void OnRgbCameraPlugStateChanged(XREALRGBCameraPlugState state)
        {
            rgbCameraSupported = state == XREALRGBCameraPlugState.PLUGIN;
            if (rgbCameraSupported)
                StartRgbCapture();
            else
                StopRgbCapture();
            PublishCurrentStatus();
        }

        private void PublishCurrentStatus()
        {
            TrackingType trackingType = XREALPlugin.GetTrackingType();
            string tracking = trackingType == TrackingType.MODE_6DOF ? "6DoF" : trackingType.ToString();
            string camera = totalFrames > 0
                ? $"RGB {rgbResolution.x}x{rgbResolution.y} {measuredFps:0.0}fps"
                : rgbCameraSupported
                    ? startedRgbCapture ? "RGB フレーム待機" : "RGB 停止"
                    : "Eye未認識";
            string position = positionTrackingSupported ? "位置追跡OK" : "位置追跡なし";
            string calibration = hasCameraIntrinsics
                ? $"fx {focalLength.x:0} cx {principalPoint.x:0}"
                : "内部値待機";
            PublishStatus($"Eye: {deviceType} / {tracking} / {position} / {camera} / {calibration}", false);
        }

        private void PublishStatus(string message, bool writeLog = true)
        {
            if (writeLog) Debug.Log($"[EyeDiagnostics] {message}");
            StatusChanged?.Invoke(message);
        }

        private GameObject CreateWorldLockTarget()
        {
            GameObject root = new("Eye World Lock Target");
            DontDestroyOnLoad(root);

            Shader shader = Shader.Find("Unlit/Color") ?? Shader.Find("Sprites/Default") ?? Shader.Find("Standard");
            worldLockMaterial = new Material(shader)
            {
                color = new Color(0.12f, 0.95f, 1f, 1f)
            };

            const float halfWidth = 0.3f;
            const float halfHeight = 0.18f;
            const float length = 0.11f;
            const float thickness = 0.012f;
            const float depth = 0.008f;

            for (int xSign = -1; xSign <= 1; xSign += 2)
            {
                for (int ySign = -1; ySign <= 1; ySign += 2)
                {
                    CreateBar(root.transform,
                        new Vector3(xSign * (halfWidth - length * 0.5f), ySign * halfHeight, 0f),
                        new Vector3(length, thickness, depth));
                    CreateBar(root.transform,
                        new Vector3(xSign * halfWidth, ySign * (halfHeight - length * 0.5f), 0f),
                        new Vector3(thickness, length, depth));
                }
            }

            CreateBar(root.transform, Vector3.zero, new Vector3(0.024f, 0.024f, depth));
            root.SetActive(false);
            return root;
        }

        private void CreateBar(Transform parent, Vector3 localPosition, Vector3 localScale)
        {
            GameObject bar = GameObject.CreatePrimitive(PrimitiveType.Cube);
            bar.name = "World lock bracket";
            bar.transform.SetParent(parent, false);
            bar.transform.localPosition = localPosition;
            bar.transform.localScale = localScale;
            Renderer renderer = bar.GetComponent<Renderer>();
            renderer.sharedMaterial = worldLockMaterial;
            Collider collider = bar.GetComponent<Collider>();
            if (collider != null) Destroy(collider);
        }

        private void OnDisable()
        {
            XREALPlugin.OnTrackingTypeChanged -= OnTrackingTypeChanged;
            XREALCallbackHandler.OnXREALGlassesRGBCameraPlugState -= OnRgbCameraPlugStateChanged;
            StopRgbCapture();
        }

        private void OnDestroy()
        {
            if (worldLockTarget != null) Destroy(worldLockTarget);
            if (worldLockMaterial != null) Destroy(worldLockMaterial);
        }
    }
}
