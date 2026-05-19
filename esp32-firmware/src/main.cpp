/*
 * BabyLink ESP32 Baby Device
 *
 * Hardware Requirements:
 * - ESP32 DevKit (ESP32-WROOM-32 or similar)
 * - INMP441 I2S MEMS Microphone
 *
 * Wiring:
 * ESP32          INMP441
 * -----          -------
 * 3.3V    ----   VDD
 * GND     ----   GND
 * GPIO26  ----   SCK (Serial Clock)
 * GPIO25  ----   WS  (Word Select / LR)
 * GPIO18  ----   SD  (Serial Data)
 * GND     ----   L/R (connects to GND for left channel)
 *
 * Optional: LED on GPIO2 for status indication
 */

#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>
#include <Preferences.h>
#include <DNSServer.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include <driver/i2s.h>
#include <vector>
#include <algorithm>
#include <NimBLEDevice.h>

// =============================================================================
// CONFIGURATION
// =============================================================================
//
// Defaults are intentionally empty so a fresh device always enters the BLE
// + SoftAP provisioning portal. For local development you can drop an
// (untracked) "dev_defaults.h" next to this file with overrides like:
//
//   #define DEV_DEFAULT_WIFI_SSID     "MyWifi"
//   #define DEV_DEFAULT_WIFI_PASSWORD "mypassword"
//   #define DEV_DEFAULT_SERVER_HOST   "192.168.1.10"
//   #define DEV_DEFAULT_SERVER_PORT   3001
//   #define DEV_DEFAULT_ROOM_ID       "dddddddddddddddddddddddddddddddd"
//
#if __has_include("dev_defaults.h")
#include "dev_defaults.h"
#endif

#ifndef DEV_DEFAULT_WIFI_SSID
#define DEV_DEFAULT_WIFI_SSID ""
#endif
#ifndef DEV_DEFAULT_WIFI_PASSWORD
#define DEV_DEFAULT_WIFI_PASSWORD ""
#endif
#ifndef DEV_DEFAULT_SERVER_HOST
#define DEV_DEFAULT_SERVER_HOST ""
#endif
#ifndef DEV_DEFAULT_SERVER_PORT
#define DEV_DEFAULT_SERVER_PORT 3001
#endif
#ifndef DEV_DEFAULT_ROOM_ID
#define DEV_DEFAULT_ROOM_ID ""
#endif

const char* DEFAULT_WIFI_SSID = DEV_DEFAULT_WIFI_SSID;
const char* DEFAULT_WIFI_PASSWORD = DEV_DEFAULT_WIFI_PASSWORD;
const char* DEFAULT_SERVER_HOST = DEV_DEFAULT_SERVER_HOST;
const uint16_t DEFAULT_SERVER_PORT = DEV_DEFAULT_SERVER_PORT;
const char* DEFAULT_ROOM_ID = DEV_DEFAULT_ROOM_ID;
const char* DEFAULT_DEVICE_NAME = "BabyLink ESP32";

// Configuration Portal Settings
const char* AP_SSID = "BabyLink-Setup";      // Access Point name for configuration
const char* AP_PASSWORD = "";                // No password for easy setup

// Runtime configuration (loaded from preferences or defaults).
// Multi-profile model: device remembers up to MAX_WIFI_PROFILES WiFi
// credentials and up to MAX_SERVER_PROFILES server/room combos. On boot
// it scans and connects to whichever known SSID has the strongest signal,
// then uses the active server profile for the WebSocket connection.
#define MAX_WIFI_PROFILES   6
#define MAX_SERVER_PROFILES 4
#define CFG_JSON_CAPACITY   2048

struct WifiProfile {
  String ssid;
  String password;
};

struct ServerProfile {
  String label;
  String host;
  uint16_t port;
  String roomId;
};

std::vector<WifiProfile> wifiProfiles;
std::vector<ServerProfile> serverProfiles;
int activeServer = 0;
String configDeviceName;

// Per-boot — populated by setupWiFi() once it picks a profile so the rest
// of the code can refer to "the WiFi/server we're currently using."
String activeWifiSsid;
String configServerHost;
uint16_t configServerPort = 3001;
String configRoomId;

// Forward declarations — the BLE callbacks defined further down need
// these config helpers, which themselves depend on the profile globals
// above and on ArduinoJson, so they're defined later in the file.
String serializeConfig();
bool deserializeConfig(const String& json);
void saveConfig();

// Objects for configuration portal
Preferences preferences;
WebServer webServer(80);
DNSServer dnsServer;
bool isConfigMode = false;
const byte DNS_PORT = 53;

// I2S Microphone Pins (Updated to match your hardware)
#define I2S_WS 25        // Word Select (LRCLK) - GPIO25
#define I2S_SD 18        // Serial Data (SDIN) - GPIO18
#define I2S_SCK 26       // Serial Clock (BCLK) - GPIO26
#define I2S_PORT I2S_NUM_0

// Audio Configuration
#define SAMPLE_RATE 16000       // Sample rate in Hz
#define BUFFER_SIZE 1024        // Audio buffer size (samples)
#define BITS_PER_SAMPLE 16      // Bits per sample

// Status LED Pin
#define LED_PIN 2

// INMP441 L/R Pin (connected to GPIO 5)
#define I2S_LR_PIN 5

// BOOT button (GPIO0) — hold 5s for factory reset
#define RESET_BUTTON_PIN 0
#define RESET_HOLD_MS 5000

// =============================================================================
// GLOBAL VARIABLES
// =============================================================================

WebSocketsClient webSocket;
bool isConnected = false;
bool isRegistered = false;

// Audio buffer
int16_t audioBuffer[BUFFER_SIZE];

// Statistics
unsigned long audioPacketsSent = 0;
unsigned long lastStatsReport = 0;
unsigned long connectionTime = 0;

// =============================================================================
// BLE PROVISIONING
// =============================================================================

