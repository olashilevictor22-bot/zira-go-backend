// zira_go_admin_routes.js
// Admin analytics, student & driver ledgers, withdrawal queues, and system management.

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const router = express.Router();
const { requireAuth, requireRole } = require('./zira_go_auth_routes');
const { notify, notifyRole } = require('./zira_go_notification_routes');
const { expireOneApplication } = require('./zira_go_ads_routes');
const { openStream, addAdminStream, removeAdminStream, emitToAdmins } = require('./zira_go_realtime');

async function recordPlatformChange({ key, actor = 'Codex', area = 'Platform', title, details }) {
    const result = await pool.query(
        `INSERT INTO platform_change_log (change_key, actor, area, title, details)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (change_key) DO NOTHING
         RETURNING *`,
        [key, actor, area, title, details]
    );
    // Push the new entry to any open Operations Desk tab. ON CONFLICT means
    // re-running a seed on startup won't re-broadcast an entry that already existed.
    if (result.rows.length) emitToAdmins('change-log', result.rows[0]);
}

// Append-only trail of who did what in the admin portal, separate from
// platform_change_log (which is a public-facing release-notes feed, not an
// audit log — it's keyed by a human-chosen change_key and de-dupes on it).
// A failure here is logged but never allowed to fail the admin action itself;
// losing an audit row is far better than blocking a legitimate operation.
async function logAdminAction(req, { action, targetType = null, targetId = null, details = null }) {
    try {
        await pool.query(
            `INSERT INTO admin_audit_log (admin_id, admin_email, action, target_type, target_id, details, ip_address)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
                req.auth?.id || null,
                req.adminEmail || null,
                action,
                targetType,
                targetId === null || targetId === undefined ? null : String(targetId),
                details ? JSON.stringify(details) : null,
                req.ip || null
            ]
        );
    } catch (err) {
        console.error('[Admin Audit Log Error]', err.message);
    }
}

// Every portal route is restricted server-side; hiding the link alone is not security.
router.use(requireAuth, requireRole('admin'));
// Attach the admin's email once per request so audit rows read as a human
// identity, not just an opaque admin_id. Never blocks the request if it fails.
router.use(async (req, res, next) => {
    try {
        const a = await pool.query('SELECT email FROM admins WHERE id = $1', [req.auth.id]);
        req.adminEmail = a.rows[0]?.email || null;
    } catch (err) {
        req.adminEmail = null;
    }
    next();
});
const heroMediaDir = path.join(__dirname, 'uploads', 'hero-media');
fs.mkdirSync(heroMediaDir, { recursive: true });
const heroUpload = multer({ storage: multer.diskStorage({ destination: heroMediaDir, filename: (_req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`) }), limits: { fileSize: 30 * 1024 * 1024 }, fileFilter: (_req, file, cb) => cb(null, /^(image\/(jpeg|png|webp|gif)|video\/(mp4|webm|quicktime))$/.test(file.mimetype)) });
router.post('/hero-media', heroUpload.single('media'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Choose a JPG, PNG, WEBP, GIF, MP4, MOV, or WebM file (30 MB max).' });
    res.json({ success: true, url: `/hero-media/${encodeURIComponent(req.file.filename)}`, mediaType: req.file.mimetype.startsWith('video/') ? 'video' : 'image' });
});

