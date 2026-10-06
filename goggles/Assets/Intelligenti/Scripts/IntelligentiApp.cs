using System.Collections;
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.InputSystem.XR;

namespace Intelligenti
{
    public sealed class IntelligentiApp : MonoBehaviour
    {
        private IntelligentiConfig config;
        private ProductApiClient apiClient;
        private ProductHud hud;
        private MqttSubscriber mqtt;
        private ReaderBleClient ble;
        private EyeDiagnostics eye;
        private ShelfMarkerTracker markerTracker;
        private NavigationGuide navigationGuide;
        private string selectedProductId = "PRD-00000001";
        private string currentProductId = "";
        private Product currentProduct;
        private long currentTargetVersion;
        private int routeRequestVersion;

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        private static void Bootstrap()
        {
            if (FindFirstObjectByType<IntelligentiApp>() != null) return;
            GameObject root = new("Intelligenti Runtime");
            DontDestroyOnLoad(root);
            root.AddComponent<IntelligentiApp>();
        }

        private void Awake()
        {
            EnsureHeadPoseDriver();
            config = IntelligentiConfig.Load();
            hud = gameObject.AddComponent<ProductHud>();
            mqtt = gameObject.AddComponent<MqttSubscriber>();
            eye = gameObject.AddComponent<EyeDiagnostics>();
            markerTracker = gameObject.AddComponent<ShelfMarkerTracker>();
            navigationGuide = gameObject.AddComponent<NavigationGuide>();
            apiClient = new ProductApiClient(
                this, config.apiBaseUrl, config.goggleApiKey);
            markerTracker.Initialize(apiClient);
            navigationGuide.Initialize(hud);

            mqtt.MessageReceived += OnMqttMessage;
            mqtt.ConnectionChanged += (connected, message) => hud.SetConnection(message);
            eye.StatusChanged += status => hud.SetEye(status);
            markerTracker.StatusChanged += status => hud.SetMarker(status);
            markerTracker.LocationRecognized += shelf => hud.ShowLocationConfirmed(shelf);
            markerTracker.MarkerPoseRecognized += OnMarkerPoseRecognized;

            // The production reader posts scans to the server. The goggles do
            // not connect to that reader over BLE; BLE remains an Editor-only
            // diagnostic/tag-writing tool.
            if (Application.isEditor)
            {
                ble = gameObject.AddComponent<ReaderBleClient>();
                ble.StatusReceived += status => hud.SetReader(status);
                ble.ErrorReceived += error => hud.SetReader($"BLE error: {error}");
                ble.Initialize();
            }

            hud.SetConnection("商品タグの読み取り待ち");
            if (!string.IsNullOrWhiteSpace(config.mqttHost))
                mqtt.StartClient(config);
            StartCoroutine(PollGoggleTarget());
        }

        private static void EnsureHeadPoseDriver()
        {
            Camera headCamera = Camera.main;
            if (headCamera == null || headCamera.GetComponent<TrackedPoseDriver>() != null)
                return;

            TrackedPoseDriver driver = headCamera.gameObject.AddComponent<TrackedPoseDriver>();
            driver.trackingType = TrackedPoseDriver.TrackingType.RotationAndPosition;
            driver.updateType = TrackedPoseDriver.UpdateType.UpdateAndBeforeRender;
            driver.ignoreTrackingState = false;

            InputAction position = new(
                "Head Position", InputActionType.Value,
                "<XRHMD>/centerEyePosition", expectedControlType: "Vector3");
            InputAction rotation = new(
                "Head Rotation", InputActionType.Value,
                "<XRHMD>/centerEyeRotation", expectedControlType: "Quaternion");
            InputAction trackingState = new(
                "Head Tracking State", InputActionType.Value,
                "<XRHMD>/trackingState", expectedControlType: "Integer");
            driver.positionInput = new InputActionProperty(position);
            driver.rotationInput = new InputActionProperty(rotation);
            driver.trackingStateInput = new InputActionProperty(trackingState);
            Debug.Log("[Intelligenti] Main Camera TrackedPoseDriver: rotation + position");
        }

        private void OnMqttMessage(string topic, string payload)
        {
            if (!string.IsNullOrWhiteSpace(config.targetTopic) && topic == config.targetTopic)
            {
                if (string.IsNullOrWhiteSpace(payload))
                {
                    ClearProduct();
                    hud.SetConnection("リセットタグを受信 / 商品タグの読み取り待ち");
                    return;
                }
                Product target = JsonUtility.FromJson<Product>(payload);
                if (target != null && !string.IsNullOrWhiteSpace(target.id))
                {
                    selectedProductId = target.id;
                    ApplyProduct(target);
                    hud.SetConnection("案内対象を受信 / 最新位置を取得中");
                    // Retained MQTT messages from older servers may not contain
                    // markerId or shelfOffset. Always enrich them through REST.
                    LoadProduct(target.id);
                }
                return;
            }

            ScanMessage scan = JsonUtility.FromJson<ScanMessage>(payload);
            if (scan == null || string.IsNullOrWhiteSpace(scan.productId))
            {
                hud.SetConnection("不正なスキャン通知");
                return;
            }

            selectedProductId = scan.productId;
            LoadProduct(scan.productId);
        }

