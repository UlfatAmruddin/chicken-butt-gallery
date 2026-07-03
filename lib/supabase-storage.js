'use strict';
/* Optional Supabase Storage backend for uploaded images. If .supabase.json is
   present at the project root, images upload to a public Storage bucket and the
   public URL is stored on the post; otherwise callers fall back to local disk.
   Zero dependencies: talks to the Supabase Storage REST API via fetch. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
/* Prefer environment variables (Vercel / any host) and fall back to the local
   .supabase.json file for dev. The key is a service-role credential and stays
   server-only; only public object URLs ever reach the client. */
let CONFIG = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_KEY && process.env.SUPABASE_BUCKET) {
  CONFIG = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_KEY, bucket: process.env.SUPABASE_BUCKET };
} else {
  try { CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, '.supabase.json'), 'utf8')); } catch { CONFIG = null; }
}
const CONFIGURED = !!(CONFIG && CONFIG.url && CONFIG.key && CONFIG.bucket);
const PUBLIC_PREFIX = CONFIGURED ? `${CONFIG.url}/storage/v1/object/public/${CONFIG.bucket}/` : '';

function isConfigured() { return CONFIGURED; }
function isSupabaseUrl(s) { return CONFIGURED && typeof s === 'string' && s.startsWith(PUBLIC_PREFIX); }

/* Verify the decoded bytes match the declared image type (same check as local). */
function sniff(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return '';
}

/* Upload a data URL. Returns { file: publicUrl } or { error }. */
async function uploadDataUrl(dataUrl, subdir, basename, maxBytes = 12 * 1024 * 1024) {
  const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(String(dataUrl || ''));
  if (!m) return { error: 'Pick an image first.' };
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > maxBytes) return { error: `Image too large (${Math.round(maxBytes / 1048576)}MB max).` };
  if (sniff(buf) !== m[1]) return { error: 'That file is not a valid image.' };
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const contentType = m[1] === 'jpeg' ? 'image/jpeg' : `image/${m[1]}`;
  const safe = String(basename).replace(/[^a-z0-9_-]/gi, '') || 'img';
  // 128 bits of randomness so a public-bucket object URL can't be guessed/enumerated
  // from the (known) subdir + basename + timestamp - the URL is effectively a secret.
  const key = `${subdir}/${safe}-${Date.now()}-${crypto.randomBytes(16).toString('hex')}.${ext}`;
  try {
    const r = await fetch(`${CONFIG.url}/storage/v1/object/${CONFIG.bucket}/${key}`, {
      method: 'POST',
      headers: { apikey: CONFIG.key, Authorization: `Bearer ${CONFIG.key}`, 'Content-Type': contentType, 'x-upsert': 'true' },
      body: buf,
    });
    if (!r.ok) { console.error('[supabase] upload failed', r.status, await r.text().catch(() => '')); return { error: 'Upload failed. Try again.' }; }
    return { file: PUBLIC_PREFIX + key };
  } catch (e) {
    console.error('[supabase] upload error:', e.message);
    return { error: 'Upload failed. Try again.' };
  }
}

/* Delete an object given its public URL. Returns true on success. */
async function deleteByUrl(fileUrl) {
  if (!isSupabaseUrl(fileUrl)) return false;
  const key = fileUrl.slice(PUBLIC_PREFIX.length);
  try {
    const r = await fetch(`${CONFIG.url}/storage/v1/object/${CONFIG.bucket}/${key}`, {
      method: 'DELETE',
      headers: { apikey: CONFIG.key, Authorization: `Bearer ${CONFIG.key}` },
    });
    return r.ok;
  } catch { return false; }
}

module.exports = { isConfigured, isSupabaseUrl, uploadDataUrl, deleteByUrl, sniff };
