/* In-memory connection state - keyed by project id ('taxio_hub')
 * Backed on disk by lib/session-store.js under storage key. */
const connections = { taxio_hub: null }; // each: { client, project, session, user, orgId, role }

function get(projectId) { return connections[projectId] || null; }
function getAll() { return connections; }
function set(projectId, data) { connections[projectId] = data; }
function clear(projectId) { connections[projectId] = null; }
function isConnected(projectId) { return !!(connections[projectId] && connections[projectId].client && connections[projectId].session); }
function connectedProjectIds() { return Object.keys(connections).filter((id) => isConnected(id)); }

module.exports = { get, getAll, set, clear, isConnected, connectedProjectIds };
