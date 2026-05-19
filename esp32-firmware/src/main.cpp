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
#include <NimBLEDevice.h>

// =============================================================================
// CONFIGURATION - EDIT THESE VALUES
// =============================================================================

// DEFAULT WiFi Credentials (fallback if no config saved)
const char* DEFAULT_WIFI_SSID = "FRITZ!Box 7590 TK";
const char* DEFAULT_WIFI_PASSWORD = "91058042730434816265";

// DEFAULT BabyLink Server Configuration
const char* DEFAULT_SERVER_HOST = "babylink.itvoodoo.at";  // Your BabyLink server hostname
const uint16_t DEFAULT_SERVER_PORT = 443;                   // HTTPS port
const char* DEFAULT_ROOM_ID = "48080e150509dfc158c896919491becf";  // Room ID to join
const char* DEFAULT_DEVICE_NAME = "ESP32 Real Hardware";   // Name of this baby device

// Configuration Portal Settings
const char* AP_SSID = "BabyLink-Setup";      // Access Point name for configuration
const char* AP_PASSWORD = "";                // No password for easy setup

// Runtime configuration (loaded from preferences or defaults)
String configWifiSsid;
String configWifiPassword;
String configServerHost;
uint16_t configServerPort;
String configRoomId;
String configDeviceName;

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

// BLE Service and Characteristic UUIDs
#define BLE_SERVICE_UUID        "bab71111-0001-1000-8000-00805f9b34fb"
#define BLE_CHAR_WIFI_SSID      "bab71111-0002-1000-8000-00805f9b34fb"
#define BLE_CHAR_WIFI_PASS      "bab71111-0003-1000-8000-00805f9b34fb"
#define BLE_CHAR_SERVER_HOST    "bab71111-0004-1000-8000-00805f9b34fb"
#define BLE_CHAR_SERVER_PORT    "bab71111-0005-1000-8000-00805f9b34fb"
#define BLE_CHAR_ROOM_ID        "bab71111-0006-1000-8000-00805f9b34fb"
#define BLE_CHAR_DEVICE_NAME    "bab71111-0007-1000-8000-00805f9b34fb"
#define BLE_CHAR_COMMAND        "bab71111-0008-1000-8000-00805f9b34fb"

// BLE provisioning state
bool isBLEActive = false;
String bleSsid = "";
String blePassword = "";
String bleServerHost = "";
String bleServerPort = "";
String bleRoomId = "";
String bleDeviceName = "";

// BLE Callbacks
class BLEProvisionCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* pCharacteristic) {
    String uuid = String(pCharacteristic->getUUID().toString().c_str());
    String value = String(pCharacteristic->getValue().c_str());

    Serial.printf("[BLE] Write to %s: %s\n", uuid.c_str(), value.c_str());

