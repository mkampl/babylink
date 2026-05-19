#!/usr/bin/env python3
"""
CLI BLE provisioning tool for BabyLink ESP32 devices.

Multi-profile model:

  set --wifi   SSID:PASS                       (repeat for multiple networks)
      --server LABEL:HOST:PORT:ROOMID          (repeat for multiple BabyLink instances)
      --active INDEX                           (which server profile to use; default 0)
      --name   DEVICE_NAME

  scan                                         (ask the device to scan WiFi
                                                and print the list)

Reads existing config from the device first so partial updates (e.g.
just adding a new WiFi) work without retyping everything. Use --replace
to discard existing config instead.

GATT (service UUID bab71111-0002-...):
  config (R/W JSON)         — full cfg_v2 blob
  scan   (W "scan", R [])   — trigger + read WiFi scan results
  command (W "apply")       — persist + reboot
"""

import argparse
import asyncio
import json
import sys

from bleak import BleakClient, BleakScanner

SERVICE_UUID = "bab71111-0002-1000-8000-00805f9b34fb"
CHAR_CONFIG = "bab71111-0002-1001-8000-00805f9b34fb"
CHAR_SCAN = "bab71111-0002-1002-8000-00805f9b34fb"
CHAR_COMMAND = "bab71111-0002-1003-8000-00805f9b34fb"


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
    # SSID can contain colons in theory; split only on the FIRST colon.
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


async def run_set(args):
    device = await find_device(args.name_prefix, args.scan_timeout)
    if device is None:
        return 1

    print(f"[*] Connecting to {device.address} …")
    async with BleakClient(device) as client:
        services = client.services
        if not any(s.uuid.lower() == SERVICE_UUID for s in services):
            print("[!] Device does not expose the BabyLink provisioning service.")
            print("    (Did you flash the new firmware? Old UUIDs are not compatible.)")
            return 2

        cfg = {"wifi": [], "servers": [], "activeServer": 0, "deviceName": ""}
        if not args.replace:
            try:
                raw = await client.read_gatt_char(CHAR_CONFIG)
                existing = json.loads(raw.decode("utf-8")) if raw else {}
                for k in cfg:
                    cfg[k] = existing.get(k, cfg[k])
                print(f"[*] Loaded existing config: "
                      f"{len(cfg['wifi'])} WiFi, {len(cfg['servers'])} servers")
            except Exception as e:
                print(f"    (no existing config to merge: {e})")

        for w in args.wifi or []:
            entry = parse_wifi(w)
            for i, existing in enumerate(cfg["wifi"]):
                if existing.get("ssid") == entry["ssid"]:
                    cfg["wifi"][i] = entry
                    break
            else:
                cfg["wifi"].append(entry)

        for s in args.server or []:
            entry = parse_server(s)
            for i, existing in enumerate(cfg["servers"]):
                if existing.get("label") == entry["label"]:
                    cfg["servers"][i] = entry
                    break
            else:
                cfg["servers"].append(entry)

        if args.active is not None:
            cfg["activeServer"] = args.active
        if args.device_name:
            cfg["deviceName"] = args.device_name

        if not cfg["wifi"] or not cfg["servers"]:
            print("[!] Need at least one WiFi profile and one server profile.")
            return 2

        blob = json.dumps(cfg)
        print(f"[*] Writing config ({len(blob)} bytes)")
        print(f"    WiFi:    {[w['ssid'] for w in cfg['wifi']]}")
        print(f"    Servers: {[s['label']+'@'+s['host']+':'+str(s['port']) for s in cfg['servers']]}")
        print(f"    Active:  {cfg['activeServer']}")
        print(f"    Device:  {cfg['deviceName']!r}")
        await client.write_gatt_char(CHAR_CONFIG, blob.encode("utf-8"), response=True)

        print(f"[*] Sending 'apply' (device will reboot)")
        try:
            await client.write_gatt_char(CHAR_COMMAND, b"apply", response=True)
        except Exception as e:
            print(f"    (link dropped during reboot, as expected: {e})")

    print()
    print("[OK] Provisioning sent. ESP32 should reboot and join the active server.")
    return 0


async def run_scan(args):
    device = await find_device(args.name_prefix, args.scan_timeout)
    if device is None:
        return 1
    print(f"[*] Connecting to {device.address} …")
    async with BleakClient(device) as client:
        await client.write_gatt_char(CHAR_SCAN, b"scan", response=True)
        await asyncio.sleep(4)
        raw = await client.read_gatt_char(CHAR_SCAN)
        nets = json.loads(raw.decode("utf-8") or "[]")
        nets.sort(key=lambda n: n.get("rssi", -100), reverse=True)
        print(f"[+] {len(nets)} networks found:")
        for n in nets:
            sec = "secured" if n.get("secure") else "open"
            print(f"    {n['rssi']:4d} dBm  {sec:8s}  {n['ssid']}")
    return 0


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--name-prefix", default="BabyLink-",
                   help="BLE name prefix to scan for (default 'BabyLink-')")
    p.add_argument("--scan-timeout", type=float, default=15.0,
                   help="BLE scan timeout in seconds")

    sub = p.add_subparsers(dest="cmd", required=True)

    pset = sub.add_parser("set", help="Write/merge profiles and apply")
    pset.add_argument("--wifi", action="append",
                      help="WiFi profile as SSID:PASS (repeat for multiple)")
    pset.add_argument("--server", action="append",
                      help="Server profile as LABEL:HOST:PORT:ROOMID (repeat)")
    pset.add_argument("--active", type=int,
                      help="Index of active server profile (default 0)")
    pset.add_argument("--name", dest="device_name",
                      help="Friendly device name")
    pset.add_argument("--replace", action="store_true",
                      help="Discard existing on-device config instead of merging")

    sub.add_parser("scan", help="Ask device to scan WiFi and print results")

    args = p.parse_args()

    if args.cmd == "scan":
        sys.exit(asyncio.run(run_scan(args)))
    else:
        sys.exit(asyncio.run(run_set(args)))


if __name__ == "__main__":
    main()
