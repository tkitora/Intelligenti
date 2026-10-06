#include <Arduino.h>
#include <Wire.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <Preferences.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <Adafruit_PN532.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>

#include "config.h"

namespace
{
// The Adafruit constructor requires IRQ and reset pin arguments, but its I2C
// transport polls the PN532 ready byte. These placeholder pins stay unconnected.
Adafruit_PN532 nfc(PIN_PN532_IRQ_UNUSED, PIN_PN532_RESET_UNUSED, &Wire);
Preferences preferences;
WiFiClient wifiClient;
PubSubClient mqttClient(wifiClient);

BLECharacteristic *statusCharacteristic = nullptr;

constexpr size_t BLE_COMMAND_BUFFER_SIZE = 384;
struct BleCommandMessage
{
  char value[BLE_COMMAND_BUFFER_SIZE];
};
QueueHandle_t bleCommandQueue = nullptr;

enum class ReaderMode
{
  Read,
  WriteWaiting
};

ReaderMode readerMode = ReaderMode::Read;
String pendingProductId;
String deviceId;
String mqttBaseTopic;
String lastHandledTagUid;

String wifiSsid;
String wifiPassword;
String mqttHost;
String mqttUsername;
String mqttPassword;
String apiBaseUrl;
String readerApiKey;
uint16_t mqttPort = 1883;

bool networkConfigured = false;
bool apiConfigured = false;
bool networkReconnectRequested = false;
bool wifiConnectInProgress = false;
bool waitingForTagRemoval = false;
unsigned long wifiConnectStartedAt = 0;
unsigned long lastWifiAttemptAt = 0;
unsigned long lastTagSeenAt = 0;
unsigned long lastMqttAttemptAt = 0;
unsigned long lastWifiDisconnectLogAt = 0;
uint8_t lastWifiDisconnectReason = 0;

uint8_t mifareKeyA[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};

void setLed(bool red, bool green, bool blue);
void setMode(ReaderMode mode);
void notifyStatus(const char *event, const char *message = nullptr,
                  const String &productId = "");
void publishStatus(const char *state);
void loadNetworkConfig();
void saveNetworkConfig(JsonObjectConst root);
void processBleCommand(const std::string &rawValue);
bool isValidProductId(const String &value);
void buildTagData(const String &productId, uint8_t data[16]);
bool parseTagData(const uint8_t data[16], String &productId);
bool isType2Tag(uint8_t uidLength);
bool authenticateClassic(const uint8_t *uid, uint8_t uidLength);
bool readTagData(const uint8_t *uid, uint8_t uidLength, uint8_t data[16]);
bool writeTagData(const uint8_t *uid, uint8_t uidLength, uint8_t data[16]);
void printTagData(const uint8_t data[16]);
bool connectWifi();
bool connectMqtt();
void maintainNetwork();
void publishScan(const String &productId, const uint8_t *uid,
                 uint8_t uidLength);
void publishReset(const uint8_t *uid, uint8_t uidLength);
String uidToString(const uint8_t *uid, uint8_t uidLength);
void handleTag(const uint8_t *uid, uint8_t uidLength);

void onWifiEvent(WiFiEvent_t event, WiFiEventInfo_t info)
{
  if (event != ARDUINO_EVENT_WIFI_STA_DISCONNECTED)
    return;

  const uint8_t reason = info.wifi_sta_disconnected.reason;
  if (reason == lastWifiDisconnectReason &&
      millis() - lastWifiDisconnectLogAt < 5000)
    return;
  lastWifiDisconnectReason = reason;
  lastWifiDisconnectLogAt = millis();
  Serial.print("Wi-Fi disconnected, reason=");
  Serial.println(static_cast<unsigned int>(reason));
}

class CommandCallbacks final : public BLECharacteristicCallbacks
{
  void onWrite(BLECharacteristic *characteristic,
               esp_ble_gatts_cb_param_t *param) override
  {
    (void)param;
    if (bleCommandQueue == nullptr)
      return;

    const std::string value = characteristic->getValue();
    BleCommandMessage message{};
    const size_t length = min(value.size(), BLE_COMMAND_BUFFER_SIZE - 1);
    memcpy(message.value, value.data(), length);
    message.value[length] = '\0';
    xQueueOverwrite(bleCommandQueue, &message);
  }
};

class ServerCallbacks final : public BLEServerCallbacks
{
  void onConnect(BLEServer *server) override
  {
    (void)server;
    Serial.println("BLE client connected");
  }

