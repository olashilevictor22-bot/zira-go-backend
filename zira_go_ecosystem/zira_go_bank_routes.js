// zira_go_bank_routes.js
// Verify-once, lock-forever bank account handling for students and drivers,
// plus the admin review queue that's the ONLY way to change a locked account.
// Mount under e.g. app.use('/api/bank', router) and app.use('/api/admin/bank', adminRouter).
//
// Assumptions:
//   - `pool` is a pg Pool instance
//   - resolveBankAccount() below calls a real name-resolution API (Paystack's
//     /bank/resolve or Korapay's equivalent) — swap in your existing client
//     the same way ZiraPay's funding flow already calls Korapay.
//   - req.auth = { id, role } is set by zira_go_auth_routes.js's requireAuth

const express = require('express');
const router = express.Router();
const adminRouter = express.Router();
const { requireAuth, requireRole } = require('./zira_go_auth_routes');
const { resolveAccountName, getNigerianBanks } = require('./zira_go_payment_service');

// ------------------------------------------------------------------
// Swap this for a real call to whichever provider ZiraPay's funding flow
// already uses (Paystack /bank/resolve, Korapay's equivalent). It should
// return the account holder's name as held by the bank — never something
// the user typed — which is the whole point of verification.
// ------------------------------------------------------------------
async function resolveBankAccount(accountNumber, bankCode) {
    return resolveAccountName(accountNumber, bankCode);
}

function ownerColumn(role) {
    return role === 'student' ? 'student_id' : 'driver_id';
}
function table(role) {
    return role === 'student' ? 'students' : 'drivers';
}
function isAccountOwner(role) {
    return role === 'student' || role === 'driver';
}

// ------------------------------------------------------------------
// GET /api/bank/account — current state: unset, pending-first-verify, or locked.
// ------------------------------------------------------------------
router.get('/account', requireAuth, async (req, res) => {
    const { id, role } = req.auth;
    if (!isAccountOwner(role)) return res.status(403).json({ error: 'role_not_supported' });
    const result = await pool.query(
        `SELECT bank_name, bank_account_number, bank_account_name, bank_verified_at, bank_locked
         FROM ${table(role)} WHERE id = $1`,
        [id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'not_found' });
    res.json(result.rows[0]);
});

router.get('/banks', requireAuth, async (req, res) => {
    if (!isAccountOwner(req.auth.role)) return res.status(403).json({ error: 'role_not_supported' });
    try { res.json({ banks: await getNigerianBanks() }); }
    catch (err) { res.status(503).json({ error: 'bank_list_unavailable', message: 'Live bank list is temporarily unavailable. Please try again.' }); }
});

// ------------------------------------------------------------------
// POST /api/bank/verify — first-time verification only. Once bank_locked is
// true, this route refuses and points the caller at the change-request flow
// instead — there is no direct-overwrite path once an account is locked.
// body: { accountNumber, bankCode, bankName, confirmed: true }
// ------------------------------------------------------------------
router.post('/resolve', requireAuth, async (req, res) => {
    const { role } = req.auth;
    const { accountNumber, bankCode, bankName } = req.body;
    const normalizedAccountNumber = String(accountNumber || '').replace(/\s/g, '');
    if (!isAccountOwner(role)) return res.status(403).json({ error: 'role_not_supported' });
    if (!/^\d{10}$/.test(normalizedAccountNumber) || !bankCode || !bankName) return res.status(400).json({ error: 'missing_fields' });
    try {
        const { accountName } = await resolveAccountName(normalizedAccountNumber, bankCode);
        res.json({ status: 'resolved', accountName, accountNumber: normalizedAccountNumber, bankCode, bankName });
    } catch (err) {
        console.error('[bank/resolve] failed:', err.reasons || err.message);
        res.status(422).json({ error: 'resolve_failed', message: "Couldn't verify that account number with the bank. Double-check the bank and account number and try again." });
    }
});

router.post('/verify', requireAuth, async (req, res) => {
    const { id, role } = req.auth;
    const { accountNumber, bankCode, bankName, confirmed } = req.body;
    const normalizedAccountNumber = String(accountNumber || '').replace(/\s/g, '');
    if (!isAccountOwner(role)) return res.status(403).json({ error: 'role_not_supported' });
    if (!/^\d{10}$/.test(normalizedAccountNumber) || !bankCode || !bankName) {
        return res.status(400).json({ error: 'missing_fields' });
    }
    if (confirmed !== true) return res.status(400).json({ error: 'confirmation_required', message: 'Confirm the verified account details before saving this payout account.' });

    const current = await pool.query(`SELECT bank_locked FROM ${table(role)} WHERE id = $1`, [id]);
    if (!current.rows.length) return res.status(404).json({ error: 'not_found' });
    if (current.rows[0].bank_locked) {
        return res.status(409).json({
            error: 'already_locked',
            message: 'A verified account is already on file. Submit a change request to update it.'
        });
    }

    let accountName;
    try {
        ({ accountName } = await resolveAccountName(normalizedAccountNumber, bankCode));
    } catch (err) {
        console.error('[bank/verify] resolve failed:', err.reasons || err.message);
        return res.status(422).json({ error: 'resolve_failed', message: "Couldn't verify that account number with the bank. Double-check it and try again." });
    }

    await pool.query(
        `UPDATE ${table(role)}
         SET bank_code = $1, bank_name = $2, bank_account_number = $3,
             bank_account_name = $4, bank_verified_at = now(), bank_locked = true
         WHERE id = $5`,
        [bankCode, bankName, normalizedAccountNumber, accountName, id]
    );

    res.json({ status: 'verified', accountName, message: 'Account verified and locked. Contact support to change it in future.' });
});

