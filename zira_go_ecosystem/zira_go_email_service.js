// zira_go_email_service.js
// Sends transactional email via the Resend HTTP API. Render's free web
// services block outbound traffic on SMTP ports 25/465/587, so nodemailer
// with Gmail SMTP can never connect from there — this goes over HTTPS
// instead, which isn't blocked.
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || 'onboarding@resend.dev';

const isConfigured = Boolean(RESEND_API_KEY);
if (isConfigured) {
  console.log('[Email] Resend configured, sending from:', EMAIL_FROM);
} else {
  console.warn('[Email] RESEND_API_KEY not set — email sending is disabled.');
}

// Throws on failure — callers decide how to handle/log it, same pattern as
// the old mailer.sendMail() calls this replaces.
async function sendEmail({ to, subject, html, text, fromName = 'Zira Go', attachments = [] }) {
  if (!isConfigured) {
    throw new Error('RESEND_API_KEY is not configured.');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const payload = {
      from: `${fromName} <${EMAIL_FROM}>`,
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
      ...(text ? { text } : {})
    };
    if (Array.isArray(attachments) && attachments.length > 0) {
      payload.attachments = attachments.map(att => ({
        filename: att.filename,
        content: att.content, // base64 string
        content_type: att.content_type || att.contentType,
        cid: att.cid
      }));
    }
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Resend API error (${response.status}): ${errText}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { sendEmail, isConfigured };
