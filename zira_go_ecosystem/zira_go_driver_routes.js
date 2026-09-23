// zira_go_driver_routes.js
// Driver withdrawals with strict full-name verification and payout receipts.

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { verifyNameMatch, initiateDriverPayout } = require('./zira_go_payment_service');
const { requireAuth, requireRole } = require('./zira_go_auth_routes');

function generateReceiptNumber() {
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const rand = crypto.randomInt(1000, 9999);
    return `ZG-WTH-${dateStr}-${rand}`;
}

// ------------------------------------------------------------------
// GET /api/driver/profile — Get driver info, balance, and bank status
// ------------------------------------------------------------------
router.get('/profile', requireAuth, requireRole('driver'), async (req, res) => {
    try {
        const driverId = req.auth.id;
        const result = await pool.query(
            `SELECT id, full_name, email, wallet_balance, bank_code, bank_name,
                    bank_account_number, bank_account_name, bank_locked, is_flagged
             FROM drivers
             WHERE id = $1`,
            [driverId]
        );

        if (!result.rows.length) return res.status(404).json({ error: 'driver_not_found' });

        const d = result.rows[0];
        res.json({
            id: d.id,
            fullName: d.full_name || 'REGISTERED DRIVER',
            email: d.email,
            walletBalance: Number(d.wallet_balance),
            bankName: d.bank_name,
            accountNumber: d.bank_account_number,
            accountName: d.bank_account_name,
            bankLocked: Boolean(d.bank_locked),
            isFlagged: Boolean(d.is_flagged)
        });
    } catch (err) {
        console.error('[Driver Profile Error]', err);
        res.status(500).json({ error: 'internal_error' });
    }
});

