idf_component_register(
    SRCS "main.cpp"
    INCLUDE_DIRS "."
    REQUIRES espressif__arduino-esp32
)

# ARDUINO_USB_CDC_ON_BOOT / ARDUINO_USB_MODE are set at the project
# level (see ../CMakeLists.txt) so they reach the Arduino component
# build too; defining them only here would NOT propagate backwards.
