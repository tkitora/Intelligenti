using System.Collections;
using UnityEngine;
using UnityEngine.Networking;
using UnityEngine.UI;

namespace Intelligenti
{
    /// <summary>
    /// Head-locked product card. Spatial guidance stays in ShelfMarkerTracker;
    /// product facts remain stable in the user's field of view.
    /// </summary>
    public sealed class ProductHud : MonoBehaviour
    {
        private Product currentProduct;
        private string connectionText = "商品タグの読み取り待ち";
        private string readerText = "";
        private Text productText;
        private RawImage productImage;
        private Text imagePlaceholder;
        private Texture2D downloadedImage;
        private Coroutine imageLoad;
        private int imageRequestVersion;
        private string locationConfirmation = "";
        private Coroutine locationConfirmationTimer;
        private GameObject navigationPanel;
        private Image navigationBackground;
        private Text navigationText;
        private string navigationMessage = "";
        private bool navigationArrived;

        private void Start()
        {
            CreateXrHud();
            RefreshXrHud();
            BeginImageLoad(currentProduct?.imageUrl);
        }

        public void SetProduct(Product product)
        {
            currentProduct = product;
            RefreshXrHud();
            if (productImage != null) BeginImageLoad(product?.imageUrl);
        }

        public void SetConnection(string value)
        {
            connectionText = value;
            RefreshXrHud();
        }

        public void SetReader(string value)
        {
            readerText = value;
            RefreshXrHud();
        }

        // Eye and marker diagnostics are intentionally kept out of the shopper HUD.
        public void SetEye(string value) { }
        public void SetMarker(string value) { }

        public void ShowLocationConfirmed(Shelf shelf)
        {
            if (shelf == null) return;
            locationConfirmation = string.IsNullOrWhiteSpace(shelf.name) ? shelf.id : shelf.name;
            if (locationConfirmationTimer != null) StopCoroutine(locationConfirmationTimer);
            locationConfirmationTimer = StartCoroutine(ClearLocationConfirmation());
            RefreshXrHud();
        }

        public void ShowNavigation(string message, bool arrived)
        {
            navigationMessage = message ?? "";
            navigationArrived = arrived;
            RefreshNavigation();
        }

        public void ClearNavigation()
        {
            navigationMessage = "";
            navigationArrived = false;
            RefreshNavigation();
        }

