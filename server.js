const http = require('http');
const crypto = require('crypto');

const { users, sessions, posts, albums, communities, invites, auditEvents, notifications, saveJSON } = require('./lib/store');
const { securityHeaders, serveStatic } = require('./lib/static');
const {
  send, readBody, authUser, createSession, tooManyAuthAttempts, tooManyWrites, hashPass,
  isAdminUsername, clean, slugify, uniqueCommunityId, findCommunity,
  communityMembers, communityBans, communityPrompts, communityPinned, communityScopes, roleFor,
  isCommunityMember, canAdminCommunity, canOwnCommunity, canChangeMember, canRemoveMember,
  requestCommunityId, joinedCommunities, resolveCommunityForAuth, requireAuth, requireCommunity,
  scopedPosts, scopedAlbums, userPhotoCount, publicProfile, albumCoverFile, publicAlbum,
  communityCoverFile, publicCommunity, canManagePost, assertSameCommunityPhoto,
  savedPostIds, toggleSaved,
  saveDataUrlImage, safeUnlinkAsset, saveImage, deleteImage, addAudit, addNotification, publicNotification,
  memberList, publicPrompt, activityFeed, communityRecap, communityPulse, communityPlaces,
  computeMilestones,
} = require('./lib/helpers');

// the fixed reaction allow-list. 'heart' is the legacy like; the rest are extra.
const REACTION_EMOJI = ['heart', 'laugh', 'wow', 'sad', 'fire'];

