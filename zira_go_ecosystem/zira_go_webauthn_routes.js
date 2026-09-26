// zira_go_webauthn_routes.js
// Real, server-verified WebAuthn: register a device's Face ID / Touch ID /
// fingerprint as a passkey, then use it to log in without a password.
// Mount under app.use('/api/webauthn', router).
//
// Assumptions:
//   - `pool` is a pg Pool instance (set as global.pool in server.js)
//   - JWT_SECRET is set (reused from zira_go_auth_routes.js)
//   - APP_BASE_URL is the exact origin the app is served from, e.g.
//     https://zira-go-backend.onrender.com or https://app.zirago.ng
//   - Optional: WEBAUTHN_RP_ID to override the Relying Party ID if it should
//     differ from APP_BASE_URL's hostname (rarely needed)
//
// Run `npm install @simplewebauthn/server` and `node migrate.js --webauthn-upgrade`
// before deploying this.

const express = require('express');
const {
    generateRegistrationOptions,
    verifyRegistrationResponse,
    generateAuthenticationOptions,
    verifyAuthenticationResponse
} = require('@simplewebauthn/server');
const { requireAuth, signToken } = require('./zira_go_auth_routes');

const router = express.Router();

(async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS webauthn_credentials (
                id             BIGSERIAL PRIMARY KEY,
                role           TEXT NOT NULL CHECK (role IN ('student', 'driver')),
                user_id        BIGINT NOT NULL,
                credential_id  TEXT NOT NULL UNIQUE,
                public_key     TEXT NOT NULL,
                counter        BIGINT NOT NULL DEFAULT 0,
                device_type    TEXT,
                backed_up      BOOLEAN NOT NULL DEFAULT false,
                transports     TEXT,
                nickname       TEXT,
                created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
                last_used_at   TIMESTAMPTZ
            )
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_webauthn_credentials_user ON webauthn_credentials (role, user_id)`);
    } catch (err) { console.warn('[WebAuthn schema]', err.message); }
})();

const APP_BASE_URL = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
const RP_ID = process.env.WEBAUTHN_RP_ID || (APP_BASE_URL ? new URL(APP_BASE_URL).hostname : 'localhost');
const RP_NAME = 'Zira Go';
const EXPECTED_ORIGIN = APP_BASE_URL || `https://${RP_ID}`;

if (!APP_BASE_URL) {
    console.warn('[WebAuthn] APP_BASE_URL is not set — falling back to https://' + RP_ID + '. Face ID/passkey login will fail if this does not match the real origin.');
}

// Short-lived challenge store: registration is keyed by the logged-in user,
// login is keyed by a random requestId since we don't know who the user is
// until the discoverable credential comes back. Both expire quickly — a
// challenge is only ever meant to be used once, seconds after it's issued.
const challengeStore = new Map(); // key -> { challenge, expiresAt }
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

function putChallenge(key, challenge) {
    challengeStore.set(key, { challenge, expiresAt: Date.now() + CHALLENGE_TTL_MS });
}
function takeChallenge(key) {
    const entry = challengeStore.get(key);
    challengeStore.delete(key);
    if (!entry || Date.now() > entry.expiresAt) return null;
    return entry.challenge;
}
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of challengeStore) if (now > entry.expiresAt) challengeStore.delete(key);
}, 10 * 60 * 1000).unref?.();

function userHandleFor(role, id) {
    return Buffer.from(`${role}:${id}`, 'utf8');
}
function parseUserHandle(base64url) {
    const decoded = Buffer.from(base64url, 'base64url').toString('utf8');
    const [role, idStr] = decoded.split(':');
    const id = Number(idStr);
    if (!['student', 'driver'].includes(role) || !Number.isInteger(id)) return null;
    return { role, id };
}

async function fetchIdentity(role, id) {
    const table = role === 'driver' ? 'drivers' : 'students';
    const cols = role === 'driver' ? 'id, email, full_name' : 'id, email, full_name, reg_no';
    const result = await pool.query(`SELECT ${cols} FROM ${table} WHERE id = $1`, [id]);
    return result.rows[0] || null;
}