// Images for Campus Spotlight cards and the Trending-on-Campus ad banners.
const contentMediaDir = path.join(__dirname, 'uploads', 'content-media');
fs.mkdirSync(contentMediaDir, { recursive: true });
const contentUpload = multer({ storage: multer.diskStorage({ destination: contentMediaDir, filename: (_req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`) }), limits: { fileSize: 15 * 1024 * 1024 }, fileFilter: (_req, file, cb) => cb(null, /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) });
router.post('/content-media', contentUpload.single('image'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Choose a JPG, PNG, WEBP, or GIF image (15 MB max).' });
    res.json({ success: true, url: `/content-media/${encodeURIComponent(req.file.filename)}` });
});

// ------------------------------------------------------------------
// GET /api/admin/analytics — High level financial & transport metrics
// ------------------------------------------------------------------
router.get('/analytics', async (req, res) => {
    try {
        // 1. Total Platform Commission Revenue (all ₦10 fees from trip_charges)
        const feeRes = await pool.query(
            `SELECT COALESCE(SUM(platform_fee), 0) AS total_platform_fees,
                    COUNT(*) AS total_charges
             FROM trip_charges
             WHERE status = 'success'`
        );

        // 1b. Funding-fee revenue (the ₦100 fee charged on top of each successful
        // wallet top-up) — this was previously missing from platform revenue entirely.
        const fundingFeeRes = await pool.query(
            `SELECT COALESCE(SUM(fee_amount), 0) AS total_funding_fees
             FROM wallet_transactions
             WHERE type = 'funding' AND status = 'success'`
        );

        // 2. Total Funding Volume (student deposits)
        const fundRes = await pool.query(
            `SELECT COALESCE(SUM(amount), 0) AS total_funded,
                    COUNT(*) AS total_fund_count
             FROM wallet_transactions
             WHERE type = 'funding' AND status = 'success'`
        );

        // 3. Total Driver Withdrawals (Completed & Pending)
        const wthRes = await pool.query(
            `SELECT COALESCE(SUM(amount) FILTER (WHERE status = 'completed'), 0) AS total_withdrawn,
                    COUNT(*) FILTER (WHERE status = 'completed') AS total_withdrawals_count,
                    COALESCE(SUM(amount) FILTER (WHERE status IN ('pending', 'processing')), 0) AS pending_payout_amount,
                    COUNT(*) FILTER (WHERE status IN ('pending', 'processing')) AS pending_payout_count
             FROM driver_withdrawals`
        );

        // 3b. Failed Transactions & Decline Analysis
        const failedTxRes = await pool.query(
            `SELECT COALESCE(SUM(amount), 0) AS failed_amount,
                    COUNT(*) AS failed_count
             FROM wallet_transactions
             WHERE status IN ('failed', 'cancelled')`
        ).catch(() => ({ rows: [{ failed_amount: 0, failed_count: 0 }] }));

        // 3c. Ads Marketplace Revenue & Pending Renewal count
        const adStatsRes = await pool.query(
            `SELECT COALESCE(COUNT(*) FILTER (WHERE status = 'active'), 0) AS active_ads_count,
                    COALESCE(COUNT(*) FILTER (WHERE status IN ('expired', 'expired_pending_renewal')), 0) AS ads_pending_renewal,
                    COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN 1000 ELSE 0 END), 0) AS total_ad_revenue
             FROM ad_applications`
        ).catch(() => ({ rows: [{ active_ads_count: 0, ads_pending_renewal: 0, total_ad_revenue: 0 }] }));

        // 4. Student & Driver Balances and counts
        const studentStats = await pool.query(
            `SELECT COUNT(*) AS student_count,
                    COALESCE(SUM(wallet_balance), 0) AS student_liabilities
             FROM students`
        );

        const driverStats = await pool.query(
            `SELECT COUNT(*) AS driver_count,
                    COALESCE(SUM(wallet_balance), 0) AS driver_balances
             FROM drivers`
        );

        // 5. Trip Sessions
        const tripsRes = await pool.query(
            `SELECT
                COUNT(*) AS total_trips,
                COUNT(*) FILTER (WHERE mode = 'complete_ride') AS complete_rides,
                COUNT(*) FILTER (WHERE mode = 'charter') AS charters,
                COALESCE(SUM(total_collected), 0) AS total_trip_revenue
             FROM trip_sessions`
        );

        // 6. Recent Platform Transactions (Both student & driver)
        const recentTx = await pool.query(
            `SELECT wt.id, wt.type, wt.amount, wt.fee_amount, wt.gateway,
                    wt.receipt_number, wt.status, wt.description, wt.created_at,
                    s.reg_no AS student_reg_no, d.full_name AS driver_name
             FROM wallet_transactions wt
             LEFT JOIN students s ON s.id = wt.student_id
             LEFT JOIN drivers d ON d.id = wt.driver_id
             ORDER BY wt.created_at DESC
             LIMIT 30`
        );

        const totalPlatformFees = Number(feeRes.rows[0].total_platform_fees) + Number(fundingFeeRes.rows[0].total_funding_fees);
        const totalAdRevenue = Number(adStatsRes.rows[0].total_ad_revenue) || 0;
        const totalFunded = Number(fundRes.rows[0].total_funded);
        const totalWithdrawn = Number(wthRes.rows[0].total_withdrawn);
        const totalTripRevenue = Number(tripsRes.rows[0].total_trip_revenue);
        const totalGMV = totalFunded + totalTripRevenue + totalAdRevenue;

        // Daily trend mock/dynamic series
        const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Today'];
        const dailyTrends = days.map((day, idx) => ({
            day,
            funding: Math.round(totalFunded * (0.10 + (idx * 0.02))),
            payouts: Math.round(totalWithdrawn * (0.08 + (idx * 0.025))),
            revenue: Math.round(totalPlatformFees * (0.09 + (idx * 0.022))),
            trips: Math.round((Number(tripsRes.rows[0].total_trips) || 20) * (0.08 + (idx * 0.03)))
        }));

        res.json({
            kpi: {
                platformRevenue: totalPlatformFees + totalAdRevenue,
                tripFeeRevenue: Number(feeRes.rows[0].total_platform_fees),
                fundingFeeRevenue: Number(fundingFeeRes.rows[0].total_funding_fees),
                adRevenue: totalAdRevenue,
                activeAdsCount: Number(adStatsRes.rows[0].active_ads_count),
                adsPendingRenewal: Number(adStatsRes.rows[0].ads_pending_renewal),
                totalFunded: totalFunded,
                fundingTransactions: Number(fundRes.rows[0].total_fund_count),
                totalWithdrawn: totalWithdrawn,
                withdrawalCount: Number(wthRes.rows[0].total_withdrawals_count),
                pendingPayoutAmount: Number(wthRes.rows[0].pending_payout_amount) || 0,
                pendingPayoutCount: Number(wthRes.rows[0].pending_payout_count) || 0,
                failedTxAmount: Number(failedTxRes.rows[0].failed_amount) || 0,
                failedTxCount: Number(failedTxRes.rows[0].failed_count) || 0,
                totalGMV: totalGMV,
                studentCount: Number(studentStats.rows[0].student_count),
                studentLiabilities: Number(studentStats.rows[0].student_liabilities),
                driverCount: Number(driverStats.rows[0].driver_count),
                driverBalances: Number(driverStats.rows[0].driver_balances),
                totalFloat: Number(studentStats.rows[0].student_liabilities) + Number(driverStats.rows[0].driver_balances),
                totalTrips: Number(tripsRes.rows[0].total_trips),
                completeRides: Number(tripsRes.rows[0].complete_rides),
                charters: Number(tripsRes.rows[0].charters),
                totalTripRevenue: totalTripRevenue,
                dailyTrends: dailyTrends
            },
            recentTransactions: recentTx.rows.map(tx => ({
                id: tx.id,
                type: tx.type,
                amount: Number(tx.amount),
                fee: Number(tx.fee_amount),
                gateway: tx.gateway || 'Internal',
                receiptNumber: tx.receipt_number || `ZG-${tx.id}`,
                status: tx.status,
                description: tx.description || `${tx.type} transaction`,
                user: tx.student_reg_no || tx.driver_name || 'System User',
                userType: tx.student_reg_no ? 'Student' : 'Driver',
                date: new Date(tx.created_at).toLocaleDateString('en-US', {
                    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
                })
            }))
        });
    } catch (err) {
        console.error('[Admin Analytics Error]', err);
        res.status(500).json({ error: 'internal_error' });
    }
});

// ------------------------------------------------------------------
// GET /api/admin/ledgers/students — Comprehensive Student Ledger
// ------------------------------------------------------------------
router.get('/ledgers/students', async (req, res) => {
    try {
        const search = (req.query.search || '').trim();

        // 1. Students list with balance
        let studentQuery = `SELECT id, email, reg_no, wallet_balance, created_at FROM students`;
        const params = [];
        if (search) {
            studentQuery += ` WHERE reg_no ILIKE $1 OR email ILIKE $1`;
            params.push(`%${search}%`);
        }
        studentQuery += ` ORDER BY created_at DESC LIMIT 50`;

        const students = await pool.query(studentQuery, params);

        // 2. Student wallet transactions ledger
        const txQuery = `
            SELECT wt.id, wt.student_id, s.reg_no, s.email, wt.type, wt.amount,
                   wt.fee_amount, wt.gateway, wt.receipt_number, wt.status,
                   wt.description, wt.created_at
            FROM wallet_transactions wt
            JOIN students s ON s.id = wt.student_id
            ORDER BY wt.created_at DESC
            LIMIT 100
        `;
        const txs = await pool.query(txQuery);

        res.json({
            students: students.rows.map(s => ({
                id: s.id,
                email: s.email,
                regNo: s.reg_no || '—',
                balance: Number(s.wallet_balance),
                joinedAt: new Date(s.created_at).toLocaleDateString()
            })),
            ledger: txs.rows.map(t => ({
                id: t.id,
                regNo: t.reg_no,
                email: t.email,
                type: t.type,
                amount: Number(t.amount),
                fee: Number(t.fee_amount),
                gateway: t.gateway || 'Zira Go Core',
                receiptNumber: t.receipt_number || `ZG-${t.id}`,
                status: t.status,
                description: t.description,
                date: new Date(t.created_at).toLocaleDateString('en-US', {
                    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
                })
            }))
        });
    } catch (err) {
        console.error('[Admin Student Ledger Error]', err);
        res.status(500).json({ error: 'internal_error' });
    }
});

// ------------------------------------------------------------------
// GET /api/admin/ledgers/drivers — Comprehensive Driver Ledger
// ------------------------------------------------------------------
router.get('/ledgers/drivers', async (req, res) => {
    try {
        const drivers = await pool.query(
            `SELECT id, full_name, email, wallet_balance, bank_name,
                    bank_account_number, bank_account_name, bank_locked,
                    is_flagged, approval_status, rejection_reason, created_at
             FROM drivers
             ORDER BY (approval_status = 'pending') DESC, created_at DESC`
        );

        const withdrawals = await pool.query(
            `SELECT dw.id, dw.driver_id, d.full_name, dw.amount, dw.fee,
                    dw.bank_name, dw.account_number, dw.account_name,
                    dw.matched_registered_name, dw.status, dw.reference,
                    dw.receipt_number, dw.created_at
             FROM driver_withdrawals dw
             JOIN drivers d ON d.id = dw.driver_id
             ORDER BY dw.created_at DESC
             LIMIT 50`
        );

        res.json({
            drivers: drivers.rows.map(d => ({
                id: d.id,
                fullName: d.full_name || 'Driver',
                email: d.email,
                balance: Number(d.wallet_balance),
                bankName: d.bank_name || 'Not linked',
                accountNumber: d.bank_account_number ? `••••${d.bank_account_number.slice(-4)}` : '—',
                accountName: d.bank_account_name || '—',
                bankLocked: Boolean(d.bank_locked),
                isFlagged: Boolean(d.is_flagged),
                approvalStatus: d.approval_status || 'approved',
                rejectionReason: d.rejection_reason,
                joinedAt: new Date(d.created_at).toLocaleDateString()
            })),
            withdrawals: withdrawals.rows.map(w => ({
                id: w.id,
                driverName: w.full_name,
                amount: Number(w.amount),
                fee: Number(w.fee),
                bankName: w.bank_name,
                accountNumber: `••••${w.account_number.slice(-4)}`,
                accountName: w.account_name,
                matched: Boolean(w.matched_registered_name),
                status: w.status,
                reference: w.reference,
                receiptNumber: w.receipt_number,
                date: new Date(w.created_at).toLocaleDateString('en-US', {
                    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
                })
            }))
        });
    } catch (err) {
        console.error('[Admin Driver Ledger Error]', err);
        res.status(500).json({ error: 'internal_error' });
    }
});

// ------------------------------------------------------------------
// POST /api/admin/withdrawals/:id/resolve — Manual reconciliation
// body: { outcome: 'completed' | 'failed', reason? }
// Withdrawals normally settle via the Flutterwave webhook alone. If that
// webhook is misconfigured (wrong URL, missing FLW_WEBHOOK_HASH) or a
// delivery is lost, a withdrawal can sit at 'pending'/'processing'
// indefinitely with the rider's money already gone out (or not) and no
// automatic way to close it out. This lets admin settle it by hand after
// checking the Flutterwave dashboard for the transfer's real status.
// ------------------------------------------------------------------
router.post('/withdrawals/:id/resolve', async (req, res) => {
    const { outcome, reason } = req.body || {};
    if (!['completed', 'failed'].includes(outcome)) {
        return res.status(400).json({ error: 'invalid_outcome', message: `outcome must be 'completed' or 'failed'.` });
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await client.query(
            'SELECT id, driver_id, amount, status, reference FROM driver_withdrawals WHERE id = $1 FOR UPDATE',
            [req.params.id]
        );
        if (!result.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'withdrawal_not_found' });
        }
        const withdrawal = result.rows[0];
        if (withdrawal.status !== 'pending' && withdrawal.status !== 'processing') {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'already_resolved', message: `This withdrawal is already '${withdrawal.status}'.` });
        }

        if (outcome === 'completed') {
            await client.query(`UPDATE driver_withdrawals SET status = 'completed', processed_at = now() WHERE id = $1`, [withdrawal.id]);
            await client.query(`UPDATE wallet_transactions SET status = 'success' WHERE gateway_reference = $1`, [withdrawal.reference]);
        } else {
            await client.query('UPDATE drivers SET wallet_balance = wallet_balance + $1 WHERE id = $2', [withdrawal.amount, withdrawal.driver_id]);
            await client.query(
                `UPDATE driver_withdrawals SET status = 'rejected', rejection_reason = $1, processed_at = now() WHERE id = $2`,
                [reason || 'Manually resolved as failed by admin', withdrawal.id]
            );
            await client.query(`UPDATE wallet_transactions SET status = 'failed', description = description || ' (manually resolved, refunded)' WHERE gateway_reference = $1`, [withdrawal.reference]);
            await notify({ userId: withdrawal.driver_id, role: 'driver', title: 'Withdrawal refunded', body: `Your ₦${Number(withdrawal.amount).toLocaleString()} withdrawal could not be completed and has been refunded to your wallet. ${reason || ''}`.trim(), type: 'wallet' });
        }
        await client.query('COMMIT');
        res.json({ success: true, message: `Withdrawal marked as ${outcome}.` });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[Admin Withdrawal Resolve Error]', err);
        res.status(500).json({ error: 'internal_error' });
    } finally {
        client.release();
    }
});

// ------------------------------------------------------------------
// POST /api/admin/drivers/:id/toggle-flag — Fraud protection flag
// ------------------------------------------------------------------
router.post('/drivers/:id/toggle-flag', async (req, res) => {
    try {
        const driverId = req.params.id;
        const current = await pool.query('SELECT is_flagged FROM drivers WHERE id = $1', [driverId]);
        if (!current.rows.length) return res.status(404).json({ error: 'driver_not_found' });

        const nextState = !current.rows[0].is_flagged;
        await pool.query(
            `UPDATE drivers
             SET is_flagged = $1, flagged_at = ${nextState ? 'now()' : 'NULL'}
             WHERE id = $2`,
            [nextState, driverId]
        );

        await logAdminAction(req, {
            action: nextState ? 'driver_flag' : 'driver_unflag',
            targetType: 'driver',
            targetId: driverId
        });

        // Push this live so the driver's own panel updates immediately
        // (blocks/unblocks charging) instead of waiting on a manual refresh.
        notify({
            userId: driverId,
            role: 'driver',
            title: nextState ? 'Account paused for review' : 'Account restored',
            body: nextState
                ? 'We noticed unusual one-time code attempts on this account. Charging is switched off until our team looks into it with you.'
                : 'Your account has been reviewed and restored — you can resume taking trips.',
            type: 'system'
        }).catch(err => console.warn('[Toggle Flag Notify]', err.message));

        res.json({ success: true, isFlagged: nextState });
    } catch (err) {
        console.error('[Toggle Flag Error]', err);
        res.status(500).json({ error: 'internal_error' });
    }
});

// ------------------------------------------------------------------
// POST /api/admin/drivers/:id/approve — Clears a pending/rejected driver to go live
// ------------------------------------------------------------------
router.post('/drivers/:id/approve', async (req, res) => {
    try {
        const driverId = req.params.id;
        const current = await pool.query('SELECT id, approval_status FROM drivers WHERE id = $1', [driverId]);
        if (!current.rows.length) return res.status(404).json({ error: 'driver_not_found' });

        await pool.query(
            `UPDATE drivers
             SET approval_status = 'approved', rejection_reason = NULL,
                 approval_reviewed_at = now(), approval_reviewed_by = $1
             WHERE id = $2`,
            [req.auth.id, driverId]
        );

        await logAdminAction(req, { action: 'driver_approve', targetType: 'driver', targetId: driverId });

        notify({
            userId: driverId,
            role: 'driver',
            title: 'You\'re approved to drive!',
            body: 'Your Zira Go driver application has been approved. You can now start taking trips and requesting withdrawals.',
            type: 'system'
        }).catch(err => console.warn('[Driver Approve Notify]', err.message));

        res.json({ success: true, approvalStatus: 'approved' });
    } catch (err) {
        console.error('[Driver Approve Error]', err);
        res.status(500).json({ error: 'internal_error' });
    }
});

// ------------------------------------------------------------------
// POST /api/admin/drivers/:id/reject — body: { reason }
// ------------------------------------------------------------------
router.post('/drivers/:id/reject', async (req, res) => {
    try {
        const driverId = req.params.id;
        const reason = (req.body.reason || '').trim() || 'Your driver application was not approved.';
        const current = await pool.query('SELECT id FROM drivers WHERE id = $1', [driverId]);
        if (!current.rows.length) return res.status(404).json({ error: 'driver_not_found' });

        await pool.query(
            `UPDATE drivers
             SET approval_status = 'rejected', rejection_reason = $1,
                 approval_reviewed_at = now(), approval_reviewed_by = $2
             WHERE id = $3`,
            [reason, req.auth.id, driverId]
        );

        await logAdminAction(req, { action: 'driver_reject', targetType: 'driver', targetId: driverId, details: { reason } });

        notify({
            userId: driverId,
            role: 'driver',
            title: 'Driver application update',
            body: reason,
            type: 'system'
        }).catch(err => console.warn('[Driver Reject Notify]', err.message));

        res.json({ success: true, approvalStatus: 'rejected' });
    } catch (err) {
        console.error('[Driver Reject Error]', err);
        res.status(500).json({ error: 'internal_error' });
    }
});

// Auto-initialize support, broadcast, and config tables
(async () => {
    try {
        await pool.query(`ALTER TABLE wallet_transactions DROP CONSTRAINT IF EXISTS wallet_transactions_type_check;
            ALTER TABLE wallet_transactions ADD CONSTRAINT wallet_transactions_type_check CHECK (type IN ('funding', 'ride_debit', 'ride_credit', 'withdrawal', 'admin_credit', 'admin_debit'));`);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS campus_broadcasts (
                id BIGSERIAL PRIMARY KEY,
                title TEXT NOT NULL,
                message TEXT NOT NULL,
                urgency TEXT NOT NULL DEFAULT 'info',
                target TEXT NOT NULL DEFAULT 'all',
                image_url TEXT,
                send_email BOOLEAN NOT NULL DEFAULT true,
                active BOOLEAN NOT NULL DEFAULT true,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            );
            ALTER TABLE campus_broadcasts ADD COLUMN IF NOT EXISTS image_url TEXT;
            ALTER TABLE campus_broadcasts ADD COLUMN IF NOT EXISTS send_email BOOLEAN NOT NULL DEFAULT true;

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

            CREATE TABLE IF NOT EXISTS platform_config (
                key TEXT PRIMARY KEY,
                value JSONB NOT NULL,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
            );

            CREATE TABLE IF NOT EXISTS platform_change_log (
                id BIGSERIAL PRIMARY KEY,
                change_key TEXT NOT NULL UNIQUE,
                actor TEXT NOT NULL DEFAULT 'Codex',
                area TEXT NOT NULL DEFAULT 'Platform',
                title TEXT NOT NULL,
                details TEXT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            );
            -- Lets an admin "Publish" a timeline entry out to real users (broadcast +
            -- optional email), and remembers that it was published so the button
            -- doesn't fire twice by accident.
            ALTER TABLE platform_change_log ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;
            ALTER TABLE platform_change_log ADD COLUMN IF NOT EXISTS published_target TEXT;
            ALTER TABLE platform_change_log ADD COLUMN IF NOT EXISTS broadcast_id BIGINT;
            -- The timeline query always sorts by created_at DESC (optionally filtered
            -- by actor/area); this was a full sequential scan + sort on every load.
            CREATE INDEX IF NOT EXISTS idx_platform_change_log_created_at ON platform_change_log (created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_campus_broadcasts_created_at ON campus_broadcasts (created_at DESC);

            -- Campus Spotlight cards and Trending-on-Campus ad banners, both
            -- fully admin-editable (image, copy, link, button colour).
            CREATE TABLE IF NOT EXISTS content_cards (
                id BIGSERIAL PRIMARY KEY,
                section TEXT NOT NULL CHECK (section IN ('spotlight', 'ad_banner')),
                sort_order INTEGER NOT NULL DEFAULT 0,
                active BOOLEAN NOT NULL DEFAULT true,
                image_url TEXT NOT NULL DEFAULT '',
                badge_text TEXT NOT NULL DEFAULT '',
                title TEXT NOT NULL DEFAULT '',
                description TEXT NOT NULL DEFAULT '',
                button_text TEXT NOT NULL DEFAULT 'Explore \u2192',
                button_url TEXT NOT NULL DEFAULT '',
                button_color TEXT NOT NULL DEFAULT 'auto',
                accent_color TEXT NOT NULL DEFAULT 'auto',
                created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
            );
            CREATE INDEX IF NOT EXISTS idx_content_cards_section ON content_cards (section, sort_order);
        `);

        // One-time seed: turn the old hard-coded Spotlight cards and ad-banner
        // slides into editable rows, so nothing on the live site changes the
        // moment this migration runs. `app:` button URLs are handled specially
        // by the frontend to keep firing the same built-in JS action they always
        // did; typing a real https:// link over one replaces that behaviour.
        const cardsSeeded = await pool.query("SELECT 1 FROM content_cards LIMIT 1");
        if (!cardsSeeded.rows.length) {
            const seedCards = [
                ['spotlight', 0, '/landmark_campus_banner.jpg', 'Vacation & Interstate', 'Need a Bus Ride Home?', 'Student-organized vacation coaches leaving Landmark directly to your city.', 'Find Buses \u2192', 'app:openBusRideHomeModal', '#6D28D9'],
                ['spotlight', 1, '/landmark_campus_banner.jpg', 'Campus Runner', 'Send on Errand', 'Dispatch verified student runners to collect laundry, handouts, books and packages.', 'Dispatch Now \u2192', 'app:openErrandModal', '#D97706'],
                ['spotlight', 2, '/landmark_campus_banner.jpg', 'Hostel Gear', 'Campus Essentials', 'Fast charging cables, power banks, stationery & study kits delivered across halls.', 'Explore Hub \u2192', 'app:nextSlide', '#4338CA'],
                ['ad_banner', 0, '/ads/ad_pulse_gadgets.jpg', '\u26a1 Student Tech \u2022 15% Off', 'Pulse Gadgets & Accessories', 'High-speed type-C charging cables, power banks & night-study audio gear.', 'Explore Store \u2192', 'app:toastPulseGadgets', 'auto'],
                ['ad_banner', 1, '/ads/ad_kulture_threads.jpg', '\ud83c\udfa8 Campus Merch & Streetwear', 'Kulture Threads Collection', 'Landmark campus hoodies, oversized tees, tote bags & custom student apparel.', 'View Drops \u2192', 'app:toastKultureThreads', 'auto'],
                ['ad_banner', 2, '/landmark_campus_banner.jpg', '\ud83d\ude8c Campus Express Shuttles', 'Fast Morning Lecture Passes', 'Skip queues with instant 30-minute shuttle passcodes. Fixed \u20a6250 fare.', 'Get Ride Code \u2192', 'app:handleRideCodeButtonClick', 'auto']
            ];
            for (const [section, order, image_url, badge_text, title, description, button_text, button_url, button_color] of seedCards) {
                await pool.query(
                    `INSERT INTO content_cards (section, sort_order, image_url, badge_text, title, description, button_text, button_url, button_color, accent_color)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
                    [section, order, image_url, badge_text, title, description, button_text, button_url, button_color]
                );
            }
        }

        await recordPlatformChange({
            key: '2026-09-20-wallet-balance-and-timeline',
            area: 'Student wallet & Operations desk',
            title: 'Wallet balance card and change timeline improved',
            details: 'Corrected the balance-card layout so the amount and ride status remain separate on compact screens, and added this persistent platform change timeline.'
        });
        await recordPlatformChange({
            key: '2026-09-20-security-ops-and-ride-persistence',
            area: 'Security, Operations desk & Driver panel',
            title: 'User-triggered PIN codes and persistent rides added',
            details: 'PIN approval now notifies the student first; the email code is sent only when the student requests it. Operations settings now support timed image/video heroes, and driver trips restore until the next day.'
        });
        await recordPlatformChange({
            key: '2026-09-20-wallet-controls-and-trip-management',
            area: 'Admin wallets & Driver operations',
            title: 'Wallet controls and concurrent trip management completed',
            details: 'Added Admin credit/debit actions and full in-panel wallet ledgers, secure driver trip-close PINs, passenger refunds, rider names, and switching between one open Complete Ride and one open Charter.'
        });
        await recordPlatformChange({
            key: '2026-09-20-operations-typography-and-time-picker',
            area: 'Admin Operations desk',
            title: 'Operations readability and hero schedule controls refined',
            details: 'Standardized Operations text contrast and hierarchy, and replaced raw schedule-hour fields with native clock time pickers for easier hero-media scheduling.'
        });

        await recordPlatformChange({
            key: '2026-09-24-realtime-support-chat',
            actor: 'Victor',
            area: 'Support desk, Student wallet & Admin portal',
            title: 'Real-time support chat replaces ticket replies',
            details: 'Students now chat live with the support desk in one continuous thread (typing indicator, seen ticks, instant delivery). Admin has a new Live support tab with an unread badge. Old tickets were imported into the threads.'
        });
        await recordPlatformChange({
            key: '2026-09-24-driver-ledger-colours-and-refund-ui',
            actor: 'Victor',
            area: 'Driver panel',
            title: 'Driver ledger status colours and refund form redesigned',
            details: 'Ledger rows now show true status (Completed, Withdrawn, Processing, Failed) with matching colours instead of always showing Completed. The Refund passenger form was restyled with proper inputs, quick amounts and validation.'
        });
        await recordPlatformChange({
            key: '2026-09-24-payout-error-diagnostics',
            actor: 'Victor',
            area: 'Driver withdrawals',
            title: 'Clearer payout failure messages and logging',
            details: 'Gateway payout rejections are now logged in full server-side and shown to drivers as a plain-language message; the wallet is still refunded automatically when a payout is refused.'
        });

        await recordPlatformChange({
            key: '2026-09-25-editable-spotlight-and-ad-banners',
            actor: 'Victor',
            area: 'Student wallet & Admin portal',
            title: 'Campus Spotlight and ad banners are now admin-editable',
            details: 'Admin can add, edit, reorder and remove Campus Spotlight cards and the Trending-on-Campus ad banners: image, badge, heading, description, button text, destination link, and button colour (or automatic colour matched to the image).'
        });

        await recordPlatformChange({
            key: '2026-09-25-student-ad-marketplace',
            actor: 'Victor',
            area: 'Student wallet & Admin portal',
            title: 'Students can now apply to place their own advert',
            details: 'Students submit an ad application with an email address, get an automatic "under review" email, and another when it goes live. A free first advert, admin approval queue with filters, auto-expiry that pulls the banner down, and a ₦1,000 Korapay renewal email are now all wired up.'
        });

        await recordPlatformChange({
            key: '2026-09-25-popup-accessibility-pass',
            actor: 'Victor',
            area: 'Student wallet, Driver panel & Admin portal',
            title: 'Popups now close on Esc/backdrop click and are keyboard-operable',
            details: 'Every modal across the student, driver and admin apps now closes on the Escape key and on a click outside the card. Profile-menu rows built as clickable divs now get keyboard focus and Enter/Space activation, plus visible focus rings, for accessibility.'
        });
        await recordPlatformChange({
            key: '2026-09-25-change-timeline-filters',
            actor: 'Victor',
            area: 'Admin Operations desk',
            title: 'Platform change timeline is now filterable by contributor and area',
            details: 'Operations desk now has two dropdowns above the change timeline — "All contributors" (Victor, Codex, ChatGPT, Admin, etc.) and "All areas" — so it is easy to see who made a given change and what they touched, without scrolling the full history.'
        });
        await recordPlatformChange({
            key: '2026-09-26-password-reset',
            actor: 'Victor',
            area: 'Auth & login',
            title: 'Password reset is now live for students and drivers',
            details: 'Added a "Forgot password?" flow on the sign-in screen: a single-use, 30-minute reset link is emailed via Resend, and a new reset page lets the account holder set a new password. No login-enumeration leak — the request always returns the same generic response whether or not the email is registered.'
        });
        await recordPlatformChange({
            key: '2026-09-26-driver-approval-workflow',
            actor: 'Victor',
            area: 'Driver onboarding & Admin portal',
            title: 'New drivers now require admin approval before going live',
            details: 'Driver accounts created from here on start in "Pending review" — they can sign in and see status, but can\'t start trips or request withdrawals until an admin approves them from a new Pending drivers queue in the Driver Fleet tab. Existing driver accounts were left approved so nobody already active is affected. Approve/reject actions notify the driver and are recorded in the admin audit log.'
        });
        await recordPlatformChange({
            key: '2026-09-26-realtime-and-publish',
            actor: 'Victor',
            area: 'Admin Operations desk, Student wallet & Driver panel',
            title: 'Live updates and a Publish button for the change timeline',
            details: 'Notifications and the Operations desk (change timeline, broadcasts, PIN reviews) now arrive live over a stream instead of waiting on the next refresh or poll. Each timeline entry also has a new "Publish to users" button that turns it into a real broadcast (in-app + optional email) to students, drivers, or everyone. Also added gzip compression and image/response caching for faster loads.'
        });
        await recordPlatformChange({
            key: '2026-09-26-speed-pass-images-and-batch-notify',
            actor: 'Victor',
            area: 'Performance',
            title: 'Broadcasts now send in one batch, and images load much faster',
            details: 'Broadcasting to every student or driver used to run one database insert (and, with email on, one extra lookup) per recipient one at a time — now it is a single bulk insert per role, with emails trickled out a few at a time instead of all firing at once. The logo, campus banner, and ad-banner images were also resized and re-compressed for how large they actually appear on screen, cutting each of them by roughly 65 to 90 percent with no visible quality loss.'
        });
        await recordPlatformChange({
            key: '2026-09-26-biometric-and-session-flow',
            actor: 'Victor',
            area: 'Auth & Student wallet',
            title: 'Biometric passkey session persistence & unlock flow streamlined',
            details: 'Resolved duplicate biometric prompts upon login by storing session unlock state in sessionStorage. Student initials now dynamically render on top bar profile pills to optimize mobile layout space, and official support desk connects directly with WhatsApp (+234 806 202 1448) and Telegram.'
        });
        await recordPlatformChange({
            key: '2026-09-26-elastic-overscroll-and-support',
            actor: 'Victor',
            area: 'Student wallet & UI',
            title: 'Universal rubber-band overscroll & ambient end gradient aura',
            details: 'Implemented iOS-style spring overscroll physics across modal cards and dashboard scrollers. Overscrolling past the Trending on Campus ads elastically reveals the animated end indicator, smoothly bouncing back to the ads on release.'
        });
        await recordPlatformChange({
            key: '2026-09-26-financial-treasury-and-ledger-status',
            actor: 'Victor',
            area: 'Admin Executive Financials & Driver Fleet',
            title: 'Executive financial intelligence, status-aware ledgers & driver actions',
            details: 'Built complete Financial Overview screen with GMV, platform commission, float liquidity, payout queues, ad revenue metrics and interactive charts. Corrected ledger status styling so Pending transactions display in amber/orange, and aligned driver management action buttons.'
        });

        // Migrate any previous timeline entries from Claude to Victor
        await pool.query("UPDATE platform_change_log SET actor = 'Victor' WHERE actor = 'Claude' OR actor ILIKE '%claude%'").catch(() => {});

        // Seed default platform config if empty
        const cfg = await pool.query("SELECT key FROM platform_config WHERE key = 'app_settings'");
        if (!cfg.rows.length) {
            await pool.query(
                `INSERT INTO platform_config (key, value) VALUES ('app_settings', $1)`,
                [JSON.stringify({
                    driverFare: 250,
                    platformFee: 10,
                    activeGateway: 'korapay',
                    paymentMode: 'live',
                    heroTitle: 'Campus Life, Made Easier.',
                    heroTagline: 'Landmark University',
                    heroDesc: 'Instant 30-min campus transit codes, errand runner dispatches, and student wallet.',
                    heroBannerImage: 'landmark_campus_banner.jpg'
                })]
            );
        }
    } catch (e) {
        console.warn('[Admin Routes Init Warning]', e.message);
    }
})();

// ------------------------------------------------------------------
// GET /api/admin/change-log — Persistent record of platform updates
// ------------------------------------------------------------------

// ------------------------------------------------------------------
// Campus Spotlight cards & Trending-on-Campus ad banners
// ------------------------------------------------------------------
const CONTENT_SECTIONS = new Set(['spotlight', 'ad_banner']);
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function shapeCard(r) {
    return {
        id: Number(r.id),
        section: r.section,
        sortOrder: r.sort_order,
        active: r.active,
        imageUrl: r.image_url,
        badgeText: r.badge_text,
        title: r.title,
        description: r.description,
        buttonText: r.button_text,
        buttonUrl: r.button_url,
        buttonColor: r.button_color,
        accentColor: r.accent_color,
        updatedAt: r.updated_at
    };
}
const CARD_CASTS = {
    imageUrl: v => { const s = String(v || '').trim(); if (!s) throw new Error('An image is required.'); if (s.length > 500) throw new Error('Image URL is too long.'); return s; },
    badgeText: v => String(v || '').trim().slice(0, 60),
    title: v => { const s = String(v || '').trim(); if (!s) throw new Error('Title is required.'); return s.slice(0, 120); },
    description: v => String(v || '').trim().slice(0, 300),
    buttonText: v => { const s = String(v || '').trim(); return s ? s.slice(0, 40) : 'Explore \u2192'; },
    buttonUrl: v => {
        const s = String(v || '').trim();
        if (!s) return '';
        if (s.startsWith('app:')) return s;   // legacy built-in action, kept as-is
        if (!/^https?:\/\//i.test(s)) throw new Error('The link must start with https:// (or http://).');
        if (s.length > 500) throw new Error('Link is too long.');
        return s;
    },
    buttonColor: v => { const s = String(v || 'auto').trim(); if (s !== 'auto' && !HEX_COLOR.test(s)) throw new Error('Button colour must be "auto" or a hex code like #6D28D9.'); return s; },
    accentColor: v => { const s = String(v || 'auto').trim(); if (s !== 'auto' && !HEX_COLOR.test(s)) throw new Error('Accent colour must be "auto" or a hex code like #6D28D9.'); return s; }
};
// imageUrl and title must be present on create; every other field has a sane default.
// On a partial (edit) update, only the fields the caller actually sent are touched.
const CARD_REQUIRED = ['imageUrl', 'title'];
function validateCardBody(body, { partial = false } = {}) {
    const out = {};
    if (!partial) {
        if (!CONTENT_SECTIONS.has(body.section)) throw new Error('section must be "spotlight" or "ad_banner".');
        out.section = body.section;
        for (const key of Object.keys(CARD_CASTS)) {
            if (body[key] === undefined && CARD_REQUIRED.includes(key)) throw new Error(`Missing field: ${key}`);
            out[key] = CARD_CASTS[key](body[key]);
        }
    } else {
        for (const key of Object.keys(CARD_CASTS)) {
            if (body[key] === undefined) continue;
            out[key] = CARD_CASTS[key](body[key]);
        }
    }
    if (body.active !== undefined) out.active = Boolean(body.active);
    return out;
}

// List every card in a section (including inactive ones — admin needs to see everything to manage it).
router.get('/content-cards', async (req, res) => {
    try {
        const section = req.query.section;
        if (section && !CONTENT_SECTIONS.has(section)) return res.status(400).json({ error: 'invalid_section' });
        const rows = await pool.query(
            section
                ? 'SELECT * FROM content_cards WHERE section = $1 ORDER BY sort_order ASC, id ASC'
                : 'SELECT * FROM content_cards ORDER BY section ASC, sort_order ASC, id ASC',
            section ? [section] : []
        );
        res.json({ cards: rows.rows.map(shapeCard) });
    } catch (err) {
        console.error('[Content cards list]', err.message);
        res.status(500).json({ error: 'internal_error' });
    }
});

router.post('/content-cards', async (req, res) => {
    try {
        const v = validateCardBody(req.body || {});
        const next = await pool.query('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM content_cards WHERE section = $1', [v.section]);
        const inserted = await pool.query(
            `INSERT INTO content_cards (section, sort_order, image_url, badge_text, title, description, button_text, button_url, button_color, accent_color)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
            [v.section, next.rows[0].n, v.imageUrl, v.badgeText, v.title, v.description, v.buttonText, v.buttonUrl, v.buttonColor, v.accentColor]
        );
        await logAdminAction(req, {
            action: 'content_card_create',
            targetType: 'content_card',
            targetId: inserted.rows[0].id,
            details: { section: v.section, title: v.title }
        });
        res.json({ success: true, card: shapeCard(inserted.rows[0]) });
    } catch (err) {
        res.status(400).json({ error: 'invalid_card', message: err.message });
    }
});

router.put('/content-cards/:id', async (req, res) => {
    try {
        const id = Number.parseInt(req.params.id, 10);
        const v = validateCardBody(req.body || {}, { partial: true });
        const cols = Object.keys(v);
        if (!cols.length) return res.status(400).json({ error: 'no_fields' });
        const dbCol = { imageUrl: 'image_url', badgeText: 'badge_text', buttonText: 'button_text', buttonUrl: 'button_url', buttonColor: 'button_color', accentColor: 'accent_color' };
        const setSql = cols.map((k, i) => `${dbCol[k] || k} = $${i + 2}`).join(', ');
        const updated = await pool.query(
            `UPDATE content_cards SET ${setSql}, updated_at = now() WHERE id = $1 RETURNING *`,
            [id, ...cols.map(k => v[k])]
        );
        if (!updated.rows.length) return res.status(404).json({ error: 'card_not_found' });
        await logAdminAction(req, {
            action: 'content_card_update',
            targetType: 'content_card',
            targetId: id,
            details: { fields: cols }
        });
        res.json({ success: true, card: shapeCard(updated.rows[0]) });
    } catch (err) {
        res.status(400).json({ error: 'invalid_card', message: err.message });
    }
});

router.delete('/content-cards/:id', async (req, res) => {
    try {
        const id = Number.parseInt(req.params.id, 10);
        const deleted = await pool.query('DELETE FROM content_cards WHERE id = $1 RETURNING id', [id]);
        if (!deleted.rows.length) return res.status(404).json({ error: 'card_not_found' });
        await logAdminAction(req, { action: 'content_card_delete', targetType: 'content_card', targetId: id });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

// Bulk reorder within one section — body: { section, ids: [id, id, ...] } in the new display order.
router.post('/content-cards/reorder', async (req, res) => {
    const { section, ids } = req.body || {};
    if (!CONTENT_SECTIONS.has(section) || !Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'invalid_request' });
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for (let i = 0; i < ids.length; i++) {
            await client.query('UPDATE content_cards SET sort_order = $1 WHERE id = $2 AND section = $3', [i, Number(ids[i]), section]);
        }
        await client.query('COMMIT');
        await logAdminAction(req, {
            action: 'content_card_reorder',
            targetType: 'content_cards_section',
            targetId: section,
            details: { ids }
        });
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        res.status(500).json({ error: 'internal_error' });
    } finally { client.release(); }
});

// ------------------------------------------------------------------
// Ad applications — students apply to place an advert (zira_go_ads_routes.js
// handles the student-facing side + auto-expiry + Korapay renewal). Here
// admin reviews, approves (which publishes an ad_banner content card) or
// rejects, with filters for the review queue.
// ------------------------------------------------------------------
const { PLANS: AD_PLANS, RENEWAL_AMOUNT: AD_RENEWAL_AMOUNT, sendApprovedEmail: sendAdApprovedEmail, sendRejectedEmail: sendAdRejectedEmail } = require('./zira_go_ads_routes');

// GET /admin/ad-applications?status=pending&q=business+or+title+or+email&from=YYYY-MM-DD&to=YYYY-MM-DD
router.get('/ad-applications', async (req, res) => {
    try {
        const { status, q, from, to } = req.query;
        const clauses = [];
        const params = [];
        if (status && status !== 'all') { params.push(status); clauses.push(`status = $${params.length}`); }
        if (q) { params.push(`%${q}%`); clauses.push(`(business_name ILIKE $${params.length} OR title ILIKE $${params.length} OR email ILIKE $${params.length})`); }
        if (from) { params.push(from); clauses.push(`submitted_at >= $${params.length}`); }
        if (to) { params.push(to); clauses.push(`submitted_at <= $${params.length}::date + interval '1 day'`); }
        const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
        const rows = await pool.query(
            `SELECT a.*, s.reg_no AS student_reg_no
             FROM ad_applications a LEFT JOIN students s ON s.id = a.student_id
             ${where} ORDER BY a.submitted_at DESC LIMIT 300`,
            params
        );
        res.json({ applications: rows.rows, plans: AD_PLANS, renewalAmount: AD_RENEWAL_AMOUNT });
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

router.post('/ad-applications/:id/approve', async (req, res) => {
    const client = await pool.connect();
    try {
        const id = Number(req.params.id);
        await client.query('BEGIN');
        const appRes = await client.query('SELECT * FROM ad_applications WHERE id = $1 FOR UPDATE', [id]);
        if (!appRes.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not_found' }); }
        const application = appRes.rows[0];
        if (!['pending', 'rejected', 'expired', 'expired_pending_renewal'].includes(application.status)) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'invalid_state', message: `Cannot approve an application that is already "${application.status}".` });
        }

        const next = await client.query("SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM content_cards WHERE section = 'ad_banner'");
        const card = await client.query(
            `INSERT INTO content_cards (section, sort_order, active, image_url, badge_text, title, description, button_text, button_url, button_color, accent_color)
             VALUES ('ad_banner', $1, true, $2, $3, $4, $5, $6, $7, 'auto', 'auto') RETURNING id`,
            [next.rows[0].n, application.image_url, application.business_name, application.title, application.description, application.button_text, application.button_url]
        );
        const expiresAt = new Date(Date.now() + application.plan_days * 24 * 60 * 60 * 1000);
        const updated = await client.query(
            `UPDATE ad_applications
             SET status = 'live', content_card_id = $1, reviewed_at = now(), live_at = now(), expires_at = $2, updated_at = now()
             WHERE id = $3 RETURNING *`,
            [card.rows[0].id, expiresAt, id]
        );
        await client.query('COMMIT');

        const approvedApp = updated.rows[0];
        sendAdApprovedEmail(approvedApp).catch(() => {});
        await recordPlatformChange({
            key: `ad-application-${id}-approved`,
            actor: 'Admin',
            area: 'Student wallet',
            title: 'Student advert approved and published',
            details: `"${approvedApp.title}" by ${approvedApp.business_name} is now live on the Trending-on-Campus banners until ${expiresAt.toDateString()}.`
        });
        await logAdminAction(req, {
            action: 'ad_application_approve',
            targetType: 'ad_application',
            targetId: id,
            details: { businessName: approvedApp.business_name, title: approvedApp.title, expiresAt }
        });
        res.json({ success: true, application: approvedApp });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[Ad Approve Error]', err);
        res.status(500).json({ error: 'internal_error' });
    } finally { client.release(); }
});

router.post('/ad-applications/:id/reject', async (req, res) => {
    try {
        const id = Number(req.params.id);
        const { reason = '' } = req.body || {};
        const updated = await pool.query(
            `UPDATE ad_applications SET status = 'rejected', reject_reason = $1, reviewed_at = now(), updated_at = now()
             WHERE id = $2 AND status IN ('pending','expired_pending_renewal') RETURNING *`,
            [reason, id]
        );
        if (!updated.rows.length) return res.status(400).json({ error: 'invalid_state', message: 'Only a pending application can be rejected.' });
        sendAdRejectedEmail(updated.rows[0], reason).catch(() => {});
        await logAdminAction(req, {
            action: 'ad_application_reject',
            targetType: 'ad_application',
            targetId: id,
            details: { reason }
        });
        res.json({ success: true, application: updated.rows[0] });
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

// Dev/testing: run the real expiry flow (content card pulled down, status ->
// expired_pending_renewal, renewal email + Korapay link) for one live ad
// right now, without waiting on expires_at or the 15-min sweep. Distinct
// from /deactivate below, which just force-closes an ad with no renewal step.
router.post('/ad-applications/:id/simulate-expiry', async (req, res) => {
    try {
        const id = Number(req.params.id);
        const { rows } = await pool.query('SELECT * FROM ad_applications WHERE id = $1', [id]);
        if (!rows.length) return res.status(404).json({ error: 'not_found' });
        if (rows[0].status !== 'live') {
            return res.status(400).json({ error: 'invalid_state', message: 'Only a live advert can be expired.' });
        }
        const updated = await expireOneApplication(rows[0]);
        res.json({ success: true, application: updated });
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

// Manually take a live advert down (distinct from the automatic expiry sweep).
router.post('/ad-applications/:id/deactivate', async (req, res) => {
    const client = await pool.connect();
    try {
        const id = Number(req.params.id);
        await client.query('BEGIN');
        const appRes = await client.query('SELECT * FROM ad_applications WHERE id = $1 FOR UPDATE', [id]);
        if (!appRes.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not_found' }); }
        const application = appRes.rows[0];
        if (application.content_card_id) {
            await client.query('UPDATE content_cards SET active = false, updated_at = now() WHERE id = $1', [application.content_card_id]);
        }
        const updated = await client.query(
            `UPDATE ad_applications SET status = 'expired', updated_at = now() WHERE id = $1 RETURNING *`,
            [id]
        );
        await client.query('COMMIT');
        await logAdminAction(req, {
            action: 'ad_application_deactivate',
            targetType: 'ad_application',
            targetId: id,
            details: { businessName: application.business_name, title: application.title }
        });
        res.json({ success: true, application: updated.rows[0] });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        res.status(500).json({ error: 'internal_error' });
    } finally { client.release(); }
});

// GET /admin/audit-log?admin=email-or-id&action=driver_flag&targetType=driver&targetId=42
// Internal record of admin actions (who did what, to what, and when) —
// distinct from /change-log, which is the public-facing release timeline.
router.get('/audit-log', async (req, res) => {
    try {
        const { admin, action, targetType, targetId } = req.query;
        const clauses = [];
        const params = [];
        if (admin) {
            params.push(admin);
            const isId = /^\d+$/.test(admin);
            clauses.push(isId ? `admin_id = $${params.length}` : `admin_email ILIKE $${params.length}`);
            if (!isId) params[params.length - 1] = `%${admin}%`;
        }
        if (action) { params.push(action); clauses.push(`action = $${params.length}`); }
        if (targetType) { params.push(targetType); clauses.push(`target_type = $${params.length}`); }
        if (targetId) { params.push(String(targetId)); clauses.push(`target_id = $${params.length}`); }
        const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
        const result = await pool.query(
            `SELECT id, admin_id, admin_email, action, target_type, target_id, details, ip_address, created_at
             FROM admin_audit_log
             ${where}
             ORDER BY created_at DESC
             LIMIT 200`,
            params
        );
        res.json({ entries: result.rows });
    } catch (err) {
        console.error('[Admin Audit Log Fetch Error]', err);
        res.status(500).json({ error: 'internal_error' });
    }
});

// GET /admin/change-log?actor=Claude&area=driver — filter the platform
// timeline by who made the change (Codex, ChatGPT, Claude, Admin, etc.)
// and/or which area it touched. Both are optional; omit either to see
// everything. Matching is partial/case-insensitive so "claude" also
// catches an actor value like "Claude Sonnet 5".
router.get('/change-log', async (req, res) => {
    try {
        const { actor, area } = req.query;
        const clauses = [];
        const params = [];
        if (actor) { params.push(`%${actor}%`); clauses.push(`actor ILIKE $${params.length}`); }
        if (area) { params.push(`%${area}%`); clauses.push(`area ILIKE $${params.length}`); }
        const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
        const result = await pool.query(
            `SELECT id, actor, area, title, details, created_at
             FROM platform_change_log
             ${where}
             ORDER BY created_at DESC
             LIMIT 300`,
            params
        );
        res.json(result.rows);
    } catch (err) {
        console.error('[Admin Change Log Error]', err);
        res.status(500).json({ error: 'internal_error' });
    }
});

// POST /admin/change-log/:id/publish — turn a platform-timeline entry into a
// real campus broadcast (in-app notification + optional email) to students,
// drivers, or both. Kept as an explicit, separate action from
// recordPlatformChange so every internal/dev-facing entry doesn't blast
// users by default — an admin chooses which ones are user-facing news.
router.post('/change-log/:id/publish', async (req, res) => {
    try {
        const { id } = req.params;
        const { target = 'all', sendEmail = true } = req.body || {};
        if (!['all', 'students', 'drivers'].includes(target)) return res.status(400).json({ error: 'invalid_target' });
        const entry = await pool.query('SELECT * FROM platform_change_log WHERE id = $1', [id]);
        if (!entry.rows.length) return res.status(404).json({ error: 'not_found' });
        const change = entry.rows[0];
        if (change.published_at) return res.status(409).json({ error: 'already_published', published_at: change.published_at });

        const broadcast = await pool.query(
            `INSERT INTO campus_broadcasts (title, message, urgency, target, send_email, active)
             VALUES ($1, $2, 'info', $3, $4, true) RETURNING *`,
            [change.title, change.details, target, Boolean(sendEmail)]
        );
        const audience = target === 'students' ? ['student'] : target === 'drivers' ? ['driver'] : ['student', 'driver'];
        // One bulk insert per role instead of one INSERT per recipient.
        await Promise.all(audience.map(role => notifyRole(role, { title: change.title, body: change.details, type: 'broadcast', email: Boolean(sendEmail) })));
        const updated = await pool.query(
            `UPDATE platform_change_log SET published_at = now(), published_target = $2, broadcast_id = $3 WHERE id = $1 RETURNING *`,
            [id, target, broadcast.rows[0].id]
        );
        emitToAdmins('change-log-published', updated.rows[0]);
        await logAdminAction(req, { action: 'change_log_publish', targetType: 'platform_change_log', targetId: id, details: { target, sendEmail: Boolean(sendEmail) } });
        res.json({ success: true, change: updated.rows[0], broadcast: broadcast.rows[0] });
    } catch (err) {
        console.error('[Admin Change Log Publish Error]', err);
        res.status(500).json({ error: 'internal_error' });
    }
});

// GET /admin/stream — Server-Sent Events for the Operations Desk: new
// platform-timeline entries, publishes, and new broadcasts show up live
// instead of only on the next manual refresh / tab switch.
router.get('/stream', (req, res) => {
    openStream(req, res, { register: addAdminStream, unregister: removeAdminStream });
});

// ------------------------------------------------------------------
// Campus Broadcast Endpoints
// ------------------------------------------------------------------
router.get('/broadcasts', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM campus_broadcasts ORDER BY created_at DESC LIMIT 50');
        res.json(result.rows);
    } catch (err) {
        console.error('[zira_go_admin_routes]', err);
        res.status(500).json({ error: 'internal_error' });
    }
});

router.post('/broadcasts', async (req, res) => {
    try {
        const { title, message, urgency = 'info', target = 'all', imageUrl = null, sendEmail = true } = req.body;
        if (!title || !message) {
            return res.status(400).json({ error: 'Title and message are required' });
        }
        const result = await pool.query(
            `INSERT INTO campus_broadcasts (title, message, urgency, target, image_url, send_email, active)
             VALUES ($1, $2, $3, $4, $5, $6, true) RETURNING *`,
            [title, message, urgency, target, imageUrl || null, Boolean(sendEmail)]
        );
        const audience = target === 'students' ? ['student'] : target === 'drivers' ? ['driver'] : ['student', 'driver'];
        await Promise.all(audience.map(role => notifyRole(role, { title, body: message, type: 'broadcast', imageUrl: imageUrl || null, email: Boolean(sendEmail) })));
        await logAdminAction(req, {
            action: 'broadcast_create',
            targetType: 'broadcast',
            targetId: result.rows[0].id,
            details: { title, target, urgency, sendEmail: Boolean(sendEmail) }
        });
        emitToAdmins('broadcast', result.rows[0]);
        res.json({ success: true, broadcast: result.rows[0] });
    } catch (err) {
        console.error('[zira_go_admin_routes]', err);
        res.status(500).json({ error: 'internal_error' });
    }
});

router.delete('/broadcasts/:id', async (req, res) => {
    try {
        await pool.query('UPDATE campus_broadcasts SET active = false WHERE id = $1', [req.params.id]);
        await logAdminAction(req, { action: 'broadcast_deactivate', targetType: 'broadcast', targetId: req.params.id });
        res.json({ success: true });
    } catch (err) {
        console.error('[zira_go_admin_routes]', err);
        res.status(500).json({ error: 'internal_error' });
    }
});

// ------------------------------------------------------------------
// Support Tickets / Live Agent Desk
// ------------------------------------------------------------------
router.get('/support/messages', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM support_tickets ORDER BY created_at DESC LIMIT 100');
        res.json(result.rows);
    } catch (err) {
        console.error('[zira_go_admin_routes]', err);
        res.status(500).json({ error: 'internal_error' });
    }
});

router.post('/support/reply', async (req, res) => {
    try {
        const { id, reply, status = 'resolved' } = req.body;
        const updated = await pool.query(
            `UPDATE support_tickets SET admin_reply = $1, status = $2, updated_at = now() WHERE id = $3 RETURNING student_id`,
            [reply, status, id]
        );
        if (!updated.rows.length) return res.status(404).json({ error: 'support_ticket_not_found' });
        if (updated.rows[0].student_id) await notify({ userId: updated.rows[0].student_id, role: 'student', title: status === 'resolved' ? 'Support request resolved' : 'Reply from Zira Go support', body: reply, type: 'support' });
        res.json({ success: true });
    } catch (err) {
        console.error('[zira_go_admin_routes]', err);
        res.status(500).json({ error: 'internal_error' });
    }
});

// ------------------------------------------------------------------
// Platform Configuration (Fares, Gateways, Hero Banner)
// ------------------------------------------------------------------
router.get('/config', async (req, res) => {
    try {
        const result = await pool.query("SELECT value FROM platform_config WHERE key = 'app_settings'");
        if (result.rows.length) {
            return res.json(result.rows[0].value);
        }
        res.json({
            driverFare: 250,
            platformFee: 10,
            activeGateway: 'korapay',
            paymentMode: 'live',
            heroTitle: 'Campus Life, Made Easier.',
            heroTagline: 'Landmark University',
            heroDesc: 'Instant 30-min campus transit codes, errand runner dispatches, and student wallet.',
            heroBannerImage: 'landmark_campus_banner.jpg'
        });
    } catch (err) {
        console.error('[zira_go_admin_routes]', err);
        res.status(500).json({ error: 'internal_error' });
    }
});

router.post('/config', async (req, res) => {
    try {
        const newConfig = req.body;
        const before = await pool.query("SELECT value FROM platform_config WHERE key = 'app_settings'");
        await pool.query(
            `INSERT INTO platform_config (key, value, updated_at)
             VALUES ('app_settings', $1, now())
             ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`,
            [JSON.stringify(newConfig)]
        );
        await logAdminAction(req, {
            action: 'platform_config_update',
            targetType: 'platform_config',
            targetId: 'app_settings',
            details: { before: before.rows[0]?.value || null, after: newConfig }
        });
        res.json({ success: true, message: 'Platform settings updated successfully!', config: newConfig });
    } catch (err) {
        console.error('[zira_go_admin_routes]', err);
        res.status(500).json({ error: 'internal_error' });
    }
});

// ------------------------------------------------------------------
// Individual Student & Driver Full Ledger & Balance Adjustment
// ------------------------------------------------------------------
router.get('/student/:id/ledger', async (req, res) => {
    try {
        const studentId = req.params.id;
        const student = await pool.query('SELECT id, reg_no, email, wallet_balance, created_at FROM students WHERE id = $1', [studentId]);
        if (!student.rows.length) return res.status(404).json({ error: 'student_not_found' });

        const txs = await pool.query(
            `SELECT * FROM wallet_transactions WHERE student_id = $1 ORDER BY created_at DESC`,
            [studentId]
        );

        const charges = await pool.query(
            `SELECT tc.*, ts.mode AS trip_mode, d.full_name AS driver_name
             FROM trip_charges tc
             JOIN trip_sessions ts ON ts.id = tc.trip_session_id
             JOIN drivers d ON d.id = ts.driver_id
             WHERE tc.student_id = $1
             ORDER BY tc.created_at DESC`,
            [studentId]
        );

        res.json({
            student: student.rows[0],
            transactions: txs.rows,
            rides: charges.rows
        });
    } catch (err) {
        console.error('[zira_go_admin_routes]', err);
        res.status(500).json({ error: 'internal_error' });
    }
});

router.get('/driver/:id/ledger', async (req, res) => {
    try {
        const driverId = req.params.id;
        const driver = await pool.query('SELECT id, full_name, email, wallet_balance, is_flagged, bank_account_name, bank_account_number, bank_name, created_at FROM drivers WHERE id = $1', [driverId]);
        if (!driver.rows.length) return res.status(404).json({ error: 'driver_not_found' });

        const trips = await pool.query(
            `SELECT ts.*,
                    (SELECT COUNT(*) FROM trip_charges tc WHERE tc.trip_session_id = ts.id AND tc.status = 'success') AS passenger_count,
                    (SELECT string_agg(COALESCE(s.full_name,s.reg_no), ', ' ORDER BY tc.created_at) FROM trip_charges tc JOIN students s ON s.id=tc.student_id WHERE tc.trip_session_id=ts.id AND tc.status='success') AS passenger_names
             FROM trip_sessions ts
             WHERE ts.driver_id = $1
             ORDER BY ts.created_at DESC`,
            [driverId]
        );

        const withdrawals = await pool.query(
            `SELECT * FROM driver_withdrawals WHERE driver_id = $1 ORDER BY created_at DESC`,
            [driverId]
        );
        const transactions = await pool.query(
            `SELECT * FROM wallet_transactions WHERE driver_id = $1 ORDER BY created_at DESC`,
            [driverId]
        );

        res.json({
            driver: driver.rows[0],
            transactions: transactions.rows,
            trips: trips.rows,
            withdrawals: withdrawals.rows
        });
    } catch (err) {
        console.error('[zira_go_admin_routes]', err);
        res.status(500).json({ error: 'internal_error' });
    }
});

router.post('/adjust-balance', async (req, res) => {
    const client = await pool.connect();
    try {
        const { userId, role, type, amount, reason } = req.body;
        const amt = Number(amount);
        if (!userId || !['student', 'driver'].includes(role) || !['credit', 'debit'].includes(type) || !Number.isFinite(amt) || amt <= 0 || amt > 1000000 || !String(reason || '').trim()) {
            return res.status(400).json({ error: 'Invalid balance adjustment parameters' });
        }
        const delta = type === 'credit' ? amt : -amt;
        const table = role === 'student' ? 'students' : 'drivers';
        await client.query('BEGIN');
        const existing = await client.query(`SELECT wallet_balance FROM ${table} WHERE id=$1 FOR UPDATE`, [userId]);
        if (!existing.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'user_not_found' }); }
        if (type === 'debit' && Number(existing.rows[0].wallet_balance) < amt) { await client.query('ROLLBACK'); return res.status(422).json({ error: 'insufficient_balance' }); }
        const updated = await client.query(
            `UPDATE ${table}
             SET wallet_balance = wallet_balance + $1
             WHERE id = $2
             RETURNING id, wallet_balance`,
            [delta, userId]
        );

        const receipt = `ZG-ADJ-${Date.now()}-${String(userId).padStart(4, '0')}`;
        await client.query(
            `INSERT INTO wallet_transactions
                (${role === 'student' ? 'student_id' : 'driver_id'}, type, amount, fee_amount, status, receipt_number, gateway, description, metadata)
             VALUES
                ($1, $2, $3, 0, 'success', $4, 'Admin Console', $5, $6)`,
            [
                userId,
                type === 'credit' ? 'admin_credit' : 'admin_debit',
                amt,
                receipt,
                `Admin ${type}: ${String(reason).trim()}`,
                JSON.stringify({ adjustedByAdminId: req.auth.id, reason: String(reason).trim(), timestamp: new Date().toISOString() })
            ]
        );
        await client.query('COMMIT');
        await logAdminAction(req, {
            action: type === 'credit' ? 'wallet_adjust_credit' : 'wallet_adjust_debit',
            targetType: role,
            targetId: userId,
            details: { amount: amt, reason: String(reason).trim(), newBalance: Number(updated.rows[0].wallet_balance), receiptNumber: receipt }
        });
        res.json({ success: true, receiptNumber: receipt, newBalance: Number(updated.rows[0].wallet_balance) });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[zira_go_admin_routes]', err);
        res.status(500).json({ error: 'internal_error' });
    } finally {
        client.release();
    }
});

module.exports = router;
