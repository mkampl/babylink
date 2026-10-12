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
#include "esp_opus_enc.h"
#include "freertos/stream_buffer.h"
#include "freertos/semphr.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_sleep.h"
#include "esp_random.h"

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

// WebRTC audio: esp_peer only packetises — it needs ready-encoded Opus frames,
// not PCM. 20 ms frames at the mic's native 16 kHz (wideband; the browser's
// decoder upsamples to the 48 kHz RTP clock itself).
static const int OPUS_FRAME_MS      = 20;
static const int OPUS_FRAME_SAMPLES = SAMPLE_RATE * OPUS_FRAME_MS / 1000;   // 320
static const int OPUS_BITRATE       = 32000;
static const int OPUS_COMPLEXITY    = 1;
// PCM queued between the I2S loop and the encoder task: 4 I2S chunks (~256 ms).
static const size_t OPUS_PCM_QUEUE_BYTES = BUFFER_SIZE * sizeof(int16_t) * 4;

// --- Battery sense --------------------------------------------------------
// The XIAO ESP32-S3 has NO built-in battery divider or dedicated ADC pin, so
// the charge can only be read via an EXTERNAL resistor divider soldered on:
//   BAT+ --[ R1 ]--+--[ R2 ]-- GND ,  ADC pin taps the R1/R2 junction.
// R1==R2 halves the voltage (4.2V -> 2.1V, safe) => divider ratio 2.0.
// Pin D4 = GPIO5 (ADC1, free on this board). If the divider isn't wired the
// reading is implausible and we report -1 ("unknown"), which the app shows as
// "--%" rather than a wrong number. Set the pin to -1 to disable the feature.
static const int   BATTERY_ADC_PIN = 5;      // GPIO5 / D4
// Nominally (R1+R2)/R2 = 2.0 for 2x equal resistors, but CALIBRATED against a
// full cell: with 2.0 a full battery (~4.20V, LED off) read only 4.01V/79%, so
// the true gain is 2.0*4200/4011 = 2.094 (resistor tolerance + ADC gain error).
// Re-calibrate here if a full charge doesn't read ~100% (serial logs v=…mV).
static const float BATTERY_DIVIDER = 2.094f;
static const unsigned long BATTERY_REPORT_MS = 30000;

// Set to 1 to force one WebRTC recovery cycle ~25s after boot (validates the
// close/reopen is crash-free). MUST be 0 for production.
#define WRTC_RECOVERY_SELFTEST 0

struct WifiProfile   { String ssid;  String password; };
// `tls` selects wss:// (+ CA bundle) vs ws://. Profiles saved by older
// firmware/wizards have no "tls" field; for those it is derived from the old
// convention (port 443 => TLS), so existing devices keep connecting the same way.
struct ServerProfile { String label; String host; uint16_t port; String roomId; bool tls; };

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
volatile bool webrtcLoopDone = false;      // loop task has exited (for a clean restart)
unsigned long webrtcPacketsSent = 0;
unsigned long wssPacketsSent = 0;
// esp_peer expects the audio pts in MILLISECONDS (it multiplies by 48 for the
// Opus RTP clock), so this advances by OPUS_FRAME_MS per encoded frame.
volatile uint32_t webrtcAudioPts = 0;
TaskHandle_t webrtcLoopTaskHandle = nullptr;

// Opus encoder task state. processAudio() pushes conditioned PCM into
// opusPcmQueue while the tunnel is up; opusEncodeTask() cuts it into 20 ms
// frames, encodes and hands them to esp_peer. Keeps encoding off the I2S/WSS
// hot path. peerLock serialises esp_peer_send_audio against esp_peer_close.
StreamBufferHandle_t opusPcmQueue = nullptr;
SemaphoreHandle_t peerLock = nullptr;
volatile bool opusResetPending = false;    // tunnel (re)connected: drop stale PCM
TaskHandle_t opusTaskHandle = nullptr;
unsigned long opusFramesEncoded = 0;
unsigned long opusEncodeErrors = 0;
unsigned long opusPcmDropped = 0;          // PCM bytes the queue had no room for
unsigned long webrtcSendErrors = 0;
uint32_t opusEncUsSum = 0, opusEncUsMax = 0, opusEncUsCount = 0;
uint32_t opusBytesSum = 0;

// Malformed-offer / wedged-esp_peer recovery: after long uptime esp_peer can
// start emitting a malformed SDP offer the browser rejects, so WebRTC never
// connects (audio silently stays on the WSS-PCM path). We count offers that
// don't reach CONNECTED and, past a threshold, re-init esp_peer WITHOUT a
// reboot — so the PCM stream (and the parent's audio) never drops.
int webrtcOfferCount = 0;               // offers sent since the last CONNECTED
unsigned long lastOfferMs = 0;
unsigned long lastRecoveryMs = 0;
static void startOffer();               // esp_peer_new_connection + bookkeeping
static void restartWebRTC();            // close + reopen esp_peer, keep the device up

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

