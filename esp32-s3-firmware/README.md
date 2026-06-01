# BabyLink — XIAO ESP32-S3 Firmware

Separate codebase from `../esp32-firmware/` (which targets the
classic ESP32 + INMP441). This firmware targets the **Seeed Studio
XIAO ESP32-S3 Sense** (ESP32-S3R8, 8 MB flash, 8 MB PSRAM, OV3660
camera, MSM261D3526H1CPM PDM mic).

## Status

**Branch 1 — skeleton**: WiFi + WSS registration only. No audio, no
BLE, no provisioning. Boots, connects, registers as a baby device
with `device_type: "esp32-s3"` so the server distinguishes it from
the classic client. Later branches add PDM audio, BLE provisioning,
and WebRTC.

## Local dev

1. Copy `src/dev_defaults.h.example` → `src/dev_defaults.h` (gitignored)
   and fill in WiFi SSID / password / server host / port / room ID.
2. `pio run` to build, `pio run -t upload` to flash.
3. `pio device monitor` for serial output.

## Production builds

Omit `src/dev_defaults.h`. The device boots into provisioning mode
(coming in Branch 3) and waits for BLE / SoftAP configuration.
