using System;
using UnityEngine;

namespace Intelligenti
{
    public sealed class ReaderBleClient : MonoBehaviour
    {
        public event Action<string> StatusReceived;
        public event Action<string> ErrorReceived;

        private AndroidJavaClass nativeClient;

        public void Initialize()
        {
#if UNITY_ANDROID && !UNITY_EDITOR
            nativeClient = new AndroidJavaClass("com.intelligenti.ble.IntelligentiBleClient");
            using AndroidJavaClass unityPlayer = new("com.unity3d.player.UnityPlayer");
            using AndroidJavaObject activity = unityPlayer.GetStatic<AndroidJavaObject>("currentActivity");
            nativeClient.CallStatic("initialize", activity, gameObject.name);
#else
            Debug.Log("BLE bridge initialized in Editor simulation mode");
#endif
        }

        public void ScanAndConnect()
        {
#if UNITY_ANDROID && !UNITY_EDITOR
            nativeClient?.CallStatic("scanAndConnect");
#else
            OnBleStatus("{\"event\":\"ble\",\"message\":\"editor_simulation\"}");
#endif
        }

        public void WriteCommand(string json)
        {
#if UNITY_ANDROID && !UNITY_EDITOR
            nativeClient?.CallStatic("writeCommand", json);
#else
            Debug.Log($"BLE simulated write: {json}");
#endif
        }

        public void BeginTagWrite(string productId)
        {
            string escaped = productId.Replace("\\", "\\\\").Replace("\"", "\\\"");
            WriteCommand($"{{\"cmd\":\"write\",\"productId\":\"{escaped}\"}}");
        }

        public void StopTagWrite() => WriteCommand("{\"cmd\":\"stop\"}");

        public void OnBleStatus(string json) => StatusReceived?.Invoke(json);
        public void OnBleError(string message) => ErrorReceived?.Invoke(message);
    }
}
