// BabyLink — XIAO ESP32-S3 firmware (ESP-IDF + Arduino-as-component).
//
// BLE GATT provisioning, WiFi STA + SoftAP captive-portal fallback,
// PDM mic capture, audio over WSS-PCM (relayed by the server) plus a
// best-effort WebRTC tunnel (esp_peer / Opus, peer-to-peer),
// OV3660 camera software-standby, BOOT-button long-press factory reset.

#include <Arduino.h>
#include <WiFi.h>
#include <Wire.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <Preferences.h>
#include <esp_mac.h>
#include <vector>
#include <algorithm>
#include <string>
#include <ArduinoJson.h>
#include <NimBLEDevice.h>
#include <ESP_I2S.h>
#include <ESPmDNS.h>
#include "esp_websocket_client.h"
#include "esp_crt_bundle.h"
#include "esp_peer.h"
#include "esp_peer_default.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

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

static const char* WS_PATH     = "/esp32-baby";
static const char* DEVICE_TYPE = "esp32-s3";

static const int MAX_WIFI_PROFILES   = 6;
static const int MAX_SERVER_PROFILES = 4;

// SoftAP fallback (used when no WiFi profile connects).
static const char* AP_SSID     = "BabyLinkS3-Setup";
static const char* AP_PASSWORD = "";
static const byte  DNS_PORT    = 53;
// BOOT button — 5 s hold = factory reset.
static const int   RESET_BUTTON_PIN = 0;
static const unsigned long RESET_HOLD_MS = 5000;

// OV3660 camera SCCB pins. PWDN isn't wired on this board — the camera
// is put into software standby via I2C at boot so the LDO doesn't heat
// the underside while video is unused.
static const int CAM_XCLK_PIN  = 10;
static const int CAM_SIOD_PIN  = 40;
static const int CAM_SIOC_PIN  = 39;
static const uint8_t OV3660_I2C_ADDR = 0x3C;

// XIAO ESP32-S3 Sense onboard PDM mic (MSM261D3526H1CPM).
static const int PDM_CLK_PIN  = 42;
static const int PDM_DATA_PIN = 41;
static const int SAMPLE_RATE  = 16000;
static const int BUFFER_SIZE  = 1024;
static const int AUDIO_GAIN   = 32;
static const float DC_ALPHA   = 0.001f;

// --- Battery sense --------------------------------------------------------
// The XIAO ESP32-S3 has NO built-in battery divider or dedicated ADC pin, so
// the charge can only be read via an EXTERNAL resistor divider soldered on:
//   BAT+ --[ R1 ]--+--[ R2 ]-- GND ,  ADC pin taps the R1/R2 junction.
// R1==R2 halves the voltage (4.2V -> 2.1V, safe) => divider ratio 2.0.
// Pin D4 = GPIO5 (ADC1, free on this board). If the divider isn't wired the
// reading is implausible and we report -1 ("unknown"), which the app shows as
// "--%" rather than a wrong number. Set the pin to -1 to disable the feature.
static const int   BATTERY_ADC_PIN = 5;      // GPIO5 / D4
static const float BATTERY_DIVIDER = 2.0f;   // (R1+R2)/R2; 2x equal resistors
static const unsigned long BATTERY_REPORT_MS = 30000;

struct WifiProfile   { String ssid;  String password; };
struct ServerProfile { String label; String host; uint16_t port; String roomId; };

std::vector<WifiProfile>   wifiProfiles;
std::vector<ServerProfile> serverProfiles;
int activeServer = 0;
String configDeviceName = "BabyLink S3";
Preferences preferences;

static const int LED_PIN = 21;
static const bool LED_ACTIVE_LOW = true;

// =============================================================================
// GLOBAL STATE
// =============================================================================

bool isConnected = false;
bool isRegistered = false;
bool isI2SReady = false;
bool isConfigMode = false;
bool resetButtonHeld = false;
String deviceId;
unsigned long lastLedToggle = 0;
bool ledState = false;
unsigned long lastStatusReport = 0;
unsigned long lastBatteryReport = 0;
// Watchdog: last time the WS was healthy (registered). If WiFi is up but this
// goes stale, the esp_websocket reconnect has wedged (seen after a server
// restart) and we force-recreate the client.
unsigned long lastWsOkMs = 0;
const unsigned long WS_WATCHDOG_MS = 60000;

// BLE provisioning gate. Config/command writes are only accepted while a
// provisioning window is open. A CONFIGURED device keeps it CLOSED so nobody
// in BLE range can silently re-point the monitor (or factory-reset it); a
// short BOOT-button press opens it for a few minutes as physical-presence
// proof. An UNCONFIGURED device (out-of-box / post-factory-reset) is open so
// first-time setup needs no button.
unsigned long provisioningWindowUntil = 0;
const unsigned long PROVISION_WINDOW_MS = 180000;  // 3 minutes
void openProvisioningWindow();   // defined after the BLE publish helpers

I2SClass I2S;
int16_t audioBuffer[BUFFER_SIZE];
esp_websocket_client_handle_t webSocket = nullptr;
esp_peer_handle_t webrtcPeer = nullptr;
volatile bool webrtcPeerRunning = false;
volatile bool webrtcConnected = false;     // set/cleared by onPeerState
unsigned long webrtcPacketsSent = 0;
unsigned long wssPacketsSent = 0;
uint32_t webrtcAudioPts = 0;
TaskHandle_t webrtcLoopTaskHandle = nullptr;

// Last parent socketId we've seen, used as `to` on outbound SDP/ICE so
// the server routes them. Single-parent — multi-parent rooms need one
// peer per parent and aren't supported yet.
String parentSocketId;
// A parent's requestOffer can arrive while esp_peer is still generating its
// DTLS cert. Queue it here and fire it from loop() once the peer is ready,
// rather than dropping it (which left WebRTC permanently unconnected).
volatile bool pendingOfferRequest = false;
WebServer  webServer(80);
DNSServer  dnsServer;

// =============================================================================
// CONFIG (cfg_v3 JSON ↔ NVS)
// =============================================================================

bool hasActiveServer() {
  return !serverProfiles.empty()
      && activeServer >= 0
      && activeServer < (int)serverProfiles.size();
}

// True when BLE config/command writes may be accepted (see the gate note by
// PROVISION_WINDOW_MS). Overflow-safe window compare.
static bool provisioningAllowed() {
  if (!hasActiveServer()) return true;   // unconfigured: open for first setup
  return provisioningWindowUntil != 0 &&
         (long)(provisioningWindowUntil - millis()) > 0;
}

String serializeConfig() {
  DynamicJsonDocument doc(4096);
  doc["version"] = 3;
  doc["deviceName"] = configDeviceName;
  doc["activeServer"] = activeServer;
  JsonArray wifi = doc.createNestedArray("wifi");
  for (auto& w : wifiProfiles) {
    JsonObject o = wifi.createNestedObject();
    o["ssid"] = w.ssid;
    o["password"] = w.password;
  }
  JsonArray servers = doc.createNestedArray("servers");
  for (auto& s : serverProfiles) {
    JsonObject o = servers.createNestedObject();
    o["label"]  = s.label;
    o["host"]   = s.host;
    o["port"]   = s.port;
    o["roomId"] = s.roomId;
  }
  String out;
  serializeJson(doc, out);
  return out;
}

