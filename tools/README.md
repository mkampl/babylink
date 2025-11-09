# BabyLink Development Tools

This directory contains development and testing tools for BabyLink.

## ESP32 Simulator

A Node.js-based simulator that emulates an ESP32 baby device for development and testing without requiring physical hardware.

### Features

- ✅ WebSocket connection to server
- ✅ Device registration
- ✅ Simulated PCM audio transmission
- ✅ Automatic audio level cycling (quiet → movement → crying)
- ✅ Real-time statistics
- ✅ Heartbeat mechanism
- ✅ Automatic reconnection

### Usage

**Basic usage** (default configuration):
```bash
node tools/esp32-simulator.js
```

**Custom room and name**:
```bash
node tools/esp32-simulator.js --room my-test-room --name "Living Room"
```

**Using npm script**:
```bash
npm run simulate:esp32
```

**Multiple simulators**:
```bash
# Terminal 1
node tools/esp32-simulator.js --name "Baby 1"

# Terminal 2
node tools/esp32-simulator.js --name "Baby 2"

# Terminal 3
node tools/esp32-simulator.js --name "Baby 3"
```

### Environment Variables

- `SERVER_HOST` - Server hostname (default: `localhost`)
- `SERVER_PORT` - Server port (default: `3000`)

Example:
```bash
SERVER_HOST=192.168.1.100 SERVER_PORT=3001 node tools/esp32-simulator.js
```

### Output

The simulator displays:

```
╔════════════════════════════════════════╗
║   ESP32 Baby Device Simulator v1.0   ║
╚════════════════════════════════════════╝

Configuration:
  Server:      localhost:3000
  Room ID:     test-room
  Device Name: ESP32 Simulator
  Sample Rate: 16000 Hz
  Buffer Size: 1024 samples

🔌 Connecting to ws://localhost:3000/esp32-baby...
✅ WebSocket connected
📤 Sending registration: {
  type: 'register',
  roomId: 'test-room',
  name: 'ESP32 Simulator',
  sampleRate: 16000,
  channels: 1
}
📨 Received: { type: 'registered', id: 'esp32_1234567890_abc123', ... }
✅ Registered as device: esp32_1234567890_abc123
🎤 Starting audio transmission...

📊 Stats - 🟢 Level: quiet    | Packets: 78  | Uptime: 5s  | Rate: 15/s
📊 Stats - 🟡 Level: movement | Packets: 156 | Uptime: 10s | Rate: 15/s
📊 Stats - 🔴 Level: crying   | Packets: 234 | Uptime: 15s | Rate: 15/s
```

### Audio Simulation

The simulator cycles through different audio levels:

1. **Quiet** (🟢): Low amplitude background noise (0-50)
2. **Movement** (🟡): Medium amplitude with tones (50-150)
3. **Crying** (🔴): High amplitude crying-like sounds (150-250)

Audio cycle: `quiet → quiet → quiet → movement → movement → crying → crying → quiet`

Each level lasts approximately 3-4 seconds (50 packets).

### Testing with Parent Device

1. Start the BabyLink server
2. Run the ESP32 simulator
3. Open a browser and join the same room as a parent
4. You should see "ESP32 Simulator" appear as a baby device
5. Observe the audio level changes (green → yellow → red)

### Troubleshooting

**Connection refused**:
- Ensure the server is running
- Check server host/port configuration
- Verify firewall settings

**No audio in parent device**:
- Check browser console for errors
- Verify room ID matches
- Check server logs for audio relay

**Simulator crashes**:
- Ensure `ws` package is installed: `npm install`
- Check Node.js version (>= 16.0.0)

### Development

The simulator is useful for:
- Testing server ESP32 integration
- Developing parent UI features
- Automated testing
- Demos without hardware
- Load testing (multiple simulators)

### Code Structure

```javascript
// Main simulator class
class ESP32Simulator {
  connect()                // Connect to WebSocket
  handleOpen()            // Handle connection
  handleMessage(data)     // Handle server messages
  startAudioTransmission() // Start sending audio
  printStats()            // Display statistics
}

// Audio generation
generateAudioData(level) // Generate PCM audio buffer
```

### Advanced Usage

**Custom audio generation**:

Edit `generateAudioData()` function to create custom audio patterns:

```javascript
function generateAudioData(level) {
  const buffer = Buffer.alloc(config.bufferSize * 2);

  for (let i = 0; i < config.bufferSize; i++) {
    // Your custom audio generation
    const sample = yourCustomLogic(i);
    buffer.writeInt16LE(sample, i * 2);
  }

  return buffer;
}
```

**Fixed audio level**:

Comment out the level cycling in `startAudioTransmission()`:

```javascript
// this.levelIndex = (this.levelIndex + 1) % this.levelCycle.length;
// this.audioLevel = this.levelCycle[this.levelIndex];
this.audioLevel = 'crying'; // Force crying level
```

**Load testing**:

Use a script to spawn multiple simulators:

```bash
#!/bin/bash
for i in {1..10}; do
  node tools/esp32-simulator.js --name "Baby $i" &
done
```

## Future Tools

Planned development tools:

- 📋 **WebRTC Test Client**: Test WebRTC connections
- 📋 **Room Inspector**: Monitor active rooms and connections
- 📋 **Audio Analyzer**: Visualize and analyze audio levels
- 📋 **Performance Profiler**: Monitor server performance
- 📋 **Load Tester**: Automated load testing

## Contributing

To add a new tool:

1. Create the tool script in this directory
2. Add documentation to this README
3. Add npm script if appropriate
4. Test thoroughly
5. Submit pull request
