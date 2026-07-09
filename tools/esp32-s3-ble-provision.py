#!/usr/bin/env python3
"""
CLI BLE provisioning tool for BabyLink XIAO ESP32-S3 devices.

Same GATT contract as the classic firmware (service UUID
bab71111-0002-1000-8000-00805f9b34fb) so the same patterns work, with
two differences:

  - device name prefix is "BabyLinkS3" (not "BabyLink") so the wizard
    can distinguish hardware generations during scan
  - read-only "device_info" characteristic at 1004 exposes model
    metadata (mic type, camera presence, fw tag)

Subcommands:

  set     write WiFi + server profiles, then 'apply'
  scan    trigger and read the device-side WiFi scan
  info    read device_info JSON
  reset   send 'wifi-reset' on the command char (clears NVS + reboots)
"""

import argparse
import asyncio
import json
import sys

from bleak import BleakClient, BleakScanner

SERVICE_UUID = "bab71111-0002-1000-8000-00805f9b34fb"
CHAR_CONFIG  = "bab71111-0002-1001-8000-00805f9b34fb"
CHAR_SCAN    = "bab71111-0002-1002-8000-00805f9b34fb"
CHAR_COMMAND = "bab71111-0002-1003-8000-00805f9b34fb"
CHAR_INFO    = "bab71111-0002-1004-8000-00805f9b34fb"

DEFAULT_NAME_PREFIX = "BabyLinkS3"


async def find_device(name_prefix: str, timeout: float):
    print(f"[*] Scanning {timeout:.0f}s for '{name_prefix}*' …")
    device = await BleakScanner.find_device_by_filter(
        lambda d, _adv: bool(d.name and d.name.startswith(name_prefix)),
        timeout=timeout,
    )
    if device is None:
        print(f"[!] No device with name prefix '{name_prefix}' found.")
        return None
    print(f"[+] Found: {device.name}  ({device.address})")
    return device


def parse_wifi(spec: str) -> dict:
    if ":" not in spec:
        return {"ssid": spec, "password": ""}
    ssid, password = spec.split(":", 1)
    return {"ssid": ssid, "password": password}


def parse_server(spec: str) -> dict:
    parts = spec.split(":", 3)
    if len(parts) != 4:
        raise ValueError(
            f"--server expects 'label:host:port:roomId', got: {spec!r}"
        )
    label, host, port, room = parts
    return {"label": label, "host": host, "port": int(port), "roomId": room}


async def connect(device):
    print(f"[*] Connecting to {device.address} …")
    client = BleakClient(device)
    await client.__aenter__()
    services = client.services
    if not any(s.uuid.lower() == SERVICE_UUID for s in services):
        print("[!] Device does not expose the BabyLink provisioning service.")
        await client.__aexit__(None, None, None)
        return None
    return client


async def run_set(args):
    device = await find_device(args.name_prefix, args.scan_timeout)
    if device is None:
        return 1
    client = await connect(device)
    if client is None:
        return 2
    # Provisioning gate: a configured device rejects config/apply writes until
    # its BLE window is opened by a physical BOOT-button tap. Warn early so the
    # writes below don't silently no-op.
    try:
        info = json.loads((await client.read_gatt_char(CHAR_INFO)).decode("utf-8") or "{}")
        if info.get("configured") and info.get("provOpen") is False:
            print("[!] Device is configured and provisioning is LOCKED.")
            print("    Tap the BOOT button on the device once (its LED blinks 3x),")
            print("    then re-run this command within 3 minutes.")
            await client.__aexit__(None, None, None)
            return 3
    except Exception:
        pass  # older firmware without the gate — proceed

    try:
        existing = json.loads(
            (await client.read_gatt_char(CHAR_CONFIG)).decode("utf-8") or "{}"
        )
    except Exception as e:
        print(f"[!] Read config failed: {e}")
        existing = {}
    print(f"[*] Existing config: {existing}")

    cfg = {} if args.replace else existing
    cfg.setdefault("wifi", [])
    cfg.setdefault("servers", [])
    if args.wifi:
        cfg["wifi"] = [parse_wifi(s) for s in args.wifi]
    if args.server:
        cfg["servers"] = [parse_server(s) for s in args.server]
    if args.active is not None:
        cfg["activeServer"] = args.active
    if args.name:
        cfg["deviceName"] = args.name

    blob = json.dumps(cfg, separators=(",", ":"))
    print(f"[*] Writing config ({len(blob)} bytes): {cfg}")
    await client.write_gatt_char(CHAR_CONFIG, blob.encode("utf-8"), response=True)
    print("[*] Sending 'apply' …")
    try:
        await client.write_gatt_char(CHAR_COMMAND, b"apply", response=True)
    except Exception as e:
        # Device reboots on apply — write may not return cleanly. That's fine.
        print(f"[*] Apply write disconnected ({e}) — expected after apply.")
    print("[+] Done. Device will reboot and join configured network.")
    try:
        await client.__aexit__(None, None, None)
    except Exception:
        pass
    return 0