        private void LoadProduct(string productId)
        {
            hud.SetConnection($"{productId} を検索中");
            apiClient.GetProduct(productId,
                product =>
                {
                    ApplyProduct(product);
                    hud.SetConnection("商品情報を受信");
                },
                error => hud.SetConnection(error));
        }

        private void ApplyProduct(Product product)
        {
            if (product == null || string.IsNullOrWhiteSpace(product.id)) return;
            bool changed = !string.Equals(currentProductId, product.id,
                System.StringComparison.OrdinalIgnoreCase);
            bool rescanned = product.targetVersion > 0 &&
                             currentTargetVersion > 0 &&
                             product.targetVersion != currentTargetVersion;
            selectedProductId = product.id;
            currentProductId = product.id;
            if (product.targetVersion > 0)
                currentTargetVersion = product.targetVersion;
            currentProduct = product;
            if (changed || rescanned)
            {
                routeRequestVersion++;
                navigationGuide.Clear();
            }
            hud.SetProduct(product);
            markerTracker.SetTarget(product);
        }

        private void OnMarkerPoseRecognized(MarkerObservation observation)
        {
            if (observation == null || currentProduct == null ||
                string.IsNullOrWhiteSpace(currentProduct.id)) return;
            if (string.IsNullOrWhiteSpace(currentProduct.shelfId))
            {
                hud.ShowNavigation("この商品には陳列場所が登録されていません", false);
                return;
            }

            int requestVersion = ++routeRequestVersion;
            string requestedProductId = currentProduct.id;
            MarkerObservation capturedObservation = observation;
            hud.ShowNavigation("経路を計算中…", false);
            apiClient.GetNavigationRoute(observation.markerId, requestedProductId,
                route =>
                {
                    if (requestVersion != routeRequestVersion || currentProduct == null ||
                        !string.Equals(currentProduct.id, requestedProductId,
                            System.StringComparison.OrdinalIgnoreCase)) return;
                    string destination = !string.IsNullOrWhiteSpace(currentProduct.shelfName)
                        ? currentProduct.shelfName
                        : currentProduct.shelfId;
                    if (!navigationGuide.BeginRoute(
                            route, capturedObservation, destination, out string error))
                        hud.ShowNavigation(error, false);
                },
                error =>
                {
                    if (requestVersion != routeRequestVersion) return;
                    hud.ShowNavigation($"案内を開始できません：{error}", false);
                });
        }

        private IEnumerator PollGoggleTarget()
        {
            WaitForSecondsRealtime interval = new(2f);
            while (enabled)
            {
                bool completed = false;
                apiClient.GetGoggleTarget(config.goggleId,
                    product =>
                    {
                        if (product == null)
                        {
                            if (!string.IsNullOrWhiteSpace(currentProductId)) ClearProduct();
                            hud.SetConnection("商品タグの読み取り待ち");
                        }
                        else if (currentProduct == null ||
                                 !string.Equals(
                                     JsonUtility.ToJson(product),
                                     JsonUtility.ToJson(currentProduct),
                                     System.StringComparison.Ordinal))
                        {
                            ApplyProduct(product);
                            hud.SetConnection("商品情報を受信");
                        }
                        completed = true;
                    },
                    error =>
                    {
                        Debug.LogWarning($"[Intelligenti] {error}");
                        hud.SetConnection(error);
                        completed = true;
                    });

                float deadline = Time.realtimeSinceStartup + 10f;
                while (!completed && Time.realtimeSinceStartup < deadline)
                    yield return null;
                yield return interval;
            }
        }

        private void ClearProduct()
        {
            routeRequestVersion++;
            currentProductId = "";
            currentProduct = null;
            currentTargetVersion = 0;
            navigationGuide.Clear();
            hud.SetProduct(null);
            markerTracker.SetTarget(null);
        }

        private void OnGUI()
        {
            // Runtime diagnostics belong on the development machine, not in the
            // shopper's field of view. Keep these controls in the Unity Editor.
            if (!Application.isEditor) return;

            GUILayout.BeginArea(new Rect(24, 24, 360, 340), GUI.skin.box);
            GUILayout.Label("Intelligenti Debug Controls");
            selectedProductId = GUILayout.TextField(selectedProductId);
            if (GUILayout.Button("商品APIをテスト")) LoadProduct(selectedProductId);
            if (GUILayout.Button("NFCリーダーを検索・接続")) ble.ScanAndConnect();
            if (GUILayout.Button("選択IDを書込モードへ")) ble.BeginTagWrite(selectedProductId);
            if (GUILayout.Button("書込モード停止")) ble.StopTagWrite();
            GUILayout.Space(8);
            GUILayout.Label("XREAL Eye Diagnostics");
            if (GUILayout.Button("6DoFへ切り替える")) eye.RequestSixDof();
            if (GUILayout.Button("空間固定枠を正面へ置き直す")) eye.PlaceWorldLock();
            if (GUILayout.Button("Eye RGB取得を再試行")) eye.RestartRgbCapture();
            GUILayout.EndArea();
        }
    }
}
