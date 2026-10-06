#pragma once

#include <Arduino.h>

// XIAO ESP32-S3 I2C pins. Only SDA, SCL, 3V3 and GND are wired to the PN532.
constexpr uint8_t PIN_PN532_SDA = D4;
constexpr uint8_t PIN_PN532_SCL = D5;

// Adafruit_PN532 requires these constructor arguments, but the I2C transport
// polls its ready byte. Leave D6 and D7 physically unconnected.
constexpr uint8_t PIN_PN532_IRQ_UNUSED = D6;
constexpr uint8_t PIN_PN532_RESET_UNUSED = D7;

// Common-cathode RGB LED. Change LED_ACTIVE_LEVEL for common-anode LEDs.
constexpr uint8_t PIN_LED_RED = D0;
constexpr uint8_t PIN_LED_GREEN = D1;
constexpr uint8_t PIN_LED_BLUE = D2;
constexpr uint8_t LED_ACTIVE_LEVEL = HIGH;

constexpr uint32_t SERIAL_BAUD = 115200;
constexpr uint32_t WIFI_CONNECT_TIMEOUT_MS = 15000;
constexpr uint32_t WIFI_RETRY_INTERVAL_MS = 15000;
constexpr uint32_t MQTT_RETRY_INTERVAL_MS = 5000;
constexpr uint32_t TAG_REMOVAL_DELAY_MS = 300;
constexpr uint8_t PN532_PASSIVE_ACTIVATION_RETRIES = 0x01;

constexpr uint8_t TAG_DATA_BLOCK = 4;
constexpr size_t MAX_PRODUCT_ID_LENGTH = 13;

// This physical NFC tag is permanently reserved for returning the goggles to
// the waiting state. It is matched by UID before product data is read.
constexpr char RESET_TAG_UID[] = "37D33463";

constexpr char BLE_DEVICE_PREFIX[] = "Intelligenti-";
constexpr char BLE_SERVICE_UUID[] = "9d880100-504a-4c45-4e54-454c4c494745";
constexpr char BLE_COMMAND_UUID[] = "9d880101-504a-4c45-4e54-454c4c494745";
constexpr char BLE_STATUS_UUID[] = "9d880102-504a-4c45-4e54-454c4c494745";
