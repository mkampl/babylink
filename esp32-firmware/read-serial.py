#!/usr/bin/env python3
import serial
import time
import sys

try:
    ser = serial.Serial('/dev/ttyUSB0', 115200, timeout=1)
    print("Connected to /dev/ttyUSB0 at 115200 baud")
    print("Reading for 15 seconds...")
    print("-" * 60)

    start_time = time.time()
    while time.time() - start_time < 15:
        if ser.in_waiting > 0:
            try:
                line = ser.readline().decode('utf-8', errors='replace').strip()
                if line:
                    print(line)
            except Exception as e:
                print(f"Error reading line: {e}")
        time.sleep(0.01)

    ser.close()
    print("-" * 60)
    print("Done")

except Exception as e:
    print(f"Error: {e}")
    sys.exit(1)
