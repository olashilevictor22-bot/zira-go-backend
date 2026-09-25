// zira_go_funding_routes.js
// Student wallet funding flow with Korapay & Flutterwave, verified receipts,
// and transaction history ledger.

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { requireAuth, requireRole } = require('./zira_go_auth_routes');
const {
    initializeKorapayFunding,
    verifyKorapayFunding,
    initializeFlutterwaveFunding,
    verifyFlutterwaveFunding
} = require('./zira_go_payment_service');

function generateReceiptNumber() {
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const rand = crypto.randomInt(1000, 9999);
    return `ZG-RCP-${dateStr}-${rand}`;
}

// ------------------------------------------------------------------
// POST /api/wallet/fund/initialize
// body: { amount, gateway, email, regNo }
// ------------------------------------------------------------------
router.post('/fund/initialize', requireAuth, requireRole('student'), async (req, res) => {
    try {
        const { amount, gateway = 'korapay' } = req.body;
        const fundingAmt = parseInt(amount, 10);

        if (!fundingAmt || fundingAmt < 250) {
            return res.status(400).json({ error: 'invalid_amount', message: 'Minimum funding amount is ₦250.' });
        }
        if (!['korapay', 'flutterwave'].includes(gateway)) return res.status(400).json({ error: 'invalid_gateway' });

        const fee = 100;
        const total = fundingAmt + fee;
        const reference = `ZG_PAY_${Date.now()}_${crypto.randomInt(100, 999)}`;

        const studentRes = await pool.query('SELECT id, email, reg_no FROM students WHERE id = $1', [req.auth.id]);
        if (!studentRes.rows.length) return res.status(404).json({ error: 'student_not_found' });
        const studentId = studentRes.rows[0].id, email = studentRes.rows[0].email, regNo = studentRes.rows[0].reg_no;

        // Insert pending transaction
        await pool.query(
            `INSERT INTO wallet_transactions
                (student_id, type, amount, fee_amount, fee_type, gateway, gateway_reference, status, description, metadata)
             VALUES
                ($1, 'funding', $2, $3, 'funding_fee', $4, $5, 'pending', $6, $7)`,
            [
                studentId,
                fundingAmt,
                fee,
                gateway,
                reference,
                `Wallet Funding via ${gateway === 'flutterwave' ? 'Flutterwave' : 'Korapay'}`,
                JSON.stringify({ regNo, email, total, requestedAt: new Date().toISOString() })
            ]
        );

        // Gateway checkout initiation
        let result;
        if (gateway === 'flutterwave') {
            result = await initializeFlutterwaveFunding({
                email,
                amount: total,
                reference,
                customerName: `Student ${regNo}`
            });
        } else {
            result = await initializeKorapayFunding({
                email,
                amount: total,
                reference,
                customerName: `Student ${regNo}`
            });
        }

        res.json({
            success: true,
            gateway,
            reference,
            amount: fundingAmt,
            fee,
            total,
            checkoutUrl: result.checkoutUrl,
            mode: result.mode
        });
    } catch (err) {
        console.error('[Funding Init Error]', err);
        res.status(500).json({ error: 'internal_error' });
    }
});

