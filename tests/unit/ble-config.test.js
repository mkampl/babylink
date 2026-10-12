// BLE wizard config handling against old and new firmware.
// New firmware never sends WiFi passwords back ("password":"" +
// hasPassword) and blanks the room ID while its provisioning gate is closed
// (hasRoomId). An empty password / room ID written back means "keep the
// stored one". Server profiles carry an explicit tls flag (absent on old
// firmware, which uses port 443 ⇒ TLS).

const BleConfig = require('../../public/js/ble-config');

describe('fromDevice', () => {
  it('keeps masked entries recognisable and derives tls for old profiles', () => {
    const cfg = BleConfig.fromDevice({
      wifi: [{ ssid: 'Home', password: '', hasPassword: true }, { ssid: 'Old', password: 'plain' }],
      servers: [{ host: 'h', port: 443, roomId: 'r' }, { host: 'l', port: 3001, roomId: '', hasRoomId: true, tls: false }],
      activeServer: 1,
      deviceName: 'Nursery',
    });
    expect(cfg.wifi[0]).toEqual({ ssid: 'Home', password: '', hasPassword: true });
    expect(cfg.wifi[1]).toEqual({ ssid: 'Old', password: 'plain', hasPassword: true });
    expect(cfg.servers[0].tls).toBe(true);
    expect(cfg.servers[1]).toMatchObject({ roomId: '', hasRoomId: true, tls: false });
    expect(cfg.activeServer).toBe(1);
  });

  it('tolerates an empty / garbage read', () => {
    expect(BleConfig.fromDevice(null)).toEqual({ wifi: [], servers: [], activeServer: 0, deviceName: '' });
  });
});

describe('selectServer', () => {
  const here = { host: 'babylink.example.org', port: 443, roomId: 'a'.repeat(32), tls: true };

  it('reuses a profile for this exact room', () => {
    const cfg = BleConfig.fromDevice({ servers: [{ host: 'x', port: 1, roomId: 'z' }, { ...here }] });
    BleConfig.selectServer(cfg, here);
    expect(cfg.servers).toHaveLength(2);
    expect(cfg.activeServer).toBe(1);
  });

  it('repoints a masked profile on the same server to this room instead of duplicating it', () => {
    const cfg = BleConfig.fromDevice({ servers: [{ host: here.host, port: 443, roomId: '', hasRoomId: true }] });
    BleConfig.selectServer(cfg, here);
    expect(cfg.servers).toHaveLength(1);
    expect(cfg.servers[0].roomId).toBe(here.roomId);
    expect(cfg.activeServer).toBe(0);
  });

  it('adds a profile for this room otherwise, keeping other rooms', () => {
    const cfg = BleConfig.fromDevice({ servers: [{ host: here.host, port: 443, roomId: 'b'.repeat(32) }] });
    BleConfig.selectServer(cfg, here);
    expect(cfg.servers).toHaveLength(2);
    expect(cfg.servers[0]).toMatchObject({ host: here.host, roomId: here.roomId, tls: true });
    expect(cfg.activeServer).toBe(0);
  });
});

describe('toDevice', () => {
  it('sends masked fields back empty (= keep stored) and drops UI-only flags', () => {
    const cfg = BleConfig.fromDevice({
      wifi: [{ ssid: 'Home', password: '', hasPassword: true }],
      servers: [{ host: 'h', port: 3001, roomId: '', hasRoomId: true, tls: false }],
    });
    const wire = JSON.parse(BleConfig.toDevice(cfg));
    expect(wire.wifi[0]).toEqual({ ssid: 'Home', password: '' });
    expect(wire.servers[0]).toEqual({ label: '', host: 'h', port: 3001, roomId: '', tls: false });
  });

  it('always writes an explicit tls flag', () => {
    const wire = JSON.parse(BleConfig.toDevice({ wifi: [], servers: [{ host: 'h', port: 443, roomId: 'r' }] }));
    expect(wire.servers[0].tls).toBe(true);
  });
});

describe('validation', () => {
  it('a masked room id counts as present (the device keeps it)', () => {
    const cfg = BleConfig.fromDevice({ servers: [{ host: 'h', port: 1, roomId: '', hasRoomId: true }] });
    expect(BleConfig.serverComplete(cfg.servers[0])).toBe(true);
    expect(BleConfig.serverComplete({ host: 'h', roomId: '' })).toBe(false);
  });
});