  void onDisconnect(BLEServer *server) override
  {
    Serial.println("BLE client disconnected");
    pendingProductId = "";
    setMode(ReaderMode::Read);
    server->startAdvertising();
  }
};

void setupBle()
{
  bleCommandQueue = xQueueCreate(1, sizeof(BleCommandMessage));
  if (bleCommandQueue == nullptr)
  {
    Serial.println("BLE command queue allocation failed");
    return;
  }

  const String bleName = String(BLE_DEVICE_PREFIX) + deviceId;
  BLEDevice::init(bleName.c_str());
  BLEDevice::setMTU(517);

  BLEServer *server = BLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());

  BLEService *service = server->createService(BLE_SERVICE_UUID);
  BLECharacteristic *commandCharacteristic = service->createCharacteristic(
      BLE_COMMAND_UUID,
      BLECharacteristic::PROPERTY_WRITE |
          BLECharacteristic::PROPERTY_WRITE_NR);
  commandCharacteristic->setCallbacks(new CommandCallbacks());

  statusCharacteristic = service->createCharacteristic(
      BLE_STATUS_UUID,
      BLECharacteristic::PROPERTY_READ |
          BLECharacteristic::PROPERTY_NOTIFY);
  statusCharacteristic->addDescriptor(new BLE2902());

  service->start();
  BLEAdvertising *advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(BLE_SERVICE_UUID);
  advertising->setScanResponse(true);
  BLEDevice::startAdvertising();

  Serial.print("BLE advertising: ");
  Serial.println(bleName);
}

void setLed(bool red, bool green, bool blue)
{
  const uint8_t inactive = LED_ACTIVE_LEVEL == HIGH ? LOW : HIGH;
  digitalWrite(PIN_LED_RED, red ? LED_ACTIVE_LEVEL : inactive);
  digitalWrite(PIN_LED_GREEN, green ? LED_ACTIVE_LEVEL : inactive);
  digitalWrite(PIN_LED_BLUE, blue ? LED_ACTIVE_LEVEL : inactive);
}

void setMode(ReaderMode mode)
{
  readerMode = mode;
  waitingForTagRemoval = false;

  if (mode == ReaderMode::Read)
  {
    setLed(false, true, false);
    Serial.println("Mode: READ");
    notifyStatus("mode", "read");
  }
  else
  {
    setLed(false, false, true);
    Serial.print("Mode: WRITE_WAITING, productId=");
    Serial.println(pendingProductId);
    notifyStatus("mode", "write_waiting", pendingProductId);
  }
}

void notifyStatus(const char *event, const char *message,
                  const String &productId)
{
  if (statusCharacteristic == nullptr)
    return;

  JsonDocument document;
  document["event"] = event;
  document["deviceId"] = deviceId;
  if (message != nullptr)
    document["message"] = message;
  if (!productId.isEmpty())
    document["productId"] = productId;

  String payload;
  serializeJson(document, payload);
  statusCharacteristic->setValue(payload.c_str());
  statusCharacteristic->notify();
}

void loadNetworkConfig()
{
  preferences.begin("intelligenti", true);
  wifiSsid = preferences.getString("ssid", "");
  wifiPassword = preferences.getString("wifiPass", "");
  mqttHost = preferences.getString("mqttHost", "");
  mqttPort = preferences.getUShort("mqttPort", 1883);
  mqttUsername = preferences.getString("mqttUser", "");
  mqttPassword = preferences.getString("mqttPass", "");
  apiBaseUrl = preferences.getString("apiUrl", "");
  readerApiKey = preferences.getString("apiKey", "");
  preferences.end();

  apiConfigured = !apiBaseUrl.isEmpty() && !readerApiKey.isEmpty();
  networkConfigured = !wifiSsid.isEmpty() &&
                      (apiConfigured || (!mqttHost.isEmpty() && mqttPort > 0));
}

