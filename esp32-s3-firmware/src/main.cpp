// BabyLink — XIAO ESP32-S3 firmware.
//
// Branch 2: PDM mic capture + WSS binary PCM stream, same wire format
// as the classic esp32-firmware/ client. Lets us validate the Sense
// expansion's mic and the server-side audio pipeline without yet
// introducing WebRTC complexity (that's Branch 5).
//
// Intentionally NO code shared with ../esp32-firmware/ (which targets
// the classic ESP32 + INMP441 over legacy I2S).

#include <Arduino.h>
#include <WiFi.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include <ESP_I2S.h>   // Arduino-ESP32 3.x PDM API (Seeed reference)

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

// XIAO ESP32-S3 user LED is GPIO21, active-low. setLED() inverts so the
// rest of the code reads naturally (HIGH = on).
static const int LED_PIN = 21;
static const bool LED_ACTIVE_LOW = true;

// NOTE on camera heat: the XIAO ESP32-S3 Sense has NO software-
// controllable PWDN GPIO for the camera (PWDN_GPIO_NUM = -1 in
// the board's camera_pins.h). The OV3660 stays powered whenever the
// Sense expansion is attached, which warms the LDO underside. A
// proper SCCB-based camera sleep lives in a follow-up branch
// (feat/s3-camera-sleep); this firmware just leaves it alone.

// XIAO ESP32-S3 Sense onboard PDM mic (MSM261D3526H1CPM).
// CLK on GPIO42, DATA on GPIO41. Same Seeed reference config.
static const int PDM_CLK_PIN  = 42;
static const int PDM_DATA_PIN = 41;
static const int SAMPLE_RATE = 16000;
static const int BUFFER_SIZE = 1024;  // samples per chunk = 64 ms @ 16 kHz
                                      // matches old client → identical
                                      // browser scheduler MAX_LEAD math.

// Gain applied after DC removal. The XIAO Sense PDM mic is intrinsically
// quieter than the classic INMP441 path (datasheet sensitivity is
// similar, but the legacy I2S mic at 24-bit gave more usable headroom).
// 32× is empirically the smallest value where "mama papa" at typical
// baby-monitor distance is clearly visible against idle, while baby
// crying still survives in the signal even if it saturates briefly —
// the server's RMS-based detection only needs sustained amplitude,
// not undistorted samples.
static const int AUDIO_GAIN = 32;

// DC blocker — running-mean subtraction implemented in float. We
// previously used a fixed-point Q10 IIR, which had a numerical bug:
// for small |y|, `(R * y) >> 10` rounds back to y exactly (e.g.
// `1019 * -100 >> 10 = -100`), so the IIR sticks at a non-zero
// residual instead of converging to 0. That gave a sustained mean
// ≈ -100 in firmware output (= -800 after gain×8). Float math has
// the resolution to avoid this. ALPHA picks the high-pass cutoff:
// 0.001 → ~2.5 Hz cutoff at 16 kHz sample rate, well below voice
// fundamentals, fully removes DC.
static const float DC_ALPHA = 0.001f;

// =============================================================================
// GLOBAL STATE
// =============================================================================

WebSocketsClient webSocket;
I2SClass I2S;
bool isConnected = false;
bool isRegistered = false;
bool isI2SReady = false;
String deviceId;
unsigned long lastLedToggle = 0;
bool ledState = false;
unsigned long lastStatsReport = 0;
unsigned long audioPacketsSent = 0;

int16_t audioBuffer[BUFFER_SIZE];

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
// PDM MIC
// =============================================================================

void setupPDM() {
  // Seeed reference for XIAO ESP32-S3 Sense PDM mic on Arduino-ESP32 3.x.
  I2S.setPinsPdmRx(PDM_CLK_PIN, PDM_DATA_PIN);
  if (!I2S.begin(I2S_MODE_PDM_RX, SAMPLE_RATE,
                 I2S_DATA_BIT_WIDTH_16BIT,
                 I2S_SLOT_MODE_MONO)) {
    Serial.println("[PDM] I2S.begin failed");
    return;
  }
  isI2SReady = true;
  Serial.printf("[PDM] mic ready: %d Hz, 16-bit, mono, %d samples/chunk\n",
                SAMPLE_RATE, BUFFER_SIZE);
}

void processAudio() {
  if (!isConnected || !isRegistered || !isI2SReady) return;

  // Blocking read of one chunk. The new driver returns # of bytes read.
  size_t bytesRead = I2S.readBytes((char*)audioBuffer,
                                   BUFFER_SIZE * sizeof(int16_t));
  if (bytesRead == 0) return;

  int sampleCount = bytesRead / sizeof(int16_t);

  // DC blocker — running mean subtraction in float, slow enough to
  // not affect voice fundamentals (cutoff ~2.5 Hz). State carries
  // across loop iterations.
  static float dc_mean = 0.0f;
  int32_t sumAbs = 0;
  for (int i = 0; i < sampleCount; i++) {
    float x = (float)audioBuffer[i];
    dc_mean = (1.0f - DC_ALPHA) * dc_mean + DC_ALPHA * x;
    float y = x - dc_mean;

    int32_t amplified = (int32_t)(y * AUDIO_GAIN);
    if (amplified > 32767) amplified = 32767;
    if (amplified < -32768) amplified = -32768;
    audioBuffer[i] = (int16_t)amplified;
    sumAbs += abs((int)audioBuffer[i]);
  }

  webSocket.sendBIN((uint8_t*)audioBuffer, sampleCount * sizeof(int16_t));
  audioPacketsSent++;

  // Periodic stats every ~10 s (audio rate ~15.6 chunks/s → 156 chunks).
  if (audioPacketsSent % 156 == 0) {
    int avgLevel = sumAbs / sampleCount;
    Serial.printf("[stats] sent=%lu avgLevel=%d rssi=%ddBm heap=%lu\n",
                  audioPacketsSent, avgLevel, WiFi.RSSI(),
                  (unsigned long)ESP.getFreeHeap());
  }
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
  doc["sampleRate"]  = SAMPLE_RATE;
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
        // heartbeat ack
      } else if (strcmp(msgType, "factory-reset") == 0) {
        Serial.println("[WS] factory-reset requested (NVS wipe lands in Branch 3)");
      } else if (strcmp(msgType, "error") == 0) {
        Serial.printf("[WS] server error: %s\n", (const char*)(doc["message"] | ""));
      }
      break;
    }

    case WStype_BIN:
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
  Serial.println("\n=== BabyLink XIAO ESP32-S3 (Branch 2 — PDM audio) ===");
  Serial.printf("MAC: %s\n", macHex().c_str());

  pinMode(LED_PIN, OUTPUT);
  setLED(false);

  setupPDM();
  connectWiFi();
  connectWebSocket();
}

void loop() {
  webSocket.loop();
  updateLED();
  processAudio();  // blocks ~64 ms per call until next DMA chunk
}
