// zira_go_ads_routes.js
// Student-facing "place an advert" flow: apply -> email receipt (under review)
// -> admin approves -> banner goes live on the student home screen -> auto
// expires on schedule -> renewal email with a Korapay pay-link -> admin
// alerted once the renewal is paid.
//
// Mount under app.use('/api/ads', router). Admin review endpoints for this
// feature live in zira_go_admin_routes.js (already gated behind
// requireAuth + requireRole('admin')) — see the "Ad applications" section
// near the Campus Spotlight / content-cards code there.

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const router = express.Router();
const { requireAuth, requireRole } = require('./zira_go_auth_routes');
const { sendEmail, isConfigured: emailConfigured } = require('./zira_go_email_service');
const { initializeKorapayFunding, verifyKorapayFunding } = require('./zira_go_payment_service');

const RENEWAL_AMOUNT = 1000; // ₦1,000 flat renewal fee, per the brief.
const APP_BASE_URL = (process.env.APP_BASE_URL || '').replace(/\/$/, '');

const PLANS = {
    basic: { label: 'Basic — 7 days', days: 7 },
    standard: { label: 'Standard — 14 days', days: 14 },
    premium: { label: 'Premium — 30 days', days: 30 }
};

// ------------------------------------------------------------------
// Schema self-heal (same pattern the rest of this codebase uses — safe to
// run on every boot, no separate migration step required).
// ------------------------------------------------------------------
(async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS ad_applications (
                id                    BIGSERIAL PRIMARY KEY,
                student_id            BIGINT NOT NULL REFERENCES students(id),
                email                 TEXT NOT NULL,
                business_name         TEXT NOT NULL,
                title                 TEXT NOT NULL,
                description           TEXT NOT NULL DEFAULT '',
                image_url             TEXT NOT NULL DEFAULT '',
                button_text           TEXT NOT NULL DEFAULT 'Explore \u2192',
                button_url            TEXT NOT NULL DEFAULT '',
                plan                  TEXT NOT NULL DEFAULT 'basic' CHECK (plan IN ('basic','standard','premium')),
                plan_days             INTEGER NOT NULL DEFAULT 7,
                is_free_ad            BOOLEAN NOT NULL DEFAULT false,
                status                TEXT NOT NULL DEFAULT 'pending'
                                      CHECK (status IN ('pending','approved','rejected','live','expired','expired_pending_renewal')),
                reject_reason         TEXT,
                content_card_id       BIGINT REFERENCES content_cards(id) ON DELETE SET NULL,
                submitted_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
                reviewed_at           TIMESTAMPTZ,
                live_at               TIMESTAMPTZ,
                expires_at            TIMESTAMPTZ,
                renewal_reference     TEXT,
                renewal_amount        NUMERIC(10,2) NOT NULL DEFAULT ${RENEWAL_AMOUNT},
                renewed_at            TIMESTAMPTZ,
                expiry_notice_sent_at TIMESTAMPTZ,
                created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
                updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
            );
            CREATE INDEX IF NOT EXISTS idx_ad_applications_status ON ad_applications (status);
            CREATE INDEX IF NOT EXISTS idx_ad_applications_student ON ad_applications (student_id);
            CREATE INDEX IF NOT EXISTS idx_ad_applications_expires ON ad_applications (expires_at);
        `);
    } catch (e) {
        console.warn('[Ad Applications Schema Warning]', e.message);
    }
})();

// ------------------------------------------------------------------
// Ad artwork upload — students need somewhere to drop the banner image
// when they apply. Kept separate from the admin-only /api/admin/content-media
// uploader, which requires an admin session.
// ------------------------------------------------------------------
const adMediaDir = path.join(__dirname, 'uploads', 'ad-media');
fs.mkdirSync(adMediaDir, { recursive: true });
const adUpload = multer({
    storage: multer.diskStorage({
        destination: adMediaDir,
        filename: (_req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`)
    }),
    limits: { fileSize: 15 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => cb(null, /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype))
});
router.post('/media', requireAuth, requireRole('student'), adUpload.single('image'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Choose a JPG, PNG, WEBP, or GIF image (15 MB max).' });
    res.json({ success: true, url: `/ad-media/${encodeURIComponent(req.file.filename)}` });
});

router.get('/plans', requireAuth, requireRole('student'), (_req, res) => {
    res.json({
        plans: Object.entries(PLANS).map(([key, v]) => ({ key, label: v.label, days: v.days })),
        renewalAmount: RENEWAL_AMOUNT
    });
});