// ------------------------------------------------------------------
// POST /api/wallet/fund/verify
// body: { reference, gateway }
// ------------------------------------------------------------------
router.post('/fund/verify', requireAuth, requireRole('student'), async (req, res) => {
    const client = await pool.connect();
    try {
        const { reference, gateway = 'korapay' } = req.body;
        if (!reference) {
            return res.status(400).json({ error: 'missing_reference' });
        }

        await client.query('BEGIN');

        const txRes = await client.query(
            `SELECT * FROM wallet_transactions WHERE gateway_reference = $1 FOR UPDATE`,
            [reference]
        );

        if (!txRes.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'transaction_not_found' });
        }

        const tx = txRes.rows[0];
        if (tx.student_id !== req.auth.id) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'forbidden' }); }
        if (tx.gateway !== gateway) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'gateway_mismatch' }); }

        if (tx.status === 'success') {
            // Already fulfilled
            await client.query('ROLLBACK');
            const student = await pool.query('SELECT wallet_balance, reg_no FROM students WHERE id = $1', [tx.student_id]);
            return res.json({
                success: true,
                alreadyVerified: true,
                receipt: {
                    receiptNumber: tx.receipt_number,
                    reference: tx.gateway_reference,
                    amount: Number(tx.amount),
                    fee: Number(tx.fee_amount),
                    total: Number(tx.amount) + Number(tx.fee_amount),
                    gateway: tx.gateway,
                    newBalance: Number(student.rows[0]?.wallet_balance || 0),
                    paidAt: tx.created_at,
                    studentRegNo: student.rows[0]?.reg_no || '—'
                }
            });
        }

        // Verify with gateway service
        let verifyResult;
        if (gateway === 'flutterwave') {
            verifyResult = await verifyFlutterwaveFunding(reference);
        } else {
            verifyResult = await verifyKorapayFunding(reference);
        }

        if (!verifyResult.success || Number(verifyResult.amount) !== Number(tx.amount) + Number(tx.fee_amount)) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'verification_failed', message: 'Payment gateway could not verify the transaction.' });
        }

        const receiptNumber = generateReceiptNumber();

        // Credit student wallet
        const updatedStudent = await client.query(
            `UPDATE students
             SET wallet_balance = wallet_balance + $1
             WHERE id = $2
             RETURNING wallet_balance, reg_no`,
            [tx.amount, tx.student_id]
        );

        // Update transaction row
        await client.query(
            `UPDATE wallet_transactions
             SET status = 'success',
                 receipt_number = $1,
                 metadata = jsonb_set(COALESCE(metadata, '{}'), '{verifiedAt}', to_jsonb(now()))
             WHERE id = $2`,
            [receiptNumber, tx.id]
        );

        await client.query('COMMIT');

        const newBalance = Number(updatedStudent.rows[0]?.wallet_balance || 0);

        res.json({
            success: true,
            receipt: {
                receiptNumber,
                reference,
                amount: Number(tx.amount),
                fee: Number(tx.fee_amount),
                total: Number(tx.amount) + Number(tx.fee_amount),
                gateway,
                channel: verifyResult.channel || (gateway === 'flutterwave' ? 'Flutterwave Card' : 'Korapay Bank Transfer'),
                newBalance,
                paidAt: verifyResult.paidAt || new Date().toISOString(),
                studentRegNo: updatedStudent.rows[0]?.reg_no || '—'
            }
        });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[Funding Verify Error]', err);
        res.status(500).json({ error: 'internal_error' });
    } finally {
        client.release();
    }
});