bool deserializeConfig(const String& blob) {
  DynamicJsonDocument doc(4096);
  DeserializationError err = deserializeJson(doc, blob);
  if (err) {
    Serial.printf("[cfg] parse error: %s\n", err.c_str());
    return false;
  }
  wifiProfiles.clear();
  serverProfiles.clear();
  for (JsonObject p : doc["wifi"].as<JsonArray>()) {
    if (wifiProfiles.size() >= (size_t)MAX_WIFI_PROFILES) break;
    WifiProfile w;
    w.ssid = p["ssid"].as<String>();
    w.password = p["password"].as<String>();
    if (w.ssid.length() > 0) wifiProfiles.push_back(w);
  }
  for (JsonObject p : doc["servers"].as<JsonArray>()) {
    if (serverProfiles.size() >= (size_t)MAX_SERVER_PROFILES) break;
    ServerProfile s;
    s.label  = p["label"].as<String>();
    s.host   = p["host"].as<String>();
    s.port   = p["port"].as<uint16_t>();
    s.roomId = p["roomId"].as<String>();
    if (s.host.length() > 0 && s.roomId.length() > 0) serverProfiles.push_back(s);
  }
  activeServer = doc["activeServer"] | 0;
  if (!hasActiveServer()) activeServer = 0;
  String name = doc["deviceName"] | "";
  if (name.length() > 0) configDeviceName = name;
  return true;
}

void saveConfig() {
  String blob = serializeConfig();
  preferences.begin("babylink", false);
  preferences.putString("cfg_v3", blob);
  preferences.end();
  Serial.printf("[cfg] saved %u bytes (%u WiFi, %u servers)\n",
                (unsigned)blob.length(),
                (unsigned)wifiProfiles.size(),
                (unsigned)serverProfiles.size());
}

void clearConfig() {
  preferences.begin("babylink", false);
  preferences.clear();
  preferences.end();
  wifiProfiles.clear();
  serverProfiles.clear();
  activeServer = 0;
  Serial.println("[cfg] cleared");
}

static void seedFromDevDefaults() {
  if (strlen(DEV_DEFAULT_WIFI_SSID) > 0) {
    WifiProfile w;
    w.ssid = DEV_DEFAULT_WIFI_SSID;
    w.password = DEV_DEFAULT_WIFI_PASSWORD;
    wifiProfiles.push_back(w);
  }
  if (strlen(DEV_DEFAULT_SERVER_HOST) > 0 && strlen(DEV_DEFAULT_ROOM_ID) > 0) {
    ServerProfile s;
    s.label  = "default";
    s.host   = DEV_DEFAULT_SERVER_HOST;
    s.port   = DEV_DEFAULT_SERVER_PORT;
    s.roomId = DEV_DEFAULT_ROOM_ID;
    serverProfiles.push_back(s);
  }
}

void loadConfig() {
  preferences.begin("babylink", true);
  String blob = preferences.getString("cfg_v3", "");
  preferences.end();

  if (blob.length() > 0 && deserializeConfig(blob)) {
    Serial.printf("[cfg] loaded: %u WiFi, %u servers (active=%d), device='%s'\n",
                  (unsigned)wifiProfiles.size(), (unsigned)serverProfiles.size(),
                  activeServer, configDeviceName.c_str());
    return;
  }
  seedFromDevDefaults();
  Serial.printf("[cfg] seeded from dev_defaults: %u WiFi, %u servers\n",
                (unsigned)wifiProfiles.size(), (unsigned)serverProfiles.size());
}

// =============================================================================
// LED HELPERS
// =============================================================================

void setLED(bool on) {
  digitalWrite(LED_PIN, (on ^ LED_ACTIVE_LOW) ? HIGH : LOW);
  ledState = on;
}