// BLE Service and Characteristic UUIDs.
//
// Three characteristics replace the previous six per-field writes:
//
//   config (R/W): full cfg_v2 JSON blob. Read returns current config so
//                 the PWA/CLI can pre-fill its UI. Write replaces all
//                 profiles in memory; nothing is persisted until "apply"
//                 lands on the command characteristic.
//   scan   (R/W): write "scan" to trigger a WiFi.scanNetworks() while in
//                 config mode; subsequent reads return a JSON array of
//                 nearby APs with SSID + RSSI. Lets the configurator
//                 populate a "pick from nearby" dropdown.
//   command (W):  "apply" persists the staged config and reboots.
//
// Bumped service UUID to 0002 to signal the breaking GATT change so old
// PWA clients fail-fast on missing service instead of silently writing
// to the wrong endpoint.
#define BLE_SERVICE_UUID        "bab71111-0002-1000-8000-00805f9b34fb"
#define BLE_CHAR_CONFIG         "bab71111-0002-1001-8000-00805f9b34fb"
#define BLE_CHAR_SCAN           "bab71111-0002-1002-8000-00805f9b34fb"
#define BLE_CHAR_COMMAND        "bab71111-0002-1003-8000-00805f9b34fb"

bool isBLEActive = false;
NimBLECharacteristic* bleConfigChar = nullptr;
NimBLECharacteristic* bleScanChar = nullptr;

// Stash the most recent scan result so a write("scan") + subsequent read
// flow returns the data without forcing a new active scan each read.
String lastScanJson = "[]";

// NimBLE-Arduino's setValue(const char*) overload stores the pointer rather
// than the string contents (sizeof a pointer = 4 bytes ends up on the wire).
// Always pass (uint8_t*, len) explicitly so the buffer is copied.
void publishConfigToBle() {
  if (!bleConfigChar) return;
  String json = serializeConfig();
  bleConfigChar->setValue((const uint8_t*)json.c_str(), json.length());
}

void publishScanToBle() {
  if (!bleScanChar) return;
  bleScanChar->setValue((const uint8_t*)lastScanJson.c_str(), lastScanJson.length());
}

// Async scan flag. WiFi.scanNetworks(true /*async*/) returns immediately,
// runs the scan on a background task. pollScanComplete() (called from
// loop() while in config mode) picks up the results when they're ready
// and publishes them on the BLE characteristic.
volatile bool scanInProgress = false;

void publishScanResults(int n) {
  DynamicJsonDocument doc(2048);
  JsonArray arr = doc.to<JsonArray>();
  for (int i = 0; i < n && i < 24; i++) {
    JsonObject o = arr.createNestedObject();
    o["ssid"] = WiFi.SSID(i);
    o["rssi"] = WiFi.RSSI(i);
    o["secure"] = (WiFi.encryptionType(i) != WIFI_AUTH_OPEN);
  }
  lastScanJson = "";
  serializeJson(doc, lastScanJson);
  publishScanToBle();
}

void pollScanComplete() {
  if (!scanInProgress) return;
  int n = WiFi.scanComplete();
  if (n == WIFI_SCAN_RUNNING) return;
  scanInProgress = false;
  if (n < 0) {
    Serial.printf("[BLE] Async scan failed (%d)\n", n);
    lastScanJson = "[]";
    publishScanToBle();
    return;
  }
  publishScanResults(n);
  WiFi.scanDelete();
  Serial.printf("[BLE] Async scan complete: %d networks (payload %u bytes)\n",
                n, (unsigned)lastScanJson.length());
}

void doWifiScanForBle() {
  if (scanInProgress) {
    Serial.println("[BLE] Scan already in progress");
    return;
  }
  Serial.println("[BLE] Starting async WiFi scan");
  // Async — returns immediately so the NimBLE task keeps the connection
  // alive. Results land via pollScanComplete() in loop().
  WiFi.scanNetworks(true, true);
  scanInProgress = true;
}

class BLEProvisionCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* pCharacteristic) {
    String uuid = String(pCharacteristic->getUUID().toString().c_str());
    // Read the raw value (std::string) so we keep any embedded bytes
    // intact even if the payload contained an unexpected NUL.
    std::string raw = pCharacteristic->getValue();
    String value;
    value.reserve(raw.length());
    for (size_t i = 0; i < raw.length(); i++) value += (char)raw[i];

    Serial.printf("[BLE] onWrite uuid=%s raw_len=%u\n",
                  uuid.c_str(), (unsigned)raw.length());

    if (uuid.indexOf("1001") > 0) {
      Serial.printf("[BLE] Config write (%u bytes)\n", (unsigned)value.length());
      if (deserializeConfig(value)) {
        publishConfigToBle();
        Serial.println("[BLE] Config staged — write 'apply' to command to persist");
      }
    } else if (uuid.indexOf("1002") > 0) {
      if (value == "scan") doWifiScanForBle();
    } else if (uuid.indexOf("1003") > 0) {
      if (value == "apply") {
        Serial.println("[BLE] Apply — persisting staged config + restart");
        saveConfig();
        delay(500);
        ESP.restart();
      } else {
        Serial.printf("[BLE] Unknown command '%s'\n", value.c_str());
      }
    }
  }
};

