// Secure, human-reviewed wallet PIN recovery. Identity files are never public.
const express = require('express');
const multer = require('multer');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { sendEmail, isConfigured: emailConfigured } = require('./zira_go_email_service');
const { notify } = require('./zira_go_notification_routes');
const { requireAuth, requireRole } = require('./zira_go_auth_routes');
const { emitToAdmins } = require('./zira_go_realtime');

const uploadDir = path.join(__dirname, 'uploads', 'pin-review');
fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({ destination: uploadDir, filename: (_req, file, cb) => cb(null, `${Date.now()}-${crypto.randomUUID()}${path.extname(file.originalname)}`) }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = /^(image\/(jpeg|png|webp)|application\/pdf|video\/(mp4|quicktime|webm))$/;
    cb(allowed.test(file.mimetype) ? null : new Error('Upload a JPG, PNG, WEBP, PDF, MP4, MOV, or WebM file.'), allowed.test(file.mimetype));
  }
});
const router = express.Router();
const adminRouter = express.Router();
const codeHash = value => crypto.createHash('sha256').update(value).digest('hex');

// Escalating lockout on the approval-code check in /confirm below, mirroring
// the wallet-PIN lockout tiers in zira_go_trip_routes.js. Previously /confirm
// let a caller retry the six-digit code as many times as they wanted before
// it expired (15 min = plenty of time to brute-force with no rate limit).
// CODE_FAIL_LIMIT wrong guesses burns the current code (student must generate
// a fresh one, which re-sends by email); after MAX_CODE_LOCK_STAGE codes are
// burned this way, the whole identity-reviewed request is voided and the
// student must submit a brand new /request (with a fresh ID + selfie video).
const CODE_FAIL_LIMIT = 5;
const MAX_CODE_LOCK_STAGE = 3;

