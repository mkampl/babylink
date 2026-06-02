idf_component_register(
    SRCS "main.cpp" "log_wrap_stubs.c"
    INCLUDE_DIRS "."
    REQUIRES espressif__arduino-esp32 ArduinoJson
)

# Force the linker to keep the wrap stubs even though only a static
# data table in esp_wifi references them. Without this the .obj in
# our archive gets dropped during the initial scan because the link
# orders the table BEFORE the archive lookup, then esp_wifi's
# reference fails to resolve.
target_link_options(${COMPONENT_LIB} INTERFACE
    "SHELL:-u __wrap_esp_log_write"
    "SHELL:-u __wrap_esp_log_writev"
)

# ARDUINO_USB_CDC_ON_BOOT / ARDUINO_USB_MODE are set at the project
# level (see ../CMakeLists.txt) so they reach the Arduino component
# build too; defining them only here would NOT propagate backwards.
