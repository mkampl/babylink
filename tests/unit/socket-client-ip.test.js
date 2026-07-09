// Behind the deployed Caddy reverse proxy, socket.handshake.address is the
// loopback/proxy IP for EVERY client — so the per-IP socket cap acted globally
// and a room's PIN lockout locked out everyone. socketClientIp() must recover
// the real client from the X-Forwarded-For Caddy sets, and fall back to the
// direct address when there's no proxy (direct/LAN/dev).

const { socketClientIp } = require('../../server');

function sock(headers, address) {
  return { handshake: { headers: headers || {}, address } };
}

describe('socketClientIp', () => {
  it('uses X-Forwarded-For (Caddy-set) over the proxy address', () => {
    expect(socketClientIp(sock({ 'x-forwarded-for': '203.0.113.7' }, '127.0.0.1')))
      .toBe('203.0.113.7');
  });

  it('takes the left-most entry when XFF has a chain', () => {
    expect(socketClientIp(sock({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }, '127.0.0.1')))
      .toBe('203.0.113.7');
  });

  it('trims whitespace', () => {
    expect(socketClientIp(sock({ 'x-forwarded-for': '  203.0.113.7 ' }, '127.0.0.1')))
      .toBe('203.0.113.7');
  });

  it('falls back to the direct address with no proxy header (LAN/dev)', () => {
    expect(socketClientIp(sock({}, '192.168.1.50'))).toBe('192.168.1.50');
  });

  it('two different clients behind the proxy get DIFFERENT keys (the whole point)', () => {
    const a = socketClientIp(sock({ 'x-forwarded-for': '203.0.113.7' }, '127.0.0.1'));
    const b = socketClientIp(sock({ 'x-forwarded-for': '198.51.100.9' }, '127.0.0.1'));
    expect(a).not.toBe(b);
  });

  it('returns "unknown" when nothing is available', () => {
    expect(socketClientIp(sock({}, undefined))).toBe('unknown');
  });
});
