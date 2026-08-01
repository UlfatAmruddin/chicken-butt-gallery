'use strict';
/* Optional Supabase Storage backend for uploaded images. If .supabase.json is
   present at the project root, images upload to a public Storage bucket and the
   public URL is stored on the post; otherwise callers fall back to local disk.
   Zero dependencies: talks to the Supabase Storage REST API via fetch. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
/* Prefer environment variables (any host) and fall back to the local
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
// Cap every Storage fetch so a stalled socket fails fast into the caller's error
// path (return {error} / false) instead of hanging the request until the host kills it.
const STORAGE_FETCH_TIMEOUT_MS = 12000;

function isConfigured() { return CONFIGURED; }
function isSupabaseUrl(s) { return CONFIGURED && typeof s === 'string' && s.startsWith(PUBLIC_PREFIX); }

/* Verify the decoded bytes match the declared image type (same check as local). */
function sniff(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return '';
}

const MAX_MEGAPIXELS = 40;   // reject decoded pixel counts over this (decompression-bomb guard)
/* Read width x height from the image HEADER bytes without decoding pixels. Returns
   null when it can't be determined (then callers do not block). */
function imageDimensions(buf, type) {
  try {
    if (type === 'png') {
      if (buf.length < 24) return null;
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };   // IHDR width/height
    }
    if (type === 'jpeg') {
      let o = 2;   // past SOI
      while (o + 9 < buf.length) {
        if (buf[o] !== 0xff) { o++; continue; }
        const marker = buf[o + 1];
        if (marker === 0xff) { o++; continue; }                                        // fill byte
        if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { o += 2; continue; } // standalone
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { h: buf.readUInt16BE(o + 5), w: buf.readUInt16BE(o + 7) };           // SOF frame header
        }
        const len = buf.readUInt16BE(o + 2);
        if (len < 2) return null;
        o += 2 + len;
      }
      return null;
    }
    if (type === 'webp') {
      if (buf.length < 30) return null;
      const cc = buf.toString('latin1', 12, 16);
      if (cc === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
      if (cc === 'VP8L') {
        const b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24];
        return { w: 1 + (((b1 & 0x3f) << 8) | b0), h: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) };
      }
      if (cc === 'VP8X') {
        return { w: 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16)), h: 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16)) };
      }
    }
  } catch { /* fall through to null */ }
  return null;
}
/* True if the image's declared canvas exceeds the megapixel cap - a decompression
   bomb (tiny file, huge canvas) that would OOM a viewer's browser. Unknown -> allow. */
function dimensionsTooLarge(buf, type) {
  const d = imageDimensions(buf, type);
  return !!(d && d.w > 0 && d.h > 0 && d.w * d.h > MAX_MEGAPIXELS * 1e6);
}

/* Decode a data: URL and run every image gate (format allow-list, size cap,
   magic-byte match, decompression-bomb dimensions) in ONE place, so the local-disk
   and Supabase upload paths can never enforce different rules. Returns
   { buf, type, ext } or { error }. */
function decodeAndValidateImageDataUrl(dataUrl, maxBytes = 12 * 1024 * 1024) {
  const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(String(dataUrl || ''));
  if (!m) return { error: 'Pick an image first.' };
  const type = m[1];
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > maxBytes) return { error: `Image too large (${Math.round(maxBytes / 1048576)}MB max).` };
  if (sniff(buf) !== type) return { error: 'That file is not a valid image.' };
  if (dimensionsTooLarge(buf, type)) return { error: `Image resolution too large (${MAX_MEGAPIXELS}MP max).` };
  return { buf, type, ext: type === 'jpeg' ? 'jpg' : type };
}

/* Upload a data URL. Returns { file: publicUrl } or { error }. */
async function uploadDataUrl(dataUrl, subdir, basename, maxBytes = 12 * 1024 * 1024) {
  const v = decodeAndValidateImageDataUrl(dataUrl, maxBytes);
  if (v.error) return { error: v.error };
  const { buf, type, ext } = v;
  const contentType = type === 'jpeg' ? 'image/jpeg' : `image/${type}`;
  const safe = String(basename).replace(/[^a-z0-9_-]/gi, '') || 'img';
  // 128 bits of randomness so a public-bucket object URL can't be guessed/enumerated
  // from the (known) subdir + basename + timestamp - the URL is effectively a secret.
  const key = `${subdir}/${safe}-${Date.now()}-${crypto.randomBytes(16).toString('hex')}.${ext}`;
  try {
    const r = await fetch(`${CONFIG.url}/storage/v1/object/${CONFIG.bucket}/${key}`, {
      method: 'POST',
      headers: { apikey: CONFIG.key, Authorization: `Bearer ${CONFIG.key}`, 'Content-Type': contentType, 'x-upsert': 'true' },
      body: buf,
      signal: AbortSignal.timeout(STORAGE_FETCH_TIMEOUT_MS),
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
      signal: AbortSignal.timeout(STORAGE_FETCH_TIMEOUT_MS),
    });
    return r.ok;
  } catch { return false; }
}

module.exports = { isConfigured, isSupabaseUrl, uploadDataUrl, deleteByUrl, sniff, dimensionsTooLarge, decodeAndValidateImageDataUrl };
