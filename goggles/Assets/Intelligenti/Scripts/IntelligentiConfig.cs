using System;
using UnityEngine;

namespace Intelligenti
{
    [Serializable]
    public sealed class IntelligentiConfig
    {
        // v2 drops the former DHCP-bound LAN override and defaults to public HTTPS.
        private const string ApiOverridePreference = "intelligenti.apiBaseUrl.override.v2";
        private const string GoggleKeyOverridePreference =
            "intelligenti.goggleApiKey.override.v1";
        public string apiBaseUrl = "https://nfc-api.tkgon.net";
        public string mqttHost = "";
        public int mqttPort = 1883;
        public string mqttUsername = "";
        public string mqttPassword = "";
        public string goggleApiKey = "";
        public string scanTopic = "intelligenti/readers/+/scan";
        public string goggleId = "BEAMPRO-01";
        public string targetTopic = "intelligenti/goggles/BEAMPRO-01/target";

        public static IntelligentiConfig Load()
        {
            TextAsset asset = Resources.Load<TextAsset>("intelligenti-config");
            if (asset == null)
            {
                Debug.LogWarning("intelligenti-config.json was not found. Using defaults.");
                IntelligentiConfig defaults = new();
                defaults.ApplyRuntimeOverrides();
                return defaults;
            }

            IntelligentiConfig config =
                JsonUtility.FromJson<IntelligentiConfig>(asset.text) ??
                new IntelligentiConfig();
            config.ApplyRuntimeOverrides();
            return config;
        }

        private void ApplyRuntimeOverrides()
        {
#if UNITY_ANDROID && !UNITY_EDITOR
            try
            {
                string savedApiOverride = PlayerPrefs.GetString(ApiOverridePreference, "");
                if (!string.IsNullOrWhiteSpace(savedApiOverride))
                    apiBaseUrl = savedApiOverride.TrimEnd('/');
                string savedGoggleKey = PlayerPrefs.GetString(
                    GoggleKeyOverridePreference, "");
                if (!string.IsNullOrWhiteSpace(savedGoggleKey))
                    goggleApiKey = savedGoggleKey.Trim();

                using AndroidJavaClass unityPlayer =
                    new("com.unity3d.player.UnityPlayer");
                using AndroidJavaObject activity =
                    unityPlayer.GetStatic<AndroidJavaObject>("currentActivity");
                using AndroidJavaObject intent =
                    activity.Call<AndroidJavaObject>("getIntent");

                string apiOverride = intent.Call<string>(
                    "getStringExtra", "intelligenti.apiBaseUrl");
                string mqttHostOverride = intent.Call<string>(
                    "getStringExtra", "intelligenti.mqttHost");
                string goggleKeyOverride = intent.Call<string>(
                    "getStringExtra", "intelligenti.goggleApiKey");
                int mqttPortOverride = intent.Call<int>(
                    "getIntExtra", "intelligenti.mqttPort", -1);

                if (!string.IsNullOrWhiteSpace(apiOverride))
                {
                    apiBaseUrl = apiOverride.TrimEnd('/');
                    PlayerPrefs.SetString(ApiOverridePreference, apiBaseUrl);
                    PlayerPrefs.Save();
                }
                if (!string.IsNullOrWhiteSpace(mqttHostOverride))
                    mqttHost = mqttHostOverride;
                if (!string.IsNullOrWhiteSpace(goggleKeyOverride))
                {
                    goggleApiKey = goggleKeyOverride.Trim();
                    PlayerPrefs.SetString(
                        GoggleKeyOverridePreference, goggleApiKey);
                    PlayerPrefs.Save();
                }
                if (mqttPortOverride > 0 && mqttPortOverride <= 65535)
                    mqttPort = mqttPortOverride;

                if (!string.IsNullOrWhiteSpace(apiOverride) ||
                    !string.IsNullOrWhiteSpace(savedApiOverride) ||
                    !string.IsNullOrWhiteSpace(mqttHostOverride) ||
                    !string.IsNullOrWhiteSpace(goggleKeyOverride) ||
                    !string.IsNullOrWhiteSpace(savedGoggleKey) ||
                    mqttPortOverride > 0)
                {
                    Debug.Log($"Intelligenti runtime endpoint override: " +
                              $"API={apiBaseUrl}, MQTT={mqttHost}:{mqttPort}, " +
                              $"RouteKey={(string.IsNullOrWhiteSpace(goggleApiKey) ? "unset" : "set")}");
                }
            }
            catch (Exception exception)
            {
                Debug.LogWarning($"Runtime endpoint override failed: {exception.Message}");
            }
#endif
        }
    }
}