void startBLE() {
  // Generate unique name from MAC address
  uint8_t mac[6];
  esp_read_mac(mac, ESP_MAC_WIFI_STA);
  char bleName[20];
  snprintf(bleName, sizeof(bleName), "BabyLink-%02X%02X", mac[4], mac[5]);

  Serial.printf("[BLE] Starting BLE as '%s'\n", bleName);

  NimBLEDevice::init(bleName);
  NimBLEDevice::setPower(ESP_PWR_LVL_P9); // Max range
  // Request 517-byte MTU (BLE 5.0 max) so the multi-profile config JSON
  // fits in a single ATT_WRITE_REQ rather than being fragmented through
  // long-write — fragmented writes are slow and (on NimBLE-Arduino 1.4.x)
  // have buffer-size pitfalls.
  NimBLEDevice::setMTU(517);

  NimBLEServer* pServer = NimBLEDevice::createServer();
  NimBLEService* pService = pServer->createService(BLE_SERVICE_UUID);

  BLEProvisionCallbacks* callbacks = new BLEProvisionCallbacks();

  auto createChar = [&](const char* uuid, uint32_t props) {
    NimBLECharacteristic* c = pService->createCharacteristic(uuid, props);
    c->setCallbacks(callbacks);
    return c;
  };

  bleConfigChar = createChar(BLE_CHAR_CONFIG,
                             NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::WRITE);
  bleScanChar   = createChar(BLE_CHAR_SCAN,
                             NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::WRITE);
                  createChar(BLE_CHAR_COMMAND, NIMBLE_PROPERTY::WRITE);

  // Pre-populate the readable characteristics so clients can pull the
  // current state without writing first.
  publishConfigToBle();
  publishScanToBle();

  pService->start();

  // Start advertising
  NimBLEAdvertising* pAdvertising = NimBLEDevice::getAdvertising();
  pAdvertising->addServiceUUID(BLE_SERVICE_UUID);
  pAdvertising->setScanResponse(true);
  pAdvertising->start();

  isBLEActive = true;
  Serial.printf("[BLE] Advertising started. Free heap: %d bytes\n", ESP.getFreeHeap());
}

// =============================================================================
// CONFIGURATION MANAGEMENT
// =============================================================================

/**
 * Serialize the in-memory profile lists into the cfg_v2 JSON blob.
 * Schema:
 *   {
 *     "wifi":    [ { "ssid": "...", "password": "..." }, ... ],
 *     "servers": [ { "label": "Home", "host": "...", "port": 3001, "roomId": "..." }, ... ],
 *     "activeServer": 0,
 *     "deviceName": "..."
 *   }
 */
String serializeConfig() {
  DynamicJsonDocument doc(CFG_JSON_CAPACITY);
  JsonArray wifi = doc.createNestedArray("wifi");
  for (auto& p : wifiProfiles) {
    JsonObject o = wifi.createNestedObject();
    o["ssid"] = p.ssid;
    o["password"] = p.password;
  }
  JsonArray servers = doc.createNestedArray("servers");
  for (auto& p : serverProfiles) {
    JsonObject o = servers.createNestedObject();
    o["label"] = p.label;
    o["host"] = p.host;
    o["port"] = p.port;
    o["roomId"] = p.roomId;
  }
  doc["activeServer"] = activeServer;
  doc["deviceName"] = configDeviceName;
  String out;
  serializeJson(doc, out);
  return out;
}

/**
 * Replace the in-memory profile lists from a cfg_v2 JSON blob. Returns
 * true on successful parse. Rejects but doesn't crash on malformed input.
 */
bool deserializeConfig(const String& json) {
  DynamicJsonDocument doc(CFG_JSON_CAPACITY);
  DeserializationError err = deserializeJson(doc, json);
  if (err) {
    Serial.printf("⚠️  cfg_v2 JSON parse failed: %s\n", err.c_str());
    return false;
  }
  wifiProfiles.clear();
  serverProfiles.clear();
  for (JsonObject p : doc["wifi"].as<JsonArray>()) {
    if (wifiProfiles.size() >= MAX_WIFI_PROFILES) break;
    WifiProfile w;
    w.ssid = p["ssid"].as<String>();
    w.password = p["password"].as<String>();
    if (w.ssid.length() > 0) wifiProfiles.push_back(w);
  }
  for (JsonObject p : doc["servers"].as<JsonArray>()) {
    if (serverProfiles.size() >= MAX_SERVER_PROFILES) break;
    ServerProfile s;
    s.label = p["label"].as<String>();
    s.host = p["host"].as<String>();
    s.port = p["port"].as<uint16_t>();
    s.roomId = p["roomId"].as<String>();
    if (s.host.length() > 0 && s.roomId.length() > 0) serverProfiles.push_back(s);
  }
  activeServer = doc["activeServer"] | 0;
  if (activeServer < 0 || activeServer >= (int)serverProfiles.size()) activeServer = 0;
  String name = doc["deviceName"] | "";
  if (name.length() > 0) configDeviceName = name;
  return true;
}

/**
 * Write the current profile lists to NVS under "cfg_v2".
 */
void saveConfig() {
  String blob = serializeConfig();
  preferences.begin("babylink", false);
  preferences.putString("cfg_v2", blob);
  preferences.end();
  Serial.printf("💾 Config saved (%u bytes, %u WiFi / %u servers)\n",
                (unsigned)blob.length(),
                (unsigned)wifiProfiles.size(),
                (unsigned)serverProfiles.size());
}

/**
 * Try to populate the profile lists from the legacy single-profile NVS
 * keys written by firmware versions <= 2026-05-19. Returns true if a
 * legacy entry was found and migrated.
 */
bool tryLegacyMigration() {
  preferences.begin("babylink", true);
  String legacySsid = preferences.getString("wifi_ssid", "");
  if (legacySsid.length() == 0) {
    preferences.end();
    return false;
  }
  WifiProfile w;
  w.ssid = legacySsid;
  w.password = preferences.getString("wifi_pass", "");
  wifiProfiles.push_back(w);

  String host = preferences.getString("server_host", "");
  if (host.length() > 0) {
    ServerProfile s;
    s.label = "default";
    s.host = host;
    s.port = preferences.getUInt("server_port", 3001);
    s.roomId = preferences.getString("room_id", "");
    serverProfiles.push_back(s);
  }
  String name = preferences.getString("device_name", "");
  if (name.length() > 0) configDeviceName = name;
  preferences.end();
  Serial.println("📦 Migrated legacy single-profile config to cfg_v2");
  saveConfig();
  return true;
}

/**
 * Seed the profile lists from dev_defaults.h if NVS is empty and the
 * developer dropped a local override file with credentials. Production
 * builds without dev_defaults.h end up here with no profiles, which
 * sends the device straight into the provisioning portal.
 */