async def run_scan(args):
    device = await find_device(args.name_prefix, args.scan_timeout)
    if device is None:
        return 1
    client = await connect(device)
    if client is None:
        return 2
    try:
        print("[*] Triggering WiFi scan on device …")
        await client.write_gatt_char(CHAR_SCAN, b"scan", response=True)
        await asyncio.sleep(args.wait)
        raw = await client.read_gatt_char(CHAR_SCAN)
        try:
            nets = json.loads(raw.decode("utf-8"))
        except Exception:
            print(f"[!] Bad scan payload: {raw!r}")
            return 3
        print(f"[+] {len(nets)} networks:")
        for n in sorted(nets, key=lambda x: -int(x.get("rssi", -999))):
            sec = "🔒" if n.get("secure") else "  "
            print(f"  {n.get('rssi'):>4} dBm  {sec}  {n.get('ssid')}")
    finally:
        await client.__aexit__(None, None, None)
    return 0


async def run_info(args):
    device = await find_device(args.name_prefix, args.scan_timeout)
    if device is None:
        return 1
    client = await connect(device)
    if client is None:
        return 2
    try:
        raw = await client.read_gatt_char(CHAR_INFO)
        try:
            info = json.loads(raw.decode("utf-8"))
            print(json.dumps(info, indent=2))
        except Exception:
            print(f"[!] Bad info payload: {raw!r}")
            return 3
    finally:
        await client.__aexit__(None, None, None)
    return 0


async def run_reset(args):
    device = await find_device(args.name_prefix, args.scan_timeout)
    if device is None:
        return 1
    client = await connect(device)
    if client is None:
        return 2
    try:
        print("[*] Sending 'wifi-reset' …")
        try:
            await client.write_gatt_char(CHAR_COMMAND, b"wifi-reset", response=True)
        except Exception as e:
            print(f"[*] Reset write disconnected ({e}) — expected.")
        print("[+] Done. Device cleared NVS and rebooted.")
    finally:
        try:
            await client.__aexit__(None, None, None)
        except Exception:
            pass
    return 0


def build_parser():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--name-prefix", default=DEFAULT_NAME_PREFIX,
                   help=f"BLE name prefix to match (default: {DEFAULT_NAME_PREFIX})")
    p.add_argument("--scan-timeout", type=float, default=10.0,
                   help="seconds to scan for the device (default: 10)")

    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("set", help="write config + apply")
    s.add_argument("--wifi", action="append", default=[],
                   help="SSID:PASSWORD (repeat for multiple profiles)")
    s.add_argument("--server", action="append", default=[],
                   help="label:host:port:roomId (repeat for multiple profiles)")
    s.add_argument("--active", type=int, default=None,
                   help="active server index (default: 0)")
    s.add_argument("--name", help="device display name")
    s.add_argument("--replace", action="store_true",
                   help="discard existing on-device config instead of merging")
    s.set_defaults(func=run_set)

    sc = sub.add_parser("scan", help="trigger + read WiFi scan")
    sc.add_argument("--wait", type=float, default=4.0,
                    help="seconds to wait before reading results (default: 4)")
    sc.set_defaults(func=run_scan)

    info = sub.add_parser("info", help="read device_info characteristic")
    info.set_defaults(func=run_info)

    rst = sub.add_parser("reset", help="wifi-reset (clear NVS + reboot)")
    rst.set_defaults(func=run_reset)

    return p


def main():
    args = build_parser().parse_args()
    rc = asyncio.run(args.func(args))
    sys.exit(rc)


if __name__ == "__main__":
    main()
