// zira_go_auth_routes.js
// Login/register for students and drivers, plus the middleware zira_go_bank_routes.js
// and zira_go_trip_routes.js should use to identify who's calling.
// Mount under e.g. app.use('/api/auth', router).
//
// Assumptions:
//   - `pool` is a pg Pool instance
//   - JWT_SECRET is set in the environment — this file throws on boot if it isn't,
//     rather than silently signing tokens with a guessable fallback
//   - students/drivers have: email, password_hash (from zira_go_auth_bank_schema.sql)

const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const router = express.Router();

if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET must be set — refusing to start with an insecure default.');
}
const JWT_SECRET = process.env.JWT_SECRET;
const TOKEN_TTL = '7d';
const BCRYPT_ROUNDS = 12;

// Same self-heal as the other two route files — drivers.trip_close_pin_hash
// is now written at registration time here too, so make sure it exists
// regardless of which module happens to load first. IF NOT EXISTS is safe
// to run from all three.
(async () => {
    try { await pool.query('ALTER TABLE drivers ADD COLUMN IF NOT EXISTS trip_close_pin_hash TEXT'); }
    catch (err) { console.warn('[Driver close PIN schema]', err.message); }
})();


function signToken(payload) {
    return jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

function normalizeLmuRegistrationNumber(value) {
    const digits = String(value || '').replace(/\D/g, '');
    if (!/^\d{7}$/.test(digits)) return null;
    return `LMU/${digits.slice(0, 2)}/${digits.slice(2)}`;
}

// ------------------------------------------------------------------
// Middleware — verifies the bearer token and attaches req.auth = { id, role }.
// role is 'student' | 'driver' | 'admin'. Use requireRole('driver') etc. to
// lock a route to one side.
// ------------------------------------------------------------------
function requireAuth(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'missing_token' });

    try {
        req.auth = jwt.verify(token, JWT_SECRET);
        return next();
    } catch (err) {
        return res.status(401).json({ error: 'invalid_or_expired_token' });
    }
}

function requireRole(role) {
    return (req, res, next) => {
        if (!req.auth || req.auth.role !== role) {
            return res.status(403).json({ error: 'wrong_role', message: `This endpoint is for ${role} accounts only.` });
        }
        return next();
    };
}

const { sendEmail, isConfigured: emailConfigured } = require('./zira_go_email_service');

// In-memory OTP cache: email -> { otp, expiresAt, verified }
const otpStore = new Map();
const adminTelegramOtpStore = new Map();

