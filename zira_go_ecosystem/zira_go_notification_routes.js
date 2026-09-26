const express = require('express');
const { requireAuth } = require('./zira_go_auth_routes');
const { sendEmail, isConfigured: emailConfigured } = require('./zira_go_email_service');
const { openStream, addUserStream, removeUserStream, emitToUser } = require('./zira_go_realtime');
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
  return sendNotificationEmailTo(email, { title, body, imageUrl });
}

// The actual send, once we already have an address in hand — factored out so
// notifyRole() below (which already has every recipient's email from its one
// bulk lookup) doesn't re-run a SELECT per user just to get what it already has.
function sendNotificationEmailTo(email, { title, body, imageUrl }) {
  const image = imageUrl ? `<img src="${String(imageUrl).replace(/"/g, '&quot;')}" alt="Notification banner" style="display:block;width:100%;max-height:260px;object-fit:cover;border-radius:12px;margin:0 0 18px">` : '';
  return sendEmail({ to: email, subject: title, text: body, html: `<div style="font-family:Arial,sans-serif;max-width:540px;margin:auto;padding:24px;color:#0f172a">${image}<h2 style="color:#6d28d9">${title}</h2><p style="white-space:pre-line;line-height:1.55">${body}</p><p style="color:#64748b;font-size:12px">Zira Go · Landmark University</p></div>` });
}

// Fire off a batch of async jobs with only `limit` running at once, instead of
// every job starting simultaneously (Promise.all over a .map does that) — for
// a few hundred students that used to mean a few hundred concurrent Resend
// HTTP requests (and a few hundred concurrent AbortController timeouts) fired
// in the same tick, which is how you get rate-limited or time out for no reason.
async function runWithConcurrency(items, limit, worker) {
  let i = 0;
  async function lane() { while (i < items.length) { const item = items[i++]; try { await worker(item); } catch (err) { console.warn('[notifyRole email]', err.message); } } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

async function notify({ userId, role, title, body, type = 'system', actionUrl = null, imageUrl = null, email = false }) {
  const result = await pool.query(`INSERT INTO notifications (recipient_id, recipient_role, title, body, type, action_url, image_url) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [userId, role, title, body, type, actionUrl, imageUrl]);
  if (email) sendNotificationEmail({ userId, role, title, body, imageUrl }).catch(err => console.warn('[Notification email]', err.message));
  // Push it live to any open tab for this student/driver — the wallet and
  // driver panel bells no longer have to wait for their 60s poll to notice.
  emitToUser(role, userId, 'notification', result.rows[0]);
  return result.rows[0];
}

// Same idea as notify(), but for "every student" / "every driver" at once —
// used by broadcasts and by "Publish to users" on the change timeline. This
// used to be `users.rows.map(u => notify(...))`: one INSERT per recipient
// (a few hundred round-trips to Postgres for a few hundred students) plus,
// with email on, a per-recipient SELECT just to re-fetch the address the
// caller already had. Now it's one INSERT for the whole role and one SELECT
// for the addresses, with email sends trickled out a handful at a time.
async function notifyRole(role, { title, body, type = 'broadcast', actionUrl = null, imageUrl = null, email = false }) {
  const table = role === 'student' ? 'students' : 'drivers';
  const users = await pool.query(`SELECT id, email FROM ${table}`);
  if (!users.rows.length) return [];
  const ids = users.rows.map(u => u.id);
  const inserted = await pool.query(
    `INSERT INTO notifications (recipient_id, recipient_role, title, body, type, action_url, image_url)
     SELECT unnest($1::bigint[]), $2, $3, $4, $5, $6
     RETURNING *`,
    [ids, role, title, body, type, actionUrl]
  );
  // image_url wasn't in the SELECT list above (unnest needs one array per
  // column and imageUrl is the same value for every row, not per-user) — set
  // it directly on the insert instead of threading it through unnest.
  if (imageUrl) await pool.query(`UPDATE notifications SET image_url = $1 WHERE id = ANY($2::bigint[])`, [imageUrl, inserted.rows.map(r => r.id)]);
  for (const row of inserted.rows) emitToUser(role, row.recipient_id, 'notification', imageUrl ? { ...row, image_url: imageUrl } : row);
  if (email && emailConfigured) {
    const emailByUser = new Map(users.rows.map(u => [Number(u.id), u.email]));
    runWithConcurrency(inserted.rows, 8, row => {
      const to = emailByUser.get(Number(row.recipient_id));
      return to ? sendNotificationEmailTo(to, { title, body, imageUrl }) : Promise.resolve();
    }).catch(() => {});
  }
  return inserted.rows;
}

// GET /api/notifications/stream — Server-Sent Events. The client opens this
// once on load and gets pushed new notifications as they're created, instead
// of only ever finding out on the next poll. Kept alongside (not instead of)
// the polling GET below, so a flaky connection or an older client still works.
router.get('/stream', requireAuth, (req, res) => {
  openStream(req, res, {
    register: r => addUserStream(req.auth.role, req.auth.id, r),
    unregister: r => removeUserStream(req.auth.role, req.auth.id, r)
  });
});

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
module.exports.notifyRole = notifyRole;
