using System;
using System.Collections.Generic;
using UnityEngine;

namespace Intelligenti
{
    /// <summary>
    /// Anchors the two-dimensional store route to the shopper pose captured
    /// when a physical location QR is recognized.
    /// XREAL 6DoF then supplies the shopper's live position between QR checks.
    /// Guidance is intentionally head-locked; it stays readable without needing
    /// an unreliable estimate of the store floor height.
    /// </summary>
    public sealed class NavigationGuide : MonoBehaviour
    {
        private const float WaypointReachedMeters = 0.65f;
        private const float DestinationReachedMeters = 0.85f;
        private const float RefreshIntervalSeconds = 0.12f;
        private const float BeaconHeightMeters = 0.72f;

        private readonly List<Vector3> worldPoints = new();
        private ProductHud hud;
        private Camera headCamera;
        private Transform directionBeacon;
        private Transform beaconPulse;
        private Material beaconOrangeMaterial;
        private Material beaconCyanMaterial;
        private int nextWaypointIndex;
        private float nextRefreshAt;
        private string destinationLabel = "目的の棚";
        private string lastMessage = "";
        private bool active;

        public void Initialize(ProductHud productHud)
        {
            hud = productHud;
        }

        public bool BeginRoute(NavigationRoute route, MarkerObservation observation,
            string label, out string error)
        {
            error = "";
            if (route?.startMarker?.position == null || route.points == null ||
                route.points.Length < 2 || observation == null)
            {
                error = "経路データを利用できません";
                return false;
            }

            Vector3 scanForward = Vector3.ProjectOnPlane(
                observation.scanForward, Vector3.up).normalized;
            if (scanForward.sqrMagnitude < 0.5f)
            {
                error = "読み取り時の向きを取得できません。QRを見て読み直してください";
                return false;
            }

            Vector3 worldRight = Vector3.Cross(Vector3.up, scanForward).normalized;
            float rotation = route.startMarker.rotationDegrees * Mathf.Deg2Rad;
            Vector2 mapForward = new(Mathf.Sin(rotation), -Mathf.Cos(rotation));
            Vector2 mapRight = new(Mathf.Cos(rotation), Mathf.Sin(rotation));
            Vector2 mapOrigin = new(
                route.startMarker.position.x, route.startMarker.position.y);

            List<Vector3> converted = new();
            foreach (MapPoint point in route.points)
            {
                if (point == null) continue;
                Vector2 delta = new(point.x - mapOrigin.x, point.y - mapOrigin.y);
                float rightMeters = Vector2.Dot(delta, mapRight);
                float forwardMeters = Vector2.Dot(delta, mapForward);
                converted.Add(observation.scanPosition +
                              worldRight * rightMeters + scanForward * forwardMeters);
            }

            worldPoints.Clear();
            worldPoints.AddRange(Simplify(converted));
            if (worldPoints.Count < 2)
            {
                error = "経路の長さが不足しています";
                return false;
            }

            headCamera = Camera.main;
            nextWaypointIndex = FindClosestSegment(
                headCamera != null ? headCamera.transform.position : observation.scanPosition) + 1;
            nextWaypointIndex = Mathf.Clamp(nextWaypointIndex, 1, worldPoints.Count - 1);
            destinationLabel = string.IsNullOrWhiteSpace(label) ? "目的の棚" : label;
            lastMessage = "";
            active = true;
            nextRefreshAt = 0f;
            EnsureDirectionBeacon();
            MoveBeaconToCurrentWaypoint();
            Debug.Log($"[NavigationGuide] Route anchored at {observation.markerId}: " +
                      $"{worldPoints.Count} waypoints / {route.distanceMeters:0.0}m / " +
                      $"scanForward={scanForward:F2}");
            RefreshGuidance();
            return true;
        }

        public void Clear()
        {
            active = false;
            worldPoints.Clear();
            nextWaypointIndex = 0;
            lastMessage = "";
            SetBeaconVisible(false);
            hud?.ClearNavigation();
        }

        private void Update()
        {
            if (!active || Time.realtimeSinceStartup < nextRefreshAt) return;
            nextRefreshAt = Time.realtimeSinceStartup + RefreshIntervalSeconds;
            RefreshGuidance();
            AnimateBeacon();
        }