// ------------------------------------------------------------------
// Email templates
// ------------------------------------------------------------------
function wrap(title, bodyHtml) {
    return `<div style="font-family:Arial,sans-serif;max-width:540px;margin:auto;padding:24px;color:#0f172a">
        <h2 style="color:#6d28d9;margin:0 0 14px">${title}</h2>
        ${bodyHtml}
        <p style="color:#64748b;font-size:12px;margin-top:26px">Zira Go \u00b7 Landmark University</p>
    </div>`;
}

async function sendApplicationReceivedEmail(app) {
    if (!emailConfigured) return;
    const html = wrap('Your advert application was received', `
        <p>Hi, thanks for applying to advertise on Zira Go. Here's a summary of what you submitted:</p>
        <table style="width:100%;border-collapse:collapse;font-size:13px;margin:14px 0">
            <tr><td style="padding:6px 0;color:#64748b">Business</td><td style="padding:6px 0;font-weight:700">${app.business_name}</td></tr>
            <tr><td style="padding:6px 0;color:#64748b">Ad title</td><td style="padding:6px 0;font-weight:700">${app.title}</td></tr>
            <tr><td style="padding:6px 0;color:#64748b">Plan</td><td style="padding:6px 0;font-weight:700">${PLANS[app.plan]?.label || app.plan}</td></tr>
            <tr><td style="padding:6px 0;color:#64748b">Cost</td><td style="padding:6px 0;font-weight:700">${app.is_free_ad ? 'Free (first advert)' : `\u20a6${RENEWAL_AMOUNT}`}</td></tr>
        </table>
        <p style="padding:12px 14px;background:#f5f3ff;border-radius:10px;color:#5b21b6;font-weight:700">Status: Under review</p>
        <p>Our team reviews every advert before it goes live on the student home screen. You'll get another email the moment it's approved.</p>
    `);
    try {
        await sendEmail({ to: app.email, subject: 'Your Zira Go advert application is under review', html });
    } catch (e) { console.warn('[Ad email — received]', e.message); }
}

async function sendApprovedEmail(app) {
    if (!emailConfigured) return;
    const expiry = app.expires_at ? new Date(app.expires_at).toLocaleDateString() : '—';
    const html = wrap('Your advert is live! \ud83c\udf89', `
        <p>Good news — <strong>${app.title}</strong> has been approved and is now live on the Zira Go student home screen.</p>
        <p style="padding:12px 14px;background:#ecfdf5;border-radius:10px;color:#065f46;font-weight:700">Runs until: ${expiry}</p>
        <p>We'll email you before it comes down so you can renew and keep it running.</p>
    `);
    try {
        await sendEmail({ to: app.email, subject: 'Your Zira Go advert is now live', html });
    } catch (e) { console.warn('[Ad email — approved]', e.message); }
}

async function sendRejectedEmail(app, reason) {
    if (!emailConfigured) return;
    const html = wrap('Your advert application needs changes', `
        <p>Your application for <strong>${app.title}</strong> wasn't approved this time.</p>
        ${reason ? `<p style="padding:12px 14px;background:#fef2f2;border-radius:10px;color:#991b1b"><strong>Reason:</strong> ${reason}</p>` : ''}
        <p>You're welcome to fix the issue and submit a new application any time.</p>
    `);
    try {
        await sendEmail({ to: app.email, subject: 'Update on your Zira Go advert application', html });
    } catch (e) { console.warn('[Ad email — rejected]', e.message); }
}

async function sendRenewalEmail(app, checkoutUrl) {
    if (!emailConfigured) return;
    const html = wrap('Your advert has come down — renew it in one tap', `
        <p><strong>${app.title}</strong> has reached the end of its run and has been taken off the student home screen.</p>
        <p>Pay \u20a6${RENEWAL_AMOUNT} to put it straight back up for another ${PLANS[app.plan]?.days || 7} days:</p>
        <p style="text-align:center;margin:22px 0">
            <a href="${checkoutUrl}" style="background:#6d28d9;color:#fff;padding:12px 22px;border-radius:10px;text-decoration:none;font-weight:700;display:inline-block">Renew for \u20a6${RENEWAL_AMOUNT}</a>
        </p>
        <p style="color:#64748b;font-size:12px">Or paste this link in your browser: ${checkoutUrl}</p>
    `);
    try {
        await sendEmail({ to: app.email, subject: `Renew your Zira Go advert (\u20a6${RENEWAL_AMOUNT})`, html });
    } catch (e) { console.warn('[Ad email — renewal]', e.message); }
}

