// Branch 5.1a hello-world: prove the toolchain (idf.py + Docker +
// Arduino-as-component) works end-to-end before porting the real
// firmware. If this prints over serial after flash, the harness is
// usable for Sub-Branch 5.1b (port full main.cpp).

#include <Arduino.h>

extern "C" void app_main() {
  initArduino();
  Serial.begin(115200);
  delay(200);
  Serial.println("\n=== BabyLink XIAO ESP32-S3 (IDF skeleton, 5.1a) ===");
  Serial.println("If you can read this, Arduino-as-component works on IDF v5.5.");
  while (true) {
    Serial.println("loop tick");
    delay(2000);
  }
}
