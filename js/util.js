/* Pure helpers — no shared state, no DOM/Three dependencies.
   Safe to import anywhere. */

/* escape user text for safe innerHTML interpolation */
export const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* normalize an image path/URL: pass data:/http(s)/absolute through, else root it */
export function mediaSrc(p) { return /^(data:|https?:|\/)/.test(p) ? p : '/' + p; }

/* avatar contents for a .avatar element: photo if set, else first initial */
export function avatarInner(profile) {
  if (profile && profile.avatar) return `<img src="${esc(mediaSrc(profile.avatar))}" alt="">`;
  const ch = (profile && (profile.displayName || profile.username) || '?')[0];
  return esc(ch);
}

/* wrap a value into [-range/2, range/2) — used for seamless sphere scrolling */
export function wrap(x, range) {
  x = (x + range / 2) % range;
  if (x < 0) x += range;
  return x - range / 2;
}

/* nearest equivalent of `desired` to `current` under modular `range` */
export function nearestEquiv(desired, current, range) {
  return desired - Math.round((desired - current) / range) * range;
}

/* relative "x ago" timestamp label */
export function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60); if (h < 24) return h + 'h ago';
  const d = Math.floor(h / 24); if (d < 7) return d + 'd ago';
  return new Date(ts).toLocaleDateString();
}

/* draw an image into rect r with object-fit: cover semantics */
export function coverDraw(ctx, img, r) {
  const s = Math.max(r.w / img.width, r.h / img.height);
  const sw = r.w / s, sh = r.h / s;
  ctx.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, r.x, r.y, r.w, r.h);
}
