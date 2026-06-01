// BabyLink — XIAO ESP32-S3 firmware, Branch 1 skeleton.
//
// Boots, connects WiFi from dev_defaults, opens WSS to the server's
// /esp32-baby endpoint, sends a register frame tagged with
// device_type="esp32-s3", maintains a heartbeat. No audio capture yet
// — that's Branch 2. No provisioning yet — that's Branch 3.
//
// Intentionally NO code shared with ../esp32-firmware/ (which targets
// the classic ESP32 + INMP441 over legacy I2S). The plan is to evolve
// this codebase independently toward an esp-webrtc-solution-based
// pipeline.

#include <Arduino.h>
#include <WiFi.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>

#if __has_include("dev_defaults.h")
  #include "dev_defaults.h"
#else
  #define DEV_DEFAULT_WIFI_SSID     ""
  #define DEV_DEFAULT_WIFI_PASSWORD ""
  #define DEV_DEFAULT_SERVER_HOST   ""
  #define DEV_DEFAULT_SERVER_PORT   443
  #define DEV_DEFAULT_ROOM_ID       ""
#endif

// =============================================================================
// CONFIGURATION
// =============================================================================

static const char* WIFI_SSID     = DEV_DEFAULT_WIFI_SSID;
static const char* WIFI_PASSWORD = DEV_DEFAULT_WIFI_PASSWORD;
static const char* SERVER_HOST   = DEV_DEFAULT_SERVER_HOST;
static const uint16_t SERVER_PORT = DEV_DEFAULT_SERVER_PORT;
static const char* ROOM_ID       = DEV_DEFAULT_ROOM_ID;
static const char* WS_PATH       = "/esp32-baby";
static const char* DEVICE_NAME   = "BabyLink S3";
static const char* DEVICE_TYPE   = "esp32-s3";

// On the XIAO ESP32-S3 the on-board user LED is GPIO21 and is
// active-low. We invert in `setLED()` so the rest of the code reads
// naturally (HIGH = on).
static const int LED_PIN = 21;
static const bool LED_ACTIVE_LOW = true;

// =============================================================================
// GLOBAL STATE
// =============================================================================

WebSocketsClient webSocket;
bool isConnected = false;
bool isRegistered = false;
String deviceId;
unsigned long lastLedToggle = 0;
bool ledState = false;
unsigned long lastHeartbeat = 0;

// =============================================================================
// LED HELPERS
// =============================================================================

void setLED(bool on) {
  digitalWrite(LED_PIN, (on ^ LED_ACTIVE_LOW) ? HIGH : LOW);
  ledState = on;
}

// Slow blink (1 s period): WiFi down. Fast blink (250 ms): connected
// but not registered. Solid: registered.
void updateLED() {
  unsigned long now = millis();
  if (isRegistered) {
    if (!ledState) setLED(true);
    return;
  }
  unsigned long period = isConnected ? 250 : 1000;
  if (now - lastLedToggle >= period) {
    setLED(!ledState);
    lastLedToggle = now;
  }
}

// =============================================================================
// MAC HELPERS
// =============================================================================

String macHex() {
  uint8_t mac[6];
  WiFi.macAddress(mac);
  char buf[13];
  snprintf(buf, sizeof(buf), "%02x%02x%02x%02x%02x%02x",
           mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  return String(buf);
}

// =============================================================================
// WIFI
// =============================================================================

void connectWiFi() {
  if (strlen(WIFI_SSID) == 0) {
    Serial.println("[WiFi] No SSID configured. Halting until provisioning lands.");
    return;
  }

  Serial.printf("[WiFi] Connecting to %s ...\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 20000) {
    delay(250);
    Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("[WiFi] Connected. IP=%s RSSI=%d\n",
                  WiFi.localIP().toString().c_str(), WiFi.RSSI());
  } else {
    Serial.println("[WiFi] Failed to connect.");
  }
}

// =============================================================================
// WEBSOCKET
// =============================================================================

void sendRegister() {
  StaticJsonDocument<384> doc;
  doc["type"]        = "register";
  doc["roomId"]      = ROOM_ID;
  doc["name"]        = DEVICE_NAME;
  doc["mac"]         = macHex();
  doc["sampleRate"]  = 16000;
  doc["channels"]    = 1;
  doc["device_type"] = DEVICE_TYPE;

  String payload;
  serializeJson(doc, payload);
  Serial.printf("[WS] register -> %s\n", payload.c_str());
  webSocket.sendTXT(payload);
}

void onWebSocketEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      Serial.println("[WS] connected");
      isConnected = true;
      sendRegister();
      break;

    case WStype_DISCONNECTED:
      Serial.println("[WS] disconnected");
      isConnected = false;
      isRegistered = false;
      deviceId = "";
      break;

    case WStype_TEXT: {
      StaticJsonDocument<512> doc;
      DeserializationError err = deserializeJson(doc, payload, length);
      if (err) {
        Serial.printf("[WS] JSON parse error: %s\n", err.c_str());
        return;
      }
      const char* msgType = doc["type"] | "";
      if (strcmp(msgType, "registered") == 0) {
        isRegistered = true;
        deviceId = String((const char*)(doc["id"] | ""));
        Serial.printf("[WS] registered as %s\n", deviceId.c_str());
      } else if (strcmp(msgType, "pong") == 0) {
        // heartbeat ack, no log spam
      } else if (strcmp(msgType, "factory-reset") == 0) {
        Serial.println("[WS] factory-reset requested (NVS wipe lands in Branch 3)");
      } else if (strcmp(msgType, "error") == 0) {
        Serial.printf("[WS] server error: %s\n", (const char*)(doc["message"] | ""));
      }
      break;
    }

    case WStype_BIN:
      // No binary inbound traffic expected yet.
      break;

    default:
      break;
  }
}

void connectWebSocket() {
  if (strlen(SERVER_HOST) == 0) {
    Serial.println("[WS] No server configured. Skipping.");
    return;
  }
  Serial.printf("[WS] Connecting to %s:%u%s\n", SERVER_HOST, SERVER_PORT, WS_PATH);
  if (SERVER_PORT == 443) {
    webSocket.beginSSL(SERVER_HOST, SERVER_PORT, WS_PATH);
  } else {
    webSocket.begin(SERVER_HOST, SERVER_PORT, WS_PATH);
  }
  webSocket.onEvent(onWebSocketEvent);
  webSocket.setReconnectInterval(5000);
  webSocket.enableHeartbeat(15000, 3000, 2);
}

// =============================================================================
// SETUP / LOOP
// =============================================================================

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\n=== BabyLink XIAO ESP32-S3 (Branch 1 skeleton) ===");
  Serial.printf("MAC: %s\n", macHex().c_str());

  pinMode(LED_PIN, OUTPUT);
  setLED(false);

  connectWiFi();
  connectWebSocket();
}

void loop() {
  webSocket.loop();
  updateLED();

  // App-level heartbeat in addition to the WS-protocol-level one.
  // Gives the server fresh JSON traffic so the audio-staleness check
  // does not unregister us when audio is not yet implemented.
  unsigned long now = millis();
  if (isRegistered && now - lastHeartbeat > 5000) {
    StaticJsonDocument<64> ping;
    ping["type"] = "ping";
    String payload;
    serializeJson(ping, payload);
    webSocket.sendTXT(payload);
    lastHeartbeat = now;
  }
}