// ------------------------------------------------------------------
// POST /api/webauthn/register-options  (auth required)
// Kicks off enrolling this device's Face ID / fingerprint as a passkey.
// ------------------------------------------------------------------
router.post('/register-options', requireAuth, async (req, res) => {
    try {
        const { role, id } = req.auth;
        const identity = await fetchIdentity(role, id);
        if (!identity) return res.status(404).json({ error: 'account_not_found' });

        const existing = await pool.query(
            `SELECT credential_id, transports FROM webauthn_credentials WHERE role = $1 AND user_id = $2`,
            [role, id]
        );

        const options = await generateRegistrationOptions({
            rpName: RP_NAME,
            rpID: RP_ID,
            userID: userHandleFor(role, id),
            userName: identity.email || identity.reg_no || `user-${id}`,
            userDisplayName: identity.full_name || 'Zira Go User',
            attestationType: 'none',
            authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
            excludeCredentials: existing.rows.map(row => ({
                id: row.credential_id,
                transports: row.transports ? row.transports.split(',') : undefined
            }))
        });

        putChallenge(`reg:${role}:${id}`, options.challenge);
        res.json({ options });
    } catch (err) {
        console.error('[WebAuthn register-options]', err);
        res.status(500).json({ error: 'internal_error' });
    }
});

// ------------------------------------------------------------------
// POST /api/webauthn/register-verify  (auth required)
// body: { response, nickname? }  — response is the RegistrationResponseJSON
// from SimpleWebAuthnBrowser's startRegistration().
// ------------------------------------------------------------------
router.post('/register-verify', requireAuth, async (req, res) => {
    try {
        const { role, id } = req.auth;
        const { response, nickname } = req.body;
        const expectedChallenge = takeChallenge(`reg:${role}:${id}`);
        if (!expectedChallenge) {
            return res.status(400).json({ error: 'challenge_expired', message: 'That setup request expired. Please try enabling it again.' });
        }

        const verification = await verifyRegistrationResponse({
            response,
            expectedChallenge,
            expectedOrigin: EXPECTED_ORIGIN,
            expectedRPID: RP_ID,
            requireUserVerification: true
        });

        if (!verification.verified || !verification.registrationInfo) {
            return res.status(400).json({ error: 'verification_failed', message: 'Could not verify that Face ID / fingerprint setup.' });
        }

        const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
        const transports = (response.response && response.response.transports) || [];

        await pool.query(
            `INSERT INTO webauthn_credentials (role, user_id, credential_id, public_key, counter, device_type, backed_up, transports, nickname)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (credential_id) DO NOTHING`,
            [
                role, id, credential.id,
                Buffer.from(credential.publicKey).toString('base64'),
                credential.counter, credentialDeviceType, credentialBackedUp,
                transports.join(','), nickname || null
            ]
        );

        res.json({ success: true, credentialId: credential.id });
    } catch (err) {
        console.error('[WebAuthn register-verify]', err);
        res.status(400).json({ error: 'verification_failed', message: 'Could not verify that Face ID / fingerprint setup.' });
    }
});

