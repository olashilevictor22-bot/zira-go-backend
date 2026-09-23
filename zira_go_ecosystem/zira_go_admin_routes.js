// zira_go_admin_routes.js
// Admin analytics, student & driver ledgers, withdrawal queues, and system management.

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const router = express.Router();
const { requireAuth, requireRole } = require('./zira_go_auth_routes');
const { notify } = require('./zira_go_notification_routes');

async function recordPlatformChange({ key, actor = 'Codex', area = 'Platform', title, details }) {
    await pool.query(
        `INSERT INTO platform_change_log (change_key, actor, area, title, details)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (change_key) DO NOTHING`,
        [key, actor, area, title, details]
    );
}

// Every portal route is restricted server-side; hiding the link alone is not security.
router.use(requireAuth, requireRole('admin'));
const heroMediaDir = path.join(__dirname, 'uploads', 'hero-media');
fs.mkdirSync(heroMediaDir, { recursive: true });
const heroUpload = multer({ storage: multer.diskStorage({ destination: heroMediaDir, filename: (_req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`) }), limits: { fileSize: 30 * 1024 * 1024 }, fileFilter: (_req, file, cb) => cb(null, /^(image\/(jpeg|png|webp|gif)|video\/(mp4|webm|quicktime))$/.test(file.mimetype)) });
router.post('/hero-media', heroUpload.single('media'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Choose a JPG, PNG, WEBP, GIF, MP4, MOV, or WebM file (30 MB max).' });
    res.json({ success: true, url: `/hero-media/${encodeURIComponent(req.file.filename)}`, mediaType: req.file.mimetype.startsWith('video/') ? 'video' : 'image' });
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

        // 2. Total Funding Volume (student deposits)
        const fundRes = await pool.query(
            `SELECT COALESCE(SUM(amount), 0) AS total_funded,
                    COUNT(*) AS total_fund_count
             FROM wallet_transactions
             WHERE type = 'funding' AND status = 'success'`
        );

        // 3. Total Driver Withdrawals
        const wthRes = await pool.query(
            `SELECT COALESCE(SUM(amount), 0) AS total_withdrawn,
                    COUNT(*) AS total_withdrawals_count
             FROM driver_withdrawals
             WHERE status = 'completed'`
        );

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
             LIMIT 15`
        );

        res.json({
            kpi: {
                platformRevenue: Number(feeRes.rows[0].total_platform_fees),
                totalFunded: Number(fundRes.rows[0].total_funded),
                fundingTransactions: Number(fundRes.rows[0].total_fund_count),
                totalWithdrawn: Number(wthRes.rows[0].total_withdrawn),
                withdrawalCount: Number(wthRes.rows[0].total_withdrawals_count),
                studentCount: Number(studentStats.rows[0].student_count),
                studentLiabilities: Number(studentStats.rows[0].student_liabilities),
                driverCount: Number(driverStats.rows[0].driver_count),
                driverBalances: Number(driverStats.rows[0].driver_balances),
                totalTrips: Number(tripsRes.rows[0].total_trips),
                completeRides: Number(tripsRes.rows[0].complete_rides),
                charters: Number(tripsRes.rows[0].charters),
                totalTripRevenue: Number(tripsRes.rows[0].total_trip_revenue)
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
        res.status(500).json({ error: 'internal_error', message: err.message });
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
                    is_flagged, created_at
             FROM drivers
             ORDER BY created_at DESC`
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

        res.json({ success: true, isFlagged: nextState });
    } catch (err) {
        console.error('[Toggle Flag Error]', err);
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
        `);

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
router.get('/change-log', async (_req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, actor, area, title, details, created_at
             FROM platform_change_log
             ORDER BY created_at DESC
             LIMIT 100`
        );
        res.json(result.rows);
    } catch (err) {
        console.error('[Admin Change Log Error]', err);
        res.status(500).json({ error: 'internal_error' });
    }
});

// ------------------------------------------------------------------
// Campus Broadcast Endpoints
// ------------------------------------------------------------------
router.get('/broadcasts', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM campus_broadcasts ORDER BY created_at DESC LIMIT 50');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
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
        for (const role of audience) {
            const users = await pool.query(`SELECT id FROM ${role === 'student' ? 'students' : 'drivers'}`);
            await Promise.all(users.rows.map(u => notify({ userId: u.id, role, title, body: message, type: 'broadcast', imageUrl: imageUrl || null, email: Boolean(sendEmail) })));
        }
        res.json({ success: true, broadcast: result.rows[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/broadcasts/:id', async (req, res) => {
    try {
        await pool.query('UPDATE campus_broadcasts SET active = false WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
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
        res.status(500).json({ error: err.message });
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
        res.status(500).json({ error: err.message });
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
        res.status(500).json({ error: err.message });
    }
});

router.post('/config', async (req, res) => {
    try {
        const newConfig = req.body;
        await pool.query(
            `INSERT INTO platform_config (key, value, updated_at)
             VALUES ('app_settings', $1, now())
             ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`,
            [JSON.stringify(newConfig)]
        );
        res.json({ success: true, message: 'Platform settings updated successfully!', config: newConfig });
    } catch (err) {
        res.status(500).json({ error: err.message });
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
        res.status(500).json({ error: err.message });
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
        res.status(500).json({ error: err.message });
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
        res.json({ success: true, receiptNumber: receipt, newBalance: Number(updated.rows[0].wallet_balance) });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

module.exports = router;