void saveNetworkConfig(JsonObjectConst root)
{
  const char *ssid = root["ssid"] | "";
  const char *wifiPass = root["wifiPassword"] | "";
  const char *host = root["mqttHost"] | "";
  const uint16_t port = root["mqttPort"] | 1883;
  const char *mqttUser = root["mqttUsername"] | "";
  const char *mqttPass = root["mqttPassword"] | "";
  const char *url = root["apiBaseUrl"] | "";
  const char *apiKey = root["apiKey"] | "";

  const bool hasApiConfig = strlen(url) > 0 && strlen(apiKey) > 0;
  const bool hasMqttConfig = strlen(host) > 0 && port > 0;
  if (strlen(ssid) == 0 || (!hasApiConfig && !hasMqttConfig))
  {
    notifyStatus("error", "invalid_config");
    return;
  }

  preferences.begin("intelligenti", false);
  preferences.putString("ssid", ssid);
  preferences.putString("wifiPass", wifiPass);
  preferences.putString("mqttHost", host);
  preferences.putUShort("mqttPort", port);
  preferences.putString("mqttUser", mqttUser);
  preferences.putString("mqttPass", mqttPass);
  preferences.putString("apiUrl", url);
  preferences.putString("apiKey", apiKey);
  preferences.end();

  loadNetworkConfig();
  networkReconnectRequested = true;
  notifyStatus("config", "saved");
}

void processBleCommand(const std::string &rawValue)
{
  JsonDocument document;
  const DeserializationError error = deserializeJson(
      document, rawValue.data(), rawValue.size());
  if (error)
  {
    notifyStatus("error", "invalid_json");
    return;
  }

  const char *command = document["cmd"] | "";

  if (strcmp(command, "configure") == 0)
  {
    saveNetworkConfig(document.as<JsonObjectConst>());
    return;
  }

  if (strcmp(command, "write") == 0)
  {
    String productId = document["productId"] | "";
    productId.trim();
    if (!isValidProductId(productId))
    {
      notifyStatus("error", "invalid_product_id");
      return;
    }

    pendingProductId = productId;
    setMode(ReaderMode::WriteWaiting);
    return;
  }

  if (strcmp(command, "stop") == 0)
  {
    pendingProductId = "";
    setMode(ReaderMode::Read);
    return;
  }

  if (strcmp(command, "status") == 0)
  {
    notifyStatus("status",
                 readerMode == ReaderMode::Read ? "read" : "write_waiting",
                 pendingProductId);
    return;
  }

  notifyStatus("error", "unknown_command");
}

bool isValidProductId(const String &value)
{
  if (value.isEmpty() || value.length() > MAX_PRODUCT_ID_LENGTH)
    return false;

  for (size_t i = 0; i < value.length(); ++i)
  {
    const char c = value[i];
    const bool valid = isalnum(static_cast<unsigned char>(c)) || c == '-' || c == '_';
    if (!valid)
      return false;
  }
  return true;
}

void buildTagData(const String &productId, uint8_t data[16])
{
  memset(data, 0, 16);
  data[0] = 0x49; // I
  data[1] = 0x4E; // N
  data[2] = static_cast<uint8_t>(productId.length());
  memcpy(data + 3, productId.c_str(), productId.length());
}

bool parseTagData(const uint8_t data[16], String &productId)
{
  if (data[0] != 0x49 || data[1] != 0x4E)
    return false;

  const uint8_t length = data[2];
  if (length == 0 || length > MAX_PRODUCT_ID_LENGTH)
    return false;

  productId = "";
  for (uint8_t i = 0; i < length; ++i)
    productId += static_cast<char>(data[i + 3]);

  return isValidProductId(productId);
}

bool isType2Tag(uint8_t uidLength)
{
  // NTAG/Ultralight tags normally use a 7-byte UID. MIFARE Classic tags used
  // by this product use a 4-byte UID and require sector authentication.
  return uidLength == 7;
}

bool authenticateClassic(const uint8_t *uid, uint8_t uidLength)
{
  const bool authenticated = nfc.mifareclassic_AuthenticateBlock(
      const_cast<uint8_t *>(uid), uidLength, TAG_DATA_BLOCK, 0, mifareKeyA);
  if (!authenticated)
    Serial.println("MIFARE Classic authentication failed");
  return authenticated;
}

bool readTagData(const uint8_t *uid, uint8_t uidLength, uint8_t data[16])
{
  if (isType2Tag(uidLength))
  {
    for (uint8_t offset = 0; offset < 4; ++offset)
    {
      if (!nfc.ntag2xx_ReadPage(TAG_DATA_BLOCK + offset, data + offset * 4))
        return false;
    }
    return true;
  }

  return authenticateClassic(uid, uidLength) &&
         nfc.mifareclassic_ReadDataBlock(TAG_DATA_BLOCK, data);
}