        private void CreateXrHud()
        {
            if (productText != null) return;

            Camera xrCamera = Camera.main;
            if (xrCamera == null)
            {
                Debug.LogWarning("Main Camera was not found for the XREAL HUD.");
                return;
            }

            // Black is optically transparent on XREAL, preserving the real store view.
            xrCamera.clearFlags = CameraClearFlags.SolidColor;
            xrCamera.backgroundColor = Color.black;

            GameObject canvasObject = new("Intelligenti product HUD");
            canvasObject.transform.SetParent(xrCamera.transform, false);
            canvasObject.transform.localPosition = new Vector3(0.12f, 0.02f, 1.8f);
            canvasObject.transform.localRotation = Quaternion.identity;
            canvasObject.transform.localScale = Vector3.one * 0.0011f;

            Canvas canvas = canvasObject.AddComponent<Canvas>();
            canvas.renderMode = RenderMode.WorldSpace;
            canvas.worldCamera = xrCamera;
            canvas.sortingOrder = 100;

            RectTransform canvasRect = canvasObject.GetComponent<RectTransform>();
            canvasRect.sizeDelta = new Vector2(640f, 300f);

            Image background = canvasObject.AddComponent<Image>();
            background.color = new Color(0.02f, 0.05f, 0.08f, 0.88f);

            GameObject imageSurface = new("Registered product image");
            imageSurface.transform.SetParent(canvasObject.transform, false);
            productImage = imageSurface.AddComponent<RawImage>();
            productImage.color = Color.clear;
            RectTransform imageRect = imageSurface.GetComponent<RectTransform>();
            imageRect.anchorMin = new Vector2(0f, 0.5f);
            imageRect.anchorMax = new Vector2(0f, 0.5f);
            imageRect.pivot = new Vector2(0f, 0.5f);
            imageRect.anchoredPosition = new Vector2(30f, 0f);
            imageRect.sizeDelta = new Vector2(210f, 210f);

            GameObject placeholderObject = new("Product image placeholder");
            placeholderObject.transform.SetParent(canvasObject.transform, false);
            imagePlaceholder = placeholderObject.AddComponent<Text>();
            imagePlaceholder.font = CreateJapaneseFont();
            imagePlaceholder.fontSize = 24;
            imagePlaceholder.alignment = TextAnchor.MiddleCenter;
            imagePlaceholder.color = new Color(0.58f, 0.72f, 0.78f);
            imagePlaceholder.text = "画像未登録";
            RectTransform placeholderRect = placeholderObject.GetComponent<RectTransform>();
            placeholderRect.anchorMin = imageRect.anchorMin;
            placeholderRect.anchorMax = imageRect.anchorMax;
            placeholderRect.pivot = imageRect.pivot;
            placeholderRect.anchoredPosition = imageRect.anchoredPosition;
            placeholderRect.sizeDelta = imageRect.sizeDelta;

            GameObject textObject = new("Essential product information");
            textObject.transform.SetParent(canvasObject.transform, false);
            productText = textObject.AddComponent<Text>();
            productText.font = CreateJapaneseFont();
            productText.fontSize = 34;
            productText.lineSpacing = 1.18f;
            productText.alignment = TextAnchor.MiddleLeft;
            productText.color = new Color(0.9f, 0.97f, 1f);
            productText.supportRichText = true;
            productText.horizontalOverflow = HorizontalWrapMode.Wrap;
            productText.verticalOverflow = VerticalWrapMode.Truncate;

            Outline outline = textObject.AddComponent<Outline>();
            outline.effectColor = new Color(0f, 0f, 0f, 0.82f);
            outline.effectDistance = new Vector2(1.5f, -1.5f);

            RectTransform textRect = textObject.GetComponent<RectTransform>();
            textRect.anchorMin = Vector2.zero;
            textRect.anchorMax = Vector2.one;
            textRect.offsetMin = new Vector2(270f, 26f);
            textRect.offsetMax = new Vector2(-30f, -26f);

            navigationPanel = new GameObject("Stable navigation instruction");
            navigationPanel.transform.SetParent(canvasObject.transform, false);
            navigationBackground = navigationPanel.AddComponent<Image>();
            RectTransform navigationRect = navigationPanel.GetComponent<RectTransform>();
            navigationRect.anchorMin = new Vector2(0.5f, 1f);
            navigationRect.anchorMax = new Vector2(0.5f, 1f);
            navigationRect.pivot = new Vector2(0.5f, 0f);
            navigationRect.anchoredPosition = new Vector2(0f, 18f);
            navigationRect.sizeDelta = new Vector2(640f, 92f);

            GameObject navigationTextObject = new("Navigation text");
            navigationTextObject.transform.SetParent(navigationPanel.transform, false);
            navigationText = navigationTextObject.AddComponent<Text>();
            navigationText.font = CreateJapaneseFont();
            navigationText.fontSize = 30;
            navigationText.fontStyle = FontStyle.Bold;
            navigationText.alignment = TextAnchor.MiddleCenter;
            navigationText.color = new Color(0.94f, 1f, 0.83f);
            navigationText.horizontalOverflow = HorizontalWrapMode.Wrap;
            navigationText.verticalOverflow = VerticalWrapMode.Truncate;
            RectTransform navigationTextRect =
                navigationTextObject.GetComponent<RectTransform>();
            navigationTextRect.anchorMin = Vector2.zero;
            navigationTextRect.anchorMax = Vector2.one;
            navigationTextRect.offsetMin = new Vector2(18f, 8f);
            navigationTextRect.offsetMax = new Vector2(-18f, -8f);
            RefreshNavigation();
        }

        private static Font CreateJapaneseFont()
        {
            Font font = Font.CreateDynamicFontFromOSFont(
                new[] { "Noto Sans CJK JP", "Noto Sans JP", "sans-serif" }, 40);
            return font != null
                ? font
                : Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
        }

