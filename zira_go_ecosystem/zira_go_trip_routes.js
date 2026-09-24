// zira_go_trip_routes.js
// Core trip/charge endpoints for Zira Go. Mount under e.g. app.use('/api/trips', router).
//
// Assumptions (adjust to match your actual ZiraPay code):
//   - `pool` is a pg Pool instance
//   - students table has: id, wallet_balance, pin_hash
//   - drivers table has: id, wallet_balance, is_flagged, flagged_at
//   - PIN hashing uses bcrypt; code hashing uses sha256 (codes aren't secret-grade, just not stored plain)

const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const router = express.Router();
const { requireAuth, requireRole, normalizeLmuRegistrationNumber } = require('./zira_go_auth_routes');
const { notifyStudent, notifyDriver, notifyDriverFlagged } = require('./zira_go_telegram_bot');
const { notify } = require('./zira_go_notification_routes');

const CODE_GUESS_FLAG_THRESHOLD = 5;
const TRANSACTION_FEE = 10;

// Escalating wallet-PIN lockout. Index = pin_lock_stage (0 = normal).
// Stage 0 -> 4 fails locks for 10 min and advances to stage 1.
// Stage 1 -> 3 more fails locks for 30 min and advances to stage 2.
// Stage 2 -> 3 more fails locks the account permanently (support must reopen it).
const PIN_LOCKOUT_TIERS = [
    { failLimit: 4, lockMinutes: 10 },
    { failLimit: 3, lockMinutes: 30 },
    { failLimit: 3, lockMinutes: null } // null => permanent
];

(async () => {
    try { await pool.query('ALTER TABLE drivers ADD COLUMN IF NOT EXISTS trip_close_pin_hash TEXT'); }
    catch (err) { console.warn('[Driver close PIN schema]', err.message); }
})();

// `redeemed_at` is read/written by the code-history endpoint and by code
// redemption below, but was never added by any schema migration — every
// history fetch and every successful code charge has been failing against
// the database with "column does not exist" until this runs.
(async () => {
    try { await pool.query('ALTER TABLE one_time_codes ADD COLUMN IF NOT EXISTS redeemed_at TIMESTAMPTZ'); }
    catch (err) { console.warn('[Code redeemed_at schema]', err.message); }
})();

