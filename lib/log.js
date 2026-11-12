/* Coretax Agent - shared logging.
   An on-disk trace (like the original coretax-helper's helper.log), plus a
   subscriber list so the GUI (gui/server.js) can stream every line live over SSE without
   stealing the single _onProgress slot the old console-only helper used for its watchdog -
   multiple independent listeners (GUI broadcast, a run's own idle-watchdog) can subscribe
   at once here. */
const path = require('path');
const fs = require('fs');
const runContext = require('./run-context');
const paths = require('./paths');

// Location comes from lib/paths.js: %LOCALAPPDATA%\TaxioPilot\logs\coretax-agent.log since Tahap 1.
// It used to sit next to the exe (process.execPath) - which silently failed whenever the exe lived
// in a read-only folder (Program Files, a network share). Old logs next to the exe are left alone.
// TAXIO_PILOT_LOG_FILE (tests) overrides the file; TAXIO_PILOT_DATA_DIR moves the whole root.
// Resolved once at load: /api/log-file, the MCP server and diagnostics all read LOG_FILE.
// The folder is created on the first write (_append), not at require time.
const LOG_FILE = paths.logFile();

/* Size-based rotation (2026-11-12 audit: the log grew without bound). Once the file passes
 * MAX_BYTES it is renamed to coretax-agent.log.1 (the previous .1 becomes .2, the previous .2 is
 * dropped) and a fresh file starts at LOG_FILE - so the path consumers read (/api/log-file, the
 * MCP server's read_log) always points at the current log. Writes stay appendFileSync on purpose:
 * the uncaughtException handler in main.js and any path that ends in process.exit() must never
 * lose the line it just logged, which an async stream can't guarantee. Rotation is best-effort:
 * if the rename fails (Windows: another process holds the file open without delete-sharing) the
 * line is still appended to the current file, and rotation is retried only after another
 * RETRY_BYTES have been written, so a locked file never costs a rename attempt per line. The
 * size is tracked in memory (one statSync on first write, then re-checked with a real stat right
 * before rotating, since another process - e.g. a second launch that forwards to the running one -
 * can append to the same file). */
const MAX_BYTES = 5 * 1024 * 1024;
const RETRY_BYTES = 256 * 1024;
const KEEP = 2;
const _state = new Map(); // file -> { size: bytes believed to be in it, nextAt: size that triggers a rotation check }

function _rotate(file) {
    for (let i = KEEP; i >= 1; i--) {
        const from = i === 1 ? file : file + '.' + (i - 1);
        const to = file + '.' + i;
        if (i === KEEP) { try { fs.rmSync(to, { force: true }); } catch (e) { /* locked - rename below overwrites or fails */ } }
        try { if (fs.existsSync(from)) fs.renameSync(from, to); }
        catch (e) { if (i === 1) throw e; /* older generations are optional */ }
    }
}

/** Appends one line to `file`, rotating first when it is over the limit. Never throws. */
function _append(file, text, limits) {
    const max = (limits && limits.maxBytes) || MAX_BYTES;
    const retry = (limits && limits.retryBytes) || RETRY_BYTES;
    let st = _state.get(file);
    try {
        if (!st) {
            st = { size: 0, nextAt: max };
            try { st.size = fs.statSync(file).size; } catch (e) { try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch (e2) { /* append below fails quietly */ } }
            _state.set(file, st);
        }
        if (st.size >= st.nextAt) {
            let real = 0;
            try { real = fs.statSync(file).size; } catch (e) { /* gone - rotated by another process */ }
            if (real >= max) {
                try { _rotate(file); st.size = 0; st.nextAt = max; }
                catch (e) { st.size = real; st.nextAt = real + retry; }
            } else { st.size = real; st.nextAt = max; }
        }
    } catch (e) { /* rotation must never block logging */ }
    try { fs.appendFileSync(file, text); if (st) st.size += Buffer.byteLength(text); } catch (e) { /* ignore */ }
}
function _resetRotationState() { _state.clear(); }

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
    _append(LOG_FILE, line + '\n');
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
    _append(LOG_FILE, line + '\n');
    for (const fn of subscribers.slice()) {
        try { fn({ line, msg: notice.msg, notice, ts: notice.ts }); } catch (e) { /* ignore */ }
    }
}
function showErrorPopup(msg) { showPopup(msg, 'Taxio Pilot Error', 'Error'); }
/** Notices the window has not acknowledged yet (replayed when it connects). */
function pendingNotices() { return notices.filter((n) => !n.seen); }
function ackNotice(id) { for (const n of notices) if (id === 'all' || n.id === +id) n.seen = true; }
// Failures before the window exists (the dashboard could not start) use a native message box:
// lib/shell.js showErrorBox (Electron dialog), called by electron/main.js.

module.exports = { log, onLogLine, showPopup, showErrorPopup, pendingNotices, ackNotice, LOG_FILE, _append, _resetRotationState, MAX_BYTES };
