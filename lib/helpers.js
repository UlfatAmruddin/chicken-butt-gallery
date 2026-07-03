'use strict';
/* Domain layer: HTTP helpers, auth/sessions + rate limiting, community/role
   logic, scoped queries, public serializers, image persistence, audit, and the
   one-time data migration (run once from appInit after the store loads, not on
   require). All state lives in ./store. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { securityHeaders } = require('./static');
const supa = require('./supabase-storage');
const {
  ROOT, ASSETS_DIR, saveJSON,
  users, sessions, posts, albums, communities, invites, auditEvents, notifications,
  ADMIN_USERNAMES, KING_BOB_ID,
} = require('./store');

const AUTH_WINDOW_MS = 10 * 60 * 1000;
const AUTH_MAX_ATTEMPTS = 25;          // per source-IP + username
const AUTH_USER_MAX_ATTEMPTS = 50;     // per username across ALL IPs (anti-spray)
const AUTH_IP_MAX_ATTEMPTS = 40;       // per source-IP across ALL usernames (anti-enumeration/mass-register)
const SESSION_MAX_PER_USER = 5;        // cap live sessions per user so sessions.json stays bounded
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const authAttempts = new Map();
const WRITE_WINDOW_MS = 60 * 1000;
const WRITE_MAX_PER_MIN = 120;         // per source-IP throttle on mutating routes
const writeAttempts = new Map();
const NOTIF_MAX_PER_USER = 200;        // retained notifications per recipient
const AUDIT_MAX_EVENTS = 5000;         // retained audit events total

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
  const now = Date.now();
  // opportunistic prune before inserting: drop every expired session, and cap this
  // user's live sessions, so the single sessions.json blob (rewritten on nearly
  // every mutating request) can't grow without bound from repeated logins.
  const mine = [];
  for (const tok of Object.keys(sessions)) {
    const s = sessions[tok];
    const sn = typeof s === 'string' ? s : (s && s.username);
    const exp = (s && typeof s !== 'string') ? s.expires : null;
    if (exp && now > exp) { delete sessions[tok]; continue; }
    if (sn === username) mine.push({ tok, created: (s && typeof s !== 'string' && s.created) || 0 });
  }
  mine.sort((a, b) => b.created - a.created).slice(SESSION_MAX_PER_USER - 1).forEach(m => delete sessions[m.tok]);
  sessions[token] = { username, created: now, expires: now + SESSION_TTL_MS };
  saveJSON('sessions.json', sessions);
  return token;
}
function clientIp(req) {
  // Behind a trusted reverse proxy (Render/Cloudflare and most PaaS), derive the
  // client IP ONLY from headers the proxy itself sets and we can trust - never a
  // raw client-supplied header. Prefer Cloudflare's CF-Connecting-IP (the edge
  // overwrites any client-sent value), then the RIGHTMOST X-Forwarded-For hop the
  // proxy appended (left hops are client-forgeable). Every candidate is validated
  // as a real IP so an attacker can't seed unbounded rate-limit keys with arbitrary
  // strings. `x-real-ip` is deliberately NOT trusted: on a Cloudflare->Render stack
  // it is pure client input and was previously spoofable to rotate the throttle key.
  // Only consult these headers when TRUST_PROXY is set; otherwise use the socket
  // (direct-bind local dev, where forwarding headers are meaningless/spoofable).
  if (process.env.TRUST_PROXY === '1') {
    const cf = String(req.headers['cf-connecting-ip'] || '').trim();
    if (net.isIP(cf)) return cf;
    const hops = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
    for (let i = hops.length - 1; i >= 0; i--) if (net.isIP(hops[i])) return hops[i];
  }
  return (req.socket && req.socket.remoteAddress) || 'local';
}
function bumpWindow(map, key, windowMs, cap) {
  const now = Date.now();
  const hits = (map.get(key) || []).filter(ts => now - ts < windowMs);
  hits.push(now);
  map.set(key, hits);
  return hits.length > cap;
}
function tooManyAuthAttempts(req, username) {
  const uname = clean(username, 20).toLowerCase();
  const ip = clientIp(req);
  // three independent limiters:
  //  - per source-IP + username: classic brute-force of one account from one IP
  //  - per-username across all IPs: anti-spray, so rotating source addresses can't
  //    grind a single account
  //  - per source-IP across ALL usernames: caps mass registration and the
  //    register "does user X exist" enumeration oracle, which the per-username
  //    counters (they reset for each new name) would otherwise never throttle.
  const ipOver = bumpWindow(authAttempts, `${ip}:${uname}`, AUTH_WINDOW_MS, AUTH_MAX_ATTEMPTS);
  const userOver = bumpWindow(authAttempts, `u:${uname}`, AUTH_WINDOW_MS, AUTH_USER_MAX_ATTEMPTS);
  const ipAllOver = bumpWindow(authAttempts, `ipall:${ip}`, AUTH_WINDOW_MS, AUTH_IP_MAX_ATTEMPTS);
  return ipOver || userOver || ipAllOver;
}
function tooManyWrites(req) {
  return bumpWindow(writeAttempts, clientIp(req), WRITE_WINDOW_MS, WRITE_MAX_PER_MIN);
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
// member/ban maps are keyed by username; keep them null-prototype so a name like
// "constructor"/"__proto__" can't resolve through Object.prototype (rebuild the
// JSON-loaded object once, then it stays null-proto for the rest of the process).
function communityMembers(c) {
  if (!c) return Object.create(null);
  if (!c.members || Array.isArray(c.members)) c.members = Object.create(null);
  else if (Object.getPrototypeOf(c.members) !== null) c.members = Object.assign(Object.create(null), c.members);
  return c.members;
}
function communityBans(c) {
  if (!c) return Object.create(null);
  if (!c.banned || Array.isArray(c.banned)) c.banned = Object.create(null);
  else if (Object.getPrototypeOf(c.banned) !== null) c.banned = Object.assign(Object.create(null), c.banned);
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
    spotlightPostId: c.spotlightPostId || '',
    memberCount: Object.keys(communityMembers(c)).length,
    photoCount: scopedPosts(c.id).length,
    albumCount: scopedAlbums(c.id).length,
    created: c.created,
    role: username ? roleFor(c, username) || (isAdminUsername(username) ? 'admin' : '') : '',
  };
}
/* Minimal, non-sensitive community preview for the UNAUTHENTICATED invite landing
   page. Deliberately omits the owner identity, the cover/photo URL (a public-bucket
   image link is itself a capability - handing it to a non-member leaks a private
   photo), welcome text, and internal ids/scopes/pins. Only what the landing UI
   needs to let someone decide whether to join. */
