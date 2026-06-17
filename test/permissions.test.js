'use strict';
/* Unit tests for the security-critical pure logic: the RBAC permission matrix,
   image content sniffing, and password hashing. These are the functions where a
   subtle bug becomes a privilege escalation or a malformed-upload bypass.

   Point the data/assets dirs at a throwaway temp location BEFORE requiring the
   app so the boot-time migration never touches real data. */
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-test-'));
process.env.PG_DATA_DIR = path.join(TMP, 'data');
// small rate-limit thresholds so the throttle tests are fast and deterministic
process.env.AUTH_FAIL_MAX = '3';
process.env.AUTH_IP_MAX = '5';
process.env.AUTH_MAX_ATTEMPTS = '4';
process.env.ADMIN_USERNAMES = 'testadmin';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  isAdminUsername, canChangeMember, canRemoveMember,
  isCommunityMember, canAdminCommunity, canOwnCommunity,
  canManagePost, sniffImage, hashPass,
  authThrottled, accountLocked, recordAuthFailure, clearAuthFailures,
} = require('../lib/helpers');
const { communities, posts } = require('../lib/store');

const ADMIN = 'testadmin'; // configured via ADMIN_USERNAMES above

test('isAdminUsername matches the configured admin, case-insensitively', () => {
  assert.equal(isAdminUsername(ADMIN), true);
  assert.equal(isAdminUsername(ADMIN.toUpperCase()), true);
  assert.equal(isAdminUsername('randomuser'), false);
  assert.equal(isAdminUsername(''), false);
  assert.equal(isAdminUsername(null), false);
});

test('canChangeMember: only the owner promotes/demotes, and never themselves or another owner', () => {
  assert.equal(canChangeMember('owner', 'member', 'admin', 'alice', 'bob'), true);
  assert.equal(canChangeMember('owner', 'admin', 'member', 'alice', 'bob'), true);
  // a plain admin cannot change roles
  assert.equal(canChangeMember('admin', 'member', 'admin', 'alice', 'bob'), false);
  // owner cannot change their own role
  assert.equal(canChangeMember('owner', 'owner', 'admin', 'alice', 'alice'), false);
  // nobody can demote another owner
  assert.equal(canChangeMember('owner', 'owner', 'member', 'alice', 'bob'), false);
  // invalid target role rejected
  assert.equal(canChangeMember('owner', 'member', 'superadmin', 'alice', 'bob'), false);
  // global admin bypasses
  assert.equal(canChangeMember('member', 'member', 'admin', ADMIN, 'bob'), true);
});

test('canRemoveMember: owners outrank admins outrank members; owners are untouchable', () => {
  const c = { members: { alice: 'owner', bob: 'admin', eve: 'admin', carol: 'member', dave: 'member' } };
  assert.equal(canRemoveMember(c, 'alice', 'alice'), false); // self
  assert.equal(canRemoveMember(c, 'alice', 'bob'), true);    // owner -> admin
  assert.equal(canRemoveMember(c, 'alice', 'carol'), true);  // owner -> member
  assert.equal(canRemoveMember(c, 'bob', 'carol'), true);    // admin -> member
  assert.equal(canRemoveMember(c, 'bob', 'eve'), false);     // admin -> admin
  assert.equal(canRemoveMember(c, 'carol', 'dave'), false);  // member -> member
  assert.equal(canRemoveMember(c, 'bob', 'alice'), false);   // anyone -> owner
  assert.equal(canRemoveMember(c, ADMIN, 'alice'), true);    // global admin bypass
});

test('isCommunityMember: banned beats membership; global admin is always a member', () => {
  const c = { members: { alice: 'owner', bob: 'member' }, banned: { bob: { bannedAt: 1 } } };
  assert.equal(isCommunityMember(c, 'alice'), true);
  assert.equal(isCommunityMember(c, 'bob'), false);     // banned overrides role
  assert.equal(isCommunityMember(c, 'stranger'), false);
  assert.equal(isCommunityMember(c, ADMIN), true);      // superadmin sees all
});

test('canAdminCommunity / canOwnCommunity respect role hierarchy', () => {
  const c = { members: { alice: 'owner', bob: 'admin', carol: 'member' } };
  assert.equal(canAdminCommunity(c, 'alice'), true);
  assert.equal(canAdminCommunity(c, 'bob'), true);
  assert.equal(canAdminCommunity(c, 'carol'), false);
  assert.equal(canOwnCommunity(c, 'alice'), true);
  assert.equal(canOwnCommunity(c, 'bob'), false);
  assert.equal(canAdminCommunity(c, ADMIN), true);
  assert.equal(canOwnCommunity(c, ADMIN), true);
});

test('canManagePost: only the author or a community admin can manage a post', () => {
  communities.push({ id: 'test-comm', members: { alice: 'owner', bob: 'member' } });
  const post = { id: 'p1', username: 'bob', communityId: 'test-comm' };
  posts.push(post);
  assert.equal(canManagePost({ user: { username: 'bob' } }, post), true);   // author
  assert.equal(canManagePost({ user: { username: 'alice' } }, post), true); // owner
  assert.equal(canManagePost({ user: { username: 'carol' } }, post), false); // stranger
});

test('sniffImage validates real magic bytes and rejects forgeries', () => {
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x11])), 'jpeg');
  assert.equal(sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'png');
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]);
  assert.equal(sniffImage(webp), 'webp');
  assert.equal(sniffImage(Buffer.from('<html>not an image')), '');
  assert.equal(sniffImage(Buffer.alloc(0)), '');
});

test('accountLocked flags an account after too many failed logins (across IPs) and clears on success', () => {
  const acct = 'victim_' + Date.now().toString(36);
  assert.equal(accountLocked(acct), false);               // fresh account
  recordAuthFailure(acct); recordAuthFailure(acct); recordAuthFailure(acct); // AUTH_FAIL_MAX=3, any source
  assert.equal(accountLocked(acct), true);                // distributed-failure threshold reached
  clearAuthFailures(acct);                                 // a correct login clears it
  assert.equal(accountLocked(acct), false);
});

test('authThrottled (pre-credential gate) does NOT lock an account from failures alone — only wrong passwords do, in the handler', () => {
  // The fix for the lockout-DoS: failures don't pre-block, so a correct password
  // (which never reaches recordAuthFailure) is never throttled by the account dimension.
  const acct = 'owner_' + Date.now().toString(36);
  recordAuthFailure(acct); recordAuthFailure(acct); recordAuthFailure(acct);
  const freshIp = { socket: { remoteAddress: '172.16.0.1' }, headers: {} };
  assert.equal(authThrottled(freshIp, acct), false);      // not blocked by the account's failures
});

test('authThrottled throttles password spraying from one IP across many usernames', () => {
  const ip = { socket: { remoteAddress: '10.9.9.9' }, headers: {} };
  let blocked = false;
  for (let i = 0; i < 8; i++) { if (authThrottled(ip, 'spray_user_' + i)) { blocked = true; break; } }
  assert.equal(blocked, true);                            // AUTH_IP_MAX=5 trips before 8 distinct usernames
});

test('hashPass is deterministic per salt and salt-sensitive', () => {
  const a = hashPass('correct horse', 'salt1');
  const b = hashPass('correct horse', 'salt1');
  const c = hashPass('correct horse', 'salt2');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(a.length, 128); // 64 bytes -> hex
});
