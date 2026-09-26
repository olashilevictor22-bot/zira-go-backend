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
  const safeTitle = String(title || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const safeBody = String(body || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const appBaseUrl = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
  const logoUrl = appBaseUrl ? `${appBaseUrl}/zira_go_logo.png` : 'https://raw.githubusercontent.com/omoyaj/assets/main/zira_go_logo.png';
  
  const mediaBlock = imageUrl ? `
    <div style="margin:20px 0;border-radius:12px;overflow:hidden;border:1px solid #E2E8F0;">
      <img src="${String(imageUrl).replace(/"/g, '&quot;')}" alt="Broadcast Media" style="display:block;width:100%;max-height:280px;object-fit:cover;">
    </div>` : '';

  const html = `
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"></head>
    <body style="margin:0;padding:0;background-color:#F8FAFC;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0F172A;">
      <table width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color:#F8FAFC;padding:32px 16px;">
        <tr>
          <td align="center">
            <table width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width:560px;background-color:#FFFFFF;border-radius:16px;overflow:hidden;border:1px solid #E2E8F0;box-shadow:0 4px 16px rgba(0,0,0,0.04);">
              <!-- Corporate Brand Header -->
              <tr>
                <td style="background:linear-gradient(135deg, #1E1035 0%, #3B1676 100%);padding:24px 28px;text-align:left;">
                  <table width="100%" border="0" cellspacing="0" cellpadding="0">
                    <tr>
                      <td style="vertical-align:middle;">
                        <span style="font-size:22px;font-weight:800;color:#FFFFFF;letter-spacing:-0.02em;">Zira <span style="color:#FBBF24;">GO!</span></span>
                        <div style="font-size:11px;font-weight:600;color:#DDD6FE;letter-spacing:0.08em;text-transform:uppercase;margin-top:2px;">Landmark University Campus Transit</div>
                      </td>
                      <td align="right" style="vertical-align:middle;">
                        <span style="display:inline-block;padding:4px 10px;background:rgba(255,255,255,0.12);border:1px solid rgba(255,255,255,0.2);border-radius:999px;color:#FFFFFF;font-size:11px;font-weight:700;letter-spacing:0.04em;">Official Notice</span>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
              <!-- Content Section -->
              <tr>
                <td style="padding:28px 28px 24px 28px;">
                  <h1 style="margin:0 0 16px 0;font-size:20px;font-weight:800;color:#0F172A;line-height:1.35;letter-spacing:-0.01em;">${safeTitle}</h1>
                  ${mediaBlock}
                  <div style="font-size:14px;line-height:1.65;color:#334155;white-space:pre-line;">
${safeBody}
                  </div>
                </td>
              </tr>
              <!-- Footer Section -->
              <tr>
                <td style="background-color:#F8FAFC;border-top:1px solid #E2E8F0;padding:18px 28px;font-size:11.5px;color:#64748B;line-height:1.5;">
                  <table width="100%" border="0" cellspacing="0" cellpadding="0">
                    <tr>
                      <td>
                        <strong style="color:#0F172A;">Zira Go Transit Operations</strong><br>
                        Landmark University Campus Ecosystem • Verified Delivery
                      </td>
                      <td align="right" style="vertical-align:middle;">
                        <span style="color:#6D28D9;font-weight:700;">Confidential</span>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </body>
    </html>
  `;

  return sendEmail({
    to: email,
    subject: title,
    text: body,
    html
  });
}

// Fire off a batch of async jobs with only `limit` running at once, instead of
// every job starting simultaneously.
async function runWithConcurrency(items, limit, worker) {
  let i = 0;
  async function lane() { while (i < items.length) { const item = items[i++]; try { await worker(item); } catch (err) { console.warn('[notifyRole email]', err.message); } } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

async function notify({ userId, role, title, body, type = 'system', actionUrl = null, imageUrl = null, email = false }) {
  const result = await pool.query(`INSERT INTO notifications (recipient_id, recipient_role, title, body, type, action_url, image_url) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [userId, role, title, body, type, actionUrl, imageUrl]);
  if (email) sendNotificationEmail({ userId, role, title, body, imageUrl }).catch(err => console.warn('[Notification email]', err.message));
  emitToUser(role, userId, 'notification', result.rows[0]);
  return result.rows[0];
}

// Same idea as notify(), but for "every student" / "every driver" at once —
// used by broadcasts and by "Publish to users" on the change timeline.
async function notifyRole(role, { title, body, type = 'broadcast', actionUrl = null, imageUrl = null, email = false }) {
  const table = role === 'student' ? 'students' : 'drivers';
  const users = await pool.query(`SELECT id, email FROM ${table}`);
  if (!users.rows.length) return [];
  const ids = users.rows.map(u => u.id);
  const inserted = await pool.query(
    `INSERT INTO notifications (recipient_id, recipient_role, title, body, type, action_url, image_url)
     SELECT unnest($1::bigint[]), $2, $3, $4, $5, $6, $7
     RETURNING *`,
    [ids, role, title, body, type, actionUrl, imageUrl || null]
  );
  for (const row of inserted.rows) emitToUser(role, row.recipient_id, 'notification', row);
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