function invitePreview(c) {
  return {
    name: c.name,
    description: c.description || '',
    photoCount: scopedPosts(c.id).length,
    memberCount: Object.keys(communityMembers(c)).length,
  };
}
/* Whether an invite code may still be resolved/redeemed. Codes gain an expiry and
   optional use-cap at creation; codes created before that change have no expiresAt
   and stay valid (backwards compatible) until revoked. */
function inviteUsable(i) {
  if (!i || i.revoked) return false;
  if (i.expiresAt && Date.now() > i.expiresAt) return false;
  if (i.maxUses && (i.uses || 0) >= i.maxUses) return false;
  return true;
}
function canManagePost(auth, post) {
  const community = findCommunity(post.communityId);
  return post.username === auth.user.username || canAdminCommunity(community, auth.user.username);
}
function assertSameCommunityPhoto(photoId, communityId) {
  return posts.some(p => p.id === photoId && p.communityId === communityId);
}
/* the ids a user has privately saved inside one community (always an array) */
function savedPostIds(user, communityId) {
  const saved = user && user.saved;
  const ids = saved && saved[communityId];
  return Array.isArray(ids) ? ids : [];
}
/* toggle one photo in a user's private saved tray for a community.
   returns { saved: bool } after mutating (caller persists users.json). */
function toggleSaved(user, communityId, postId) {
  if (!user.saved || typeof user.saved !== 'object' || Array.isArray(user.saved)) user.saved = {};
  const list = Array.isArray(user.saved[communityId]) ? user.saved[communityId] : [];
  const i = list.indexOf(postId);
  if (i >= 0) list.splice(i, 1); else list.push(postId);
  if (list.length) user.saved[communityId] = list; else delete user.saved[communityId];
  return { saved: i < 0 };
}
function saveDataUrlImage(dataUrl, relDir, basename, maxBytes = 12 * 1024 * 1024) {
  const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(String(dataUrl || ''));
  if (!m) return { error: 'Pick an image first.' };
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > maxBytes) return { error: `Image too large (${Math.round(maxBytes / 1048576)}MB max).` };
  // validate magic bytes match the declared type, same as the Supabase path,
  // so a mislabelled/non-image payload can't be written to disk as an image.
  if (supa.sniff(buf) !== m[1]) return { error: 'That file is not a valid image.' };
  // reject decompression bombs (tiny file, enormous canvas) using the header dims
  if (supa.dimensionsTooLarge(buf, m[1])) return { error: 'Image resolution too large (40MP max).' };
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
/* Image save/delete that use Supabase Storage when configured (.supabase.json),
   otherwise local disk. Returns { file } (a public URL or a relative path) or { error }. */