bool writeTagData(const uint8_t *uid, uint8_t uidLength, uint8_t data[16])
{
  if (isType2Tag(uidLength))
  {
    for (uint8_t offset = 0; offset < 4; ++offset)
    {
      if (!nfc.ntag2xx_WritePage(TAG_DATA_BLOCK + offset, data + offset * 4))
        return false;
    }
    return true;
  }

  return authenticateClassic(uid, uidLength) &&
         nfc.mifareclassic_WriteDataBlock(TAG_DATA_BLOCK, data);
}

void printTagData(const uint8_t data[16])
{
  Serial.print("Tag data: ");
  for (uint8_t index = 0; index < 16; ++index)
  {
    if (data[index] < 0x10)
      Serial.print('0');
    Serial.print(data[index], HEX);
    if (index < 15)
      Serial.print(' ');
  }
  Serial.println();
}

bool connectWifi()
{
  if (!networkConfigured)
    return false;
  if (WiFi.status() == WL_CONNECTED)
  {
    if (wifiConnectInProgress)
    {
      Serial.print("Wi-Fi connected: ");
      Serial.println(WiFi.localIP());
      notifyStatus("wifi", "connected");
      setMode(readerMode);
    }
    wifiConnectInProgress = false;
    return true;

  }

  if (wifiConnectInProgress)
  {
    if (millis() - wifiConnectStartedAt < WIFI_CONNECT_TIMEOUT_MS)
      return false;

    Serial.print("Wi-Fi connection failed, status=");
    Serial.println(static_cast<int>(WiFi.status()));
    WiFi.disconnect(false, false);
    wifiConnectInProgress = false;
    lastWifiAttemptAt = millis();
    setLed(true, false, false);
    notifyStatus("wifi", "failed");
    return false;
  }

  if (lastWifiAttemptAt != 0 &&
      millis() - lastWifiAttemptAt < WIFI_RETRY_INTERVAL_MS)
    return false;

  Serial.print("Connecting Wi-Fi: ");
  Serial.println(wifiSsid);
  setLed(true, true, false);
  WiFi.mode(WIFI_STA);
  WiFi.begin(wifiSsid.c_str(), wifiPassword.c_str());
  wifiConnectInProgress = true;
  wifiConnectStartedAt = millis();
  lastWifiAttemptAt = millis();
  return false;
}

bool connectMqtt()
{
  if (WiFi.status() != WL_CONNECTED || mqttClient.connected())
    return mqttClient.connected();

  const String clientId = "intelligenti-reader-" + deviceId;
  const String statusTopic = mqttBaseTopic + "/status";
  bool connected = false;

  if (mqttUsername.isEmpty())
  {
    connected = mqttClient.connect(clientId.c_str(), statusTopic.c_str(), 1,
                                   true, "offline");
  }
  else
  {
    connected = mqttClient.connect(clientId.c_str(), mqttUsername.c_str(),
                                   mqttPassword.c_str(), statusTopic.c_str(), 1,
                                   true, "offline");
  }

  if (!connected)
  {
    Serial.print("MQTT connection failed, state=");
    Serial.println(mqttClient.state());
    notifyStatus("mqtt", "failed");
    return false;
  }

  Serial.println("MQTT connected");
  publishStatus("online");
  notifyStatus("mqtt", "connected");
  return true;
}

void maintainNetwork()
{
  if (networkReconnectRequested)
  {
    networkReconnectRequested = false;
    mqttClient.disconnect();
    WiFi.disconnect(true);
    wifiConnectInProgress = false;
    lastWifiAttemptAt = 0;
  }

  if (!networkConfigured)
    return;

  if (!connectWifi())
    return;

  if (apiConfigured)
    return;

  if (!mqttClient.connected() &&
      millis() - lastMqttAttemptAt >= MQTT_RETRY_INTERVAL_MS)
  {
    lastMqttAttemptAt = millis();
    connectMqtt();
  }
  mqttClient.loop();
}

void publishStatus(const char *state)
{
  if (!mqttClient.connected())
    return;
  const String topic = mqttBaseTopic + "/status";
  mqttClient.publish(topic.c_str(), state, true);
}

String uidToString(const uint8_t *uid, uint8_t uidLength)
{
  String value;
  for (uint8_t i = 0; i < uidLength; ++i)
  {
    if (uid[i] < 0x10)
      value += '0';
    value += String(uid[i], HEX);
  }
  value.toUpperCase();
  return value;
}

