# Top-level project CMake for the XIAO ESP32-S3 firmware (ESP-IDF).
#
# Built via Docker against espressif/idf:v5.5.4 — see ./README.md and
# ./docs/branch5-webrtc-toolchain-decision.md for the why-not-PIO
# spike outcome. Replaces the original PlatformIO firmware as of
# Sub-Branch 5.1d (Jun 2 2026).

cmake_minimum_required(VERSION 3.16)
include($ENV{IDF_PATH}/tools/cmake/project.cmake)

# These two defines need to reach the Arduino-ESP32 component's own
# sources (HWCDC.cpp gates HWCDCSerial on `#if ARDUINO_USB_MODE &&
# ARDUINO_USB_CDC_ON_BOOT`). Setting them as PUBLIC on `main`'s
# COMPONENT_LIB doesn't propagate backwards to arduino-esp32, so we
# inject them at the project level instead. Same effect as PIO's
# board_build extra_flags for seeed_xiao_esp32s3.
idf_build_set_property(COMPILE_OPTIONS
    "-DARDUINO_USB_MODE=1;-DARDUINO_USB_CDC_ON_BOOT=1"
    APPEND
)

project(babylink_xiao_s3)