// ------------------------------------------------------------------
// GET /api/webauthn/credentials  (auth required)
// Lets the app show which devices have Face ID / fingerprint login enabled.
// ------------------------------------------------------------------
router.get('/credentials', requireAuth, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT credential_id, nickname, device_type, created_at, last_used_at
             FROM webauthn_credentials WHERE role = $1 AND user_id = $2 ORDER BY created_at DESC`,
            [req.auth.role, req.auth.id]
        );
        res.json({ credentials: result.rows });
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

// ------------------------------------------------------------------
// DELETE /api/webauthn/credentials/:credentialId  (auth required)
// Revokes one registered device — e.g. when the student turns the toggle off.
// ------------------------------------------------------------------
router.delete('/credentials/:credentialId', requireAuth, async (req, res) => {
    try {
        await pool.query(
            `DELETE FROM webauthn_credentials WHERE role = $1 AND user_id = $2 AND credential_id = $3`,
            [req.auth.role, req.auth.id, req.params.credentialId]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

// ------------------------------------------------------------------
// POST /api/webauthn/login-options  (public)
// No email needed — this is a "usernameless" flow. The browser lets the
// person pick from whichever passkeys it has stored for this site.
// ------------------------------------------------------------------
router.post('/login-options', async (req, res) => {
    try {
        const options = await generateAuthenticationOptions({
            rpID: RP_ID,
            userVerification: 'required'
            // No allowCredentials: lets any discoverable passkey for this RP be offered.
        });
        const requestId = require('crypto').randomBytes(16).toString('hex');
        putChallenge(`login:${requestId}`, options.challenge);
        res.json({ requestId, options });
    } catch (err) {
        console.error('[WebAuthn login-options]', err);
        res.status(500).json({ error: 'internal_error' });
    }
});

// ------------------------------------------------------------------
// POST /api/webauthn/login-verify  (public)
// body: { requestId, response }
// On success, issues the same kind of JWT as /api/auth/login.
// ------------------------------------------------------------------
router.post('/login-verify', async (req, res) => {
    try {
        const { requestId, response } = req.body;
        const expectedChallenge = requestId ? takeChallenge(`login:${requestId}`) : null;
        if (!expectedChallenge) {
            return res.status(400).json({ error: 'challenge_expired', message: 'That sign-in request expired. Please try again.' });
        }
        if (!response || !response.response || !response.response.userHandle) {
            return res.status(400).json({ error: 'invalid_response', message: 'This device is not enrolled for Face ID / fingerprint sign-in yet.' });
        }

        const identity = parseUserHandle(response.response.userHandle);
        if (!identity) return res.status(401).json({ error: 'invalid_credentials' });

        const credRow = await pool.query(
            `SELECT * FROM webauthn_credentials WHERE role = $1 AND user_id = $2 AND credential_id = $3`,
            [identity.role, identity.id, response.id]
        );
        if (!credRow.rows.length) return res.status(401).json({ error: 'invalid_credentials' });
        const stored = credRow.rows[0];

        const verification = await verifyAuthenticationResponse({
            response,
            expectedChallenge,
            expectedOrigin: EXPECTED_ORIGIN,
            expectedRPID: RP_ID,
            requireUserVerification: true,
            credential: {
                id: stored.credential_id,
                publicKey: new Uint8Array(Buffer.from(stored.public_key, 'base64')),
                counter: Number(stored.counter)
            }
        });

        if (!verification.verified) {
            return res.status(401).json({ error: 'invalid_credentials' });
        }

        await pool.query(
            `UPDATE webauthn_credentials SET counter = $1, last_used_at = now() WHERE id = $2`,
            [verification.authenticationInfo.newCounter, stored.id]
        );

        const { role, id } = identity;

        if (role === 'driver') {
            const driverRow = await pool.query('SELECT is_flagged, approval_status, rejection_reason FROM drivers WHERE id = $1', [id]);
            if (!driverRow.rows.length) return res.status(404).json({ error: 'account_not_found' });
            const d = driverRow.rows[0];
            if (d.approval_status === 'rejected') {
                return res.status(403).json({ error: 'driver_rejected', message: d.rejection_reason || 'Your driver application was not approved.' });
            }
            return res.json({ token: signToken({ id, role }), role, id, pendingApproval: d.approval_status === 'pending', flagged: Boolean(d.is_flagged) });
        }

        const studentRow = await pool.query('SELECT full_name, reg_no FROM students WHERE id = $1', [id]);
        if (!studentRow.rows.length) return res.status(404).json({ error: 'account_not_found' });
        return res.json({ token: signToken({ id, role }), role, id, fullName: studentRow.rows[0].full_name, regNo: studentRow.rows[0].reg_no });
    } catch (err) {
        console.error('[WebAuthn login-verify]', err);
        res.status(401).json({ error: 'invalid_credentials' });
    }
});

module.exports = router;
