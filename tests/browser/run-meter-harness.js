#!/usr/bin/env node
// Drives tests/browser/meter-harness.html in a real (system) Chrome via
// playwright-core and asserts the meter fix holds end-to-end. No mic, no
// human input — the page synthesises its own audio with an OscillatorNode.
//
//   node tests/browser/run-meter-harness.js
//
// Exit 0 on pass, 1 on failure. Auto-detects a system Chrome/Chromium so it
// needs no bundled browser download.

const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');

const CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/snap/bin/chromium',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

function findChrome() {
  for (const p of CANDIDATES) {
    try { if (fs.existsSync(p)) return p; } catch (e) {}
  }
  return null;
}

async function main() {
  const executablePath = findChrome();
  if (!executablePath) {
    console.error('No system Chrome/Chromium found. Set CHROME_PATH.');
    process.exit(2);
  }
  console.log('Using browser:', executablePath);

  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: [
      '--autoplay-policy=no-user-gesture-required', // let AudioContext run
      '--no-sandbox',
    ],
  });

  try {
    const page = await browser.newPage();
    page.on('console', (m) => console.log('  [page]', m.text()));
    page.on('pageerror', (e) => console.log('  [pageerror]', e.message));

    const harness = path.join(__dirname, 'meter-harness.html');
    await page.goto('file://' + harness);

    // Inject the real production level-meter.js (same file the browser loads).
    await page.addScriptTag({
      path: path.join(__dirname, '../../public/js/level-meter.js'),
    });

    // level-meter.js is injected after navigation; start once it's defined
    // and the harness has exposed its runner.
    await page.waitForFunction(
      () => typeof window.LevelMeter === 'function' && typeof window.__run__ === 'function'
    );

    // ~7s of scripted 100ms frames; give it generous headroom.
    const res = await page.evaluate(async () => await window.__run__());

    console.log('\nResult:', JSON.stringify(res, null, 2));

    const failures = [];
    if (!res || res.error) failures.push('harness error: ' + (res && res.error));
    else {
      const { latencyMs, flicks } = res;
      // 1) Both must eventually cross RED (signal was parked just above it).
      if (latencyMs.new === null) failures.push('NEW never crossed RED');
      if (latencyMs.old === null) failures.push('OLD never crossed RED');
      // 2) The new (low-smoothing) analyser must cross the threshold much
      //    faster than the old — at most 60% of the old lag. This is the
      //    worst case (signal parked right on the boundary), the exact
      //    scenario the user hit; louder signals cross far quicker.
      if (latencyMs.new !== null && latencyMs.old !== null && !(latencyMs.new <= 0.6 * latencyMs.old))
        failures.push(`NEW latency ${latencyMs.new}ms not <= 60% of OLD ${latencyMs.old}ms`);
      // 3) New crossing must be sub-second even in this worst case.
      if (latencyMs.new !== null && latencyMs.new > 700)
        failures.push(`NEW latency ${latencyMs.new}ms exceeds 700ms worst-case budget`);
      // 4) On the identical real feed, LevelMeter must flicker far less than a
      //    naive per-frame classifier at the noisy threshold.
      if (!(flicks.meter < flicks.naive))
        failures.push(`meter flicks ${flicks.meter} not < naive ${flicks.naive}`);
      // 5) Absolute flicker of the meter should be small.
      if (flicks.meter > 4)
        failures.push(`meter flicks ${flicks.meter} exceeds 4`);
    }

    if (failures.length) {
      console.error('\nFAIL:\n - ' + failures.join('\n - '));
      process.exitCode = 1;
    } else {
      console.log('\nPASS: real-browser meter reacts fast (no lag) and is stable (no flicker).');
      console.log(`  latency  old=${res.latencyMs.old}ms  new=${res.latencyMs.new}ms  (gBoundary=${res.gBoundary})`);
      console.log(`  flicker  naive=${res.flicks.naive}  meter=${res.flicks.meter}`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
