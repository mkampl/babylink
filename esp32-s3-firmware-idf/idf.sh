#!/usr/bin/env bash
# Thin wrapper to run idf.py inside the Espressif ESP-IDF Docker image.
# All arguments are forwarded to idf.py. The project source directory
# is mounted read-write at /project (matches Espressif's image
# convention).
#
# Usage:
#   ./idf.sh set-target esp32s3
#   ./idf.sh build
#   ./idf.sh flash       # needs USB pass-through; see notes below
#   ./idf.sh size
#
# Flashing from inside the container requires the USB device to be
# accessible. We pass /dev/ttyACM0 in; if your device shows up under
# a different name (e.g. /dev/ttyUSB0 with a CP210x adapter), adjust.
# As a fallback, run `./idf.sh build`, then flash from the host with
# the esptool binary that the toolchain already ships in build/.

set -euo pipefail

IMAGE="${IDF_DOCKER_IMAGE:-espressif/idf:v5.5.4}"
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
USB_DEV="${IDF_USB_DEV:-/dev/ttyACM0}"

EXTRA_DEVICE_ARGS=()
if [ -e "$USB_DEV" ]; then
  EXTRA_DEVICE_ARGS=(--device "$USB_DEV":"$USB_DEV")
fi

# Use -it only when stdin is a real terminal — `idf.py monitor` needs
# the TTY, but `build` / `flash` work fine non-interactively, and `-it`
# without a TTY breaks scripts.
TTY_ARGS=()
if [ -t 0 ] && [ -t 1 ]; then
  TTY_ARGS=(-it)
fi

exec docker run --rm "${TTY_ARGS[@]}" \
  -v "$PROJECT_DIR":/project \
  -w /project \
  -e HOME=/tmp \
  "${EXTRA_DEVICE_ARGS[@]}" \
  "$IMAGE" \
  idf.py "$@"
