'use strict';
/* Domain layer: HTTP helpers, auth/sessions + rate limiting, community/role
   logic, scoped queries, public serializers, image persistence, audit, and the
   one-time data migration (run on require). All state lives in ./store. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { securityHeaders } = require('./static');
const { sendCode } = require('./mailer');
const {
  ROOT, ASSETS_DIR, saveJSON,
  users, sessions, posts, albums, communities, auditEvents, devices,
  ADMIN_USERNAMES, KING_BOB_ID,
} = require('./store');

const {
  AUTH_WINDOW_MS, AUTH_MAX_ATTEMPTS, AUTH_IP_MAX, AUTH_FAIL_WINDOW_MS, AUTH_FAIL_MAX,
  SESSION_TTL_MS, WRITE_WINDOW_MS, WRITE_MAX, UPLOAD_WINDOW_MS, UPLOAD_MAX,
  MAINT_INTERVAL_MS, TRUST_PROXY, MAX_IMAGE_BYTES, MAX_AUDIT_EVENTS,
  CODE_TTL_MS, CODE_MAX_ATTEMPTS, CODE_SEND_WINDOW_MS, CODE_SEND_MAX, DEVICE_TTL_MS,
} = config;
const codeSends = new Map();      // rate-limit code emails, keyed by username
const codeSendsByEmail = new Map(); // and by destination email (anti inbox-bombing via fresh usernames)
const challenges = new Map();     // challenge token -> { username, purpose, codeHash, email, expires, attempts }
// Rolling-window hit buckets. Swept periodically (startMaintenance) so keys for
// transient IPs / usernames cannot accumulate without bound.
const authByPair = new Map();    // key: ip:username  - fine-grained
const authByIp = new Map();      // key: ip           - anti password-spray
const failByAccount = new Map(); // key: username     - anti distributed brute force
const writeAttempts = new Map(); // key: ip
const uploadAttempts = new Map();// key: username
const RATE_MAPS = [
  [authByPair, AUTH_WINDOW_MS], [authByIp, AUTH_WINDOW_MS], [failByAccount, AUTH_FAIL_WINDOW_MS],
  [writeAttempts, WRITE_WINDOW_MS], [uploadAttempts, UPLOAD_WINDOW_MS],
  [codeSends, CODE_SEND_WINDOW_MS], [codeSendsByEmail, CODE_SEND_WINDOW_MS],
];

/* Record a hit and return the count within the window. Deletes the key when the
   window is empty so abandoned buckets don't leak memory. */
function recordHit(map, key, windowMs) {
  const now = Date.now();
  const hits = (map.get(key) || []).filter(ts => now - ts < windowMs);
  hits.push(now);
  map.set(key, hits);
  return hits.length;
}
/* Count current hits without recording a new one (also prunes empty keys). */
function countHits(map, key, windowMs) {
  const now = Date.now();
  const hits = (map.get(key) || []).filter(ts => now - ts < windowMs);
  if (hits.length) map.set(key, hits); else map.delete(key);
  return hits.length;
}
function rateHit(map, key, max, windowMs) {
  return recordHit(map, key, windowMs) > max;
}

function send(res, code, obj) {
  res.writeHead(code, securityHeaders({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  }));
  res.end(JSON.stringify(obj));
}
function readBody(req, limit = 16 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function authUser(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!/^[a-f0-9]{48}$/i.test(token)) return null;
  const entry = sessions[token];
  const name = typeof entry === 'string' ? entry : entry && entry.username;
  if (entry && typeof entry !== 'string' && entry.expires && Date.now() > entry.expires) {
    delete sessions[token];
    saveJSON('sessions.json', sessions);
    return null;
  }
  if (typeof entry === 'string' && users[name]) {
    sessions[token] = { username: name, created: Date.now(), expires: Date.now() + SESSION_TTL_MS };
    saveJSON('sessions.json', sessions);
  }
  return name && users[name] ? { user: users[name], token } : null;
}
function createSession(username) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions[token] = { username, created: Date.now(), expires: Date.now() + SESSION_TTL_MS };
  saveJSON('sessions.json', sessions);
  return token;
}
function clientIp(req) {
  // Only honour X-Forwarded-For behind a trusted proxy - otherwise the header
  // is attacker-controlled and would let anyone forge a fresh rate-limit bucket.
  if (TRUST_PROXY) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return req.socket.remoteAddress || 'local';
}
/* Pre-credential gate on a login/register attempt (records the hit):
   - the IP is throttled across ALL usernames (stops password spraying);
   - the (IP, username) pair is throttled (per-target backstop).
   The account-failure dimension is deliberately NOT checked here - see
   accountLocked, which is consulted only for WRONG passwords so a correct
   password always lets the real owner in (no targeted lockout DoS). */
