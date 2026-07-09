// The Push-Notifications UI invites users to run their OWN ntfy server, but the
// old validator hard-allowed only ntfy.sh → every self-hosted host got a 400,
// so the advertised flow never worked. It must now accept any public HTTPS host
// while still blocking SSRF to loopback/private targets.

const { validateNtfyServer } = require('../../server/notification-service');
const ALLOWED = ['ntfy.sh'];

describe('validateNtfyServer', () => {
  it('accepts the default ntfy.sh', () => {
    expect(validateNtfyServer('https://ntfy.sh', ALLOWED)).toBeNull();
  });

  it('accepts a public self-hosted HTTPS server (the regression)', () => {
    expect(validateNtfyServer('https://ntfy.example.com', ALLOWED)).toBeNull();
    expect(validateNtfyServer('https://alerts.mydomain.io', ALLOWED)).toBeNull();
  });

  it('empty → null (use default)', () => {
    expect(validateNtfyServer('', ALLOWED)).toBeNull();
    expect(validateNtfyServer(null, ALLOWED)).toBeNull();
  });

  it('rejects non-HTTPS', () => {
    expect(validateNtfyServer('http://ntfy.example.com', ALLOWED)).toMatch(/HTTPS/);
  });

  it('rejects an invalid URL', () => {
    expect(validateNtfyServer('not a url', ALLOWED)).toMatch(/Invalid/);
  });

  it('blocks SSRF: loopback / private / link-local / CGNAT', () => {
    for (const host of [
      'https://localhost',
      'https://127.0.0.1',
      'https://10.0.0.5',
      'https://192.168.1.10',
      'https://172.16.0.1',
      'https://169.254.1.1',
      'https://100.64.0.1',
      'https://ntfy.local',
      'https://[::1]',
    ]) {
      expect(validateNtfyServer(host, ALLOWED)).toMatch(/not allowed/);
    }
  });

  it('a public IP literal is allowed', () => {
    expect(validateNtfyServer('https://8.8.8.8', ALLOWED)).toBeNull();
  });
});