// ------------------------------------------------------------------
// POST /api/driver/withdraw
// body: { driverId, amount }
// ------------------------------------------------------------------
router.post('/withdraw', requireAuth, requireRole('driver'), async (req, res) => {
    const client = await pool.connect();
    try {
        const { amount } = req.body;
        const driverId = req.auth.id;
        const withdrawAmt = parseInt(amount, 10);

        if (!withdrawAmt || withdrawAmt < 500) {
            return res.status(400).json({
                error: 'invalid_amount',
                message: 'Minimum withdrawal amount is ₦500.'
            });
        }

        await client.query('BEGIN');

        // Lock driver record for update
        const driverRes = await client.query(
            `SELECT id, full_name, wallet_balance, bank_code, bank_name,
                    bank_account_number, bank_account_name, bank_locked, is_flagged
             FROM drivers
             WHERE id = $1 FOR UPDATE`,
            [driverId]
        );

        if (!driverRes.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'driver_not_found' });
        }

        const driver = driverRes.rows[0];

        if (driver.is_flagged) {
            await client.query('ROLLBACK');
            return res.status(403).json({
                error: 'account_flagged',
                message: 'Your account is currently restricted. Please contact campus admin support.'
            });
        }

        const currentBal = Number(driver.wallet_balance);
        if (currentBal < withdrawAmt) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                error: 'insufficient_balance',
                message: `Insufficient funds. Available balance is ₦${currentBal.toLocaleString()}.`
            });
        }

        if (!driver.bank_locked || !driver.bank_account_number || !driver.bank_account_name) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                error: 'no_verified_bank',
                message: 'You have not linked and verified a bank account for payouts yet.'
            });
        }

        // =================================================================
        // STRICT NAME MATCHING RULE: Account must match Full name registered
        // =================================================================
        const matchResult = verifyNameMatch(driver.full_name, driver.bank_account_name);

        if (!matchResult.matched) {
            await client.query('ROLLBACK');
            return res.status(422).json({
                error: 'name_mismatch',
                message: matchResult.reason,
                registeredName: driver.full_name,
                bankAccountName: driver.bank_account_name
            });
        }

        const fee = 0; // Free campus transit withdrawals
        const reference = `ZG_WTH_${Date.now()}_${crypto.randomInt(100, 999)}`;
        const receiptNumber = generateReceiptNumber();

        // 1. Deduct driver balance
        const updated = await client.query(
            `UPDATE drivers
             SET wallet_balance = wallet_balance - $1
             WHERE id = $2
             RETURNING wallet_balance`,
            [withdrawAmt, driverId]
        );

        // 2. Record withdrawal
        await client.query(
            `INSERT INTO driver_withdrawals
                (driver_id, amount, fee, bank_code, bank_name, account_number, account_name,
                 matched_registered_name, status, reference, receipt_number)
             VALUES
                ($1, $2, $3, $4, $5, $6, $7, true, 'pending', $8, $9)`,
            [
                driverId,
                withdrawAmt,
                fee,
                driver.bank_code || '044',
                driver.bank_name,
                driver.bank_account_number,
                driver.bank_account_name,
                reference,
                receiptNumber
            ]
        );

        // 3. Record in universal wallet_transactions
        await client.query(
            `INSERT INTO wallet_transactions
                (driver_id, type, amount, fee_amount, fee_type, status, receipt_number, description, gateway_reference, metadata)
             VALUES
                ($1, 'withdrawal', $2, $3, 'withdrawal_fee', 'pending', $4, $5, $6, $7)`,
            [
                driverId,
                withdrawAmt,
                fee,
                receiptNumber,
                `Driver Payout to ${driver.bank_name} (••••${driver.bank_account_number.slice(-4)})`,
                reference,
                JSON.stringify({
                    bankName: driver.bank_name,
                    accountNumber: driver.bank_account_number,
                    accountName: driver.bank_account_name,
                    driverFullName: driver.full_name
                })
            ]
        );

        await client.query('COMMIT');

        const newBalance = Number(updated.rows[0].wallet_balance);

        // The wallet debit is committed first to make a double-click safe. A
        // failed gateway request is compensated below before any receipt is
        // returned to the driver.
        let payout;
        try {
            payout = await initiateDriverPayout({
                accountNumber: driver.bank_account_number,
                bankCode: driver.bank_code,
                amount: withdrawAmt - fee,
                reference,
                narration: `Zira Go driver earnings — ${driver.full_name}`
            });
        } catch (payoutError) {
            const recovery = await pool.connect();
            try {
                await recovery.query('BEGIN');
                await recovery.query('UPDATE drivers SET wallet_balance = wallet_balance + $1 WHERE id = $2', [withdrawAmt, driverId]);
                await recovery.query("UPDATE driver_withdrawals SET status = 'rejected', rejection_reason = $1, processed_at = now() WHERE reference = $2", [payoutError.message, reference]);
                await recovery.query("UPDATE wallet_transactions SET status = 'failed', description = description || ' (payout initiation failed)' WHERE gateway_reference = $1", [reference]);
                await recovery.query('COMMIT');
            } catch (recoveryError) {
                await recovery.query('ROLLBACK');
                console.error('[Driver Withdraw Recovery Error]', recoveryError);
            } finally {
                recovery.release();
            }
            return res.status(502).json({ error: 'payout_not_started', message: payoutError.message });
        }

        const settlementStatus = ['successful', 'success', 'completed'].includes(payout.status) ? 'completed' : 'processing';
        await pool.query(
            "UPDATE driver_withdrawals SET status = $1, processed_at = CASE WHEN $1 = 'completed' THEN now() ELSE NULL END WHERE reference = $2",
            [settlementStatus, reference]
        );
        await pool.query(
            "UPDATE wallet_transactions SET status = $1, metadata = metadata || $2::jsonb WHERE gateway_reference = $3",
            [settlementStatus === 'completed' ? 'success' : 'pending', JSON.stringify(payout), reference]
        );

        res.json({
            success: true,
            receipt: {
                receiptNumber,
                reference,
                amount: withdrawAmt,
                fee,
                totalDisbursed: withdrawAmt,
                bankName: driver.bank_name,
                accountNumber: `••••${driver.bank_account_number.slice(-4)}`,
                accountName: driver.bank_account_name,
                driverFullName: driver.full_name,
                newBalance,
                status: settlementStatus === 'completed' ? 'Completed' : 'Processing',
                date: new Date().toISOString()
            }
        });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[Driver Withdraw Error]', err);
        res.status(500).json({ error: 'internal_error', message: err.message });
    } finally {
        client.release();
    }
});