function authThrottled(req, username) {
  const ip = clientIp(req);
  const uname = clean(username, 20).toLowerCase();
  const ipHot = rateHit(authByIp, ip, AUTH_IP_MAX, AUTH_WINDOW_MS);
  const pairHot = rateHit(authByPair, `${ip}:${uname}`, AUTH_MAX_ATTEMPTS, AUTH_WINDOW_MS);
  return ipHot || pairHot;
}
/* Distributed-brute-force backstop: true once an account has accumulated too many
   recent FAILED logins across all IPs. Applied only to reject wrong passwords, so
   an attacker cannot lock out a user who knows their own password. */
function accountLocked(username) {
  return countHits(failByAccount, clean(username, 20).toLowerCase(), AUTH_FAIL_WINDOW_MS) >= AUTH_FAIL_MAX;
}
function recordAuthFailure(username) {
  recordHit(failByAccount, clean(username, 20).toLowerCase(), AUTH_FAIL_WINDOW_MS);
}
function clearAuthFailures(username) {
  failByAccount.delete(clean(username, 20).toLowerCase());
}
function tooManyWrites(req) {
  return rateHit(writeAttempts, clientIp(req), WRITE_MAX, WRITE_WINDOW_MS);
}
function tooManyUploads(username) {
  return rateHit(uploadAttempts, clean(username, 20).toLowerCase(), UPLOAD_MAX, UPLOAD_WINDOW_MS);
}

/* ---------------- email + 2FA codes, challenges, trusted devices ---------------- */
function validEmail(s) {
  const e = clean(s, 254);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e.toLowerCase() : '';
}
/* Is this email already the VERIFIED email of some other account? */
function emailInUse(emailLower, exceptUsername) {
  return Object.values(users).some(u => u.emailVerified && (u.email || '').toLowerCase() === emailLower && u.username !== exceptUsername);
}
function genCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}
function hashCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex'); // codes are short-lived + attempt-limited, not passwords
}
/* Create a pending auth challenge. purpose: 'email' (need an address, no code yet),
   'verify' (confirm email -> activates + logs in), or '2fa' (login second factor). */