void updateLED() {
  if (resetButtonHeld) return;   // checkResetButton owns the LED right now
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
  esp_read_mac(mac, ESP_MAC_WIFI_STA);
  char buf[13];
  snprintf(buf, sizeof(buf), "%02x%02x%02x%02x%02x%02x",
           mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  return String(buf);
}

// =============================================================================
// CAMERA SLEEP (OV3660 software standby via SCCB at boot)
// =============================================================================

static uint8_t cameraWriteReg(uint16_t reg, uint8_t value) {
  Wire.beginTransmission(OV3660_I2C_ADDR);
  Wire.write((uint8_t)(reg >> 8));
  Wire.write((uint8_t)(reg & 0xFF));
  Wire.write(value);
  return Wire.endTransmission();
}

void cameraSleep() {
  if (!ledcAttach(CAM_XCLK_PIN, 8000000, 1)) {
    Serial.println("[cam] ledcAttach failed — skipping camera sleep");
    return;
  }
  ledcWrite(CAM_XCLK_PIN, 1);
  delay(20);

  Wire.begin(CAM_SIOD_PIN, CAM_SIOC_PIN, 100000);
  delay(5);

  uint8_t status = cameraWriteReg(0x3008, 0x42);
  if (status == 0) {
    Serial.println("[cam] OV3660 → software standby");
  } else {
    Serial.printf("[cam] OV3660 no ACK (err %u) — Sense maybe detached?\n", status);
  }

  Wire.end();
  ledcDetach(CAM_XCLK_PIN);
}

// =============================================================================
// FACTORY RESET (BOOT-button long-press)
// =============================================================================

void performFactoryReset() {
  Serial.println("[reset] Performing factory reset — clearing NVS and restarting");
  for (int i = 0; i < 10; i++) {
    setLED(true);  delay(50);
    setLED(false); delay(50);
  }
  clearConfig();
  delay(500);
  ESP.restart();
}

// Strict debounce: any HIGH reading resets the press timer. BLE + WiFi
// RF noise can briefly pull GPIO0 to ~250 ms of intermittent HIGH while
// streaming; a permissive debounce would integrate that into a false
// 5-second "press." Skipped during the captive portal (no factory-reset
// of a device that's already being provisioned).
static void checkResetButton() {
  if (isConfigMode) return;
  if (millis() < 3000) return;   // ignore strapping-pin boot transients

  static unsigned long pressStart = 0;
  int level = digitalRead(RESET_BUTTON_PIN);
  if (level == LOW) {
    if (pressStart == 0) pressStart = millis();
    unsigned long held = millis() - pressStart;
    if (held > 1000) {
      resetButtonHeld = true;
      bool on = (held / 250) & 1;
      setLED(on);
    }
    if (held >= RESET_HOLD_MS) {
      Serial.println("[reset] 5s hold — factory reset");
      pressStart = 0;
      resetButtonHeld = false;
      performFactoryReset();
    }
  } else {
    // Released. A short, deliberate tap (80–900 ms, below the 1 s that starts
    // reset feedback) opens the BLE provisioning window as physical-presence
    // proof — so a configured monitor can be re-provisioned only by someone
    // who can physically press the button.
    if (pressStart != 0 && !resetButtonHeld) {
      unsigned long dur = millis() - pressStart;
      if (dur >= 80 && dur < 900) openProvisioningWindow();
    }
    pressStart = 0;
    resetButtonHeld = false;
  }
}

// Forward declaration — used by connectWiFi when no STA profile works.
void startConfigPortal();

// =============================================================================
// PDM MIC + AUDIO PROCESSING
// =============================================================================

void setupPDM() {
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
  if (!isI2SReady) return;

  size_t bytesRead = I2S.readBytes((char*)audioBuffer,
                                   BUFFER_SIZE * sizeof(int16_t));
  if (bytesRead == 0) return;

  int sampleCount = bytesRead / sizeof(int16_t);

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

  const int chunkBytes = sampleCount * sizeof(int16_t);

  // Send BOTH paths, always. WebRTC is the preferred one (Opus, encrypted
  // DTLS-SRTP, peer-to-peer) but esp_peer does not reliably re-establish after
  // a parent reloads, and a stuck tunnel does not always report itself
  // disconnected — so if the device sent only WebRTC the audio would go silent
  // on reconnect. Keeping the raw-PCM stream flowing over the WSS socket as a
  // constant safety net means the parent never loses audio: the browser plays
  // WebRTC when its track is live and mutes this PCM copy (the webrtcActive
  // guard in esp32-audio-handler.js), and falls straight back to PCM the
  // instant WebRTC drops. The server relays the PCM frames to parents as
  // `esp32-audio` and exempts them from its control-message rate limit.
  if (isConnected && isRegistered && webSocket) {
    esp_websocket_client_send_bin(webSocket, (const char*)audioBuffer,
                                  chunkBytes, portMAX_DELAY);
    wssPacketsSent++;
  }
  if (webrtcConnected && webrtcPeer) {
    // NOTE: tried feeding esp_peer 20 ms (320-sample) frames to fix the faint
    // "squeak" — it made the audio worse (garbled), so we send the full chunk
    // as before. The squeak, if it matters, needs a different approach.
    esp_peer_audio_frame_t frame = {};
    frame.pts  = webrtcAudioPts;
    frame.data = (uint8_t*)audioBuffer;
    frame.size = chunkBytes;
    if (esp_peer_send_audio(webrtcPeer, &frame) == ESP_PEER_ERR_NONE) {
      webrtcPacketsSent++;
    }
    webrtcAudioPts += sampleCount;
  }

  static unsigned long framesProcessed = 0;
  if (++framesProcessed % 156 == 0) {
    int avgLevel = sumAbs / sampleCount;
    Serial.printf("[stats] wss=%lu wrtc=%lu avgLevel=%d rssi=%ddBm heap=%lu\n",
                  wssPacketsSent, webrtcPacketsSent, avgLevel, WiFi.RSSI(),
                  (unsigned long)ESP.getFreeHeap());
  }
}

// =============================================================================
// BLE PROVISIONING (NimBLE GATT server — UUIDs are the contract the PWA
//                   wizard reads/writes)
// =============================================================================

#define BLE_SERVICE_UUID  "bab71111-0002-1000-8000-00805f9b34fb"
#define BLE_CHAR_CONFIG   "bab71111-0002-1001-8000-00805f9b34fb"
#define BLE_CHAR_SCAN     "bab71111-0002-1002-8000-00805f9b34fb"
#define BLE_CHAR_COMMAND  "bab71111-0002-1003-8000-00805f9b34fb"
#define BLE_CHAR_INFO     "bab71111-0002-1004-8000-00805f9b34fb"

NimBLECharacteristic* bleConfigChar = nullptr;
NimBLECharacteristic* bleScanChar   = nullptr;
NimBLECharacteristic* bleInfoChar   = nullptr;
String lastScanJson = "[]";
volatile bool bleScanInProgress = false;
bool isBLEActive = false;

void publishConfigToBle() {
  if (!bleConfigChar) return;
  String json = serializeConfig();
  bleConfigChar->setValue((const uint8_t*)json.c_str(), json.length());
}

void publishScanToBle() {
  if (!bleScanChar) return;
  bleScanChar->setValue((const uint8_t*)lastScanJson.c_str(), lastScanJson.length());
}

static String buildInfoJson() {
  StaticJsonDocument<256> doc;
  doc["model"]    = "xiao-esp32-s3";
  doc["fw"]       = "babylink-s3";
  doc["mic"]      = "pdm";
  doc["camera"]   = true;
  doc["channels"] = 1;
  doc["mac"]      = macHex();
  // Gate state for the wizard: whether the device already has a server
  // (needs the button to re-provision) and whether the window is open now.
  doc["configured"] = hasActiveServer();
  doc["provOpen"]   = provisioningAllowed();
  String out;
  serializeJson(doc, out);
  return out;
}

void publishInfoToBle() {
  if (!bleInfoChar) return;
  String json = buildInfoJson();
  bleInfoChar->setValue((const uint8_t*)json.c_str(), json.length());
}

// Open the provisioning window (short BOOT-button tap) and push the new state
// to any connected wizard so it can drop its "press the button" prompt.
void openProvisioningWindow() {
  provisioningWindowUntil = millis() + PROVISION_WINDOW_MS;
  Serial.printf("[BLE] provisioning window OPEN for %lus\n",
                (unsigned long)(PROVISION_WINDOW_MS / 1000));
  for (int i = 0; i < 3; i++) { setLED(true); delay(60); setLED(false); delay(60); }
  if (bleInfoChar) {
    publishInfoToBle();
    bleInfoChar->notify();
  }
}

static void publishScanResults(int n) {
  DynamicJsonDocument doc(2048);
  JsonArray arr = doc.to<JsonArray>();
  std::vector<int> idx;
  for (int i = 0; i < n; i++) idx.push_back(i);
  std::sort(idx.begin(), idx.end(),
            [](int a, int b) { return WiFi.RSSI(a) > WiFi.RSSI(b); });
  const int CAP = 8;
  for (int k = 0; k < (int)idx.size() && k < CAP; k++) {
    int i = idx[k];
    JsonObject o = arr.createNestedObject();
    o["ssid"]   = WiFi.SSID(i);
    o["rssi"]   = WiFi.RSSI(i);
    o["secure"] = (WiFi.encryptionType(i) != WIFI_AUTH_OPEN);
  }
  lastScanJson = "";
  serializeJson(doc, lastScanJson);
  publishScanToBle();
}

void pollBleScanComplete() {
  if (!bleScanInProgress) return;
  int n = WiFi.scanComplete();
  if (n == WIFI_SCAN_RUNNING) return;
  bleScanInProgress = false;
  if (n < 0) {
    Serial.printf("[BLE] Async scan failed (%d)\n", n);
    lastScanJson = "[]";
    publishScanToBle();
    return;
  }
  publishScanResults(n);
  WiFi.scanDelete();
  Serial.printf("[BLE] Scan complete: %d networks (%u bytes)\n",
                n, (unsigned)lastScanJson.length());
}

static void doWifiScanForBle() {
  if (bleScanInProgress) {
    Serial.println("[BLE] Scan already in progress");
    return;
  }
  Serial.println("[BLE] Starting async WiFi scan");
  WiFi.scanNetworks(true, true);
  bleScanInProgress = true;
}

class BabyLinkBLEServer : public NimBLEServerCallbacks {
  void onDisconnect(NimBLEServer* server,
                    NimBLEConnInfo& /*info*/,
                    int /*reason*/) override {
    Serial.println("[BLE] client disconnected, restart advertising");
    NimBLEDevice::getAdvertising()->start();
  }
};

class BLEProvisionCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* pCharacteristic,
               NimBLEConnInfo& /*connInfo*/) override {
    String uuid = String(pCharacteristic->getUUID().toString().c_str());
    std::string raw = pCharacteristic->getValue();
    String value;
    value.reserve(raw.length());
    for (size_t i = 0; i < raw.length(); i++) value += (char)raw[i];

    Serial.printf("[BLE] onWrite uuid=%s len=%u\n",
                  uuid.c_str(), (unsigned)raw.length());

    if (uuid.indexOf("1001") > 0) {
      // Gate: reject config writes on a configured device unless the button
      // opened the provisioning window (physical-presence proof).
      if (!provisioningAllowed()) {
        Serial.println("[BLE] Config write REJECTED — provisioning closed (tap BOOT to enable)");
        // NimBLE has already stored the raw written bytes in the char buffer.
        // Overwrite them with the real config so a later read (e.g. a wizard
        // prefilling its editor) can't surface attacker-supplied values.
        publishConfigToBle();
        return;
      }
      Serial.printf("[BLE] Config write (%u bytes)\n", (unsigned)value.length());
      if (deserializeConfig(value)) {
        publishConfigToBle();
        Serial.println("[BLE] Config staged — write 'apply' to command to persist");
      }
    } else if (uuid.indexOf("1002") > 0) {
      if (value == "scan") {
        doWifiScanForBle();
        publishScanToBle();
      }
    } else if (uuid.indexOf("1003") > 0) {
      // Gate: apply/wifi-reset mutate the device — same physical-presence rule.
      if (!provisioningAllowed()) {
        Serial.printf("[BLE] Command '%s' REJECTED — provisioning closed (tap BOOT)\n",
                      value.c_str());
        return;
      }
      if (value == "apply") {
        Serial.println("[BLE] Apply — persisting + restart");
        saveConfig();
        delay(500);
        ESP.restart();
      } else if (value == "wifi-reset") {
        Serial.println("[BLE] Wifi-reset — clearing config + restart");
        clearConfig();
        delay(500);
        ESP.restart();
      } else {
        Serial.printf("[BLE] Unknown command '%s'\n", value.c_str());
      }
    }
  }
};

