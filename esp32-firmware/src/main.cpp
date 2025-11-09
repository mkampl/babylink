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
 * GPIO25  ----   SCK (Serial Clock)
 * GPIO33  ----   WS  (Word Select / LR)
 * GPIO32  ----   SD  (Serial Data)
 * GND     ----   L/R (connects to GND for left channel)
 *
 * Optional: LED on GPIO2 for status indication
 */

#include <Arduino.h>
#include <WiFi.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include <driver/i2s.h>

// =============================================================================
// CONFIGURATION - EDIT THESE VALUES
// =============================================================================

// WiFi Credentials
const char* WIFI_SSID = "YourWiFiSSID";
const char* WIFI_PASSWORD = "YourWiFiPassword";

// BabyLink Server Configuration
const char* SERVER_HOST = "192.168.1.100";  // Your BabyLink server IP
const uint16_t SERVER_PORT = 3000;           // Server port
const char* ROOM_ID = "your-room-id";        // Room ID to join
const char* DEVICE_NAME = "ESP32 Bedroom";   // Name of this baby device

// I2S Microphone Pins
#define I2S_WS 33        // Word Select (LRCLK)
#define I2S_SD 32        // Serial Data (SDIN)
#define I2S_SCK 25       // Serial Clock (BCLK)
#define I2S_PORT I2S_NUM_0

// Audio Configuration
#define SAMPLE_RATE 16000       // Sample rate in Hz
#define BUFFER_SIZE 1024        // Audio buffer size (samples)
#define BITS_PER_SAMPLE 16      // Bits per sample

// Status LED Pin
#define LED_PIN 2

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
// I2S MICROPHONE SETUP
// =============================================================================

void setupI2S() {
  Serial.println("🎤 Initializing I2S microphone...");

  // I2S configuration
  i2s_config_t i2s_config = {
    .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX),
    .sample_rate = SAMPLE_RATE,
    .bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT,
    .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT,
    .communication_format = I2S_COMM_FORMAT_I2S,
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
  Serial.printf("   SSID: %s\n", WIFI_SSID);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

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
        doc["roomId"] = ROOM_ID;
        doc["name"] = DEVICE_NAME;
        doc["sampleRate"] = SAMPLE_RATE;
        doc["channels"] = 1;

        String json;
        serializeJson(doc, json);
        webSocket.sendTXT(json);

        Serial.println("📤 Sent registration request");
        Serial.printf("   Room ID: %s\n", ROOM_ID);
        Serial.printf("   Device Name: %s\n", DEVICE_NAME);
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

  // Read audio from I2S
  size_t bytesRead = 0;
  esp_err_t result = i2s_read(
    I2S_PORT,
    audioBuffer,
    BUFFER_SIZE * sizeof(int16_t),
    &bytesRead,
    portMAX_DELAY
  );

  if (result == ESP_OK && bytesRead > 0) {
    // Optional: Calculate volume for local processing
    // float volume = calculateVolume(audioBuffer, bytesRead / sizeof(int16_t));

    // Send audio data via WebSocket (binary)
    webSocket.sendBIN((uint8_t*)audioBuffer, bytesRead);
    audioPacketsSent++;

    // Blink LED briefly when sending audio
    if (audioPacketsSent % 50 == 0) {
      digitalWrite(LED_PIN, LOW);
      delay(10);
      digitalWrite(LED_PIN, HIGH);
    }

    // Report statistics every 10 seconds
    if (millis() - lastStatsReport > 10000) {
      unsigned long uptime = (millis() - connectionTime) / 1000;
      Serial.printf("📊 Stats - Packets: %lu, Uptime: %lu s, WiFi: %d dBm\n",
                    audioPacketsSent, uptime, WiFi.RSSI());
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

  // Initialize LED
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);

  // Initialize I2S microphone
  setupI2S();

  // Connect to WiFi
  setupWiFi();

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("❌ Cannot continue without WiFi. Restarting in 10 seconds...");
    delay(10000);
    ESP.restart();
  }

  // Connect to WebSocket
  Serial.println("🔌 Connecting to BabyLink server...");
  Serial.printf("   Host: %s\n", SERVER_HOST);
  Serial.printf("   Port: %d\n", SERVER_PORT);
  Serial.printf("   Endpoint: /esp32-baby\n");

  webSocket.begin(SERVER_HOST, SERVER_PORT, "/esp32-baby");
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
