# BabyLink

A self-hosted baby monitor. WebRTC audio between phones, optional ESP32-S3
hardware as a baby device, no cloud, no accounts. Multiple babies and parents
in one room work side by side.

Live demo: <https://babylink.itvoodoo.at> · Android app:
[babylink-app](https://github.com/mkampl/babylink-app)

[![License](https://img.shields.io/badge/license-BSD--3--Clause-blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A516.0.0-brightgreen)](https://nodejs.org/)

**Audio only — video is out of scope.**

## Quick start

```sh
PUBLIC_HOST=192.168.x.y docker compose up -d --build
```

Open `http://192.168.x.y:3001` on a phone, create a room, then open the same URL
on a second device and pick *Baby* or *Parent*. `PUBLIC_HOST` is the address
advertised to ESP32-S3 devices during BLE provisioning; omit it for browser-only
use. Without Docker: `npm install && npm start` (`npm test` runs the suite).

> **Microphones need a secure context.** `getUserMedia` works on `localhost`
> over HTTP, but on a LAN IP you need HTTPS — run Caddy with the bundled
> `Caddyfile.local`, or see [DEPLOYMENT.md](DEPLOYMENT.md) for a public server.

## What it does

- **Audio** over WebRTC (Opus, peer-to-peer; only signaling goes through the server).
- **Multi-baby / multi-parent rooms** with per-baby volume, sensitivity, mute, solo.
- **Voice activity detection** (quiet / active / crying) with optional ntfy push.
- **Sleep timeline**, stored locally on the parent — nothing leaves the device.
- **PIN-locked rooms** and an **owner token** for management.
- **PWA**: installable, offline shell, screen wake lock, dark mode.

## ESP32-S3 hardware

Firmware in `esp32-s3-firmware-idf/` for the Seeed XIAO ESP32-S3 Sense (onboard
PDM mic). Build and flash via the Docker wrapper:

```sh
cd esp32-s3-firmware-idf
./idf.sh build && ./idf.sh flash
```

It boots into BLE + a SoftAP captive portal; provision from the PWA
(*Add device → via Bluetooth*, Chrome) or via the SoftAP. Hold BOOT 5 s to
factory-reset.

## Security

Rooms are 128-bit unguessable IDs acting as bearer tokens; management needs the
owner token returned at creation; PINs are hashed with a salted KDF. Full threat
model in [SECURITY.md](SECURITY.md).

## Layout

```
public/                PWA assets (css, js, icons, manifest, SW)
views/                 server-rendered HTML
server.js, server/     entry, socket.io handlers, ESP32 proxy, room state
tests/                 vitest suite
tools/                 dev tools (S3 simulator, BLE provisioning CLI)
esp32-s3-firmware-idf/ firmware (ESP-IDF + Arduino-as-component)
```

## License

BSD-3-Clause — see [LICENSE](LICENSE). Third-party components: [THIRD_PARTY.md](THIRD_PARTY.md).