void startBLE() {
  if (isBLEActive) return;
  uint8_t mac[6];
  esp_read_mac(mac, ESP_MAC_WIFI_STA);
  char bleName[24];
  snprintf(bleName, sizeof(bleName), "BabyLinkS3-%02X%02X", mac[4], mac[5]);

  Serial.printf("[BLE] Starting BLE as '%s'\n", bleName);

  NimBLEDevice::init(bleName);
  NimBLEDevice::setPower(9);
  NimBLEDevice::setMTU(517);

  NimBLEServer* server = NimBLEDevice::createServer();
  static BabyLinkBLEServer serverCallbacks;
  server->setCallbacks(&serverCallbacks);

  NimBLEService* service = server->createService(BLE_SERVICE_UUID);
  static BLEProvisionCallbacks callbacks;

  auto mkChar = [&](const char* uuid, uint32_t props) {
    NimBLECharacteristic* c = service->createCharacteristic(uuid, props);
    c->setCallbacks(&callbacks);
    return c;
  };

  bleConfigChar = mkChar(BLE_CHAR_CONFIG,  NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::WRITE);
  bleScanChar   = mkChar(BLE_CHAR_SCAN,    NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::WRITE);
                  mkChar(BLE_CHAR_COMMAND, NIMBLE_PROPERTY::WRITE);
  bleInfoChar   = mkChar(BLE_CHAR_INFO,    NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);

  publishConfigToBle();
  publishScanToBle();
  publishInfoToBle();

  NimBLEAdvertising* adv = NimBLEDevice::getAdvertising();
  adv->setName(bleName);
  adv->addServiceUUID(BLE_SERVICE_UUID);
  adv->enableScanResponse(true);
  adv->start();

  isBLEActive = true;
  Serial.printf("[BLE] Advertising. Free heap: %lu\n",
                (unsigned long)ESP.getFreeHeap());
}

// =============================================================================
// WIFI
// =============================================================================

static int pickBestWifiProfile() {
  if (wifiProfiles.empty()) return -1;
  Serial.println("[WiFi] Scanning networks ...");
  int n = WiFi.scanNetworks(false, true);
  if (n < 0) {
    Serial.printf("[WiFi] Scan failed (%d) — trying profile 0\n", n);
    WiFi.scanDelete();
    return 0;
  }
  int bestProfile = -1;
  int bestRssi = -200;
  for (int i = 0; i < n; i++) {
    String ssid = WiFi.SSID(i);
    int rssi = WiFi.RSSI(i);
    for (int p = 0; p < (int)wifiProfiles.size(); p++) {
      if (wifiProfiles[p].ssid == ssid && rssi > bestRssi) {
        bestRssi = rssi;
        bestProfile = p;
      }
    }
  }
  WiFi.scanDelete();
  if (bestProfile < 0) {
    Serial.println("[WiFi] No configured SSID visible — falling back to profile 0");
    return 0;
  }
  Serial.printf("[WiFi] Pick: profile %d '%s' @ %d dBm\n",
                bestProfile, wifiProfiles[bestProfile].ssid.c_str(), bestRssi);
  return bestProfile;
}

void connectWiFi() {
  if (wifiProfiles.empty() || serverProfiles.empty()) {
    Serial.println("[WiFi] No profiles configured — entering provisioning portal.");
    startConfigPortal();
    return;
  }

  WiFi.mode(WIFI_STA);
  int idx = pickBestWifiProfile();
  if (idx < 0) {
    startConfigPortal();
    return;
  }

  const WifiProfile& w = wifiProfiles[idx];
  Serial.printf("[WiFi] Connecting to %s ...\n", w.ssid.c_str());
  WiFi.begin(w.ssid.c_str(), w.password.c_str());

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 20000) {
    delay(250);
    Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    isConnected = true;
    Serial.printf("[WiFi] Connected. IP=%s RSSI=%d\n",
                  WiFi.localIP().toString().c_str(), WiFi.RSSI());
    // mDNS: advertise babylink-<mac>.local and (via CONFIG_LWIP_DNS_SUPPORT_
    // MDNS_QUERIES) let esp_peer resolve the browser's mDNS-obscured
    // `<uuid>.local` ICE candidates — enabling a DIRECT LAN WebRTC path when
    // parent and device share a network (lower latency, no STUN round-trip).
    static bool mdnsUp = false;
    if (!mdnsUp) {
      String host = "babylink-" + macHex();
      if (MDNS.begin(host.c_str())) {
        mdnsUp = true;
        Serial.printf("[mDNS] responder up: %s.local\n", host.c_str());
      } else {
        Serial.println("[mDNS] begin failed");
      }
    }
  } else {
    Serial.println("[WiFi] Failed to connect — entering provisioning portal.");
    startConfigPortal();
  }
}

// =============================================================================
// SOFTAP CAPTIVE PORTAL (fallback when no WiFi profile connects, or for
//                       browsers without Web Bluetooth — Safari, FF)
// =============================================================================

