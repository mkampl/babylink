# Third-party components

## Vendored

### public/js/qrcode-generator.js

QR Code Generator for JavaScript
Copyright (c) 2009 Kazuhiko Arase — <http://www.d-project.com/>
Licensed under the MIT License.

Vendored directly. Generates the QR codes shown in the BLE provisioning
wizard so users can scan the room URL on another device.

## Runtime dependencies (npm)

| Package | License |
| -- | -- |
| axios | MIT |
| cors | MIT |
| dotenv | BSD-2-Clause |
| express | MIT |
| express-rate-limit | MIT |
| helmet | MIT |
| socket.io | MIT |
| winston | MIT |
| ws | MIT |

Full texts ship in each package under `node_modules/`. Licenses are current as
of the versions pinned in `package-lock.json`.

## Firmware (esp32-s3-firmware-idf/)

Built against ESP-IDF and Espressif's managed components (arduino-esp32,
esp_peer, esp-nimble, libsodium, …), pulled at build time via
`idf_component.yml` — predominantly Apache-2.0. ArduinoJson (MIT) is used for
config and signaling payloads.
