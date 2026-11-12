/* Coretax Agent - persistent "who did we last confirm login+impersonate as" tracker, PER JENDELA.
   Separate from lib/runcontrol's `coretaxAs` (which is scoped to an active download run and
   gets cleared the moment that run finishes) - this one is for the standalone "Login" button in
   the Entitas panel: the whole point of that button is letting the user log in and see it
   CONFIRMED before deciding what to download, so its result must stay visible after the login
   action itself finishes, not disappear the instant it's done.

   Sejak satu PIC boleh punya beberapa jendela (lib/runcontrol.js), catatan disimpan per jendela ("<pic>",
   "<pic>~2", ...): runcontrol memakainya untuk memilih jendela yang SUDAH mengimpersonate entitas yang diminta,
   gui/server.js prepareDividenPage untuk memeriksa kasus yang terbuka di jendela entitas itu. get() tanpa
   argumen = catatan terbaru dari jendela mana pun (bentuk lama untuk GET /api/login/status). */
const byWindow = new Map(); // kunci jendela -> { picId, window, entityId, npwp, name, at }
let last = null;

/** Login + impersonate `entity` terkonfirmasi untuk PIC `picId`. Jendelanya = jendela proses alur ini untuk PIC itu
 *  (lib/runcontrol.js windowKeyFor); di luar proses: jendela pertama PIC itu. */
function set(picId, entity) {
    let windowKey = picId;
    try { windowKey = require('./runcontrol').windowKeyFor(picId) || picId; } catch (e) { /* tanpa runcontrol */ }
    const rec = { picId, window: windowKey, entityId: entity.entity_id || '', npwp: entity.npwp || '', name: entity.entity_name || '', at: Math.max(Date.now(), last ? last.at + 1 : 0) };
    byWindow.set(windowKey, rec);
    last = rec;
    require('./ui-events').emit('login'); // dashboard memuat ulang /api/login/status segera (lib/ui-events.js)
}
/** Catatan jendela `windowKey`, atau (tanpa argumen) catatan terbaru dari jendela mana pun. */
function get(windowKey) { return windowKey === undefined ? last : (byWindow.get(windowKey) || null); }
/** Jendela PIC `picId` yang terakhir terkonfirmasi untuk entitas `entityId` (terbaru), atau null. */
function windowFor(picId, entityId) {
    let best = null;
    for (const rec of byWindow.values()) if (rec.picId === picId && (!entityId || rec.entityId === entityId) && (!best || rec.at > best.at)) best = rec;
    return best ? best.window : null;
}
/** Jendela ditutup: catatannya tidak berlaku lagi untuk pemilihan jendela (get() tanpa argumen - histori
 *  "terakhir login" di topbar - tetap seperti dulu). */
function clearWindow(windowKey) { byWindow.delete(windowKey); }
function clear() { byWindow.clear(); last = null; }

module.exports = { set, get, windowFor, clearWindow, clear };
