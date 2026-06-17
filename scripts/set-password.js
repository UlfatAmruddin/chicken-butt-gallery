'use strict';
/* Reset a user's password from the server console - for initial admin setup or
   lockout recovery. The new password is read from STDIN so it is never stored in
   shell history. All of the user's existing sessions are revoked.

   Usage:
     node scripts/set-password.js <username>
   e.g. (paste the password when prompted, or pipe it):
     printf '%s' 'a-strong-passphrase' | node scripts/set-password.js <username> */
const crypto = require('crypto');
const config = require('../lib/config');
const { users, sessions, saveJSON } = require('../lib/store');
const { hashPass } = require('../lib/helpers');

const username = String(process.argv[2] || '').trim().toLowerCase();
if (!username) { console.error('Usage: node scripts/set-password.js <username>   (new password on stdin)'); process.exit(1); }
if (!users[username]) { console.error(`No such user: ${username}`); process.exit(1); }

if (process.stdin.isTTY) process.stderr.write(`New password for ${username}: `);
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { data += c; });
process.stdin.on('end', () => {
  const pw = data.replace(/\r?\n$/, '');
  if (pw.length < config.MIN_PASSWORD_LEN) {
    console.error(`Password must be at least ${config.MIN_PASSWORD_LEN} characters.`);
    process.exit(1);
  }
  const salt = crypto.randomBytes(16).toString('hex');
  users[username].salt = salt;
  users[username].hash = hashPass(pw, salt);
  saveJSON('users.json', users);
  // Revoke all of this user's sessions so a reset-after-compromise is effective.
  let revoked = 0;
  for (const t of Object.keys(sessions)) {
    const e = sessions[t];
    const name = typeof e === 'string' ? e : e && e.username;
    if (name === username) { delete sessions[t]; revoked++; }
  }
  if (revoked) saveJSON('sessions.json', sessions);
  console.log(`Password updated for ${username}; ${revoked} session(s) revoked.`);
});
