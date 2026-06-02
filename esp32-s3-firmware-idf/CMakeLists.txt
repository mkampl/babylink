# Top-level project CMake for the XIAO ESP32-S3 firmware (ESP-IDF version).
#
# Built via Docker against espressif/idf:v5.5.4 — see ../README.md.
# Lives in parallel to ../esp32-s3-firmware/ (PlatformIO) during the
# Branch 5.1 toolchain conversion; that parallel directory is removed
# in Sub-Branch 5.1d once this one carries the full firmware.

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
