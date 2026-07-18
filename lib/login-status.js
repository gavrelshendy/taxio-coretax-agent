/* Coretax Agent - persistent "who did we last confirm login+impersonate as" tracker.
   Separate from lib/runcontrol's `coretaxAs` (which is scoped to an active download run and
   gets cleared the moment that run finishes) - this one is for the standalone "Login" button in
   the Entitas panel: the whole point of that button is letting the user log in and see it
   CONFIRMED before deciding what to download, so its result must stay visible after the login
   action itself finishes, not disappear the instant it's done. */
let last = null; // { picId, entityId, npwp, name, at }

function set(picId, entity) {
    last = { picId, entityId: entity.entity_id || '', npwp: entity.npwp || '', name: entity.entity_name || '', at: Date.now() };
}
function get() { return last; }
function clear() { last = null; }

module.exports = { set, get, clear };
