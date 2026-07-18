/* Coretax Agent - shared logging.
   Same on-disk trace as the original coretax-helper (helper.log next to the exe), plus a
   subscriber list so the GUI (gui/server.js) can stream every line live over SSE without
   stealing the single _onProgress slot the old console-only helper used for its watchdog -
   multiple independent listeners (GUI broadcast, a run's own idle-watchdog) can subscribe
   at once here. */
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

// __dirname inside a pkg-compiled exe resolves to a virtual snapshot path, not a writable
// location - so logs must live next to the exe itself (process.execPath), not next to main.js.
const APP_DIR = process.pkg ? path.dirname(process.execPath) : __dirname + '/..';
const LOG_FILE = path.join(APP_DIR, 'coretax-agent.log');

const subscribers = [];
/** Subscribe to every log line. Returns an unsubscribe function. */
function onLogLine(fn) {
    subscribers.push(fn);
    return () => {
        const i = subscribers.indexOf(fn);
        if (i !== -1) subscribers.splice(i, 1);
    };
}

function log(msg, runId) {
    const line = '[' + new Date().toISOString() + '] ' + msg;
    console.log(line);
    try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (e) { /* ignore */ }
    for (const fn of subscribers.slice()) {
        try { fn({ line, msg, runId: runId || null, ts: Date.now() }); } catch (e) { /* ignore */ }
    }
}

function showPopup(msg, title, icon) {
    const cleanMsg = String(msg).replace(/'/g, "''").replace(/"/g, '\"');
    const psCommand = `Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('${cleanMsg}', '${title}', 'OK', '${icon}')`;
    exec(`powershell -NoProfile -Command "${psCommand}"`, { windowsHide: true });
}
function showErrorPopup(msg) { showPopup(msg, 'Coretax Agent Error', 'Error'); }

module.exports = { log, onLogLine, showPopup, showErrorPopup, APP_DIR, LOG_FILE };