void seedFromDevDefaults() {
  if (strlen(DEFAULT_WIFI_SSID) > 0) {
    WifiProfile w;
    w.ssid = DEFAULT_WIFI_SSID;
    w.password = DEFAULT_WIFI_PASSWORD;
    wifiProfiles.push_back(w);
  }
  if (strlen(DEFAULT_SERVER_HOST) > 0 && strlen(DEFAULT_ROOM_ID) > 0) {
    ServerProfile s;
    s.label = "default";
    s.host = DEFAULT_SERVER_HOST;
    s.port = DEFAULT_SERVER_PORT;
    s.roomId = DEFAULT_ROOM_ID;
    serverProfiles.push_back(s);
  }
}

void loadConfiguration() {
  configDeviceName = "BabyLink ESP32";

  preferences.begin("babylink", true);
  String blob = preferences.getString("cfg_v2", "");
  preferences.end();

  if (blob.length() > 0 && deserializeConfig(blob)) {
    Serial.printf("📋 Loaded cfg_v2: %u WiFi, %u servers (active=%d), device='%s'\n",
                  (unsigned)wifiProfiles.size(), (unsigned)serverProfiles.size(),
                  activeServer, configDeviceName.c_str());
    return;
  }

  // No cfg_v2 yet — try legacy migration, then dev defaults
  if (tryLegacyMigration()) return;
  seedFromDevDefaults();
  Serial.printf("📋 Seeded from defaults: %u WiFi, %u servers\n",
                (unsigned)wifiProfiles.size(), (unsigned)serverProfiles.size());
}

/**
 * Clear all stored configuration. Wipes both cfg_v2 and the legacy keys
 * so devices migrated from older firmware don't fall back to stale
 * credentials after a factory reset.
 */
void clearConfiguration() {
  preferences.begin("babylink", false);
  preferences.clear();
  preferences.end();
  wifiProfiles.clear();
  serverProfiles.clear();
  activeServer = 0;
  Serial.println("🗑️  Configuration cleared");
}

/**
 * Clear all stored credentials and reboot into the provisioning portal.
 * Used by both the server-initiated factory-reset command and the
 * 5-second BOOT-button long-press.
 */
void performFactoryReset() {
  Serial.println("🔁 Performing factory reset — clearing NVS and restarting");
  // Fast blink to acknowledge
  for (int i = 0; i < 10; i++) {
    digitalWrite(LED_PIN, HIGH);
    delay(50);
    digitalWrite(LED_PIN, LOW);
    delay(50);
  }
  clearConfiguration();
  delay(500);
  ESP.restart();
}

// =============================================================================
// CONFIGURATION WEB PORTAL
// =============================================================================

// Captive-portal HTML. Embedded directly so the device can serve it
// without filesystem dependencies. The JavaScript drives a multi-profile
// editor: WiFi profile rows, server profile rows, "scan nearby" dropdown,
// and a single "Save & Connect" submit that POSTs the cfg_v2 JSON blob.
const char CONFIG_HTML[] PROGMEM = R"rawliteral(
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>BabyLink Setup</title>
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
</style>
</head>
<body>
<div class="container">
<h1>🍼 BabyLink</h1>
<div class="subtitle">ESP32 multi-profile setup</div>
<div class="info">Save the WiFi networks this device will roam between (e.g. Home, Grandma). On boot it picks whichever known network has the strongest signal. The active server &amp; room is the BabyLink instance this device will register with.</div>

<h2>WiFi networks</h2>
<button id="scanBtn" class="btn scan" type="button">📡 Scan nearby networks</button>
<div id="scanList"></div>
<div id="wifiRows"></div>
<button id="addWifi" class="btn secondary" type="button">+ Add WiFi manually</button>

<h2>Server profiles</h2>
<div id="serverRows"></div>
<button id="addServer" class="btn secondary" type="button">+ Add server</button>

<h2>Device</h2>
<input id="devName" placeholder="Device name (e.g. Nursery)">

<button id="saveBtn" class="btn" type="button">💾 Save &amp; Connect</button>
<div id="msg"></div>
</div>

<script>
const $=id=>document.getElementById(id);
let cfg={wifi:[],servers:[],activeServer:0,deviceName:""};
const MAX_WIFI=6,MAX_SRV=4;

function render(){
  const w=$('wifiRows');w.innerHTML='';
  if(!cfg.wifi.length)w.innerHTML='<div class="empty">No WiFi networks saved yet — scan or add one manually.</div>';
  cfg.wifi.forEach((p,i)=>{
    const r=document.createElement('div');r.className='row';
    r.innerHTML=`<div class="col">
      <label>SSID</label><input data-i="${i}" data-k="ssid" value="${p.ssid||''}">
      <label>Password</label><input data-i="${i}" data-k="password" type="password" value="${p.password||''}">
    </div><button class="rm" data-rm-w="${i}" type="button">×</button>`;
    w.appendChild(r);
  });
  const s=$('serverRows');s.innerHTML='';
  if(!cfg.servers.length)s.innerHTML='<div class="empty">No servers saved yet.</div>';
  cfg.servers.forEach((p,i)=>{
    const r=document.createElement('div');r.className='row';
    r.innerHTML=`<div class="col">
      <label>Label</label><input data-i="${i}" data-k="label" value="${p.label||''}" placeholder="e.g. Home">
      <label>Host</label><input data-i="${i}" data-k="host" value="${p.host||''}" placeholder="192.168.1.10 or babylink.example">
      <label>Port</label><input data-i="${i}" data-k="port" type="number" value="${p.port||3001}">
      <label>Room ID</label><input data-i="${i}" data-k="roomId" value="${p.roomId||''}">
      <div class="active-pick"><input type="radio" name="active" ${i==cfg.activeServer?'checked':''} data-a="${i}"> Active for this device</div>
    </div><button class="rm" data-rm-s="${i}" type="button">×</button>`;
    s.appendChild(r);
  });
  $('devName').value=cfg.deviceName||'';
}

