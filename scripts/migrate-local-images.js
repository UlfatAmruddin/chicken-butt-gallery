'use strict';
/* One-time migration: any image still stored as a local assets/ path (photos,
   avatars, community covers) is uploaded to Supabase Storage and the record is
   repointed to the returned public https URL. Local files are left in place as a
   backup; delete assets/ once you have verified the app loads from Supabase.

   Run from the project root with .supabase.json present (or SUPABASE_* env vars):
     node scripts/migrate-local-images.js */
const fs = require('fs');
const path = require('path');
const supa = require('../lib/supabase-storage');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const load = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
const save = (f, obj) => fs.writeFileSync(path.join(DATA, f), JSON.stringify(obj, null, 2));
const isLocal = (v) => v && typeof v === 'string' && !v.startsWith('http');

async function toSupabase(localPath, subdir) {
  const abs = path.join(ROOT, localPath);
  if (!fs.existsSync(abs)) { console.log(`  ! missing on disk, left as-is: ${localPath}`); return null; }
  const buf = fs.readFileSync(abs);
  const type = supa.sniff(buf);
  if (!type) { console.log(`  ! not a valid jpeg/png/webp, left as-is: ${localPath}`); return null; }
  const dataUrl = `data:image/${type};base64,${buf.toString('base64')}`;
  const base = path.basename(localPath).replace(/\.[^.]+$/, '');
  const res = await supa.uploadDataUrl(dataUrl, subdir, base, 25 * 1024 * 1024);
  if (res.error) { console.log(`  ! upload failed (${res.error}), left as-is: ${localPath}`); return null; }
  return res.file;
}

(async () => {
  if (!supa.isConfigured()) { console.error('Supabase is not configured (.supabase.json or SUPABASE_* env). Aborting.'); process.exit(1); }

  // back up the two data files we touch
  for (const f of ['posts.json', 'users.json']) {
    fs.copyFileSync(path.join(DATA, f), path.join(DATA, `${f}.pre-image-migration.bak`));
  }
  console.log('backed up posts.json + users.json (.pre-image-migration.bak)\n');

  let photos = 0, avatars = 0, covers = 0;

  const posts = load('posts.json');
  for (const p of posts) {
    if (isLocal(p.file)) {
      const url = await toSupabase(p.file, 'uploads');
      if (url) { console.log(`photo ${p.id}: ${p.file} -> supabase`); p.file = url; photos++; }
    }
  }
  save('posts.json', posts);

  const users = load('users.json');
  for (const name of Object.keys(users)) {
    const u = users[name];
    if (isLocal(u.avatar)) { const url = await toSupabase(u.avatar, 'avatars'); if (url) { console.log(`avatar ${name}: ${u.avatar} -> supabase`); u.avatar = url; avatars++; } }
    if (isLocal(u.coverFile)) { const url = await toSupabase(u.coverFile, 'community'); if (url) { console.log(`cover ${name}: ${u.coverFile} -> supabase`); u.coverFile = url; covers++; } }
  }
  save('users.json', users);

  const communities = load('communities.json');
  let commCovers = 0;
  for (const c of communities) {
    if (isLocal(c.coverFile)) { const url = await toSupabase(c.coverFile, 'community'); if (url) { console.log(`community ${c.id}: ${c.coverFile} -> supabase`); c.coverFile = url; commCovers++; } }
  }
  if (commCovers) { fs.copyFileSync(path.join(DATA, 'communities.json'), path.join(DATA, 'communities.json.pre-image-migration.bak')); save('communities.json', communities); }

  console.log(`\ndone. photos: ${photos}, avatars: ${avatars}, user covers: ${covers}, community covers: ${commCovers}`);
})().catch((e) => { console.error('migration error:', e.message); process.exit(1); });