        private void RefreshGuidance()
        {
            if (!active || worldPoints.Count < 2) return;
            if (headCamera == null) headCamera = Camera.main;
            if (headCamera == null) return;

            Vector3 position = headCamera.transform.position;
            int previousWaypoint = nextWaypointIndex;
            while (nextWaypointIndex < worldPoints.Count - 1 &&
                   HorizontalDistance(position, worldPoints[nextWaypointIndex]) <=
                   WaypointReachedMeters)
                nextWaypointIndex++;
            if (nextWaypointIndex != previousWaypoint) MoveBeaconToCurrentWaypoint();

            Vector3 target = worldPoints[nextWaypointIndex];
            float waypointDistance = HorizontalDistance(position, target);
            bool finalWaypoint = nextWaypointIndex == worldPoints.Count - 1;
            if (finalWaypoint && waypointDistance <= DestinationReachedMeters)
            {
                active = false;
                SetBeaconVisible(false);
                string arrived = $"✓ {destinationLabel}に到着しました";
                lastMessage = arrived;
                hud?.ShowNavigation(arrived, true);
                return;
            }

            Vector3 direction = Vector3.ProjectOnPlane(target - position, Vector3.up);
            Vector3 viewForward = Vector3.ProjectOnPlane(
                headCamera.transform.forward, Vector3.up).normalized;
            if (direction.sqrMagnitude < 0.01f || viewForward.sqrMagnitude < 0.5f) return;

            float angle = Vector3.SignedAngle(viewForward, direction.normalized, Vector3.up);
            string instruction = DirectionInstruction(angle);
            float remaining = waypointDistance;
            for (int index = nextWaypointIndex + 1; index < worldPoints.Count; index++)
                remaining += HorizontalDistance(worldPoints[index - 1], worldPoints[index]);

            string message = $"{instruction}　残り約{FormatDistance(remaining)}m　{destinationLabel}";
            if (message == lastMessage) return;
            lastMessage = message;
            hud?.ShowNavigation(message, false);
        }

        private void EnsureDirectionBeacon()
        {
            if (directionBeacon != null) return;

            GameObject root = new("Intelligenti route direction beacon");
            directionBeacon = root.transform;
            DontDestroyOnLoad(root);
            beaconOrangeMaterial = CreateMaterial(new Color(1f, 0.34f, 0.08f, 1f));
            beaconCyanMaterial = CreateMaterial(new Color(0.15f, 0.93f, 1f, 1f));

            CreateBeaconPrimitive(PrimitiveType.Cylinder, directionBeacon,
                new Vector3(0f, 0f, 0f), new Vector3(0.035f, BeaconHeightMeters * 0.5f, 0.035f),
                beaconOrangeMaterial, "Route beacon column");
            CreateBeaconPrimitive(PrimitiveType.Sphere, directionBeacon,
                new Vector3(0f, 0.28f, 0f), Vector3.one * 0.20f,
                beaconOrangeMaterial, "Route beacon core");

            GameObject pulse = GameObject.CreatePrimitive(PrimitiveType.Sphere);
            pulse.name = "Route beacon pulse";
            pulse.transform.SetParent(directionBeacon, false);
            pulse.transform.localPosition = new Vector3(0f, 0.28f, 0f);
            pulse.transform.localScale = Vector3.one * 0.28f;
            pulse.GetComponent<Renderer>().sharedMaterial = beaconCyanMaterial;
            Collider collider = pulse.GetComponent<Collider>();
            if (collider != null) Destroy(collider);
            beaconPulse = pulse.transform;
            root.SetActive(false);
        }

        private void MoveBeaconToCurrentWaypoint()
        {
            if (directionBeacon == null || nextWaypointIndex < 0 ||
                nextWaypointIndex >= worldPoints.Count) return;
            Vector3 target = worldPoints[nextWaypointIndex];
            float eyeHeight = headCamera != null
                ? headCamera.transform.position.y
                : target.y;
            directionBeacon.position = new Vector3(target.x, eyeHeight - 0.22f, target.z);
            SetBeaconVisible(true);
        }