/* ---------------- API ---------------- */
async function handleApi(req, res, pathname, params) {
  try {
    const seg = pathname.split('/').filter(Boolean);

    // global per-IP throttle on mutating requests to blunt upload/comment spam
    if (req.method !== 'GET' && req.method !== 'HEAD' && tooManyWrites(req)) {
      return send(res, 429, { error: 'Too many requests. Slow down.' });
    }

    if (req.method === 'POST' && pathname === '/api/register') {
      const b = JSON.parse(await readBody(req, 64 * 1024));
      const username = clean(b.username, 20).toLowerCase();
      const password = String(b.password || '');
      if (tooManyAuthAttempts(req, username)) return send(res, 429, { error: 'Too many attempts. Try again soon.' });
      if (!/^[a-z0-9_]{3,20}$/.test(username)) return send(res, 400, { error: 'Username must be 3-20 chars: letters, numbers, underscores.' });
      if (password.length < 8) return send(res, 400, { error: 'Password must be at least 8 characters.' });
      // reserve the configured admin name(s) so they can't be claimed on a fresh instance
      if (isAdminUsername(username)) return send(res, 409, { error: 'That username is taken.' });
      if (users[username]) return send(res, 409, { error: 'That username is taken.' });
      const salt = crypto.randomBytes(16).toString('hex');
      users[username] = {
        username,
        displayName: clean(b.displayName, 40) || username,
        salt,
        hash: hashPass(password, salt),
        bio: '', location: '', website: '',
        joined: Date.now(),
      };
      saveJSON('users.json', users);
      const token = createSession(username);
      return send(res, 200, { token, profile: publicProfile(users[username]) });
    }

    if (req.method === 'POST' && pathname === '/api/login') {
      const b = JSON.parse(await readBody(req, 64 * 1024));
      const username = clean(b.username, 20).toLowerCase();
      if (tooManyAuthAttempts(req, username)) return send(res, 429, { error: 'Too many attempts. Try again soon.' });
      const u = users[username];
      if (!u) return send(res, 401, { error: 'Wrong username or password.' });
      const tryHash = Buffer.from(hashPass(String(b.password || ''), u.salt), 'hex');
      const goodHash = Buffer.from(u.hash, 'hex');
      if (tryHash.length !== goodHash.length || !crypto.timingSafeEqual(tryHash, goodHash)) {
        return send(res, 401, { error: 'Wrong username or password.' });
      }
      const token = createSession(username);
      return send(res, 200, { token, profile: publicProfile(u) });
    }

    if (req.method === 'POST' && pathname === '/api/logout') {
      const auth = authUser(req);
      if (auth) { delete sessions[auth.token]; saveJSON('sessions.json', sessions); }
      return send(res, 200, { ok: true });
    }

    if (req.method === 'GET' && pathname === '/api/me') {
      const auth = requireAuth(req, res);
      if (!auth) return;
      return send(res, 200, publicProfile(auth.user));
    }

    if (req.method === 'PUT' && pathname === '/api/profile') {
      const auth = requireAuth(req, res);
      if (!auth) return;
      const b = JSON.parse(await readBody(req, 12 * 1024 * 1024));
      const u = auth.user;
      if (b.displayName !== undefined) u.displayName = clean(b.displayName, 40) || u.username;
      if (b.bio !== undefined) u.bio = clean(b.bio, 280);
      if (b.location !== undefined) u.location = clean(b.location, 60);
      if (b.website !== undefined) u.website = clean(b.website, 120);
      for (const field of ['avatar', 'cover']) {
        if (b[field] === undefined) continue;
        if (b[field] === null || b[field] === '') {
          if (u[field]) await deleteImage(u[field]);
          u[field] = '';
        } else {
          const saved = await saveImage(b[field], 'avatars', `${u.username}-${field}`, 8 * 1024 * 1024);
          if (saved.error) return send(res, 400, { error: saved.error });
          if (u[field]) await deleteImage(u[field]);
          u[field] = saved.file;
        }
      }
      saveJSON('users.json', users);
      return send(res, 200, publicProfile(u));
    }

    /* ---------------- notifications inbox (per user) ---------------- */
    if (req.method === 'GET' && pathname === '/api/notifications') {
      const auth = requireAuth(req, res);
      if (!auth) return;
      const me = auth.user.username;
      const mine = notifications.filter(n => n.to === me);
      const list = mine
        .sort((a, b) => b.created - a.created)
        .slice(0, 50)
        .map(publicNotification);
      // count unread across ALL of this user's notifications, not just the 50 shown
      return send(res, 200, { notifications: list, unread: mine.filter(n => !n.read).length });
    }

    if (req.method === 'POST' && pathname === '/api/notifications/read') {
      const auth = requireAuth(req, res);
      if (!auth) return;
      const me = auth.user.username;
      const raw = String(await readBody(req, 64 * 1024).catch(() => Buffer.from('')));
      const b = raw ? JSON.parse(raw) : {};
      const ids = Array.isArray(b.ids) ? new Set(b.ids.map(String)) : null;
      let changed = 0;
      notifications.forEach(n => {
        if (n.to !== me || n.read) return;
        if (ids && !ids.has(n.id)) return;
        n.read = true;
        changed++;
      });
      if (changed) saveJSON('notifications.json', notifications);
      return send(res, 200, { ok: true, marked: changed });
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
      const b = JSON.parse(await readBody(req, 12 * 1024 * 1024));
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
        const saved = await saveImage(b.cover, 'community', `${c.id}-cover`, 8 * 1024 * 1024);
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

    if (req.method === 'GET' && seg[1] === 'communities' && seg[2] && seg[3] === 'recap') {
      const auth = requireAuth(req, res);
      if (!auth) return;
      const c = findCommunity(seg[2]);
      if (!c) return send(res, 404, { error: 'No such community.' });
      if (!isCommunityMember(c, auth.user.username)) return send(res, 403, { error: 'You are not a member of this community.' });
      return send(res, 200, communityRecap(c));
    }

    if (req.method === 'GET' && seg[1] === 'communities' && seg[2] && seg[3] === 'pulse') {
      const auth = requireAuth(req, res);
      if (!auth) return;
      const c = findCommunity(seg[2]);
      if (!c) return send(res, 404, { error: 'No such community.' });
      if (!isCommunityMember(c, auth.user.username)) return send(res, 403, { error: 'You are not a member of this community.' });
      return send(res, 200, communityPulse(c));
    }

    if (req.method === 'GET' && seg[1] === 'communities' && seg[2] && seg[3] === 'milestones') {
      const auth = requireAuth(req, res);
      if (!auth) return;
      const c = findCommunity(seg[2]);
      if (!c) return send(res, 404, { error: 'No such community.' });
      if (!isCommunityMember(c, auth.user.username)) return send(res, 403, { error: 'You are not a member of this community.' });
      return send(res, 200, computeMilestones(c));
    }

    if (req.method === 'GET' && seg[1] === 'communities' && seg[2] && seg[3] === 'places') {
      const auth = requireAuth(req, res);
      if (!auth) return;
      const c = findCommunity(seg[2]);
      if (!c) return send(res, 404, { error: 'No such community.' });
      if (!isCommunityMember(c, auth.user.username)) return send(res, 403, { error: 'You are not a member of this community.' });
      return send(res, 200, communityPlaces(c));
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

    if ((req.method === 'POST' || req.method === 'DELETE') && seg[1] === 'communities' && seg[2] && seg[3] === 'spotlight' && seg[4]) {
      const auth = requireAuth(req, res);
      if (!auth) return;
      const c = findCommunity(seg[2]);
      if (!c) return send(res, 404, { error: 'No such community.' });
      if (!canAdminCommunity(c, auth.user.username)) return send(res, 403, { error: 'Only admins can spotlight photos.' });
      const post = posts.find(p => p.id === seg[4] && p.communityId === c.id);
      if (!post) return send(res, 404, { error: 'No such photo.' });
      if (req.method === 'POST') {
        c.spotlightPostId = post.id;
        saveJSON('communities.json', communities);
        addAudit(c.id, auth.user.username, 'photo.spotlighted', post.id, { title: post.title });
        addNotification(post.username, c.id, 'spotlight', auth.user.username, post.id, { title: post.title });
      } else {
        if (c.spotlightPostId === post.id) { c.spotlightPostId = ''; saveJSON('communities.json', communities); }
      }
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
      return send(res, 200, scopedPosts(ctx.community.id).sort((a, b) => b.created - a.created));
    }

    if (req.method === 'POST' && pathname === '/api/photos') {
      const ctx = requireCommunity(req, res, params);
      if (!ctx) return;
      // 20MB body: a valid 12MB image base64-expands to ~16MB, so the default
      // limit would 413 max-size uploads before saveImage's friendly check runs.
      const b = JSON.parse(await readBody(req, 20 * 1024 * 1024));
      const saved = await saveImage(b.image, 'uploads', ctx.auth.user.username);
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
        place: clean(b.place, 60),
        caption: clean(b.caption, 300),
        year: Number.isFinite(yr) && yr >= 1900 && yr <= 2100 ? yr : new Date().getFullYear(),
        tags: Array.isArray(b.tags) ? b.tags.slice(0, 8).map(t => clean(t, 20).toUpperCase()).filter(Boolean) : [],
        file: saved.file,
        layout: ['full', 'portrait', 'landscape'].includes(b.layout) ? b.layout : 'full',
        pinned: false,
        promptId: promptOk ? promptId : '',
        likes: [],
        reactions: {},
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
      if (i < 0) addNotification(post.username, post.communityId, 'like', name, post.id, { title: post.title });
      return send(res, 200, { count: post.likes.length, liked: i < 0 });
    }

    // emoji reactions: a small fixed set on top of the legacy heart. 'heart'
    // stays mapped to post.likes so the heart count is one source of truth;
    // the other emojis live in post.reactions = { emoji: [usernames] }.
    if (req.method === 'POST' && seg[1] === 'photos' && seg[2] && seg[3] === 'react') {
      const auth = requireAuth(req, res);
      if (!auth) return;
      const post = posts.find(p => p.id === seg[2]);
      if (!post) return send(res, 404, { error: 'No such photo.' });
      const c = findCommunity(post.communityId);
      if (!isCommunityMember(c, auth.user.username)) return send(res, 403, { error: 'You are not a member of this community.' });
      const b = JSON.parse(await readBody(req, 64 * 1024));
      const emoji = clean(b.emoji, 12);
      if (!REACTION_EMOJI.includes(emoji)) return send(res, 400, { error: 'Unknown reaction.' });
      const name = auth.user.username;
      let list, on;
      if (emoji === 'heart') {
        // heart is the canonical like: toggle post.likes so counts stay in sync
        if (!Array.isArray(post.likes)) post.likes = [];
        list = post.likes;
        const i = list.indexOf(name);
        if (i >= 0) { list.splice(i, 1); on = false; } else { list.push(name); on = true; }
      } else {
        if (!post.reactions || typeof post.reactions !== 'object' || Array.isArray(post.reactions)) post.reactions = {};
        list = Array.isArray(post.reactions[emoji]) ? post.reactions[emoji] : [];
        const i = list.indexOf(name);
        if (i >= 0) list.splice(i, 1); else list.push(name);
        on = i < 0;
        if (list.length) post.reactions[emoji] = list; else delete post.reactions[emoji];
      }
      saveJSON('posts.json', posts);
      if (on) addNotification(post.username, post.communityId, 'reaction', name, post.id, { title: post.title, text: emoji });
      return send(res, 200, { emoji, on, count: list.length, likes: post.likes, reactions: post.reactions || {} });
    }

    /* ---------------- private "saved" tray (per user, per community) ---------------- */
    // toggle: POST saves, DELETE unsaves. Kept on the user record so it stays private.
    if ((req.method === 'POST' || req.method === 'DELETE') && seg[1] === 'photos' && seg[2] && seg[3] === 'save') {
      const auth = requireAuth(req, res);
      if (!auth) return;
      const post = posts.find(p => p.id === seg[2]);
      if (!post) return send(res, 404, { error: 'No such photo.' });
      const c = findCommunity(post.communityId);
      if (!isCommunityMember(c, auth.user.username)) return send(res, 403, { error: 'You are not a member of this community.' });
      if (!assertSameCommunityPhoto(post.id, post.communityId)) return send(res, 404, { error: 'No such photo.' });
      const already = savedPostIds(auth.user, post.communityId).includes(post.id);
      // POST idempotently saves, DELETE idempotently unsaves; only write when it changes
      const want = req.method === 'POST';
      if (want !== already) { toggleSaved(auth.user, post.communityId, post.id); saveJSON('users.json', users); }
      return send(res, 200, { saved: want });
    }

    if (req.method === 'GET' && pathname === '/api/saved') {
      const ctx = requireCommunity(req, res, params);
      if (!ctx) return;
      // the caller's saved posts, in save order, filtered to photos still present
      // in this community. ids and posts stay in lockstep (both live-only).
      const byId = new Map(scopedPosts(ctx.community.id).map(p => [p.id, p]));
      const list = savedPostIds(ctx.auth.user, ctx.community.id)
        .map(id => byId.get(id))
        .filter(Boolean);
      return send(res, 200, { ids: list.map(p => p.id), posts: list });
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
      // optional single-level reply: parentId must name an existing top-level
      // comment on this same post (a comment whose own parentId is falsy).
      let parentId = '';
      let parent = null;
      if (b.parentId) {
        parent = post.comments.find(x => x.id === b.parentId && !x.parentId);
        if (!parent) return send(res, 400, { error: 'That comment no longer exists.' });
        parentId = parent.id;
      }
      const comment = { id: crypto.randomBytes(6).toString('hex'), username: auth.user.username, text, parentId, created: Date.now() };
      post.comments.push(comment);
      saveJSON('posts.json', posts);
      addNotification(post.username, post.communityId, 'comment', auth.user.username, post.id, { title: post.title, text });
      // @mentions: notify every real community member tagged in the text (minus the author + post owner, who already gets a comment notification)
      const members = communityMembers(c);
      const mentioned = new Set((text.match(/@([a-z0-9_]{3,20})/g) || []).map(m => m.slice(1).toLowerCase()));
      mentioned.forEach(name => {
        if (name === auth.user.username || name === post.username) return;
        if (!members[name]) return;
        addNotification(name, post.communityId, 'mention', auth.user.username, post.id, { title: post.title, text });
      });
      // reply: notify the parent comment's author, unless they are the actor,
      // the post owner, or already @mentioned (all of whom got another notification), or a non-member.
      if (parent && parent.username !== auth.user.username && parent.username !== post.username && !mentioned.has(parent.username) && members[parent.username]) {
        addNotification(parent.username, post.communityId, 'reply', auth.user.username, post.id, { title: post.title, text });
      }
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
      // deleting a top-level comment removes its direct replies too, so no orphans remain
      if (!comment.parentId) post.comments = post.comments.filter(x => x.parentId !== comment.id);
      saveJSON('posts.json', posts);
      return send(res, 200, { ok: true });
    }

    // a heart on a single comment, mirroring the photo-like route. likes live in
    // comment.likes = [usernames]; toggling notifies the comment author on a new like.
    if (req.method === 'POST' && seg[1] === 'photos' && seg[2] && seg[3] === 'comments' && seg[4] && seg[5] === 'like') {
      const auth = requireAuth(req, res);
      if (!auth) return;
      const post = posts.find(p => p.id === seg[2]);
      if (!post || !Array.isArray(post.comments)) return send(res, 404, { error: 'No such comment.' });
      const c = findCommunity(post.communityId);
      if (!isCommunityMember(c, auth.user.username)) return send(res, 403, { error: 'You are not a member of this community.' });
      const comment = post.comments.find(x => x.id === seg[4]);
      if (!comment) return send(res, 404, { error: 'No such comment.' });
      if (!Array.isArray(comment.likes)) comment.likes = [];
      const name = auth.user.username;
      const i = comment.likes.indexOf(name);
      if (i >= 0) comment.likes.splice(i, 1); else comment.likes.push(name);
      saveJSON('posts.json', posts);
      if (i < 0) addNotification(comment.username, post.communityId, 'comment_like', name, post.id, { title: post.title, text: comment.text });
      return send(res, 200, { count: comment.likes.length, liked: i < 0 });
    }

    // edit a comment's own text in place. author-only (moderation stays with
    // DELETE), keeping likes/replies/created intact and stamping comment.edited.
    if (req.method === 'PUT' && seg[1] === 'photos' && seg[2] && seg[3] === 'comments' && seg[4] && !seg[5]) {
      const auth = requireAuth(req, res);
      if (!auth) return;
      const post = posts.find(p => p.id === seg[2]);
      if (!post || !Array.isArray(post.comments)) return send(res, 404, { error: 'No such comment.' });
      const c = findCommunity(post.communityId);
      if (!isCommunityMember(c, auth.user.username)) return send(res, 403, { error: 'You are not a member of this community.' });
      const comment = post.comments.find(x => x.id === seg[4]);
      if (!comment) return send(res, 404, { error: 'No such comment.' });
      if (comment.username !== auth.user.username) return send(res, 403, { error: 'You can only edit your own comment.' });
      const b = JSON.parse(await readBody(req, 64 * 1024));
      const text = clean(b.text, 500);
      if (!text) return send(res, 400, { error: 'Write something first.' });
      comment.text = text;
      comment.edited = Date.now();
      saveJSON('posts.json', posts);
      return send(res, 200, comment);
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
      if (b.place !== undefined) post.place = clean(b.place, 60);
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
      await deleteImage(post.file);
      // re-find by identity after the await: another request may have mutated
      // posts during the network delete, making the captured index i stale.
      const idx = posts.findIndex(p => p.id === photoId);
      if (idx >= 0) posts.splice(idx, 1);
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
      // drop the deleted photo from every member's private saved tray
      let usersChanged = false;
      Object.values(users).forEach(u => {
        const list = u.saved && u.saved[post.communityId];
        if (!Array.isArray(list)) return;
        const next = list.filter(id => id !== photoId);
        if (next.length !== list.length) {
          if (next.length) u.saved[post.communityId] = next; else delete u.saved[post.communityId];
          usersChanged = true;
        }
      });
      if (usersChanged) saveJSON('users.json', users);
      // never let a stale spotlight survive its photo
      if (c && c.spotlightPostId === photoId) { c.spotlightPostId = ''; saveJSON('communities.json', communities); }
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
    // never reflect a raw error message; use fixed client-safe strings
    return send(res, code, { error: code === 413 ? 'Payload too large.' : code === 400 ? 'Invalid request body.' : 'Server error.' });
  }
}

/* ---------------- server ---------------- */
function onRequest(req, res) {
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

  if (pathname.startsWith('/api/')) { handleApi(req, res, pathname, u.searchParams); return; }
  serveStatic(req, res, pathname);
}

// Listen on BOTH loopback stacks (127.0.0.1 and ::1) so http://localhost:8173
// works however the OS resolves 'localhost' (Windows often prefers IPv6 ::1),
// while staying loopback-only - not reachable from the LAN. The IPv6 listener
// no-ops if ::1 is unavailable.
http.createServer(onRequest).listen(8173, '127.0.0.1', () => console.log('serving at http://localhost:8173'));
http.createServer(onRequest).listen(8173, '::1').on('error', () => {});
