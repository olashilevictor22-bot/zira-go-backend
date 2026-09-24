const express = require('express');
const { requireAuth } = require('./zira_go_auth_routes');
const { sendEmail, isConfigured: emailConfigured } = require('./zira_go_email_service');
const router = express.Router();

// Existing deployments may have applied the original notification table before
// banner support was introduced. Keep this additive upgrade safe on startup.
(async () => {
  try { await pool.query('ALTER TABLE notifications ADD COLUMN IF NOT EXISTS image_url TEXT'); }
  catch (err) { console.warn('[Notification schema]', err.message); }
})();

async function sendNotificationEmail({ userId, role, title, body, imageUrl }) {
  if (!emailConfigured || !['student', 'driver'].includes(role)) return;
  const table = role === 'student' ? 'students' : 'drivers';
  const recipient = await pool.query(`SELECT email FROM ${table} WHERE id = $1`, [userId]);
  const email = recipient.rows[0]?.email;
  if (!email) return;
  const image = imageUrl ? `<img src="${String(imageUrl).replace(/"/g, '&quot;')}" alt="Notification banner" style="display:block;width:100%;max-height:260px;object-fit:cover;border-radius:12px;margin:0 0 18px">` : '';
  await sendEmail({ to: email, subject: title, text: body, html: `<div style="font-family:Arial,sans-serif;max-width:540px;margin:auto;padding:24px;color:#0f172a">${image}<h2 style="color:#6d28d9">${title}</h2><p style="white-space:pre-line;line-height:1.55">${body}</p><p style="color:#64748b;font-size:12px">Zira Go · Landmark University</p></div>` });
}

async function notify({ userId, role, title, body, type = 'system', actionUrl = null, imageUrl = null, email = false }) {
  const result = await pool.query(`INSERT INTO notifications (recipient_id, recipient_role, title, body, type, action_url, image_url) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [userId, role, title, body, type, actionUrl, imageUrl]);
  if (email) sendNotificationEmail({ userId, role, title, body, imageUrl }).catch(err => console.warn('[Notification email]', err.message));
  return result.rows[0];
}

router.get('/', requireAuth, async (req, res) => {
  const result = await pool.query(`SELECT id,title,body,type,action_url,image_url,read_at,created_at FROM notifications WHERE recipient_id=$1 AND recipient_role=$2 ORDER BY created_at DESC LIMIT 50`, [req.auth.id, req.auth.role]);
  res.json(result.rows);
});
router.post('/:id/read', requireAuth, async (req, res) => {
  await pool.query(`UPDATE notifications SET read_at=COALESCE(read_at,now()) WHERE id=$1 AND recipient_id=$2 AND recipient_role=$3`, [req.params.id, req.auth.id, req.auth.role]);
  res.json({ success: true });
});
router.post('/read-all', requireAuth, async (req, res) => {
  await pool.query(`UPDATE notifications SET read_at=COALESCE(read_at,now()) WHERE recipient_id=$1 AND recipient_role=$2`, [req.auth.id, req.auth.role]);
  res.json({ success: true });
});
module.exports = router;
module.exports.notify = notify;