        private void RefreshXrHud()
        {
            if (productText == null) return;

            if (currentProduct == null)
            {
                imagePlaceholder.text = "商品画像";
                imagePlaceholder.gameObject.SetActive(true);
                productImage.color = Color.clear;
                string status = !string.IsNullOrWhiteSpace(locationConfirmation)
                    ? $"現在地を確認　{locationConfirmation}"
                    : IsActionableStatus(connectionText)
                    ? connectionText
                    : IsActionableStatus(readerText)
                        ? readerText
                        : "NFCリーダーを商品タグにかざす";
                productText.text = "<size=42><b>商品を読み取る</b></size>\n" +
                                   $"<size=25><color=#8EDFFF>{status}</color></size>";
                return;
            }

            string shelf = !string.IsNullOrWhiteSpace(currentProduct.shelfName)
                ? currentProduct.shelfName
                : currentProduct.shelfId;
            string zone = string.IsNullOrWhiteSpace(currentProduct.zone)
                ? ""
                : $"\n<size=24><color=#A9C6D1>{currentProduct.zone}</color></size>";
            string confirmation = string.IsNullOrWhiteSpace(locationConfirmation)
                ? ""
                : $"\n<size=23><color=#8EDFFF>現在地を確認　{locationConfirmation}</color></size>";
            productText.text = $"<size=44><b>{currentProduct.name}</b></size>\n" +
                               $"<size=34>在庫　<b>{currentProduct.stock}点</b></size>\n" +
                               $"<size=30>陳列場所　<b>{shelf}</b></size>{zone}{confirmation}";
        }

        private void RefreshNavigation()
        {
            if (navigationPanel == null || navigationText == null ||
                navigationBackground == null) return;
            bool visible = !string.IsNullOrWhiteSpace(navigationMessage);
            navigationPanel.SetActive(visible);
            if (!visible) return;
            navigationText.text = navigationMessage;
            navigationBackground.color = navigationArrived
                ? new Color(0.08f, 0.24f, 0.12f, 0.94f)
                : new Color(0.02f, 0.08f, 0.12f, 0.94f);
            navigationText.color = navigationArrived
                ? new Color(0.72f, 1f, 0.49f)
                : new Color(0.56f, 0.88f, 1f);
        }

        private IEnumerator ClearLocationConfirmation()
        {
            yield return new WaitForSecondsRealtime(3f);
            locationConfirmation = "";
            locationConfirmationTimer = null;
            RefreshXrHud();
        }

        private static bool IsActionableStatus(string value)
        {
            if (string.IsNullOrWhiteSpace(value)) return false;
            string normalized = value.ToLowerInvariant();
            return normalized.Contains("エラー") || normalized.Contains("失敗") ||
                   normalized.Contains("未接続") || normalized.Contains("見つかりません") ||
                   normalized.Contains("error");
        }

        private void BeginImageLoad(string imageUrl)
        {
            if (productImage == null || imagePlaceholder == null) return;
            imageRequestVersion++;
            if (imageLoad != null)
            {
                StopCoroutine(imageLoad);
                imageLoad = null;
            }
            if (downloadedImage != null)
            {
                Destroy(downloadedImage);
                downloadedImage = null;
            }

            productImage.texture = null;
            productImage.color = Color.clear;
            imagePlaceholder.text = string.IsNullOrWhiteSpace(imageUrl)
                ? "画像未登録"
                : "画像を読込中";
            imagePlaceholder.gameObject.SetActive(true);
            if (!string.IsNullOrWhiteSpace(imageUrl))
                imageLoad = StartCoroutine(LoadImage(imageUrl, imageRequestVersion));
        }

        private IEnumerator LoadImage(string imageUrl, int requestVersion)
        {
            using UnityWebRequest request = UnityWebRequestTexture.GetTexture(imageUrl);
            yield return request.SendWebRequest();
            imageLoad = null;
            if (requestVersion != imageRequestVersion) yield break;

            if (request.result != UnityWebRequest.Result.Success)
            {
                Debug.LogWarning($"[Intelligenti] Product image load failed: HTTP {request.responseCode} / {request.error} / {imageUrl}");
                imagePlaceholder.text = "画像を表示できません";
                yield break;
            }

            downloadedImage = DownloadHandlerTexture.GetContent(request);
            productImage.texture = downloadedImage;
            productImage.color = Color.white;
            imagePlaceholder.gameObject.SetActive(false);
        }

        private void OnDestroy()
        {
            if (downloadedImage != null) Destroy(downloadedImage);
        }
    }
}
