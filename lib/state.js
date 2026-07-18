/* In-memory connection state - keyed by project id ('grup' | 'personal') since the user can
 * be connected to BOTH Taxio (Grup) and Taxio.me at the same time, not just one or the other.
 * Backed on disk by lib/session-store.js (each project's session is namespaced separately by
 * supabase-js under its own storage key, so both coexist in the same session.json). */
const connections = { grup: null, personal: null }; // each: { client, project, session, user, orgId, role }

function get(projectId) { return connections[projectId] || null; }
function getAll() { return connections; }
function set(projectId, data) { connections[projectId] = data; }
function clear(projectId) { connections[projectId] = null; }
function isConnected(projectId) { return !!(connections[projectId] && connections[projectId].client && connections[projectId].session); }
function connectedProjectIds() { return Object.keys(connections).filter((id) => isConnected(id)); }

module.exports = { get, getAll, set, clear, isConnected, connectedProjectIds };
