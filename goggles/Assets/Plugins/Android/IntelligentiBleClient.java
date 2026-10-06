package com.intelligenti.ble;

import android.Manifest;
import android.app.Activity;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanFilter;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelUuid;

import com.unity3d.player.UnityPlayer;

import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.UUID;

public final class IntelligentiBleClient {
    private static final UUID SERVICE_UUID = UUID.fromString("9d880100-504a-4c45-4e54-454c4c494745");
    private static final UUID COMMAND_UUID = UUID.fromString("9d880101-504a-4c45-4e54-454c4c494745");
    private static final UUID STATUS_UUID = UUID.fromString("9d880102-504a-4c45-4e54-454c4c494745");
    private static final UUID CCCD_UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");

    private static Activity activity;
    private static String callbackObject;
    private static BluetoothLeScanner scanner;
    private static BluetoothGatt gatt;
    private static BluetoothGattCharacteristic commandCharacteristic;
    private static final Handler handler = new Handler(Looper.getMainLooper());

    public static void initialize(Activity unityActivity, String gameObjectName) {
        activity = unityActivity;
        callbackObject = gameObjectName;
        requestPermissions();
    }

    public static void scanAndConnect() {
        if (activity == null) {
            error("BLE bridge is not initialized");
            return;
        }
        requestPermissions();
        BluetoothManager manager = (BluetoothManager) activity.getSystemService(Context.BLUETOOTH_SERVICE);
        BluetoothAdapter adapter = manager == null ? null : manager.getAdapter();
        if (adapter == null || !adapter.isEnabled()) {
            error("Bluetooth is disabled");
            return;
        }

        scanner = adapter.getBluetoothLeScanner();
        ScanFilter filter = new ScanFilter.Builder().setServiceUuid(new ParcelUuid(SERVICE_UUID)).build();
        ScanSettings settings = new ScanSettings.Builder()
                .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build();
        scanner.startScan(Collections.singletonList(filter), settings, scanCallback);
        status("{\"event\":\"ble\",\"message\":\"scanning\"}");
        handler.postDelayed(() -> {
            if (scanner != null) scanner.stopScan(scanCallback);
        }, 10000);
    }

    public static void writeCommand(String json) {
        if (gatt == null || commandCharacteristic == null) {
            error("NFC reader is not connected");
            return;
        }
        commandCharacteristic.setValue(json.getBytes(StandardCharsets.UTF_8));
        commandCharacteristic.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT);
        if (!gatt.writeCharacteristic(commandCharacteristic)) error("BLE write could not start");
    }

    private static final ScanCallback scanCallback = new ScanCallback() {
        @Override public void onScanResult(int callbackType, ScanResult result) {
            if (scanner != null) scanner.stopScan(this);
            gatt = result.getDevice().connectGatt(activity, false, gattCallback,
                    BluetoothDevice.TRANSPORT_LE);
        }
        @Override public void onScanFailed(int errorCode) { error("BLE scan failed: " + errorCode); }
    };

    private static final BluetoothGattCallback gattCallback = new BluetoothGattCallback() {
        @Override public void onConnectionStateChange(BluetoothGatt value, int statusCode, int newState) {
            if (statusCode != BluetoothGatt.GATT_SUCCESS) {
                error("BLE connection failed: " + statusCode);
                value.close();
                return;
            }
            if (newState == BluetoothProfile.STATE_CONNECTED) {
                status("{\"event\":\"ble\",\"message\":\"connected\"}");
                value.discoverServices();
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                commandCharacteristic = null;
                status("{\"event\":\"ble\",\"message\":\"disconnected\"}");
                value.close();
            }
        }

        @Override public void onServicesDiscovered(BluetoothGatt value, int statusCode) {
            BluetoothGattService service = value.getService(SERVICE_UUID);
            if (service == null) { error("Intelligenti BLE service not found"); return; }
            commandCharacteristic = service.getCharacteristic(COMMAND_UUID);
            BluetoothGattCharacteristic statusValue = service.getCharacteristic(STATUS_UUID);
            if (commandCharacteristic == null || statusValue == null) {
                error("Intelligenti BLE characteristics not found"); return;
            }
            value.setCharacteristicNotification(statusValue, true);
            BluetoothGattDescriptor descriptor = statusValue.getDescriptor(CCCD_UUID);
            if (descriptor != null) {
                descriptor.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
                value.writeDescriptor(descriptor);
            }
            status("{\"event\":\"ble\",\"message\":\"ready\"}");
        }

        @Override public void onCharacteristicChanged(BluetoothGatt value,
                BluetoothGattCharacteristic characteristic) {
            status(new String(characteristic.getValue(), StandardCharsets.UTF_8));
        }
    };

    private static void requestPermissions() {
        if (Build.VERSION.SDK_INT >= 31) {
            if (activity.checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN) != PackageManager.PERMISSION_GRANTED ||
                    activity.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) {
                activity.requestPermissions(new String[]{Manifest.permission.BLUETOOTH_SCAN,
                        Manifest.permission.BLUETOOTH_CONNECT}, 4102);
            }
        }
    }

    private static void status(String message) {
        UnityPlayer.UnitySendMessage(callbackObject, "OnBleStatus", message);
    }
    private static void error(String message) {
        UnityPlayer.UnitySendMessage(callbackObject, "OnBleError", message);
    }
}