async function alertAdminsOfRenewal(app) {
    try {
        const admins = await pool.query('SELECT email FROM admins');
        if (!admins.rows.length) return;
        const html = wrap('Advert renewal paid', `
            <p><strong>${app.business_name}</strong> (${app.email}) just paid \u20a6${RENEWAL_AMOUNT} to renew "<strong>${app.title}</strong>".</p>
            <p>It has been automatically put back live on the student home screen until ${new Date(app.expires_at).toLocaleDateString()}. No further action is needed, but you can review it in the Ad Applications tab.</p>
        `);
        await Promise.all(admins.rows.map(a => sendEmail({ to: a.email, subject: 'Advert renewal received \u2014 auto-renewed', html }).catch(e => console.warn('[Admin renewal alert]', e.message))));
    } catch (e) { console.warn('[Admin renewal alert lookup]', e.message); }
}

// ------------------------------------------------------------------
// POST /api/ads/apply
// body: { businessName, title, description, imageUrl, buttonText, buttonUrl, plan, email }
// The very first application from any student is free; every plan after
// that (including a renewal) is the flat ₦1,000 fee.
// ------------------------------------------------------------------
router.post('/apply', requireAuth, requireRole('student'), async (req, res) => {
    try {
        const { businessName, title, description = '', imageUrl = '', buttonText = 'Explore \u2192', buttonUrl = '', plan = 'basic', email } = req.body || {};
        if (!businessName || !title || !imageUrl) {
            return res.status(400).json({ error: 'missing_fields', message: 'Business name, ad title and an image are required.' });
        }
        if (!PLANS[plan]) return res.status(400).json({ error: 'invalid_plan' });

        const student = await pool.query('SELECT id, email FROM students WHERE id = $1', [req.auth.id]);
        if (!student.rows.length) return res.status(404).json({ error: 'student_not_found' });
        const contactEmail = (email || student.rows[0].email || '').trim();
        if (!contactEmail) return res.status(400).json({ error: 'missing_email', message: 'An email address is required so we can keep you updated on your application.' });

        const priorCount = await pool.query('SELECT COUNT(*)::int AS n FROM ad_applications WHERE student_id = $1', [req.auth.id]);
        const isFreeAd = priorCount.rows[0].n === 0;

        const inserted = await pool.query(
            `INSERT INTO ad_applications
                (student_id, email, business_name, title, description, image_url, button_text, button_url, plan, plan_days, is_free_ad, status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending')
             RETURNING *`,
            [req.auth.id, contactEmail, businessName, title, description, imageUrl, buttonText, buttonUrl, plan, PLANS[plan].days, isFreeAd]
        );
        const application = inserted.rows[0];
        sendApplicationReceivedEmail(application).catch(() => {});

        res.json({ success: true, application: { id: application.id, status: application.status, isFreeAd, plan, planDays: PLANS[plan].days } });
    } catch (err) {
        console.error('[Ad Apply Error]', err);
        res.status(500).json({ error: 'internal_error' });
    }
});

// GET /api/ads/my — the signed-in student's own applications & their live status.
router.get('/my', requireAuth, requireRole('student'), async (req, res) => {
    try {
        const rows = await pool.query(
            `SELECT id, business_name, title, description, image_url, plan, plan_days, is_free_ad, status,
                    reject_reason, submitted_at, reviewed_at, live_at, expires_at, renewal_amount, renewed_at
             FROM ad_applications WHERE student_id = $1 ORDER BY created_at DESC`,
            [req.auth.id]
        );
        res.json({ applications: rows.rows });
    } catch (err) {
        res.status(500).json({ error: 'internal_error' });
    }
});

// ------------------------------------------------------------------
// POST /api/ads/:id/renew/initialize — start the ₦1,000 Korapay checkout for
// an ad that has expired and is waiting on renewal.
// ------------------------------------------------------------------
router.post('/:id/renew/initialize', requireAuth, requireRole('student'), async (req, res) => {
    try {
        const id = Number(req.params.id);
        const appRes = await pool.query('SELECT * FROM ad_applications WHERE id = $1 AND student_id = $2', [id, req.auth.id]);
        if (!appRes.rows.length) return res.status(404).json({ error: 'not_found' });
        const application = appRes.rows[0];
        if (!['expired', 'expired_pending_renewal'].includes(application.status)) {
            return res.status(400).json({ error: 'not_renewable', message: 'This advert is not currently awaiting renewal.' });
        }

        const reference = `ZG_AD_RENEW_${id}_${Date.now()}_${crypto.randomInt(100, 999)}`;
        const redirectUrl = APP_BASE_URL ? `${APP_BASE_URL}/zira_go_student_wallet.html?adRenewalRef=${encodeURIComponent(reference)}&adId=${id}` : undefined;
        const result = await initializeKorapayFunding({
            email: application.email,
            amount: RENEWAL_AMOUNT,
            reference,
            customerName: application.business_name,
            redirectUrl
        });

        await pool.query('UPDATE ad_applications SET renewal_reference = $1, updated_at = now() WHERE id = $2', [reference, id]);
        res.json({ success: true, reference, checkoutUrl: result.checkoutUrl, amount: RENEWAL_AMOUNT });
    } catch (err) {
        console.error('[Ad Renew Init Error]', err);
        res.status(500).json({ error: 'internal_error' });
    }
});

