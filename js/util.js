/* Pure helpers - no shared state, no DOM/Three dependencies.
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

/* wrap a value into [-range/2, range/2) - used for seamless sphere scrolling */
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

/* Shared share-card chrome: the near-black backdrop + soft top glow + thin
   inset border used by the recap card, album contact sheet, and mosaic poster.
   Kept identical in one place so the three keepsake images can never drift. */
export function drawShareBackdrop(ctx, W, H) {
  ctx.fillStyle = '#050505';
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W / 2, -120, 80, W / 2, 320, 900);
  glow.addColorStop(0, 'rgba(28,28,28,0.9)');
  glow.addColorStop(1, 'rgba(5,5,5,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#1f1f1f';
  ctx.lineWidth = 2;
  ctx.strokeRect(24.5, 24.5, W - 49, H - 49);
}

/* Pick the largest heading size that fits `text` within maxW, stepping down by
   4px from startPx to a minPx floor. Sets ctx.font (so the caller can fillText
   straight after) and returns the chosen size. */
export function fitHeadingFont(ctx, text, maxW, startPx, minPx, weight = 600, family = 'Inter') {
  let size = startPx;
  ctx.font = `${weight} ${size}px ${family}`;
  while (ctx.measureText(text).width > maxW && size > minPx) {
    size -= 4;
    ctx.font = `${weight} ${size}px ${family}`;
  }
  return size;
}

/* render a horizontal thumbnail filmstrip into `container` from an ordered
   `items` list, marking item #activeIndex active and scrolling it into view.
   Each item may carry {heroSrc|src, title}. Clicking a thumb calls onPick(i).
   DOM-only and dependency-free so any caller can drive it from ordered nav. */
export function buildFilmstrip(container, items, activeIndex, { onPick } = {}) {
  if (!container) return;
  container.innerHTML = '';
  if (!Array.isArray(items) || items.length <= 1) { container.hidden = true; return; }
  container.hidden = false;
  const frag = document.createDocumentFragment();
  let activeBtn = null;
  items.forEach((item, i) => {
    const src = (item && (item.heroSrc || item.src)) || '';
    const title = (item && item.title) || '';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'fs-thumb' + (i === activeIndex ? ' active' : '');
    btn.dataset.index = String(i);
    if (i === activeIndex) btn.setAttribute('aria-current', 'true');
    btn.title = title;
    btn.setAttribute('aria-label', title ? 'Jump to ' + title : 'Jump to photo ' + (i + 1));
    btn.innerHTML = `<img src="${esc(mediaSrc(src))}" alt="" loading="lazy" draggable="false"><span class="fs-num mono">${i + 1}</span>`;
    if (typeof onPick === 'function') btn.addEventListener('click', () => onPick(i));
    if (i === activeIndex) activeBtn = btn;
    frag.appendChild(btn);
  });
  container.appendChild(frag);
  if (activeBtn && activeBtn.scrollIntoView) {
    activeBtn.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'auto' });
  }
}
