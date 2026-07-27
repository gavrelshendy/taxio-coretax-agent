/* Persists Supabase Auth sessions across restarts, using a Node-compatible custom storage
   adapter (there's no browser localStorage here) - a single JSON file under the user's home
   directory, not next to the exe, so replacing/moving the exe on an update never loses the
   saved connection(s).

   supabase-js namespaces each project's session under its own derived key (based on the
   project ref in the URL), so Taxio (Grup) and Taxio.me sessions safely coexist in the SAME
   file - which is exactly what lets a user stay connected to BOTH at once, no "pick one"
   restriction. */
const path = require('path');
const os = require('os');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const PROJECTS = require('./supabase-projects');
const { log } = require('./log');

const STORE_DIR = path.join(os.homedir(), '.coretax-agent');
const STORE_FILE = path.join(STORE_DIR, 'session.json');

function _loadAll() {
    try { return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')) || {}; }
    catch (e) { return {}; }
}
function _saveAll(obj) {
    try {
        // This file holds Supabase access + refresh tokens (long-lived account access), so keep
        // it owner-only. mode 0o700/0o600 is honored on POSIX; on Windows it's a no-op (the
        // per-user profile dir already restricts it), so this hardens the Linux/Mac case without
        // regressing Windows.
        fs.mkdirSync(STORE_DIR, { recursive: true, mode: 0o700 });
        fs.writeFileSync(STORE_FILE, JSON.stringify(obj, null, 2), { mode: 0o600 });
        try { fs.chmodSync(STORE_FILE, 0o600); } catch (e) { /* Windows / already-restricted */ }
    } catch (e) {
        log('Gagal menyimpan sesi lokal: ' + e.message);
    }
}

/** supabase-js `auth.storage` adapter backed by the shared JSON file above. */
class FileSessionStorage {
    async getItem(key) { return _loadAll()[key] ?? null; }
    async setItem(key, value) { const all = _loadAll(); all[key] = value; _saveAll(all); }
    async removeItem(key) { const all = _loadAll(); delete all[key]; _saveAll(all); }
}

function _clientFor(projectId) {
    const project = PROJECTS[projectId];
    if (!project) throw new Error('Project Supabase tidak dikenal: ' + projectId);
    // autoRefreshToken deliberately OFF: supabase-js's background auto-refresh machinery
    // (timers/locks meant for a long-lived browser tab) is unproven in a pkg-compiled Node
    // process and was the likely cause of an early hard crash during testing. persistSession
    // still keeps the session on disk across restarts; refreshSession() is called explicitly
    // (see refreshIfNeeded below) instead of relying on a background timer.
    const client = createClient(project.url, project.anonKey, {
        auth: {
            persistSession: true,
            autoRefreshToken: false,
            detectSessionInUrl: false,
            storage: new FileSessionStorage()
        }
    });
    return { client, project };
}

/** Fresh login with email+password for ONE project - does not affect any other project's
 *  connection (see lib/state.js, which tracks each project's connection independently). */
async function connectWithPassword(projectId, email, password) {
    const { client, project } = _clientFor(projectId);
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return { client, project, session: data.session, user: data.user };
}

/** Connects using an access token the caller ALREADY has (from an already-logged-in Taxio/
 *  Taxio.me web session) instead of an interactive email+password prompt - the taxio-coretax://
 *  deep-link integration's whole point: clicking a button in Taxio should feel like the legacy
 *  coretax-helper tool, not require a separate manual "connect" step in this app.
 *
 *  Mirrors coretax-helper/run.js's own proven pattern EXACTLY: create a plain client with the
 *  project's anon key, then attach `Authorization: Bearer <token>` as a global header rather
 *  than calling `auth.setSession()` - the deep link only ever carries an access_token (no
 *  refresh_token), and setSession() needs both to behave correctly. A raw bearer header is
 *  simpler and is all RLS/RPC calls need to authenticate as that user for this one run;
 *  `persistSession: false` because a fresh token arrives with every single deep-link click, so
 *  there is nothing worth persisting across restarts (unlike the password-login path above). */
async function connectWithToken(sbUrl, sbAnonKey, token) {
    const matched = Object.values(PROJECTS).find((p) => p.url === sbUrl);
    const project = matched || { id: 'deeplink', label: 'Taxio (via link)', url: sbUrl, anonKey: sbAnonKey };
    const client = createClient(project.url, sbAnonKey || project.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { headers: { Authorization: 'Bearer ' + token } }
    });
    const { data, error } = await client.auth.getUser(token);
    if (error || !data || !data.user) throw new Error('Token sesi tidak valid atau kedaluwarsa: ' + (error ? error.message : 'unknown'));
    return { client, project, user: data.user };
}

/** Attempts to silently restore a previously-persisted session for ONE project. Returns null
 *  if that project was never connected, or its stored refresh token is no longer valid. */
async function restoreSession(projectId) {
    const { client, project } = _clientFor(projectId);
    const { data, error } = await client.auth.getSession();
    if (error || !data || !data.session) return null;
    return { client, project, session: data.session, user: data.session.user };
}

/** Restores every project that has a usable stored session - called once on startup so a
 *  user who was connected to both Grup and Taxio.me gets both back automatically. */
async function restoreAllSessions() {
    const out = {};
    for (const projectId of Object.keys(PROJECTS)) {
        try {
            const restored = await restoreSession(projectId);
            if (restored) out[projectId] = restored;
        } catch (e) { log('Gagal memulihkan sesi ' + PROJECTS[projectId].label + ': ' + e.message); }
    }
    return out;
}

/** Manual, explicitly-triggered token refresh (replaces supabase-js's background auto-refresh
 *  - see the comment in _clientFor). Safe to call opportunistically; swallows errors so a
 *  refresh failure never crashes a caller mid-automation-run. */
async function refreshIfNeeded(client) {
    try {
        const { data } = await client.auth.getSession();
        const session = data && data.session;
        if (!session) return;
        const expiresInMs = (session.expires_at * 1000) - Date.now();
        if (expiresInMs < 10 * 60 * 1000) { // refresh proactively inside the last 10 minutes
            await client.auth.refreshSession();
        }
    } catch (e) { log('Refresh sesi gagal (diabaikan): ' + e.message); }
}

async function disconnect(client) {
    try { if (client) await client.auth.signOut(); } catch (e) { /* ignore */ }
}

module.exports = { connectWithPassword, connectWithToken, restoreSession, restoreAllSessions, refreshIfNeeded, disconnect, STORE_FILE };