// POST /api/ads/:id/renew/verify — body: { reference }
router.post('/:id/renew/verify', requireAuth, requireRole('student'), async (req, res) => {
    const client = await pool.connect();
    try {
        const id = Number(req.params.id);
        const { reference } = req.body || {};
        if (!reference) return res.status(400).json({ error: 'missing_reference' });

        await client.query('BEGIN');
        const appRes = await client.query('SELECT * FROM ad_applications WHERE id = $1 AND student_id = $2 FOR UPDATE', [id, req.auth.id]);
        if (!appRes.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not_found' }); }
        const application = appRes.rows[0];

        if (application.status === 'live' && application.renewed_at) {
            await client.query('ROLLBACK');
            return res.json({ success: true, alreadyRenewed: true, expiresAt: application.expires_at });
        }
        if (application.renewal_reference !== reference) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'reference_mismatch' });
        }

        const verifyResult = await verifyKorapayFunding(reference);
        if (!verifyResult.success || Number(verifyResult.amount) !== RENEWAL_AMOUNT) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'verification_failed', message: 'Korapay could not verify this payment yet.' });
        }

        const newExpiry = new Date(Date.now() + application.plan_days * 24 * 60 * 60 * 1000);
        const updated = await client.query(
            `UPDATE ad_applications
             SET status = 'live', renewed_at = now(), expires_at = $1, expiry_notice_sent_at = NULL, updated_at = now()
             WHERE id = $2 RETURNING *`,
            [newExpiry, id]
        );

        // Record the ad renewal in wallet_transactions for financial ledger and revenue tracking
        const receipt = `ZG-ADR-${Date.now()}-${String(id).padStart(4, '0')}`;
        await client.query(
            `INSERT INTO wallet_transactions
                (student_id, type, amount, fee_amount, status, receipt_number, gateway, description, metadata)
             VALUES ($1, 'ad_renewal', $2, $2, 'success', $3, 'Korapay Gateway', $4, $5)`,
            [
                application.student_id,
                RENEWAL_AMOUNT,
                receipt,
                `Advert Renewal: ${application.business_name} (${application.title})`,
                JSON.stringify({ adId: id, reference, days: application.plan_days })
            ]
        );

        // Bring the banner back on the student home screen.
        if (application.content_card_id) {
            await client.query('UPDATE content_cards SET active = true, updated_at = now() WHERE id = $1', [application.content_card_id]);
        }
        await client.query('COMMIT');

        const renewedApp = updated.rows[0];
        alertAdminsOfRenewal(renewedApp).catch(() => {});
        res.json({ success: true, expiresAt: renewedApp.expires_at, receipt });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[Ad Renew Verify Error]', err);
        res.status(500).json({ error: 'internal_error' });
    } finally {
        client.release();
    }
});