        private void AnimateBeacon()
        {
            if (beaconPulse == null || directionBeacon == null ||
                !directionBeacon.gameObject.activeSelf) return;
            float pulse = 0.82f + (Mathf.Sin(Time.realtimeSinceStartup * 5f) + 1f) * 0.22f;
            beaconPulse.localScale = Vector3.one * (0.28f * pulse);
            directionBeacon.Rotate(Vector3.up, 42f * RefreshIntervalSeconds, Space.World);
        }

        private void SetBeaconVisible(bool visible)
        {
            if (directionBeacon != null) directionBeacon.gameObject.SetActive(visible);
        }

        private static Material CreateMaterial(Color color)
        {
            Shader shader = Shader.Find("Unlit/Color") ?? Shader.Find("Sprites/Default") ??
                            Shader.Find("Standard");
            return new Material(shader) { color = color };
        }

        private static void CreateBeaconPrimitive(PrimitiveType type, Transform parent,
            Vector3 localPosition, Vector3 localScale, Material material, string objectName)
        {
            GameObject shape = GameObject.CreatePrimitive(type);
            shape.name = objectName;
            shape.transform.SetParent(parent, false);
            shape.transform.localPosition = localPosition;
            shape.transform.localScale = localScale;
            shape.GetComponent<Renderer>().sharedMaterial = material;
            Collider collider = shape.GetComponent<Collider>();
            if (collider != null) Destroy(collider);
        }

        private int FindClosestSegment(Vector3 position)
        {
            int closest = 0;
            float bestDistance = float.PositiveInfinity;
            for (int index = 0; index < worldPoints.Count - 1; index++)
            {
                float distance = DistanceToHorizontalSegment(
                    position, worldPoints[index], worldPoints[index + 1]);
                if (distance >= bestDistance) continue;
                bestDistance = distance;
                closest = index;
            }
            return closest;
        }

        private static List<Vector3> Simplify(List<Vector3> source)
        {
            List<Vector3> unique = new();
            foreach (Vector3 point in source)
            {
                if (unique.Count == 0 ||
                    HorizontalDistance(unique[unique.Count - 1], point) >= 0.08f)
                    unique.Add(point);
            }

            for (int index = unique.Count - 2; index > 0; index--)
            {
                Vector3 incoming = Vector3.ProjectOnPlane(
                    unique[index] - unique[index - 1], Vector3.up);
                Vector3 outgoing = Vector3.ProjectOnPlane(
                    unique[index + 1] - unique[index], Vector3.up);
                if (incoming.sqrMagnitude > 0.01f && outgoing.sqrMagnitude > 0.01f &&
                    Vector3.Angle(incoming, outgoing) < 7f)
                    unique.RemoveAt(index);
            }
            return unique;
        }

        private static float DistanceToHorizontalSegment(
            Vector3 point, Vector3 start, Vector3 end)
        {
            Vector2 p = new(point.x, point.z);
            Vector2 a = new(start.x, start.z);
            Vector2 b = new(end.x, end.z);
            Vector2 segment = b - a;
            float lengthSquared = segment.sqrMagnitude;
            if (lengthSquared < 0.0001f) return Vector2.Distance(p, a);
            float amount = Mathf.Clamp01(Vector2.Dot(p - a, segment) / lengthSquared);
            return Vector2.Distance(p, a + segment * amount);
        }

        private static float HorizontalDistance(Vector3 one, Vector3 two)
        {
            return Vector2.Distance(new Vector2(one.x, one.z), new Vector2(two.x, two.z));
        }

        private static string DirectionInstruction(float angle)
        {
            float absolute = Mathf.Abs(angle);
            if (absolute < 18f) return "↑ まっすぐ";
            if (absolute < 52f) return angle > 0f ? "↗ 右前へ" : "↖ 左前へ";
            if (absolute < 132f) return angle > 0f ? "→ 右へ" : "← 左へ";
            return "↓ 後ろへ";
        }

        private static string FormatDistance(float meters)
        {
            return meters < 10f ? meters.ToString("0.0") : meters.ToString("0");
        }

        private void OnDestroy()
        {
            if (directionBeacon != null) Destroy(directionBeacon.gameObject);
            if (beaconOrangeMaterial != null) Destroy(beaconOrangeMaterial);
            if (beaconCyanMaterial != null) Destroy(beaconCyanMaterial);
        }
    }
}
