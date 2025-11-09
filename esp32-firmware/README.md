# BabyLink ESP32 Baby Device Firmware

This firmware turns an ESP32 microcontroller with an I2S microphone into a dedicated baby monitor device for the BabyLink system.

## Hardware Requirements

### Components
- **ESP32 Development Board** (ESP32-WROOM-32 or similar) - ~$5
- **INMP441 I2S MEMS Microphone** - ~$3
- **USB Cable** for power and programming
- **Jumper wires** for connections
- Optional: **LED** (built-in LED on GPIO2 is used by default)

### Total Cost
Approximately **$8-13** per device

## Wiring Diagram

Connect the INMP441 microphone to the ESP32 as follows:

```
ESP32          INMP441
-----          -------
3.3V    ----   VDD
GND     ----   GND
GPIO25  ----   SCK (Serial Clock / BCLK)
GPIO33  ----   WS  (Word Select / LRCLK)
GPIO32  ----   SD  (Serial Data / SDIN)
GND     ----   L/R (Left channel select)
```

**Note**: Connect L/R pin to GND for left channel. The firmware uses mono audio.

## Software Setup

### Prerequisites

1. **Install PlatformIO**
   - VS Code Extension: https://platformio.org/install/ide?install=vscode
   - Or PlatformIO CLI: https://platformio.org/install/cli

2. **Install Drivers**
   - Most ESP32 boards use CP210x or CH340 USB-to-Serial chips
   - Download drivers from your board manufacturer's website

### Configuration

1. **Edit Configuration** in `src/main.cpp`:

```cpp
// WiFi Credentials
const char* WIFI_SSID = "YourWiFiSSID";
const char* WIFI_PASSWORD = "YourWiFiPassword";

// BabyLink Server Configuration
const char* SERVER_HOST = "192.168.1.100";  // Your server IP
const uint16_t SERVER_PORT = 3000;
const char* ROOM_ID = "your-room-id";
const char* DEVICE_NAME = "ESP32 Bedroom";
```

2. **Find Your Server IP**:
   ```bash
   # On Linux/Mac
   hostname -I

   # On Windows
   ipconfig
   ```

3. **Create a Room**:
   - Open BabyLink in your browser: `http://your-server-ip:3000`
   - Create a new room and note the Room ID from the URL

### Building and Uploading

#### Using PlatformIO CLI

```bash
cd esp32-firmware

# Build the firmware
pio run

# Upload to ESP32 (connect via USB)
pio run --target upload

# Open serial monitor
pio device monitor
```

#### Using VS Code

1. Open the `esp32-firmware` folder in VS Code
2. Click the PlatformIO icon in the sidebar
3. Under "Project Tasks":
   - Click "Build" to compile
   - Click "Upload" to flash to ESP32
   - Click "Monitor" to view serial output

## Testing

### Serial Monitor Output

When the ESP32 boots, you should see:

```
╔════════════════════════════════════════╗
║   BabyLink ESP32 Baby Device v1.0    ║
╚════════════════════════════════════════╝

🎤 Initializing I2S microphone...
✅ I2S microphone initialized
   Sample rate: 16000 Hz
   Bits per sample: 16
   Buffer size: 1024 samples

📡 Connecting to WiFi...
   SSID: YourWiFi
✅ WiFi connected
   IP: 192.168.1.150
   Signal: -45 dBm

🔌 Connecting to BabyLink server...
   Host: 192.168.1.100
   Port: 3000
   Endpoint: /esp32-baby

✅ WebSocket Connected
📤 Sent registration request
   Room ID: abc123
   Device Name: ESP32 Bedroom

✅ Successfully registered with server
   Device ID: esp32_1234567890_abc123

📊 Stats - Packets: 500, Uptime: 10 s, WiFi: -45 dBm
```

### LED Status

- **Slow Blink (1s)**: Disconnected from server
- **Fast Blink (250ms)**: Connected, waiting for registration
- **Solid On**: Registered and streaming audio

### Testing with Parent Device

1. Open BabyLink in a browser as a parent
2. Join the same room ID
3. You should see "ESP32 Bedroom" appear as a baby
4. Audio from the ESP32 microphone will stream to the parent

## Troubleshooting

### ESP32 Won't Connect to WiFi

- **Check credentials**: Ensure SSID and password are correct
- **Signal strength**: Move ESP32 closer to router
- **2.4GHz only**: ESP32 doesn't support 5GHz WiFi
- **Hidden SSID**: Add `WiFi.begin(SSID, PASSWORD, 0, NULL, true)` for hidden networks

