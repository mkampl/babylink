// Diagnostic firmware — XIAO ESP32-S3 WiFi visibility check.
//
// Scans every 5 seconds and prints every visible BSSID with RSSI,
// channel, encryption, and MAC. Highlights the FRITZ!Box target so
// we can see at a glance whether the S3's internal antenna can hear
// the production AP, and how strong.
//
// Build & flash:
//   pio run -d esp32-s3-firmware -e wifi_scan -t upload
// View output:
//   python3 -c "import serial,sys,time; s=serial.Serial('/dev/ttyACM0',115200,timeout=1); \
//     [sys.stdout.write(s.readline().decode('utf-8','replace')) or sys.stdout.flush() for _ in iter(int,1)]"

#include <Arduino.h>
#include <WiFi.h>

static const char* TARGET_SSID = "FRITZ!Box 7590 TK";

const char* encName(wifi_auth_mode_t e) {
  switch (e) {
    case WIFI_AUTH_OPEN:            return "open";
    case WIFI_AUTH_WEP:             return "WEP";
    case WIFI_AUTH_WPA_PSK:         return "WPA";
    case WIFI_AUTH_WPA2_PSK:        return "WPA2";
    case WIFI_AUTH_WPA_WPA2_PSK:    return "WPA/2";
    case WIFI_AUTH_WPA2_ENTERPRISE: return "WPA2-E";
    case WIFI_AUTH_WPA3_PSK:        return "WPA3";
    case WIFI_AUTH_WPA2_WPA3_PSK:   return "WPA2/3";
    default:                        return "?";
  }
}

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println("\n\n=== XIAO ESP32-S3 — WiFi scanner ===");

  uint8_t mac[6];
  WiFi.macAddress(mac);
  Serial.printf("Our MAC: %02x:%02x:%02x:%02x:%02x:%02x\n",
                mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  Serial.printf("Looking for target SSID: \"%s\"\n", TARGET_SSID);
  Serial.println("Antenna note: scan uses whichever antenna the on-board");
  Serial.println("RF switch is set to (default = internal PCB).");

  WiFi.mode(WIFI_STA);
  WiFi.disconnect(true, true);
  delay(100);
}

void loop() {
  unsigned long t0 = millis();
  Serial.println("\n--- scanning ... ---");
  // scanNetworks(async=false, show_hidden=true, passive=false, max_ms_per_chan)
  int n = WiFi.scanNetworks(false, true);
  unsigned long dt = millis() - t0;

  if (n < 0) {
    Serial.printf("scan failed: %d (took %lums)\n", n, dt);
  } else if (n == 0) {
    Serial.printf("0 networks found (took %lums)\n", dt);
  } else {
    Serial.printf("%d networks (scan took %lums)\n", n, dt);
    Serial.println("    RSSI  Ch  Encryption  BSSID              SSID");
    Serial.println("    ----  --  ----------  -----------------  ----");

    // Sort indices by RSSI descending (small n, simple selection sort)
    int idx[64];
    int count = n > 64 ? 64 : n;
    for (int i = 0; i < count; i++) idx[i] = i;
    for (int i = 0; i < count - 1; i++) {
      for (int j = i + 1; j < count; j++) {
        if (WiFi.RSSI(idx[j]) > WiFi.RSSI(idx[i])) {
          int tmp = idx[i]; idx[i] = idx[j]; idx[j] = tmp;
        }
      }
    }

    for (int k = 0; k < count; k++) {
      int i = idx[k];
      String ssid = WiFi.SSID(i);
      int32_t rssi = WiFi.RSSI(i);
      int32_t ch = WiFi.channel(i);
      const char* enc = encName(WiFi.encryptionType(i));
      uint8_t* b = WiFi.BSSID(i);
      bool target = ssid == TARGET_SSID;
      Serial.printf("%s %4ddBm  %2ld  %-10s  %02x:%02x:%02x:%02x:%02x:%02x  %s%s\n",
                    target ? " ->" : "   ",
                    rssi, ch, enc,
                    b[0], b[1], b[2], b[3], b[4], b[5],
                    ssid.c_str(),
                    target ? "  <== TARGET" : "");
    }

    // Summary for target
    bool foundTarget = false;
    int32_t bestRssi = -999;
    int32_t bestCh = -1;
    for (int i = 0; i < n; i++) {
      if (WiFi.SSID(i) == TARGET_SSID) {
        foundTarget = true;
        if (WiFi.RSSI(i) > bestRssi) {
          bestRssi = WiFi.RSSI(i);
          bestCh = WiFi.channel(i);
        }
      }
    }
    if (foundTarget) {
      const char* quality =
          bestRssi >= -50 ? "excellent" :
          bestRssi >= -65 ? "good"      :
          bestRssi >= -75 ? "fair"      :
          bestRssi >= -85 ? "weak"      :
                            "very weak";
      Serial.printf("\n==> Target \"%s\" seen: best RSSI %ddBm on ch %ld (%s)\n",
                    TARGET_SSID, bestRssi, bestCh, quality);
    } else {
      Serial.printf("\n==> Target \"%s\" NOT visible from current antenna\n",
                    TARGET_SSID);
    }
  }

  WiFi.scanDelete();
  delay(5000);
}