// ------------------------------------------------------------------
// POST /api/driver/webhooks/flutterwave
// Flutterwave calls this after a transfer settles. Configure this exact URL
// in Flutterwave's dashboard and set its secret hash as FLW_WEBHOOK_HASH.
// The row lock makes duplicate delivery safe and refunds a failed payout once.
// ------------------------------------------------------------------
router.post('/webhooks/flutterwave', async (req, res) => {
    const expectedHash = process.env.FLW_WEBHOOK_HASH;
    const receivedHash = req.get('verif-hash');
    if (!expectedHash || !receivedHash || receivedHash !== expectedHash) {
        return res.status(401).json({ error: 'invalid_webhook_signature' });
    }

    const payload = req.body || {};
    const transfer = payload.data || payload;
    const reference = transfer.reference || transfer.tx_ref;
    const rawStatus = String(transfer.status || payload.event || '').toLowerCase();
    if (!reference) return res.status(400).json({ error: 'missing_reference' });

    const succeeded = /successful|success|completed/.test(rawStatus);
    const failed = /failed|reversed|cancelled|canceled/.test(rawStatus);
    if (!succeeded && !failed) return res.status(200).json({ received: true, ignored: true });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await client.query(
            'SELECT id, driver_id, amount, status FROM driver_withdrawals WHERE reference = $1 FOR UPDATE',
            [reference]
        );
        if (!result.rows.length) {
            await client.query('ROLLBACK');
            return res.status(200).json({ received: true, ignored: true });
        }

        const withdrawal = result.rows[0];
        if (withdrawal.status !== 'processing' && withdrawal.status !== 'pending') {
            await client.query('ROLLBACK');
            return res.status(200).json({ received: true, duplicate: true });
        }

        if (succeeded) {
            await client.query("UPDATE driver_withdrawals SET status = 'completed', processed_at = now() WHERE id = $1", [withdrawal.id]);
            await client.query("UPDATE wallet_transactions SET status = 'success' WHERE gateway_reference = $1", [reference]);
        } else {
            const reason = transfer.complete_message || transfer.processor_response || 'Payout failed at provider';
            await client.query('UPDATE drivers SET wallet_balance = wallet_balance + $1 WHERE id = $2', [withdrawal.amount, withdrawal.driver_id]);
            await client.query("UPDATE driver_withdrawals SET status = 'rejected', rejection_reason = $1, processed_at = now() WHERE id = $2", [reason, withdrawal.id]);
            await client.query("UPDATE wallet_transactions SET status = 'failed', description = description || ' (payout refunded)' WHERE gateway_reference = $1", [reference]);
        }
        await client.query('COMMIT');
        res.status(200).json({ received: true });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[Flutterwave Webhook Error]', err);
        res.status(500).json({ error: 'webhook_processing_failed' });
    } finally {
        client.release();
    }
});

// ------------------------------------------------------------------
// GET /api/driver/withdrawals/history?driverId=...
// ------------------------------------------------------------------
router.get('/withdrawals/history', requireAuth, requireRole('driver'), async (req, res) => {
    try {
        const driverId = req.auth.id;
        const history = await pool.query(
            `SELECT id, amount, fee, bank_name, account_number, account_name,
                    status, reference, receipt_number, created_at, processed_at
             FROM driver_withdrawals
             WHERE driver_id = $1
             ORDER BY created_at DESC LIMIT 30`,
            [driverId]
        );

        res.json({
            withdrawals: history.rows.map(w => ({
                id: w.id,
                amount: Number(w.amount),
                fee: Number(w.fee),
                bankName: w.bank_name,
                accountNumber: `••••${w.account_number.slice(-4)}`,
                accountName: w.account_name,
                status: w.status,
                reference: w.reference,
                receiptNumber: w.receipt_number,
                date: new Date(w.created_at).toLocaleDateString('en-US', {
                    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
                })
            }))
        });
    } catch (err) {
        console.error('[Withdrawal History Error]', err);
        res.status(500).json({ error: 'internal_error' });
    }
});

// ------------------------------------------------------------------
// GET /api/driver/transactions?driverId=...
// Returns complete driver ledger of ride credits & payouts
// ------------------------------------------------------------------
router.get('/transactions', requireAuth, requireRole('driver'), async (req, res) => {
    try {
        const driverId = req.auth.id;
        const txs = await pool.query(
            `SELECT id, type, amount, fee_amount, fee_type, status, receipt_number, description, gateway_reference, created_at
             FROM wallet_transactions
             WHERE driver_id = $1
             ORDER BY created_at DESC LIMIT 50`,
            [driverId]
        );

        res.json({
            transactions: txs.rows.map(t => {
                const isCredit = t.type === 'ride_credit';
                let desc = t.description;
                if (!desc) {
                    desc = isCredit ? 'Passenger Transit Fare' : 'Bank Payout';
                }
                return {
                    id: t.id,
                    type: t.type,
                    isCredit,
                    amount: Number(t.amount),
                    fee: Number(t.fee_amount || 0),
                    status: t.status || 'success',
                    receiptNumber: t.receipt_number,
                    description: desc,
                    date: new Date(t.created_at).toLocaleDateString('en-US', {
                        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
                    })
                };
            })
        });
    } catch (err) {
        console.error('[Driver Transactions Error]', err);
        res.status(500).json({ error: 'internal_error' });
    }
});

module.exports = router;
