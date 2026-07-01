'use strict';
/* Domain layer: HTTP helpers, auth/sessions + rate limiting, community/role
   logic, scoped queries, public serializers, image persistence, audit, and the
   one-time data migration (run on require). All state lives in ./store. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { securityHeaders } = require('./static');
const supa = require('./supabase-storage');
const {
  ROOT, ASSETS_DIR, saveJSON,
  users, sessions, posts, albums, communities, auditEvents, notifications,
  ADMIN_USERNAMES, KING_BOB_ID,
} = require('./store');

const AUTH_WINDOW_MS = 10 * 60 * 1000;
const AUTH_MAX_ATTEMPTS = 25;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const authAttempts = new Map();

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
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket.remoteAddress || 'local';
}
function tooManyAuthAttempts(req, username) {
  const now = Date.now();
  const key = `${clientIp(req)}:${clean(username, 20).toLowerCase()}`;
  const attempts = (authAttempts.get(key) || []).filter(ts => now - ts < AUTH_WINDOW_MS);
  attempts.push(now);
  authAttempts.set(key, attempts);
  return attempts.length > AUTH_MAX_ATTEMPTS;
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
  });

  posts.forEach(p => {
    if (!p.communityId) { p.communityId = KING_BOB_ID; changedPosts = true; }
    if (!Array.isArray(p.likes)) { p.likes = []; changedPosts = true; }
    if (!p.reactions || typeof p.reactions !== 'object' || Array.isArray(p.reactions)) { p.reactions = {}; changedPosts = true; }
    if (!Array.isArray(p.comments)) { p.comments = []; changedPosts = true; }
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
migrateCommunities();

module.exports = {
  send, readBody, authUser, createSession, tooManyAuthAttempts, hashPass,
  isAdminUsername, clean, slugify, uniqueCommunityId, findCommunity,
  communityMembers, communityBans, communityPrompts, communityPinned, communityScopes, roleFor,
  isCommunityMember, canAdminCommunity, canOwnCommunity, canChangeMember, canRemoveMember,
  requestCommunityId, joinedCommunities, resolveCommunityForAuth, requireAuth, requireCommunity,
  scopedPosts, scopedAlbums, userPhotoCount, publicProfile, albumCoverFile, publicAlbum,
  communityCoverFile, publicCommunity, canManagePost, assertSameCommunityPhoto,
  savedPostIds, toggleSaved,
  saveDataUrlImage, safeUnlinkAsset, saveImage, deleteImage, addAudit, addNotification, publicNotification,
  memberList, publicPrompt, activityFeed, communityRecap, communityPulse,
};
