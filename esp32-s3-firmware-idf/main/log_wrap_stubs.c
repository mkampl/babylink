// Pass-through stubs for the esp_log_write / esp_log_writev wrapper
// symbols. Arduino-ESP32 v3.3.7+ provides these to redirect IDF logs
// into Arduino's Serial output; v3.3.5/3.3.6 don't, but IDF v5.5.4's
// esp_wifi component's g_wifi_osi_funcs table references them at link
// time. Pin to 3.3.6 (avoids the NimBLE BT-controller init regression
// in 3.3.7+ on the XIAO S3, issue #12357) + these stubs to satisfy
// the linker. The wrappers just forward to __real_esp_log_write /
// __real_esp_log_writev — the IDF originals exposed by ld's --wrap.

#include <stdarg.h>
#include "esp_log.h"

extern void __real_esp_log_write(esp_log_level_t level,
                                 const char *tag,
                                 const char *format, ...);

extern void __real_esp_log_writev(esp_log_level_t level,
                                  const char *tag,
                                  const char *format,
                                  va_list args);

void __wrap_esp_log_writev(esp_log_level_t level,
                           const char *tag,
                           const char *format,
                           va_list args) {
  __real_esp_log_writev(level, tag, format, args);
}

void __wrap_esp_log_write(esp_log_level_t level,
                          const char *tag,
                          const char *format, ...) {
  va_list args;
  va_start(args, format);
  __real_esp_log_writev(level, tag, format, args);
  va_end(args);
}