function createChallenge(username, purpose, email = '') {
  const token = crypto.randomBytes(24).toString('hex');
  challenges.set(token, { username, purpose, email, codeHash: '', expires: Date.now() + CODE_TTL_MS, attempts: 0 });
  return token;
}
function getChallenge(token) {
  const c = challenges.get(String(token || ''));
  if (!c) return null;
  if (Date.now() > c.expires) { challenges.delete(token); return null; }
  return c;
}
function consumeChallenge(token) { challenges.delete(String(token || '')); }
/* Generate a code on a challenge and email it, honouring the per-account send cap. */
async function issueCode(token, email, purpose) {
  const c = challenges.get(token);
  if (!c) return { error: 'This request expired. Start again.' };
  const emailLower = String(email || '').toLowerCase();
  // Throttle on BOTH the account and the destination email, so an attacker can't
  // bomb a victim's inbox (or run up email cost) by cycling fresh usernames.
  const userHot = rateHit(codeSends, c.username, CODE_SEND_MAX, CODE_SEND_WINDOW_MS);
  const emailHot = rateHit(codeSendsByEmail, emailLower, CODE_SEND_MAX, CODE_SEND_WINDOW_MS);
  if (userHot || emailHot) return { error: 'Too many codes requested. Try again later.' };
  const code = genCode();
  c.codeHash = hashCode(code);
  c.expires = Date.now() + CODE_TTL_MS;
  c.attempts = 0;
  const sent = await sendCode(emailLower, code, purpose === '2fa' ? '2fa' : 'verify');
  if (!sent.ok) return { error: 'Could not send the code. Try again.' };
  return { ok: true };
}
/* Check a submitted code against a challenge; counts attempts and invalidates on too many. */
function checkCode(c, code) {
  if (!c.codeHash) return false;
  if (c.attempts >= CODE_MAX_ATTEMPTS) return false;
  c.attempts++;
  const a = Buffer.from(hashCode(code), 'hex');
  const b = Buffer.from(c.codeHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function trustDevice(username) {
  const token = crypto.randomBytes(24).toString('hex');
  devices[token] = { username, created: Date.now(), expires: Date.now() + DEVICE_TTL_MS };
  saveJSON('devices.json', devices);
  return token;
}
function deviceTrusted(token, username) {
  const d = devices[String(token || '')];
  if (!d) return false;
  if (Date.now() > d.expires) { delete devices[token]; saveJSON('devices.json', devices); return false; }
  return d.username === username;
}
function revokeUserDevices(username) {
  let changed = false;
  for (const t of Object.keys(devices)) {
    if (devices[t] && devices[t].username === username) { delete devices[t]; changed = true; }
  }
  if (changed) saveJSON('devices.json', devices);
}

/* Drop expired sessions from disk; presented-token expiry is handled lazily in
   authUser, but abandoned tokens (cleared storage, lost device) need a sweep. */
function sweepSessions() {
  const now = Date.now();
  let changed = false;
  for (const t of Object.keys(sessions)) {
    const e = sessions[t];
    if (e && typeof e === 'object' && e.expires && now > e.expires) { delete sessions[t]; changed = true; }
  }
  if (changed) saveJSON('sessions.json', sessions);
}
/* Periodic maintenance: prune empty rate-limit buckets and expired sessions.
   Started by the server (not on require) so tests don't spawn timers. */
function startMaintenance() {
  sweepSessions();
  const now = () => Date.now();
  return setInterval(() => {
    const t = now();
    for (const [m, win] of RATE_MAPS) {
      for (const [k, arr] of m) {
        const f = arr.filter(ts => t - ts < win);
        if (f.length) m.set(k, f); else m.delete(k);
      }
    }
    for (const [k, c] of challenges) if (t > c.expires) challenges.delete(k);
    let devChanged = false;
    for (const k of Object.keys(devices)) if (devices[k] && t > devices[k].expires) { delete devices[k]; devChanged = true; }
    if (devChanged) saveJSON('devices.json', devices);
    sweepSessions();
  }, MAINT_INTERVAL_MS).unref();
}
function hashPass(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
function isAdminUsername(username) {
  return ADMIN_USERNAMES.has(String(username || '').toLowerCase());
}
function clean(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max);
}
function slugify(v) {
  return clean(v, 80).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'community';
}
function uniqueCommunityId(name) {
  const base = slugify(name);
  let id = base;
  let n = 2;
  while (communities.some(c => c.id === id || c.slug === id)) id = `${base}-${n++}`;
  return id;
}
function findCommunity(id) {
  return communities.find(c => c.id === id || c.slug === id);
}
function communityMembers(c) {
  if (!c) return {};
  if (!c.members || Array.isArray(c.members)) c.members = {};
  return c.members;
}
function communityBans(c) {
  if (!c) return {};
  if (!c.banned || Array.isArray(c.banned)) c.banned = {};
  return c.banned;
}
function communityPrompts(c) {
  if (!c) return [];
  if (!Array.isArray(c.prompts)) c.prompts = [];
  return c.prompts;
}
function communityPinned(c) {
  if (!c) return [];
  if (!Array.isArray(c.pinnedPostIds)) c.pinnedPostIds = [];
  return c.pinnedPostIds;
}
function communityScopes(c) {
  if (!c) return [];
  if (!Array.isArray(c.scopes)) c.scopes = [];
  return c.scopes;
}
function roleFor(c, username) {
  if (!c || !username) return '';
  return communityMembers(c)[username] || '';
}
function isCommunityMember(c, username) {
  if (isAdminUsername(username)) return true;
  if (communityBans(c)[username]) return false;
  return !!roleFor(c, username);
}
function canAdminCommunity(c, username) {
  const role = roleFor(c, username);
  return role === 'owner' || role === 'admin' || isAdminUsername(username);
}
function canOwnCommunity(c, username) {
  return roleFor(c, username) === 'owner' || isAdminUsername(username);
}
function canChangeMember(actorRole, targetRole, nextRole, actorUsername, targetUsername) {
  if (isAdminUsername(actorUsername)) return true;
  if (actorUsername === targetUsername) return false;
  if (actorRole !== 'owner') return false;
  if (targetRole === 'owner') return false;
  return nextRole === 'admin' || nextRole === 'member';
}
function canRemoveMember(c, actorUsername, targetUsername) {
  if (actorUsername === targetUsername) return false;
  if (isAdminUsername(actorUsername)) return true;
  const actorRole = roleFor(c, actorUsername);
  const targetRole = roleFor(c, targetUsername);
  if (targetRole === 'owner') return false;
  if (actorRole === 'owner') return targetRole === 'admin' || targetRole === 'member';
  return actorRole === 'admin' && targetRole === 'member';
}
function requestCommunityId(req, params) {
  return clean(params.get('community') || params.get('communityId') || req.headers['x-community-id'] || '', 80);
}
function joinedCommunities(username) {
  return communities.filter(c => isCommunityMember(c, username));
}
function resolveCommunityForAuth(req, params, auth) {
  const requested = requestCommunityId(req, params);
  if (requested) return findCommunity(requested);
  const joined = joinedCommunities(auth.user.username);
  return joined.length === 1 ? joined[0] : null;
}
function requireAuth(req, res) {
  const auth = authUser(req);
  if (!auth) send(res, 401, { error: 'Not logged in.' });
  return auth;
}
function requireCommunity(req, res, params) {
  const auth = requireAuth(req, res);
  if (!auth) return null;
  const community = resolveCommunityForAuth(req, params, auth);
  if (!community) { send(res, 400, { error: 'Choose a community first.' }); return null; }
  if (!isCommunityMember(community, auth.user.username)) {
    send(res, 403, { error: 'You are not a member of this community.' });
    return null;
  }
  return { auth, community };
}
function scopedPosts(communityId) {
  return posts.filter(p => p.communityId === communityId);
}
function scopedAlbums(communityId) {
  return albums.filter(a => a.communityId === communityId);
}
function userPhotoCount(username, communityId) {
  return posts.filter(p => p.username === username && (!communityId || p.communityId === communityId)).length;
}
function publicProfile(u, communityId = '') {
  return {
    username: u.username,
    displayName: u.displayName,
    bio: u.bio || '',
    location: u.location || '',
    website: u.website || '',
    avatar: u.avatar || '',
    cover: u.cover || '',
    joined: u.joined,
    photoCount: userPhotoCount(u.username, communityId),
    isAdmin: isAdminUsername(u.username),
  };
}
function albumCoverFile(a) {
  const ids = a.photoIds || [];
  const coverId = a.cover && ids.includes(a.cover) ? a.cover : ids[0];
  const post = coverId && posts.find(p => p.id === coverId && p.communityId === a.communityId);
  return post ? post.file : '';
}
function publicAlbum(a) {
  return {
    id: a.id, owner: a.owner, communityId: a.communityId,
    name: a.name, description: a.description || '',
    cover: a.cover || '', coverFile: albumCoverFile(a),
    photoCount: (a.photoIds || []).length, created: a.created,
  };
}
function communityCoverFile(c) {
  if (c.cover) return c.cover;
  const latest = scopedPosts(c.id).sort((a, b) => b.created - a.created)[0];
  return latest ? latest.file : '';
}
function publicCommunity(c, username = '') {
  return {
    id: c.id,
    slug: c.slug || c.id,
    name: c.name,
    description: c.description || '',
    welcome: c.welcome || '',
    accent: c.accent || '#ffffff',
    owner: c.owner,
    coverFile: communityCoverFile(c),
    pinnedPostIds: communityPinned(c),
    scopes: communityScopes(c),
    activePromptId: c.activePromptId || '',
    memberCount: Object.keys(communityMembers(c)).length,
    photoCount: scopedPosts(c.id).length,
    albumCount: scopedAlbums(c.id).length,
    created: c.created,
    role: username ? roleFor(c, username) || (isAdminUsername(username) ? 'admin' : '') : '',
  };
}
function canManagePost(auth, post) {
  const community = findCommunity(post.communityId);
  return post.username === auth.user.username || canAdminCommunity(community, auth.user.username);
}
function assertSameCommunityPhoto(photoId, communityId) {
  return posts.some(p => p.id === photoId && p.communityId === communityId);
}
/* Verify the decoded bytes really are the image type the data URL claims, so a
   crafted payload can't smuggle a non-image (or type-confused) file onto disk. */
function sniffImage(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return 'png';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return '';
}
function saveDataUrlImage(dataUrl, relDir, basename, maxBytes = MAX_IMAGE_BYTES) {
  const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(String(dataUrl || ''));
  if (!m) return { error: 'Pick an image first.' };
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > maxBytes) return { error: `Image too large (${Math.round(maxBytes / 1048576)}MB max).` };
  if (sniffImage(buf) !== m[1]) return { error: 'That file is not a valid image.' };
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const safe = String(basename).replace(/[^a-z0-9_-]/gi, '') || 'img';
  const fname = `${safe}-${Date.now()}.${ext}`;
  const absDir = path.join(ROOT, relDir);
  fs.mkdirSync(absDir, { recursive: true });
  fs.writeFileSync(path.join(absDir, fname), buf);
  return { file: relDir.replace(/\\/g, '/') + '/' + fname };
}
function safeUnlinkAsset(relPath) {
  const target = path.resolve(ROOT, String(relPath || ''));
  const assetsRoot = path.resolve(ASSETS_DIR);
  if (!target.startsWith(assetsRoot + path.sep)) return false;
  try {
    fs.unlinkSync(target);
    return true;
  } catch {
    return false;
  }
}
function addAudit(communityId, actor, action, target = '', metadata = {}) {
  auditEvents.push({
    id: crypto.randomBytes(8).toString('hex'),
    communityId,
    actor,
    action,
    target,
    metadata,
    created: Date.now(),
  });
  // Bound the log so the array, heap, and the full-file rewrite stay constant-cost.
  if (auditEvents.length > MAX_AUDIT_EVENTS) auditEvents.splice(0, auditEvents.length - MAX_AUDIT_EVENTS);
  saveJSON('audit_events.json', auditEvents);
}
function memberList(c) {
  return Object.entries(communityMembers(c))
    .map(([username, role]) => users[username] ? { ...publicProfile(users[username], c.id), role } : null)
    .filter(Boolean)
    .sort((a, b) => {
      const order = { owner: 0, admin: 1, member: 2 };
      return (order[a.role] ?? 9) - (order[b.role] ?? 9) || a.username.localeCompare(b.username);
    });
}
function publicPrompt(p) {
  return {
    id: p.id,
    text: p.text,
    createdBy: p.createdBy,
    created: p.created,
    active: !!p.active,
  };
}
function activityFeed(c) {
  const events = [];
  scopedPosts(c.id).forEach(post => {
    events.push({
      id: `photo-${post.id}`,
      type: 'photo',
      actor: post.username,
      title: post.title || 'Untitled',
      photoId: post.id,
      file: post.file,
      created: post.created,
    });
    (post.comments || []).forEach(comment => events.push({
      id: `comment-${post.id}-${comment.id}`,
      type: 'comment',
      actor: comment.username,
      title: post.title || 'Untitled',
      photoId: post.id,
      file: post.file,
      text: comment.text,
      created: comment.created,
    }));
  });
  scopedAlbums(c.id).forEach(album => events.push({
    id: `album-${album.id}`,
    type: 'album',
    actor: album.owner,
    title: album.name,
    albumId: album.id,
    file: albumCoverFile(album),
    created: album.created,
  }));
  auditEvents
    .filter(e => e.communityId === c.id && ['member.joined', 'prompt.created', 'photo.pinned'].includes(e.action))
    .forEach(e => events.push({
      id: e.id,
      type: e.action,
      actor: e.actor,
      title: e.metadata && e.metadata.title || e.target,
      created: e.created,
    }));
  return events.sort((a, b) => b.created - a.created).slice(0, 40);
}

/* ---------------- one-time migration (runs on require) ---------------- */
function migrateCommunities() {
  let changedCommunities = false;
  let changedPosts = false;
  let changedAlbums = false;

  // Seed a default community owned by the first configured admin (if any).
  const seedOwner = [...ADMIN_USERNAMES][0] || '';
  let kingBob = findCommunity(KING_BOB_ID);
  if (!kingBob && seedOwner) {
    kingBob = {
      id: KING_BOB_ID,
      slug: KING_BOB_ID,
      name: 'home',
      description: '',
      owner: seedOwner,
      members: { [seedOwner]: 'owner' },
      created: Date.now(),
    };
    communities.push(kingBob);
    changedCommunities = true;
  }
  if (kingBob) {
    if (!kingBob.members) { kingBob.members = {}; changedCommunities = true; }
    if (seedOwner && kingBob.members[seedOwner] !== 'owner') { kingBob.members[seedOwner] = 'owner'; changedCommunities = true; }
    if (!kingBob.slug) { kingBob.slug = KING_BOB_ID; changedCommunities = true; }
  }

  communities.forEach(c => {
    if (!c.banned || Array.isArray(c.banned)) { c.banned = {}; changedCommunities = true; }
    if (!Array.isArray(c.prompts)) { c.prompts = []; changedCommunities = true; }
    if (!Array.isArray(c.pinnedPostIds)) { c.pinnedPostIds = []; changedCommunities = true; }
    if (!c.accent) { c.accent = '#ffffff'; changedCommunities = true; }
    if (c.welcome === undefined) { c.welcome = ''; changedCommunities = true; }
  });

  posts.forEach(p => {
    if (!p.communityId) { p.communityId = KING_BOB_ID; changedPosts = true; }
    if (!Array.isArray(p.likes)) { p.likes = []; changedPosts = true; }
    if (!Array.isArray(p.comments)) { p.comments = []; changedPosts = true; }
    if (p.pinned === undefined) { p.pinned = false; changedPosts = true; }
    if (p.promptId === undefined) { p.promptId = ''; changedPosts = true; }
  });
  albums.forEach(a => {
    if (!a.communityId) { a.communityId = KING_BOB_ID; changedAlbums = true; }
  });

  // seed each community's scope roster from the tags its photos already use
  communities.forEach(c => {
    if (!Array.isArray(c.scopes)) {
      const used = new Set();
      posts.forEach(p => { if (p.communityId === c.id) (p.tags || []).forEach(t => used.add(t)); });
      c.scopes = [...used].sort();
      changedCommunities = true;
    }
  });

  if (changedCommunities) saveJSON('communities.json', communities);
  if (changedPosts) saveJSON('posts.json', posts);
  if (changedAlbums) saveJSON('albums.json', albums);
}
migrateCommunities();

module.exports = {
  send, readBody, authUser, createSession, hashPass,
  authThrottled, accountLocked, recordAuthFailure, clearAuthFailures, tooManyWrites, tooManyUploads, startMaintenance,
  validEmail, emailInUse, createChallenge, getChallenge, consumeChallenge, issueCode, checkCode,
  trustDevice, deviceTrusted, revokeUserDevices,
  sniffImage, isAdminUsername, clean, slugify, uniqueCommunityId, findCommunity,
  communityMembers, communityBans, communityPrompts, communityPinned, communityScopes, roleFor,
  isCommunityMember, canAdminCommunity, canOwnCommunity, canChangeMember, canRemoveMember,
  requestCommunityId, joinedCommunities, resolveCommunityForAuth, requireAuth, requireCommunity,
  scopedPosts, scopedAlbums, userPhotoCount, publicProfile, albumCoverFile, publicAlbum,
  communityCoverFile, publicCommunity, canManagePost, assertSameCommunityPhoto,
  saveDataUrlImage, safeUnlinkAsset, addAudit, memberList, publicPrompt, activityFeed,
};
