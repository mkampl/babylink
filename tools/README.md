# tools/

Development utilities for BabyLink. All tools target the ESP32-S3
(XIAO ESP32-S3 Sense, WebRTC/Opus path). The classic ESP32 simulator
and provisioner have been removed along with that firmware.

## esp32-s3-simulator.js

Node.js script that connects to the `/esp32-baby` WebSocket endpoint,
registers as a `device_type=esp32-s3` device, and sends periodic
keep-alive pings. Useful for testing the server-side ESP32 proxy and
parent UI without physical hardware.

**Usage:**

```sh
# server must be running on localhost:3001
node tools/esp32-s3-simulator.js

# custom room and name
node tools/esp32-s3-simulator.js --room <room-id> --name "Bench S3"

# remote server
SERVER_HOST=192.168.1.10 SERVER_PORT=3001 node tools/esp32-s3-simulator.js --room <id>
```

Arguments: `--room <id>`, `--name <label>`, `--mac <hex>` (all optional).  
Default room: `test-room`. Default port: `3001`.

## esp32-s3-ble-provision.py

Python CLI that speaks the BabyLink BLE GATT provisioning protocol to
a physical XIAO ESP32-S3 device. Requires `bleak` (`pip install bleak`).

**Subcommands:**

| Command | What it does |
| ------- | ------------ |
| `set`   | Write WiFi + server profile and apply |
| `scan`  | Trigger and read a device-side WiFi scan |
| `info`  | Read `device_info` JSON (model, mic, fw tag) |
| `reset` | Send `wifi-reset` — clears NVS and reboots |

**Usage:**

```sh
# provision a device in range
python tools/esp32-s3-ble-provision.py set \
  --ssid MyNetwork --password s3cr3t \
  --server wss://babylink.example.com

# read device info
python tools/esp32-s3-ble-provision.py info

# factory-reset NVS
python tools/esp32-s3-ble-provision.py reset
```

The tool scans for BLE advertisements with the prefix `BabyLinkS3`.
Pass `--device <address>` to skip scanning if you already know the MAC.
