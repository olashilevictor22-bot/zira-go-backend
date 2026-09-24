// zira_go_support_chat_routes.js
// Real-time support chat between students/drivers and the admin desk.
//
//  - One continuous conversation thread per user (WhatsApp-style).
//  - Messages are stored in support_messages; the thread summary lives in
//    support_conversations.
//  - Live delivery uses Server-Sent Events (plain HTTP, works behind Nginx +
//    Cloudflare with no extra config — we send X-Accel-Buffering: no). Clients
//    also catch up with ?after=<id> after any reconnect, so nothing is lost.
//  - The stream hub is in-memory, so it assumes ONE Node process (PM2 fork
//    mode, which is how ZiraGo runs today). If you ever move to PM2 cluster
//    mode, swap `emitToUser`/`emitToAdmins` for Postgres LISTEN/NOTIFY or Redis.

const express = require('express');
const rateLimit = require('express-rate-limit');
const { requireAuth, requireRole } = require('./zira_go_auth_routes');
const { notify } = require('./zira_go_notification_routes');

const MAX_BODY = 2000;
const CATEGORIES = new Set(['ride', 'wallet', 'account', 'other', 'general']);

// ------------------------------------------------------------------
// Schema (additive + idempotent) and one-time import of old tickets
// ------------------------------------------------------------------
(async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS support_tickets (
                id BIGSERIAL PRIMARY KEY,
                student_id BIGINT REFERENCES students(id),
                user_name TEXT,
                contact_info TEXT NOT NULL,
                user_role TEXT DEFAULT 'student',
                category TEXT DEFAULT 'general',
                message TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'open',
                admin_reply TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
            );
            ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS student_id BIGINT REFERENCES students(id);
            ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS migrated_to_chat BOOLEAN NOT NULL DEFAULT false;

            CREATE TABLE IF NOT EXISTS support_conversations (
                id BIGSERIAL PRIMARY KEY,
                user_role TEXT NOT NULL CHECK (user_role IN ('student', 'driver')),
                user_id BIGINT NOT NULL,
                user_name TEXT,
                user_ref TEXT,
                contact_info TEXT,
                category TEXT NOT NULL DEFAULT 'general',
                status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
                last_message_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                last_message_preview TEXT,
                user_unread INTEGER NOT NULL DEFAULT 0,
                admin_unread INTEGER NOT NULL DEFAULT 0,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                UNIQUE (user_role, user_id)
            );
            CREATE INDEX IF NOT EXISTS idx_support_conv_last ON support_conversations (last_message_at DESC);

            CREATE TABLE IF NOT EXISTS support_messages (
                id BIGSERIAL PRIMARY KEY,
                conversation_id BIGINT NOT NULL REFERENCES support_conversations(id) ON DELETE CASCADE,
                sender TEXT NOT NULL CHECK (sender IN ('user', 'admin', 'system')),
                body TEXT NOT NULL,
                read_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            );
            CREATE INDEX IF NOT EXISTS idx_support_msg_conv ON support_messages (conversation_id, id);
        `);
        await migrateLegacyTickets();
    } catch (err) {
        console.warn('[Support chat schema]', err.message);
    }
})();

// Old single-reply tickets become messages in the student's thread, so no
// history is lost. Tickets with no student_id (anonymous) stay in the old table.
async function migrateLegacyTickets() {
    const tickets = await pool.query(
        `SELECT t.*, s.full_name, s.reg_no, s.email
         FROM support_tickets t JOIN students s ON s.id = t.student_id
         WHERE t.migrated_to_chat = false AND t.student_id IS NOT NULL
         ORDER BY t.created_at ASC`
    );
    for (const t of tickets.rows) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const conv = await client.query(
                `INSERT INTO support_conversations (user_role, user_id, user_name, user_ref, contact_info, category, status, created_at)
                 VALUES ('student', $1, $2, $3, $4, $5, 'open', $6)
                 ON CONFLICT (user_role, user_id) DO UPDATE SET user_name = EXCLUDED.user_name
                 RETURNING id`,
                [t.student_id, t.full_name || t.user_name, t.reg_no || t.email, t.contact_info, t.category || 'general', t.created_at]
            );
            const convId = conv.rows[0].id;
            await client.query(
                `INSERT INTO support_messages (conversation_id, sender, body, created_at, read_at) VALUES ($1, 'user', $2, $3, $3)`,
                [convId, t.message, t.created_at]
            );
            let lastAt = t.created_at, preview = t.message;
            if (t.admin_reply) {
                await client.query(
                    `INSERT INTO support_messages (conversation_id, sender, body, created_at, read_at) VALUES ($1, 'admin', $2, $3, $3)`,
                    [convId, t.admin_reply, t.updated_at]
                );
                lastAt = t.updated_at; preview = t.admin_reply;
            }
            await client.query(
                `UPDATE support_conversations
                 SET last_message_at = GREATEST(last_message_at, $2), last_message_preview = LEFT($3, 140),
                     status = $4
                 WHERE id = $1`,
                [convId, lastAt, preview, t.status === 'resolved' ? 'resolved' : 'open']
            );
            await client.query('UPDATE support_tickets SET migrated_to_chat = true WHERE id = $1', [t.id]);
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK');
            console.warn('[Support chat migrate]', t.id, err.message);
        } finally { client.release(); }
    }
}

// ------------------------------------------------------------------
// Live stream hub
// ------------------------------------------------------------------
const userStreams = new Map();   // "student:12" -> Set<res>
const adminStreams = new Set();  // Set<res>
const MAX_STREAMS_PER_USER = 5;

const userKey = (role, id) => `${role}:${id}`;
function writeEvent(res, event, data) {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (_) { /* socket closed */ }
}
function emitToUser(role, id, event, data) {
    const set = userStreams.get(userKey(role, id));
    if (set) for (const res of set) writeEvent(res, event, data);
}
function emitToAdmins(event, data) {
    for (const res of adminStreams) writeEvent(res, event, data);
}
function userIsOnline(role, id) {
    const set = userStreams.get(userKey(role, id));
    return Boolean(set && set.size);
}

function openStream(req, res, { onOpen, register, unregister }) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'   // stop Nginx buffering this response
    });
    res.write('retry: 3000\n\n');
    register(res);
    if (onOpen) Promise.resolve(onOpen(res)).catch(() => {});
    // Cloudflare closes idle connections after ~100s; a comment every 20s keeps it open.
    const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 20000);
    req.on('close', () => { clearInterval(heartbeat); unregister(res); });
}

// ------------------------------------------------------------------
// Shapes + helpers
// ------------------------------------------------------------------
const shapeMessage = (m, clientId) => ({
    id: Number(m.id),
    conversationId: Number(m.conversation_id),
    sender: m.sender,
    body: m.body,
    createdAt: m.created_at,
    readAt: m.read_at,
    ...(clientId ? { clientId } : {})
});
const shapeConversation = c => ({
    id: Number(c.id),
    userRole: c.user_role,
    userId: Number(c.user_id),
    name: c.user_name || 'User',
    ref: c.user_ref || '',
    contact: c.contact_info || '',
    category: c.category,
    status: c.status,
    preview: c.last_message_preview || '',
    lastMessageAt: c.last_message_at,
    userUnread: c.user_unread,
    adminUnread: c.admin_unread
});
const cleanBody = value => String(value == null ? '' : value).replace(/\r\n/g, '\n').trim().slice(0, MAX_BODY);

async function lookupUser(role, id) {
    const table = role === 'student' ? 'students' : 'drivers';
    const cols = role === 'student' ? 'full_name, reg_no AS ref, email' : 'full_name, email AS ref, email';
    const r = await pool.query(`SELECT ${cols} FROM ${table} WHERE id = $1`, [id]);
    return r.rows[0] || {};
}

async function ensureConversation(client, auth, category) {
    const existing = await client.query(
        'SELECT * FROM support_conversations WHERE user_role = $1 AND user_id = $2 FOR UPDATE',
        [auth.role, auth.id]
    );
    if (existing.rows.length) return existing.rows[0];
    const u = await lookupUser(auth.role, auth.id);
    const created = await client.query(
        `INSERT INTO support_conversations (user_role, user_id, user_name, user_ref, contact_info, category)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (user_role, user_id) DO UPDATE SET user_name = support_conversations.user_name
         RETURNING *`,
        [auth.role, auth.id, u.full_name || (auth.role === 'student' ? 'Student' : 'Driver'), u.ref || '', u.email || '', category]
    );
    return created.rows[0];
}

async function adminUnreadTotal() {
    const r = await pool.query('SELECT COALESCE(SUM(admin_unread), 0) AS n FROM support_conversations');
    return Number(r.rows[0].n);
}

const perUser = (limit, windowMs = 60 * 1000) => rateLimit({
    windowMs, limit, standardHeaders: true, legacyHeaders: false,
    keyGenerator: req => `support:${req.auth.role}:${req.auth.id}`,
    message: { error: 'slow_down', message: 'You are sending messages too quickly. Please wait a moment.' }
});
const sendLimiter = perUser(30);
const typingLimiter = perUser(60);

// ==================================================================
// USER (student / driver) router — mounted at /api/support/chat
// ==================================================================
const userRouter = express.Router();
userRouter.use(requireAuth, (req, res, next) => {
    if (!['student', 'driver'].includes(req.auth.role)) return res.status(403).json({ error: 'wrong_role' });
    next();
});

// Current thread + recent messages
userRouter.get('/', async (req, res) => {
    try {
        const conv = await pool.query('SELECT * FROM support_conversations WHERE user_role = $1 AND user_id = $2', [req.auth.role, req.auth.id]);
        if (!conv.rows.length) return res.json({ conversation: null, messages: [] });
        const msgs = await pool.query(
            `SELECT * FROM (SELECT * FROM support_messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT 200) m ORDER BY id ASC`,
            [conv.rows[0].id]
        );
        res.json({ conversation: shapeConversation(conv.rows[0]), messages: msgs.rows.map(m => shapeMessage(m)) });
    } catch (err) {
        console.error('[Support chat load]', err.message);
        res.status(500).json({ error: 'support_unavailable' });
    }
});

// Catch-up after a reconnect
userRouter.get('/messages', async (req, res) => {
    try {
        const after = Number.parseInt(req.query.after, 10) || 0;
        const conv = await pool.query('SELECT * FROM support_conversations WHERE user_role = $1 AND user_id = $2', [req.auth.role, req.auth.id]);
        if (!conv.rows.length) return res.json({ conversation: null, messages: [] });
        const msgs = await pool.query(
            'SELECT * FROM support_messages WHERE conversation_id = $1 AND id > $2 ORDER BY id ASC LIMIT 200',
            [conv.rows[0].id, after]
        );
        res.json({ conversation: shapeConversation(conv.rows[0]), messages: msgs.rows.map(m => shapeMessage(m)) });
    } catch (err) { res.status(500).json({ error: 'support_unavailable' }); }
});

userRouter.post('/messages', sendLimiter, async (req, res) => {
    const body = cleanBody(req.body?.body);
    if (!body) return res.status(400).json({ error: 'empty_message', message: 'Type a message first.' });
    const category = CATEGORIES.has(req.body?.category) ? req.body.category : 'general';
    const clientId = typeof req.body?.clientId === 'string' ? req.body.clientId.slice(0, 64) : undefined;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const conv = await ensureConversation(client, req.auth, category);
        const inserted = await client.query(
            `INSERT INTO support_messages (conversation_id, sender, body) VALUES ($1, 'user', $2) RETURNING *`,
            [conv.id, body]
        );
        // A new topic (first message, or after "resolved") takes the chosen category.
        const newCategory = (conv.status === 'resolved' || conv.last_message_preview == null) && req.body?.category ? category : conv.category;
        const updated = await client.query(
            `UPDATE support_conversations
             SET status = 'open', category = $2, last_message_at = now(), last_message_preview = LEFT($3, 140),
                 admin_unread = admin_unread + 1
             WHERE id = $1 RETURNING *`,
            [conv.id, newCategory, body]
        );
        await client.query('COMMIT');
        const message = shapeMessage(inserted.rows[0], clientId);
        const conversation = shapeConversation(updated.rows[0]);
        emitToAdmins('message', { conversation, message });
        emitToUser(req.auth.role, req.auth.id, 'message', { conversation, message });   // other tabs / devices
        res.json({ success: true, message, conversation });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[Support chat send]', err.message);
        res.status(500).json({ error: 'support_unavailable', message: 'Could not send your message. Please try again.' });
    } finally { client.release(); }
});

userRouter.post('/read', async (req, res) => {
    try {
        const conv = await pool.query('SELECT id FROM support_conversations WHERE user_role = $1 AND user_id = $2', [req.auth.role, req.auth.id]);
        if (!conv.rows.length) return res.json({ success: true });
        const id = conv.rows[0].id;
        const marked = await pool.query(
            `UPDATE support_messages SET read_at = now() WHERE conversation_id = $1 AND sender = 'admin' AND read_at IS NULL RETURNING id`,
            [id]
        );
        await pool.query('UPDATE support_conversations SET user_unread = 0 WHERE id = $1', [id]);
        if (marked.rows.length) emitToAdmins('read', { conversationId: Number(id), by: 'user', upTo: Math.max(...marked.rows.map(r => Number(r.id))) });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'support_unavailable' }); }
});

userRouter.post('/typing', typingLimiter, async (req, res) => {
    try {
        const conv = await pool.query('SELECT id FROM support_conversations WHERE user_role = $1 AND user_id = $2', [req.auth.role, req.auth.id]);
        if (conv.rows.length) emitToAdmins('typing', { conversationId: Number(conv.rows[0].id) });
        res.json({ success: true });
    } catch (_) { res.json({ success: false }); }
});

userRouter.get('/stream', (req, res) => {
    const key = userKey(req.auth.role, req.auth.id);
    openStream(req, res, {
        register: r => {
            if (!userStreams.has(key)) userStreams.set(key, new Set());
            const set = userStreams.get(key);
            set.add(r);
            while (set.size > MAX_STREAMS_PER_USER) {          // drop the oldest tab
                const oldest = set.values().next().value;
                set.delete(oldest);
                try { oldest.end(); } catch (_) {}
            }
        },
        unregister: r => {
            const set = userStreams.get(key);
            if (!set) return;
            set.delete(r);
            if (!set.size) userStreams.delete(key);
        },
        onOpen: r => writeEvent(r, 'hello', { ts: Date.now() })
    });
});

// ==================================================================
// ADMIN router — mounted at /api/admin/support-chat
// ==================================================================
const adminRouter = express.Router();
adminRouter.use(requireAuth, requireRole('admin'));

adminRouter.get('/conversations', async (req, res) => {
    try {
        const status = ['open', 'resolved'].includes(req.query.status) ? req.query.status : 'all';
        const q = String(req.query.q || '').trim();
        const like = q ? `%${q.replace(/[%_]/g, m => '\\' + m)}%` : '';
        const rows = await pool.query(
            `SELECT * FROM support_conversations
             WHERE ($1 = 'all' OR status = $1)
               AND ($2 = '' OR user_name ILIKE $2 OR user_ref ILIKE $2 OR last_message_preview ILIKE $2)
             ORDER BY last_message_at DESC LIMIT 150`,
            [status, like]
        );
        res.json({ conversations: rows.rows.map(shapeConversation), totalUnread: await adminUnreadTotal() });
    } catch (err) {
        console.error('[Support admin list]', err.message);
        res.status(500).json({ error: 'internal_error' });
    }
});

adminRouter.get('/conversations/:id/messages', async (req, res) => {
    try {
        const id = Number.parseInt(req.params.id, 10);
        const after = Number.parseInt(req.query.after, 10) || 0;
        const conv = await pool.query('SELECT * FROM support_conversations WHERE id = $1', [id]);
        if (!conv.rows.length) return res.status(404).json({ error: 'conversation_not_found' });
        const msgs = after
            ? await pool.query('SELECT * FROM support_messages WHERE conversation_id = $1 AND id > $2 ORDER BY id ASC LIMIT 200', [id, after])
            : await pool.query('SELECT * FROM (SELECT * FROM support_messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT 200) m ORDER BY id ASC', [id]);
        res.json({
            conversation: shapeConversation(conv.rows[0]),
            messages: msgs.rows.map(m => shapeMessage(m)),
            userOnline: userIsOnline(conv.rows[0].user_role, conv.rows[0].user_id)
        });
    } catch (err) { res.status(500).json({ error: 'internal_error' }); }
});

adminRouter.post('/conversations/:id/messages', sendLimiter, async (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    const body = cleanBody(req.body?.body);
    if (!body) return res.status(400).json({ error: 'empty_message', message: 'Type a reply first.' });
    const clientId = typeof req.body?.clientId === 'string' ? req.body.clientId.slice(0, 64) : undefined;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const conv = await client.query('SELECT * FROM support_conversations WHERE id = $1 FOR UPDATE', [id]);
        if (!conv.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'conversation_not_found' }); }
        const before = conv.rows[0];
        const inserted = await client.query(
            `INSERT INTO support_messages (conversation_id, sender, body) VALUES ($1, 'admin', $2) RETURNING *`,
            [id, body]
        );
        const updated = await client.query(
            `UPDATE support_conversations
             SET status = 'open', last_message_at = now(), last_message_preview = LEFT($2, 140),
                 user_unread = user_unread + 1, admin_unread = 0
             WHERE id = $1 RETURNING *`,
            [id, body]
        );
        await client.query(`UPDATE support_messages SET read_at = COALESCE(read_at, now()) WHERE conversation_id = $1 AND sender = 'user'`, [id]);
        await client.query('COMMIT');

        const message = shapeMessage(inserted.rows[0], clientId);
        const conversation = shapeConversation(updated.rows[0]);
        emitToUser(before.user_role, before.user_id, 'message', { conversation, message });
        emitToAdmins('message', { conversation, message });

        // Only bother the user's notification bell when they are not live in the chat,
        // and only for the first unread message so a burst does not spam them.
        if (!userIsOnline(before.user_role, before.user_id) && before.user_unread === 0) {
            notify({ userId: before.user_id, role: before.user_role, title: 'Reply from Zira Go support', body: body.slice(0, 200), type: 'support' })
                .catch(err => console.warn('[Support notify]', err.message));
        }
        res.json({ success: true, message, conversation });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[Support admin send]', err.message);
        res.status(500).json({ error: 'internal_error', message: 'Could not send your reply.' });
    } finally { client.release(); }
});

adminRouter.post('/conversations/:id/read', async (req, res) => {
    try {
        const id = Number.parseInt(req.params.id, 10);
        const marked = await pool.query(
            `UPDATE support_messages SET read_at = now() WHERE conversation_id = $1 AND sender = 'user' AND read_at IS NULL RETURNING id`,
            [id]
        );
        const conv = await pool.query('UPDATE support_conversations SET admin_unread = 0 WHERE id = $1 RETURNING *', [id]);
        if (!conv.rows.length) return res.status(404).json({ error: 'conversation_not_found' });
        const c = conv.rows[0];
        if (marked.rows.length) emitToUser(c.user_role, c.user_id, 'read', { conversationId: id, by: 'admin', upTo: Math.max(...marked.rows.map(r => Number(r.id))) });
        emitToAdmins('conversation', { conversation: shapeConversation(c), totalUnread: await adminUnreadTotal() });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'internal_error' }); }
});

adminRouter.post('/conversations/:id/status', async (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    const status = req.body?.status === 'resolved' ? 'resolved' : req.body?.status === 'open' ? 'open' : null;
    if (!status) return res.status(400).json({ error: 'invalid_status' });
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const updated = await client.query('UPDATE support_conversations SET status = $2 WHERE id = $1 RETURNING *', [id, status]);
        if (!updated.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'conversation_not_found' }); }
        const text = status === 'resolved'
            ? 'This conversation was marked as resolved. Send a message any time to reopen it.'
            : 'This conversation was reopened.';
        const sys = await client.query(
            `INSERT INTO support_messages (conversation_id, sender, body) VALUES ($1, 'system', $2) RETURNING *`,
            [id, text]
        );
        await client.query('COMMIT');
        const c = updated.rows[0];
        const payload = { conversation: shapeConversation(c), message: shapeMessage(sys.rows[0]) };
        emitToUser(c.user_role, c.user_id, 'message', payload);
        emitToAdmins('message', payload);
        res.json({ success: true, conversation: payload.conversation });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        res.status(500).json({ error: 'internal_error' });
    } finally { client.release(); }
});

adminRouter.post('/conversations/:id/typing', typingLimiter, async (req, res) => {
    try {
        const id = Number.parseInt(req.params.id, 10);
        const conv = await pool.query('SELECT user_role, user_id FROM support_conversations WHERE id = $1', [id]);
        if (conv.rows.length) emitToUser(conv.rows[0].user_role, conv.rows[0].user_id, 'typing', { conversationId: id });
        res.json({ success: true });
    } catch (_) { res.json({ success: false }); }
});

adminRouter.get('/stream', (req, res) => {
    openStream(req, res, {
        register: r => adminStreams.add(r),
        unregister: r => adminStreams.delete(r),
        onOpen: async r => writeEvent(r, 'hello', { ts: Date.now(), totalUnread: await adminUnreadTotal() })
    });
});

module.exports = { userRouter, adminRouter };
