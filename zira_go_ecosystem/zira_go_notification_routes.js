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

const fs = require('fs');
const path = require('path');

function resolveMediaAttachment(imageUrl) {
  if (!imageUrl) return { src: null, isVideo: false, attachment: null, publicUrl: null };
  const raw = String(imageUrl).trim();
  const isVideo = /\.(mp4|webm|ogg|mov)(\?|$)/i.test(raw);
  const appBaseUrl = (process.env.APP_BASE_URL || process.env.RENDER_EXTERNAL_URL || 'https://therealzionbites.com.ng').replace(/\/$/, '');
  
  let localPath = null;
  if (raw.startsWith('/hero-media/')) {
    localPath = path.join(__dirname, 'uploads', 'hero-media', raw.replace('/hero-media/', ''));
  } else if (raw.startsWith('/content-media/')) {
    localPath = path.join(__dirname, 'uploads', 'content-media', raw.replace('/content-media/', ''));
  } else if (raw.startsWith('/ad-media/')) {
    localPath = path.join(__dirname, 'uploads', 'ad-media', raw.replace('/ad-media/', ''));
  } else if (raw.startsWith('/uploads/')) {
    localPath = path.join(__dirname, raw.replace(/^\//, ''));
  } else if (raw.startsWith('/') && !raw.startsWith('//')) {
    localPath = path.join(__dirname, raw.replace(/^\//, ''));
  }

  let publicUrl = raw;
  if (!raw.startsWith('http://') && !raw.startsWith('https://')) {
    publicUrl = `${appBaseUrl}${raw.startsWith('/') ? '' : '/'}${raw}`;
  }

  let attachment = null;
  if (localPath && fs.existsSync(localPath) && !isVideo) {
    try {
      const buf = fs.readFileSync(localPath);
      const ext = path.extname(localPath).toLowerCase().replace('.', '');
      const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/jpeg';
      const filename = path.basename(localPath);
      attachment = {
        filename,
        content: buf.toString('base64'),
        content_type: mime,
        cid: 'broadcast_media_img'
      };
    } catch (e) {
      console.warn('[resolveMediaAttachment]', e.message);
    }
  }

  const src = attachment ? 'cid:broadcast_media_img' : publicUrl;
  return { src, isVideo, attachment, publicUrl };
}

function getLogoAttachment() {
  const logoPath = path.join(__dirname, 'zira_go_logo.png');
  const appBaseUrl = (process.env.APP_BASE_URL || process.env.RENDER_EXTERNAL_URL || 'https://therealzionbites.com.ng').replace(/\/$/, '');
  const publicUrl = `${appBaseUrl}/zira_go_logo.png`;

  if (fs.existsSync(logoPath)) {
    try {
      const buf = fs.readFileSync(logoPath);
      return {
        src: 'cid:zira_go_official_logo',
        publicUrl,
        attachment: {
          filename: 'zira_go_logo.png',
          content: buf.toString('base64'),
          content_type: 'image/png',
          cid: 'zira_go_official_logo'
        }
      };
    } catch (_) {}
  }
  return { src: publicUrl, publicUrl, attachment: null };
}

// The actual send, once we already have an address in hand — factored out so
// notifyRole() below (which already has every recipient's email from its one
// bulk lookup) doesn't re-run a SELECT per user just to get what it already has.
function sendNotificationEmailTo(email, { title, body, imageUrl, actionUrl = null, actionText = null }) {
  const safeTitle = String(title || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const safeBody = String(body || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  
  const logoInfo = getLogoAttachment();
  const mediaInfo = resolveMediaAttachment(imageUrl);

  const attachments = [];
  if (logoInfo.attachment) attachments.push(logoInfo.attachment);
  if (mediaInfo.attachment) attachments.push(mediaInfo.attachment);

  let mediaBlock = '';
  if (mediaInfo.src) {
    if (mediaInfo.isVideo) {
      mediaBlock = `
        <div style="margin:20px 0 24px 0;border-radius:14px;overflow:hidden;border:1.5px solid #DDD6FE;background:linear-gradient(135deg, #1E0B36 0%, #2E1065 100%);text-align:center;padding:26px 18px;">
          <div style="display:inline-block;width:52px;height:52px;line-height:52px;border-radius:50%;background:#7C3AED;color:#FFFFFF;font-size:22px;margin-bottom:10px;">▶</div>
          <div style="font-size:14px;font-weight:700;color:#FFFFFF;margin-bottom:12px;">Video Broadcast Attached</div>
          <a href="${mediaInfo.publicUrl}" target="_blank" style="display:inline-block;padding:10px 22px;background:#8B5CF6;color:#FFFFFF;font-size:13px;font-weight:700;border-radius:8px;text-decoration:none;box-shadow:0 4px 12px rgba(124,58,237,0.35);">Watch Video Broadcast</a>
        </div>`;
    } else {
      mediaBlock = `
        <div style="margin:20px 0 24px 0;border-radius:14px;overflow:hidden;border:1px solid #E9D5FF;background:#0F172A;text-align:center;">
          <img src="${mediaInfo.src}" alt="Broadcast Media" width="100%" style="display:block;width:100%;max-width:100%;height:auto;max-height:360px;object-fit:cover;margin:0 auto;border:0;">
        </div>`;
    }
  }

  const actionBlock = actionUrl ? `
    <div style="margin:26px 0 10px 0;text-align:center;">
      <a href="${String(actionUrl).replace(/"/g, '&quot;')}" target="_blank" style="display:inline-block;padding:12px 28px;background:linear-gradient(135deg, #6D28D9 0%, #7C3AED 100%);color:#FFFFFF;font-size:14px;font-weight:700;border-radius:10px;text-decoration:none;box-shadow:0 4px 14px rgba(109,40,217,0.3);">${actionText || 'View Details'}</a>
    </div>` : '';

  const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <meta name="color-scheme" content="light dark">
      <meta name="supported-color-schemes" content="light dark">
      <style>
        @media only screen and (max-width: 540px) {
          .email-wrapper { padding: 12px 8px !important; }
          .email-container { width: 100% !important; max-width: 100% !important; border-radius: 14px !important; }
          .header-cell { padding: 20px 18px !important; }
          .brand-title { font-size: 19px !important; }
          .badge-cell { padding-top: 10px !important; display: block !important; text-align: left !important; width: 100% !important; }
          .badge-pill { display: inline-block !important; }
          .body-cell { padding: 22px 18px !important; }
          .title-heading { font-size: 18px !important; line-height: 1.3 !important; }
          .footer-cell { padding: 16px 18px !important; }
          .footer-table td { display: block !important; width: 100% !important; text-align: left !important; }
          .footer-badge-wrap { margin-top: 10px !important; }
        }
      </style>
    </head>
    <body style="margin:0;padding:0;background-color:#F5F3FF;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;color:#0F172A;">
      <table class="email-wrapper" width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color:#F5F3FF;padding:32px 16px;">
        <tr>
          <td align="center">
            <table class="email-container" width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width:560px;background-color:#FFFFFF;border-radius:18px;overflow:hidden;border:1px solid #E9D5FF;box-shadow:0 10px 25px -5px rgba(91,33,182,0.08), 0 8px 10px -6px rgba(91,33,182,0.04);">
              <!-- Brand Header -->
              <tr>
                <td class="header-cell" style="background:linear-gradient(135deg, #1E0B36 0%, #2E1065 50%, #4C1D95 100%);padding:24px 28px;text-align:left;">
                  <table width="100%" border="0" cellspacing="0" cellpadding="0">
                    <tr>
                      <td valign="middle" style="padding:0;">
                        <table border="0" cellspacing="0" cellpadding="0">
                          <tr>
                            <td valign="middle" style="padding-right:14px;">
                              <img src="${logoInfo.src}" alt="Zira Go" width="46" height="46" style="display:block;width:46px;height:46px;border-radius:12px;background:#FFFFFF;padding:3px;box-shadow:0 4px 10px rgba(0,0,0,0.25);object-fit:contain;">
                            </td>
                            <td valign="middle">
                              <div class="brand-title" style="font-size:21px;font-weight:900;color:#FFFFFF;letter-spacing:-0.02em;line-height:1.1;">
                                Zira <span style="color:#C084FC;">GO!</span>
                              </div>
                              <div style="font-size:10px;font-weight:700;color:#E9D5FF;letter-spacing:0.12em;text-transform:uppercase;margin-top:3px;">
                                Campus Tap & Move • Transit
                              </div>
                            </td>
                          </tr>
                        </table>
                      </td>
                      <td class="badge-cell" align="right" valign="middle" style="padding:0;white-space:nowrap;width:120px;">
                        <span class="badge-pill" style="display:inline-block;padding:5px 12px;background:rgba(255,255,255,0.12);border:1px solid rgba(255,255,255,0.25);border-radius:999px;color:#FFFFFF;font-size:11px;font-weight:700;letter-spacing:0.04em;white-space:nowrap;">
                          Official Notice
                        </span>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
              <!-- Content Section -->
              <tr>
                <td class="body-cell" style="padding:30px 28px 26px 28px;">
                  <h1 class="title-heading" style="margin:0 0 16px 0;font-size:20px;font-weight:800;color:#0F172A;line-height:1.35;letter-spacing:-0.015em;">${safeTitle}</h1>
                  ${mediaBlock}
                  <div style="font-size:14.5px;line-height:1.65;color:#334155;white-space:pre-line;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
${safeBody}
                  </div>
                  ${actionBlock}
                </td>
              </tr>
              <!-- Footer Section -->
              <tr>
                <td class="footer-cell" style="background-color:#FAF5FF;border-top:1px solid #F3E8FF;padding:18px 28px;font-size:11.5px;color:#64748B;line-height:1.5;">
                  <table class="footer-table" width="100%" border="0" cellspacing="0" cellpadding="0">
                    <tr>
                      <td valign="middle">
                        <strong style="color:#2E1065;font-weight:700;">Zira Go Transit Operations</strong><br>
                        <span style="color:#6B21A8;">Landmark University Campus Ecosystem • Verified Delivery</span>
                      </td>
                      <td class="footer-badge-wrap" align="right" valign="middle" style="width:90px;white-space:nowrap;">
                        <span style="display:inline-block;color:#6D28D9;background:#EDE9FE;border:1px solid #DDD6FE;border-radius:6px;padding:3px 8px;font-weight:700;font-size:10.5px;letter-spacing:0.02em;white-space:nowrap;">
                          Confidential
                        </span>
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
    html,
    fromName: 'Zira Go Campus Transit',
    attachments
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