// Serialize the config. `withSecrets` is true ONLY for the NVS copy. Anything
// that leaves the device (BLE CONFIG characteristic, captive-portal GET
// /config) uses withSecrets=false: WiFi passwords are never sent — each entry
// carries "password":"" plus "hasPassword" — and, while the provisioning gate
// is closed, the room ID (= access to the baby's audio) is blanked too, with
// "hasRoomId". deserializeConfig() restores blanked fields from the stored
// profile on write, so a wizard that round-trips a masked config loses nothing.
String serializeConfig(bool withSecrets) {
  const bool showRoom = withSecrets || provisioningAllowed();
  DynamicJsonDocument doc(4096);
  doc["version"] = 3;
  doc["deviceName"] = configDeviceName;
  doc["activeServer"] = activeServer;
  JsonArray wifi = doc.createNestedArray("wifi");
  for (auto& w : wifiProfiles) {
    JsonObject o = wifi.createNestedObject();
    o["ssid"] = w.ssid;
    o["password"] = withSecrets ? w.password : String("");
    if (!withSecrets) o["hasPassword"] = w.password.length() > 0;
  }
  JsonArray servers = doc.createNestedArray("servers");
  for (auto& s : serverProfiles) {
    JsonObject o = servers.createNestedObject();
    o["label"]  = s.label;
    o["host"]   = s.host;
    o["port"]   = s.port;
    o["roomId"] = showRoom ? s.roomId : String("");
    if (!withSecrets) o["hasRoomId"] = s.roomId.length() > 0;
    o["tls"]    = s.tls;
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
  // Keep the previous profiles so masked fields (empty password / room ID,
  // see serializeConfig) can be restored from what is already stored.
  const std::vector<WifiProfile>   prevWifi    = wifiProfiles;
  const std::vector<ServerProfile> prevServers = serverProfiles;
  wifiProfiles.clear();
  serverProfiles.clear();
  for (JsonObject p : doc["wifi"].as<JsonArray>()) {
    if (wifiProfiles.size() >= (size_t)MAX_WIFI_PROFILES) break;
    WifiProfile w;
    w.ssid = p["ssid"] | "";
    w.password = p["password"] | "";
    if (w.password.length() == 0) {
      // Masked round-trip: an empty password for a known SSID keeps the
      // stored one. (Turning a saved network into an open one therefore
      // needs the entry removed and re-added.)
      for (auto& old : prevWifi) {
        if (old.ssid == w.ssid) { w.password = old.password; break; }
      }
    }
    if (w.ssid.length() > 0) wifiProfiles.push_back(w);
  }
  for (JsonObject p : doc["servers"].as<JsonArray>()) {
    if (serverProfiles.size() >= (size_t)MAX_SERVER_PROFILES) break;
    ServerProfile s;
    s.label  = p["label"] | "";
    s.host   = p["host"] | "";
    s.port   = p["port"].as<uint16_t>();
    s.roomId = p["roomId"] | "";
    s.tls    = p["tls"].is<bool>() ? p["tls"].as<bool>() : (s.port == 443);
    if (s.roomId.length() == 0) {
      // Masked round-trip (room ID blanked while the gate was closed).
      for (auto& old : prevServers) {
        if (old.host == s.host && old.port == s.port) { s.roomId = old.roomId; break; }
      }
    }
    if (s.host.length() > 0 && s.roomId.length() > 0) serverProfiles.push_back(s);
  }
  activeServer = doc["activeServer"] | 0;
  if (!hasActiveServer()) activeServer = 0;
  String name = doc["deviceName"] | "";
  if (name.length() > 0) configDeviceName = name;
  return true;
}

void saveConfig() {
  String blob = serializeConfig(true);
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
    s.tls    = (s.port == 443);
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
// 5-second "press." Also active during the captive portal: a configured
// device whose WiFi failed needs the short tap to unlock re-provisioning
// (BLE and portal /save are both gated), and the 5 s factory reset is the
// way out of a portal that keeps failing.
static void checkResetButton() {
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
  if (webrtcConnected && webrtcPeer && opusPcmQueue) {
    size_t queued = xStreamBufferSend(opusPcmQueue, audioBuffer, chunkBytes, 0);
    if (queued < (size_t)chunkBytes) opusPcmDropped += chunkBytes - queued;
  }

  static unsigned long framesProcessed = 0;
  if (++framesProcessed % 156 == 0) {
    int avgLevel = sumAbs / sampleCount;
    Serial.printf("[stats] wss=%lu wrtc=%lu avgLevel=%d rssi=%ddBm heap=%lu\n",
                  wssPacketsSent, webrtcPacketsSent, avgLevel, WiFi.RSSI(),
                  (unsigned long)ESP.getFreeHeap());
    if (opusEncUsCount > 0 || opusEncodeErrors || webrtcSendErrors || opusPcmDropped) {
      Serial.printf("[opus] frames=%lu avgUs=%lu maxUs=%lu avgB=%lu encErr=%lu sendErr=%lu "
                    "dropB=%lu intHeap=%u minIntHeap=%u stackFree=%u\n",
                    opusFramesEncoded,
                    (unsigned long)(opusEncUsCount ? opusEncUsSum / opusEncUsCount : 0),
                    (unsigned long)opusEncUsMax,
                    (unsigned long)(opusEncUsCount ? opusBytesSum / opusEncUsCount : 0),
                    opusEncodeErrors, webrtcSendErrors, opusPcmDropped,
                    (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
                    (unsigned)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL),
                    opusTaskHandle ? (unsigned)uxTaskGetStackHighWaterMark(opusTaskHandle) : 0u);
      opusEncUsSum = opusEncUsMax = opusEncUsCount = opusBytesSum = 0;
    }
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
  String json = serializeConfig(false);
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
  publishConfigToBle();   // the room ID is readable again while the window is open
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
// Everything interpolated into innerHTML goes through esc(): SSIDs come from
// any nearby access point and must never be able to inject markup.
const esc=v=>String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function render(){
  const w=$('wifiRows');w.innerHTML='';
  if(!cfg.wifi.length)w.innerHTML='<div class="empty">No WiFi networks saved yet - scan or add one manually.</div>';
  cfg.wifi.forEach((p,i)=>{const r=document.createElement('div');r.className='row';
    r.innerHTML=`<div class="col"><label>SSID</label><input data-i="${i}" data-k="ssid" value="${esc(p.ssid)}"><label>Password</label><input data-i="${i}" data-k="password" type="password" value="${esc(p.password)}" placeholder="${p.hasPassword?'Saved - leave empty to keep':''}"></div><button class="rm" data-rm-w="${i}" type="button">x</button>`;
    w.appendChild(r);});
  const s=$('serverRows');s.innerHTML='';
  if(!cfg.servers.length)s.innerHTML='<div class="empty">No servers saved yet.</div>';
  cfg.servers.forEach((p,i)=>{const r=document.createElement('div');r.className='row';
    r.innerHTML=`<div class="col"><label>Label</label><input data-i="${i}" data-k="label" value="${esc(p.label)}" placeholder="e.g. Home"><label>Host</label><input data-i="${i}" data-k="host" value="${esc(p.host)}" placeholder="192.168.1.10 or babylink.example"><label>Port</label><input data-i="${i}" data-k="port" type="number" value="${esc(p.port||3001)}"><label>Room ID</label><input data-i="${i}" data-k="roomId" value="${esc(p.roomId)}" placeholder="${p.hasRoomId?'Saved - leave empty to keep':''}"><div class="active-pick"><input type="checkbox" data-i="${i}" data-k="tls" ${(p.tls===undefined?(+p.port===443):p.tls)?'checked':''} style="width:auto"> Secure connection (wss / TLS)</div><div class="active-pick"><input type="radio" name="active" ${i==cfg.activeServer?'checked':''} data-a="${i}"> Active for this device</div></div><button class="rm" data-rm-s="${i}" type="button">x</button>`;
    s.appendChild(r);});
  $('devName').value=cfg.deviceName||'';
}
document.addEventListener('input',e=>{const t=e.target;if(t.dataset.k){const i=+t.dataset.i,k=t.dataset.k;const list=t.closest('#wifiRows')?cfg.wifi:cfg.servers;list[i][k]=k=='port'?+t.value:(k=='tls'?t.checked:t.value);}else if(t.id=='devName'){cfg.deviceName=t.value;}});
document.addEventListener('change',e=>{if(e.target.dataset.a!==undefined){cfg.activeServer=+e.target.dataset.a;}else if(e.target.dataset.k=='tls'){cfg.servers[+e.target.dataset.i].tls=e.target.checked;}});
document.addEventListener('click',e=>{const t=e.target;if(t.dataset.rmW!==undefined){cfg.wifi.splice(+t.dataset.rmW,1);render();}else if(t.dataset.rmS!==undefined){cfg.servers.splice(+t.dataset.rmS,1);if(cfg.activeServer>=cfg.servers.length)cfg.activeServer=Math.max(0,cfg.servers.length-1);render();}else if(t.dataset.pick){cfg.wifi.push({ssid:t.dataset.pick,password:""});render();$('scanList').innerHTML='';}});
$('addWifi').onclick=()=>{if(cfg.wifi.length<MAX_WIFI){cfg.wifi.push({ssid:"",password:""});render();}};
$('addServer').onclick=()=>{if(cfg.servers.length<MAX_SRV){cfg.servers.push({label:"",host:"",port:3001,roomId:"",tls:false});render();}};
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
  }catch(e){$('scanList').innerHTML='<div class="msg err">Scan failed: '+esc(e.message)+'</div>';}
  $('scanBtn').disabled=false;$('scanBtn').textContent='Scan nearby networks';};
$('saveBtn').onclick=async()=>{if(!cfg.wifi.length||!cfg.wifi[0].ssid){$('msg').innerHTML='<div class="msg err">Add at least one WiFi network.</div>';return;}
  if(!cfg.servers.length||!cfg.servers[0].host||!(cfg.servers[0].roomId||cfg.servers[0].hasRoomId)){$('msg').innerHTML='<div class="msg err">Add at least one server with host + room.</div>';return;}
  $('saveBtn').disabled=true;
  try{const r=await fetch('/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(cfg)});const j=await r.json();
    if(r.ok){clearDraft();$('msg').innerHTML='<div class="msg ok">Saved! Device is rebooting...</div>';}
    else{$('msg').innerHTML='<div class="msg err">'+esc(j.error||'Save failed')+'</div>';$('saveBtn').disabled=false;}
  }catch(e){$('msg').innerHTML='<div class="msg err">'+esc(e.message)+'</div>';$('saveBtn').disabled=false;}};
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

// Last time someone used the portal (any HTTP request). The STA retry below
// stays out of the way while a person is actively configuring the device.
static unsigned long lastPortalActivityMs = 0;
static void portalTouch() { lastPortalActivityMs = millis(); }

// Portal STA retry state (see portalStaRetryTick).
static const unsigned long PORTAL_STA_RETRY_MS   = 60000;
static const unsigned long PORTAL_STA_ATTEMPT_MS = 15000;
static unsigned long lastStaRetryMs = 0;
static unsigned long staAttemptStartMs = 0;
static int staNextProfile = 0;

static void handleRoot()      { portalTouch(); webServer.send_P(200, "text/html", CONFIG_HTML); }
static void handleGetConfig() { portalTouch(); webServer.send(200, "application/json", serializeConfig(false)); }

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
  portalTouch();
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
  portalTouch();
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
  portalTouch();
  if (!webServer.hasArg("plain")) {
    webServer.send(400, "application/json", "{\"error\":\"missing JSON body\"}");
    return;
  }
  // Same physical-presence rule as BLE: the AP is open, so on a device that is
  // already configured (and only here because its WiFi failed) anyone in range
  // could otherwise re-point the monitor. A short BOOT tap opens the window.
  if (!provisioningAllowed()) {
    webServer.send(403, "application/json",
                   "{\"error\":\"Locked: briefly press the BOOT button on the device, then save again.\"}");
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
  lastStaRetryMs = millis();
}

// Portal STA retry. A device with a saved config lands in the portal when its
// WiFi didn't come up within the boot attempt — typically a power outage where
// the router boots slower than the device. Without a retry the monitor would
// sit in the portal until someone power-cycles it. So while a config exists,
// periodically retry the saved networks and reboot into normal operation as
// soon as one connects. The attempt is skipped while anyone is using the
// portal (associated AP client, recent HTTP request, scan running, BLE
// wizard connected): the STA connect hops channels, which would knock a phone
// off the SoftAP mid-setup (see the passive-scan note in handleApScanTrigger).

static bool portalInUse(unsigned long now) {
  if (WiFi.softAPgetStationNum() > 0) return true;
  if (lastPortalActivityMs != 0 && now - lastPortalActivityMs < PORTAL_STA_RETRY_MS) return true;
  if (webScanInProgress || bleScanInProgress) return true;
  NimBLEServer* srv = NimBLEDevice::getServer();
  if (srv && srv->getConnectedCount() > 0) return true;
  return false;
}

static void portalStaRetryTick() {
  if (wifiProfiles.empty() || !hasActiveServer()) return;   // nothing to retry
  unsigned long now = millis();
  if (staAttemptStartMs != 0) {
    if (WiFi.status() == WL_CONNECTED) {
      Serial.printf("[portal] WiFi '%s' is back — rebooting into normal operation\n",
                    WiFi.SSID().c_str());
      delay(200);
      ESP.restart();
    }
    if (now - staAttemptStartMs >= PORTAL_STA_ATTEMPT_MS) {
      Serial.println("[portal] STA retry failed — staying in portal");
      WiFi.disconnect(false);      // stop the STA attempt; the SoftAP stays up
      staAttemptStartMs = 0;
      lastStaRetryMs = now;
    }
    return;
  }
  if (now - lastStaRetryMs < PORTAL_STA_RETRY_MS) return;
  lastStaRetryMs = now;
  if (portalInUse(now)) return;
  const WifiProfile& w = wifiProfiles[staNextProfile % wifiProfiles.size()];
  staNextProfile = (staNextProfile + 1) % (int)wifiProfiles.size();
  Serial.printf("[portal] retrying saved WiFi '%s'\n", w.ssid.c_str());
  WiFi.begin(w.ssid.c_str(), w.password.c_str());
  staAttemptStartMs = now;
}

static void portalLoopTick() {
  if (!isConfigMode) return;
  dnsServer.processNextRequest();
  webServer.handleClient();
  pollWebScanComplete();
  portalStaRetryTick();
}

// =============================================================================
// WEBSOCKET (server register + audio stream)
// =============================================================================

// Resting-voltage → state-of-charge for a 1S Li-ion/LiPo cell, as breakpoints
// (monotonic high→low), linearly interpolated between points. This follows the
// real curve — a flat plateau where 3.73-3.95V ≈ 20-70% and a steep drop below
// ~3.7V — instead of a straight line, which badly over-reports mid-range (a
// linear map calls 3.75V "50%"; the true value is ~25%). Sources: common Li-ion
// OCV/SoC charts (lygte-info.dk, Battery University). Most accurate at rest or
// light load; while charging the terminal voltage is elevated so it reads high.
struct BatPoint { float v; int pct; };
static const BatPoint BAT_CURVE[] = {
  {4.20f, 100}, {4.15f, 95}, {4.11f, 90}, {4.08f, 85}, {4.02f, 80}, {3.98f, 75},
  {3.95f, 70},  {3.91f, 65}, {3.87f, 60}, {3.85f, 55}, {3.84f, 50}, {3.82f, 45},
  {3.80f, 40},  {3.79f, 35}, {3.77f, 30}, {3.75f, 25}, {3.73f, 20}, {3.71f, 15},
  {3.69f, 10},  {3.61f, 5},  {3.30f, 0},
};

int socFromVoltage(float v) {
  const int n = sizeof(BAT_CURVE) / sizeof(BAT_CURVE[0]);
  if (v >= BAT_CURVE[0].v) return 100;
  if (v <= BAT_CURVE[n - 1].v) return 0;
  for (int i = 1; i < n; i++) {
    if (v >= BAT_CURVE[i].v) {
      const BatPoint& hi = BAT_CURVE[i - 1];
      const BatPoint& lo = BAT_CURVE[i];
      float t = (v - lo.v) / (hi.v - lo.v);
      return (int)lroundf(lo.pct + t * (hi.pct - lo.pct));
    }
  }
  return 0;
}

// Read the battery via the external divider. Returns 0-100, or -1 ("unknown"
// → the app shows "--%") when the feature is off or NO divider is soldered.
//
// Detecting "not soldered" robustly matters: a floating ADC pin can drift into
// the valid Li-ion range and show a bogus %. So we first probe with an internal
// pull-down — an unwired pin is dragged to ~0 mV, but a wired divider (~50k
// source) still holds the pin well above it (~0.8-1.0 V). Below the probe
// threshold ⇒ nothing connected ⇒ unknown.
// Returns the smoothed battery voltage (already scaled by the divider), or a
// negative value when the feature is off or NO divider is wired.
float readBatteryVolts() {

  pinMode(BATTERY_ADC_PIN, INPUT_PULLDOWN);
  delay(3);
  int probeMv = analogReadMilliVolts(BATTERY_ADC_PIN);
  pinMode(BATTERY_ADC_PIN, INPUT); // release so the pull-down doesn't skew the read
  delay(3);
  if (probeMv < 300) return -1.0f; // pulled to ~0 ⇒ no divider wired ⇒ unknown

  uint32_t sum = 0;
  const int n = 16;
  for (int i = 0; i < n; i++) sum += analogReadMilliVolts(BATTERY_ADC_PIN);
  float vbat = (sum / (float)n) / 1000.0f * BATTERY_DIVIDER;
  // 2.9 V, not 3.0: the readings right before the cell cuts out are exactly the
  // ones the SoC curve's 0% point is calibrated from, so they must not be
  // discarded as "implausible". Still well above any real divider fault.
  if (vbat < 2.9f || vbat > 4.35f) return -1.0f;   // implausible ⇒ unknown
  // Light smoothing (EMA) so the % doesn't wobble ±1-2% with WiFi-load sag and
  // ADC noise on the flat plateau, where a few mV is a percent or two.
  static float vbatEma = 0.0f;
  vbatEma = (vbatEma <= 0.0f) ? vbat : vbatEma + 0.25f * (vbat - vbatEma);
  return vbatEma;
}

int readBatteryPercent() {
  float v = readBatteryVolts();
  if (v < 0.0f) return -1;
  return socFromVoltage(v); // real Li-ion curve, not a straight line
}

// Periodic battery report so the parent sees a live level (and notices a baby
// about to die). -1 is sent as "unknown" and surfaces as "--%".
void sendBatteryStatus() {
  if (BATTERY_ADC_PIN < 0 || !isRegistered || !webSocket) return;
  // One read for both fields: readBatteryVolts() advances an EMA on every call,
  // so reading twice here would age the average twice as fast per report.
  float v = readBatteryVolts();
  StaticJsonDocument<128> doc;
  doc["type"]    = "status";
  doc["battery"] = (v < 0.0f) ? -1 : socFromVoltage(v);
  // Raw millivolts alongside the percentage. The percentage is derived from
  // BAT_CURVE, so it can't be used to calibrate that curve; the mV can. This is
  // the only way to see the voltage at the moment the cell gives out, since the
  // device is on battery then and no serial cable is attached.
  doc["batteryMv"] = (v < 0.0f) ? -1 : (int)lroundf(v * 1000.0f);
  String payload;
  serializeJson(doc, payload);
  esp_websocket_client_send_text(webSocket, payload.c_str(), payload.length(), portMAX_DELAY);
}

// Per-device secret, generated once on first boot and presented on every
// register. The server pins it to this device's MAC the first time it sees it
// (trust on first use) and from then on refuses a register for this MAC
// without it — so a stranger who knows the MAC can no longer kick the real
// device out of its slot or impersonate it. Lives in its own NVS namespace,
// which a factory reset (clearConfig) does not touch, so re-provisioning the
// same device keeps its identity. Servers that predate this ignore the field.
String deviceToken;

static void loadDeviceToken() {
  Preferences auth;
  auth.begin("bl_auth", false);
  String t = auth.getString("tok", "");
  if (t.length() != 32) {
    uint8_t raw[16];
    esp_fill_random(raw, sizeof(raw));
    char hex[33];
    for (int i = 0; i < 16; i++) snprintf(hex + i * 2, 3, "%02x", raw[i]);
    t = String(hex);
    auth.putString("tok", t);
    Serial.println("[auth] generated device token");
  }
  auth.end();
  deviceToken = t;
}

// Set by the WS task when the server rejects our token; loop() then parks the
// client for TOKEN_BACKOFF_MS instead of letting it reconnect every 5 s.
volatile bool tokenRejected = false;
unsigned long tokenBackoffUntil = 0;
const unsigned long TOKEN_BACKOFF_MS = 300000;   // 5 minutes

void sendRegister() {
  if (!hasActiveServer() || !webSocket) return;
  const ServerProfile& s = serverProfiles[activeServer];
  StaticJsonDocument<512> doc;
  doc["type"]        = "register";
  doc["roomId"]      = s.roomId;
  doc["name"]        = configDeviceName;
  doc["mac"]         = macHex();
  doc["sampleRate"]  = SAMPLE_RATE;
  doc["channels"]    = 1;
  doc["device_type"] = DEVICE_TYPE;
  if (BATTERY_ADC_PIN >= 0) doc["battery"] = readBatteryPercent();
  if (deviceToken.length() > 0) doc["deviceToken"] = deviceToken;

  String payload;
  serializeJson(doc, payload);
  // Don't print the token to the serial log.
  Serial.printf("[WS] register -> room=%s mac=%s name='%s'\n",
                s.roomId.c_str(), macHex().c_str(), configDeviceName.c_str());
  esp_websocket_client_send_text(webSocket, payload.c_str(), payload.length(),
                                 portMAX_DELAY);
}

// Chrome hides a parent's LAN IP behind an mDNS `<uuid>.local` host ICE
// candidate. esp_peer's ICE agent doesn't resolve it, so it falls back to the
// STUN/hairpin path (public IP) even on the same LAN. Resolve the name to a LAN
// IP ourselves (the responder + lwIP mDNS queries are already up) and rewrite
// the candidate, giving esp_peer a numeric host candidate for a DIRECT-LAN path.
static String resolveMdnsCandidate(const String& cand) {
  int dot = cand.indexOf(".local");
  if (dot < 0) return cand; // already numeric (host with real IP, or srflx/relay)
  int sp = cand.lastIndexOf(' ', dot);
  int start = (sp < 0) ? 0 : sp + 1;
  String host = cand.substring(start, dot); // the <uuid>, without ".local"
  if (host.length() == 0) return cand;
  // Chrome reuses one <uuid> for every host candidate of a connection (UDP,
  // TCP, per interface), so a tiny cache saves repeated 1 s lookups.
  static String cacheHost[4];
  static IPAddress cacheIp[4];
  static int cacheNext = 0;
  IPAddress ip;
  bool cached = false;
  for (int i = 0; i < 4; i++) {
    if (cacheHost[i] == host) { ip = cacheIp[i]; cached = true; break; }
  }
  if (!cached) {
    ip = MDNS.queryHost((char*)host.c_str(), 1000);
    if ((uint32_t)ip == 0) {
      Serial.printf("[mDNS] no A-record for %s.local — leaving candidate as-is\n", host.c_str());
      return cand;
    }
    cacheHost[cacheNext] = host;
    cacheIp[cacheNext] = ip;
    cacheNext = (cacheNext + 1) % 4;
  }
  String out = cand.substring(0, start) + ip.toString() + cand.substring(dot + 6); // 6 = len(".local")
  Serial.printf("[mDNS] %s.local -> %s (direct-LAN candidate)\n", host.c_str(), ip.toString().c_str());
  return out;
}

static void sendCandidateToPeer(const String& cand) {
  if (!webrtcPeer) return;
  esp_peer_msg_t pmsg = {};
  pmsg.type = ESP_PEER_MSG_TYPE_CANDIDATE;
  pmsg.data = (uint8_t*)cand.c_str();
  pmsg.size = cand.length();
  esp_peer_send_msg(webrtcPeer, &pmsg);
  Serial.printf("[peer] <- ICE: %s\n", cand.c_str());
}

// mDNS lookups block for up to a second each. They used to run inline on the
// websocket event task, stalling every other inbound frame (and the server's
// keepalive) for each `.local` candidate. A small worker task now resolves
// them; numeric candidates still go straight to esp_peer.
static QueueHandle_t mdnsQueue = nullptr;

static void mdnsResolveTask(void* /*arg*/) {
  for (;;) {
    char* item = nullptr;
    if (xQueueReceive(mdnsQueue, &item, portMAX_DELAY) != pdTRUE || !item) continue;
    String cand = resolveMdnsCandidate(String(item));
    free(item);
    sendCandidateToPeer(cand);
  }
}

static void handleIceCandidate(const String& cand) {
  if (cand.indexOf(".local") < 0) { sendCandidateToPeer(cand); return; }
  if (!mdnsQueue) {
    mdnsQueue = xQueueCreate(8, sizeof(char*));
    if (mdnsQueue &&
        xTaskCreatePinnedToCore(mdnsResolveTask, "mdns-res", 6 * 1024, nullptr, 3,
                                nullptr, 1) != pdPASS) {
      vQueueDelete(mdnsQueue);
      mdnsQueue = nullptr;
    }
  }
  char* dup = mdnsQueue ? strdup(cand.c_str()) : nullptr;
  if (!dup || xQueueSend(mdnsQueue, &dup, 0) != pdTRUE) {
    free(dup);
    sendCandidateToPeer(cand);   // can't resolve right now — pass it through as-is
  }
}

// Start the WebRTC offer to the current parent, tracking attempts so the
// recovery logic can spot a wedged esp_peer that never reaches CONNECTED.
static void startOffer() {
  if (!webrtcPeer) return;
  esp_peer_new_connection(webrtcPeer);
  lastOfferMs = millis();
  webrtcOfferCount++;
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
    const char* code = doc["code"] | "";
    Serial.printf("[WS] server error: %s %s\n", code, (const char*)(doc["message"] | ""));
    if (strcmp(code, "DEVICE_TOKEN_MISMATCH") == 0) {
      Serial.println("[auth] server rejected this device's token — another registration "
                     "owns this MAC on the server. The room owner can remove the device "
                     "there; retrying in 5 min");
      tokenRejected = true;
    }
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
      startOffer();
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
      // Resolve a browser's mDNS-obscured `<uuid>.local` host candidate to a LAN
      // IP so esp_peer can pair on the direct-LAN path (not just STUN/hairpin).
      // Done off this task (see handleIceCandidate).
      handleIceCandidate(cand);
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
           s.tls ? "wss" : "ws",
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
  if (s.tls) {
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
    opusResetPending = true;   // encoder: drop PCM queued before this tunnel
    webrtcOfferCount = 0;      // healthy tunnel — clear the recovery counter
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
  webrtcLoopDone = true;   // let restartWebRTC know it's safe to close the peer
  vTaskDelete(nullptr);
}

// Open esp_peer and start its main-loop task. Split out of setupWebRTC so the
// recovery path can reopen the peer without re-generating the DTLS cert.
static bool startPeer() {
  esp_peer_default_cfg_t defaults = {};
  defaults.agent_recv_timeout = 300;
  defaults.rtp_cfg.audio_recv_jitter.cache_size = 1024;
  // Holds sent RTP packets for NACK retransmission. Opus frames are
  // ~60-120 B, so 16 KB keeps well over a second of history.
  defaults.rtp_cfg.send_pool_size = 16 * 1024;
  defaults.rtp_cfg.send_queue_num = 64;

  static esp_peer_ice_server_cfg_t iceServers[1] = {};
  iceServers[0].stun_url = (char*)"stun:stun.l.google.com:19302";

  esp_peer_cfg_t cfg = {};
  cfg.server_lists     = iceServers;
  cfg.server_num       = 1;
  cfg.role             = ESP_PEER_ROLE_CONTROLLING;
  cfg.ice_trans_policy = ESP_PEER_ICE_TRANS_POLICY_ALL;
  cfg.audio_info.codec       = ESP_PEER_AUDIO_CODEC_OPUS;
  cfg.audio_info.sample_rate = SAMPLE_RATE;
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
    return false;
  }
  Serial.printf("[peer] esp_peer opened — heap=%lu\n", (unsigned long)ESP.getFreeHeap());

  webrtcPeerRunning = true;
  webrtcLoopDone = false;
  if (xTaskCreatePinnedToCore(webrtcLoopTask, "wrtc-loop", 10 * 1024, nullptr, 5,
                              &webrtcLoopTaskHandle, 1) != pdPASS) {
    Serial.println("[peer] failed to create main-loop task");
    webrtcPeerRunning = false;
    esp_peer_close(webrtcPeer);
    webrtcPeer = nullptr;
    return false;
  }
  return true;
}

// Re-initialise esp_peer WITHOUT rebooting: stop the loop task, close the wedged
// peer, reopen a fresh one, and re-offer to the current parent. The WSS-PCM
// audio path is untouched throughout, so the parent never loses audio (no
// "baby unreachable" alarm) — this just heals the WebRTC tunnel in place.
static void restartWebRTC() {
  Serial.println("[peer] recovery: reinitialising esp_peer (no reboot; PCM keeps flowing)");
  webrtcPeerRunning = false;                       // ask the loop task to exit
  for (int i = 0; i < 80 && !webrtcLoopDone; i++) { // wait up to ~800ms for it
    vTaskDelay(pdMS_TO_TICKS(10));
  }
  webrtcConnected  = false;                         // encoder stops sending
  if (peerLock) xSemaphoreTake(peerLock, portMAX_DELAY);
  if (webrtcPeer) {
    esp_peer_close(webrtcPeer);
    webrtcPeer = nullptr;
  }
  if (peerLock) xSemaphoreGive(peerLock);
  pendingOfferRequest = false;
  webrtcOfferCount = 0;
  webrtcAudioPts   = 0;
  if (startPeer() && parentSocketId.length() > 0) {
    Serial.println("[peer] recovery: offering to the waiting parent");
    startOffer();
  }
}

// Opus encoder task: pulls conditioned 16 kHz PCM from opusPcmQueue, encodes
// 20 ms frames and sends them through esp_peer. Runs on its own task (stack in
// PSRAM — libopus needs a deep stack) so encoding never stalls the I2S read or
// the WSS-PCM send in loop().
static void opusEncodeTask(void* /*arg*/) {
  esp_opus_enc_config_t cfg = ESP_OPUS_ENC_CONFIG_DEFAULT();
  cfg.sample_rate      = SAMPLE_RATE;
  cfg.channel          = 1;
  cfg.bits_per_sample  = 16;
  cfg.bitrate          = OPUS_BITRATE;
  cfg.frame_duration   = ESP_OPUS_ENC_FRAME_DURATION_20_MS;
  cfg.application_mode = ESP_OPUS_ENC_APPLICATION_VOIP;
  cfg.complexity       = OPUS_COMPLEXITY;
  cfg.enable_fec       = false;
  // No DTX: a quiet nursery must still produce a steady packet stream, or the
  // parent's track looks stalled/muted between sounds.
  cfg.enable_dtx       = false;
  cfg.enable_vbr       = true;
  void* enc = nullptr;
  esp_audio_err_t err = esp_opus_enc_open(&cfg, sizeof(cfg), &enc);
  int inSize = 0, outSize = 0;
  if (err == ESP_AUDIO_ERR_OK) err = esp_opus_enc_get_frame_size(enc, &inSize, &outSize);
  if (err != ESP_AUDIO_ERR_OK || inSize != OPUS_FRAME_SAMPLES * (int)sizeof(int16_t)) {
    Serial.printf("[opus] encoder init failed err=%d in=%d out=%d — WebRTC audio disabled\n",
                  (int)err, inSize, outSize);
    if (enc) esp_opus_enc_close(enc);
    vTaskDelete(nullptr);
    return;
  }
  Serial.printf("[opus] encoder ready: %d Hz mono, %d ms, %d bps, in=%dB out<=%dB\n",
                SAMPLE_RATE, OPUS_FRAME_MS, OPUS_BITRATE, inSize, outSize);

  uint8_t* pcm = (uint8_t*)heap_caps_malloc(inSize, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  uint8_t* out = (uint8_t*)heap_caps_malloc(outSize, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  if (!pcm || !out) {
    Serial.println("[opus] out of memory — WebRTC audio disabled");
    free(pcm); free(out);
    esp_opus_enc_close(enc);
    vTaskDelete(nullptr);
    return;
  }
  size_t have = 0;
  for (;;) {
    size_t got = xStreamBufferReceive(opusPcmQueue, pcm + have, inSize - have,
                                      pdMS_TO_TICKS(500));
    if (opusResetPending) {
      // Fresh tunnel: start from live audio, not PCM left from a previous one.
      opusResetPending = false;
      xStreamBufferReset(opusPcmQueue);
      have = 0;
      continue;
    }
    have += got;
    if (have < (size_t)inSize) continue;
    have = 0;
    if (!webrtcConnected) continue;

    esp_audio_enc_in_frame_t  inFrame  = {};
    esp_audio_enc_out_frame_t outFrame = {};
    inFrame.buffer  = pcm;
    inFrame.len     = inSize;
    outFrame.buffer = out;
    outFrame.len    = outSize;
    int64_t t0 = esp_timer_get_time();
    err = esp_opus_enc_process(enc, &inFrame, &outFrame);
    uint32_t us = (uint32_t)(esp_timer_get_time() - t0);
    if (err != ESP_AUDIO_ERR_OK || outFrame.encoded_bytes == 0) {
      opusEncodeErrors++;
      continue;
    }
    opusFramesEncoded++;
    opusEncUsSum += us;
    opusEncUsCount++;
    if (us > opusEncUsMax) opusEncUsMax = us;
    opusBytesSum += outFrame.encoded_bytes;

    xSemaphoreTake(peerLock, portMAX_DELAY);
    if (webrtcConnected && webrtcPeer) {
      esp_peer_audio_frame_t frame = {};
      frame.pts  = webrtcAudioPts;
      frame.data = out;
      frame.size = (int)outFrame.encoded_bytes;
      if (esp_peer_send_audio(webrtcPeer, &frame) == ESP_PEER_ERR_NONE) {
        webrtcPacketsSent++;
      } else {
        webrtcSendErrors++;
      }
      webrtcAudioPts += OPUS_FRAME_MS;
    }
    xSemaphoreGive(peerLock);
  }
}

static void startOpusEncoder() {
  peerLock = xSemaphoreCreateMutex();
  opusPcmQueue = xStreamBufferCreateWithCaps(OPUS_PCM_QUEUE_BYTES,
                                             OPUS_FRAME_SAMPLES * sizeof(int16_t),
                                             MALLOC_CAP_SPIRAM);
  if (!peerLock || !opusPcmQueue) {
    Serial.println("[opus] failed to allocate queue — WebRTC audio disabled");
    return;
  }
  // libopus is stack-hungry (Espressif recommend ~40 KB for its encoders);
  // put the stack in PSRAM to spare internal RAM.
  if (xTaskCreatePinnedToCoreWithCaps(opusEncodeTask, "opus-enc", 40 * 1024, nullptr, 4,
                                      &opusTaskHandle, 1, MALLOC_CAP_SPIRAM) != pdPASS) {
    Serial.println("[opus] failed to start encoder task — WebRTC audio disabled");
  }
}

void setupWebRTC() {
  // Generate the DTLS cert up front so the first connection doesn't stall on it.
  // NOTE on STUN + the stack: the browser's DTLS ClientHello can arrive
  // fragmented; older ESP-IDF mbedtls couldn't reassemble it (the patched
  // babylink-idf image fixes this). Config lives in startPeer(), which the
  // recovery path reuses to reopen esp_peer without regenerating the cert.
  esp_peer_pre_generate_cert();
  startOpusEncoder();
  startPeer();
}

// =============================================================================
// SETUP / LOOP
// =============================================================================

// =============================================================================
// CHARGE MODE (press RESET twice)
// =============================================================================
// Charging while the firmware runs barely works: WiFi plus continuous audio
// draws about as much as the XIAO's charger supplies, so the cell gains only a
// few mV per minute. Charge mode parks the device with every radio off so the
// full charge current reaches the battery.
//
// The trigger is the RESET button, not BOOT: GPIO0's press durations are fully
// allocated (tap = provisioning, 5 s = factory reset) and it picks up RF noise
// while streaming, so splitting it into finer time windows would make the
// factory reset less reliable — an expensive thing to get wrong in the field.
//
// The counter lives in NVS, not RTC_NOINIT. RTC memory survives a software
// reset — which is what a host-driven RTS pulse produces, and why this first
// tested fine on the bench — but not the RESET button pulling EN, the one path
// that actually matters here. Flash survives both. Two small writes per boot is
// a fair price for a gesture that works with the physical button.
static const char* CHARGE_NVS_KEY = "chgarm";
// Generous on purpose: the press cannot be seen during the ~0.7 s of boot that
// precedes our code, so the usable part of this window is shorter than it
// looks. Still far below any plausible gap between two unrelated reboots.
static const unsigned long CHARGE_ARM_MS = 6000;
static bool chargeArmActive = false;

// Deliberately light sleep, not deep sleep: waking from deep sleep re-enters
// the ROM, which samples GPIO0 as a strapping pin and can land in USB download
// mode — a silent device that looks bricked. Light sleep keeps the CPU state,
// and at ~1-2 mA it is already negligible against a ~100 mA charge current.
// Persisted arm flag: 1 = a boot is in progress that has not yet run long
// enough to count as "settled", so the next reset completes the gesture.
static void chargeArmWrite(uint8_t v) {
  preferences.begin("babylink", false);
  preferences.putUChar(CHARGE_NVS_KEY, v);
  preferences.end();
}

static uint8_t chargeArmRead() {
  preferences.begin("babylink", true);
  uint8_t v = preferences.getUChar(CHARGE_NVS_KEY, 0);
  preferences.end();
  return v;
}

static void enterChargeMode() {
  // Clear first: the RESET that ends charge mode must count as a fresh first
  // press, or the device would drop straight back into charging.
  chargeArmWrite(0);

  Serial.println("[charge] double reset — charge mode: radios off, light sleep");
  Serial.println("[charge] press RESET once to resume monitoring");
  Serial.flush();

  esp_sleep_enable_timer_wakeup(4000000ULL); // 4 s
  for (;;) {
    // A short heartbeat blink, so a charging device doesn't look dead — the
    // failure mode this whole feature is easy to mistake for.
    setLED(true);
    delay(30);
    setLED(false);
    esp_light_sleep_start();
  }
}

// Called at the very top of setup(), before any radio is brought up: entering
// charge mode is then simply a matter of never starting them.
// Runs before Serial is up, so it reports the flag it saw through [out] rather
// than printing it; setup() logs it once the port is ready.
// Only a reset a person can cause counts toward the gesture. A crash, watchdog
// or brownout loop also restarts within the arm window, and must not park the
// monitor in charge mode — it would go silent instead of recovering. This is a
// deny-list on purpose: on the S3 the RESET button pulls CHIP_PU/EN, which
// reports as a power-on reset (ESP_RST_POWERON), not ESP_RST_EXT, so an
// allow-list of "external reset" would break the hand gesture.
static bool resetCountsForGesture(esp_reset_reason_t r) {
  switch (r) {
    case ESP_RST_SW:          // ESP.restart(): apply, watchdog reboot, factory reset
    case ESP_RST_PANIC:
    case ESP_RST_INT_WDT:
    case ESP_RST_TASK_WDT:
    case ESP_RST_WDT:
    case ESP_RST_BROWNOUT:
    case ESP_RST_DEEPSLEEP:
    case ESP_RST_PWR_GLITCH:
      return false;
    default:
      return true;
  }
}

static bool chargeModeRequested(uint8_t* seen) {
  const uint8_t armed = chargeArmRead();
  if (seen) *seen = armed;
  // Previous boot was cut short by a reset — but only a hand-made one counts.
  if (armed == 1 && resetCountsForGesture(esp_reset_reason())) return true;
  chargeArmWrite(1);
  chargeArmActive = true;
  return false;
}

// Two quick blinks meaning "first press counted — press RESET again now". The
// window before this point is dead time where a press cannot be seen, so
// rather than asking the user to guess an interval, the device says when it is
// listening. Cheap enough to run on every normal boot.
static void chargeArmBlink() {
  for (int i = 0; i < 2; i++) {
    setLED(true);  delay(60);
    setLED(false); delay(90);
  }
}

// Disarm once the device has clearly booted normally, so a reset minutes later
// starts a fresh gesture instead of completing a stale one.
static void chargeArmTick() {
  if (!chargeArmActive) return;
  if (millis() < CHARGE_ARM_MS) return;
  chargeArmActive = false;
  chargeArmWrite(0);
  Serial.println("[charge] settled — a single reset now boots normally");
}

void setup() {
  // First statement in the sketch, ahead of Serial: the gesture counter can
  // only be bumped once our code runs, and everything before this point is a
  // window in which a second RESET press goes unseen. About 0.7 s of IDF init
  // stays unavoidable — hence the acknowledgement blink below.
  pinMode(LED_PIN, OUTPUT);
  setLED(false);
  uint8_t armAtBoot = 0;
  const bool charge = chargeModeRequested(&armAtBoot);
  if (!charge) chargeArmBlink();

  Serial.begin(115200);
  delay(200);
  Serial.println("\n=== BabyLink XIAO ESP32-S3 ===");
  Serial.printf("[id] MAC=%s\n", macHex().c_str());
  Serial.printf("[charge] arm flag at boot = %u, reset reason = %d\n",
                armAtBoot, (int)esp_reset_reason());

  if (charge) {
    cameraSleep();       // the LDO heats up otherwise, even while charging
    enterChargeMode();   // never returns
  }

  // Camera to standby early — stops the LDO heating up while the rest
  // of boot runs. (LED pins are already set up above, for charge mode.)
  cameraSleep();

  pinMode(RESET_BUTTON_PIN, INPUT_PULLUP);

  deviceId = String("esp32_") + macHex();
  Serial.printf("[id] device_id=%s type=%s name='%s'\n",
                deviceId.c_str(), DEVICE_TYPE, configDeviceName.c_str());

  loadConfig();
  loadDeviceToken();
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

// Keep the BLE INFO characteristic's provOpen flag fresh (e.g. after the
// provisioning window expires) for any connected wizard, and re-publish the
// CONFIG value so the room ID is masked again once the window closes.
static void provGateTick() {
  static bool lastProvOpen = false;
  static unsigned long lastCheck = 0;
  unsigned long now = millis();
  if (now - lastCheck < 500) return;
  lastCheck = now;
  bool provOpen = provisioningAllowed();
  if (isBLEActive && provOpen != lastProvOpen) {
    lastProvOpen = provOpen;
    publishConfigToBle();
    publishInfoToBle();
    if (bleInfoChar) bleInfoChar->notify();
  }
}

void loop() {
  chargeArmTick();
  checkResetButton();
  provGateTick();
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
    startOffer();
  }

  processAudio();

  unsigned long now = millis();

  // WebRTC self-heal: if we've offered a few times and never reached CONNECTED,
  // esp_peer is wedged (the post-uptime malformed-offer bug). Re-init it in
  // place — the WSS-PCM audio keeps flowing, so the parent never alarms.
  if (webrtcPeer && !webrtcConnected && webrtcOfferCount >= 2 &&
      now - lastOfferMs > 8000 && now - lastRecoveryMs > 30000) {
    lastRecoveryMs = now;
    Serial.printf("[peer] %d offers, still not connected — recovering\n", webrtcOfferCount);
    restartWebRTC();
  }
#if WRTC_RECOVERY_SELFTEST
  // One forced recovery ~25s after boot to prove the close/reopen is crash-free.
  static bool selftestDone = false;
  if (!selftestDone && now > 25000) {
    selftestDone = true;
    Serial.println("[peer] SELFTEST: forcing a recovery cycle");
    restartWebRTC();
  }
#endif

  // Reconnect watchdog. esp_websocket auto-reconnects, but after a server
  // restart it can wedge and never recover on its own — the device then sits
  // "gone" until a power-cycle. If WiFi is up but we haven't been registered
  // for WS_WATCHDOG_MS, tear the client down and recreate it for a clean
  // reconnect. lastWsOkMs is seeded at boot so a device that never registers
  // (server down at startup) is also retried rather than stuck forever.
  // Token rejected: park the websocket client instead of letting it hammer the
  // server every 5 s, and retry later (the owner may have released the slot).
  if (tokenRejected && webSocket) {
    tokenRejected = false;
    esp_websocket_client_stop(webSocket);
    tokenBackoffUntil = now + TOKEN_BACKOFF_MS;
    if (tokenBackoffUntil == 0) tokenBackoffUntil = 1;
  }
  if (tokenBackoffUntil != 0 && (long)(now - tokenBackoffUntil) >= 0) {
    tokenBackoffUntil = 0;
    Serial.println("[auth] retrying registration");
    esp_websocket_client_start(webSocket);
  }

  if (isRegistered || tokenBackoffUntil != 0) lastWsOkMs = now;
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
    float vb = readBatteryVolts();
    Serial.printf("[status] uptime=%lus wifi=%s ws=%s heap=%u bat=%d%% v=%dmV\n",
                  now / 1000,
                  (WiFi.status() == WL_CONNECTED) ? "up" : "down",
                  isRegistered ? "registered" : (isConnected ? "open" : "down"),
                  (unsigned)ESP.getFreeHeap(),
                  (vb < 0.0f) ? -1 : socFromVoltage(vb),
                  (int)lroundf(vb * 1000.0f));
  }
}

extern "C" void app_main() {
  initArduino();
  setup();
  while (true) {
    loop();
  }
}