async function saveImage(dataUrl, kind, basename, maxBytes = 12 * 1024 * 1024) {
  if (supa.isConfigured()) return supa.uploadDataUrl(dataUrl, kind, basename, maxBytes);
  return saveDataUrlImage(dataUrl, 'assets/' + kind, basename, maxBytes);
}
async function deleteImage(fileOrUrl) {
  if (supa.isSupabaseUrl(fileOrUrl)) return supa.deleteByUrl(fileOrUrl);
  return safeUnlinkAsset(fileOrUrl);
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
  // cap total retained events so audit_events.json can't grow unbounded
  if (auditEvents.length > AUDIT_MAX_EVENTS) auditEvents.splice(0, auditEvents.length - AUDIT_MAX_EVENTS);
  saveJSON('audit_events.json', auditEvents);
}
function addNotification(toUsername, communityId, type, actor, postId, extra = {}) {
  // never notify people about their own actions
  if (!toUsername || !actor || toUsername === actor) return;
  notifications.push({
    id: crypto.randomBytes(8).toString('hex'),
    to: toUsername,
    communityId,
    type,
    actor,
    postId,
    title: extra.title || '',
    text: extra.text || '',
    created: Date.now(),
    read: false,
  });
  // keep only the newest NOTIF_MAX_PER_USER for this recipient (push order is
  // chronological) so notifications.json stays bounded as history accumulates.
  const mine = notifications.filter(n => n.to === toUsername);
  if (mine.length > NOTIF_MAX_PER_USER) {
    const drop = new Set(mine.slice(0, mine.length - NOTIF_MAX_PER_USER).map(n => n.id));
    for (let i = notifications.length - 1; i >= 0; i--) if (drop.has(notifications[i].id)) notifications.splice(i, 1);
  }
  saveJSON('notifications.json', notifications);
}
function publicNotification(n) {
  return {
    id: n.id,
    to: n.to,
    communityId: n.communityId,
    type: n.type,
    actor: n.actor,
    postId: n.postId,
    title: n.title || '',
    text: n.text || '',
    created: n.created,
    read: !!n.read,
  };
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
/* the "love score" for one photo: hearts + every other reaction + comments.
   heart lives in post.likes; the rest live in post.reactions = { emoji: [names] }. */
function loveScore(post) {
  const likes = Array.isArray(post.likes) ? post.likes.length : 0;
  const comments = Array.isArray(post.comments) ? post.comments.length : 0;
  return likes + reactionTotal(post) + comments;
}
/* sum of every reaction list on a post (excludes hearts, which live in likes). */
function reactionTotal(post) {
  let n = 0;
  const r = post.reactions;
  if (r && typeof r === 'object' && !Array.isArray(r)) {
    Object.values(r).forEach(list => { if (Array.isArray(list)) n += list.length; });
  }
  return n;
}
/* the public-safe photo fields shared by recap.topPhotos and pulse.topPhotos.
   `extra` carries the per-view score (loveScore vs reactionCount). */
function publicPhotoCard(post, extra) {
  return Object.assign({
    id: post.id,
    title: post.title || 'UNTITLED',
    username: post.username,
    file: post.file,
    likes: Array.isArray(post.likes) ? post.likes.length : 0,
    comments: Array.isArray(post.comments) ? post.comments.length : 0,
  }, extra);
}
/* a shareable "wrapped" digest of one community: totals, a date range, the
   most-loved photos, and the most active members. Reuses existing primitives
   only and adds no stored state - everything is computed on the fly. */
function communityRecap(c) {
  const cposts = scopedPosts(c.id);
  const calbums = scopedAlbums(c.id);
  const members = communityMembers(c);
  const created = cposts.map(p => p.created).filter(t => Number.isFinite(t));
  const topPhotos = cposts
    .map(p => ({ post: p, score: loveScore(p) }))
    .sort((a, b) => b.score - a.score || b.post.created - a.post.created)
    .slice(0, 6)
    .map(({ post, score }) => publicPhotoCard(post, { loveScore: score }));
  const counts = Object.create(null);
  cposts.forEach(p => { counts[p.username] = (counts[p.username] || 0) + 1; });
  const topMembers = Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([username, photoCount]) => ({
      username,
      displayName: users[username] ? users[username].displayName : username,
      avatar: users[username] ? users[username].avatar || '' : '',
      photoCount,
    }));
  return {
    community: { id: c.id, name: c.name },
    photoCount: cposts.length,
    albumCount: calbums.length,
    memberCount: Object.keys(members).length,
    promptCount: communityPrompts(c).length,
    range: { first: created.length ? Math.min(...created) : 0, last: created.length ? Math.max(...created) : 0 },
    topPhotos,
    topMembers,
  };
}
/* the fixed reaction allow-list, mirrored from server.js. 'heart' lives in
   post.likes; the rest live in post.reactions = { emoji: [names] }. */