document.addEventListener('input',e=>{
  const t=e.target;
  if(t.dataset.k){
    const i=+t.dataset.i,k=t.dataset.k;
    const list=t.closest('#wifiRows')?cfg.wifi:cfg.servers;
    list[i][k]=k=='port'?+t.value:t.value;
  } else if(t.id=='devName'){cfg.deviceName=t.value;}
});
document.addEventListener('change',e=>{
  if(e.target.dataset.a!==undefined){cfg.activeServer=+e.target.dataset.a;}
});
document.addEventListener('click',e=>{
  const t=e.target;
  if(t.dataset.rmW!==undefined){cfg.wifi.splice(+t.dataset.rmW,1);render();}
  else if(t.dataset.rmS!==undefined){
    cfg.servers.splice(+t.dataset.rmS,1);
    if(cfg.activeServer>=cfg.servers.length)cfg.activeServer=Math.max(0,cfg.servers.length-1);
    render();
  } else if(t.dataset.pick){
    cfg.wifi.push({ssid:t.dataset.pick,password:""});render();
    $('scanList').innerHTML='';
  }
});
$('addWifi').onclick=()=>{if(cfg.wifi.length<MAX_WIFI){cfg.wifi.push({ssid:"",password:""});render();}};
$('addServer').onclick=()=>{if(cfg.servers.length<MAX_SRV){cfg.servers.push({label:"",host:"",port:3001,roomId:""});render();}};

$('scanBtn').onclick=async()=>{
  $('scanBtn').disabled=true;$('scanBtn').textContent='Scanning...';
  try{
    const r=await fetch('/scan');const list=await r.json();
    const sl=$('scanList');
    sl.innerHTML=list.length?'<div style="font-size:12px;color:#555;margin:4px 0">Tap a network to add it:</div>':'<div class="msg err">No networks found.</div>';
    list.sort((a,b)=>b.rssi-a.rssi).forEach(n=>{
      const b=document.createElement('button');b.type='button';
      b.className='btn secondary';b.style.textAlign='left';
      b.dataset.pick=n.ssid;
      b.textContent=`${n.ssid} (${n.rssi} dBm${n.secure?'':' · open'})`;
      sl.appendChild(b);
    });
  }catch(e){$('scanList').innerHTML='<div class="msg err">Scan failed: '+e.message+'</div>';}
  $('scanBtn').disabled=false;$('scanBtn').textContent='📡 Scan nearby networks';
};

$('saveBtn').onclick=async()=>{
  if(!cfg.wifi.length||!cfg.wifi[0].ssid){$('msg').innerHTML='<div class="msg err">Add at least one WiFi network.</div>';return;}
  if(!cfg.servers.length||!cfg.servers[0].host||!cfg.servers[0].roomId){$('msg').innerHTML='<div class="msg err">Add at least one server with host + room.</div>';return;}
  $('saveBtn').disabled=true;
  try{
    const r=await fetch('/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(cfg)});
    const j=await r.json();
    if(r.ok){$('msg').innerHTML='<div class="msg ok">✅ Saved! Device is rebooting…</div>';}
    else{$('msg').innerHTML='<div class="msg err">'+(j.error||'Save failed')+'</div>';$('saveBtn').disabled=false;}
  }catch(e){$('msg').innerHTML='<div class="msg err">'+e.message+'</div>';$('saveBtn').disabled=false;}
};

(async()=>{
  try{const r=await fetch('/config');cfg=await r.json();if(!cfg.wifi)cfg.wifi=[];if(!cfg.servers)cfg.servers=[];}catch(e){}
  render();
})();
</script>
</body>
</html>
)rawliteral";

void handleRoot() {
  webServer.send_P(200, "text/html", CONFIG_HTML);
}

void handleGetConfig() {
  webServer.send(200, "application/json", serializeConfig());
}

void handleScan() {
  // Captive portal scan: synchronous active scan + return JSON list.
  // No active connection at this point (we're in config mode) so this
  // can safely block briefly.
  int n = WiFi.scanNetworks(false, true);
  DynamicJsonDocument doc(2048);
  JsonArray arr = doc.to<JsonArray>();
  for (int i = 0; i < n && i < 24; i++) {
    JsonObject o = arr.createNestedObject();
    o["ssid"] = WiFi.SSID(i);
    o["rssi"] = WiFi.RSSI(i);
    o["secure"] = (WiFi.encryptionType(i) != WIFI_AUTH_OPEN);
  }
  String out;
  serializeJson(doc, out);
  webServer.send(200, "application/json", out);
}

void handleSave() {
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
    webServer.send(400, "application/json", "{\"error\":\"need at least one WiFi profile and one server profile\"}");
    return;
  }
  saveConfig();
  webServer.send(200, "application/json", "{\"ok\":true}");
  delay(800);
  ESP.restart();
}

/**
 * Start configuration web server
 */
void startConfigPortal() {
  Serial.println("🌐 Starting configuration portal...");

  // Start Access Point in combined AP+STA mode so we can also run WiFi
  // scans during provisioning (configurators want to pick from a list of
  // nearby networks). Pure WIFI_AP makes scanNetworks a no-op.
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP(AP_SSID, AP_PASSWORD);

  IPAddress IP = WiFi.softAPIP();
  Serial.printf("   AP IP: %s\n", IP.toString().c_str());
  Serial.printf("   AP SSID: %s\n", AP_SSID);
  Serial.println("   Connect to this network and visit http://192.168.4.1");

  // Setup DNS server for captive portal
  dnsServer.start(DNS_PORT, "*", IP);

  // Setup web server routes
  webServer.on("/", handleRoot);
  webServer.on("/config", HTTP_GET, handleGetConfig);
  webServer.on("/scan", HTTP_GET, handleScan);
  webServer.on("/save", HTTP_POST, handleSave);
  webServer.onNotFound(handleRoot);  // Redirect all unknown requests to config page

  webServer.begin();
  isConfigMode = true;

  // Also start BLE for phone provisioning (Android Web Bluetooth)
  startBLE();

  // Kick off an initial async scan so configurators see networks
  // immediately on their first read.
  doWifiScanForBle();

  Serial.println("✅ Configuration portal ready (WiFi AP + BLE)!");
}

// =============================================================================
// I2S MICROPHONE SETUP
// =============================================================================

