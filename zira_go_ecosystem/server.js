// server.js — example wiring. This is the glue file this bundle doesn't
// otherwise include: it shows how the pieces plug into ONE Express app and
// ONE shared pg Pool, the way your existing ZiraPay server.js already does.
// Merge this into your real server.js rather than running it standalone —
// you almost certainly already have session/CORS/logging middleware set up
// that should stay in place.

require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const path = require('path');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'same-origin' } }));
// The UI is sometimes hosted by a separate static server during device
// testing. Allow only the configured public app origin (and explicit extra
// origins), rather than making the money/auth API public to every website.
const allowedOrigins = new Set([
    process.env.APP_BASE_URL,
    ...(process.env.ALLOWED_ORIGINS || '').split(',')
].map(origin => origin.trim().replace(/\/$/, '')).filter(Boolean));
app.use((req, res, next) => {
    const origin = (req.get('origin') || '').replace(/\/$/, '');
    if (origin && allowedOrigins.has(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        if (req.method === 'OPTIONS') return res.sendStatus(204);
    }
    return next();
});
app.use(express.json({ limit: '100kb' }));
// Live support chat (stream, typing, catch-up) is exempt from the shared per-IP limiter —
// campus Wi-Fi puts many students behind one IP. The chat routes have their own per-user limits.
app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false, skip: req => /^\/(support\/chat|admin\/support-chat)(\/|$)/.test(req.path) }));
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false, message: { error: 'too_many_attempts', message: 'Please wait before trying again.' } });
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/auth/send-otp', authLimiter);

// One pool, shared by every route file below via the global `pool` they
// each reference.
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: (process.env.DATABASE_URL && (process.env.DATABASE_URL.includes('localhost') || process.env.DATABASE_URL.includes('127.0.0.1')))
        ? false
        : { rejectUnauthorized: false }
});
global.pool = pool;

const { router: authRouter, requireAuth, requireRole } = require('./zira_go_auth_routes');
const { router: bankRouter, adminRouter: bankAdminRouter } = require('./zira_go_bank_routes');
const telegramLinkRouter = require('./zira_go_telegram_link_routes');
const tripRoutes = require('./zira_go_trip_routes');
const fundingRouter = require('./zira_go_funding_routes');
const driverRouter = require('./zira_go_driver_routes');
const adminPortalRouter = require('./zira_go_admin_routes');
const { router: pinRouter, adminRouter: adminPinRouter } = require('./zira_go_pin_routes');
const notificationRouter = require('./zira_go_notification_routes');
const { userRouter: supportChatRouter, adminRouter: supportChatAdminRouter } = require('./zira_go_support_chat_routes');

app.use('/api/auth', authRouter);
app.use('/api/bank', bankRouter);
app.use('/api/admin/bank', bankAdminRouter);
app.use('/api/admin/support-chat', supportChatAdminRouter);
app.use('/api/support/chat', supportChatRouter);
app.use('/api/admin', adminPortalRouter);
app.use('/api/pin', pinRouter);
app.use('/api/admin/pin-requests', adminPinRouter);
app.use('/api/notifications', notificationRouter);
app.use('/api/telegram', telegramLinkRouter);
app.use('/api/trips', tripRoutes);
app.use('/api/wallet', fundingRouter);
app.use('/api/driver', driverRouter);
app.use('/hero-media', express.static(path.join(__dirname, 'uploads', 'hero-media'), { maxAge: '1h' }));
app.use('/content-media', express.static(path.join(__dirname, 'uploads', 'content-media'), { maxAge: '1h' }));