void publishScan(const String &productId, const uint8_t *uid,
                 uint8_t uidLength)
{
  JsonDocument document;
  document["deviceId"] = deviceId;
  document["productId"] = productId;
  document["tagUid"] = uidToString(uid, uidLength);
  document["rssi"] = WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0;
  document["uptimeMs"] = millis();

  String payload;
  serializeJson(document, payload);

  if (apiConfigured && WiFi.status() == WL_CONNECTED)
  {
    WiFiClientSecure secureClient;
    secureClient.setInsecure();
    HTTPClient http;
    String url = apiBaseUrl;
    if (url.endsWith("/"))
      url.remove(url.length() - 1);
    url += "/api/reader-scans";

    if (http.begin(secureClient, url))
    {
      http.addHeader("Content-Type", "application/json");
      http.addHeader("Authorization", "Bearer " + readerApiKey);
      const int statusCode = http.POST(payload);
      http.end();
      if (statusCode >= 200 && statusCode < 300)
      {
        Serial.print("Published scan over HTTPS: ");
        Serial.println(productId);
        notifyStatus("scan", "published", productId);
        return;
      }
      Serial.print("HTTPS scan failed, status=");
      Serial.println(statusCode);
      notifyStatus("error", "https_failed", productId);
      return;
    }
    Serial.println("HTTPS connection could not start");
    notifyStatus("error", "https_failed", productId);
    return;
  }

  const String topic = mqttBaseTopic + "/scan";

  if (mqttClient.connected() && mqttClient.publish(topic.c_str(), payload.c_str()))
  {
    Serial.print("Published scan: ");
    Serial.println(payload);
    notifyStatus("scan", "published", productId);
  }
  else
  {
    Serial.println("Scan not published: MQTT offline");
    notifyStatus("error", "mqtt_offline", productId);
  }
}

void publishReset(const uint8_t *uid, uint8_t uidLength)
{
  JsonDocument document;
  document["deviceId"] = deviceId;
  document["action"] = "reset";
  document["tagUid"] = uidToString(uid, uidLength);
  document["rssi"] = WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0;
  document["uptimeMs"] = millis();

  String payload;
  serializeJson(document, payload);

  if (apiConfigured && WiFi.status() == WL_CONNECTED)
  {
    WiFiClientSecure secureClient;
    secureClient.setInsecure();
    HTTPClient http;
    String url = apiBaseUrl;
    if (url.endsWith("/"))
      url.remove(url.length() - 1);
    url += "/api/reader-scans";

    if (http.begin(secureClient, url))
    {
      http.addHeader("Content-Type", "application/json");
      http.addHeader("Authorization", "Bearer " + readerApiKey);
      const int statusCode = http.POST(payload);
      http.end();
      if (statusCode >= 200 && statusCode < 300)
      {
        Serial.println("Published reset over HTTPS");
        notifyStatus("reset", "published");
        return;
      }
      Serial.print("HTTPS reset failed, status=");
      Serial.println(statusCode);
      notifyStatus("error", "https_reset_failed");
      return;
    }
    Serial.println("HTTPS reset connection could not start");
    notifyStatus("error", "https_reset_failed");
    return;
  }

  const String topic = mqttBaseTopic + "/scan";
  if (mqttClient.connected() && mqttClient.publish(topic.c_str(), payload.c_str()))
  {
    Serial.println("Published reset over MQTT");
    notifyStatus("reset", "published");
  }
  else
  {
    Serial.println("Reset not published: network offline");
    notifyStatus("error", "reset_offline");
  }
}

void handleTag(const uint8_t *uid, uint8_t uidLength)
{
  const String tagUid = uidToString(uid, uidLength);
  Serial.print("Tag detected: UID=");
  Serial.println(tagUid);

  if (tagUid == RESET_TAG_UID)
  {
    Serial.println("Dedicated reset tag detected");
    setLed(true, false, true);
    publishReset(uid, uidLength);
    waitingForTagRemoval = true;
    return;
  }

  if (readerMode == ReaderMode::WriteWaiting)
  {
    uint8_t data[16];
    buildTagData(pendingProductId, data);
    const bool written = writeTagData(uid, uidLength, data);
    uint8_t verifiedData[16] = {};
    const bool verified = written && readTagData(uid, uidLength, verifiedData) &&
                          memcmp(data, verifiedData, sizeof(data)) == 0;

    if (verified)
    {
      Serial.print("Tag written: ");
      Serial.println(pendingProductId);
      Serial.println(isType2Tag(uidLength) ? "Tag storage: NTAG/Type 2" :
                                            "Tag storage: MIFARE Classic");
      setLed(false, true, false);
      notifyStatus("write", "success", pendingProductId);
      pendingProductId = "";
      readerMode = ReaderMode::Read;
    }
    else
    {
      Serial.println(written ? "Tag write verification failed" : "Tag write failed");
      if (written)
        printTagData(verifiedData);
      setLed(true, false, false);
      notifyStatus("write", "failed", pendingProductId);
    }
    waitingForTagRemoval = true;
    return;
  }

  uint8_t data[16];
  if (!readTagData(uid, uidLength, data))
  {
    setLed(true, false, false);
    notifyStatus("error", "tag_read_failed");
    return;
  }

  String productId;
  if (!parseTagData(data, productId))
  {
    Serial.println("Tag data has no Intelligenti product ID");
    printTagData(data);
    setLed(true, false, false);
    notifyStatus("error", "unknown_tag_format");
    return;
  }

  setLed(false, true, true);
  publishScan(productId, uid, uidLength);
  waitingForTagRemoval = true;
}
} // namespace