// ------------------------------------------------------------------
// POST /api/bank/change-request — the only way to touch a locked account.
// Nothing is applied to students/drivers here; it just queues a request for
// an admin to review. One pending request at a time (enforced by the unique
// partial index in the schema, this check just gives a friendlier error).
// body: { accountNumber, bankCode, bankName, reason }
// ------------------------------------------------------------------
router.post('/change-request', requireAuth, async (req, res) => {
    const { id, role } = req.auth;
    const { accountNumber, bankCode, bankName, reason } = req.body;
    if (!accountNumber || !bankCode || !bankName) {
        return res.status(400).json({ error: 'missing_fields' });
    }

    const owner = await pool.query(
        `SELECT bank_account_number, bank_account_name FROM ${table(role)} WHERE id = $1`, [id]
    );
    if (!owner.rows.length) return res.status(404).json({ error: 'not_found' });

    const pending = await pool.query(
        `SELECT id FROM bank_account_change_requests WHERE ${ownerColumn(role)} = $1 AND status = 'pending'`,
        [id]
    );
    if (pending.rows.length) {
        return res.status(409).json({ error: 'request_already_pending', message: 'You already have a change request under review.' });
    }

    const result = await pool.query(
        `INSERT INTO bank_account_change_requests
            (${ownerColumn(role)}, current_account_number, current_account_name,
             requested_bank_code, requested_bank_name, requested_account_number, reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, created_at`,
        [id, owner.rows[0].bank_account_number, owner.rows[0].bank_account_name, bankCode, bankName, accountNumber, reason || null]
    );

    res.status(201).json({ status: 'pending_review', requestId: result.rows[0].id, createdAt: result.rows[0].created_at });
});

// ------------------------------------------------------------------
// GET /api/bank/change-request/status — so the frontend can show "pending
// review" instead of the verify form once a request is in flight.
// ------------------------------------------------------------------
router.get('/change-request/status', requireAuth, async (req, res) => {
    const { id, role } = req.auth;
    const result = await pool.query(
        `SELECT id, status, requested_account_number, requested_bank_name, admin_note, created_at, reviewed_at
         FROM bank_account_change_requests
         WHERE ${ownerColumn(role)} = $1
         ORDER BY created_at DESC LIMIT 1`,
        [id]
    );
    res.json(result.rows[0] || null);
});

// ==================================================================
// Admin-only queue — mount adminRouter behind requireAuth + requireRole('admin')
// ==================================================================

// GET /api/admin/bank/change-requests?status=pending
adminRouter.get('/change-requests', requireAuth, requireRole('admin'), async (req, res) => {
    const status = req.query.status || 'pending';
    const result = status === 'all'
        ? await pool.query(`SELECT * FROM bank_account_change_requests ORDER BY created_at DESC`)
        : await pool.query(
            `SELECT * FROM bank_account_change_requests WHERE status = $1 ORDER BY created_at ASC`,
            [status]
        );
    res.json(result.rows);
});

// POST /api/admin/bank/change-requests/:id/approve
// Re-resolves the requested account with the bank before applying it — an
// admin approving a request is not itself proof the number is real, so we
// verify again rather than trusting whatever the requester typed.
adminRouter.post('/change-requests/:id/approve', requireAuth, requireRole('admin'), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const reqRow = await client.query(
            `SELECT * FROM bank_account_change_requests WHERE id = $1 AND status = 'pending' FOR UPDATE`,
            [req.params.id]
        );
        if (!reqRow.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'not_found_or_already_reviewed' });
        }
        const cr = reqRow.rows[0];
        const role = cr.student_id ? 'student' : 'driver';
        const ownerId = cr.student_id || cr.driver_id;

        let accountName;
        try {
            ({ accountName } = await resolveBankAccount(cr.requested_account_number, cr.requested_bank_code));
        } catch (err) {
            await client.query('ROLLBACK');
            return res.status(422).json({ error: 'resolve_failed', message: "Couldn't re-verify this account with the bank before approving." });
        }

        await client.query(
            `UPDATE ${table(role)}
             SET bank_code = $1, bank_name = $2, bank_account_number = $3,
                 bank_account_name = $4, bank_verified_at = now(), bank_locked = true
             WHERE id = $5`,
            [cr.requested_bank_code, cr.requested_bank_name, cr.requested_account_number, accountName, ownerId]
        );
        await client.query(
            `UPDATE bank_account_change_requests
             SET status = 'approved', requested_account_name = $1, reviewed_by_admin_id = $2, reviewed_at = now()
             WHERE id = $3`,
            [accountName, req.auth.id, cr.id]
        );

        await client.query('COMMIT');
        res.json({ status: 'approved', accountName });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('approve change-request failed:', err);
        res.status(500).json({ error: 'internal_error' });
    } finally {
        client.release();
    }
});

// POST /api/admin/bank/change-requests/:id/reject  body: { note }
adminRouter.post('/change-requests/:id/reject', requireAuth, requireRole('admin'), async (req, res) => {
    const result = await pool.query(
        `UPDATE bank_account_change_requests
         SET status = 'rejected', admin_note = $1, reviewed_by_admin_id = $2, reviewed_at = now()
         WHERE id = $3 AND status = 'pending' RETURNING id`,
        [req.body.note || null, req.auth.id, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'not_found_or_already_reviewed' });
    res.json({ status: 'rejected' });
});

module.exports = { router, adminRouter };
