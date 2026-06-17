'use strict';
/* Pluggable, zero-dependency mailer. With RESEND_API_KEY set it sends via the
   Resend HTTP API (just fetch - no SDK). Without it, "dev mode" prints the code
   to the server log so the whole 2FA flow is testable locally with no provider. */
const config = require('./config');

const PURPOSE_COPY = {
  verify: { subject: 'Verify your email', line: 'Use this code to verify your email' },
  '2fa': { subject: 'Your login code', line: 'Use this code to finish logging in' },
};

async function sendCode(email, code, purpose) {
  const copy = PURPOSE_COPY[purpose] || PURPOSE_COPY['2fa'];
  const subject = `${config.APP_NAME} - ${copy.subject}`;
  const text = `${copy.line}:\n\n${code}\n\nIt expires in ${Math.round(config.CODE_TTL_MS / 60000)} minutes. If you didn't request this, you can ignore this email.`;

  if (!config.RESEND_API_KEY) {
    // Dev mode - no provider configured. Surface the code in the server log.
    console.log(`\n[mail:dev] to=${email} purpose=${purpose} CODE=${code}\n`);
    return { ok: true, dev: true };
  }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: config.MAIL_FROM, to: [email], subject, text }),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      console.error(`[mail] send failed ${r.status}: ${detail}`);
      return { ok: false };
    }
    return { ok: true };
  } catch (e) {
    console.error('[mail] send error:', e.message);
    return { ok: false };
  }
}

module.exports = { sendCode };