void setupI2S() {
  Serial.println("🎤 Initializing I2S microphone...");

  // Control L/R pin via GPIO 5 (LOW = left channel, HIGH = right channel)
  pinMode(I2S_LR_PIN, OUTPUT);
  digitalWrite(I2S_LR_PIN, LOW);  // Set to LEFT channel
  Serial.println("   L/R pin (GPIO 5) set to LEFT channel (LOW)");

  // I2S configuration (matching working MicroPython config)
  i2s_config_t i2s_config = {
    .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX),
    .sample_rate = SAMPLE_RATE,
    .bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT,  // 16-bit like MicroPython
    .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT,   // MONO left channel
    .communication_format = I2S_COMM_FORMAT_STAND_I2S, // Standard I2S format
    .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
    .dma_buf_count = 8,
    .dma_buf_len = BUFFER_SIZE,
    .use_apll = false,
    .tx_desc_auto_clear = false,
    .fixed_mclk = 0
  };

  // I2S pin configuration
  i2s_pin_config_t pin_config = {
    .bck_io_num = I2S_SCK,
    .ws_io_num = I2S_WS,
    .data_out_num = I2S_PIN_NO_CHANGE,
    .data_in_num = I2S_SD
  };

  // Install and start I2S driver
  esp_err_t err = i2s_driver_install(I2S_PORT, &i2s_config, 0, NULL);
  if (err != ESP_OK) {
    Serial.printf("❌ Failed to install I2S driver: %d\n", err);
    return;
  }

  err = i2s_set_pin(I2S_PORT, &pin_config);
  if (err != ESP_OK) {
    Serial.printf("❌ Failed to set I2S pins: %d\n", err);
    return;
  }

  // Set sample rate
  i2s_set_clk(I2S_PORT, SAMPLE_RATE, I2S_BITS_PER_SAMPLE_16BIT, I2S_CHANNEL_MONO);

  Serial.println("✅ I2S microphone initialized");
  Serial.printf("   Sample rate: %d Hz\n", SAMPLE_RATE);
  Serial.printf("   Bits per sample: %d\n", BITS_PER_SAMPLE);
  Serial.printf("   Buffer size: %d samples\n", BUFFER_SIZE);
}

// =============================================================================
// WIFI SETUP
// =============================================================================

/**
 * Connect to the strongest available saved WiFi network.
 *
 * Scans nearby APs, intersects with the saved profile list by SSID, sorts
 * matches by RSSI (descending), then tries each in turn until one
 * connects. Falls back to the provisioning portal if no saved network is
 * in range, or if every match fails authentication.
 *
 * Once connected, also picks the active server profile and copies its
 * host/port/room into the legacy config* globals so the rest of the code
 * paths (WebSocket setup, registration, factory-reset handler) don't
 * need to know about the multi-profile model.
 */
void setupWiFi() {
  if (wifiProfiles.empty() || serverProfiles.empty()) {
    Serial.println("ℹ️  No saved profiles — entering provisioning portal");
    startConfigPortal();
    return;
  }

  // Pin down the active server up front so WebSocket setup has its values
  // available regardless of which WiFi we end up on.
  if (activeServer < 0 || activeServer >= (int)serverProfiles.size()) activeServer = 0;
  const ServerProfile& srv = serverProfiles[activeServer];
  configServerHost = srv.host;
  configServerPort = srv.port;
  configRoomId = srv.roomId;
  Serial.printf("🎯 Active server: [%s] %s:%u room=%s\n",
                srv.label.c_str(), srv.host.c_str(), srv.port, srv.roomId.c_str());

  WiFi.mode(WIFI_STA);
  Serial.printf("📡 Scanning for known WiFi networks (%u saved)...\n",
                (unsigned)wifiProfiles.size());
  int n = WiFi.scanNetworks(false /*async*/, true /*show hidden*/);
  if (n <= 0) {
    Serial.println("⚠️  No networks visible at all");
    startConfigPortal();
    return;
  }

  // Build (profileIndex, rssi) pairs for every saved SSID we can see.
  // A given saved profile can appear multiple times if its SSID is
  // broadcast by more than one AP; pick the strongest in that case.
  std::vector<std::pair<int, int>> matches;
  for (int i = 0; i < n; i++) {
    String foundSsid = WiFi.SSID(i);
    int rssi = WiFi.RSSI(i);
    for (size_t j = 0; j < wifiProfiles.size(); j++) {
      if (foundSsid == wifiProfiles[j].ssid) {
        matches.push_back(std::make_pair((int)j, rssi));
      }
    }
  }

  if (matches.empty()) {
    Serial.println("⚠️  None of the saved networks are in range");
    Serial.println("    Nearby networks:");
    for (int i = 0; i < n && i < 10; i++) {
      Serial.printf("      %s (%d dBm)\n", WiFi.SSID(i).c_str(), WiFi.RSSI(i));
    }
    startConfigPortal();
    return;
  }

  // Strongest signal first
  std::sort(matches.begin(), matches.end(),
            [](const std::pair<int,int>& a, const std::pair<int,int>& b) {
              return a.second > b.second;
            });

  // De-duplicate so we only try each saved profile once (highest RSSI wins)
  std::vector<int> tried;
  for (auto& m : matches) {
    int profileIdx = m.first;
    if (std::find(tried.begin(), tried.end(), profileIdx) != tried.end()) continue;
    tried.push_back(profileIdx);

    const WifiProfile& p = wifiProfiles[profileIdx];
    Serial.printf("📡 Connecting to '%s' (RSSI %d dBm)\n", p.ssid.c_str(), m.second);
    WiFi.begin(p.ssid.c_str(), p.password.c_str());

    int attempts = 0;
    while (WiFi.status() != WL_CONNECTED && attempts < 20) {
      delay(500);
      Serial.print(".");
      attempts++;
    }

    if (WiFi.status() == WL_CONNECTED) {
      activeWifiSsid = p.ssid;
      Serial.printf("\n✅ Connected to '%s'\n", p.ssid.c_str());
      Serial.printf("   IP: %s\n", WiFi.localIP().toString().c_str());
      Serial.printf("   Signal: %d dBm\n", WiFi.RSSI());
      return;
    }
    Serial.println("\n⚠️  Authentication failed, trying next match");
    WiFi.disconnect();
  }

  Serial.println("❌ All saved networks failed");
  Serial.println("⚠️  Starting configuration portal...");
  startConfigPortal();
}