void setup()
{
  Serial.begin(SERIAL_BAUD);
  delay(500);

  pinMode(PIN_LED_RED, OUTPUT);
  pinMode(PIN_LED_GREEN, OUTPUT);
  pinMode(PIN_LED_BLUE, OUTPUT);
  setLed(false, false, true);

  const uint64_t chipId = ESP.getEfuseMac();
  char idBuffer[7];
  snprintf(idBuffer, sizeof(idBuffer), "%06llX",
           static_cast<unsigned long long>(chipId & 0xFFFFFF));
  deviceId = idBuffer;
  mqttBaseTopic = "intelligenti/readers/" + deviceId;

  Serial.println("Intelligenti NFC Reader");
  Serial.print("Device ID: ");
  Serial.println(deviceId);

  WiFi.onEvent(onWifiEvent);
  loadNetworkConfig();
  Serial.print("Dedicated reset tag UID: ");
  Serial.println(RESET_TAG_UID);
  setupBle();

  Wire.begin(PIN_PN532_SDA, PIN_PN532_SCL);
  nfc.begin();
  const uint32_t versionData = nfc.getFirmwareVersion();
  if (!versionData)
  {
    Serial.println("PN532 not found. Check I2C wiring and mode settings.");
    setLed(true, false, false);
    notifyStatus("error", "pn532_not_found");
    while (true)
      delay(1000);
  }

  bool samConfigured = false;
  for (uint8_t attempt = 1; attempt <= 3 && !samConfigured; ++attempt)
  {
    samConfigured = nfc.SAMConfig();
    if (!samConfigured)
    {
      Serial.print("PN532 SAM configuration retry ");
      Serial.println(attempt);
      delay(100);
    }
  }
  if (!samConfigured ||
      !nfc.setPassiveActivationRetries(PN532_PASSIVE_ACTIVATION_RETRIES))
  {
    Serial.println("PN532 reader configuration failed");
    setLed(true, false, false);
    notifyStatus("error", "pn532_configuration_failed");
    while (true)
      delay(1000);
  }
  Serial.println("PN532 ready");
  setMode(ReaderMode::Read);

  if (networkConfigured)
  {
    connectWifi();
    connectMqtt();
  }
  else
  {
    Serial.println("Network not configured. Configure over BLE.");
  }
}

void loop()
{
  BleCommandMessage bleCommand{};
  if (bleCommandQueue != nullptr &&
      xQueueReceive(bleCommandQueue, &bleCommand, 0) == pdTRUE)
  {
    processBleCommand(std::string(bleCommand.value));
  }

  maintainNetwork();

  uint8_t uid[7];
  uint8_t uidLength = 0;
  const bool found = nfc.readPassiveTargetID(
      PN532_MIFARE_ISO14443A, uid, &uidLength, 100);

  if (!found)
  {
    if (waitingForTagRemoval &&
        millis() - lastTagSeenAt >= TAG_REMOVAL_DELAY_MS)
    {
      waitingForTagRemoval = false;
      lastHandledTagUid = "";
      setMode(readerMode);
    }
    delay(10);
    return;
  }

  lastTagSeenAt = millis();
  const String detectedTagUid = uidToString(uid, uidLength);
  const bool differentTag = !lastHandledTagUid.isEmpty() &&
                            detectedTagUid != lastHandledTagUid;
  if (!waitingForTagRemoval || differentTag)
  {
    waitingForTagRemoval = true;
    lastHandledTagUid = detectedTagUid;
    handleTag(uid, uidLength);
  }
}