// ------------------------------------------------------------------
// POST /api/wallet/webhooks/korapay
// Passed as this transaction's notification_url when the charge is
// initialized (see zira_go_payment_service.js), so it fires independently of
// whatever webhook URL, if any, is configured on the Korapay dashboard.
// Closes the same gap /fund/verify has on its own: a dropped connection after
// payment used to leave the student charged but uncredited, with nothing to
// auto-reconcile it. The row lock makes duplicate delivery safe.
// ------------------------------------------------------------------
router.post('/webhooks/korapay', async (req, res) => {
    const secretKey = process.env.KORAPAY_SECRET_KEY;
    const receivedSignature = req.get('x-korapay-signature');
    if (!secretKey || !receivedSignature) {
        return res.status(401).json({ error: 'invalid_webhook_signature' });
    }

    const payload = req.body || {};
    const data = payload.data || {};
    // Korapay signs only the `data` object, HMAC-SHA256 with the secret key —
    // re-stringifying the parsed body reproduces the same key order Korapay
    // sent, since Node preserves string-key insertion order.
    const expectedSignature = crypto.createHmac('sha256', secretKey).update(JSON.stringify(data)).digest('hex');
    const signaturesMatch = receivedSignature.length === expectedSignature.length &&
        crypto.timingSafeEqual(Buffer.from(receivedSignature), Buffer.from(expectedSignature));
    if (!signaturesMatch) {
        return res.status(401).json({ error: 'invalid_webhook_signature' });
    }

    const reference = data.reference;
    const rawStatus = String(data.status || payload.event || '').toLowerCase();
    if (!reference) return res.status(400).json({ error: 'missing_reference' });

    const succeeded = /success/.test(rawStatus);
    const failed = /fail/.test(rawStatus);
    if (!succeeded && !failed) return res.status(200).json({ received: true, ignored: true });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const txRes = await client.query(
            `SELECT id, student_id, amount, fee_amount, status
             FROM wallet_transactions
             WHERE gateway_reference = $1 AND gateway = 'korapay' AND type = 'funding'
             FOR UPDATE`,
            [reference]
        );

        if (!txRes.rows.length) {
            await client.query('ROLLBACK');
            return res.status(200).json({ received: true, ignored: true });
        }

        const tx = txRes.rows[0];
        if (tx.status !== 'pending') {
            await client.query('ROLLBACK');
            return res.status(200).json({ received: true, duplicate: true });
        }

        if (!succeeded) {
            await client.query("UPDATE wallet_transactions SET status = 'failed' WHERE id = $1", [tx.id]);
            await client.query('COMMIT');
            return res.status(200).json({ received: true });
        }

        // Don't trust the webhook payload's amount alone — independently confirm
        // the charge with Korapay's verify endpoint first, same as /fund/verify.
        const verifyResult = await verifyKorapayFunding(reference);
        const expectedTotal = Number(tx.amount) + Number(tx.fee_amount);
        if (!verifyResult.success || Number(verifyResult.amount) !== expectedTotal) {
            await client.query('ROLLBACK');
            console.error('[Korapay Webhook] funding verify mismatch', reference);
            return res.status(200).json({ received: true, verification_failed: true });
        }

        const receiptNumber = generateReceiptNumber();
        await client.query(
            `UPDATE students SET wallet_balance = wallet_balance + $1 WHERE id = $2`,
            [tx.amount, tx.student_id]
        );
        await client.query(
            `UPDATE wallet_transactions
             SET status = 'success',
                 receipt_number = $1,
                 metadata = jsonb_set(COALESCE(metadata, '{}'), '{verifiedAt}', to_jsonb(now()))
             WHERE id = $2`,
            [receiptNumber, tx.id]
        );

        await client.query('COMMIT');
        res.status(200).json({ received: true });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[Korapay Webhook Error]', err);
        res.status(500).json({ error: 'webhook_processing_failed' });
    } finally {
        client.release();
    }
});

// ------------------------------------------------------------------
// GET /api/wallet/transactions?regNo=...
// ------------------------------------------------------------------
router.get('/transactions', requireAuth, requireRole('student'), async (req, res) => {
    try {
        const studentRes = await pool.query('SELECT id, wallet_balance FROM students WHERE id = $1 LIMIT 1', [req.auth.id]);
        const studentId = studentRes.rows[0]?.id;

        if (!studentId) {
            return res.status(404).json({ error: 'student_not_found' });
        }

        const txRes = await pool.query(
            `SELECT id, type, amount, fee_amount, fee_type, gateway, receipt_number, description, status, created_at
             FROM wallet_transactions
             WHERE student_id = $1
             ORDER BY created_at DESC LIMIT 50`,
            [studentId]
        );

        res.json({
            balance: Number(studentRes.rows[0].wallet_balance),
            transactions: txRes.rows.map(tx => ({
                id: tx.id,
                type: ['funding', 'admin_credit', 'ride_credit'].includes(tx.type) ? 'credit' : 'debit',
                desc: tx.description || (tx.type === 'funding' ? 'Wallet Funding' : 'Shuttle Ride Fare'),
                amount: Number(tx.amount),
                fee: Number(tx.fee_amount),
                gateway: tx.gateway,
                receiptNumber: tx.receipt_number,
                status: tx.status,
                meta: new Date(tx.created_at).toLocaleDateString('en-US', {
                    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
                })
            }))
        });
    } catch (err) {
        console.error('[Transactions Fetch Error]', err);
        res.status(500).json({ error: 'internal_error' });
    }
});

module.exports = router;
