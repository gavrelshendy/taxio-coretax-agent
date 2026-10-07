/* Coretax Agent - shared logging.
   Same on-disk trace as the original coretax-helper (helper.log next to the exe), plus a
   subscriber list so the GUI (gui/server.js) can stream every line live over SSE without
   stealing the single _onProgress slot the old console-only helper used for its watchdog -
   multiple independent listeners (GUI broadcast, a run's own idle-watchdog) can subscribe
   at once here. */
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const runContext = require('./run-context');

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
    // Beberapa sesi bisa berjalan bersamaan (lib/runcontrol.js): baris dari sebuah proses diberi
    // label kode entitasnya, mis. "[HBI] ...", dan event ke dashboard membawa kunci sesinya
    // supaya log bisa disaring per sesi.
    const run = runContext.current();
    const tagged = run && run.tag ? '[' + run.tag + '] ' + msg : String(msg);
    const line = '[' + new Date().toISOString() + '] ' + tagged;
    console.log(line);
    try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (e) { /* ignore */ }
    const session = run ? run.key : null;
    for (const fn of subscribers.slice()) {
        try { fn({ line, msg: tagged, session, tag: run ? run.tag : '', runId: runId || null, ts: Date.now() }); } catch (e) { /* ignore */ }
    }
}

/* Notifications live inside the Coretax Agent window, not in separate Windows message boxes
 * (user request 2026-09-25: every kind of notice - success, warning, error). A notice is logged,
 * kept until the window has shown it, and pushed to the window over the same /events stream as
 * the log. */
const notices = [];
let noticeSeq = 0;
function showPopup(msg, title, icon) {
    const level = /error/i.test(String(icon || '')) ? 'error' : /warn/i.test(String(icon || '')) ? 'warning' : 'info';
    const notice = { id: ++noticeSeq, msg: String(msg), title: title || 'Taxio Pilot', level, ts: Date.now(), seen: false };
    notices.push(notice);
    if (notices.length > 50) notices.shift();
    const line = '[' + new Date(notice.ts).toISOString() + '] [' + (level === 'error' ? 'GALAT' : level === 'warning' ? 'PERINGATAN' : 'INFO') + '] ' + notice.msg.replace(/\s*\n\s*/g, ' ');
    console.log(line);
    try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (e) { /* ignore */ }
    for (const fn of subscribers.slice()) {
        try { fn({ line, msg: notice.msg, notice, ts: notice.ts }); } catch (e) { /* ignore */ }
    }
}
function showErrorPopup(msg) { showPopup(msg, 'Taxio Pilot Error', 'Error'); }
/** Notices the window has not acknowledged yet (replayed when it connects). */
function pendingNotices() { return notices.filter((n) => !n.seen); }
function ackNotice(id) { for (const n of notices) if (id === 'all' || n.id === +id) n.seen = true; }
/** Only for failures before the window exists (the dashboard could not start): a real message box. */
function showNativePopup(msg, title, icon) {
    const cleanMsg = String(msg).replace(/'/g, "''").replace(/"/g, '\\"');
    const psCommand = `Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('${cleanMsg}', '${title || 'Taxio Pilot'}', 'OK', '${icon || 'Error'}')`;
    exec(`powershell -NoProfile -Command "${psCommand}"`, { windowsHide: true });
}

module.exports = { log, onLogLine, showPopup, showErrorPopup, showNativePopup, pendingNotices, ackNotice, APP_DIR, LOG_FILE };