// =============================================================================
// WEBSOCKET EVENT HANDLER
// =============================================================================

void webSocketEvent(WStype_t type, uint8_t * payload, size_t length) {
  switch(type) {
    case WStype_DISCONNECTED:
      Serial.println("❌ WebSocket Disconnected");
      isConnected = false;
      isRegistered = false;
      digitalWrite(LED_PIN, LOW);
      break;

    case WStype_CONNECTED:
      {
        Serial.println("✅ WebSocket Connected");
        isConnected = true;
        connectionTime = millis();

        // Send registration message
        // Hardware MAC — stable across reboots, used as the server-side
        // device ID so renames + reconnects don't create ghost entries.
        uint8_t mac[6];
        esp_read_mac(mac, ESP_MAC_WIFI_STA);
        char macHex[13];
        snprintf(macHex, sizeof(macHex), "%02x%02x%02x%02x%02x%02x",
                 mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);

        StaticJsonDocument<256> doc;
        doc["type"] = "register";
        doc["roomId"] = configRoomId;
        doc["name"] = configDeviceName;
        doc["mac"] = macHex;
        doc["sampleRate"] = SAMPLE_RATE;
        doc["channels"] = 1;

        String json;
        serializeJson(doc, json);
        webSocket.sendTXT(json);

        Serial.println("📤 Sent registration request");
        Serial.printf("   Room ID: %s\n", configRoomId.c_str());
        Serial.printf("   Device Name: %s\n", configDeviceName.c_str());
      }
      break;

    case WStype_TEXT:
      {
        // Parse JSON response
        StaticJsonDocument<256> doc;
        DeserializationError error = deserializeJson(doc, payload, length);

        if (!error) {
          const char* type = doc["type"];

          if (strcmp(type, "registered") == 0) {
            isRegistered = true;
            const char* id = doc["id"];
            Serial.println("✅ Successfully registered with server");
            Serial.printf("   Device ID: %s\n", id);
            digitalWrite(LED_PIN, HIGH); // Turn on LED when registered
          } else if (strcmp(type, "pong") == 0) {
            // Heartbeat response
            Serial.println("💓 Heartbeat acknowledged");
          } else if (strcmp(type, "error") == 0) {
            const char* message = doc["message"];
            Serial.printf("❌ Server error: %s\n", message);
          } else if (strcmp(type, "factory-reset") == 0) {
            Serial.println("🧹 Factory reset requested by server");
            performFactoryReset();
          }
        }
      }
      break;

    case WStype_BIN:
      Serial.printf("📦 Received binary data: %u bytes\n", length);
      break;

    case WStype_ERROR:
      Serial.printf("❌ WebSocket error\n");
      break;

    case WStype_PING:
      Serial.println("🏓 Ping received");
      break;

    case WStype_PONG:
      Serial.println("🏓 Pong received");
      break;
  }
}

// =============================================================================
// AUDIO PROCESSING
// =============================================================================

/**
 * Calculate RMS volume from audio buffer
 */
float calculateVolume(int16_t* buffer, int size) {
  long sum = 0;
  for (int i = 0; i < size; i++) {
    sum += abs(buffer[i]);
  }
  return (float)sum / size;
}

/**
 * Read audio from I2S microphone and send via WebSocket
 */
void processAudio() {
  if (!isConnected || !isRegistered) {
    return;
  }

  // Read audio from I2S (16-bit samples, matching MicroPython)
  size_t bytesRead = 0;
  esp_err_t result = i2s_read(
    I2S_PORT,
    audioBuffer,
    BUFFER_SIZE * sizeof(int16_t),
    &bytesRead,
    portMAX_DELAY
  );

  if (result == ESP_OK && bytesRead > 0) {
    int sampleCount = bytesRead / sizeof(int16_t);

    // Apply software amplification (50x gain)
    // INMP441 has very low output levels, need significant boost
    const int GAIN = 50;
    for (int i = 0; i < sampleCount; i++) {
      int32_t amplified = (int32_t)audioBuffer[i] * GAIN;
      // Clamp to prevent overflow
      if (amplified > 32767) amplified = 32767;
      if (amplified < -32768) amplified = -32768;
      audioBuffer[i] = (int16_t)amplified;
    }

    // Calculate audio level (after amplification)
    int32_t sum = 0;
    for (int i = 0; i < sampleCount; i++) {
      sum += abs(audioBuffer[i]);
    }
    int avgLevel = sum / sampleCount;

    // Send 16-bit audio data via WebSocket (binary)
    webSocket.sendBIN((uint8_t*)audioBuffer, sampleCount * sizeof(int16_t));
    audioPacketsSent++;

    // Debug: Print audio level every 50 packets
    if (audioPacketsSent % 50 == 0) {
      Serial.printf("🔊 Audio level: %d (avg of %d samples)\n", avgLevel, sampleCount);
      // Print first 5 raw 16-bit samples for debugging
      Serial.print("   Raw 16-bit samples: ");
      for (int i = 0; i < 5 && i < sampleCount; i++) {
        Serial.printf("%d ", audioBuffer[i]);
      }
      Serial.println();
    }

    // Blink LED briefly when sending audio
    if (audioPacketsSent % 50 == 0) {
      digitalWrite(LED_PIN, LOW);
      delay(10);
      digitalWrite(LED_PIN, HIGH);
    }

    // Report statistics every 10 seconds
    if (millis() - lastStatsReport > 10000) {
      unsigned long uptime = (millis() - connectionTime) / 1000;
      Serial.printf("�� Stats - Packets: %lu, Uptime: %lu s, WiFi: %d dBm, Heap: %d bytes\n",
                    audioPacketsSent, uptime, WiFi.RSSI(), ESP.getFreeHeap());
      lastStatsReport = millis();
    }
  } else if (result != ESP_OK) {
    Serial.printf("❌ I2S read error: %d\n", result);
  }
}

// =============================================================================
// HEARTBEAT
// =============================================================================