### No Audio Received

1. **Check wiring**: Verify all I2S connections
2. **Test microphone**: Tap or blow on mic while watching serial monitor
3. **Volume**: Adjust sensitivity in parent UI
4. **Sample rate**: Ensure server and ESP32 match (16 kHz)

### WebSocket Connection Fails

- **Server IP**: Verify server is reachable (ping from another device)
- **Port**: Check server is running on specified port
- **Firewall**: Ensure port 3000 is open
- **Server logs**: Check server console for connection attempts

### Frequent Disconnections

- **WiFi signal**: Check with `WiFi.RSSI()` (> -70 dBm is good)
- **Power supply**: Use quality USB cable and 5V/1A+ power
- **Server capacity**: Check server resources aren't exhausted

### I2S Errors

- **Bad wiring**: Double-check all connections
- **Wrong pins**: Verify GPIO numbers match your board
- **Bad microphone**: Try a different INMP441 module

## Audio Configuration

### Adjusting Sample Rate

To change audio quality, edit in `src/main.cpp`:

```cpp
#define SAMPLE_RATE 16000  // Options: 8000, 16000, 44100

// Higher = better quality but more bandwidth
// 16000 Hz is optimal for voice (baby crying)
```

### Adjusting Buffer Size

```cpp
#define BUFFER_SIZE 1024  // Samples per transmission

// Larger = less frequent transmissions, higher latency
// Smaller = more frequent transmissions, lower latency
// 1024 samples @ 16 kHz = 64ms of audio
```

## Advanced Features

### Over-The-Air (OTA) Updates

To enable OTA updates, add to `src/main.cpp`:

```cpp
#include <ArduinoOTA.h>

void setup() {
  // ... existing setup ...

  ArduinoOTA.setHostname(DEVICE_NAME);
  ArduinoOTA.begin();
}

void loop() {
  ArduinoOTA.handle();
  // ... existing loop ...
}
```

Then upload via network:
```bash
pio run --target upload --upload-port 192.168.1.150
```

### Local Audio Detection

To only send audio when baby is crying (save bandwidth):

```cpp
void processAudio() {
  // ... read audio ...

  float volume = calculateVolume(audioBuffer, BUFFER_SIZE);

  // Only send if volume exceeds threshold
  if (volume > 50) {  // Adjust threshold as needed
    webSocket.sendBIN((uint8_t*)audioBuffer, bytesRead);
  }
}
```

### Multiple I2S Microphones

To add a second microphone for stereo or multiple rooms:

```cpp
#define I2S_PORT_0 I2S_NUM_0
#define I2S_PORT_1 I2S_NUM_1

// Initialize both ports
setupI2S(I2S_PORT_0, I2S_WS_0, I2S_SD_0, I2S_SCK_0);
setupI2S(I2S_PORT_1, I2S_WS_1, I2S_SD_1, I2S_SCK_1);
```

## Power Consumption

- **Active (WiFi + I2S)**: ~80-120 mA
- **Deep Sleep**: ~10-20 µA (not recommended for baby monitor)

With a 5V/1A USB power supply, the ESP32 can run indefinitely.

### Battery Operation (Optional)

For portable operation:

- **LiPo Battery**: 3.7V 2000mAh (~16-20 hours)
- **Power Bank**: 5V 10000mAh (~80-100 hours)

Add battery monitoring:

```cpp
#define BATTERY_PIN 34  // ADC pin

void checkBattery() {
  int raw = analogRead(BATTERY_PIN);
  float voltage = (raw / 4095.0) * 3.3 * 2; // Voltage divider

  if (voltage < 3.3) {
    Serial.println("⚠️ Low battery!");
  }
}
```

## Performance

- **Audio latency**: ~200-500ms (typical for network streaming)
- **Bandwidth**: ~256 kbps (16-bit, 16 kHz, mono)
- **CPU usage**: ~15-20% (one core)
- **RAM usage**: ~50-80 KB

## Security

- **Network**: Uses WebSocket (WS) - upgrade to WSS for encryption
- **Authentication**: Basic room ID - add password authentication for production
- **Firmware updates**: Use OTA with password protection

## Support

For issues or questions:
- Check server logs: `docker-compose logs -f`
- ESP32 serial monitor: `pio device monitor`
- Server status: `http://your-server:3000/api/esp32/status`

## License

MIT License - See parent project for details
