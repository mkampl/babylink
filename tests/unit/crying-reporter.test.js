// The parent reports crying (RED) to the server, which sends the ntfy push.
// It used to be wired only to the WebRTC meter callback, so an ESP baby —
// whose card meter is driven by the PCM path — never triggered a push.
// CryingReporter is fed from the shared level hook every path goes through.

const fs = require('fs');
const path = require('path');
const CryingReporter = require('../../public/js/crying-reporter');

function make() {
  const sent = [];
  const r = new CryingReporter((babyId) => sent.push(babyId), 10000);
  return { r, sent };
}

describe('CryingReporter', () => {
  it('reports the first RED, then at most once per cooldown while it lasts', () => {
    const { r, sent } = make();
    r.observe('esp', 'RED', 0);
    r.observe('esp', 'RED', 100);
    r.observe('esp', 'RED', 9999);
    expect(sent).toEqual(['esp']);
    r.observe('esp', 'RED', 10001);
    expect(sent).toEqual(['esp', 'esp']);
  });

  it('a new crying episode after a calm spell reports right away', () => {
    const { r, sent } = make();
    r.observe('esp', 'RED', 0);
    r.observe('esp', 'GREEN', 1000);
    r.observe('esp', 'RED', 2000);
    expect(sent).toEqual(['esp', 'esp']);
  });

  it('tracks babies independently', () => {
    const { r, sent } = make();
    r.observe('a', 'RED', 0);
    r.observe('b', 'RED', 1);
    expect(sent).toEqual(['a', 'b']);
  });

  it('YELLOW and GREEN never report', () => {
    const { r, sent } = make();
    r.observe('a', 'YELLOW', 0);
    r.observe('a', 'GREEN', 1);
    expect(sent).toEqual([]);
  });
});

describe('wiring', () => {
  const app = fs.readFileSync(path.join(__dirname, '../../public/js/app.js'), 'utf8');
  it('the parent feeds the reporter from the shared level hook (all transports)', () => {
    const hook = app.slice(app.indexOf('multiBabyUI.onLevelObserved ='));
    const body = hook.slice(0, hook.indexOf('\n    };'));
    expect(body).toMatch(/cryingReporter\.observe\(/);
  });
  it('the WebRTC-only callback no longer emits crying itself (no double report)', () => {
    const cb = app.slice(app.indexOf('multiStreamManager.onAudioLevelUpdate ='));
    const body = cb.slice(0, cb.indexOf('\n    };'));
    expect(body).not.toMatch(/crying-detected/);
  });
  it('crying-reporter.js is loaded before app.js on the monitor page', () => {
    const html = fs.readFileSync(path.join(__dirname, '../../views/webrtc.html'), 'utf8');
    expect(html.indexOf('/js/crying-reporter.js')).toBeGreaterThan(-1);
    expect(html.indexOf('/js/crying-reporter.js')).toBeLessThan(html.indexOf('/js/app.js'));
  });
});
