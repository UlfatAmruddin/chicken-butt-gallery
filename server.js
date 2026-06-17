const http = require('http');
const crypto = require('crypto');

const config = require('./lib/config');
const { users, sessions, posts, albums, communities, invites, auditEvents, saveJSON } = require('./lib/store');
const { securityHeaders, serveStatic } = require('./lib/static');
const {
  send, readBody, authUser, createSession, hashPass,
  authThrottled, accountLocked, recordAuthFailure, clearAuthFailures, tooManyWrites, tooManyUploads, startMaintenance,
  validEmail, emailInUse, createChallenge, getChallenge, consumeChallenge, issueCode, checkCode,
  trustDevice, deviceTrusted, revokeUserDevices,
  isAdminUsername, clean, slugify, uniqueCommunityId, findCommunity,
  communityMembers, communityBans, communityPrompts, communityPinned, communityScopes, roleFor,
  isCommunityMember, canAdminCommunity, canOwnCommunity, canChangeMember, canRemoveMember,
  requestCommunityId, joinedCommunities, resolveCommunityForAuth, requireAuth, requireCommunity,
  scopedPosts, scopedAlbums, userPhotoCount, publicProfile, albumCoverFile, publicAlbum,
  communityCoverFile, publicCommunity, canManagePost, assertSameCommunityPhoto,
  saveDataUrlImage, safeUnlinkAsset, addAudit, memberList, publicPrompt, activityFeed,
} = require('./lib/helpers');

// Body cap for image routes: a base64 data URL is ~4/3 the decoded size; profile
// can carry both an avatar and a cover, so allow two images plus JSON envelope.
const IMG_BODY_LIMIT = Math.ceil(config.MAX_IMAGE_BYTES * 4 / 3) + 64 * 1024;
const PROFILE_BODY_LIMIT = Math.ceil(2 * 8 * 1024 * 1024 * 4 / 3) + 128 * 1024;
// Constant-time dummy credentials so logins for unknown users cost the same as
// for real ones (no username-enumeration timing oracle).
const DUMMY_SALT = crypto.randomBytes(16).toString('hex');
const DUMMY_HASH = Buffer.from(hashPass('*', DUMMY_SALT), 'hex');

// Profile for the account owner — adds email fields the public profile must never expose.
function selfProfile(u) {
  return { ...publicProfile(u), email: u.email || '', emailVerified: !!u.emailVerified };
}
// Mask an email for display in a code-step prompt ("ji***@gmail.com") without fully revealing it.
function maskEmail(email) {
  const [name, domain] = String(email || '').split('@');
  if (!domain) return '';
  const head = name.length <= 2 ? name[0] || '' : name.slice(0, 2);
  return `${head}${'*'.repeat(Math.max(1, name.length - head.length))}@${domain}`;
}
// Finish auth: issue a session, optionally a trusted-device token (skips future 2FA).
function grantSession(u, rememberDevice) {
  const out = { token: createSession(u.username), profile: selfProfile(u) };
  if (rememberDevice) out.deviceToken = trustDevice(u.username);
  return out;
}