// ------------------------------------------------------------------
// POST /api/auth/send-otp
// body: { email }
// ------------------------------------------------------------------
router.post('/send-otp', async (req, res) => {
    const { email } = req.body;
    if (!email || !email.includes('@')) {
        return res.status(400).json({ error: 'invalid_email', message: 'Valid email address is required.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

    otpStore.set(cleanEmail, { otp, expiresAt, verified: false });
    console.log(`[OTP Verification] OTP generated for ${cleanEmail}`);

    if (emailConfigured) {
        try {
            await sendEmail({
                fromName: 'Zira Go Campus Transit',
                to: cleanEmail,
                subject: `${otp} is your Zira Go verification code`,
                html: `
                  <div style="font-family:sans-serif;max-width:460px;margin:0 auto;padding:24px;border:1px solid #e2e8f0;border-radius:16px;">
                    <div style="text-align:center;margin-bottom:18px">
                      <h2 style="color:#6D28D9;margin:0">Zira GO!</h2>
                      <p style="color:#64748B;font-size:12px;margin:4px 0 0">Landmark University Campus Transit</p>
                    </div>
                    <p style="font-size:14px;color:#0F172A">Hello,</p>
                    <p style="font-size:14px;color:#475569">Use the 6-digit verification code below to verify your account registration:</p>
                    <div style="background:#F3EEFF;padding:16px;border-radius:12px;text-align:center;margin:20px 0;">
                      <span style="font-family:monospace;font-size:32px;font-weight:bold;letter-spacing:6px;color:#6D28D9">${otp}</span>
                    </div>
                    <p style="font-size:12px;color:#94A3B8">This code expires in 10 minutes. If you did not request this, please disregard.</p>
                  </div>
                `
            });
            return res.json({ success: true, message: 'Verification code sent to your email.' });
        } catch (mailErr) {
            console.warn('[Email Warning] Failed to send via Resend:', mailErr.message);
        }
    }

    // Never expose a real OTP outside an explicitly local development run.
    // A missing Gmail app password must be fixed, not silently bypassed.
    if (process.env.NODE_ENV !== 'development') {
        return res.status(503).json({
            error: 'email_delivery_unavailable',
            message: 'Email verification is temporarily unavailable. Please contact support.'
        });
    }

    // Local-development fallback only.
    return res.json({
        success: true,
        message: 'Verification code generated.',
        testOtp: otp // Returned in dev mode for instant testing
    });
});

// ------------------------------------------------------------------
// POST /api/auth/verify-otp
// body: { email, otp }
// ------------------------------------------------------------------
router.post('/verify-otp', async (req, res) => {
    const { email, otp } = req.body;
    if (!email || !otp) {
        return res.status(400).json({ error: 'missing_fields', message: 'Email and OTP code are required.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const entry = otpStore.get(cleanEmail);

    if (!entry) {
        return res.status(400).json({ error: 'otp_not_found', message: 'No verification code was requested for this email.' });
    }

    if (Date.now() > entry.expiresAt) {
        otpStore.delete(cleanEmail);
        return res.status(400).json({ error: 'otp_expired', message: 'Verification code has expired. Please request a new code.' });
    }

    if (entry.otp !== otp.trim()) {
        return res.status(400).json({ error: 'invalid_otp', message: 'Incorrect 6-digit code. Please try again.' });
    }

    entry.verified = true;
    otpStore.set(cleanEmail, entry);

    return res.json({ success: true, message: 'Email verified successfully!' });
});

// ------------------------------------------------------------------
// POST /api/auth/register/student
// body: { email, password, regNo, pin }
// ------------------------------------------------------------------
router.post('/register/student', async (req, res) => {
  try {
    const { email, password, regNo, fullName, pin } = req.body;
    const formattedRegNo = normalizeLmuRegistrationNumber(regNo);
    if (!email || !password || !formattedRegNo || !fullName?.trim() || !pin) {
        return res.status(400).json({ error: 'missing_fields', message: 'Full name, email, a 7-digit Landmark registration number, password, and PIN are all required.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const otpEntry = otpStore.get(cleanEmail);
    if (!otpEntry || !otpEntry.verified) {
        return res.status(400).json({ error: 'email_not_verified', message: 'Please verify your email address with OTP before completing registration.' });
    }
    if (password.length < 8) {
        return res.status(400).json({ error: 'weak_password', message: 'Password must be at least 8 characters.' });
    }
    if (!/^\d{4}$/.test(pin)) {
        return res.status(400).json({ error: 'invalid_pin', message: 'Transaction PIN must be exactly 4 digits.' });
    }

    const existing = await pool.query('SELECT id FROM students WHERE email = $1 OR reg_no = $2', [cleanEmail, formattedRegNo]);
    if (existing.rows.length) {
        return res.status(409).json({ error: 'already_registered' });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const pinHash = await bcrypt.hash(pin, BCRYPT_ROUNDS);

    const result = await pool.query(
        `INSERT INTO students (email, full_name, password_hash, reg_no, pin_hash, wallet_balance)
         VALUES ($1, $2, $3, $4, $5, 0) RETURNING id, full_name, reg_no`,
        [cleanEmail, fullName.trim(), passwordHash, formattedRegNo, pinHash]
    );

    const token = signToken({ id: result.rows[0].id, role: 'student' });
    otpStore.delete(cleanEmail); // A verified code may be used exactly once.
    return res.status(201).json({ token, role: 'student', id: result.rows[0].id, fullName: result.rows[0].full_name, regNo: result.rows[0].reg_no });
  } catch (err) {
    console.error('[Student Registration Error]', err);
    if (err.code === '23505') return res.status(409).json({ error: 'already_registered' });
    return res.status(500).json({ error: 'internal_error', message: 'Could not create your account. Please try again.' });
  }
});

// ------------------------------------------------------------------
// POST /api/auth/register/driver
// body: { email, password, fullName, tripClosePin }
// ------------------------------------------------------------------
router.post('/register/driver', async (req, res) => {
  try {
    const { email, password, fullName, tripClosePin } = req.body;
    if (!email || !password || !fullName) {
        return res.status(400).json({ error: 'missing_fields', message: 'email, password, and fullName are all required.' });
    }
    if (!/^\d{4}$/.test(String(tripClosePin || ''))) {
        return res.status(400).json({ error: 'invalid_trip_close_pin', message: 'Choose a 4-digit trip-close PIN.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const otpEntry = otpStore.get(cleanEmail);
    if (!otpEntry || !otpEntry.verified) {
        return res.status(400).json({ error: 'email_not_verified', message: 'Please verify your email address with OTP before completing registration.' });
    }
    if (password.length < 8) {
        return res.status(400).json({ error: 'weak_password', message: 'Password must be at least 8 characters.' });
    }

    const existing = await pool.query('SELECT id FROM drivers WHERE email = $1', [email]);
    if (existing.rows.length) {
        return res.status(409).json({ error: 'already_registered' });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const closePinHash = await bcrypt.hash(String(tripClosePin), BCRYPT_ROUNDS);
    const result = await pool.query(
        `INSERT INTO drivers (email, password_hash, full_name, wallet_balance, trip_close_pin_hash)
         VALUES ($1, $2, $3, 0, $4) RETURNING id`,
        [email, passwordHash, fullName, closePinHash]
    );

    const token = signToken({ id: result.rows[0].id, role: 'driver' });
    otpStore.delete(cleanEmail); // A verified code may be used exactly once.
    return res.status(201).json({ token, role: 'driver', id: result.rows[0].id });
  } catch (err) {
    console.error('[Driver Registration Error]', err);
    if (err.code === '23505') return res.status(409).json({ error: 'already_registered' });
    return res.status(500).json({ error: 'internal_error', message: 'Could not create your account. Please try again.' });
  }
});

// ------------------------------------------------------------------
// POST /api/auth/login
// body: { email, password, role: 'student' | 'driver' }
// One endpoint for both — role picks the table, everything else is identical.
// ------------------------------------------------------------------
router.post('/login', async (req, res) => {
    try {
        const { email, password, role } = req.body;
        if (!['student', 'driver'].includes(role)) {
            return res.status(400).json({ error: 'invalid_role' });
        }
        const isDriver = role === 'driver';
        const query = isDriver
            ? `SELECT id, password_hash, is_flagged FROM drivers WHERE email = $1`
            : `SELECT id, password_hash FROM students WHERE email = $1`;

        const result = await pool.query(query, [email]);
        if (!result.rows.length) {
            return res.status(401).json({ error: 'invalid_credentials' });
        }

        const row = result.rows[0];
        const { id, password_hash: passwordHash } = row;
        const isFlagged = Boolean(row.is_flagged);
        const valid = passwordHash ? await bcrypt.compare(password, passwordHash) : false;
        if (!valid) {
            return res.status(401).json({ error: 'invalid_credentials' });
        }

        if (isDriver && isFlagged) {
            // Still issue the token — the flagged screen is what the driver panel shows
            // next, not a login block, since they may need to see support info.
            return res.status(200).json({ token: signToken({ id, role }), role, id, flagged: true });
        }

        return res.json({ token: signToken({ id, role }), role, id });
    } catch (err) {
        console.error('[Login Error]', err);
        return res.status(500).json({ error: 'internal_error', message: err.message });
    }
});

// ------------------------------------------------------------------
// POST /api/auth/login/admin
// Kept as its own endpoint (not merged into the role param above) so an admin
// credential leak can never be tried against the student/driver login path.
// ------------------------------------------------------------------
router.post('/login/admin', async (req, res) => {
    try {
        const { email, password, telegramOtp } = req.body;
        const result = await pool.query('SELECT id, password_hash FROM admins WHERE email = $1', [email]);
        if (!result.rows.length) return res.status(401).json({ error: 'invalid_credentials' });

        const valid = await bcrypt.compare(password, result.rows[0].password_hash);
        if (!valid) return res.status(401).json({ error: 'invalid_credentials' });

        const pendingOtp = adminTelegramOtpStore.get(email.trim().toLowerCase());
        if (!pendingOtp || Date.now() > pendingOtp.expiresAt || pendingOtp.code !== String(telegramOtp || '').trim()) {
            return res.status(401).json({ error: 'telegram_otp_required', message: 'Request and enter the Telegram admin login code.' });
        }
        adminTelegramOtpStore.delete(email.trim().toLowerCase());

        return res.json({ token: signToken({ id: result.rows[0].id, role: 'admin' }), role: 'admin', id: result.rows[0].id });
    } catch (err) {
        console.error('[Admin Login Error]', err);
        return res.status(500).json({ error: 'internal_error', message: err.message });
    }
});

router.post('/admin/telegram-otp', async (req, res) => {
    const email = (req.body.email || '').trim().toLowerCase();
    const password = req.body.password || '';
    if (!email || !password) return res.status(400).json({ message: 'Administrator email and password are required.' });
    if (!process.env.TELEGRAM_ADMIN_CHAT_ID) return res.status(503).json({ message: 'Telegram admin MFA is not configured.' });
    const admin = await pool.query('SELECT id, password_hash FROM admins WHERE email = $1', [email]);
    if (!admin.rows.length) return res.status(404).json({ message: 'Administrator account not found.' });
    if (!await bcrypt.compare(password, admin.rows[0].password_hash)) return res.status(401).json({ message: 'Invalid administrator credentials.' });
    const { bot } = require('./zira_go_telegram_bot');
    if (!bot) return res.status(503).json({ message: 'Telegram bot is unavailable.' });
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    adminTelegramOtpStore.set(email, { code, expiresAt: Date.now() + 5 * 60 * 1000 });
    await bot.sendMessage(process.env.TELEGRAM_ADMIN_CHAT_ID, `Zira Go admin login code: ${code}. Expires in 5 minutes.`);
    res.json({ success: true, message: 'A login code was sent to the configured Telegram admin account.' });
});

// ------------------------------------------------------------------
// GET /api/auth/me — lets the frontend confirm a stored token is still valid
// and find out which role it belongs to, without hardcoding it client-side.
// ------------------------------------------------------------------
router.get('/me', requireAuth, async (req, res) => {
    try {
        if (req.auth.role === 'student') {
            const result = await pool.query('SELECT full_name, reg_no, email, wallet_balance FROM students WHERE id = $1', [req.auth.id]);
            if (!result.rows.length) return res.status(404).json({ error: 'account_not_found' });
            const student = result.rows[0];
            return res.json({ id: req.auth.id, role: 'student', fullName: student.full_name || student.email.split('@')[0], regNo: student.reg_no, email: student.email, walletBalance: Number(student.wallet_balance) });
        }
        return res.json({ id: req.auth.id, role: req.auth.role });
    } catch (_err) {
        return res.status(500).json({ error: 'profile_unavailable' });
    }
});

module.exports = { router, requireAuth, requireRole, normalizeLmuRegistrationNumber };