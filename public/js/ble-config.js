// Device config handling for the BLE / Web Bluetooth setup wizard.
//
// New firmware never returns WiFi passwords ("password":"" + hasPassword)
// and blanks the room ID while its provisioning gate is closed (hasRoomId).
// Writing an empty password / room ID back means "keep what is stored", so
// a masked config can be round-tripped safely. Server profiles carry an
// explicit `tls` flag; older firmware ignores it and keeps its "port 443 ⇒
// TLS" rule, so profiles saved by it are read with that rule too.
//
// Pure (no DOM), unit-tested in tests/unit/ble-config.test.js.

(function (global) {
  'use strict';

  function tlsOf(s) {
    return typeof s.tls === 'boolean' ? s.tls : Number(s.port) === 443;
  }

  const BleConfig = {
    empty() {
      return { wifi: [], servers: [], activeServer: 0, deviceName: '' };
    },

    /** Normalise a config read from the device for the editor. */
    fromDevice(parsed) {
      if (!parsed || typeof parsed !== 'object') return this.empty();
      const wifi = (Array.isArray(parsed.wifi) ? parsed.wifi : []).map((w) => ({
        ssid: w.ssid || '',
        password: w.password || '',
        // Old firmware sends the real password; treat it as "has one" too.
        hasPassword: !!(w.hasPassword || w.password),
      }));
      const servers = (Array.isArray(parsed.servers) ? parsed.servers : []).map((s) => ({
        label: s.label || '',
        host: s.host || '',
        port: parseInt(s.port, 10) || 0,
        roomId: s.roomId || '',
        hasRoomId: !!(s.hasRoomId || s.roomId),
        tls: tlsOf(s),
      }));
      const active = parseInt(parsed.activeServer, 10) || 0;
      return {
        wifi,
        servers,
        activeServer: active < servers.length ? active : 0,
        deviceName: parsed.deviceName || '',
      };
    },

    /**
     * Make `here` ({host, port, roomId, tls}) the active server. A profile
     * for the same server whose room is this room — or is masked, i.e.
     * unknown — is repointed to this room; otherwise a new profile is added
     * in front, keeping profiles for other rooms.
     */
    selectServer(cfg, here) {
      const idx = cfg.servers.findIndex((s) =>
        s.host === here.host && (s.port || 3001) === here.port &&
        (s.roomId === here.roomId || (s.roomId === '' && s.hasRoomId)));
      if (idx >= 0) {
        cfg.servers[idx].roomId = here.roomId;
        cfg.servers[idx].hasRoomId = true;
        cfg.activeServer = idx;
      } else {
        cfg.servers.unshift({
          label: here.host, host: here.host, port: here.port,
          roomId: here.roomId, hasRoomId: true, tls: !!here.tls,
        });
        cfg.activeServer = 0;
      }
      return cfg;
    },

    /** A server row is usable: host plus a room (typed, or stored on the device). */
    serverComplete(s) {
      return !!(s && s.host && (s.roomId || (s.roomId === '' && s.hasRoomId)));
    },

    /** Serialise for the CONFIG characteristic. */
    toDevice(cfg) {
      return JSON.stringify({
        wifi: (cfg.wifi || []).map((w) => ({ ssid: w.ssid || '', password: w.password || '' })),
        servers: (cfg.servers || []).map((s) => ({
          label: s.label || '',
          host: s.host || '',
          port: parseInt(s.port, 10) || 0,
          roomId: s.roomId || '',
          tls: tlsOf(s),
        })),
        activeServer: cfg.activeServer || 0,
        deviceName: cfg.deviceName || '',
      });
    },
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = BleConfig;
  } else {
    global.BleConfig = BleConfig;
  }
})(typeof window !== 'undefined' ? window : globalThis);