/* ---------------- API ---------------- */
async function handleApi(req, res, pathname, params) {
  try {
    const seg = pathname.split('/').filter(Boolean);

    // Coarse per-IP throttle on every mutating request — a public backstop
    // against write floods that complements the auth- and upload-specific limits.
    if ((req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE') && tooManyWrites(req)) {
      return send(res, 429, { error: 'Too many requests. Slow down.' });
    }

    if (req.method === 'POST' && pathname === '/api/register') {
      const b = JSON.parse(await readBody(req, 64 * 1024));
      const username = clean(b.username, 20).toLowerCase();
      const password = String(b.password || '');
      const email = validEmail(b.email);
      // Validate format BEFORE the throttle so malformed usernames can't mint rate-limit keys.
      if (!/^[a-z0-9_]{3,20}$/.test(username)) return send(res, 400, { error: 'Username must be 3-20 chars: letters, numbers, underscores.' });
      if (!email) return send(res, 400, { error: 'Enter a valid email address.' });
      if (password.length < config.MIN_PASSWORD_LEN) return send(res, 400, { error: `Password must be at least ${config.MIN_PASSWORD_LEN} characters.` });
      if (authThrottled(req, username)) return send(res, 429, { error: 'Too many attempts. Try again soon.' });
      if (users[username]) return send(res, 409, { error: 'That username is taken.' });
      if (emailInUse(email, username)) return send(res, 409, { error: 'That email is already in use.' });
      // Defer account creation until the emailed code is verified — no persisted
      // unverified accounts to bloat storage or squat usernames.
      const salt = crypto.randomBytes(16).toString('hex');
      const challenge = createChallenge(username, 'register', email);
      const pending = getChallenge(challenge);
      pending.displayName = clean(b.displayName, 40) || username;
      pending.salt = salt;
      pending.hash = hashPass(password, salt);
      const r = await issueCode(challenge, email, 'verify');
      if (r.error) return send(res, 429, { error: r.error });
      return send(res, 200, { step: 'verify', challenge, email });
    }

    if (req.method === 'POST' && pathname === '/api/login') {
      const b = JSON.parse(await readBody(req, 64 * 1024));
      const username = clean(b.username, 20).toLowerCase();
      if (authThrottled(req, username)) return send(res, 429, { error: 'Too many attempts. Try again soon.' });
      const u = users[username];
      // Always run scrypt (against a dummy hash for unknown users) so timing
      // does not reveal whether the account exists.
      const salt = u ? u.salt : DUMMY_SALT;
      const goodHash = u ? Buffer.from(u.hash, 'hex') : DUMMY_HASH;
      const tryHash = Buffer.from(hashPass(String(b.password || ''), salt), 'hex');
      const ok = !!u && tryHash.length === goodHash.length && crypto.timingSafeEqual(tryHash, goodHash);
      if (!ok) {
        // Wrong credentials: record the failure. Block only once the account crosses
        // the distributed-failure threshold — and only here (wrong password), so the
        // real owner with the correct password is never locked out.
        recordAuthFailure(username);
        if (accountLocked(username)) return send(res, 429, { error: 'Too many failed attempts. Try again later.' });
        return send(res, 401, { error: 'Wrong username or password.' });
      }
      clearAuthFailures(username);
      // Existing accounts predating email: must add + verify an email first.
      if (!u.email) {
        const challenge = createChallenge(username, 'email');
        return send(res, 200, { step: 'email', challenge });
      }
      // Email on file but never verified: re-send a verification code.
      if (!u.emailVerified) {
        const challenge = createChallenge(username, 'verify', u.email);
        const r = await issueCode(challenge, u.email, 'verify');
        if (r.error) return send(res, 429, { error: r.error });
        return send(res, 200, { step: 'verify', challenge, email: maskEmail(u.email) });
      }
      // Recognised device → skip 2FA.
      if (b.deviceToken && deviceTrusted(b.deviceToken, username)) {
        return send(res, 200, grantSession(u, false));
      }
      // Otherwise require a second factor by email.
      const challenge = createChallenge(username, '2fa', u.email);
      const r = await issueCode(challenge, u.email, '2fa');
      if (r.error) return send(res, 429, { error: r.error });
      return send(res, 200, { step: '2fa', challenge, email: maskEmail(u.email) });
    }

    // Existing-account email-add step: attach an email, then send a verify code.
    if (req.method === 'POST' && pathname === '/api/auth/email') {
      const b = JSON.parse(await readBody(req, 64 * 1024));
      const c = getChallenge(b.challenge);
      if (!c || c.purpose !== 'email') return send(res, 400, { error: 'This request expired. Start again.' });
      const u = users[c.username];
      if (!u) return send(res, 400, { error: 'This request expired. Start again.' });
      const email = validEmail(b.email);
      if (!email) return send(res, 400, { error: 'Enter a valid email address.' });
      if (emailInUse(email, u.username)) return send(res, 409, { error: 'That email is already in use.' });
      u.email = email; u.emailVerified = false;
      saveJSON('users.json', users);
      c.purpose = 'verify'; c.email = email;
      const r = await issueCode(b.challenge, email, 'verify');
      if (r.error) return send(res, 429, { error: r.error });
      return send(res, 200, { step: 'verify', challenge: b.challenge, email });
    }

    // Verify a code: completes email verification ('verify') or login 2FA ('2fa'),
    // then issues a session (and a trusted-device token if requested).
    if (req.method === 'POST' && pathname === '/api/auth/verify') {
      const b = JSON.parse(await readBody(req, 64 * 1024));
      const c = getChallenge(b.challenge);
      if (!c || !['register', 'verify', '2fa'].includes(c.purpose)) return send(res, 400, { error: 'This code expired. Start again.' });
      if (!checkCode(c, clean(b.code, 12))) {
        recordAuthFailure(c.username);  // feed sustained code-guessing into the account backstop
        return send(res, 401, { error: 'Wrong or expired code.' });
      }
      consumeChallenge(b.challenge);
      // Pending registration: create the account only now that the email is proven.
      if (c.purpose === 'register') {
        if (users[c.username]) return send(res, 409, { error: 'That username is taken.' });
        if (emailInUse(c.email, c.username)) return send(res, 409, { error: 'That email is already in use.' });
        users[c.username] = {
          username: c.username, displayName: c.displayName,
          email: c.email, emailVerified: true,
          salt: c.salt, hash: c.hash,
          bio: '', location: '', website: '', joined: Date.now(),
        };
        saveJSON('users.json', users);
        return send(res, 200, grantSession(users[c.username], b.rememberDevice === true));
      }
      const u = users[c.username];
      if (!u) return send(res, 400, { error: 'This request expired. Start again.' });
      if (c.purpose === 'verify') {
        if (emailInUse(c.email, u.username)) return send(res, 409, { error: 'That email is already in use.' });
        u.email = c.email; u.emailVerified = true;
        saveJSON('users.json', users);
      }
      return send(res, 200, grantSession(u, b.rememberDevice === true));
    }

    if (req.method === 'POST' && pathname === '/api/auth/resend') {
      const b = JSON.parse(await readBody(req, 64 * 1024));
      const c = getChallenge(b.challenge);
      if (!c || !['register', 'verify', '2fa'].includes(c.purpose)) return send(res, 400, { error: 'This request expired. Start again.' });
      const r = await issueCode(b.challenge, c.email, c.purpose);
      if (r.error) return send(res, 429, { error: r.error });
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && pathname === '/api/logout') {
      const auth = authUser(req);
      if (auth) { delete sessions[auth.token]; saveJSON('sessions.json', sessions); }
      return send(res, 200, { ok: true });
    }

    if (req.method === 'GET' && pathname === '/api/me') {
      const auth = requireAuth(req, res);
      if (!auth) return;
      return send(res, 200, selfProfile(auth.user));
    }

    if (req.method === 'PUT' && pathname === '/api/profile') {
      const auth = requireAuth(req, res);
      if (!auth) return;
      const b = JSON.parse(await readBody(req, PROFILE_BODY_LIMIT));
      const u = auth.user;
      if (b.displayName !== undefined) u.displayName = clean(b.displayName, 40) || u.username;
      if (b.bio !== undefined) u.bio = clean(b.bio, 280);
      if (b.location !== undefined) u.location = clean(b.location, 60);
      if (b.website !== undefined) u.website = clean(b.website, 120);
      for (const field of ['avatar', 'cover']) {
        if (b[field] === undefined) continue;
        if (b[field] === null || b[field] === '') {
          if (u[field]) safeUnlinkAsset(u[field]);
          u[field] = '';
        } else {
          const saved = saveDataUrlImage(b[field], 'assets/avatars', `${u.username}-${field}`, 8 * 1024 * 1024);
          if (saved.error) return send(res, 400, { error: saved.error });
          if (u[field]) safeUnlinkAsset(u[field]);
          u[field] = saved.file;
        }
      }
      saveJSON('users.json', users);
      return send(res, 200, publicProfile(u));
    }

    if (req.method === 'PUT' && pathname === '/api/password') {
      const auth = requireAuth(req, res);
      if (!auth) return;
      const b = JSON.parse(await readBody(req, 64 * 1024));
      const u = auth.user;
      // verify the current password in constant time
      const cur = Buffer.from(hashPass(String(b.currentPassword || ''), u.salt), 'hex');
      const good = Buffer.from(u.hash, 'hex');
      const ok = cur.length === good.length && crypto.timingSafeEqual(cur, good);
      if (!ok) {
        // Brute-force protection on the re-auth gate (DoS-safe: only wrong attempts
        // are counted, so the real owner with the correct password is never blocked).
        recordAuthFailure(u.username);
        if (accountLocked(u.username)) return send(res, 429, { error: 'Too many attempts. Try again later.' });
        return send(res, 403, { error: 'Current password is incorrect.' });
      }
      clearAuthFailures(u.username);
      const next = String(b.newPassword || '');
      if (next.length < config.MIN_PASSWORD_LEN) return send(res, 400, { error: `Password must be at least ${config.MIN_PASSWORD_LEN} characters.` });
      const salt = crypto.randomBytes(16).toString('hex');
      u.salt = salt;
      u.hash = hashPass(next, salt);
      saveJSON('users.json', users);
      // Revoke every other session for this user (a password change should log
      // out other devices); keep the current token so the caller stays signed in.
      let revoked = false;
      for (const t of Object.keys(sessions)) {
        if (t === auth.token) continue;
        const e = sessions[t];
        const name = typeof e === 'string' ? e : e && e.username;
        if (name === u.username) { delete sessions[t]; revoked = true; }
      }
      if (revoked) saveJSON('sessions.json', sessions);
      // Untrust remembered devices too, so a stolen device token can't skip 2FA after a reset.
      revokeUserDevices(u.username);
      return send(res, 200, { ok: true });
    }

    /* ---------------- communities + invites ---------------- */
    if (req.method === 'GET' && pathname === '/api/communities') {
      const auth = requireAuth(req, res);
      if (!auth) return;
      return send(res, 200, joinedCommunities(auth.user.username).map(c => publicCommunity(c, auth.user.username)));
    }

    if (req.method === 'POST' && pathname === '/api/communities') {
      const auth = requireAuth(req, res);
      if (!auth) return;
      const b = JSON.parse(await readBody(req, 64 * 1024));
      const name = clean(b.name, 60);
      if (!name) return send(res, 400, { error: 'Name your community first.' });
      const owned = communities.filter(c => c.owner === auth.user.username).length;
      if (!isAdminUsername(auth.user.username) && owned >= config.MAX_COMMUNITIES_PER_USER) {
        return send(res, 429, { error: 'You have reached the community limit.' });
      }
      const id = uniqueCommunityId(name);
      const community = {
        id,
        slug: id,
        name,
        description: clean(b.description, 240),
        welcome: '',
        accent: '#ffffff',
        banned: {},
        prompts: [],
        pinnedPostIds: [],
        owner: auth.user.username,
        members: { [auth.user.username]: 'owner' },
        created: Date.now(),
      };
      communities.push(community);
      saveJSON('communities.json', communities);
      addAudit(community.id, auth.user.username, 'community.created', community.id, { name: community.name });
      return send(res, 200, publicCommunity(community, auth.user.username));
    }

    if (req.method === 'GET' && seg[1] === 'communities' && seg[2] && !seg[3]) {
      const auth = requireAuth(req, res);
      if (!auth) return;
      const c = findCommunity(seg[2]);
      if (!c) return send(res, 404, { error: 'No such community.' });
      if (!isCommunityMember(c, auth.user.username)) return send(res, 403, { error: 'You are not a member of this community.' });
      return send(res, 200, publicCommunity(c, auth.user.username));
    }

    if (req.method === 'PUT' && seg[1] === 'communities' && seg[2] && !seg[3]) {
      const auth = requireAuth(req, res);
      if (!auth) return;
      const c = findCommunity(seg[2]);
      if (!c) return send(res, 404, { error: 'No such community.' });
      if (!canAdminCommunity(c, auth.user.username)) return send(res, 403, { error: 'Only admins can edit community settings.' });
      const b = JSON.parse(await readBody(req, IMG_BODY_LIMIT));
      if (b.name !== undefined && canOwnCommunity(c, auth.user.username)) {
        const name = clean(b.name, 60);
        if (name) c.name = name;
      }
      if (b.description !== undefined) c.description = clean(b.description, 240);
      if (b.welcome !== undefined) c.welcome = clean(b.welcome, 300);
      if (b.accent !== undefined) {
        const accent = clean(b.accent, 16);
        if (/^#[0-9a-f]{6}$/i.test(accent)) c.accent = accent;
      }
      if (b.activePromptId !== undefined) {
        const prompts = communityPrompts(c);
        c.activePromptId = prompts.some(p => p.id === b.activePromptId) ? b.activePromptId : '';
      }
      if (b.cover === '') {
        c.cover = '';
      } else if (b.cover) {
        const saved = saveDataUrlImage(b.cover, 'assets/community', `${c.id}-cover`, 8 * 1024 * 1024);
        if (saved.error) return send(res, 400, { error: saved.error });
        c.cover = saved.file;
      }
      saveJSON('communities.json', communities);
      addAudit(c.id, auth.user.username, 'community.updated', c.id, { name: c.name });
      return send(res, 200, publicCommunity(c, auth.user.username));
    }

    if (req.method === 'GET' && seg[1] === 'communities' && seg[2] && seg[3] === 'members') {
      const auth = requireAuth(req, res);
      if (!auth) return;
      const c = findCommunity(seg[2]);
      if (!c) return send(res, 404, { error: 'No such community.' });
      if (!isCommunityMember(c, auth.user.username)) return send(res, 403, { error: 'You are not a member of this community.' });
      return send(res, 200, memberList(c));
    }

    if (req.method === 'PUT' && seg[1] === 'communities' && seg[2] && seg[3] === 'members' && seg[4] && seg[5] === 'role') {
      const auth = requireAuth(req, res);
      if (!auth) return;
      const c = findCommunity(seg[2]);
      if (!c) return send(res, 404, { error: 'No such community.' });
      const target = clean(decodeURIComponent(seg[4]), 20).toLowerCase();
      const members = communityMembers(c);
      const currentRole = members[target];
      if (!currentRole) return send(res, 404, { error: 'No such member.' });
      const b = JSON.parse(await readBody(req, 64 * 1024));
      const nextRole = clean(b.role, 12).toLowerCase();
      if (!canChangeMember(roleFor(c, auth.user.username), currentRole, nextRole, auth.user.username, target)) {
        return send(res, 403, { error: 'Only the owner can change admin roles.' });
      }
      members[target] = nextRole;
      saveJSON('communities.json', communities);
      addAudit(c.id, auth.user.username, 'member.role_changed', target, { from: currentRole, to: nextRole });
      return send(res, 200, { ok: true, member: { username: target, role: nextRole } });
    }

    if (req.method === 'DELETE' && seg[1] === 'communities' && seg[2] && seg[3] === 'members' && seg[4]) {
      const auth = requireAuth(req, res);
      if (!auth) return;
      const c = findCommunity(seg[2]);
      if (!c) return send(res, 404, { error: 'No such community.' });
      const target = clean(decodeURIComponent(seg[4]), 20).toLowerCase();
      const members = communityMembers(c);
      if (!members[target]) return send(res, 404, { error: 'No such member.' });
      if (!canRemoveMember(c, auth.user.username, target)) return send(res, 403, { error: 'You cannot remove that member.' });
      const raw = String(await readBody(req, 64 * 1024).catch(() => Buffer.from('')));
      const b = raw ? JSON.parse(raw) : {};
      const role = members[target];
      delete members[target];
      communityBans(c)[target] = {
        bannedBy: auth.user.username,
        bannedAt: Date.now(),
        reason: clean(b.reason, 160),
      };
      saveJSON('communities.json', communities);
      addAudit(c.id, auth.user.username, 'member.removed', target, { role, banned: true });
      return send(res, 200, { ok: true });
    }

    if (req.method === 'GET' && seg[1] === 'communities' && seg[2] && seg[3] === 'bans') {
      const auth = requireAuth(req, res);
      if (!auth) return;
      const c = findCommunity(seg[2]);
      if (!c) return send(res, 404, { error: 'No such community.' });
      if (!canAdminCommunity(c, auth.user.username)) return send(res, 403, { error: 'Only admins can view bans.' });
      const bans = Object.entries(communityBans(c)).map(([username, ban]) => ({
        username,
        displayName: users[username] ? users[username].displayName : username,
        avatar: users[username] ? users[username].avatar || '' : '',
        ...ban,
      })).sort((a, b) => b.bannedAt - a.bannedAt);
      return send(res, 200, bans);
    }

    if (req.method === 'DELETE' && seg[1] === 'communities' && seg[2] && seg[3] === 'bans' && seg[4]) {
      const auth = requireAuth(req, res);
      if (!auth) return;
      const c = findCommunity(seg[2]);
      if (!c) return send(res, 404, { error: 'No such community.' });
      if (!canAdminCommunity(c, auth.user.username)) return send(res, 403, { error: 'Only admins can unban members.' });
      const target = clean(decodeURIComponent(seg[4]), 20).toLowerCase();
      delete communityBans(c)[target];
      saveJSON('communities.json', communities);
      addAudit(c.id, auth.user.username, 'member.unbanned', target);
      return send(res, 200, { ok: true });
    }

    if (req.method === 'GET' && seg[1] === 'communities' && seg[2] && seg[3] === 'audit') {
      const auth = requireAuth(req, res);
      if (!auth) return;
      const c = findCommunity(seg[2]);
      if (!c) return send(res, 404, { error: 'No such community.' });
      if (!canAdminCommunity(c, auth.user.username)) return send(res, 403, { error: 'Only admins can view audit logs.' });
      return send(res, 200, auditEvents.filter(e => e.communityId === c.id).sort((a, b) => b.created - a.created).slice(0, 100));
    }

    if (req.method === 'GET' && seg[1] === 'communities' && seg[2] && seg[3] === 'activity') {
      const auth = requireAuth(req, res);
      if (!auth) return;
      const c = findCommunity(seg[2]);
      if (!c) return send(res, 404, { error: 'No such community.' });
      if (!isCommunityMember(c, auth.user.username)) return send(res, 403, { error: 'You are not a member of this community.' });
      return send(res, 200, activityFeed(c));
    }

    if (req.method === 'GET' && seg[1] === 'communities' && seg[2] && seg[3] === 'prompts') {
      const auth = requireAuth(req, res);
      if (!auth) return;
      const c = findCommunity(seg[2]);
      if (!c) return send(res, 404, { error: 'No such community.' });
      if (!isCommunityMember(c, auth.user.username)) return send(res, 403, { error: 'You are not a member of this community.' });
      return send(res, 200, communityPrompts(c).map(p => ({ ...publicPrompt(p), active: p.id === c.activePromptId })));
    }

    if (req.method === 'POST' && seg[1] === 'communities' && seg[2] && seg[3] === 'prompts') {
      const auth = requireAuth(req, res);
      if (!auth) return;
      const c = findCommunity(seg[2]);
      if (!c) return send(res, 404, { error: 'No such community.' });
      if (!canAdminCommunity(c, auth.user.username)) return send(res, 403, { error: 'Only admins can create prompts.' });
      const b = JSON.parse(await readBody(req, 64 * 1024));
      const text = clean(b.text, 140);
      if (!text) return send(res, 400, { error: 'Write a prompt first.' });
      const prompt = { id: crypto.randomBytes(6).toString('hex'), text, createdBy: auth.user.username, created: Date.now() };
      communityPrompts(c).unshift(prompt);
      if (b.active !== false) c.activePromptId = prompt.id;
      saveJSON('communities.json', communities);
      addAudit(c.id, auth.user.username, 'prompt.created', prompt.id, { title: text });
      return send(res, 200, { ...publicPrompt(prompt), active: prompt.id === c.activePromptId });
    }

    if (req.method === 'DELETE' && seg[1] === 'communities' && seg[2] && seg[3] === 'prompts' && seg[4]) {
      const auth = requireAuth(req, res);
      if (!auth) return;
      const c = findCommunity(seg[2]);
      if (!c) return send(res, 404, { error: 'No such community.' });
      if (!canAdminCommunity(c, auth.user.username)) return send(res, 403, { error: 'Only admins can delete prompts.' });
      const before = communityPrompts(c).length;
      c.prompts = communityPrompts(c).filter(p => p.id !== seg[4]);
      if (c.activePromptId === seg[4]) c.activePromptId = c.prompts[0] ? c.prompts[0].id : '';
      if (before === c.prompts.length) return send(res, 404, { error: 'No such prompt.' });
      saveJSON('communities.json', communities);
      addAudit(c.id, auth.user.username, 'prompt.deleted', seg[4]);
      return send(res, 200, { ok: true });
    }

    if (req.method === 'GET' && seg[1] === 'communities' && seg[2] && seg[3] === 'scopes') {
      const auth = requireAuth(req, res);
      if (!auth) return;
      const c = findCommunity(seg[2]);
      if (!c) return send(res, 404, { error: 'No such community.' });
      if (!isCommunityMember(c, auth.user.username)) return send(res, 403, { error: 'You are not a member of this community.' });
      return send(res, 200, communityScopes(c));
    }

    if (req.method === 'POST' && seg[1] === 'communities' && seg[2] && seg[3] === 'scopes') {
      const auth = requireAuth(req, res);
      if (!auth) return;
      const c = findCommunity(seg[2]);
      if (!c) return send(res, 404, { error: 'No such community.' });
      if (!canAdminCommunity(c, auth.user.username)) return send(res, 403, { error: 'Only admins can manage scopes.' });
      const b = JSON.parse(await readBody(req, 64 * 1024));
      const name = clean(b.name, 20).toUpperCase();
      if (!name) return send(res, 400, { error: 'Name the scope first.' });
      const scopes = communityScopes(c);
      if (!scopes.includes(name)) {
        scopes.push(name);
        scopes.sort();
        saveJSON('communities.json', communities);
        addAudit(c.id, auth.user.username, 'scope.created', name);
      }
      return send(res, 200, scopes);
    }

    if (req.method === 'DELETE' && seg[1] === 'communities' && seg[2] && seg[3] === 'scopes' && seg[4]) {
      const auth = requireAuth(req, res);
      if (!auth) return;
      const c = findCommunity(seg[2]);
      if (!c) return send(res, 404, { error: 'No such community.' });
      if (!canAdminCommunity(c, auth.user.username)) return send(res, 403, { error: 'Only admins can manage scopes.' });
      // seg[] comes from the already-decoded pathname — do NOT decode again, or
      // scope names containing '%' break and spaces (%20) mis-match/mis-target.
      const name = clean(seg[4], 20).toUpperCase();
      const scopes = communityScopes(c);
      const before = scopes.length;
      c.scopes = scopes.filter(s => s !== name);
      if (before === c.scopes.length) return send(res, 404, { error: 'No such scope.' });
      // also strip the scope from this community's photo tags
      let postsChanged = false;
      posts.forEach(p => {
        if (p.communityId === c.id && Array.isArray(p.tags) && p.tags.includes(name)) {
          p.tags = p.tags.filter(t => t !== name);
          postsChanged = true;
        }
      });
      saveJSON('communities.json', communities);
      if (postsChanged) saveJSON('posts.json', posts);
      addAudit(c.id, auth.user.username, 'scope.deleted', name);
      return send(res, 200, c.scopes);
    }

    if ((req.method === 'POST' || req.method === 'DELETE') && seg[1] === 'communities' && seg[2] && seg[3] === 'pins' && seg[4]) {
      const auth = requireAuth(req, res);
      if (!auth) return;
      const c = findCommunity(seg[2]);
      if (!c) return send(res, 404, { error: 'No such community.' });
      if (!canAdminCommunity(c, auth.user.username)) return send(res, 403, { error: 'Only admins can pin photos.' });
      const post = posts.find(p => p.id === seg[4] && p.communityId === c.id);
      if (!post) return send(res, 404, { error: 'No such photo.' });
      const pins = communityPinned(c);
      if (req.method === 'POST' && !pins.includes(post.id)) pins.unshift(post.id);
      if (req.method === 'DELETE') c.pinnedPostIds = pins.filter(id => id !== post.id);
      posts.forEach(p => { if (p.communityId === c.id) p.pinned = communityPinned(c).includes(p.id); });
      saveJSON('communities.json', communities);
      saveJSON('posts.json', posts);
      addAudit(c.id, auth.user.username, req.method === 'POST' ? 'photo.pinned' : 'photo.unpinned', post.id, { title: post.title });
      return send(res, 200, publicCommunity(c, auth.user.username));
    }

    if (req.method === 'GET' && seg[1] === 'communities' && seg[2] && seg[3] === 'invites') {
      const auth = requireAuth(req, res);
      if (!auth) return;
      const c = findCommunity(seg[2]);
      if (!c) return send(res, 404, { error: 'No such community.' });
      if (!canAdminCommunity(c, auth.user.username)) return send(res, 403, { error: 'Only admins can manage invites.' });
      return send(res, 200, invites.filter(i => i.communityId === c.id && !i.revoked));
    }

    if (req.method === 'POST' && seg[1] === 'communities' && seg[2] && seg[3] === 'invites') {
      const auth = requireAuth(req, res);
      if (!auth) return;
      const c = findCommunity(seg[2]);
      if (!c) return send(res, 404, { error: 'No such community.' });
      if (!canAdminCommunity(c, auth.user.username)) return send(res, 403, { error: 'Only admins can create invites.' });
      const invite = {
        code: crypto.randomBytes(12).toString('hex'),
        communityId: c.id,
        createdBy: auth.user.username,
        created: Date.now(),
        revoked: false,
      };
      invites.push(invite);
      saveJSON('invites.json', invites);
      addAudit(c.id, auth.user.username, 'invite.created', invite.code);
      return send(res, 200, invite);
    }

    if (req.method === 'GET' && seg[1] === 'invites' && seg[2] && !seg[3]) {
      const invite = invites.find(i => i.code === seg[2] && !i.revoked);
      if (!invite) return send(res, 404, { error: 'Invite not found.' });
      const c = findCommunity(invite.communityId);
      if (!c) return send(res, 404, { error: 'Community not found.' });
      return send(res, 200, { code: invite.code, community: publicCommunity(c) });
    }

    if (req.method === 'POST' && seg[1] === 'invites' && seg[2] && seg[3] === 'join') {
      const auth = requireAuth(req, res);
      if (!auth) return;
      const invite = invites.find(i => i.code === seg[2] && !i.revoked);
      if (!invite) return send(res, 404, { error: 'Invite not found.' });
      const c = findCommunity(invite.communityId);
      if (!c) return send(res, 404, { error: 'Community not found.' });
      if (communityBans(c)[auth.user.username]) return send(res, 403, { error: 'You cannot join this community.' });
      const members = communityMembers(c);
      if (!members[auth.user.username]) {
        members[auth.user.username] = 'member';
        addAudit(c.id, auth.user.username, 'member.joined', auth.user.username);
      }
      saveJSON('communities.json', communities);
      return send(res, 200, publicCommunity(c, auth.user.username));
    }

    if (req.method === 'DELETE' && seg[1] === 'invites' && seg[2]) {
      const auth = requireAuth(req, res);
      if (!auth) return;
      const invite = invites.find(i => i.code === seg[2]);
      if (!invite) return send(res, 404, { error: 'Invite not found.' });
      const c = findCommunity(invite.communityId);
      if (!c || !canAdminCommunity(c, auth.user.username)) return send(res, 403, { error: 'Only admins can revoke invites.' });
      invite.revoked = true;
      saveJSON('invites.json', invites);
      addAudit(c.id, auth.user.username, 'invite.revoked', invite.code);
      return send(res, 200, { ok: true });
    }

    /* ---------------- scoped people ---------------- */
    if (req.method === 'GET' && pathname === '/api/users') {
      const ctx = requireCommunity(req, res, params);
      if (!ctx) return;
      const q = (params.get('q') || '').toLowerCase();
      const names = Object.keys(communityMembers(ctx.community));
      const list = names
        .map(name => users[name])
        .filter(Boolean)
        .map(u => publicProfile(u, ctx.community.id))
        .filter(p => !q || p.username.includes(q) || p.displayName.toLowerCase().includes(q))
        .sort((a, b) => b.joined - a.joined);
      return send(res, 200, list);
    }

    if (req.method === 'GET' && seg[1] === 'user' && seg[2]) {
      const ctx = requireCommunity(req, res, params);
      if (!ctx) return;
      const u = users[decodeURIComponent(seg[2]).toLowerCase()];
      if (!u || !isCommunityMember(ctx.community, u.username)) return send(res, 404, { error: 'No such user in this community.' });
      return send(res, 200, {
        profile: publicProfile(u, ctx.community.id),
        posts: scopedPosts(ctx.community.id).filter(p => p.username === u.username).sort((a, b) => b.created - a.created),
      });
    }

    /* ---------------- scoped photos ---------------- */
    if (req.method === 'GET' && pathname === '/api/photos') {
      const ctx = requireCommunity(req, res, params);
      if (!ctx) return;
      // Opt-in cursor pagination: with no params this returns the full set
      // (the sphere loads everything at current scale); ?before=<ts>&limit=<n>
      // is available for a paginated frontend once a community grows large.
      let list = scopedPosts(ctx.community.id).sort((a, b) => b.created - a.created);
      const before = parseInt(params.get('before'), 10);
      if (Number.isFinite(before)) list = list.filter(p => p.created < before);
      const limit = parseInt(params.get('limit'), 10);
      if (Number.isFinite(limit) && limit > 0) list = list.slice(0, Math.min(limit, 500));
      return send(res, 200, list);
    }

    if (req.method === 'POST' && pathname === '/api/photos') {
      const ctx = requireCommunity(req, res, params);
      if (!ctx) return;
      if (tooManyUploads(ctx.auth.user.username)) return send(res, 429, { error: 'Upload limit reached. Try again later.' });
      if (!isAdminUsername(ctx.auth.user.username) && userPhotoCount(ctx.auth.user.username) >= config.MAX_PHOTOS_PER_USER) {
        return send(res, 429, { error: 'You have reached the photo limit.' });
      }
      const b = JSON.parse(await readBody(req, IMG_BODY_LIMIT));
      const saved = saveDataUrlImage(b.image, 'assets/uploads', ctx.auth.user.username);
      if (saved.error) return send(res, 400, { error: saved.error });
      const yr = parseInt(b.year, 10);
      const promptId = clean(b.promptId, 40);
      const promptOk = !promptId || communityPrompts(ctx.community).some(p => p.id === promptId);
      const post = {
        id: crypto.randomBytes(8).toString('hex'),
        communityId: ctx.community.id,
        username: ctx.auth.user.username,
        title: clean(b.title, 40) || 'UNTITLED',
        client: clean(b.client, 30),
        caption: clean(b.caption, 300),
        year: Number.isFinite(yr) && yr >= 1900 && yr <= 2100 ? yr : new Date().getFullYear(),
        tags: Array.isArray(b.tags) ? b.tags.slice(0, 8).map(t => clean(t, 20).toUpperCase()).filter(Boolean) : [],
        file: saved.file,
        layout: ['full', 'portrait', 'landscape'].includes(b.layout) ? b.layout : 'full',
        pinned: false,
        promptId: promptOk ? promptId : '',
        likes: [],
        comments: [],
        created: Date.now(),
      };
      posts.push(post);
      saveJSON('posts.json', posts);
      addAudit(ctx.community.id, ctx.auth.user.username, 'photo.created', post.id, { title: post.title });
      return send(res, 200, post);
    }

    if (req.method === 'POST' && seg[1] === 'photos' && seg[2] && seg[3] === 'like') {
      const auth = requireAuth(req, res);
      if (!auth) return;
      const post = posts.find(p => p.id === seg[2]);
      if (!post) return send(res, 404, { error: 'No such photo.' });
      const c = findCommunity(post.communityId);
      if (!isCommunityMember(c, auth.user.username)) return send(res, 403, { error: 'You are not a member of this community.' });
      if (!Array.isArray(post.likes)) post.likes = [];
      const name = auth.user.username;
      const i = post.likes.indexOf(name);
      if (i >= 0) post.likes.splice(i, 1); else post.likes.push(name);
      saveJSON('posts.json', posts);
      return send(res, 200, { count: post.likes.length, liked: i < 0 });
    }

    if (req.method === 'POST' && seg[1] === 'photos' && seg[2] && seg[3] === 'comments' && !seg[4]) {
      const auth = requireAuth(req, res);
      if (!auth) return;
      const post = posts.find(p => p.id === seg[2]);
      if (!post) return send(res, 404, { error: 'No such photo.' });
      const c = findCommunity(post.communityId);
      if (!isCommunityMember(c, auth.user.username)) return send(res, 403, { error: 'You are not a member of this community.' });
      const b = JSON.parse(await readBody(req, 64 * 1024));
      const text = clean(b.text, 500);
      if (!text) return send(res, 400, { error: 'Write something first.' });
      if (!Array.isArray(post.comments)) post.comments = [];
      if (post.comments.length >= config.MAX_COMMENTS_PER_POST) return send(res, 429, { error: 'This photo has reached the comment limit.' });
      const comment = { id: crypto.randomBytes(6).toString('hex'), username: auth.user.username, text, created: Date.now() };
      post.comments.push(comment);
      saveJSON('posts.json', posts);
      return send(res, 200, comment);
    }

    if (req.method === 'DELETE' && seg[1] === 'photos' && seg[2] && seg[3] === 'comments' && seg[4]) {
      const auth = requireAuth(req, res);
      if (!auth) return;
      const post = posts.find(p => p.id === seg[2]);
      if (!post || !Array.isArray(post.comments)) return send(res, 404, { error: 'No such comment.' });
      const c = findCommunity(post.communityId);
      if (!isCommunityMember(c, auth.user.username)) return send(res, 403, { error: 'You are not a member of this community.' });
      const ci = post.comments.findIndex(comment => comment.id === seg[4]);
      if (ci < 0) return send(res, 404, { error: 'No such comment.' });
      const comment = post.comments[ci];
      const allowed = comment.username === auth.user.username || canManagePost(auth, post);
      if (!allowed) return send(res, 403, { error: 'You cannot delete this comment.' });
      post.comments.splice(ci, 1);
      saveJSON('posts.json', posts);
      return send(res, 200, { ok: true });
    }

    if (req.method === 'PUT' && seg[1] === 'photos' && seg[2] && !seg[3]) {
      const auth = requireAuth(req, res);
      if (!auth) return;
      const post = posts.find(p => p.id === seg[2]);
      if (!post) return send(res, 404, { error: 'No such photo.' });
      const c = findCommunity(post.communityId);
      if (!isCommunityMember(c, auth.user.username)) return send(res, 403, { error: 'You are not a member of this community.' });
      if (!canManagePost(auth, post)) return send(res, 403, { error: 'You do not have permission to edit this photo.' });
      const b = JSON.parse(await readBody(req, 64 * 1024));
      if (b.title !== undefined) post.title = clean(b.title, 40) || 'UNTITLED';
      if (b.client !== undefined) post.client = clean(b.client, 30);
      if (b.caption !== undefined) post.caption = clean(b.caption, 300);
      if (b.year !== undefined) {
        const y = parseInt(b.year, 10);
        if (Number.isFinite(y) && y >= 1900 && y <= 2100) post.year = y;
      }
      if (Array.isArray(b.tags)) post.tags = b.tags.slice(0, 8).map(t => clean(t, 20).toUpperCase()).filter(Boolean);
      if (['full', 'portrait', 'landscape'].includes(b.layout)) post.layout = b.layout;
      saveJSON('posts.json', posts);
      addAudit(post.communityId, auth.user.username, 'photo.updated', post.id, { title: post.title });
      return send(res, 200, post);
    }

    if (req.method === 'DELETE' && seg[1] === 'photos' && seg[2] && !seg[3]) {
      const auth = requireAuth(req, res);
      if (!auth) return;
      const i = posts.findIndex(p => p.id === seg[2]);
      if (i < 0) return send(res, 404, { error: 'No such photo.' });
      const post = posts[i];
      const c = findCommunity(post.communityId);
      if (!isCommunityMember(c, auth.user.username)) return send(res, 403, { error: 'You are not a member of this community.' });
      if (!canManagePost(auth, post)) return send(res, 403, { error: 'You do not have permission to delete this photo.' });
      const photoId = post.id;
      safeUnlinkAsset(post.file);
      posts.splice(i, 1);
      saveJSON('posts.json', posts);
      let albumsChanged = false;
      albums.forEach(a => {
        if (!Array.isArray(a.photoIds)) return;
        const nextIds = a.photoIds.filter(id => id !== photoId);
        if (nextIds.length !== a.photoIds.length) {
          a.photoIds = nextIds;
          if (a.cover === photoId) a.cover = '';
          albumsChanged = true;
        }
      });
      if (albumsChanged) saveJSON('albums.json', albums);
      addAudit(post.communityId, auth.user.username, 'photo.deleted', photoId, { title: post.title });
      return send(res, 200, { ok: true });
    }

    /* ---------------- scoped albums ---------------- */
    if (req.method === 'GET' && pathname === '/api/albums') {
      const ctx = requireCommunity(req, res, params);
      if (!ctx) return;
      const user = (params.get('user') || '').toLowerCase();
      const list = scopedAlbums(ctx.community.id)
        .filter(a => !user || a.owner === user)
        .map(publicAlbum)
        .sort((a, b) => b.created - a.created);
      return send(res, 200, list);
    }

    if (req.method === 'GET' && seg[1] === 'albums' && seg[2]) {
      const ctx = requireCommunity(req, res, params);
      if (!ctx) return;
      const a = albums.find(x => x.id === seg[2] && x.communityId === ctx.community.id);
      if (!a) return send(res, 404, { error: 'No such album.' });
      const byId = new Map(scopedPosts(ctx.community.id).map(p => [p.id, p]));
      const albumPosts = (a.photoIds || []).map(id => byId.get(id)).filter(Boolean);
      return send(res, 200, { album: publicAlbum(a), posts: albumPosts });
    }

    if (req.method === 'POST' && pathname === '/api/albums') {
      const ctx = requireCommunity(req, res, params);
      if (!ctx) return;
      const b = JSON.parse(await readBody(req, 64 * 1024));
      const name = clean(b.name, 60);
      if (!name) return send(res, 400, { error: 'Give the album a name.' });
      const album = {
        id: crypto.randomBytes(8).toString('hex'),
        communityId: ctx.community.id,
        owner: ctx.auth.user.username,
        name,
        description: clean(b.description, 300),
        cover: '',
        photoIds: Array.isArray(b.photoIds) ? b.photoIds.filter(id => assertSameCommunityPhoto(id, ctx.community.id)) : [],
        created: Date.now(),
      };
      albums.push(album);
      saveJSON('albums.json', albums);
      addAudit(ctx.community.id, ctx.auth.user.username, 'album.created', album.id, { title: album.name });
      return send(res, 200, publicAlbum(album));
    }

    if (req.method === 'PUT' && seg[1] === 'albums' && seg[2]) {
      const ctx = requireCommunity(req, res, params);
      if (!ctx) return;
      const a = albums.find(x => x.id === seg[2] && x.communityId === ctx.community.id);
      if (!a) return send(res, 404, { error: 'No such album.' });
      if (a.owner !== ctx.auth.user.username && !canAdminCommunity(ctx.community, ctx.auth.user.username)) {
        return send(res, 403, { error: 'You do not own this album.' });
      }
      const b = JSON.parse(await readBody(req, 64 * 1024));
      if (!Array.isArray(a.photoIds)) a.photoIds = [];
      if (b.name !== undefined) { const n = clean(b.name, 60); if (n) a.name = n; }
      if (b.description !== undefined) a.description = clean(b.description, 300);
      if (b.addPhotoId && assertSameCommunityPhoto(b.addPhotoId, ctx.community.id) && !a.photoIds.includes(b.addPhotoId)) {
        a.photoIds.push(b.addPhotoId);
      }
      if (b.removePhotoId) {
        a.photoIds = a.photoIds.filter(id => id !== b.removePhotoId);
        if (a.cover === b.removePhotoId) a.cover = '';
      }
      if (Array.isArray(b.photoIds)) a.photoIds = b.photoIds.filter(id => assertSameCommunityPhoto(id, ctx.community.id));
      if (b.cover !== undefined) a.cover = a.photoIds.includes(b.cover) ? b.cover : '';
      saveJSON('albums.json', albums);
      addAudit(ctx.community.id, ctx.auth.user.username, 'album.updated', a.id, { title: a.name });
      return send(res, 200, publicAlbum(a));
    }

    if (req.method === 'DELETE' && seg[1] === 'albums' && seg[2]) {
      const ctx = requireCommunity(req, res, params);
      if (!ctx) return;
      const i = albums.findIndex(x => x.id === seg[2] && x.communityId === ctx.community.id);
      if (i < 0) return send(res, 404, { error: 'No such album.' });
      if (albums[i].owner !== ctx.auth.user.username && !canAdminCommunity(ctx.community, ctx.auth.user.username)) {
        return send(res, 403, { error: 'You do not own this album.' });
      }
      const deleted = albums[i];
      albums.splice(i, 1);
      saveJSON('albums.json', albums);
      addAudit(ctx.community.id, ctx.auth.user.username, 'album.deleted', deleted.id, { title: deleted.name });
      return send(res, 200, { ok: true });
    }

    return send(res, 404, { error: 'Unknown API route.' });
  } catch (e) {
    const code = e.message === 'payload too large' ? 413 : e instanceof SyntaxError ? 400 : 500;
    // Log unexpected failures so production 500s are diagnosable; client-caused
    // 4xx (bad JSON, oversized body) stay quiet to avoid log noise.
    if (code === 500) console.error(`[api] ${req.method} ${pathname} ->`, e);
    return send(res, code, { error: code === 500 ? 'Server error.' : e.message });
  }
}

/* ---------------- server ---------------- */
const server = http.createServer((req, res) => {
  let u;
  try {
    u = new URL(req.url, 'http://localhost');
  } catch {
    res.writeHead(400, securityHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }));
    res.end('bad request');
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(u.pathname);
  } catch {
    res.writeHead(400, securityHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }));
    res.end('bad request');
    return;
  }

  // Unauthenticated liveness probe for the reverse proxy / uptime monitor.
  if (pathname === '/healthz') {
    res.writeHead(200, securityHeaders({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }));
    res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ ok: true }));
    return;
  }

  if (pathname.startsWith('/api/')) { handleApi(req, res, pathname, u.searchParams); return; }
  serveStatic(req, res, pathname);
});

server.listen(config.PORT, config.HOST, () => console.log(`serving at http://${config.HOST}:${config.PORT}`));

// Periodic sweep of expired sessions and stale rate-limit buckets.
startMaintenance();

// Graceful shutdown: stop accepting connections, let in-flight requests drain,
// then exit. Persisted writes are synchronous so on-disk state is already safe.
function shutdown(signal) {
  console.log(`${signal} received — shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
