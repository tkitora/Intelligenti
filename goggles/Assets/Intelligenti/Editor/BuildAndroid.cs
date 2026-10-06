using System;
using System.IO;
using UnityEditor;
using UnityEditor.Build;
using UnityEditor.Build.Reporting;

namespace Intelligenti.Editor
{
    public static class BuildAndroid
    {
        public static void BuildApk()
        {
            PlayerSettings.SetScriptingBackend(
                NamedBuildTarget.Android, ScriptingImplementation.IL2CPP);
            PlayerSettings.Android.targetArchitectures = AndroidArchitecture.ARM64;
            PlayerSettings.Android.minSdkVersion = AndroidSdkVersions.AndroidApiLevel29;
            PlayerSettings.Android.targetSdkVersion = AndroidSdkVersions.AndroidApiLevelAuto;
            PlayerSettings.applicationIdentifier = "com.intelligenti.goggles";
            // The on-premise supermarket API is intentionally served over the
            // store LAN during development. Release deployment uses HTTPS.
            PlayerSettings.insecureHttpOption = InsecureHttpOption.DevelopmentOnly;

            string outputDirectory = Path.GetFullPath("Builds");
            Directory.CreateDirectory(outputDirectory);
            string outputPath = Path.Combine(outputDirectory, "Intelligenti-Goggles.apk");

            BuildPlayerOptions options = new()
            {
                scenes = new[] { "Assets/Scenes/SampleScene.unity" },
                locationPathName = outputPath,
                target = BuildTarget.Android,
                options = BuildOptions.Development
            };

            BuildReport report = BuildPipeline.BuildPlayer(options);
            if (report.summary.result != BuildResult.Succeeded)
                throw new Exception($"Android build failed: {report.summary.result}");

            UnityEngine.Debug.Log($"INTELLIGENTI_APK={outputPath}");
        }
    }
}