const PULSE_EMOJI = ['heart', 'laugh', 'wow', 'sad', 'fire'];
const PULSE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/* a live "what is resonating right now" snapshot for one community: total
   reactions per emoji, the most-reacted photos in a recent window (falling
   back to all-time when the window is empty), and the most-commented photos.
   Reuses scopedPosts only and returns only public-safe photo fields, exactly
   like communityRecap's topPhotos. Adds no stored state. */
function communityPulse(c) {
  const cposts = scopedPosts(c.id);
  const reactionCounts = Object.create(null);
  PULSE_EMOJI.forEach(k => { reactionCounts[k] = 0; });
  cposts.forEach(p => {
    reactionCounts.heart += Array.isArray(p.likes) ? p.likes.length : 0;
    const r = p.reactions;
    if (r && typeof r === 'object' && !Array.isArray(r)) {
      PULSE_EMOJI.forEach(k => {
        if (k !== 'heart' && Array.isArray(r[k])) reactionCounts[k] += r[k].length;
      });
    }
  });
  const reactions = PULSE_EMOJI.map(emoji => ({ emoji, count: reactionCounts[emoji] }));
  const totalReactions = PULSE_EMOJI.reduce((sum, k) => sum + reactionCounts[k], 0);
  // reaction count for one photo = hearts + every other reaction (no comments).
  const reactionScore = post => (Array.isArray(post.likes) ? post.likes.length : 0) + reactionTotal(post);
  const rankTop = source => source
    .map(post => ({ post, score: reactionScore(post) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || b.post.created - a.post.created)
    .slice(0, 6)
    .map(({ post, score }) => publicPhotoCard(post, { reactionCount: score }));
  const cutoff = Date.now() - PULSE_WINDOW_MS;
  const recent = cposts.filter(p => Number.isFinite(p.created) && p.created >= cutoff);
  let topPhotos = rankTop(recent);
  let windowDays = 30;
  if (!topPhotos.length) { topPhotos = rankTop(cposts); windowDays = 0; }
  return {
    community: { id: c.id, name: c.name },
    windowDays,
    totalReactions,
    reactions,
    topPhotos,
  };
}
/* the photo-count tiers that unlock a "collection" badge. */
const MILESTONE_TIERS = [10, 50, 100, 250];
/* the current daily posting streak: the number of consecutive local-day
   buckets (each with at least one post) ending today or yesterday. Buckets by
   the post's local calendar day so a fresh post today keeps yesterday's streak
   alive. Returns 0 when there is no post today or yesterday. */
function currentPostingStreak(cposts) {
  const days = new Set();
  cposts.forEach(p => {
    if (!Number.isFinite(p.created)) return;
    const d = new Date(p.created);
    days.add(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`);
  });
  if (!days.size) return 0;
  const dayKey = date => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  const today = new Date();
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  // anchor to today if there is a post today, else to yesterday, else no streak.
  let cursor;
  if (days.has(dayKey(today))) cursor = today;
  else if (days.has(dayKey(yesterday))) cursor = yesterday;
  else return 0;
  let streak = 0;
  while (days.has(dayKey(cursor))) {
    streak += 1;
    cursor = new Date(cursor.getTime() - 24 * 60 * 60 * 1000);
  }
  return streak;
}
/* a shared "momentum" board for one community: the earned (and next unearned)
   milestones that celebrate collective progress. Reuses scopedPosts + loveScore
   only and adds no stored state, mirroring communityRecap/communityPulse. Each
   badge is { key, label, detail, icon, achieved, progress }, where progress is a
   0..1 hint toward the next unearned tier (1 for achieved boolean badges). */
function computeMilestones(c) {
  const cposts = scopedPosts(c.id);
  const photoCount = cposts.length;
  const members = communityMembers(c);
  const memberCount = Object.keys(members).length;
  const contributors = new Set(cposts.map(p => p.username)).size;
  const badges = [];
  // photo-count collection tiers (10/50/100/250): show every reached tier plus
  // the next one still in progress, so the board always points somewhere.
  let shownNextTier = false;
  MILESTONE_TIERS.forEach(tier => {
    const achieved = photoCount >= tier;
    if (achieved) {
      badges.push({
        key: `photos-${tier}`,
        label: `${tier} MEMORIES`,
        detail: `The sphere holds ${tier}+ photos.`,
        icon: '◆',
        achieved: true,
        progress: 1,
      });
    } else if (!shownNextTier) {
      shownNextTier = true;
      badges.push({
        key: `photos-${tier}`,
        label: `${tier} MEMORIES`,
        detail: `${photoCount} of ${tier} photos so far.`,
        icon: '◇',
        achieved: false,
        progress: Math.min(1, photoCount / tier),   // tier is always > 0
      });
    }
  });
  // everyone contributed: every member has posted at least one photo.
  const everyone = memberCount > 0 && contributors >= memberCount;
  badges.push({
    key: 'everyone-contributed',
    label: 'EVERYONE CONTRIBUTED',
    detail: everyone
      ? `All ${memberCount} member${memberCount === 1 ? '' : 's'} have posted.`
      : `${contributors} of ${memberCount} member${memberCount === 1 ? '' : 's'} have posted.`,
    icon: everyone ? '◆' : '◇',
    achieved: everyone,
    progress: memberCount ? Math.min(1, contributors / memberCount) : 0,
  });
  // most-loved memory of all time (by loveScore): earned once any photo has love.
  const scored = cposts
    .map(p => ({ post: p, score: loveScore(p) }))
    .sort((a, b) => b.score - a.score || b.post.created - a.post.created)[0];
  const mostLoved = scored && scored.score > 0;
  badges.push({
    key: 'most-loved',
    label: 'MOST LOVED MEMORY',
    detail: mostLoved
      ? `"${scored.post.title || 'UNTITLED'}" has ${scored.score} love.`
      : 'No photo has been loved yet.',
    icon: mostLoved ? '◆' : '◇',
    achieved: mostLoved,
    progress: mostLoved ? 1 : 0,
  });
  // longest current daily posting streak (in days), earned at 2+ days running.
  const streak = currentPostingStreak(cposts);
  const streakOn = streak >= 2;
  badges.push({
    key: 'streak',
    label: streakOn ? `${streak}-DAY STREAK` : 'POSTING STREAK',
    detail: streakOn
      ? `${streak} days in a row with a new memory.`
      : 'Post two days running to start a streak.',
    icon: streakOn ? '◆' : '◇',
    achieved: streakOn,
    progress: Math.min(1, streak / 2),   // streak >= 0, so 0 maps to 0
  });
  return {
    community: { id: c.id, name: c.name },
    photoCount,
    memberCount,
    contributors,
    streak,
    badges,
  };
}
/* browse a community's memories grouped by their free-text `place`. Buckets
   posts by a normalized place key (trim + lowercase), skipping empty places,
   and for each bucket returns a display label (from the most recent post), a
   count, the latest timestamp, a cover photo card, and up to 8 newest photo
   cards. Sorts buckets by count desc then latest desc. Also reports how many
   photos carry no place. Reuses scopedPosts/publicPhotoCard only and adds no
   stored state, mirroring communityRecap/communityPulse. */
/* Validate a structured location off a request body into { lat, lng, country,
   state }. Coordinates must be finite and in range or both drop to null. */
function sanitizeGeo(b) {
  // Treat null / '' / undefined as "no coordinate" so clearing a place stores
  // null, not 0 (Number(null) === 0, which would otherwise pin the null island).
  const num = (v) => (v === null || v === undefined || v === '') ? NaN : Number(v);
  const lat = num(b.lat), lng = num(b.lng);
  const ok = Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
  return { lat: ok ? lat : null, lng: ok ? lng : null, country: clean(b.country, 60), state: clean(b.state, 60) };
}

/* Forward-geocode a typed place via OpenStreetMap Nominatim (server-side fetch,
   zero-dependency, no API key). Returns up to 6 candidates with a display label,
   lat/lng, country, and state/province. Never throws; [] on any failure.
   Results are cached per normalized query (Nominatim's usage policy asks callers
   to cache and stay under ~1 req/sec) and the fetch is capped with a timeout. */
const geocodeCache = new Map();                 // normalized query -> { at, results }
const GEOCODE_TTL_MS = 10 * 60 * 1000;

async function geocodePlace(query) {
  const q = String(query || '').trim().slice(0, 120);
  if (q.length < 2) return [];
  const key = q.toLowerCase();
  const cached = geocodeCache.get(key);
  if (cached && (Date.now() - cached.at) < GEOCODE_TTL_MS) return cached.results;
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&accept-language=en&limit=6&q=${encodeURIComponent(q)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'chicken-butt-gallery/1.0 (personal photo gallery)', 'Accept': 'application/json' } });
    if (!r.ok) return [];
    const rows = await r.json();
    const results = (Array.isArray(rows) ? rows : []).map(row => {
      const a = row.address || {};
      const state = a.state || a.province || a.region || a.state_district || a.county || '';
      const name = String(row.display_name || q).split(',')[0].trim();
      const label = [name, state, a.country || ''].filter(Boolean).join(', ').slice(0, 80);
      return { label, lat: Number(row.lat), lng: Number(row.lon), country: a.country || '', state };
    }).filter(x => Number.isFinite(x.lat) && Number.isFinite(x.lng));
    geocodeCache.set(key, { at: Date.now(), results });
    if (geocodeCache.size > 500) geocodeCache.delete(geocodeCache.keys().next().value);   // bound memory
    return results;
  } catch { return []; }
  finally { clearTimeout(timer); }
}

function communityPlaces(c) {
  const cposts = scopedPosts(c.id);
  const buckets = new Map();
  let unplaced = 0;
  cposts.forEach(post => {
    const place = clean(post.place, 80);
    if (!place) { unplaced += 1; return; }
    const key = place.toLowerCase();
    let bucket = buckets.get(key);
    if (!bucket) { bucket = { key, posts: [] }; buckets.set(key, bucket); }
    bucket.posts.push(post);
  });
  const places = [...buckets.values()].map(bucket => {
    const sorted = bucket.posts.slice().sort((a, b) => (b.created || 0) - (a.created || 0));
    const newest = sorted[0];
    // representative coordinates for the globe pin: the newest located photo in
    // the bucket (they share a place label, so coords match).
    const located = sorted.find(p => Number.isFinite(p.lat) && Number.isFinite(p.lng)) || newest;
    return {
      key: bucket.key,
      place: clean(newest.place, 80),
      count: sorted.length,
      latest: newest.created || 0,
      lat: Number.isFinite(located.lat) ? located.lat : null,
      lng: Number.isFinite(located.lng) ? located.lng : null,
      country: clean(located.country, 60),
      state: clean(located.state, 60),
      cover: publicPhotoCard(newest),
      photos: sorted.slice(0, 8).map(p => publicPhotoCard(p)),
    };
  });
  places.sort((a, b) => b.count - a.count || b.latest - a.latest || a.place.localeCompare(b.place));
  return {
    community: { id: c.id, name: c.name },
    placeCount: places.length,
    unplaced,
    places,
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
    .filter(e => e.communityId === c.id && ['member.joined', 'prompt.created', 'photo.pinned', 'photo.spotlighted'].includes(e.action))
    .forEach(e => events.push({
      id: e.id,
      type: e.action,
      actor: e.actor,
      title: e.metadata && e.metadata.title || e.target,
      created: e.created,
    }));
  return events.sort((a, b) => b.created - a.created).slice(0, 40);
}

/* ---------------- one-time migration (runs once from appInit) ---------------- */
function migrateCommunities() {
  let changedCommunities = false;
  let changedPosts = false;
  let changedAlbums = false;
  let changedUsers = false;

  let kingBob = findCommunity(KING_BOB_ID);
  if (!kingBob) {
    kingBob = {
      id: KING_BOB_ID,
      slug: KING_BOB_ID,
      name: 'king bob',
      description: 'Private memories for king bob.',
      owner: 'ulfatamruddin',
      members: { ulfatamruddin: 'owner' },
      created: Date.now(),
    };
    communities.push(kingBob);
    changedCommunities = true;
  }
  if (!kingBob.members) { kingBob.members = {}; changedCommunities = true; }
  if (kingBob.members.ulfatamruddin !== 'owner') { kingBob.members.ulfatamruddin = 'owner'; changedCommunities = true; }
  if (!kingBob.slug) { kingBob.slug = KING_BOB_ID; changedCommunities = true; }

  communities.forEach(c => {
    if (!c.banned || Array.isArray(c.banned)) { c.banned = {}; changedCommunities = true; }
    if (!Array.isArray(c.prompts)) { c.prompts = []; changedCommunities = true; }
    if (!Array.isArray(c.pinnedPostIds)) { c.pinnedPostIds = []; changedCommunities = true; }
    if (!c.accent) { c.accent = '#ffffff'; changedCommunities = true; }
    if (c.welcome === undefined) { c.welcome = ''; changedCommunities = true; }
    if (c.spotlightPostId === undefined) { c.spotlightPostId = ''; changedCommunities = true; }
  });

  posts.forEach(p => {
    if (!p.communityId) { p.communityId = KING_BOB_ID; changedPosts = true; }
    if (!Array.isArray(p.likes)) { p.likes = []; changedPosts = true; }
    if (!p.reactions || typeof p.reactions !== 'object' || Array.isArray(p.reactions)) { p.reactions = {}; changedPosts = true; }
    if (!Array.isArray(p.comments)) { p.comments = []; changedPosts = true; }
    p.comments.forEach(comment => {
      if (!Array.isArray(comment.likes)) { comment.likes = []; changedPosts = true; }
      if (comment.parentId === undefined) { comment.parentId = ''; changedPosts = true; }
    });
    if (p.pinned === undefined) { p.pinned = false; changedPosts = true; }
    if (p.promptId === undefined) { p.promptId = ''; changedPosts = true; }
    if (p.place === undefined) { p.place = ''; changedPosts = true; }
  });
  albums.forEach(a => {
    if (!a.communityId) { a.communityId = KING_BOB_ID; changedAlbums = true; }
  });
  // private per-user "saved" tray: { communityId: [postId, ...] }
  Object.values(users).forEach(u => {
    if (!u.saved || typeof u.saved !== 'object' || Array.isArray(u.saved)) {
      u.saved = {};
      changedUsers = true;
    }
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
  if (changedUsers) saveJSON('users.json', users);
}
// migrateCommunities() is NOT run at require time any more: the collections are
// empty until store.init() loads them, so the migration runs once after init
// (see appInit in server.js).

/* ---------------- account deletion (cascade) ---------------- */
// Remove one photo and every reference to it (image bytes, album membership +
// cover, saved trays, community pins/spotlight). Mirrors the DELETE /api/photos
// handler so a bulk delete leaves no dangling ids.
async function deleteOnePost(post) {
  const id = post.id;
  if (post.file) await deleteImage(post.file);
  const pi = posts.findIndex(p => p.id === id);
  if (pi >= 0) posts.splice(pi, 1);
  albums.forEach(a => {
    if (!Array.isArray(a.photoIds)) return;
    a.photoIds = a.photoIds.filter(x => x !== id);
    if (a.cover === id) a.cover = '';
  });
  Object.values(users).forEach(u => {
    if (u.saved && Array.isArray(u.saved[post.communityId])) {
      const next = u.saved[post.communityId].filter(x => x !== id);
      if (next.length) u.saved[post.communityId] = next; else delete u.saved[post.communityId];
    }
  });
  const c = communities.find(cc => cc.id === post.communityId);
  if (c) {
    if (Array.isArray(c.pinnedPostIds)) c.pinnedPostIds = c.pinnedPostIds.filter(x => x !== id);
    if (c.spotlightPostId === id) c.spotlightPostId = '';
  }
}

// Delete a whole community and all content scoped to it.
async function deleteCommunityAndContent(communityId) {
  for (const p of posts.filter(p => p.communityId === communityId)) { if (p.file) await deleteImage(p.file); }
  for (let i = posts.length - 1; i >= 0; i--) if (posts[i].communityId === communityId) posts.splice(i, 1);
  for (let i = albums.length - 1; i >= 0; i--) if (albums[i].communityId === communityId) albums.splice(i, 1);
  for (let i = invites.length - 1; i >= 0; i--) if (invites[i].communityId === communityId) invites.splice(i, 1);
  for (let i = notifications.length - 1; i >= 0; i--) if (notifications[i].communityId === communityId) notifications.splice(i, 1);
  Object.values(users).forEach(u => { if (u.saved && u.saved[communityId]) delete u.saved[communityId]; });
  const ci = communities.findIndex(c => c.id === communityId);
  if (ci >= 0) communities.splice(ci, 1);
}

/* Fully delete a user account and every trace of it: owned communities (with all
   their content), the user's own photos/albums, their comments (+ replies) /
   likes / reactions on surviving posts, memberships + bans, invites they created,
   notifications to/from them, and their sessions. Marks all touched collections
   dirty; the caller flushes. Returns a summary. Does NOT persist by itself. */
async function deleteUserAccount(username) {
  const name = String(username || '').toLowerCase();
  if (!users[name]) return { ok: false, error: 'no such user' };

  const ownedIds = communities.filter(c => c.owner === name).map(c => c.id);
  for (const cid of ownedIds) await deleteCommunityAndContent(cid);

  for (const p of posts.filter(p => p.username === name)) await deleteOnePost(p);

  for (let i = albums.length - 1; i >= 0; i--) if (albums[i].owner === name) albums.splice(i, 1);

  posts.forEach(p => {
    if (Array.isArray(p.comments)) {
      const removedTop = new Set(p.comments.filter(cm => cm.username === name && !cm.parentId).map(cm => cm.id));
      p.comments = p.comments.filter(cm => cm.username !== name && !removedTop.has(cm.parentId));
      p.comments.forEach(cm => { if (Array.isArray(cm.likes)) cm.likes = cm.likes.filter(u => u !== name); });
    }
    if (Array.isArray(p.likes)) p.likes = p.likes.filter(u => u !== name);
    if (p.reactions && typeof p.reactions === 'object' && !Array.isArray(p.reactions)) {
      for (const emoji of Object.keys(p.reactions)) {
        p.reactions[emoji] = (p.reactions[emoji] || []).filter(u => u !== name);
        if (!p.reactions[emoji].length) delete p.reactions[emoji];
      }
    }
  });

  communities.forEach(c => {
    if (c.members && c.members[name]) delete c.members[name];
    if (c.banned && c.banned[name]) delete c.banned[name];
  });

  for (let i = invites.length - 1; i >= 0; i--) if (invites[i].createdBy === name) invites.splice(i, 1);
  for (let i = notifications.length - 1; i >= 0; i--) if (notifications[i].to === name || notifications[i].actor === name) notifications.splice(i, 1);
  for (const tok of Object.keys(sessions)) {
    const s = sessions[tok];
    const sn = typeof s === 'string' ? s : s && s.username;
    if (sn === name) delete sessions[tok];
  }
  delete users[name];

  ['users.json', 'posts.json', 'albums.json', 'communities.json', 'invites.json', 'notifications.json', 'sessions.json']
    .forEach(f => saveJSON(f, undefined));
  return { ok: true, ownedCommunitiesDeleted: ownedIds.length };
}

module.exports = {
  migrateCommunities,
  deleteUserAccount,
  send, readBody, authUser, createSession, tooManyAuthAttempts, tooManyWrites, hashPass,
  isAdminUsername, clean, slugify, uniqueCommunityId, findCommunity,
  communityMembers, communityBans, communityPrompts, communityPinned, communityScopes, roleFor,
  isCommunityMember, canAdminCommunity, canOwnCommunity, canChangeMember, canRemoveMember,
  requestCommunityId, joinedCommunities, resolveCommunityForAuth, requireAuth, requireCommunity,
  scopedPosts, scopedAlbums, userPhotoCount, publicProfile, albumCoverFile, publicAlbum,
  communityCoverFile, publicCommunity, invitePreview, inviteUsable, canManagePost, assertSameCommunityPhoto,
  savedPostIds, toggleSaved,
  saveDataUrlImage, safeUnlinkAsset, saveImage, deleteImage, addAudit, addNotification, publicNotification,
  memberList, publicPrompt, activityFeed, communityRecap, communityPulse, communityPlaces,
  sanitizeGeo, geocodePlace,
  computeMilestones,
};
