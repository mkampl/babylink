# Branch 5 toolchain decision (Sub-Branch 5.0 spike outcome)

**Status**: spike complete, decision **deferred to user**.

## Goal recap

Branch 5 wants real WebRTC (Opus + DTLS/SRTP + ICE) running on the
ESP32-S3 itself, with the existing server acting only as a signaling
relay (Branch 4 already builds that). End goal: lower latency than
PCM-over-WSS, encrypted media, and unlocks Branch 7 (direct
ESP↔companion-app peer without internet).

The plan called out the canonical library — Espressif's
`espressif/esp_webrtc` from their `esp-webrtc-solution` repo.

## What I tried

The existing firmware is a PlatformIO project using the `pioarduino`
community fork of `platform-espressif32` (Arduino-ESP32 v3.3.8,
ESP-IDF v5.5.4). To add `esp_webrtc`:

1. **Tried `custom_component_add = espressif/esp_webrtc` in
   `platformio.ini`.** pioarduino exposes this option (per its
   `component_manager.py`). Result: directive accepted by PIO,
   visible in verbose build output, but **no component download
   or compile happens**. Reading the source, `handle_component_settings()`
   is invoked from `arduino.py` without args, defaulting
   `add_components=False`, which skips the add path entirely. So
   the directive is half-implemented in pioarduino today — present
   but inert.

2. **Tried dropping `idf_component.yml` directly into `src/`** with
   `dependencies: {espressif/esp_webrtc: "~1.2.0"}`. Same result —
   pioarduino's Arduino-only build path doesn't run the ESP-IDF
   Component Manager, so the manifest is ignored.

3. **Reviewed alternative libraries.** `sepfy/libpeer` is lighter
   (single dep on mbedtls/libsrtp/usrsctp/cJSON) and MIT, but it's
   ALSO published as an ESP-IDF managed component with its own
   `idf_component.yml`. Same integration problem.

## Why this is harder than expected

The `esp-webrtc-solution` package depends on 7 other Espressif
components (esp_peer, esp_capture, esp_codec_dev, esp_websocket_client,
nghttp, media_lib_utils, av_render), each pulling more. The only
mechanism that resolves this graph cleanly is the ESP-IDF Component
Manager, which is invoked by `idf.py build` and integrates with
ESP-IDF's CMake-based build. PIO's Arduino-only build path doesn't
run that manager.

The pioarduino `custom_component_add` looks like an attempted bridge,
but the current implementation is incomplete (see point 1).

## Two viable paths forward

### Path A — Convert firmware to native ESP-IDF + Arduino-as-component

**What it means**: Drop `platformio.ini`, structure the project as a
standard ESP-IDF project (`CMakeLists.txt`, `sdkconfig.defaults`,
`main/`, optional `components/`), build with `idf.py build`. Pull
Arduino-ESP32 in as one component among others (well-trodden pattern;
see Espressif's `arduino-esp32` README under "Using as an ESP-IDF
component").

| Pros | Cons |
|---|---|
| Standard ESP-IDF tooling. `idf_component.yml` works out of the box. esp-webrtc-solution drops in with one line. | 1–2 days of refactor to swap build system. |
| All existing C++ code carries over. Arduino-isms (`Serial.print`, `WiFi.h`, `Preferences`, `WebSocketsClient`, `NimBLEDevice.h`) still work because Arduino IS a component. | Loses PIO conveniences (`pio run -t upload`, `pio device monitor`). Replaced by `idf.py flash monitor`. |
| Unlocks every other ESP-IDF managed component (esp_camera, esp_audio_pipeline, etc.). | New testing workflow — we wrote a bunch of Python-driven tests around pio + serial; those need to be re-pointed at `idf.py`-built binaries. (Most tests are server-side and unaffected.) |
| Enables Branch 7 (direct peer mode) which needs real WebRTC. | |

### Path B — Skip "real WebRTC", use Opus-over-WebSocket

**What it means**: Add `libopus` to the firmware (small C library, no
IDF-component-manager deps — can be vendored as plain source or pulled
via `lib_deps`). ESP encodes captured PCM into Opus frames, sends
binary frames over the existing WSS to `/esp32-baby`. Server forwards
to browser via existing Socket.IO `esp32-audio` event. Browser decodes
with the well-supported `opus-decoder` WASM library (`@webmscore/opus-decoder` or similar).

| Pros | Cons |
|---|---|
| Days, not weeks. Keeps current PIO toolchain. | Not actually WebRTC — no SRTP encryption (just TLS at the WSS layer), no ICE. |
| ~10× bandwidth reduction. Audio quality preserved or improved (Opus is good). | **Branch 7 (direct peer, no server) is not achievable from this path**. Would still need Path A later if we want it. |
| Reversible: if we later go to Path A, the Opus encoder code carries over (libopus is what esp-webrtc uses internally anyway). | The server now does codec-aware audio forwarding rather than transparent PCM blob forwarding. |
| | Latency probably comparable to current WSS (still TCP), not the UDP-low-latency promise of real WebRTC. |

## My recommendation

**Path A**, with eyes open about the 1–2 day toolchain cost. Rationale:

- The user's original choice for Branch 5 explicitly listed "P2P UDP,
  encrypted, future-proof for Branch 7" — Path B sacrifices all
  three. We'd be doing the work and not getting the strategic
  benefits the user wanted.
- The refactor cost is one-time. Once done, Branches 6 (Flutter
  companion app) and 7 (direct peer) become straightforward —
  they need real WebRTC anyway.
- All the existing firmware code carries forward; we're swapping
  the build harness, not the application logic.

If the user is short on time, Path B as a "good enough for now"
stopgap is reasonable — but it's a one-way street if we want to
extend later.

## What this commit contains

- This document.
- `platformio.ini` reverted to pre-spike state (no `custom_component_add`).
- No new dependencies pulled.
- No source code changes.

Branches downstream of this point branch from a clean, working
state — they don't depend on this spike's failed experiments.