(async () => {
  await pool.query(`CREATE TABLE IF NOT EXISTS pin_change_requests (
    id BIGSERIAL PRIMARY KEY, student_id BIGINT NOT NULL REFERENCES students(id),
    document_path TEXT NOT NULL, selfie_video_path TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    review_note TEXT, reviewed_by BIGINT REFERENCES admins(id), reviewed_at TIMESTAMPTZ,
    approval_code_hash TEXT, approval_code_expires_at TIMESTAMPTZ, used_at TIMESTAMPTZ,
    code_fail_count INTEGER NOT NULL DEFAULT 0, code_lock_stage INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  // Self-heal for databases that already have this table from before the
  // lockout columns existed — IF NOT EXISTS makes this harmless to re-run.
  await pool.query(`ALTER TABLE pin_change_requests ADD COLUMN IF NOT EXISTS code_fail_count INTEGER NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE pin_change_requests ADD COLUMN IF NOT EXISTS code_lock_stage INTEGER NOT NULL DEFAULT 0`);
})().catch(err => console.error('[PIN review table]', err.message));

router.post('/request', requireAuth, requireRole('student'), upload.fields([{ name: 'identityDocument', maxCount: 1 }, { name: 'selfieVideo', maxCount: 1 }]), async (req, res) => {
  try {
    const identityDocument = req.files?.identityDocument?.[0], selfieVideo = req.files?.selfieVideo?.[0];
    if (!identityDocument || !selfieVideo) return res.status(400).json({ message: 'Both your ID document and selfie video are required.' });
    const active = await pool.query(`SELECT id FROM pin_change_requests WHERE student_id=$1 AND status IN ('pending','approved')`, [req.auth.id]);
    if (active.rows.length) return res.status(409).json({ message: 'You already have a PIN-change request under review.' });
    const created = await pool.query(`INSERT INTO pin_change_requests (student_id, document_path, selfie_video_path) VALUES ($1,$2,$3) RETURNING id, status, created_at`, [req.auth.id, identityDocument.path, selfieVideo.path]);
    const student = await pool.query('SELECT reg_no, email FROM students WHERE id = $1', [req.auth.id]);
    // Push it straight to any open Operations Desk tab so the Pending
    // drivers... err, Pending reviews queue doesn't need a manual refresh.
    emitToAdmins('pin-request', { ...created.rows[0], reg_no: student.rows[0]?.reg_no, email: student.rows[0]?.email });
    res.status(201).json({ success: true, request: created.rows[0] });
  } catch (err) { console.error('[PIN change request]', err); res.status(400).json({ message: 'Could not submit the request.' }); }
});

router.get('/status', requireAuth, requireRole('student'), async (req, res) => {
  const result = await pool.query(`SELECT id,status,review_note,created_at,reviewed_at,approval_code_expires_at FROM pin_change_requests WHERE student_id=$1 ORDER BY created_at DESC LIMIT 1`, [req.auth.id]);
  res.json({ request: result.rows[0] || null });
});

router.post('/confirm', requireAuth, requireRole('student'), async (req, res) => {
  const { requestId, code, newPin } = req.body;
  if (!/^\d{4}$/.test(newPin || '')) return res.status(400).json({ message: 'PIN must be exactly four digits.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(`SELECT * FROM pin_change_requests WHERE id=$1 AND student_id=$2 FOR UPDATE`, [requestId, req.auth.id]);
    const request = result.rows[0];
    if (!request || request.status !== 'approved' || request.used_at || !request.approval_code_hash || new Date(request.approval_code_expires_at) < new Date()) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'That approval code is invalid or expired.' });
    }

    const codeValid = codeHash(code || '') === request.approval_code_hash;
    if (codeValid) {
      await client.query('UPDATE students SET pin_hash=$1 WHERE id=$2', [await bcrypt.hash(newPin, 12), req.auth.id]);
      await client.query(`UPDATE pin_change_requests SET status='completed', used_at=now() WHERE id=$1`, [request.id]);
      await client.query('COMMIT');
      return res.json({ success: true, message: 'Your wallet PIN has been changed.' });
    }

    // Wrong code — count against this specific generated code.
    const newFailCount = request.code_fail_count + 1;
    if (newFailCount < CODE_FAIL_LIMIT) {
      await client.query(`UPDATE pin_change_requests SET code_fail_count=$1 WHERE id=$2`, [newFailCount, request.id]);
      await client.query('COMMIT');
      return res.status(401).json({ message: 'Incorrect approval code.', attemptsRemaining: CODE_FAIL_LIMIT - newFailCount });
    }

    // This code is burned. Either hand back a clean slate for a fresh code,
    // or — if too many codes have already been burned — void the whole
    // identity-reviewed request so a stolen session can't just keep grinding.
    const newStage = request.code_lock_stage + 1;
    if (newStage >= MAX_CODE_LOCK_STAGE) {
      await client.query(
        `UPDATE pin_change_requests
         SET status='rejected', review_note=$1, reviewed_at=now(),
             approval_code_hash=NULL, approval_code_expires_at=NULL, code_fail_count=0, code_lock_stage=$2
         WHERE id=$3`,
        ['Too many incorrect approval codes entered. Submit a new PIN-change request.', newStage, request.id]
      );
      await client.query('COMMIT');
      return res.status(423).json({
        error: 'pin_change_locked',
        message: 'Too many incorrect codes. This request has been closed for security — please submit a new PIN-change request.'
      });
    }

    await client.query(
      `UPDATE pin_change_requests SET approval_code_hash=NULL, approval_code_expires_at=NULL, code_fail_count=0, code_lock_stage=$1 WHERE id=$2`,
      [newStage, request.id]
    );
    await client.query('COMMIT');
    return res.status(423).json({
      error: 'code_locked',
      message: 'Too many incorrect codes. Generate a new approval code to try again.'
    });
  } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ message: 'Could not change PIN.' }); } finally { client.release(); }
});

adminRouter.use(requireAuth, requireRole('admin'));
adminRouter.get('/', async (_req, res) => {
  const result = await pool.query(`SELECT p.id,p.status,p.review_note,p.created_at,p.reviewed_at,s.reg_no,s.email FROM pin_change_requests p JOIN students s ON s.id=p.student_id ORDER BY p.created_at DESC LIMIT 100`);
  res.json(result.rows);
});
adminRouter.get('/:id/file/:kind', async (req, res) => {
  const col = req.params.kind === 'document' ? 'document_path' : req.params.kind === 'selfie' ? 'selfie_video_path' : null;
  if (!col) return res.status(404).end();
  const result = await pool.query(`SELECT ${col} AS file_path FROM pin_change_requests WHERE id=$1`, [req.params.id]);
  const filePath = result.rows[0]?.file_path;
  if (!filePath || !path.resolve(filePath).startsWith(path.resolve(uploadDir))) return res.status(404).end();
  res.setHeader('Cache-Control', 'no-store, private');
  res.sendFile(path.resolve(filePath));
});
adminRouter.post('/:id/approve', async (req, res) => {
  const row = await pool.query(`SELECT p.*,s.email,s.reg_no FROM pin_change_requests p JOIN students s ON s.id=p.student_id WHERE p.id=$1 AND p.status='pending'`, [req.params.id]);
  if (!row.rows.length) return res.status(404).json({ message: 'Pending request not found.' });
  const request = row.rows[0];
  await pool.query(`UPDATE pin_change_requests SET status='approved',reviewed_by=$1,reviewed_at=now(),review_note=$2,approval_code_hash=NULL,approval_code_expires_at=NULL WHERE id=$3`, [req.auth.id, req.body.note || null, request.id]);
  await notify({ userId: request.student_id, role: 'student', title: 'Wallet PIN change approved', body: 'Your identity check was approved. Open Change Wallet PIN and tap Generate approval code to receive it by email.', type: 'security' });
  res.json({ success: true, message: 'Approved. The student can now generate their approval code from the app.' });
});

router.post('/generate-code', requireAuth, requireRole('student'), async (req, res) => {
  const row = await pool.query(`SELECT p.*,s.email FROM pin_change_requests p JOIN students s ON s.id=p.student_id WHERE p.student_id=$1 AND p.status='approved' AND p.used_at IS NULL ORDER BY p.reviewed_at DESC LIMIT 1`, [req.auth.id]);
  if (!row.rows.length) return res.status(404).json({ message: 'There is no approved PIN-change request ready for a code.' });
  if (!emailConfigured) return res.status(503).json({ message: 'Email delivery is not configured yet. Please contact support.' });
  const request = row.rows[0], code = crypto.randomInt(100000, 1000000).toString(), expires = new Date(Date.now() + 15 * 60 * 1000);
  try {
    await sendEmail({ to: request.email, subject: `${code} is your Zira Go wallet PIN approval code`, text: `Your identity review is approved. Your code is ${code}. It expires in 15 minutes. Do not share this code.`, html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:28px;background:#f8f7ff;color:#172033"><div style="background:linear-gradient(135deg,#6d28d9,#8b5cf6);border-radius:18px;padding:22px;color:#fff"><div style="font-size:12px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;opacity:.85">Zira Go security</div><h1 style="font-size:24px;margin:8px 0 0">Wallet PIN change approved</h1></div><div style="background:#fff;border-radius:0 0 18px 18px;padding:26px;box-shadow:0 10px 28px rgba(43,27,90,.08)"><p style="margin-top:0;line-height:1.55">Your identity check has been approved. Use this one-time code in the Zira Go app to set your new wallet PIN.</p><div style="margin:24px 0;padding:18px;border-radius:14px;background:#f2ecff;text-align:center;font-family:monospace;font-size:30px;font-weight:800;letter-spacing:7px;color:#6d28d9">${code}</div><p style="font-size:13px;line-height:1.5;color:#5b6475">This code expires in <b>15 minutes</b>. Never share it with anyone — Zira Go support will never ask for this code.</p></div></div>` });
  } catch (mailErr) {
    console.error('[PIN approval code email failed]', mailErr.message);
    return res.status(502).json({ message: 'Could not send the approval code email. Please try again shortly.' });
  }
  await pool.query(`UPDATE pin_change_requests SET approval_code_hash=$1,approval_code_expires_at=$2 WHERE id=$3`, [codeHash(code), expires, request.id]);
  res.json({ success: true, message: 'A six-digit approval code was sent to your email.', expiresAt: expires });
});
adminRouter.post('/:id/reject', async (req, res) => { const result=await pool.query(`UPDATE pin_change_requests SET status='rejected',reviewed_by=$1,reviewed_at=now(),review_note=$2 WHERE id=$3 AND status='pending' RETURNING student_id,review_note`, [req.auth.id, req.body.note || 'Identity check could not be verified.', req.params.id]); if(result.rows[0]) await notify({ userId:result.rows[0].student_id,role:'student',title:'Wallet PIN change update',body:`Your identity review needs attention. ${result.rows[0].review_note}`,type:'security' }); res.json({ success: true }); });

module.exports = { router, adminRouter };
