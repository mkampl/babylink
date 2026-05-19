#!/usr/bin/env python3
"""
CLI BLE provisioning tool for BabyLink ESP32 devices.

Mirrors the Web Bluetooth flow in views/select-role.html — scans for a
BabyLink-XXXX device, writes the WiFi/server/room characteristics, then
sends "apply" to the command characteristic so the firmware persists
config and reboots.

Usage:
    ./esp32-ble-provision.py \\
        --ssid "MyWifi" --pass "secret" \\
        --host 192.168.178.39 --port 3001 \\
        --room dddddddddddddddddddddddddddddddd \\
        [--name BabyDevice] [--scan-timeout 15]

Requires: pip install bleak
"""

import argparse
import asyncio
import sys

from bleak import BleakClient, BleakScanner

SERVICE_UUID = "bab71111-0001-1000-8000-00805f9b34fb"
CHAR_WIFI_SSID = "bab71111-0002-1000-8000-00805f9b34fb"
CHAR_WIFI_PASS = "bab71111-0003-1000-8000-00805f9b34fb"
CHAR_SERVER_HOST = "bab71111-0004-1000-8000-00805f9b34fb"
CHAR_SERVER_PORT = "bab71111-0005-1000-8000-00805f9b34fb"
CHAR_ROOM_ID = "bab71111-0006-1000-8000-00805f9b34fb"
CHAR_DEVICE_NAME = "bab71111-0007-1000-8000-00805f9b34fb"
CHAR_COMMAND = "bab71111-0008-1000-8000-00805f9b34fb"


async def find_device(name_prefix: str, timeout: float):
    print(f"[*] Scanning {timeout:.0f}s for '{name_prefix}*' …")
    device = await BleakScanner.find_device_by_filter(
        lambda d, _adv: bool(d.name and d.name.startswith(name_prefix)),
        timeout=timeout,
    )
    if device is None:
        print(f"[!] No device with name prefix '{name_prefix}' found.")
        print("    Tip: hold the ESP32 close and confirm it printed")
        print("         '[BLE] Advertising started' on the serial monitor.")
        return None
    print(f"[+] Found: {device.name}  ({device.address})")
    return device


async def provision(args):
    device = await find_device(args.name_prefix, args.scan_timeout)
    if device is None:
        return 1

    print(f"[*] Connecting to {device.address} …")
    async with BleakClient(device) as client:
        print(f"[+] Connected. Services: ", end="")
        services = client.services
        found = any(s.uuid.lower() == SERVICE_UUID for s in services)
        print("provisioning service present" if found else "MISSING provisioning service")
        if not found:
            print("[!] Device does not expose the BabyLink provisioning service.")
            return 2

        writes = [
            (CHAR_WIFI_SSID, args.ssid, "WiFi SSID"),
            (CHAR_WIFI_PASS, args.password, "WiFi password"),
            (CHAR_SERVER_HOST, args.host, "Server host"),
            (CHAR_SERVER_PORT, str(args.port), "Server port"),
            (CHAR_ROOM_ID, args.room, "Room ID"),
            (CHAR_DEVICE_NAME, args.device_name, "Device name"),
        ]
        for uuid, value, label in writes:
            print(f"[*] Writing {label}: {value!r}")
            await client.write_gatt_char(uuid, value.encode("utf-8"), response=True)

        print(f"[*] Sending 'apply' command (device will reboot) …")
        try:
            await client.write_gatt_char(CHAR_COMMAND, b"apply", response=True)
        except Exception as e:
            # ESP32 may drop the BLE link mid-restart — that's fine.
            print(f"    (link dropped during reboot, as expected: {e})")

    print()
    print("[OK] Provisioning sent. ESP32 should reboot and join the server.")
    print(f"     Verify via:  curl http://{args.host}:{args.port}/api/rooms/{args.room}/esp32/devices")
    return 0


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--ssid", required=True, help="WiFi SSID the ESP32 should join")
    p.add_argument("--pass", dest="password", required=True, help="WiFi password")
    p.add_argument("--host", required=True, help="BabyLink server host/IP (e.g. 192.168.178.39)")
    p.add_argument("--port", type=int, default=3001, help="BabyLink server port (default 3001)")
    p.add_argument("--room", required=True, help="32-char hex room ID")
    p.add_argument("--name", dest="device_name", default="BabyLink ESP32", help="Friendly device name")
    p.add_argument("--name-prefix", default="BabyLink-", help="BLE name prefix to scan for (default 'BabyLink-')")
    p.add_argument("--scan-timeout", type=float, default=15.0, help="BLE scan timeout in seconds")
    args = p.parse_args()

    if len(args.room) != 32 or any(c not in "0123456789abcdefABCDEF" for c in args.room):
        print("[!] --room must be 32 hex chars", file=sys.stderr)
        sys.exit(2)

    sys.exit(asyncio.run(provision(args)))


if __name__ == "__main__":
    main()
