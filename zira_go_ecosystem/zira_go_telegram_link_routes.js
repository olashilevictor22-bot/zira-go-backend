// zira_go_telegram_link_routes.js
// The web-app side of Telegram linking — generates the code zira_go_account.html
// shows, into the SAME telegram_link_codes table zira_go_telegram_bot.js reads
// from. Mount under e.g. app.use('/api/telegram', router).

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { requireAuth } = require('./zira_go_auth_routes');

const LINK_CODE_TTL_SECONDS = 600; // 10 minutes, matches zira_go_telegram_schema.sql's intent
const BOT_USERNAME = (process.env.TELEGRAM_BOT_USERNAME || 'zirago_bot').replace(/^@/, '').trim();

function hashCode(code) {
    return crypto.createHash('sha256').update(code).digest('hex');
}
function generateNumericCode(length = 6) {
    return crypto.randomInt(0, 10 ** length).toString().padStart(length, '0');
}

// POST /api/telegram/link-code
router.post('/link-code', requireAuth, async (req, res) => {
    const { id, role } = req.auth;
    if (!['student', 'driver'].includes(role)) return res.status(403).json({ error: 'wrong_role' });

    const ownerColumn = role === 'student' ? 'student_id' : 'driver_id';
    const table = role === 'student' ? 'students' : 'drivers';

    const already = await pool.query(`SELECT telegram_chat_id FROM ${table} WHERE id = $1`, [id]);
    if (already.rows[0]?.telegram_chat_id) {
        return res.status(409).json({ error: 'already_linked' });
    }

    // Expire any still-active code before issuing a new one
    await pool.query(
        `UPDATE telegram_link_codes SET status = 'expired' WHERE ${ownerColumn} = $1 AND status = 'active'`,
        [id]
    );

    const rawCode = generateNumericCode();
    const expiresAt = new Date(Date.now() + LINK_CODE_TTL_SECONDS * 1000);

    await pool.query(
        `INSERT INTO telegram_link_codes (${ownerColumn}, code_hash, expires_at) VALUES ($1, $2, $3)`,
        [id, hashCode(rawCode), expiresAt]
    );

    res.json({ code: rawCode, ttlSeconds: LINK_CODE_TTL_SECONDS, deepLink: `https://t.me/${BOT_USERNAME}?start=${rawCode}` });
});

// GET /api/telegram/status
router.get('/status', requireAuth, async (req, res) => {
    const { id, role } = req.auth;
    const table = role === 'student' ? 'students' : 'drivers';
    const result = await pool.query(`SELECT telegram_chat_id, telegram_linked_at FROM ${table} WHERE id = $1`, [id]);
    const row = result.rows[0] || {};
    res.json({ linked: !!row.telegram_chat_id, linkedAt: row.telegram_linked_at || null });
});

module.exports = router;