// `raw_code` is needed only while a pass is active so its owner can see it in
// the app. This keeps older deployments compatible with Telegram-generated passes.
(async () => {
    try {
        await pool.query('ALTER TABLE one_time_codes ADD COLUMN IF NOT EXISTS raw_code TEXT');
        // Keep the latest current pass if legacy data contains duplicates, then
        // make duplicate active codes impossible at the database layer.
        await pool.query(`WITH ranked AS (
            SELECT id, ROW_NUMBER() OVER (PARTITION BY student_id ORDER BY created_at DESC, id DESC) AS row_no
            FROM one_time_codes WHERE status='active'
        ) UPDATE one_time_codes c SET status='expired'
          FROM ranked r WHERE c.id=r.id AND r.row_no > 1`);
        await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_code_per_student
          ON one_time_codes(student_id) WHERE status='active'`);
    }
    catch (err) { console.warn('[Ride code schema]', err.message); }
})();

function hashCode(code) {
    return crypto.createHash('sha256').update(code).digest('hex');
}

// ------------------------------------------------------------------
// GET /api/trips/code/active
// Fetches student's current active code if valid (< 30 min)
// ------------------------------------------------------------------
router.get('/code/active', requireAuth, requireRole('student'), async (req, res) => {
    try {
        const studentId = req.auth.id;
        // Keep the database's single-active-pass rule in sync with elapsed
        // time. Otherwise an expired row remains `active` and blocks the
        // next insert even though it is no longer valid for use.
        await pool.query(`UPDATE one_time_codes SET status='expired'
            WHERE student_id=$1 AND status='active' AND expires_at <= now()`, [studentId]);
        const result = await pool.query(
            `SELECT id, raw_code, expires_at, created_at FROM one_time_codes
             WHERE student_id = $1 AND status = 'active' AND expires_at > now()
             ORDER BY created_at DESC LIMIT 1`,
            [studentId]
        );
        if (!result.rows.length) {
            return res.json({ activeCode: null });
        }
        const row = result.rows[0];
        const remainingMs = new Date(row.expires_at).getTime() - Date.now();
        // Older Telegram versions stored hash-only rows. They cannot be shown
        // again, so retire that unusable row and allow the user to request a
        // fresh pass rather than locking the wallet on dashes.
        if (!row.raw_code) {
            await pool.query(`UPDATE one_time_codes SET status = 'expired' WHERE id = $1`, [row.id]);
            return res.json({ activeCode: null, replacedUnreadableCode: true });
        }
        const raw = row.raw_code;
        res.json({
            activeCode: {
                id: row.id,
                code: raw,
                formatted: raw.length === 6 ? `${raw.slice(0, 3)} ${raw.slice(3)}` : raw,
                expiresAt: row.expires_at,
                ttlSeconds: Math.max(0, Math.floor(remainingMs / 1000))
            }
        });
    } catch (err) {
        console.error('[Active Code Error]', err);
        res.status(500).json({ error: 'internal_error' });
    }
});

// ------------------------------------------------------------------
// POST /api/trips/code/generate
// Generates a 6-digit one-time ride code with 30-minute validity.
// Prevents generating a new code if an unexpired active code exists!
// body: { studentId? }
// ------------------------------------------------------------------
router.post('/code/generate', requireAuth, requireRole('student'), async (req, res) => {
    try {
        const studentId = req.auth.id;
        await pool.query(`UPDATE one_time_codes SET status='expired'
            WHERE student_id=$1 AND status='active' AND expires_at <= now()`, [studentId]);

        // 1. Check if an active, unexpired code already exists
        const existing = await pool.query(
            `SELECT id, raw_code, expires_at, created_at FROM one_time_codes
             WHERE student_id = $1 AND status = 'active' AND expires_at > now()
             ORDER BY created_at DESC LIMIT 1`,
            [studentId]
        );

        if (existing.rows.length > 0) {
            const row = existing.rows[0];
            const remainingMs = new Date(row.expires_at).getTime() - Date.now();
            if (!row.raw_code) {
                await pool.query(`UPDATE one_time_codes SET status = 'expired' WHERE id = $1`, [row.id]);
                return res.status(409).json({ message: 'Your previous pass could not be displayed. It was cleared; tap Generate Fresh Code again.' });
            }
            const raw = row.raw_code;
            return res.json({
                isExisting: true,
                code: raw,
                formatted: raw.length === 6 ? `${raw.slice(0, 3)} ${raw.slice(3)}` : raw,
                expiresAt: row.expires_at,
                ttlSeconds: Math.max(0, Math.floor(remainingMs / 1000)),
                message: 'An active code is already running. Please use it or wait for expiration before generating another.'
            });
        }

        // 2. Generate brand new code
        const rawCode = crypto.randomInt(100000, 999999).toString();
        const codeHash = hashCode(rawCode);
        const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes

        await pool.query(
            `INSERT INTO one_time_codes (student_id, code_hash, raw_code, expires_at, status)
             VALUES ($1, $2, $3, $4, 'active')`,
            [studentId, codeHash, rawCode, expiresAt]
        );

        res.json({
            isExisting: false,
            code: rawCode,
            formatted: `${rawCode.slice(0, 3)} ${rawCode.slice(3)}`,
            expiresAt: expiresAt.toISOString(),
            ttlSeconds: 1800
        });
    } catch (err) {
        console.error('[Generate Code Error]', err);
        res.status(500).json({ error: 'internal_error' });
    }
});

// ------------------------------------------------------------------
// GET /api/trips/code/history
// Returns all ride codes for the student (active, redeemed, expired)
// ------------------------------------------------------------------
router.get('/code/history', requireAuth, requireRole('student'), async (req, res) => {
    try {
        const studentId = req.auth.id;
        const result = await pool.query(
            `SELECT id, raw_code, status, expires_at, created_at, redeemed_at
             FROM one_time_codes
             WHERE student_id = $1
             ORDER BY created_at DESC LIMIT 50`,
            [studentId]
        );
        const now = new Date();
        const codes = result.rows.map(r => {
            let computedStatus = r.status;
            if (r.status === 'active' && new Date(r.expires_at) <= now) {
                computedStatus = 'expired';
            }
            return {
                id: r.id,
                code: r.raw_code || '******',
                formatted: r.raw_code && r.raw_code.length === 6 ? `${r.raw_code.slice(0, 3)} ${r.raw_code.slice(3)}` : (r.raw_code || '******'),
                status: computedStatus,
                createdAt: r.created_at,
                expiresAt: r.expires_at,
                redeemedAt: r.redeemed_at
            };
        });
        res.json({ codes });
    } catch (err) {
        console.error('[Code History Error]', err);
        res.status(500).json({ error: 'internal_error' });
    }
});

// ------------------------------------------------------------------
// POST /api/trips/start
// Driver opens a new trip session in either mode.
// body: { driverId, mode: 'complete_ride' | 'charter', seatCapacity?, charterFare? }
// ------------------------------------------------------------------
router.post('/start', requireAuth, requireRole('driver'), async (req, res) => {
    const { mode, charterFare } = req.body;
    const driverId = req.auth.id;
    const seatCapacity = Number(req.body.seatCapacity || 4);

    const driver = await pool.query('SELECT is_flagged FROM drivers WHERE id = $1', [driverId]);
    if (!driver.rows.length) return res.status(404).json({ error: 'driver_not_found' });
    if (driver.rows[0].is_flagged) return res.status(403).json({ error: 'driver_flagged' });

    if (!['complete_ride', 'charter'].includes(mode)) {
        return res.status(400).json({ error: 'invalid_mode' });
    }
    if (!Number.isInteger(seatCapacity) || seatCapacity < 1 || seatCapacity > 60) {
        return res.status(400).json({ error: 'invalid_seat_capacity', message: 'Choose a vehicle capacity between 1 and 60.' });
    }
    const existing = await pool.query(
        `SELECT id FROM trip_sessions WHERE driver_id=$1 AND mode=$2 AND status='open' AND created_at::date=CURRENT_DATE LIMIT 1`,
        [driverId, mode]
    );
    if (existing.rows.length) return res.status(409).json({ error: 'same_mode_trip_open', tripSessionId: existing.rows[0].id, message: 'You already have an open trip of this type. Resume it from Open trips.' });

    const result = await pool.query(
        `INSERT INTO trip_sessions (driver_id, mode, charter_fare, seat_capacity)
         VALUES ($1, $2, $3, $4) RETURNING id, seat_capacity`,
        [driverId, mode, mode === 'charter' ? charterFare : null, seatCapacity]
    );

    res.json({ tripSessionId: result.rows[0].id, seatCapacity: result.rows[0].seat_capacity });
});

// ------------------------------------------------------------------
// GET /api/trips/active — restores today's unfinished driver session
// ------------------------------------------------------------------
router.get('/active', requireAuth, requireRole('driver'), async (req, res) => {
    try {
        // A trip is intentionally available after refresh/re-login, but never
        // carries into a new calendar day.
        await pool.query(`UPDATE trip_sessions SET status='closed', closed_at=now()
            WHERE driver_id=$1 AND status='open' AND created_at::date < CURRENT_DATE`, [req.auth.id]);
        const result = await pool.query(
            `SELECT id, mode, seat_capacity, seats_filled, total_collected
             FROM trip_sessions WHERE driver_id=$1 AND status='open'
             AND created_at::date = CURRENT_DATE ORDER BY created_at DESC`,
            [req.auth.id]
        );
        const trips=result.rows.map(trip=>({ id: trip.id, mode: trip.mode, seatCapacity: trip.seat_capacity, seatsFilled: trip.seats_filled, totalCollected: Number(trip.total_collected), charges: [] }));
        res.json({ trip: trips[0] || null, trips });
    } catch (err) {
        console.error('[Active Trip Error]', err);
        res.status(500).json({ error: 'internal_error' });
    }
});

// ------------------------------------------------------------------
// POST /api/trips/:id/charge/reg-no
// body: { studentId, regNo, pin, fareAmount }
// fareAmount is ignored (forced to 250) when the session is complete_ride.
// ------------------------------------------------------------------
router.post('/:id/charge/reg-no', requireAuth, requireRole('driver'), async (req, res) => {
    const tripSessionId = req.params.id;
    const { regNo, pin } = req.body;
    let { fareAmount } = req.body;

    try {
        const session = await pool.query('SELECT mode, status FROM trip_sessions WHERE id = $1 AND driver_id = $2', [tripSessionId, req.auth.id]);
        if (!session.rows.length || session.rows[0].status !== 'open') {
            return res.status(400).json({ error: 'trip_session_not_open' });
        }
        if (session.rows[0].mode === 'complete_ride') fareAmount = 250;

        const formattedRegNo = normalizeLmuRegistrationNumber(regNo);
        if (!formattedRegNo) {
            return res.status(400).json({ error: 'invalid_reg_no', message: 'Enter the student\'s 7-digit registration number, e.g. 2012345.' });
        }

        const studentLookup = await pool.query(
            `SELECT id, pin_hash, pin_fail_count, pin_lock_stage, pin_locked_until, pin_permanently_locked
             FROM students WHERE reg_no = $1`,
            [formattedRegNo]
        );
        if (!studentLookup.rows.length) return res.status(404).json({ error: 'student_not_found' });
        const student = studentLookup.rows[0];
        const studentId = student.id;

        if (student.pin_permanently_locked) {
            return res.status(423).json({
                error: 'pin_permanently_locked',
                message: 'This wallet PIN is locked after repeated failed attempts. The student must contact support to reopen the account.'
            });
        }
        if (student.pin_locked_until && new Date(student.pin_locked_until) > new Date()) {
            return res.status(423).json({
                error: 'pin_temporarily_locked',
                lockedUntil: student.pin_locked_until,
                message: `This wallet PIN is locked. Try again after ${new Date(student.pin_locked_until).toLocaleTimeString()}.`
            });
        }
        if (!student.pin_hash) {
            return res.status(409).json({ error: 'pin_not_set', message: 'This student has not set a wallet PIN yet.' });
        }

        const pinValid = await bcrypt.compare(pin || '', student.pin_hash);
        await pool.query(
            'INSERT INTO pin_attempts (student_id, trip_session_id, success) VALUES ($1, $2, $3)',
            [studentId, tripSessionId, pinValid]
        );

        if (pinValid) {
            // A correct PIN clears the whole escalation, not just the immediate lock.
            await pool.query(
                `UPDATE students SET pin_fail_count = 0, pin_lock_stage = 0, pin_locked_until = NULL WHERE id = $1`,
                [studentId]
            );
            return executeCharge({ tripSessionId, studentId, fareAmount, authMethod: 'reg_no_pin' }, res);
        }

        // Wrong PIN — advance the fail count for this tier and check whether it's breached.
        const newFailCount = student.pin_fail_count + 1;
        const stage = student.pin_lock_stage; // 0, 1, or 2
        const tier = PIN_LOCKOUT_TIERS[Math.min(stage, PIN_LOCKOUT_TIERS.length - 1)];

        if (newFailCount >= tier.failLimit) {
            if (tier.lockMinutes === null) {
                // Final tier breached — permanent lock, support must reopen it.
                await pool.query(
                    `UPDATE students
                     SET pin_fail_count = 0, pin_permanently_locked = true, pin_permanently_locked_at = now(), pin_locked_until = NULL
                     WHERE id = $1`,
                    [studentId]
                );
                return res.status(423).json({
                    error: 'pin_permanently_locked',
                    message: 'Too many incorrect PIN attempts. This wallet is now locked — the student must contact support to reopen it.'
                });
            }
            const lockedUntil = new Date(Date.now() + tier.lockMinutes * 60 * 1000);
            await pool.query(
                `UPDATE students SET pin_fail_count = 0, pin_lock_stage = $1, pin_locked_until = $2 WHERE id = $3`,
                [stage + 1, lockedUntil, studentId]
            );
            return res.status(423).json({
                error: 'pin_temporarily_locked',
                lockedUntil,
                message: `Too many incorrect attempts. This wallet PIN is locked for ${tier.lockMinutes} minutes.`
            });
        }

        await pool.query(`UPDATE students SET pin_fail_count = $1 WHERE id = $2`, [newFailCount, studentId]);
        const remaining = tier.failLimit - newFailCount;
        return res.status(401).json({ error: 'invalid_pin', attemptsRemaining: Math.max(remaining, 0) });
    } catch (err) {
        console.error('[Charge reg-no Error]', err);
        return res.status(500).json({ error: 'internal_error', message: 'Could not process this charge. Please try again.' });
    }
});

// ------------------------------------------------------------------
// POST /api/trips/:id/charge/code
// body: { driverId, code, fareAmount }
// fareAmount is ignored (forced to 250) when the session is complete_ride.
// ------------------------------------------------------------------
router.post('/:id/charge/code', requireAuth, requireRole('driver'), async (req, res) => {
    const tripSessionId = req.params.id;
    const { code } = req.body;
    const driverId = req.auth.id;
    let { fareAmount } = req.body;

    try {
        const session = await pool.query('SELECT mode, status FROM trip_sessions WHERE id = $1 AND driver_id = $2', [tripSessionId, driverId]);
        if (!session.rows.length || session.rows[0].status !== 'open') {
            return res.status(400).json({ error: 'trip_session_not_open' });
        }
        if (session.rows[0].mode === 'complete_ride') fareAmount = 250;

        const codeHash = hashCode(code);
        const codeRow = await pool.query(
            `SELECT id, student_id FROM one_time_codes
             WHERE code_hash = $1 AND status = 'active' AND expires_at > now()`,
            [codeHash]
        );

        const success = codeRow.rows.length > 0;
        await pool.query(
            'INSERT INTO code_guess_attempts (driver_id, success) VALUES ($1, $2)',
            [driverId, success]
        );

        if (!success) {
            // Count the current consecutive-failure streak for this driver
            const recent = await pool.query(
                `SELECT success FROM code_guess_attempts
                 WHERE driver_id = $1 ORDER BY created_at DESC LIMIT $2`,
                [driverId, CODE_GUESS_FLAG_THRESHOLD]
            );
            const streak = recent.rows.every(r => r.success === false) && recent.rows.length === CODE_GUESS_FLAG_THRESHOLD;

            if (streak) {
                await pool.query(
                    'UPDATE drivers SET is_flagged = true, flagged_at = now() WHERE id = $1',
                    [driverId]
                );
                // Fire-and-forget — the flag is already committed above, so a Telegram
                // hiccup here should never affect the 403 the driver's app is about to show.
                notifyDriverFlagged(driverId).catch(err => console.error('notifyDriverFlagged failed:', err));
                return res.status(403).json({ error: 'driver_flagged', message: 'Too many wrong codes in a row. Contact support.' });
            }
            return res.status(404).json({ error: 'invalid_or_expired_code' });
        }

        await pool.query(`UPDATE one_time_codes SET status = 'redeemed', redeemed_at = now() WHERE id = $1`, [codeRow.rows[0].id]);

        return executeCharge(
            { tripSessionId, studentId: codeRow.rows[0].student_id, fareAmount, authMethod: 'one_time_code', codeId: codeRow.rows[0].id },
            res
        );
    } catch (err) {
        console.error('[Charge by code error]', err);
        return res.status(500).json({ error: 'internal_error', message: 'Could not process this charge. Please try again.' });
    }
});

// ------------------------------------------------------------------
// Shared charge execution: balance check -> debit student -> credit driver (minus fee) -> log trip_charge
// Runs as one DB transaction so a failure anywhere rolls the whole thing back.
// ------------------------------------------------------------------
async function executeCharge({ tripSessionId, studentId, fareAmount, authMethod, codeId }, res) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const studentRes = await client.query(
            'SELECT wallet_balance, full_name, reg_no FROM students WHERE id = $1 FOR UPDATE', [studentId]
        );
        const balance = parseFloat(studentRes.rows[0].wallet_balance);

        if (balance < fareAmount) {
            await client.query(
                `INSERT INTO trip_charges (trip_session_id, student_id, auth_method, fare_amount, status, one_time_code_id)
                 VALUES ($1, $2, $3, $4, 'failed_insufficient_funds', $5)`,
                [tripSessionId, studentId, authMethod, fareAmount, codeId || null]
            );
            await client.query('COMMIT');
            return res.status(402).json({ error: 'insufficient_funds' });
        }

        const tripRes = await client.query(
            `SELECT driver_id FROM trip_sessions WHERE id = $1`, [tripSessionId]
        );
        const driverId = tripRes.rows[0].driver_id;

        // A passenger cannot begin a Charter (or another ride) while they
        // are already recorded in an open trip. Close the earlier trip first.
        const activeElsewhere = await client.query(
            `SELECT tc.id FROM trip_charges tc JOIN trip_sessions ts ON ts.id=tc.trip_session_id
             WHERE tc.student_id=$1 AND tc.status='success' AND ts.status='open' AND ts.id<>$2 LIMIT 1`,
            [studentId, tripSessionId]
        );
        if (activeElsewhere.rows.length) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'student_in_active_trip', message: 'This student is already in an active trip. Close that trip before starting a Charter ride.' });
        }

        // A student can board a session once only, whether they identify with
        // reg-no/PIN or a ride code generated from that same account.
        const alreadyCharged = await client.query(
            `SELECT id FROM trip_charges WHERE trip_session_id = $1 AND student_id = $2 AND status = 'success'`,
            [tripSessionId, studentId]
        );
        if (alreadyCharged.rows.length) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'student_already_charged', message: `${studentRes.rows[0].reg_no} already used for this ride.` });
        }

        // Debit student
        await client.query('UPDATE students SET wallet_balance = wallet_balance - $1 WHERE id = $2', [fareAmount, studentId]);
        await client.query(
            `INSERT INTO wallet_transactions (student_id, type, amount) VALUES ($1, 'ride_debit', $2)`,
            [studentId, fareAmount]
        );

        // Credit driver (fare minus the ₦10 transaction fee)
        const driverCredit = fareAmount - TRANSACTION_FEE;
        await client.query('UPDATE drivers SET wallet_balance = wallet_balance + $1 WHERE id = $2', [driverCredit, driverId]);
        await client.query(
            `INSERT INTO wallet_transactions (driver_id, type, amount, fee_amount, fee_type)
             VALUES ($1, 'ride_credit', $2, $3, 'transaction_fee')`,
            [driverId, driverCredit, TRANSACTION_FEE]
        );

        // Log the successful charge — the trip_sessions cap trigger fires on this insert
        await client.query(
            `INSERT INTO trip_charges (trip_session_id, student_id, auth_method, fare_amount, platform_fee, status, one_time_code_id)
             VALUES ($1, $2, $3, $4, $5, 'success', $6)`,
            [tripSessionId, studentId, authMethod, fareAmount, TRANSACTION_FEE, codeId || null]
        );

        await client.query('COMMIT');

        const newBalance = balance - fareAmount;

        // Fire-and-forget Telegram pushes — never let a notification failure affect
        // the charge response, which has already committed successfully at this point.
        notifyStudent(studentId, { fareAmount, newBalance }).catch(err =>
            console.error('notifyStudent failed:', err)
        );
        notifyDriver(driverId, { fareAmount, driverCredit }).catch(err =>
            console.error('notifyDriver failed:', err)
        );
        notify({ userId: studentId, role: 'student', title: 'Ride payment confirmed', body: `₦${fareAmount} was charged for your campus ride.`, type: 'ride' }).catch(() => {});
        notify({ userId: driverId, role: 'driver', title: 'Passenger payment received', body: `You received ₦${driverCredit} after fees.`, type: 'ride' }).catch(() => {});

        return res.json({ status: 'success', fareAmount, newBalance, studentName: studentRes.rows[0].full_name || studentRes.rows[0].reg_no });
    } catch (err) {
        await client.query('ROLLBACK');
        if (err.code === '23505') {
            return res.status(409).json({ error: 'student_already_charged', message: `${studentRes.rows[0].reg_no} already used for this ride.` });
        }
        if (err.message && err.message.includes('Complete Ride')) {
            return res.status(409).json({ error: 'trip_session_full' });
        }
        console.error('executeCharge failed:', err);
        return res.status(500).json({ error: 'internal_error' });
    } finally {
        client.release();
    }
}

// ------------------------------------------------------------------
// POST /api/trips/:id/close
// ------------------------------------------------------------------
router.post('/:id/close', requireAuth, requireRole('driver'), async (req, res) => {
    const { pin } = req.body || {};
    const driver = await pool.query('SELECT trip_close_pin_hash FROM drivers WHERE id=$1', [req.auth.id]);
    if (!driver.rows[0]?.trip_close_pin_hash) return res.status(409).json({ error: 'close_pin_not_set', message: 'Set your 4-digit trip-close PIN in Driver Settings first.' });
    if (!await bcrypt.compare(String(pin || ''), driver.rows[0].trip_close_pin_hash)) return res.status(401).json({ error: 'invalid_close_pin', message: 'Incorrect trip-close PIN.' });
    const current = await pool.query(`SELECT mode,seats_filled,seat_capacity FROM trip_sessions WHERE id=$1 AND driver_id=$2 AND status='open'`, [req.params.id, req.auth.id]);
    if (!current.rows.length) return res.status(404).json({ error: 'trip_not_found_or_closed' });
    await pool.query(`UPDATE trip_sessions SET status = 'closed', closed_at = now() WHERE id = $1 AND driver_id=$2`, [req.params.id, req.auth.id]);
    res.json({ status: 'closed' });
});

router.post('/close-pin', requireAuth, requireRole('driver'), async (req, res) => {
    const pin = String(req.body?.pin || '');
    if (!/^\d{4}$/.test(pin)) return res.status(400).json({ message: 'Trip-close PIN must be four digits.' });
    await pool.query('UPDATE drivers SET trip_close_pin_hash=$1 WHERE id=$2', [await bcrypt.hash(pin, 12), req.auth.id]);
    res.json({ success: true });
});

router.post('/refund', requireAuth, requireRole('driver'), async (req, res) => {
    const client = await pool.connect();
    try {
        const rawRegNo=String(req.body?.regNo||'').trim(), amount=Number(req.body?.amount), reason=String(req.body?.reason||'').trim();
        if (!rawRegNo || !Number.isFinite(amount) || amount<=0 || !reason) return res.status(400).json({ message: 'Registration number, amount and reason are required.' });
        const regNo = normalizeLmuRegistrationNumber(rawRegNo);
        if (!regNo) return res.status(400).json({ message: 'Enter the student\'s 7-digit registration number, e.g. 2012345.' });
        await client.query('BEGIN');
        const charge=await client.query(`SELECT tc.*,s.id AS student_id FROM trip_charges tc JOIN students s ON s.id=tc.student_id JOIN trip_sessions ts ON ts.id=tc.trip_session_id WHERE ts.driver_id=$1 AND s.reg_no=$2 AND tc.status='success' ORDER BY tc.created_at DESC LIMIT 1 FOR UPDATE`,[req.auth.id,regNo]);
        if(!charge.rows.length) { await client.query('ROLLBACK');return res.status(404).json({message:'No completed ride charge was found for this student.'}); }
        if(amount>Number(charge.rows[0].fare_amount)){await client.query('ROLLBACK');return res.status(400).json({message:'Refund cannot exceed the charged fare.'});}
        const driver=await client.query('SELECT wallet_balance FROM drivers WHERE id=$1 FOR UPDATE',[req.auth.id]);
        if(Number(driver.rows[0].wallet_balance)<amount){await client.query('ROLLBACK');return res.status(400).json({message:'Your driver wallet does not have enough balance to refund this amount.'});}
        await client.query('UPDATE drivers SET wallet_balance=wallet_balance-$1 WHERE id=$2',[amount,req.auth.id]);
        await client.query('UPDATE students SET wallet_balance=wallet_balance+$1 WHERE id=$2',[amount,charge.rows[0].student_id]);
        await client.query(`INSERT INTO wallet_transactions (student_id,type,amount,status,gateway,description) VALUES ($1,'ride_credit',$2,'success','Driver refund',$3)`,[charge.rows[0].student_id,amount,`Ride refund: ${reason}`]);
        await client.query(`INSERT INTO wallet_transactions (driver_id,type,amount,status,gateway,description) VALUES ($1,'admin_debit',$2,'success','Driver refund',$3)`,[req.auth.id,amount,`Passenger refund to ${regNo}: ${reason}`]);
        await client.query('COMMIT');
        notify({userId:charge.rows[0].student_id,role:'student',title:'Ride refund received',body:`₦${amount.toLocaleString()} was refunded to your wallet. Reason: ${reason}`,type:'ride'}).catch(()=>{});
        res.json({success:true});
    } catch(err){await client.query('ROLLBACK');console.error('[Ride refund]',err);res.status(500).json({message:'Could not complete refund.'});} finally{client.release();}
});

module.exports = router;
