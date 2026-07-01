/* DETAIL FILMSTRIP: keyboard-navigable quick-jump thumbnails.
   Wires the reusable buildFilmstrip() primitive to the live detail page.
   main.js owns the pool + navigation as module-local state (no globals), so
   this driver reads the active photo from the hash route it already writes on
   every open / step / slideshow tick, and jumps by setting that same hash -
   main.js's router (handleHashRoute) opens any photo from c/<id>/photo/<id>.
   The ordered strip mirrors the server's created-desc photo order (the pool's
   order when nothing is pinned, i.e. the common case); jumping by hash lands
   correctly regardless of order. Cached per community, refetched on a miss.
   (Served as a module so the page needs no inline script under a strict CSP.) */
import { buildFilmstrip } from './util.js';
import { api } from './api.js';

const strip = document.getElementById('d-filmstrip');
const detail = document.getElementById('detail');
if (strip && detail) {
  // read the active community + photo id straight from the hash main.js writes:
  //   #/c/<community>/photo/<postId>  or  #/photo/<postId>
  function routeInfo() {
    const raw = (location.hash || '').replace(/^#\/?/, '').replace(/^\/+|\/+$/g, '');
    let parts;
    try { parts = decodeURIComponent(raw).split('/').filter(Boolean); }
    catch { parts = raw.split('/').filter(Boolean); }
    if (parts[0] === 'c' && parts[2] === 'photo' && parts[3]) return { community: parts[1], postId: parts[3] };
    if (parts[0] === 'photo' && parts[1]) return { community: '', postId: parts[1] };
    return null;
  }

  function photoHash(community, postId) {
    return community ? `#/c/${community}/photo/${postId}` : `#/photo/${postId}`;
  }

  // fetch + cache the community photo list, created-desc (matches the server
  // and the unpinned pool). one call per community, reused across steps.
  let cache = { key: null, items: [] };
  async function loadItems(community, force) {
    const key = community || '_';
    if (!force && cache.key === key && cache.items.length) return cache.items;
    let rows = [];
    try { rows = await api.call('GET', '/api/photos'); } catch { rows = []; }
    const items = (Array.isArray(rows) ? rows : []).map(p => ({
      postId: p.id,
      src: p.file || '',
      title: (p.title || 'UNTITLED').toUpperCase(),
    }));
    cache = { key, items };
    return items;
  }

  let token = 0;   // guards against overlapping async renders
  async function render() {
    const info = detail.getAttribute('aria-hidden') === 'false' ? routeInfo() : null;
    if (!info) { strip.hidden = true; strip.innerHTML = ''; return; }
    const my = ++token;
    let items = await loadItems(info.community, false);
    let idx = items.findIndex(it => it.postId === info.postId);
    if (idx < 0) { items = await loadItems(info.community, true); idx = items.findIndex(it => it.postId === info.postId); }
    if (my !== token) return;   // a newer render superseded this one
    if (idx < 0) { strip.hidden = true; strip.innerHTML = ''; return; }
    buildFilmstrip(strip, items, idx, {
      onPick(i) {
        const t = items[i];
        if (!t || i === idx) return;
        location.hash = photoHash(info.community, t.postId);
      },
    });
  }

  // roving keyboard nav inside the strip: Left/Right move focus between thumbs,
  // Home/End jump to the ends. stopPropagation keeps main.js's global arrow
  // handler (which steps the open photo) from also firing while a thumb has focus.
  strip.addEventListener('keydown', e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
    const thumbs = [...strip.querySelectorAll('.fs-thumb')];
    if (!thumbs.length) return;
    const here = thumbs.indexOf(document.activeElement);
    let next = here;
    if (e.key === 'ArrowLeft') next = here <= 0 ? thumbs.length - 1 : here - 1;
    else if (e.key === 'ArrowRight') next = here < 0 || here >= thumbs.length - 1 ? 0 : here + 1;
    else if (e.key === 'Home') next = 0;
    else next = thumbs.length - 1;
    e.preventDefault();
    e.stopPropagation();
    thumbs[next].focus();
  });

  // re-render whenever the active photo changes (open / step / slideshow write
  // the hash) or the detail panel is shown / hidden (aria-hidden flips).
  window.addEventListener('hashchange', render);
  new MutationObserver(render).observe(detail, { attributes: true, attributeFilter: ['aria-hidden'] });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render);
  else render();
}
