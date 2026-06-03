# BabyLink

A self-hosted baby monitor. WebRTC audio between phones, optional
ESP32 hardware as a baby device, no cloud, no accounts. Multiple
babies and multiple parents in the same room work side by side.

[![License](https://img.shields.io/badge/license-BSD--3--Clause-blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A516.0.0-brightgreen)](https://nodejs.org/)

## Quick start

Docker (recommended):

```sh
LAN_IP=192.168.x.y docker compose up -d --build
```

Open `http://<LAN_IP>:3001` on a phone. Create a room, then open the
same link on a second device and pick *Baby* or *Parent*.

`LAN_IP` is the address the BLE provisioning wizard hands to ESP32
devices. Skip it if you only use browser babies; the rest of the
PWA works either way.

Without Docker:

```sh
npm install
npm start
```

`npm test` runs the vitest suite.

## What it does

- **Audio** over WebRTC (Opus, end-to-end peer-to-peer; only signaling
  goes through the server).
- **Multi-baby / multi-parent rooms** with per-baby volume, sensitivity,
  mute, solo.
- **Voice activity detection** with three levels (quiet / active / crying).
  Optional ntfy.sh push when crying is detected.
- **Sleep timeline** stored locally on the parent (15 s detail + 12 h
  history), nothing leaves the device.
- **PIN-locked rooms** for shared spaces.
- **PWA**: installable, works offline for the shell, screen wake lock
  while monitoring, dark mode.

## Architecture

```
phone (parent) ──WebRTC──┐
                         ├─── room ──── phone (baby) ──┐
phone (parent) ──WebRTC──┤                             │
                         └─── room ──── ESP32-S3 ──────┤
                                        (mic + Opus)   │
                                                       │
                  ┌──────────── server ────────────────┘
                  │
                  ├── express + socket.io   (signaling, PWA)
                  ├── /esp32-baby WS bridge (ESP register + audio)
                  └── room state (in-memory)
```

The server is a thin signaling broker. Audio never traverses it
between two browsers; the ESP32 path is the one exception (it
streams raw PCM to the server when WebRTC isn't up yet, so older
clients still get audio).

## Routes

| Path | What |
| -- | -- |
| `/` | Home — create / join / list saved rooms |
| `/<roomId>` | Role picker for that room |
| `/<roomId>?role=baby\|parent` | The monitor view |
| `/api/config/webrtc` | ICE servers (STUN + optional TURN) |
| `/api/config/server-hint` | LAN address for the BLE wizard |
| `/api/rooms/:roomId/...` | PIN, ntfy, sleep, devices APIs |
| `/health` | uptime + room count |

Static paths (`/css/`, `/js/`, `/icons/`, `/manifest.json`,
`/service-worker.js`, `/health`) bypass the rate limiter.

## ESP32 hardware

Source: `esp32-s3-firmware-idf/`. Target: Seeed XIAO ESP32-S3 Sense
with the onboard PDM mic (MSM261D3526H1CPM).

Build + flash via the Docker wrapper:

```sh
cd esp32-s3-firmware-idf
./idf.sh build
./idf.sh flash
./idf.sh monitor
```

Out-of-the-box the device boots into BLE GATT advertising
(`BabyLinkS3-XXXX`) and a SoftAP captive portal (`BabyLinkS3-Setup`,
http://192.168.4.1). Provision from the PWA's *Add ESP32 Device →
Add via Bluetooth* on Chrome, or from any phone via the SoftAP.

Hold the BOOT button for 5 s to factory-reset.

For local dev shortcuts (skip BLE on a freshly flashed bench device),
copy `main/dev_defaults.h.example` to `main/dev_defaults.h` and fill
in WiFi + server. The file is `.gitignore`d.

## Environment

| Var | Default | Notes |
| -- | -- | -- |
| `PORT` | `3001` | HTTP port |
| `NODE_ENV` | `development` | Production trims logs |
| `PUBLIC_HOST` | auto | Host advertised to ESP32s (must be set in Docker) |
| `PUBLIC_PORT` | `$PORT` | Port advertised to ESP32s |
| `RATE_LIMIT_MAX_REQUESTS` | `100` | Per-IP, 15 min |
| `LOG_LEVEL` | `info` | `error \| warn \| info \| debug` |

TURN, ntfy, and reverse-proxy config live in `config/` and
`docker-compose.yaml`. See `DEPLOYMENT.md` for the production setup
notes (Caddy / nginx, certs, system service).

## Repository layout

```
public/                static PWA assets (css, js, icons, manifest, SW)
views/                 server-rendered HTML
server.js              entry, routes, middleware
server/                socket.io handlers, ESP32 proxy, room state
config/                env-driven config
tests/                 vitest suite (unit, integration, e2e-server, manual)
tools/                 dev tools (simulators, BLE provisioning CLI)
esp32-s3-firmware-idf/ firmware source (ESP-IDF + Arduino-as-component)
```

## License

BSD-3-Clause — see `LICENSE`.
