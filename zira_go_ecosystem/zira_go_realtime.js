// zira_go_realtime.js
// General-purpose Server-Sent Events hub, so pages stop needing a manual
// refresh (or a 60s/30s setInterval poll) to see things that just happened.
// Two channels:
//   - per-user notification stream (student:id / driver:id) — used by the
//     wallet and driver panel bells.
//   - a single admin stream — used by the Operations Desk (platform change
//     timeline, broadcasts, PIN reviews) so it updates itself live instead
//     of only refreshing on tab switch / manual reload.
//
// Same trade-off as the existing support-chat stream (zira_go_support_chat_routes.js):
// in-memory, so it assumes one Node process (PM2 fork mode). If this ever
// moves to PM2 cluster mode or multiple instances, swap these for Postgres
// LISTEN/NOTIFY or Redis pub/sub — the emit* call sites below wouldn't need
// to change, only what's inside them.

const userStreams = new Map();   // "student:12" -> Set<res>
const adminStreams = new Set();  // Set<res>
const MAX_STREAMS_PER_USER = 5;

const userKey = (role, id) => `${role}:${id}`;

function writeEvent(res, event, data) {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
    catch (_) { /* socket already closed; the close handler will clean it up */ }
}

function addUserStream(role, id, res) {
    const key = userKey(role, id);
    let set = userStreams.get(key);
    if (!set) { set = new Set(); userStreams.set(key, set); }
    // Cap concurrent tabs/devices per account so a stuck client can't leak sockets forever.
    if (set.size >= MAX_STREAMS_PER_USER) { const oldest = set.values().next().value; try { oldest.end(); } catch (_) {} set.delete(oldest); }
    set.add(res);
}
function removeUserStream(role, id, res) {
    const key = userKey(role, id);
    const set = userStreams.get(key);
    if (!set) return;
    set.delete(res);
    if (!set.size) userStreams.delete(key);
}
function emitToUser(role, id, event, data) {
    const set = userStreams.get(userKey(role, id));
    if (set) for (const res of set) writeEvent(res, event, data);
}
function emitToRole(role, event, data) {
    for (const [key, set] of userStreams) {
        if (key.startsWith(`${role}:`)) for (const res of set) writeEvent(res, event, data);
    }
}

function addAdminStream(res) { adminStreams.add(res); }
function removeAdminStream(res) { adminStreams.delete(res); }
function emitToAdmins(event, data) { for (const res of adminStreams) writeEvent(res, event, data); }

// Shared connection setup: headers, initial retry hint, and the 20s
// heartbeat comment that keeps Cloudflare/Nginx from closing an "idle"
// connection (no visible data, but it resets the idle timer).
function openStream(req, res, { onOpen, register, unregister } = {}) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    res.write('retry: 3000\n\n');
    if (register) register(res);
    if (onOpen) Promise.resolve(onOpen(res)).catch(() => {});
    const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 20000);
    req.on('close', () => { clearInterval(heartbeat); if (unregister) unregister(res); });
}

module.exports = {
    openStream,
    addUserStream, removeUserStream, emitToUser, emitToRole,
    addAdminStream, removeAdminStream, emitToAdmins
};