unsigned long lastHeartbeat = 0;
const unsigned long HEARTBEAT_INTERVAL = 30000; // 30 seconds

void sendHeartbeat() {
  if (!isConnected || !isRegistered) {
    return;
  }

  if (millis() - lastHeartbeat > HEARTBEAT_INTERVAL) {
    StaticJsonDocument<64> doc;
    doc["type"] = "ping";

    String json;
    serializeJson(doc, json);
    webSocket.sendTXT(json);

    lastHeartbeat = millis();
  }
}

// =============================================================================
// FACTORY-RESET BUTTON (GPIO0 / BOOT)
// =============================================================================
//
// Hold for RESET_HOLD_MS (5s) to clear NVS and reboot into provisioning.
// Slow LED blink starts after 1s as feedback so the user knows the press
// was registered. Polled from loop() in both normal and config modes.
//
void checkResetButton() {
  // Debounced long-press detector. The I2S read between loop iterations
  // makes our polling rate ~16 Hz; cheap dev-board buttons bounce HIGH
  // for a single sample during that window, so we treat the button as
  // "still held" until it's been HIGH for DEBOUNCE_RELEASE_MS straight.
  //
  // Boot-time grace: ignore any LOW reading in the first 3 seconds after
  // boot. GPIO0 is the boot strap, can read transiently LOW during
  // power-up. Without this guard we observed phantom factory resets at
  // ~10-30s post-boot when the line settled noisily after BLE+WiFi
  // initialization.
  static unsigned long pressStart = 0;
  static unsigned long lastLowMs = 0;
  static unsigned long lastBlink = 0;
  static bool blinkState = false;
  const unsigned long DEBOUNCE_RELEASE_MS = 250;
  const unsigned long BOOT_GRACE_MS = 3000;

  unsigned long now = millis();
  if (now < BOOT_GRACE_MS) return;

  bool low = (digitalRead(RESET_BUTTON_PIN) == LOW);

  if (low) {
    lastLowMs = now;
    if (pressStart == 0) {
      pressStart = now;
    }
  }

  if (pressStart == 0) return;

  // Released stably (no LOW reading in the debounce window)
  if (!low && (now - lastLowMs) > DEBOUNCE_RELEASE_MS) {
    pressStart = 0;
    return;
  }

  unsigned long held = now - pressStart;

  if (held >= RESET_HOLD_MS) {
    Serial.println("🔘 BOOT held 5s — factory reset");
    performFactoryReset();
    return;
  }

  // After 1s, slow-blink LED as feedback that the press was registered
  if (held > 1000 && now - lastBlink > 200) {
    blinkState = !blinkState;
    digitalWrite(LED_PIN, blinkState ? HIGH : LOW);
    lastBlink = now;
  }
}

// =============================================================================
// STATUS LED
// =============================================================================

void updateStatusLED() {
  static unsigned long lastBlink = 0;
  static bool ledState = false;

  if (isRegistered) {
    // Solid on when registered
    digitalWrite(LED_PIN, HIGH);
  } else if (isConnected) {
    // Fast blink when connected but not registered
    if (millis() - lastBlink > 250) {
      ledState = !ledState;
      digitalWrite(LED_PIN, ledState);
      lastBlink = millis();
    }
  } else {
    // Slow blink when disconnected
    if (millis() - lastBlink > 1000) {
      ledState = !ledState;
      digitalWrite(LED_PIN, ledState);
      lastBlink = millis();
    }
  }
}

// =============================================================================
// SETUP
// =============================================================================

void setup() {
  // Initialize serial
  Serial.begin(115200);
  delay(1000);

  Serial.println("\n\n");
  Serial.println("╔════════════════════════════════════════╗");
  Serial.println("║   BabyLink ESP32 Baby Device v1.0    ║");
  Serial.println("╚════════════════════════════════════════╝");
  Serial.println();

  // Load configuration from flash (or use defaults)
  loadConfiguration();

  // Initialize LED + BOOT button (for factory-reset long-press)
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);
  pinMode(RESET_BUTTON_PIN, INPUT_PULLUP);

  // Initialize I2S microphone
  setupI2S();

  // Connect to WiFi
  setupWiFi();

  // If in config mode, don't continue to WebSocket setup
  if (isConfigMode) {
    Serial.println("⚙️  Configuration mode active - waiting for user setup...");
    return;
  }

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("❌ Cannot continue without WiFi. Check configuration.");
    return;
  }

  // Connect to WebSocket
  Serial.println("🔌 Connecting to BabyLink server...");
  Serial.printf("   Host: %s\n", configServerHost.c_str());
  Serial.printf("   Port: %d\n", configServerPort);
  Serial.printf("   Endpoint: /esp32-baby\n");

  // Use SSL if port is 443, otherwise plain WebSocket
  if (configServerPort == 443) {
    Serial.println("   Using secure WebSocket (WSS)");
    webSocket.beginSSL(configServerHost.c_str(), configServerPort, "/esp32-baby");
  } else {
    Serial.println("   Using plain WebSocket (WS)");
    webSocket.begin(configServerHost.c_str(), configServerPort, "/esp32-baby");
  }

  webSocket.onEvent(webSocketEvent);
  webSocket.setReconnectInterval(5000);
  webSocket.enableHeartbeat(15000, 3000, 2);

  Serial.println("✅ Setup complete");
  Serial.println("🎧 Waiting for server connection...");
  Serial.println();
}

// =============================================================================
// MAIN LOOP
// =============================================================================

void loop() {
  // BOOT button long-press → factory reset (works in both modes)
  checkResetButton();

  // If in configuration mode, handle web server, DNS, and async WiFi scan
  if (isConfigMode) {
    dnsServer.processNextRequest();
    webServer.handleClient();
    pollScanComplete();
    yield();
    return;
  }

  // Normal operation mode
  // Handle WebSocket events
  webSocket.loop();

  // Update status LED
  updateStatusLED();

  // Send heartbeat
  sendHeartbeat();

  // Process and send audio
  processAudio();

  // Small delay to prevent watchdog issues
  yield();
}