// Public Support & Live Agent Dispatch
app.post('/api/support/message', rateLimit({ windowMs: 60 * 60 * 1000, limit: 10 }), async (req, res) => {
    try {
        const { name, contact, role = 'student', category = 'general', message, studentId = null } = req.body;
        if (!contact || !message) return res.status(400).json({ error: 'Contact and message are required' });
        const result = await pool.query(
            `INSERT INTO support_tickets (student_id, user_name, contact_info, user_role, category, message)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at`,
            [Number.isInteger(Number(studentId)) ? Number(studentId) : null, name || 'Anonymous', contact, role, category, message]
        );
        res.json({ success: true, ticketId: `ZG-SUP-${result.rows[0].id}`, created_at: result.rows[0].created_at });
    } catch (e) {
        res.status(500).json({ error: 'support_unavailable' });
    }
});

// The signed-in student's own support history. This is intentionally scoped
// to their account; no contact number can be used to read another person's chat.
app.get('/api/support/my', requireAuth, requireRole('student'), async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, category, message, admin_reply, status, created_at, updated_at
             FROM support_tickets WHERE student_id=$1 ORDER BY created_at DESC LIMIT 30`,
            [req.auth.id]
        );
        res.json({ tickets: result.rows });
    } catch (_e) { res.status(500).json({ error: 'support_unavailable' }); }
});

// Public Active Broadcasts
app.get('/api/broadcasts/active', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM campus_broadcasts WHERE active = true ORDER BY created_at DESC LIMIT 5");
        res.json(result.rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Public Campus Spotlight cards & Trending-on-Campus ad banners (active only)
app.get('/api/public/content-cards', async (req, res) => {
    try {
        const rows = await pool.query(
            `SELECT * FROM content_cards WHERE active = true ORDER BY section ASC, sort_order ASC, id ASC`
        );
        const spotlight = [], ads = [];
        for (const r of rows.rows) {
            const card = {
                id: Number(r.id), imageUrl: r.image_url, badgeText: r.badge_text, title: r.title,
                description: r.description, buttonText: r.button_text, buttonUrl: r.button_url,
                buttonColor: r.button_color, accentColor: r.accent_color
            };
            (r.section === 'spotlight' ? spotlight : ads).push(card);
        }
        res.json({ spotlight, ads });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Public Dynamic Config (Fares, Gateway, Hero Banner)
app.get('/api/public/config', async (req, res) => {
    try {
        const result = await pool.query("SELECT value FROM platform_config WHERE key = 'app_settings'");
        if (result.rows.length) {
            const { korapaySecretKey, flwSecretKey, ...publicConfig } = result.rows[0].value;
            return res.json(publicConfig);
        }
        res.json({
            driverFare: 250,
            platformFee: 10,
            activeGateway: 'korapay',
            heroTitle: 'Campus Life, Made Easier.',
            heroTagline: 'Landmark University',
            heroDesc: 'Instant 30-min campus transit codes, errand runner dispatches, and student wallet.',
            heroBannerImage: 'landmark_campus_banner.jpg'
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Serve the static HTML apps in this bundle directly, if you want a single
// process for the demo. In production these usually live behind Nginx
// instead — see README "Deploying" section.
app.get('/healthz', async (_req, res) => {
    try { await pool.query('SELECT 1'); res.json({ status: 'ok' }); }
    catch (_) { res.status(503).json({ status: 'unavailable' }); }
});

app.use('/uploads', (_req, res) => res.status(404).end());
app.use((req, res, next) => {
    if (req.path === '/') return next();
    const allowedStatic = /\.(html|png|jpe?g|webp|svg|ico)$/i.test(req.path);
    return allowedStatic ? next() : res.status(404).end();
});
app.use(express.static(__dirname, { dotfiles: 'deny', index: 'zira_go_login.html' }));

app.use((err, _req, res, _next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'payload_too_large' });
    console.error('[Unhandled request error]', err.message);
    return res.status(500).json({ error: 'internal_error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Zira Go backend listening on :${PORT}`));

// Start the Telegram bot in the same process. It opens its own pg Pool
// internally (see zira_go_telegram_bot.js) rather than reusing `pool` above,
// so it can also run as a fully separate process/PM2 app if you'd rather
// isolate bot uptime from API uptime.
require('./zira_go_telegram_bot');
