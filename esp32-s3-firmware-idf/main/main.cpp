// BabyLink — XIAO ESP32-S3 firmware (ESP-IDF + Arduino-as-component).
//
// Sub-Branch 5.1b mikro-commit 2: + BLE GATT provisioning via
// h2zero/esp-nimble-cpp. The PWA wizard's UUIDs are unchanged so the
// existing flow works against this firmware. No audio, no SoftAP, no
// WSS yet — those land in the next mikro-commits of this branch.
//
// The PIO version under ../../esp32-s3-firmware/src/main.cpp remains
// authoritative for behaviour until 5.1d removes it.

#include <Arduino.h>
#include <WiFi.h>
#include <Preferences.h>
#include <esp_mac.h>
#include <vector>
#include <algorithm>
#include <string>
#include <ArduinoJson.h>
#include <NimBLEDevice.h>

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

static const char* DEVICE_TYPE = "esp32-s3";

static const int MAX_WIFI_PROFILES   = 6;
static const int MAX_SERVER_PROFILES = 4;

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
String deviceId;
unsigned long lastLedToggle = 0;
bool ledState = false;
unsigned long lastStatusReport = 0;

// =============================================================================
// CONFIG (cfg_v3 JSON ↔ NVS)
// =============================================================================

bool hasActiveServer() {
  return !serverProfiles.empty()
      && activeServer >= 0
      && activeServer < (int)serverProfiles.size();
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
// BLE PROVISIONING (NimBLE GATT server, same UUIDs as classic firmware
//                   so the existing PWA wizard works unchanged)
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
  doc["fw"]       = "5.1b-mc2-idf";
  doc["mic"]      = "pdm";
  doc["camera"]   = true;
  doc["channels"] = 1;
  doc["mac"]      = macHex();
  String out;
  serializeJson(doc, out);
  return out;
}

void publishInfoToBle() {
  if (!bleInfoChar) return;
  String json = buildInfoJson();
  bleInfoChar->setValue((const uint8_t*)json.c_str(), json.length());
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
  bleInfoChar   = mkChar(BLE_CHAR_INFO,    NIMBLE_PROPERTY::READ);

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
  if (wifiProfiles.empty()) {
    Serial.println("[WiFi] No profiles — staying idle (BLE/SoftAP land in later commits).");
    return;
  }

  WiFi.mode(WIFI_STA);
  int idx = pickBestWifiProfile();
  if (idx < 0) return;

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
  } else {
    Serial.println("[WiFi] Failed to connect.");
  }
}

// =============================================================================
// SETUP / LOOP
// =============================================================================

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\n=== BabyLink XIAO ESP32-S3 (IDF 5.1b mc2 — WiFi + BLE) ===");

  pinMode(LED_PIN, OUTPUT);
  setLED(false);

  deviceId = String("esp32_") + macHex();
  Serial.printf("[id] device_id=%s type=%s name='%s'\n",
                deviceId.c_str(), DEVICE_TYPE, configDeviceName.c_str());

  loadConfig();
  // Ensure WiFi stack is up for the BLE-driven async scan, even when no
  // STA profile is configured. Without a mode set, scanNetworks() fails
  // immediately and the BLE scan response is permanently empty.
  WiFi.mode(WIFI_STA);
  startBLE();
  connectWiFi();
}

void loop() {
  updateLED();
  pollBleScanComplete();

  unsigned long now = millis();
  if (now - lastStatusReport >= 5000) {
    lastStatusReport = now;
    Serial.printf("[status] uptime=%lus wifi=%s heap=%u\n",
                  now / 1000,
                  (WiFi.status() == WL_CONNECTED) ? "up" : "down",
                  (unsigned)ESP.getFreeHeap());
  }

  delay(50);
}

extern "C" void app_main() {
  initArduino();
  setup();
  while (true) {
    loop();
  }
}