    if (uuid.indexOf("0002") > 0) bleSsid = value;
    else if (uuid.indexOf("0003") > 0) blePassword = value;
    else if (uuid.indexOf("0004") > 0) bleServerHost = value;
    else if (uuid.indexOf("0005") > 0) bleServerPort = value;
    else if (uuid.indexOf("0006") > 0) bleRoomId = value;
    else if (uuid.indexOf("0007") > 0) bleDeviceName = value;
    else if (uuid.indexOf("0008") > 0) {
      // Command characteristic — "apply" triggers save and restart
      if (value == "apply") {
        Serial.println("[BLE] Apply command received — saving config and restarting");

        // Update runtime config from BLE values
        if (bleSsid.length() > 0) configWifiSsid = bleSsid;
        if (blePassword.length() > 0) configWifiPassword = blePassword;
        if (bleServerHost.length() > 0) configServerHost = bleServerHost;
        if (bleServerPort.length() > 0) configServerPort = bleServerPort.toInt();
        if (bleRoomId.length() > 0) configRoomId = bleRoomId;
        if (bleDeviceName.length() > 0) configDeviceName = bleDeviceName;

        // Save to NVS
        preferences.begin("babylink", false);
        preferences.putString("wifi_ssid", configWifiSsid);
        preferences.putString("wifi_pass", configWifiPassword);
        preferences.putString("server_host", configServerHost);
        preferences.putUInt("server_port", configServerPort);
        preferences.putString("room_id", configRoomId);
        preferences.putString("device_name", configDeviceName);
        preferences.end();

        Serial.println("[BLE] Configuration saved. Restarting in 1 second...");
        delay(1000);
        ESP.restart();
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

  NimBLEServer* pServer = NimBLEDevice::createServer();
  NimBLEService* pService = pServer->createService(BLE_SERVICE_UUID);

  BLEProvisionCallbacks* callbacks = new BLEProvisionCallbacks();

  // Create writable characteristics for each config field
  auto createChar = [&](const char* uuid) {
    NimBLECharacteristic* c = pService->createCharacteristic(
      uuid,
      NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::READ
    );
    c->setCallbacks(callbacks);
    return c;
  };

  createChar(BLE_CHAR_WIFI_SSID);
  createChar(BLE_CHAR_WIFI_PASS);
  createChar(BLE_CHAR_SERVER_HOST);
  createChar(BLE_CHAR_SERVER_PORT);
  createChar(BLE_CHAR_ROOM_ID);
  createChar(BLE_CHAR_DEVICE_NAME);
  createChar(BLE_CHAR_COMMAND);

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
 * Load configuration from flash storage (or use defaults)
 */
void loadConfiguration() {
  preferences.begin("babylink", false);  // Open in read-write mode

  // Load WiFi config (or use defaults)
  configWifiSsid = preferences.getString("wifi_ssid", DEFAULT_WIFI_SSID);
  configWifiPassword = preferences.getString("wifi_pass", DEFAULT_WIFI_PASSWORD);

  // Load server config (or use defaults)
  configServerHost = preferences.getString("server_host", DEFAULT_SERVER_HOST);
  configServerPort = preferences.getUInt("server_port", DEFAULT_SERVER_PORT);
  configRoomId = preferences.getString("room_id", DEFAULT_ROOM_ID);
  configDeviceName = preferences.getString("device_name", DEFAULT_DEVICE_NAME);

  preferences.end();

  Serial.println("📋 Configuration loaded:");
  Serial.printf("   WiFi: %s\n", configWifiSsid.c_str());
  Serial.printf("   Server: %s:%d\n", configServerHost.c_str(), configServerPort);
  Serial.printf("   Room: %s\n", configRoomId.c_str());
  Serial.printf("   Device: %s\n", configDeviceName.c_str());
}

/**
 * Save configuration to flash storage
 */
void saveConfiguration(String ssid, String password, String host, uint16_t port, String roomId, String deviceName) {
  preferences.begin("babylink", false);

  preferences.putString("wifi_ssid", ssid);
  preferences.putString("wifi_pass", password);
  preferences.putString("server_host", host);
  preferences.putUInt("server_port", port);
  preferences.putString("room_id", roomId);
  preferences.putString("device_name", deviceName);

  preferences.end();

  Serial.println("💾 Configuration saved to flash!");
}

/**
 * Clear saved configuration (reset to defaults)
 */
void clearConfiguration() {
  preferences.begin("babylink", false);
  preferences.clear();
  preferences.end();
  Serial.println("🗑️  Configuration cleared");
}

// =============================================================================
// CONFIGURATION WEB PORTAL
// =============================================================================

const char CONFIG_HTML[] PROGMEM = R"rawliteral(
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>BabyLink Setup</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        .container {
            background: white;
            border-radius: 20px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            max-width: 500px;
            width: 100%;
            padding: 40px;
        }
        h1 {
            color: #667eea;
            text-align: center;
            margin-bottom: 10px;
            font-size: 28px;
        }
        .subtitle {
            text-align: center;
            color: #666;
            margin-bottom: 30px;
            font-size: 14px;
        }
        .form-group {
            margin-bottom: 20px;
        }
        label {
            display: block;
            margin-bottom: 8px;
            color: #333;
            font-weight: 500;
            font-size: 14px;
        }
        input, select {
            width: 100%;
            padding: 12px;
            border: 2px solid #e0e0e0;
            border-radius: 8px;
            font-size: 14px;
            transition: border-color 0.3s;
        }
        input:focus, select:focus {
            outline: none;
            border-color: #667eea;
        }
        .btn {
            width: 100%;
            padding: 14px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            border-radius: 8px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            transition: transform 0.2s;
        }
        .btn:hover {
            transform: translateY(-2px);
        }
        .btn:active {
            transform: translateY(0);
        }
        .info {
            background: #f0f4ff;
            padding: 15px;
            border-radius: 8px;
            margin-bottom: 20px;
            font-size: 13px;
            color: #555;
        }
        .divider {
            margin: 30px 0;
            height: 1px;
            background: #e0e0e0;
        }
        .scan-btn {
            background: #28a745;
            margin-bottom: 15px;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🍼 BabyLink</h1>
        <div class="subtitle">ESP32 Baby Monitor Setup</div>

        <div class="info">
            Connect this ESP32 to your WiFi network and configure your BabyLink server.
        </div>

        <form action="/save" method="POST">
            <div class="form-group">
                <label>WiFi Network</label>
                <input type="text" name="wifi_ssid" placeholder="Network name (SSID)" required>
            </div>

            <div class="form-group">
                <label>WiFi Password</label>
                <input type="password" name="wifi_password" placeholder="Password">
            </div>

            <div class="divider"></div>

            <div class="form-group">
                <label>Server Address</label>
                <input type="text" name="server_host" placeholder="IP address or hostname" required>
            </div>

            <div class="form-group">
                <label>Server Port</label>
                <input type="number" name="server_port" value="3001" required>
            </div>

            <div class="form-group">
                <label>Room ID</label>
                <input type="text" name="room_id" placeholder="Room identifier" required>
            </div>

            <div class="form-group">
                <label>Device Name</label>
                <input type="text" name="device_name" placeholder="Baby Monitor Name" required>
            </div>

            <button type="submit" class="btn">💾 Save & Connect</button>
        </form>
    </div>
</body>
</html>
)rawliteral";

/**
 * Handle root page - show configuration form
 */
void handleRoot() {
  webServer.send(200, "text/html", CONFIG_HTML);
}

/**
 * Handle form submission - save config and restart
 */
void handleSave() {
  String ssid = webServer.arg("wifi_ssid");
  String password = webServer.arg("wifi_password");
  String host = webServer.arg("server_host");
  uint16_t port = webServer.arg("server_port").toInt();
  String roomId = webServer.arg("room_id");
  String deviceName = webServer.arg("device_name");

  // Validate inputs
  if (ssid.length() == 0 || host.length() == 0 || port == 0 || roomId.length() == 0) {
    webServer.send(400, "text/html", "<html><body><h1>Error: All fields required!</h1><a href='/'>Go back</a></body></html>");
    return;
  }

  // Save configuration
  saveConfiguration(ssid, password, host, port, roomId, deviceName);

  // Send success page
  String html = "<html><body style='font-family: Arial; text-align: center; padding: 50px;'>";
  html += "<h1 style='color: #667eea;'>✅ Configuration Saved!</h1>";
  html += "<p>BabyLink will now restart and connect to your WiFi network.</p>";
  html += "<p style='margin-top: 30px; color: #666;'>You can close this window.</p>";
  html += "</body></html>";

  webServer.send(200, "text/html", html);

  delay(2000);
  ESP.restart();  // Restart to apply new config
}

/**
 * Start configuration web server
 */
void startConfigPortal() {
  Serial.println("🌐 Starting configuration portal...");

  // Start Access Point
  WiFi.mode(WIFI_AP);
  WiFi.softAP(AP_SSID, AP_PASSWORD);

  IPAddress IP = WiFi.softAPIP();
  Serial.printf("   AP IP: %s\n", IP.toString().c_str());
  Serial.printf("   AP SSID: %s\n", AP_SSID);
  Serial.println("   Connect to this network and visit http://192.168.4.1");

  // Setup DNS server for captive portal
  dnsServer.start(DNS_PORT, "*", IP);

  // Setup web server routes
  webServer.on("/", handleRoot);
  webServer.on("/save", HTTP_POST, handleSave);
  webServer.onNotFound(handleRoot);  // Redirect all unknown requests to config page

  webServer.begin();
  isConfigMode = true;

  // Also start BLE for phone provisioning (Android Web Bluetooth)
  startBLE();

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

void setupWiFi() {
  Serial.println("📡 Connecting to WiFi...");
  Serial.printf("   SSID: %s\n", configWifiSsid.c_str());

  WiFi.mode(WIFI_STA);
  WiFi.begin(configWifiSsid.c_str(), configWifiPassword.c_str());

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 30) {
    delay(500);
    Serial.print(".");
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n✅ WiFi connected");
    Serial.printf("   IP: %s\n", WiFi.localIP().toString().c_str());
    Serial.printf("   Signal: %d dBm\n", WiFi.RSSI());
  } else {
    Serial.println("\n❌ WiFi connection failed");
    Serial.println("⚠️  Starting configuration portal...");
    startConfigPortal();
  }
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
        StaticJsonDocument<256> doc;
        doc["type"] = "register";
        doc["roomId"] = configRoomId;
        doc["name"] = configDeviceName;
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

  // Initialize LED
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);

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
  // If in configuration mode, handle web server and DNS
  if (isConfigMode) {
    dnsServer.processNextRequest();
    webServer.handleClient();
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
