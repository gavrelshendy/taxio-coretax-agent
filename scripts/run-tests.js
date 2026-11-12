#!/usr/bin/env node
/* Single offline test runner: `npm test` / `node scripts/run-tests.js [substring]`.
 *
 * Auto-discovers every scripts/test-*.js and runs each one in its own child process
 * (`node scripts/<name>.js` from the repo root), sequentially, with a per-test timeout.
 * A new scripts/test-*.js is picked up automatically - only add it to EXCLUDED below if it is
 * LIVE (needs a real Coretax session / network / a real Chrome on a CDP port) or otherwise unsafe.
 *
 * Exit code 0 = every non-excluded, non-known-failing test passed.
 *
 * Safety: none of the included tests bind the real app port 51733 or use the real data root
 * (%LOCALAPPDATA%\TaxioPilot, or the legacy %USERPROFILE%\.coretax-agent*). Tests that start the
 * dashboard server use an OS-assigned port (0), so two checkouts can run the suite at once. Every child gets its OWN temp
 * TAXIO_PILOT_DATA_DIR (removed afterwards) unless the test sets one itself, so data, logs, Chrome
 * profiles and runtime.json of any test land there - never in the real root (lib/paths.js). The one
 * exception is the bundled-Chrome binary cache: TAXIO_PILOT_CHROME_DIR points at the real one so
 * browser-based tests reuse an already-installed Chrome instead of downloading ±185 MB per test
 * (read-only use when it is installed - same as before Tahap 1). */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const paths = require('../lib/paths');

const ROOT = path.join(__dirname, '..');
const SCRIPTS = __dirname;
const DEFAULT_TIMEOUT_MS = 120000;
const TAIL_LINES = 40;

// LIVE / unsafe: never run by this runner. One-line reason each.
const EXCLUDED = {
    'test-form-zoom-live.js': 'LIVE: attaches over CDP to a real logged-in Coretax Chrome (SPT page) on 127.0.0.1:<port>',
    'test-lampiran-live.js': 'LIVE: attaches over CDP to a real logged-in Coretax Chrome on port 9741 and downloads a real lampiran',
    'test-monthly-lampiran-live.js': 'LIVE: attaches over CDP to a real Coretax Chrome on port 9741, navigates real SPT URLs from a tmp JSON'
};

// Tests that fail at baseline for a reason unrelated to the environment (stale/broken test).
// Still run and reported, but they do not fail the run. Fix the test, then remove it from here.
// (Baseline 2026-11-12, branch audit/arch-hardening.)
const KNOWN_FAILING = {
};

// Tests that need a real browser/Chrome and cannot run on a clean CI runner. Skipped only when
// process.env.CI is set. (Currently empty: GitHub's windows-latest image ships Google Chrome,
// which every browser-based offline test here can use via channel 'chrome'.)
const SKIP_IN_CI = {
};

// Per-test timeout overrides (ms) for slow-but-healthy tests.
const TIMEOUTS = {
    'test-gui-ui.js': 300000,
    'test-lampiran-export.js': 180000
};

function tail(text, n) {
    const lines = String(text).replace(/\s+$/, '').split(/\r?\n/);
    return lines.slice(-n).map((l) => '    | ' + l).join('\n');
}

function runOne(file, timeoutMs) {
    return new Promise((resolve) => {
        const started = Date.now();
        const env = Object.assign({}, process.env);
        // On CI, never download the ~185 MB bundled Chrome (lib/browser.js): use the runner's Chrome.
        if (process.env.CI && env.CORETAX_BUNDLED_CHROME === undefined) env.CORETAX_BUNDLED_CHROME = '0';
        // Isolated data root per test (see the header). Computed from lib/paths.js BEFORE overriding.
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taxio-pilot-run-'));
        if (env.TAXIO_PILOT_CHROME_DIR === undefined) env.TAXIO_PILOT_CHROME_DIR = path.join(paths.defaultRoot(), 'chrome');
        if (env.TAXIO_PILOT_DATA_DIR === undefined) env.TAXIO_PILOT_DATA_DIR = tmpRoot;
        const cleanup = () => { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) { /* still locked - temp dir */ } };
        const child = spawn(process.execPath, [path.join('scripts', file)], { cwd: ROOT, env, windowsHide: true });
        let out = '';
        const add = (d) => { out += d; if (out.length > 2e6) out = out.slice(-1e6); };
        child.stdout.on('data', add);
        child.stderr.on('data', add);
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
        child.on('close', (code, signal) => {
            clearTimeout(timer);
            cleanup();
            resolve({ code, signal, timedOut, out, ms: Date.now() - started });
        });
        child.on('error', (e) => { clearTimeout(timer); cleanup(); resolve({ code: -1, timedOut: false, out: out + '\n' + e.stack, ms: Date.now() - started }); });
    });
}

(async () => {
    const filter = process.argv[2] || '';
    const all = fs.readdirSync(SCRIPTS).filter((n) => /^test-.*\.js$/.test(n)).sort();
    const selected = all.filter((n) => n.includes(filter));
    if (!selected.length) { console.error('No scripts/test-*.js match "' + filter + '".'); process.exit(1); }

    const t0 = Date.now();
    const failed = [], knownFailed = [], skipped = [];
    let passed = 0;
    for (const file of selected) {
        if (EXCLUDED[file]) { skipped.push(file); console.log('SKIP  ' + file + '  (' + EXCLUDED[file] + ')'); continue; }
        if (process.env.CI && SKIP_IN_CI[file]) { skipped.push(file); console.log('SKIP  ' + file + '  (CI: ' + SKIP_IN_CI[file] + ')'); continue; }
        const r = await runOne(file, TIMEOUTS[file] || DEFAULT_TIMEOUT_MS);
        const secs = (r.ms / 1000).toFixed(1) + 's';
        const ok = r.code === 0 && !r.timedOut;
        if (ok) { passed++; console.log('PASS  ' + file + '  ' + secs + (KNOWN_FAILING[file] ? '  (listed in KNOWN_FAILING but passed - remove it)' : '')); continue; }
        const why = r.timedOut ? 'timeout' : 'exit ' + (r.code === null ? r.signal : r.code);
        if (KNOWN_FAILING[file]) {
            knownFailed.push(file);
            console.log('KFAIL ' + file + '  ' + secs + '  (' + why + '; known failing: ' + KNOWN_FAILING[file] + ')\n' + tail(r.out, 3));
        } else {
            failed.push(file);
            console.log('FAIL  ' + file + '  ' + secs + '  (' + why + ')\n' + tail(r.out, TAIL_LINES));
        }
    }
    const total = ((Date.now() - t0) / 1000).toFixed(1);
    console.log('\n' + passed + ' passed, ' + failed.length + ' failed, ' + knownFailed.length + ' known-failing, '
        + skipped.length + ' skipped  (' + total + 's)');
    if (failed.length) console.log('Failed: ' + failed.join(', '));
    process.exit(failed.length ? 1 : 0);
})();
