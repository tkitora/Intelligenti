using System;
using System.Collections;
using System.Text;
using UnityEngine;
using UnityEngine.Networking;

namespace Intelligenti
{
    public sealed class ProductApiClient
    {
        private readonly MonoBehaviour coroutineHost;
        private readonly string baseUrl;
        private readonly string goggleApiKey;

        public ProductApiClient(MonoBehaviour coroutineHost, string baseUrl,
            string goggleApiKey = "")
        {
            this.coroutineHost = coroutineHost;
            this.baseUrl = (baseUrl ?? string.Empty).TrimEnd('/');
            this.goggleApiKey = (goggleApiKey ?? string.Empty).Trim();
        }

        public void GetProduct(string productId, Action<Product> onSuccess,
            Action<string> onError)
        {
            coroutineHost.StartCoroutine(GetProductCoroutine(productId, onSuccess, onError));
        }

        public void GetMarker(string markerId, Action<MarkerLookup> onSuccess,
            Action<string> onError)
        {
            coroutineHost.StartCoroutine(GetMarkerCoroutine(markerId, onSuccess, onError));
        }

        public void GetGoggleTarget(string goggleId, Action<Product> onSuccess,
            Action<string> onError)
        {
            coroutineHost.StartCoroutine(GetGoggleTargetCoroutine(goggleId, onSuccess, onError));
        }

        public void GetNavigationRoute(string markerId, string productId,
            Action<NavigationRoute> onSuccess, Action<string> onError)
        {
            coroutineHost.StartCoroutine(GetNavigationRouteCoroutine(
                markerId, productId, onSuccess, onError));
        }

        private IEnumerator GetProductCoroutine(string productId,
            Action<Product> onSuccess, Action<string> onError)
        {
            string escapedId = UnityWebRequest.EscapeURL(productId);
            using UnityWebRequest request = UnityWebRequest.Get(
                $"{baseUrl}/api/products/{escapedId}");
            request.timeout = 8;
            yield return request.SendWebRequest();

            if (request.result != UnityWebRequest.Result.Success)
            {
                onError?.Invoke($"商品APIエラー: {request.error}");
                yield break;
            }

            Product product;
            try
            {
                product = JsonUtility.FromJson<Product>(request.downloadHandler.text);
            }
            catch (Exception exception)
            {
                onError?.Invoke($"商品データ解析エラー: {exception.Message}");
                yield break;
            }

            if (product == null || string.IsNullOrWhiteSpace(product.id))
            {
                onError?.Invoke("商品データが不正です");
                yield break;
            }

            onSuccess?.Invoke(product);
        }

        private IEnumerator GetMarkerCoroutine(string markerId,
            Action<MarkerLookup> onSuccess, Action<string> onError)
        {
            string escapedId = UnityWebRequest.EscapeURL(markerId);
            using UnityWebRequest request = UnityWebRequest.Get(
                $"{baseUrl}/api/markers/{escapedId}");
            request.timeout = 8;
            yield return request.SendWebRequest();

            if (request.result != UnityWebRequest.Result.Success)
            {
                onError?.Invoke(request.responseCode == 404
                    ? $"未割当マーカー: {markerId}"
                    : $"マーカーAPIエラー: {request.error}");
                yield break;
            }

            MarkerLookup lookup;
            try
            {
                lookup = JsonUtility.FromJson<MarkerLookup>(request.downloadHandler.text);
            }
            catch (Exception exception)
            {
                onError?.Invoke($"マーカーデータ解析エラー: {exception.Message}");
                yield break;
            }

            if (lookup?.shelf == null || string.IsNullOrWhiteSpace(lookup.markerId))
            {
                onError?.Invoke("マーカーデータが不正です");
                yield break;
            }

            onSuccess?.Invoke(lookup);
        }

        private IEnumerator GetGoggleTargetCoroutine(string goggleId,
            Action<Product> onSuccess, Action<string> onError)
        {
            string escapedId = UnityWebRequest.EscapeURL(goggleId);
            using UnityWebRequest request = UnityWebRequest.Get(
                $"{baseUrl}/api/goggles/{escapedId}/target");
            request.timeout = 8;
            yield return request.SendWebRequest();

            if (request.responseCode == 204)
            {
                onSuccess?.Invoke(null);
                yield break;
            }
            if (request.result != UnityWebRequest.Result.Success)
            {
                onError?.Invoke($"案内対象APIエラー: {request.error}");
                yield break;
            }

            Product product;
            try
            {
                product = JsonUtility.FromJson<Product>(request.downloadHandler.text);
            }
            catch (Exception exception)
            {
                onError?.Invoke($"案内対象データ解析エラー: {exception.Message}");
                yield break;
            }

            if (product == null || string.IsNullOrWhiteSpace(product.id))
            {
                onError?.Invoke("案内対象データが不正です");
                yield break;
            }
            onSuccess?.Invoke(product);
        }

        [Serializable]
        private sealed class RouteRequest
        {
            public string fromMarkerId;
            public string toProductId;
        }

        private IEnumerator GetNavigationRouteCoroutine(string markerId,
            string productId, Action<NavigationRoute> onSuccess,
            Action<string> onError)
        {
            if (string.IsNullOrWhiteSpace(goggleApiKey))
            {
                onError?.Invoke("経路案内用の端末キーが未設定です");
                yield break;
            }

            string json = JsonUtility.ToJson(new RouteRequest
            {
                fromMarkerId = markerId,
                toProductId = productId,
            });
            using UnityWebRequest request = new(
                $"{baseUrl}/api/navigation/route", UnityWebRequest.kHttpVerbPOST);
            request.uploadHandler = new UploadHandlerRaw(Encoding.UTF8.GetBytes(json));
            request.downloadHandler = new DownloadHandlerBuffer();
            request.SetRequestHeader("Content-Type", "application/json");
            request.SetRequestHeader("Authorization", $"Bearer {goggleApiKey}");
            request.timeout = 8;
            yield return request.SendWebRequest();

            if (request.result != UnityWebRequest.Result.Success)
            {
                string message = "";
                try
                {
                    message = JsonUtility.FromJson<ApiError>(
                        request.downloadHandler.text)?.error;
                }
                catch (Exception) { }
                onError?.Invoke(!string.IsNullOrWhiteSpace(message)
                    ? message
                    : $"経路APIエラー: {request.error}");
                yield break;
            }

            NavigationRoute route;
            try
            {
                route = JsonUtility.FromJson<NavigationRoute>(
                    request.downloadHandler.text);
            }
            catch (Exception exception)
            {
                onError?.Invoke($"経路データ解析エラー: {exception.Message}");
                yield break;
            }

            if (route?.startMarker?.position == null || route.points == null ||
                route.points.Length < 2)
            {
                onError?.Invoke("経路データが不正です");
                yield break;
            }
            onSuccess?.Invoke(route);
        }
    }
}