static const char CONFIG_HTML[] PROGMEM = R"rawliteral(
<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>BabyLink S3 Setup</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);min-height:100vh;padding:20px;color:#222}
.container{background:#fff;border-radius:20px;box-shadow:0 20px 60px rgba(0,0,0,.3);max-width:560px;margin:0 auto;padding:32px}
h1{color:#667eea;text-align:center;font-size:26px;margin-bottom:4px}
h2{font-size:15px;color:#444;margin:24px 0 10px;padding-bottom:6px;border-bottom:1px solid #eee}
.subtitle{text-align:center;color:#666;font-size:13px;margin-bottom:16px}
.info{background:#f0f4ff;padding:12px;border-radius:8px;margin-bottom:14px;font-size:12.5px;color:#555}
label{display:block;font-weight:500;color:#333;font-size:13px;margin-bottom:5px}
input,select{width:100%;padding:10px;border:2px solid #e0e0e0;border-radius:7px;font-size:14px;font-family:inherit}
input:focus,select:focus{outline:none;border-color:#667eea}
.row{display:flex;gap:6px;align-items:flex-start;background:#fafafe;padding:10px;border-radius:8px;margin-bottom:8px;border:1px solid #ececf6}
.row .col{flex:1;min-width:0}
.row input{padding:8px;font-size:13px;margin-bottom:6px}
.row input:last-child{margin-bottom:0}
.row .rm{background:#fee;color:#c33;border:none;border-radius:6px;padding:6px 10px;cursor:pointer;font-weight:600;flex-shrink:0;font-size:13px}
.row .rm:hover{background:#c33;color:#fff}
.row label{font-size:11.5px;color:#777;margin-bottom:3px}
.row .active-pick{font-size:12px;color:#666;margin-top:6px;display:flex;align-items:center;gap:6px}
.btn{width:100%;padding:13px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;margin-top:14px}
.btn.secondary{background:#eef;color:#557;font-weight:500;padding:9px;font-size:13px;margin-top:6px}
.btn.scan{background:#28a745;padding:9px;font-size:13px;margin:0 0 8px 0}
.btn:hover{filter:brightness(1.05)}
.btn[disabled]{opacity:.5;cursor:not-allowed}
.msg{padding:10px;border-radius:7px;font-size:13px;margin-top:10px}
.msg.ok{background:#e6ffea;color:#0a6}
.msg.err{background:#fee;color:#c33}
.empty{color:#888;font-size:12.5px;font-style:italic;padding:8px}
</style></head>
<body><div class="container">
<h1>BabyLink S3</h1>
<div class="subtitle">XIAO ESP32-S3 setup</div>
<div class="info">Save the WiFi networks this device will roam between. On boot it picks whichever known network has the strongest signal. The active server &amp; room is the BabyLink instance this device will register with.</div>
<h2>WiFi networks</h2>
<button id="scanBtn" class="btn scan" type="button">Scan nearby networks</button>
<div id="scanList"></div>
<div id="wifiRows"></div>
<button id="addWifi" class="btn secondary" type="button">+ Add WiFi manually</button>
<h2>Server profiles</h2>
<div id="serverRows"></div>
<button id="addServer" class="btn secondary" type="button">+ Add server</button>
<h2>Device</h2>
<input id="devName" placeholder="Device name (e.g. Nursery)">
<button id="saveBtn" class="btn" type="button">Save &amp; Connect</button>
<div id="msg"></div>
</div>
<script>
const $=id=>document.getElementById(id);
let cfg={wifi:[],servers:[],activeServer:0,deviceName:""};
const MAX_WIFI=6,MAX_SRV=4;
function render(){
  const w=$('wifiRows');w.innerHTML='';
  if(!cfg.wifi.length)w.innerHTML='<div class="empty">No WiFi networks saved yet - scan or add one manually.</div>';
  cfg.wifi.forEach((p,i)=>{const r=document.createElement('div');r.className='row';
    r.innerHTML=`<div class="col"><label>SSID</label><input data-i="${i}" data-k="ssid" value="${p.ssid||''}"><label>Password</label><input data-i="${i}" data-k="password" type="password" value="${p.password||''}"></div><button class="rm" data-rm-w="${i}" type="button">x</button>`;
    w.appendChild(r);});
  const s=$('serverRows');s.innerHTML='';
  if(!cfg.servers.length)s.innerHTML='<div class="empty">No servers saved yet.</div>';
  cfg.servers.forEach((p,i)=>{const r=document.createElement('div');r.className='row';
    r.innerHTML=`<div class="col"><label>Label</label><input data-i="${i}" data-k="label" value="${p.label||''}" placeholder="e.g. Home"><label>Host</label><input data-i="${i}" data-k="host" value="${p.host||''}" placeholder="192.168.1.10 or babylink.example"><label>Port</label><input data-i="${i}" data-k="port" type="number" value="${p.port||3001}"><label>Room ID</label><input data-i="${i}" data-k="roomId" value="${p.roomId||''}"><div class="active-pick"><input type="radio" name="active" ${i==cfg.activeServer?'checked':''} data-a="${i}"> Active for this device</div></div><button class="rm" data-rm-s="${i}" type="button">x</button>`;
    s.appendChild(r);});
  $('devName').value=cfg.deviceName||'';
}
document.addEventListener('input',e=>{const t=e.target;if(t.dataset.k){const i=+t.dataset.i,k=t.dataset.k;const list=t.closest('#wifiRows')?cfg.wifi:cfg.servers;list[i][k]=k=='port'?+t.value:t.value;}else if(t.id=='devName'){cfg.deviceName=t.value;}});
document.addEventListener('change',e=>{if(e.target.dataset.a!==undefined){cfg.activeServer=+e.target.dataset.a;}});
document.addEventListener('click',e=>{const t=e.target;if(t.dataset.rmW!==undefined){cfg.wifi.splice(+t.dataset.rmW,1);render();}else if(t.dataset.rmS!==undefined){cfg.servers.splice(+t.dataset.rmS,1);if(cfg.activeServer>=cfg.servers.length)cfg.activeServer=Math.max(0,cfg.servers.length-1);render();}else if(t.dataset.pick){cfg.wifi.push({ssid:t.dataset.pick,password:""});render();$('scanList').innerHTML='';}});
$('addWifi').onclick=()=>{if(cfg.wifi.length<MAX_WIFI){cfg.wifi.push({ssid:"",password:""});render();}};
$('addServer').onclick=()=>{if(cfg.servers.length<MAX_SRV){cfg.servers.push({label:"",host:"",port:3001,roomId:""});render();}};
$('scanBtn').onclick=async()=>{$('scanBtn').disabled=true;$('scanBtn').textContent='Scanning...';
  try{
    await fetch('/scan',{method:'POST'});
    const deadline=Date.now()+12000;let list=[];
    await new Promise(r=>setTimeout(r,1500));
    while(Date.now()<deadline){
      const r=await fetch('/scan');list=await r.json();
      if(Array.isArray(list)&&list.length)break;
      await new Promise(r=>setTimeout(r,500));
    }
    const sl=$('scanList');
    sl.innerHTML=list.length?'<div style="font-size:12px;color:#555;margin:4px 0">Tap a network to add it:</div>':'<div class="msg err">No networks found.</div>';
    list.sort((a,b)=>b.rssi-a.rssi).forEach(n=>{const b=document.createElement('button');b.type='button';b.className='btn secondary';b.style.textAlign='left';b.dataset.pick=n.ssid;b.textContent=`${n.ssid} (${n.rssi} dBm${n.secure?'':' - open'})`;sl.appendChild(b);});
  }catch(e){$('scanList').innerHTML='<div class="msg err">Scan failed: '+e.message+'</div>';}
  $('scanBtn').disabled=false;$('scanBtn').textContent='Scan nearby networks';};
$('saveBtn').onclick=async()=>{if(!cfg.wifi.length||!cfg.wifi[0].ssid){$('msg').innerHTML='<div class="msg err">Add at least one WiFi network.</div>';return;}
  if(!cfg.servers.length||!cfg.servers[0].host||!cfg.servers[0].roomId){$('msg').innerHTML='<div class="msg err">Add at least one server with host + room.</div>';return;}
  $('saveBtn').disabled=true;
  try{const r=await fetch('/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(cfg)});const j=await r.json();
    if(r.ok){clearDraft();$('msg').innerHTML='<div class="msg ok">Saved! Device is rebooting...</div>';}
    else{$('msg').innerHTML='<div class="msg err">'+(j.error||'Save failed')+'</div>';$('saveBtn').disabled=false;}
  }catch(e){$('msg').innerHTML='<div class="msg err">'+e.message+'</div>';$('saveBtn').disabled=false;}};
// Persist in-progress edits to localStorage so an Android-induced
// AP drop + auto-reconnect + page reload doesn't wipe what was typed.
// On save the entry is dropped — we only want it across crash cycles
// during the same provisioning session.
const LS_KEY='bl_portal_cfg';
function saveDraft(){try{localStorage.setItem(LS_KEY,JSON.stringify(cfg));}catch(_){}}
function loadDraft(){try{const s=localStorage.getItem(LS_KEY);return s?JSON.parse(s):null;}catch(_){return null;}}
function clearDraft(){try{localStorage.removeItem(LS_KEY);}catch(_){}}
document.addEventListener('input',saveDraft);
document.addEventListener('change',saveDraft);
document.addEventListener('click',e=>{if(e.target.closest('.btn'))setTimeout(saveDraft,0);});
(async()=>{
  const draft=loadDraft();
  if(draft){cfg=draft;if(!cfg.wifi)cfg.wifi=[];if(!cfg.servers)cfg.servers=[];}
  else{try{const r=await fetch('/config');cfg=await r.json();if(!cfg.wifi)cfg.wifi=[];if(!cfg.servers)cfg.servers=[];}catch(e){}}
  render();
})();
</script></body></html>
)rawliteral";

static void handleRoot()      { webServer.send_P(200, "text/html", CONFIG_HTML); }
static void handleGetConfig() { webServer.send(200, "application/json", serializeConfig()); }

// Captive-portal scan plumbing.
//
// The old handleApScan called WiFi.scanNetworks(false, ...) — synchronous,
// blocked the HTTP loop, and disrupted the SoftAP long enough that
// Android dropped the client and roamed back to a remembered home WiFi.
// Same pattern as the BLE scan path: trigger async, poll completion
// from the main loop, return cached results from the GET.
//
//   POST /scan  → kick off an async scan, returns immediately
//   GET  /scan  → returns the latest cached array (empty while running)
static String  webScanJson         = "[]";
static bool    webScanInProgress   = false;

static void handleApScanTrigger() {
  if (!webScanInProgress) {
    Serial.println("[portal] Starting async WiFi scan (passive)");
    webScanJson = "[]";
    webScanInProgress = true;
    // Passive scan + short per-channel dwell: the radio still has to
    // leave the SoftAP's channel to hear other beacons, but each visit
    // is brief enough that the client doesn't notice missed beacons.
    // Active scans actively transmit probes and dwell ~300 ms — long
    // enough for Android to deauth and roam.
    //   args: async=true, show_hidden=true, passive=true, ms_per_chan=120
    WiFi.scanNetworks(true, true, true, 120);
  }
  webServer.send(202, "application/json", "{\"status\":\"scanning\"}");
}

static void handleApScanPoll() {
  webServer.send(200, "application/json", webScanJson);
}

void pollWebScanComplete() {
  if (!webScanInProgress) return;
  int n = WiFi.scanComplete();
  if (n == WIFI_SCAN_RUNNING) return;
  webScanInProgress = false;
  if (n < 0) {
    Serial.printf("[portal] Async scan failed (%d)\n", n);
    webScanJson = "[]";
    return;
  }
  DynamicJsonDocument doc(2048);
  JsonArray arr = doc.to<JsonArray>();
  std::vector<int> idx;
  for (int i = 0; i < n; i++) idx.push_back(i);
  std::sort(idx.begin(), idx.end(),
            [](int a, int b) { return WiFi.RSSI(a) > WiFi.RSSI(b); });
  // 12 entries is plenty for a "tap to add" picker — we're not
  // constrained by the BLE 512-byte attribute cap here.
  const int CAP = 12;
  for (int k = 0; k < (int)idx.size() && k < CAP; k++) {
    int i = idx[k];
    JsonObject o = arr.createNestedObject();
    o["ssid"]   = WiFi.SSID(i);
    o["rssi"]   = WiFi.RSSI(i);
    o["secure"] = (WiFi.encryptionType(i) != WIFI_AUTH_OPEN);
  }
  webScanJson = "";
  serializeJson(doc, webScanJson);
  WiFi.scanDelete();
  Serial.printf("[portal] Scan complete: %d networks (%u bytes)\n",
                n, webScanJson.length());
}

static void handleSave() {
  if (!webServer.hasArg("plain")) {
    webServer.send(400, "application/json", "{\"error\":\"missing JSON body\"}");
    return;
  }
  String body = webServer.arg("plain");
  if (!deserializeConfig(body)) {
    webServer.send(400, "application/json", "{\"error\":\"invalid config JSON\"}");
    return;
  }
  if (wifiProfiles.empty() || serverProfiles.empty()) {
    webServer.send(400, "application/json",
                   "{\"error\":\"need at least one WiFi profile and one server profile\"}");
    return;
  }
  saveConfig();
  webServer.send(200, "application/json", "{\"ok\":true}");
  delay(800);
  ESP.restart();
}

void startConfigPortal() {
  if (isConfigMode) return;
  Serial.println("[portal] Starting WiFi-AP + DNS + WebServer captive portal");

  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP(AP_SSID, AP_PASSWORD);
  IPAddress ip = WiFi.softAPIP();
  Serial.printf("[portal] AP '%s'  IP=%s  -> http://192.168.4.1\n",
                AP_SSID, ip.toString().c_str());

  dnsServer.start(DNS_PORT, "*", ip);
  webServer.on("/",       handleRoot);
  webServer.on("/config", HTTP_GET,  handleGetConfig);
  webServer.on("/scan",   HTTP_GET,  handleApScanPoll);
  webServer.on("/scan",   HTTP_POST, handleApScanTrigger);
  webServer.on("/save",   HTTP_POST, handleSave);
  webServer.onNotFound(handleRoot);
  webServer.begin();
  isConfigMode = true;
}

static void portalLoopTick() {
  if (!isConfigMode) return;
  dnsServer.processNextRequest();
  webServer.handleClient();
  pollWebScanComplete();
}

// =============================================================================
// WEBSOCKET (server register + audio stream)
// =============================================================================

// Read the battery via the external divider. Returns 0-100, or -1 when the
// feature is off OR the reading is implausible (no divider soldered → a
// floating pin won't land in the Li-ion range), so the app shows "--%".
int readBatteryPercent() {
  if (BATTERY_ADC_PIN < 0) return -1;
  uint32_t sum = 0;
  const int n = 8;
  for (int i = 0; i < n; i++) sum += analogReadMilliVolts(BATTERY_ADC_PIN);
  float vbat = (sum / (float)n) / 1000.0f * BATTERY_DIVIDER;
  if (vbat < 3.0f || vbat > 4.35f) return -1;   // implausible → unknown
  int pct = (int)lroundf((vbat - 3.30f) / (4.20f - 3.30f) * 100.0f);
  if (pct < 0) pct = 0;
  if (pct > 100) pct = 100;
  return pct;
}

// Periodic battery report so the parent sees a live level (and notices a baby
// about to die). -1 is sent as "unknown" and surfaces as "--%".
void sendBatteryStatus() {
  if (BATTERY_ADC_PIN < 0 || !isRegistered || !webSocket) return;
  StaticJsonDocument<96> doc;
  doc["type"]    = "status";
  doc["battery"] = readBatteryPercent();
  String payload;
  serializeJson(doc, payload);
  esp_websocket_client_send_text(webSocket, payload.c_str(), payload.length(), portMAX_DELAY);
}

void sendRegister() {
  if (!hasActiveServer() || !webSocket) return;
  const ServerProfile& s = serverProfiles[activeServer];
  StaticJsonDocument<384> doc;
  doc["type"]        = "register";
  doc["roomId"]      = s.roomId;
  doc["name"]        = configDeviceName;
  doc["mac"]         = macHex();
  doc["sampleRate"]  = SAMPLE_RATE;
  doc["channels"]    = 1;
  doc["device_type"] = DEVICE_TYPE;
  if (BATTERY_ADC_PIN >= 0) doc["battery"] = readBatteryPercent();

  String payload;
  serializeJson(doc, payload);
  Serial.printf("[WS] register -> %s\n", payload.c_str());
  esp_websocket_client_send_text(webSocket, payload.c_str(), payload.length(),
                                 portMAX_DELAY);
}

static void handleWsTextFrame(const char* data, size_t len) {
  // SDP answers from the browser can run 700-1500 bytes; ArduinoJson
  // overhead roughly doubles that. 4 KB is comfortable for our signal
  // frames. DynamicJsonDocument allocates from heap (PSRAM-eligible).
  DynamicJsonDocument doc(4096);
  DeserializationError err = deserializeJson(doc, data, len);
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
    Serial.println("[WS] factory-reset requested by server");
    clearConfig();
    delay(200);
    ESP.restart();
  } else if (strcmp(msgType, "error") == 0) {
    Serial.printf("[WS] server error: %s\n", (const char*)(doc["message"] | ""));
  } else if (strcmp(msgType, "signal") == 0) {
    // SDP / ICE relay from the parent browser. Track the parent's
    // socketId, kick off the offer when requested, hand answer / ICE
    // off to esp_peer.
    const char* from = doc["fromSocketId"] | "";
    if (from[0]) parentSocketId = from;

    if (!webrtcPeer) {
      if (doc["requestOffer"] | false) {
        // Peer still initialising — remember the request so loop() can fire
        // it the moment esp_peer is ready.
        pendingOfferRequest = true;
        Serial.println("[peer] requestOffer before peer ready — queued");
      } else {
        Serial.println("[peer] inbound signal but esp_peer not initialised");
      }
      return;
    }
    if (doc["requestOffer"] | false) {
      Serial.printf("[peer] requestOffer from %s — starting connection\n", from);
      esp_peer_new_connection(webrtcPeer);
      return;
    }
    // MultiStreamManager (browser) sends answers as
    // {type, sdp} objects from RTCPeerConnection.createAnswer().
    // Accept the legacy raw-string form too in case anything else
    // (a Python test harness, an older receiver) still sends that.
    if (doc["answer"].is<JsonObject>() || doc["answer"].is<const char*>()) {
      String answer;
      if (doc["answer"].is<JsonObject>()) {
        answer = doc["answer"]["sdp"].as<String>();
      } else {
        answer = doc["answer"].as<String>();
      }
      esp_peer_msg_t pmsg = {};
      pmsg.type = ESP_PEER_MSG_TYPE_SDP;
      pmsg.data = (uint8_t*)answer.c_str();
      pmsg.size = answer.length();
      esp_peer_send_msg(webrtcPeer, &pmsg);
      Serial.printf("[peer] <- SDP/answer (%u B)\n", (unsigned)answer.length());
      return;
    }
    if (doc["ice"].is<JsonObject>()) {
      String cand = doc["ice"]["candidate"].as<String>();
      if (cand.length() == 0) return;   // end-of-candidates marker
      esp_peer_msg_t pmsg = {};
      pmsg.type = ESP_PEER_MSG_TYPE_CANDIDATE;
      pmsg.data = (uint8_t*)cand.c_str();
      pmsg.size = cand.length();
      esp_peer_send_msg(webrtcPeer, &pmsg);
      // Log the full candidate: a browser without mic/cam permission hides
      // its LAN IP behind an mDNS `.local` name the device can't resolve.
      Serial.printf("[peer] <- ICE: %s\n", cand.c_str());
    }
  }
}

static void onWsEvent(void* /*arg*/, esp_event_base_t /*base*/,
                      int32_t id, void* event_data) {
  esp_websocket_event_data_t* e = (esp_websocket_event_data_t*)event_data;
  switch (id) {
    case WEBSOCKET_EVENT_CONNECTED:
      Serial.println("[WS] connected");
      isConnected = true;
      sendRegister();
      break;
    case WEBSOCKET_EVENT_DISCONNECTED:
      Serial.println("[WS] disconnected");
      isConnected = false;
      isRegistered = false;
      deviceId = "";
      break;
    case WEBSOCKET_EVENT_DATA:
      // op_code 0x1 = text, 0x2 = binary, 0x8 = close, 0x9 = ping, 0xA = pong.
      // Only consume text — the audio path is send-only.
      if (e->op_code == 0x1 && e->data_len > 0) {
        handleWsTextFrame((const char*)e->data_ptr, e->data_len);
      }
      break;
    case WEBSOCKET_EVENT_ERROR:
      Serial.println("[WS] error");
      // Clear registered/connected on error too, not just on a clean
      // disconnect. A server restart can leave a half-open connection that
      // only surfaces as an error — without this, isRegistered stays stale
      // true and the reconnect watchdog never starts its timer.
      isConnected = false;
      isRegistered = false;
      break;
    default:
      break;
  }
}

void connectWebSocket() {
  if (isConfigMode) {
    Serial.println("[WS] In config portal — skipping WS connect.");
    return;
  }
  if (!hasActiveServer()) {
    Serial.println("[WS] No server configured. Skipping.");
    return;
  }
  const ServerProfile& s = serverProfiles[activeServer];
  char uri[160];
  snprintf(uri, sizeof(uri), "%s://%s:%u%s",
           s.port == 443 ? "wss" : "ws",
           s.host.c_str(), s.port, WS_PATH);
  Serial.printf("[WS] Connecting to %s\n", uri);

  esp_websocket_client_config_t cfg = {};
  cfg.uri = uri;
  cfg.reconnect_timeout_ms = 5000;
  cfg.network_timeout_ms   = 10000;
  // BUFFER_SIZE * 2 bytes per audio packet (= 2048 bytes); default outbox
  // is 1024 which would truncate.
  cfg.buffer_size = 4096;
  cfg.ping_interval_sec   = 15;
  cfg.pingpong_timeout_sec = 6;
  if (s.port == 443) {
    cfg.crt_bundle_attach = esp_crt_bundle_attach;
  }

  webSocket = esp_websocket_client_init(&cfg);
  if (!webSocket) {
    Serial.println("[WS] init failed");
    return;
  }
  esp_websocket_register_events(webSocket, WEBSOCKET_EVENT_ANY, onWsEvent, NULL);
  esp_websocket_client_start(webSocket);
}

// =============================================================================
// WEBRTC (esp_peer init + signaling)
//
// SDP / ICE flow through the existing WSS connection: on_msg → server →
// parent browser, inbound `signal` frames → esp_peer_send_msg. A browser-
// side `requestOffer` triggers esp_peer_new_connection.
// =============================================================================

static const char* peerStateName(esp_peer_state_t s) {
  switch (s) {
    case ESP_PEER_STATE_CLOSED:                    return "closed";
    case ESP_PEER_STATE_DISCONNECTED:              return "disconnected";
    case ESP_PEER_STATE_NEW_CONNECTION:            return "new_connection";
    case ESP_PEER_STATE_CANDIDATE_GATHERING:       return "candidate_gathering";
    case ESP_PEER_STATE_PAIRING:                   return "pairing";
    case ESP_PEER_STATE_PAIRED:                    return "paired";
    case ESP_PEER_STATE_CONNECTING:                return "connecting";
    case ESP_PEER_STATE_CONNECTED:                 return "connected";
    case ESP_PEER_STATE_CONNECT_FAILED:            return "connect_failed";
    case ESP_PEER_STATE_DATA_CHANNEL_CONNECTED:    return "dc_connected";
    case ESP_PEER_STATE_DATA_CHANNEL_OPENED:       return "dc_opened";
    case ESP_PEER_STATE_DATA_CHANNEL_CLOSED:       return "dc_closed";
    case ESP_PEER_STATE_DATA_CHANNEL_DISCONNECTED: return "dc_disconnected";
    default:                                       return "?";
  }
}

static int onPeerState(esp_peer_state_t state, void* /*ctx*/) {
  Serial.printf("[peer] state=%s (%d)\n", peerStateName(state), (int)state);
  if (state == ESP_PEER_STATE_CONNECTED) {
    webrtcConnected = true;
    webrtcAudioPts  = 0;       // restart timestamps on every fresh tunnel
  } else if (state == ESP_PEER_STATE_DISCONNECTED ||
             state == ESP_PEER_STATE_CONNECT_FAILED ||
             state == ESP_PEER_STATE_CLOSED) {
    webrtcConnected = false;
  }
  return 0;
}

static int onPeerMsg(esp_peer_msg_t* msg, void* /*ctx*/) {
  if (parentSocketId.length() == 0 || !webSocket) {
    Serial.printf("[peer] msg type=%d size=%d dropped (no parent yet)\n",
                  (int)msg->type, msg->size);
    return 0;
  }
  // esp_peer hands us raw SDP text or a single ICE candidate string.
  // Wrap into the same `signal` event shape the browser-side receiver
  // expects (`offer` = SDP string, `ice` = addIceCandidate-compatible
  // object). Server is a pure relay — it forwards the frame verbatim
  // to the target socketId.
  DynamicJsonDocument doc(2048);
  doc["type"] = "signal";
  doc["to"]   = parentSocketId;
  String payload((const char*)msg->data, msg->size);
  if (msg->type == ESP_PEER_MSG_TYPE_SDP) {
    // esp_peer emits `a=setup:passive` in offers; RFC 5763 / JSEP say
    // offers must use `a=setup:actpass` or browsers silently never
    // start ICE. Rewrite — the browser still picks "active" in the
    // answer, ESP stays DTLS server.
    int idx = payload.indexOf("a=setup:passive");
    if (idx >= 0) payload = payload.substring(0, idx) + "a=setup:actpass" +
                            payload.substring(idx + strlen("a=setup:passive"));
    // Wrap as {type, sdp} so the browser can pass it straight to
    // RTCSessionDescription.
    JsonObject offer = doc.createNestedObject("offer");
    offer["type"] = "offer";
    offer["sdp"]  = payload;
  } else if (msg->type == ESP_PEER_MSG_TYPE_CANDIDATE) {
    JsonObject ice = doc.createNestedObject("ice");
    ice["candidate"]     = payload;
    ice["sdpMid"]        = "audio";   // single audio m-line
    ice["sdpMLineIndex"] = 0;
  } else {
    Serial.printf("[peer] unknown msg type=%d\n", (int)msg->type);
    return 0;
  }
  String frame;
  serializeJson(doc, frame);
  esp_websocket_client_send_text(webSocket, frame.c_str(), frame.length(),
                                 portMAX_DELAY);
  Serial.printf("[peer] -> %s (%d B)\n",
                msg->type == ESP_PEER_MSG_TYPE_SDP ? "SDP/offer" : "ICE",
                (int)frame.length());
  return 0;
}

static void webrtcLoopTask(void* /*arg*/) {
  while (webrtcPeerRunning) {
    esp_peer_main_loop(webrtcPeer);
    vTaskDelay(pdMS_TO_TICKS(20));
  }
  vTaskDelete(nullptr);
}

void setupWebRTC() {
  // Generate the DTLS cert up front so the first connection doesn't
  // stall on it.
  esp_peer_pre_generate_cert();

  esp_peer_default_cfg_t defaults = {};
  defaults.agent_recv_timeout = 300;            // 100 ms → 300 ms: slack
                                                // for DTLS retransmits on
                                                // residential WiFi.
  defaults.rtp_cfg.audio_recv_jitter.cache_size = 1024;
  defaults.rtp_cfg.send_pool_size = 1024;
  defaults.rtp_cfg.send_queue_num = 10;

  // STUN so the device advertises a server-reflexive candidate, not just a
  // bare host one. Note: WebRTC media does not currently complete on this
  // stack — the browser's DTLS ClientHello arrives fragmented (large modern
  // ClientHello) and ESP-IDF's mbedtls DTLS server cannot reassemble a
  // fragmented ClientHello (ssl_tls12_server.c: "ClientHello fragmentation
  // not supported" → MBEDTLS_ERR_SSL_FEATURE_UNAVAILABLE). Until that upstream
  // limitation is resolved, audio rides the WSS-PCM path. Kept wired so the
  // moment mbedtls/esp_peer gains fragmented-ClientHello support this works.
  static esp_peer_ice_server_cfg_t iceServers[1] = {};
  iceServers[0].stun_url = (char*)"stun:stun.l.google.com:19302";

  esp_peer_cfg_t cfg = {};
  cfg.server_lists     = iceServers;
  cfg.server_num       = 1;
  cfg.role             = ESP_PEER_ROLE_CONTROLLING;     // baby initiates the offer
  cfg.ice_trans_policy = ESP_PEER_ICE_TRANS_POLICY_ALL;
  cfg.audio_info.codec       = ESP_PEER_AUDIO_CODEC_OPUS;
  cfg.audio_info.sample_rate = SAMPLE_RATE;             // 16 kHz, matches PDM
  cfg.audio_info.channel     = 1;
  cfg.audio_dir          = ESP_PEER_MEDIA_DIR_SEND_ONLY;
  cfg.video_dir          = ESP_PEER_MEDIA_DIR_NONE;
  cfg.enable_data_channel = false;
  cfg.on_state           = onPeerState;
  cfg.on_msg             = onPeerMsg;
  cfg.extra_cfg          = &defaults;
  cfg.extra_size         = sizeof(defaults);

  int ret = esp_peer_open(&cfg, esp_peer_get_default_impl(), &webrtcPeer);
  if (ret != ESP_PEER_ERR_NONE || !webrtcPeer) {
    Serial.printf("[peer] esp_peer_open failed ret=%d\n", ret);
    webrtcPeer = nullptr;
    return;
  }
  Serial.printf("[peer] esp_peer opened — heap=%lu\n",
                (unsigned long)ESP.getFreeHeap());

  webrtcPeerRunning = true;
  // Pinned to core 1 so ICE / DTLS work doesn't fight the Arduino loop
  // on core 0.
  if (xTaskCreatePinnedToCore(webrtcLoopTask, "wrtc-loop",
                              10 * 1024, nullptr, 5,
                              &webrtcLoopTaskHandle, 1) != pdPASS) {
    Serial.println("[peer] failed to create main-loop task");
    webrtcPeerRunning = false;
    esp_peer_close(webrtcPeer);
    webrtcPeer = nullptr;
  }
}

// =============================================================================
// SETUP / LOOP
// =============================================================================

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\n=== BabyLink XIAO ESP32-S3 ===");
  Serial.printf("[id] MAC=%s\n", macHex().c_str());

  // Camera to standby first — stops the LDO heating up while the rest
  // of boot runs.
  cameraSleep();

  pinMode(LED_PIN, OUTPUT);
  setLED(false);
  pinMode(RESET_BUTTON_PIN, INPUT_PULLUP);

  deviceId = String("esp32_") + macHex();
  Serial.printf("[id] device_id=%s type=%s name='%s'\n",
                deviceId.c_str(), DEVICE_TYPE, configDeviceName.c_str());

  loadConfig();
  setupPDM();
  // BLE before WiFi so connectWiFi / startConfigPortal own the
  // WiFi.mode() decision.
  startBLE();
  connectWiFi();         // falls through to startConfigPortal on failure
  connectWebSocket();    // no-op while isConfigMode
  if (!isConfigMode) {
    setupWebRTC();
  }
}

void loop() {
  checkResetButton();
  if (isConfigMode) {
    portalLoopTick();
    updateLED();
    pollBleScanComplete();
    delay(1);
    return;
  }
  updateLED();
  pollBleScanComplete();

  // A requestOffer that raced esp_peer init is honoured here, once the peer
  // exists and we know which parent to answer.
  if (pendingOfferRequest && webrtcPeer && parentSocketId.length() > 0) {
    pendingOfferRequest = false;
    Serial.println("[peer] firing queued requestOffer");
    esp_peer_new_connection(webrtcPeer);
  }

  processAudio();

  unsigned long now = millis();

  // Reconnect watchdog. esp_websocket auto-reconnects, but after a server
  // restart it can wedge and never recover on its own — the device then sits
  // "gone" until a power-cycle. If WiFi is up but we haven't been registered
  // for WS_WATCHDOG_MS, tear the client down and recreate it for a clean
  // reconnect. lastWsOkMs is seeded at boot so a device that never registers
  // (server down at startup) is also retried rather than stuck forever.
  if (isRegistered) lastWsOkMs = now;
  if (WiFi.status() == WL_CONNECTED && now - lastWsOkMs > WS_WATCHDOG_MS) {
    // esp_websocket's own auto-reconnect wedges after a server restart, and
    // recreating the client in place did not recover it either. Reboot — a
    // fresh boot re-registers reliably every time. Worst case during a real
    // outage is a reboot every WS_WATCHDOG_MS until the server returns.
    Serial.println("[WS] watchdog: unregistered too long — rebooting");
    delay(100);
    ESP.restart();
  }

  if (BATTERY_ADC_PIN >= 0 && now - lastBatteryReport >= BATTERY_REPORT_MS) {
    lastBatteryReport = now;
    sendBatteryStatus();
  }

  if (now - lastStatusReport >= 5000) {
    lastStatusReport = now;
    Serial.printf("[status] uptime=%lus wifi=%s ws=%s heap=%u\n",
                  now / 1000,
                  (WiFi.status() == WL_CONNECTED) ? "up" : "down",
                  isRegistered ? "registered" : (isConnected ? "open" : "down"),
                  (unsigned)ESP.getFreeHeap());
    // Keep the BLE INFO characteristic's provOpen flag fresh (e.g. after the
    // provisioning window expires) for any connected wizard.
    static bool lastProvOpen = false;
    bool provOpen = provisioningAllowed();
    if (isBLEActive && provOpen != lastProvOpen) {
      lastProvOpen = provOpen;
      publishInfoToBle();
      if (bleInfoChar) bleInfoChar->notify();
    }
  }
}

extern "C" void app_main() {
  initArduino();
  setup();
  while (true) {
    loop();
  }
}