// POST /api/ads/:id/renew/wallet — Renew using student wallet balance
router.post('/:id/renew/wallet', requireAuth, requireRole('student'), async (req, res) => {
    const client = await pool.connect();
    try {
        const id = Number(req.params.id);
        await client.query('BEGIN');
        const appRes = await client.query('SELECT * FROM ad_applications WHERE id = $1 AND student_id = $2 FOR UPDATE', [id, req.auth.id]);
        if (!appRes.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not_found' }); }
        const application = appRes.rows[0];

        if (!['expired', 'expired_pending_renewal'].includes(application.status)) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'not_renewable', message: 'This advert is not currently awaiting renewal.' });
        }

        const studentRes = await client.query('SELECT wallet_balance FROM students WHERE id = $1 FOR UPDATE', [req.auth.id]);
        const currentBal = Number(studentRes.rows[0]?.wallet_balance || 0);
        if (currentBal < RENEWAL_AMOUNT) {
            await client.query('ROLLBACK');
            return res.status(422).json({ error: 'insufficient_balance', message: `Insufficient wallet balance. You need ₦${RENEWAL_AMOUNT.toLocaleString()} to renew.` });
        }

        // Debit student wallet
        await client.query('UPDATE students SET wallet_balance = wallet_balance - $1 WHERE id = $2', [RENEWAL_AMOUNT, req.auth.id]);

        const receipt = `ZG-ADR-W-${Date.now()}-${String(id).padStart(4, '0')}`;
        await client.query(
            `INSERT INTO wallet_transactions
                (student_id, type, amount, fee_amount, status, receipt_number, gateway, description, metadata)
             VALUES ($1, 'ad_renewal', $2, $2, 'success', $3, 'Student Wallet', $4, $5)`,
            [
                req.auth.id,
                RENEWAL_AMOUNT,
                receipt,
                `Advert Renewal: ${application.business_name} (${application.title})`,
                JSON.stringify({ adId: id, method: 'wallet_balance', days: application.plan_days })
            ]
        );

        const newExpiry = new Date(Date.now() + application.plan_days * 24 * 60 * 60 * 1000);
        const updated = await client.query(
            `UPDATE ad_applications
             SET status = 'live', renewed_at = now(), expires_at = $1, expiry_notice_sent_at = NULL, updated_at = now()
             WHERE id = $2 RETURNING *`,
            [newExpiry, id]
        );

        if (application.content_card_id) {
            await client.query('UPDATE content_cards SET active = true, updated_at = now() WHERE id = $1', [application.content_card_id]);
        }

        await client.query('COMMIT');
        const renewedApp = updated.rows[0];
        alertAdminsOfRenewal(renewedApp).catch(() => {});
        res.json({ success: true, expiresAt: renewedApp.expires_at, receipt });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[Ad Wallet Renew Error]', err);
        res.status(500).json({ error: 'internal_error' });
    } finally {
        client.release();
    }
});

// ------------------------------------------------------------------
// Expiry sweep — checks for live ads past their expires_at, pulls the
// banner down, and emails the student a renewal link. Runs every 15
// minutes; no extra dependency (node-cron) needed for that cadence.
//
// expireOneApplication() holds the actual per-row work so a single ad can
// also be expired on demand (see the admin "simulate expiry" route), not
// just by the scheduled sweep.
// ------------------------------------------------------------------
async function expireOneApplication(application) {
    if (application.content_card_id) {
        await pool.query('UPDATE content_cards SET active = false, updated_at = now() WHERE id = $1', [application.content_card_id]);
    }
    const reference = `ZG_AD_RENEW_${application.id}_${Date.now()}_${crypto.randomInt(100, 999)}`;
    const redirectUrl = APP_BASE_URL ? `${APP_BASE_URL}/zira_go_student_wallet.html?adRenewalRef=${encodeURIComponent(reference)}&adId=${application.id}` : undefined;
    let checkoutUrl = null;
    try {
        const result = await initializeKorapayFunding({
            email: application.email,
            amount: RENEWAL_AMOUNT,
            reference,
            customerName: application.business_name,
            redirectUrl
        });
        checkoutUrl = result.checkoutUrl;
    } catch (payErr) {
        console.warn('[Ad Expiry] Korapay checkout not available:', payErr.message);
    }

    const updated = await pool.query(
        `UPDATE ad_applications
         SET status = 'expired_pending_renewal', renewal_reference = COALESCE($1, renewal_reference),
             expiry_notice_sent_at = now(), updated_at = now()
         WHERE id = $2 RETURNING *`,
        [checkoutUrl ? reference : null, application.id]
    );

    if (checkoutUrl) await sendRenewalEmail(application, checkoutUrl);
    return updated.rows[0];
}

async function runExpirySweep() {
    try {
        const expired = await pool.query(
            `SELECT * FROM ad_applications WHERE status = 'live' AND expires_at IS NOT NULL AND expires_at <= now()`
        );
        for (const application of expired.rows) {
            try {
                await expireOneApplication(application);
            } catch (rowErr) {
                console.warn('[Ad Expiry Sweep] row error', application.id, rowErr.message);
            }
        }
    } catch (e) {
        console.warn('[Ad Expiry Sweep]', e.message);
    }
}
setInterval(runExpirySweep, 15 * 60 * 1000);
setTimeout(runExpirySweep, 30 * 1000); // one soon-after-boot pass too

module.exports = router;
module.exports.PLANS = PLANS;
module.exports.RENEWAL_AMOUNT = RENEWAL_AMOUNT;
module.exports.sendApprovedEmail = sendApprovedEmail;
module.exports.sendRejectedEmail = sendRejectedEmail;
module.exports.expireOneApplication = expireOneApplication;
