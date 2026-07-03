import * as THREE from './js/vendor/three.module.js';
import { esc, mediaSrc, avatarInner, wrap, nearestEquiv, timeAgo, coverDraw, drawShareBackdrop, fitHeadingFont, recapDateLabel, sanitizeBase } from './js/util.js';
import { loadCors, renderRecapCard, renderAlbumContactSheet, downloadBlob, shareOrDownloadBlob } from './js/poster.js';
import { createGlobe } from './js/globe.js';
import { LOW_POWER, IMAGE_LOAD_CONCURRENCY } from './js/config.js';
import { makeCardTexture, setCardAccent } from './js/textures.js';
import { api } from './js/api.js';
import { toast } from './js/toast.js';
import { loadImage } from './js/images.js';
import { initCinema } from './js/cinema.js';
import { renderMosaicPoster } from './js/mosaic.js';
const gsap = window.gsap;

let me = null;               // logged-in user's profile
let currentCommunity = null; // active private community
let allCommunities = [];
let pendingAuthAction = null;
let communityPosts = [];     // posts fetched from the server
let pool = [];               // community posts -> what the wall shows
let communityActivity = [];
let communityPulse = null;
let communityMilestones = null;
let communityPrompts = [];
let savedIds = new Set();     // postIds the logged-in user has privately saved here

// give the API client read access to the active community for auto-scoping
api.communityResolver = () => currentCommunity;

function postToProject(p) {
  return {
    src: mediaSrc(p.file),
    client: p.client || '@' + p.username,
    title: (p.title || 'UNTITLED').toUpperCase(),
    cat: 'COMMUNITY',
    tags: (p.tags && p.tags.length) ? p.tags : ['PHOTO'],
    year: p.year || new Date(p.created).getFullYear(),
    caption: p.caption || '',
    place: p.place || '',
    lat: Number.isFinite(p.lat) ? p.lat : null,
    lng: Number.isFinite(p.lng) ? p.lng : null,
    country: p.country || '',
    state: p.state || '',
    layout: p.layout || 'full',
    logo: 'mono',
    community: true,
    communityId: p.communityId,
    username: p.username,
    postId: p.id,
    pinned: !!p.pinned,
    promptId: p.promptId || '',
    created: p.created || 0,
    likes: Array.isArray(p.likes) ? p.likes : [],
    reactions: (p.reactions && typeof p.reactions === 'object' && !Array.isArray(p.reactions)) ? p.reactions : {},
    comments: Array.isArray(p.comments) ? p.comments : [],
  };
}
/* Pull a photo's saved coordinates into the shape the place search expects, or
   null when it has none. Used to seed the edit form so it never carries a
   location picked for a different photo. */
function geoOf(p) {
  return (p && Number.isFinite(p.lat) && Number.isFinite(p.lng))
    ? { lat: p.lat, lng: p.lng, country: p.country || '', state: p.state || '' } : null;
}
function buildPool() {
  const pinned = new Set(currentCommunity && currentCommunity.pinnedPostIds || []);
  pool = communityPosts
    .slice()
    .sort((a, b) => {
      const ap = pinned.has(a.id) ? 1 : 0;
      const bp = pinned.has(b.id) ? 1 : 0;
      return bp - ap || b.created - a.created;
    })
    .map(postToProject);
  // if a Sphere Tour is running, keep the live pool in love-score order across
  // rebuilds (e.g. an admin pins a photo mid-tour). the freshly built normal
  // order becomes the restore target; buildTour() re-ranks the live pool.
  if (tourActive) { tourSavedPool = pool; pool = buildTour(); }
}

/* ============================================================
   ON THIS DAY - resurface past memories on the sphere.
   Purely client-side over the current community pool: it finds photos
   posted on today's calendar date in previous years and, failing that,
   picks the oldest photo as a "REDISCOVER" nudge. Dismissible per day.
   ============================================================ */
const memoryRibbon = document.getElementById('memory-ribbon');
const memoryRibbonText = document.getElementById('memory-ribbon-text');
const memoryRibbonOpen = document.getElementById('memory-ribbon-open');
const memoryRibbonClose = document.getElementById('memory-ribbon-close');
let onThisDay = null;   // { kind:'onthisday'|'rediscover', matches:[project], label }

/* local yyyy-mm-dd for a Date (used for both matching and the dismissal key) */
function localDayKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function otdDismissKey() {
  const id = currentCommunity ? (currentCommunity.id || currentCommunity.slug || '') : '';
  return `pg_otd_${id}_${localDayKey(new Date())}`;
}

/* build the "on this day" result from the current pool, or null if nothing fits */
function computeOnThisDay() {
  if (!currentCommunity || !pool.length) return null;
  const now = new Date();
  const curYear = now.getFullYear();
  const matches = [];
  for (const p of pool) {
    if (!p.created) continue;
    const d = new Date(p.created);
    if (isNaN(d)) continue;
    if (d.getMonth() === now.getMonth() && d.getDate() === now.getDate() && d.getFullYear() < curYear) {
      matches.push(p);
    }
  }
  if (matches.length) {
    // oldest first so the memory opens at the earliest year
    matches.sort((a, b) => a.created - b.created);
    const yrsAgo = curYear - new Date(matches[0].created).getFullYear();
    const n = matches.length;
    const label = `ON THIS DAY - ${n} MEMOR${n === 1 ? 'Y' : 'IES'} FROM ${yrsAgo} YEAR${yrsAgo === 1 ? '' : 'S'} AGO`;
    return { kind: 'onthisday', matches, label };
  }
  // fallback: nudge people to rediscover the oldest photo in the room
  const past = pool.filter(p => p.created && new Date(p.created).getFullYear() < curYear);
  if (!past.length) return null;
  past.sort((a, b) => a.created - b.created);
  const yrsAgo = curYear - new Date(past[0].created).getFullYear();
  const label = yrsAgo > 0
    ? `REDISCOVER - A MEMORY FROM ${yrsAgo} YEAR${yrsAgo === 1 ? '' : 'S'} AGO`
    : 'REDISCOVER - AN OLDER MEMORY';
  return { kind: 'rediscover', matches: [past[0]], label };
}

/* compute + render (or hide) the ribbon for the active community */
function renderMemoryRibbon() {
  if (!memoryRibbon) return;
  try {
    onThisDay = null;
    memoryRibbon.hidden = true;
    if (!currentCommunity || !me || !pool.length) return;
    // respect a per-day, per-community dismissal
    let dismissed = false;
    try { dismissed = localStorage.getItem(otdDismissKey()) === '1'; } catch {}
    if (dismissed) return;
    const otd = computeOnThisDay();
    if (!otd) return;
    onThisDay = otd;
    memoryRibbonText.textContent = otd.label;
    memoryRibbon.hidden = false;
    if (!reduceMotion) {
      gsap.fromTo(memoryRibbon, { opacity: 0, y: -10 }, { opacity: 1, y: 0, duration: 0.45, ease: 'power2.out' });
    }
  } catch { memoryRibbon.hidden = true; }
}

/* open the resurfaced memory in the detail view; PREV/NEXT then walk normally */
function openMemoryRibbon() {
  if (!onThisDay || !onThisDay.matches.length) return;
  const first = onThisDay.matches[0];
  openDetailFor(first);
  if (onThisDay.kind === 'onthisday' && onThisDay.matches.length > 1) {
    toast(`${onThisDay.matches.length} MEMORIES FROM TODAY, OLDEST FIRST`);
  }
}

function dismissMemoryRibbon() {
  try { localStorage.setItem(otdDismissKey(), '1'); } catch {}
  if (!memoryRibbon) return;
  if (reduceMotion) { memoryRibbon.hidden = true; return; }
  gsap.to(memoryRibbon, { opacity: 0, y: -10, duration: 0.3, ease: 'power2.in', onComplete: () => { memoryRibbon.hidden = true; } });
}

if (memoryRibbonOpen) memoryRibbonOpen.addEventListener('click', openMemoryRibbon);
if (memoryRibbonClose) memoryRibbonClose.addEventListener('click', dismissMemoryRibbon);

/* ============================================================
   GALLERY GEOMETRY - interior of a sphere
   ============================================================ */
const BASE_COLS = 42;
const BASE_ROWS = 14;
const BASE_R = 30;
const BASE_CELL = (2 * Math.PI * BASE_R) / BASE_COLS;       // seamless horizontal wrap
const FOV = 40;
const layout = {
  cols: BASE_COLS,
  rows: BASE_ROWS,
  radius: BASE_R,
  cell: BASE_CELL,
  totalW: BASE_COLS * BASE_CELL,
  totalH: BASE_ROWS * BASE_CELL,
};

function syncGalleryLayout(itemCount) {
  const needed = Math.max(itemCount, 1);
  const baseCapacity = BASE_COLS * BASE_ROWS;
  let cols = BASE_COLS;
  let rows = BASE_ROWS;

  if (needed > baseCapacity) {
    const targetRatio = BASE_COLS / BASE_ROWS;
    cols = Math.max(BASE_COLS, Math.ceil(Math.sqrt(needed * targetRatio)));
    rows = Math.max(BASE_ROWS, Math.ceil(needed / cols));
  }

  layout.cols = cols;
  layout.rows = rows;
  layout.cell = BASE_CELL;
  layout.radius = (cols * layout.cell) / (2 * Math.PI);
  layout.totalW = cols * layout.cell;
  layout.totalH = rows * layout.cell;
  camera.far = Math.max(250, layout.radius * 3);
  camera.updateProjectionMatrix();
}

const canvas = document.getElementById('scene');
let sceneDirty = true;
let cardsAnimating = true;
let hoverDirty = true;
let renderLoopRunning = false;
let lastFrameAt = 0;
let lastHoverAt = 0;
let introDriftUntil = 0;

function markSceneDirty() {
  sceneDirty = true;
  queueRenderFrame();
}
function markHoverDirty() {
  hoverDirty = true;
  markSceneDirty();
}

const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'low-power', alpha: false });
renderer.sortObjects = false;
renderer.setClearColor(0x000000, 1);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 250);

/* keep the drawing buffer in sync with the canvas's real CSS box -
   handles window resizes, browser zoom, DPI changes, scrollbars, etc. */
function syncSize() {
  const w = canvas.clientWidth || window.innerWidth;
  const h = canvas.clientHeight || window.innerHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, LOW_POWER.maxDpr);
  const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
  if (canvas.width !== bw || canvas.height !== bh) {
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    sceneDirty = true;
  }
}
syncSize();
window.addEventListener('resize', markSceneDirty, { passive: true });
const ORIGIN = new THREE.Vector3(0, 0, 0);

/* scroll state - lenis-style: targets + exponentially smoothed current */
const state = { tx: 0, ty: 0, cx: 0, cy: 0, vx: 0, vy: 0 };
const gal = { fade: 0, others: 1 };
const ui = { locked: false };
let sel = null;
let hovered = null;
let interacted = false;
let introDone = false;

const cards = [];
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let mouseHas = false;
const emptyWall = document.getElementById('empty-wall');

function updateEmptyWall() {
  if (!emptyWall) return;
  emptyWall.hidden = !me || !currentCommunity || pool.length > 0;
}
function isAdminProfile(profile = me) {
  return !!profile && (profile.isAdmin || String(profile.username || '').toLowerCase() === 'ulfatamruddin');
}
function isCommunityAdmin() {
  return !!currentCommunity && ['owner', 'admin'].includes(currentCommunity.role);
}
function canManageProject(p) {
  return !!(p && p.community && me && (isAdminProfile() || isCommunityAdmin() || me.username === p.username));
}

function worldPerPx() {
  const vFov = THREE.MathUtils.degToRad(camera.fov);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
  const w = canvas.clientWidth || window.innerWidth;
  const h = canvas.clientHeight || window.innerHeight;
  return { wx: (layout.radius * hFov) / w, wy: (layout.radius * vFov) / h };
}

/* ============================================================
   BUILD SCENE
   ============================================================ */
let liveTextures = [];
let liveGeo = null;

function disposeGallery() {
  for (const c of cards) {
    scene.remove(c.mesh);
    c.mesh.material.dispose();
  }
  cards.length = 0;
  liveTextures.forEach(t => t.dispose());
  liveTextures = [];
  if (liveGeo) { liveGeo.dispose(); liveGeo = null; }
  hovered = null;
  markSceneDirty();
}

function makeGallerySlots(count) {
  const slots = [];
  const centerRow = (layout.rows - 1) / 2;
  const centerCol = Math.floor(layout.cols / 2);

  for (let row = 0; row < layout.rows; row++) {
    for (let col = 0; col < layout.cols; col++) {
      const wrappedCol = ((col - centerCol + layout.cols / 2) % layout.cols) - layout.cols / 2;
      const rowOffset = row - centerRow;
      slots.push({
        u: wrappedCol * layout.cell,
        v: rowOffset * layout.cell,
        distance: Math.hypot(wrappedCol / 1.8, rowOffset),
      });
    }
  }

  slots.sort((a, b) => a.distance - b.distance || a.v - b.v || a.u - b.u);
  return slots.slice(0, count);
}

function buildGallery() {
  syncGalleryLayout(pool.length);
  if (pool.length === 0) { markSceneDirty(); return; }

  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const textures = pool.map(p => makeCardTexture(p, p._img || null, maxAniso));
  liveTextures = textures;
  pool.forEach(p => { p.heroSrc = p.src || ''; });

  const slots = makeGallerySlots(pool.length);
  const geo = new THREE.PlaneGeometry(layout.cell * 0.995, layout.cell * 0.995);
  liveGeo = geo;
  for (let pIdx = 0; pIdx < pool.length; pIdx++) {
    const slot = slots[pIdx];
    const mat = new THREE.MeshBasicMaterial({ map: textures[pIdx], transparent: true, opacity: 0, depthWrite: false });
    const mesh = new THREE.Mesh(geo, mat);
    const card = {
      mesh,
      u: slot.u,
      v: slot.v,
      pIdx,
      pop: 0,
      op: 1,
      hoverT: 0,
      filtered: false,
    };
    mesh.userData.card = card;
    cards.push(card);
    scene.add(mesh);
  }
  cardsAnimating = true;
  markSceneDirty();
}

/* ============================================================
   FRAME LOOP
   ============================================================ */
const clock = new THREE.Clock();

function updateCards(dt) {
  let needsMoreFrames = false;
  const vFov = THREE.MathUtils.degToRad(camera.fov);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
  const margin = (layout.cell / layout.radius) * 1.3;
  const hLim = hFov / 2 + margin;
  const vLim = vFov / 2 + margin;
  const hoverEase = 1 - Math.exp(-10 * dt);
  const opEase = 1 - Math.exp(-8 * dt);

  for (const card of cards) {
    const du = wrap(card.u + state.cx, layout.totalW);
    const dv = wrap(card.v + state.cy, layout.totalH);
    const th = du / layout.radius, ph = dv / layout.radius;
    const vis = Math.abs(th) < hLim && Math.abs(ph) < vLim;
    card.mesh.visible = vis;
    if (!vis) {
      if (hovered === card) hovered = null;
      continue;
    }
    const r = layout.radius - card.pop;
    const cp = Math.cos(ph), sp = Math.sin(ph);
    const ct = Math.cos(th), st = Math.sin(th);
    card.mesh.position.set(r * st * cp, r * sp, -r * ct * cp);
    card.mesh.lookAt(ORIGIN);

    const hoverTarget = card === hovered ? 1 : 0;
    card.hoverT += (hoverTarget - card.hoverT) * hoverEase;
    if (Math.abs(hoverTarget - card.hoverT) > 0.002) needsMoreFrames = true;
    card.mesh.scale.setScalar(1 + 0.045 * card.hoverT);

    let opacityTarget = card.filtered ? 0.08 : 1;
    if (sel && card !== sel) opacityTarget *= gal.others;
    card.op += (opacityTarget - card.op) * opEase;
    if (Math.abs(opacityTarget - card.op) > 0.002) needsMoreFrames = true;
    card.mesh.material.opacity = card.op * gal.fade;
  }
  return needsMoreFrames;
}

function updateHover(now, sceneMoving) {
  if (!mouseHas || ui.locked || drag.active) {
    if (!hovered) return false;
    hovered = null;
    canvas.style.cursor = ui.locked ? 'default' : 'grab';
    return true;
  }
  if (!hoverDirty && !sceneMoving) return false;
  if (!hoverDirty && now - lastHoverAt < LOW_POWER.hoverInterval) return false;
  hoverDirty = false;
  lastHoverAt = now;
  const previous = hovered;
  raycaster.setFromCamera(mouse, camera);
  const visMeshes = [];
  for (const c of cards) if (c.mesh.visible) visMeshes.push(c.mesh);
  const hits = raycaster.intersectObjects(visMeshes, false);
  hovered = hits.length ? hits[0].object.userData.card : null;
  canvas.style.cursor = hovered ? 'pointer' : 'grab';
  return previous !== hovered;
}

function hasGsapWork() {
  // The root timeline has no parent, so gsap.globalTimeline.isActive() is ALWAYS
  // true - using it here kept the render loop re-queuing forever, so the sphere
  // never idled. Instead ask whether any tween/timeline is still pending: the root
  // auto-removes finished children, so a non-empty child list means an animation
  // is genuinely in flight (this also covers a tween still in its start delay).
  const tl = gsap.globalTimeline;
  if (!tl) return false;
  const kids = tl.getChildren(true, true, true);
  if (!kids.length) return false;
  // The slideshow/tour dwell timer is a long-lived (often endless) tween whose
  // onUpdate only advances a DOM progress ring - it never touches the WebGL
  // scene. Exclude it, else it would keep the sphere painting forever behind the
  // opaque detail/cinema page during a slideshow (playing OR paused).
  const idleTimer = slideshow && slideshow.tween;
  return idleTimer ? kids.some(t => t !== idleTimer) : true;
}

function introDriftActive(now) {
  return introDone && !interacted && now < introDriftUntil && !ui.locked;
}

// The sphere's own physics have settled: no residual spin velocity, no gap
// between target and current position, and the zoom has reached its target.
// (Deliberately ignores drag/lock/drift, which are input state, not motion.)
function sphereAtRest() {
  return Math.abs(state.vx) <= LOW_POWER.idleVelocity
    && Math.abs(state.vy) <= LOW_POWER.idleVelocity
    && Math.abs(state.tx - state.cx) <= LOW_POWER.idlePosition
    && Math.abs(state.ty - state.cy) <= LOW_POWER.idlePosition
    && Math.abs(zoomState.target - zoomState.current) <= 0.01;
}

function galleryMoving(now = performance.now()) {
  return drag.active || ui.locked || introDriftActive(now) || !sphereAtRest();
}

function queueRenderFrame() {
  if (renderLoopRunning) return;
  renderLoopRunning = true;
  requestAnimationFrame(renderFrame);
}

/* True while a full-screen, opaque page (detail, room, albums, people, atlas,
   recap, flat view, admin, cinema, or the black auth screen) sits on top of the
   sphere. Those pages hide the sphere completely, so there is no reason to keep
   drawing it - the render loop below stops until the page closes and the sphere
   is the visible view again. Only one view ever paints at a time.
   NOTE: the landing / hub / invite entry screens are deliberately NOT listed -
   they use a translucent backdrop, so the drifting sphere behind them is meant
   to stay visible and animating. */
function overlayCoveringSphere() {
  return roomOpen || adminOpen || recapOpen || flatOpen || peopleOpen || atlasOpen || albumsOpen
    || !authEl.hidden
    || (detail && detail.style.display === 'block')
    || (cinema && cinema.isOpen());
}

function renderFrame(now = performance.now()) {
  renderLoopRunning = false;
  if (document.hidden) {
    clock.getDelta();
    return;
  }
  if (LOW_POWER.activeFps <= 0) { clock.getDelta(); return; }  // user paused rendering (0 fps)
  // A page is covering the sphere - let that page own the GPU and idle here. We
  // keep painting through the open/close slide (hasGsapWork) and while the sphere
  // still has momentum to bleed off (sphereAtRest) so the reveal is smooth and
  // never lurches, then fully stop once the page has settled on top.
  if (overlayCoveringSphere() && !hasGsapWork() && sphereAtRest()) { clock.getDelta(); return; }

  // computed once per frame and reused below: hasGsapWork() walks the gsap
  // timeline, and nothing between here and the re-queue creates or kills a tween.
  const gsapWork = hasGsapWork();
  const active = sceneDirty || cardsAnimating || galleryMoving(now) || gsapWork;
  const minFrameMs = 1000 / LOW_POWER.activeFps;
  if (active && lastFrameAt && now - lastFrameAt < minFrameMs) {
    queueRenderFrame();
    return;
  }
  lastFrameAt = now;

  syncSize();
  const dt = Math.min(clock.getDelta(), 0.05);

  if (!drag.active && !ui.locked) {
    state.tx += state.vx * dt;
    state.ty += state.vy * dt;
    const d = Math.exp(-2.4 * dt);
    state.vx *= d; state.vy *= d;
    if (Math.abs(state.vx) < 0.002) state.vx = 0;
    if (Math.abs(state.vy) < 0.002) state.vy = 0;
  }

  // gentle drift before the first interaction
  if (introDriftActive(now)) state.tx += 0.45 * dt;

  const f = 1 - Math.exp(-(drag.active ? 12 : 6.5) * dt);
  state.cx += (state.tx - state.cx) * f;
  state.cy += (state.ty - state.cy) * f;

  // smooth zoom (paused while the detail page owns the camera)
  if (!ui.locked) {
    const fz = 1 - Math.exp(-8 * dt);
    zoomState.current += (zoomState.target - zoomState.current) * fz;
    if (Math.abs(zoomState.current - camera.fov) > 0.001) {
      camera.fov = zoomState.current;
      camera.updateProjectionMatrix();
    }
  }

  const movingNow = galleryMoving(now) || gsapWork;
  const needsCardFrames = updateCards(dt);
  const hoverChanged = updateHover(now, movingNow);
  renderer.render(scene, camera);
  sceneDirty = false;
  cardsAnimating = needsCardFrames || hoverChanged;
  if (sceneDirty || cardsAnimating || galleryMoving(now) || gsapWork) queueRenderFrame();
}

document.addEventListener('visibilitychange', () => {
  clock.getDelta();
  if (!document.hidden) markSceneDirty();
});

/* ============================================================
   INPUT - drag with momentum, wheel, click vs drag
   ============================================================ */
const drag = { active: false, id: null, px: 0, py: 0, t: 0, lastT: 0, moved: 0 };

canvas.addEventListener('pointerdown', (e) => {
  if (ui.locked) return;
  interacted = true;
  drag.active = true;
  drag.id = e.pointerId;
  canvas.setPointerCapture(e.pointerId);
  drag.px = e.clientX; drag.py = e.clientY;
  drag.t = drag.lastT = performance.now();
  drag.moved = 0;
  state.vx = state.vy = 0;
  canvas.classList.add('dragging');
  markHoverDirty();
});

canvas.addEventListener('pointermove', (e) => {
  const rect = canvas.getBoundingClientRect();
  mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  mouseHas = true;
  markHoverDirty();
  if (!drag.active || e.pointerId !== drag.id) return;
  const now = performance.now();
  const dtm = Math.max((now - drag.lastT) / 1000, 0.001);
  drag.lastT = now;
  const dx = e.clientX - drag.px;
  const dy = e.clientY - drag.py;
  drag.px = e.clientX; drag.py = e.clientY;
  drag.moved += Math.abs(dx) + Math.abs(dy);
  const { wx, wy } = worldPerPx();
  const dwx = dx * wx;
  const dwy = -dy * wy;
  state.tx += dwx;
  state.ty += dwy;
  state.vx = state.vx * 0.7 + (dwx / dtm) * 0.3;
  state.vy = state.vy * 0.7 + (dwy / dtm) * 0.3;
  markSceneDirty();
});

canvas.addEventListener('pointerleave', () => {
  mouseHas = false;
  if (hovered) {
    hovered = null;
    markSceneDirty();
  }
});

function endDrag(e) {
  if (!drag.active || e.pointerId !== drag.id) return;
  drag.active = false;
  canvas.classList.remove('dragging');
  try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
  const held = performance.now() - drag.t;
  if (drag.moved < 7 && held < 450) {
    state.vx = state.vy = 0;
    tryClick();
  } else {
    const MAXV = 90;
    state.vx = THREE.MathUtils.clamp(state.vx, -MAXV, MAXV);
    state.vy = THREE.MathUtils.clamp(state.vy, -MAXV, MAXV);
  }
  markSceneDirty();
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

/* scroll wheel = zoom in/out (smoothly lerped FOV) */
const zoomState = { target: FOV, current: FOV };
window.addEventListener('wheel', (e) => {
  if (ui.locked || overlayOpen() || shortcutsOpen()) return;
  interacted = true;
  zoomState.target = THREE.MathUtils.clamp(zoomState.target + e.deltaY * 0.022, 26, 62);
  markSceneDirty();
}, { passive: true });

function tryClick() {
  raycaster.setFromCamera(mouse, camera);
  const visMeshes = [];
  for (const c of cards) if (c.mesh.visible) visMeshes.push(c.mesh);
  const hits = raycaster.intersectObjects(visMeshes, false);
  if (hits.length) openProject(hits[0].object.userData.card);
}

/* ============================================================
   DETAIL PAGE
   ============================================================ */
const detail = document.getElementById('detail');
const dEls = {
  title: document.getElementById('d-title-inner'),
  clientTop: document.getElementById('d-client-top'),
  client: document.getElementById('d-client'),
  year: document.getElementById('d-year'),
  tags: document.getElementById('d-tags'),
  placeRow: document.getElementById('d-place-row'),
  place: document.getElementById('d-place'),
  img: document.getElementById('d-img'),
  p1: document.getElementById('d-p1'),
  p2: document.getElementById('d-p2'),
};

function fillDetail(p) {
  dEls.title.textContent = p.title;
  dEls.client.textContent = p.community ? '@' + p.username : p.client;
  dEls.year.textContent = p.year;
  dEls.tags.textContent = [p.cat, ...p.tags].join(' / ');
  const place = (p.place || '').trim();
  dEls.placeRow.hidden = !place;
  dEls.place.innerHTML = '';
  if (place) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'place-chip';
    chip.innerHTML = `<span class="place-pin" aria-hidden="true">&#9678;</span>${esc(place)}`;
    chip.title = 'Find memories from ' + place;
    chip.addEventListener('click', () => { closeProject(); openFlatSearch(place); });
    dEls.place.appendChild(chip);
  }
  dEls.img.src = p.heroSrc || p.src || '';
  resetDetailZoom();
  detailProject = p;
  const canManage = canManageProject(p);
  document.getElementById('d-owner').hidden = !canManage;
  const pinBtn = document.getElementById('d-pin-btn');
  const canPin = !!(p.community && me && (isCommunityAdmin() || isAdminProfile()));
  pinBtn.hidden = !canPin;
  pinBtn.textContent = p.pinned ? 'UNPIN PHOTO' : 'PIN PHOTO';
  const spotBtn = document.getElementById('d-spotlight-btn');
  const isSpotlight = !!(currentCommunity && p.postId && currentCommunity.spotlightPostId === p.postId);
  spotBtn.hidden = !canPin;
  spotBtn.textContent = isSpotlight ? 'UNFEATURE' : 'FEATURE THIS PHOTO';
  document.getElementById('d-edit-form').hidden = true;
  const navHidden = pool.length <= 1;
  document.getElementById('d-prev').hidden = navHidden;
  document.getElementById('d-next').hidden = navHidden;
  updateSlideAvailability();
  if (p.community) {
    dEls.clientTop.textContent = `@${p.username} - VIEW PROFILE ↗`;
    dEls.clientTop.style.textDecoration = 'underline';
    dEls.clientTop.onclick = () => { closeProject(); openPeople(p.username); };
    dEls.p1.textContent = p.caption || `"${p.title}" was posted to the wall by @${p.username} in ${p.year}. Every photo here belongs to someone - tap their name above to see who they are and what else they've shared.`;
    dEls.p2.textContent = `Posted by @${p.username}. Want your own photos up here? Hit the + button in the bottom-left corner of the wall and post whatever you want. The sphere has room for everyone.`;
  } else {
    dEls.clientTop.textContent = `${p.client} - ${p.year}`;
    dEls.clientTop.style.textDecoration = 'none';
    dEls.clientTop.onclick = null;
    dEls.p1.textContent = `${p.title} is a ${p.cat.toLowerCase()}-led collaboration with ${p.client}, built to translate the brand's ambition into a living, breathing digital artefact. We prototyped early, tested often, and let the craft carry the idea from first sketch to final ship.`;
    dEls.p2.textContent = `Spanning ${[p.cat, ...p.tags].join(', ').toLowerCase()}, the work reached audiences across every touchpoint that matters. The result: a piece of the internet people actually remember - measured not just in numbers, but in the messages that landed in our inbox the week it launched.`;
  }
  clearReply();   // a pending reply belongs to the photo we just left
  renderSocial(p);
  // keep the fullscreen cinema image in sync when it is open (stepPhoto /
  // slideshow both funnel through fillDetail). cinema is assigned during
  // module init, well before any user action can call fillDetail.
  if (cinema) cinema.refresh();
  // keep the tour narration in step with whatever photo just loaded.
  if (tourActive) updateTourCaption();
}

let detailFromOverlay = false;

/* open the detail page for a project object directly (from an overlay:
   album page, flat grid, deep link) - no sphere camera move */
function openDetailFor(project, updateHash = true) {
  if (!project) return;
  if (updateHash && project.postId) setRoute(photoRoute(project.postId));
  detailFromOverlay = true;
  document.getElementById('back-btn').textContent = '←  BACK';
  fillDetail(project);
  showDetail();
}

/* step to the previous (-1) or next (+1) photo in the pool, wrapping around */
function stepPhoto(dir) {
  if (!detailProject || !detailProject.postId) return;
  const idx = pool.findIndex((p) => p.postId === detailProject.postId);
  if (idx < 0) return;
  const n = pool.length;
  if (n <= 1) return;
  const target = pool[((idx + dir) % n + n) % n];
  if (!target) return;
  // if opened by zooming a sphere card, release the sphere now so closing
  // later does not leave the gallery frozen / zoomed in.
  if (!detailFromOverlay && sel) {
    gsap.to(gal, { others: 1, duration: 0.6 });
    gsap.set(sel, { pop: 0 });
    gsap.to(camera, {
      fov: zoomState.target, duration: 0.6, ease: 'power3.inOut',
      onUpdate: () => camera.updateProjectionMatrix(),
      onComplete: () => { zoomState.current = camera.fov; },
    });
    sel = null;
    ui.locked = false;
    canvas.style.cursor = 'grab';
    markSceneDirty();
  }
  openDetailFor(target);
}
document.getElementById('d-prev').addEventListener('click', () => stepPhoto(-1));
document.getElementById('d-next').addEventListener('click', () => stepPhoto(1));

/* ============================================================
   SLIDESHOW - hands-free auto-tour of the pool on the detail page.
   Reuses stepPhoto(1) (which already wraps) driven by a GSAP tween of
   an SVG progress ring; on each full ring it advances one photo.
   ============================================================ */
const slideBtn = document.getElementById('d-play');
const slidePrArc = slideBtn ? slideBtn.querySelector('.pr-arc') : null;
const slideLabel = slideBtn ? slideBtn.querySelector('.play-label') : null;
const slideGlyph = slideBtn ? slideBtn.querySelector('.play-glyph') : null;
const GLYPH_PLAY = '▶';    // right-pointing triangle
const GLYPH_PAUSE = '‖';   // double vertical bar (pause)
const SLIDE_ARC_LEN = 62.83;   // 2*pi*r (r=10), must match the CSS stroke-dasharray
const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
// per-photo dwell time; persisted like the render settings
let slideIntervalMs = (() => {
  const saved = parseInt(localStorage.getItem('pg_slide_ms'), 10);
  return Number.isFinite(saved) && saved >= 2000 && saved <= 15000 ? saved : 4000;
})();
const slideshow = { playing: false, tween: null, paused: false };

/* set the visible fill of the ring (0..1) without any animation */
function setSlideRing(frac) {
  if (!slidePrArc) return;
  slidePrArc.style.strokeDashoffset = String(SLIDE_ARC_LEN * (1 - Math.max(0, Math.min(1, frac))));
}

/* run one dwell tween; on completion advance to the next photo and repeat */
function slideTick() {
  if (!slideshow.playing) return;
  if (slidePrArc) gsap.killTweensOf(slidePrArc);
  const prog = { v: 0 };
  // reduced-motion: keep the ring static (no sweeping arc) but still use the
  // tween purely as the dwell timer that advances photos.
  setSlideRing(reduceMotion ? 1 : 0);
  slideshow.tween = gsap.to(prog, {
    v: 1,
    duration: slideIntervalMs / 1000,
    ease: 'none',
    onUpdate: reduceMotion ? undefined : () => setSlideRing(prog.v),
    onComplete: () => {
      if (!slideshow.playing) return;
      stepPhoto(1);          // wraps automatically; new photo re-renders the detail page
      slideTick();           // queue the next dwell
    },
  });
}

function startSlideshow() {
  if (slideshow.playing) return;
  if (detail.style.display !== 'block') return;
  if (pool.length <= 1) { toast('NOTHING TO PLAY YET'); return; }
  slideshow.playing = true;
  slideshow.paused = false;
  if (slideBtn) {
    slideBtn.classList.add('playing');
    slideBtn.setAttribute('aria-pressed', 'true');
    slideBtn.title = 'Pause slideshow';
  }
  if (slideLabel) slideLabel.textContent = 'PAUSE';
  if (slideGlyph) slideGlyph.textContent = GLYPH_PAUSE;
  toast('SLIDESHOW ON');
  slideTick();
}

function stopSlideshow() {
  if (!slideshow.playing && !slideshow.tween) return;
  slideshow.playing = false;
  slideshow.paused = false;
  if (slideshow.tween) { slideshow.tween.kill(); slideshow.tween = null; }
  if (slidePrArc) gsap.killTweensOf(slidePrArc);
  setSlideRing(0);
  if (slideBtn) {
    slideBtn.classList.remove('playing');
    slideBtn.setAttribute('aria-pressed', 'false');
    slideBtn.title = 'Play slideshow';
  }
  if (slideLabel) slideLabel.textContent = 'PLAY';
  if (slideGlyph) slideGlyph.textContent = GLYPH_PLAY;
  // a definitive stop ends any running tour and drops back to normal pool order.
  stopTour();
}

/* temporary pause (hover / zoom / comment focus) - keeps playing state so it
   auto-resumes; freezes the ring where it is. */
function pauseSlideshow() {
  if (!slideshow.playing || slideshow.paused) return;
  slideshow.paused = true;
  if (slideshow.tween) slideshow.tween.pause();
}
function resumeSlideshow() {
  if (!slideshow.playing || !slideshow.paused) return;
  // do not resume while any auto-pause condition still holds
  if (detailZoom.scale > 1.001) return;
  if (document.activeElement === dCommentInput) return;
  slideshow.paused = false;
  if (slideshow.tween) slideshow.tween.play();
}

function toggleSlideshow() {
  if (slideshow.playing) stopSlideshow(); else startSlideshow();
}

if (slideBtn) slideBtn.addEventListener('click', toggleSlideshow);

/* ============================================================
   CINEMA MODE - immersive fullscreen viewing layered on the detail
   hero. The controller is pure UI; PREV/NEXT/PLAY delegate straight
   back to stepPhoto()/toggleSlideshow() so navigation and slideshow
   keep working while the overlay is up. cinema.refresh() is called
   from fillDetail() so stepPhoto()/slideshow advance the big image too.
   ============================================================ */
const cinema = initCinema({
  getProject: () => detailProject,
  step: (dir) => stepPhoto(dir),
  isPlaying: () => slideshow.playing,
  togglePlay: toggleSlideshow,
  // shared with updateSlideAvailability() so cinema's PLAY control matches the
  // detail row's #d-play, which is hidden for private / single-photo views.
  isPlayable: slideshowUsable,
});
const cinemaBtn = document.getElementById('d-cinema');
if (cinemaBtn && cinema) {
  cinemaBtn.addEventListener('click', () => {
    if (!detailProject) return;
    cinema.open();
  });
}
// NOTE: the pointerenter/pointerleave pause hooks live in the zoom section
// below, where dHero is defined (avoids a temporal-dead-zone reference here).

/* the slideshow only works for a community pool holding more than one photo.
   shared by updateSlideAvailability() (detail row #d-play) and cinema's PLAY
   control so both surfaces show/hide the control under the same condition. */
function slideshowUsable() {
  return pool.length > 1 && !!detailProject && !!detailProject.community;
}

/* show/hide the play control alongside PREV/NEXT. only useful with >1 photo,
   and it lives in the social row so it must share that row's visibility. */
function updateSlideAvailability() {
  if (!slideBtn) return;
  const usable = slideshowUsable();
  slideBtn.hidden = !usable;
  if (!usable && slideshow.playing) stopSlideshow();
}

/* ============================================================
   SPHERE TOUR - one tap turns the community into a curated, narrated
   auto-cinema of its most loved photos. It composes existing primitives
   only: it re-ranks the live pool by love score, opens the top photo,
   lifts into Cinema mode, and hands the wheel to the slideshow. Exiting
   Cinema / the detail page (Escape / close) restores the normal pool.
   ============================================================ */
const tourChip = document.getElementById('tour-chip');
const tourCaption = document.getElementById('tour-caption');
// while active, holds the pool order we replaced so it can be restored on exit.
let tourActive = false;
let tourSavedPool = null;

/* love score for one project, mirroring loveScore() in lib/helpers.js:
   hearts (likes) + every other reaction + comments. */
function projectLoveScore(p) {
  const likes = Array.isArray(p.likes) ? p.likes.length : 0;
  const comments = Array.isArray(p.comments) ? p.comments.length : 0;
  let reactions = 0;
  if (p.reactions && typeof p.reactions === 'object') {
    Object.values(p.reactions).forEach(list => { if (Array.isArray(list)) reactions += list.length; });
  }
  return likes + reactions + comments;
}

/* rank a copy of the current pool by love score, newest-first as the tie-break
   and fallback (matches the recap's ordering). returns a fresh array. */
function buildTour() {
  return pool
    .map(p => ({ p, score: projectLoveScore(p) }))
    .sort((a, b) => b.score - a.score || (b.p.created || 0) - (a.p.created || 0))
    .map(({ p }) => p);
}

/* refresh the narration caption for the photo now on screen. plain text only,
   set via textContent so nothing user-typed needs escaping. */
function updateTourCaption() {
  if (!tourCaption) return;
  if (!tourActive || !detailProject) { tourCaption.hidden = true; return; }
  const idx = pool.findIndex(p => p.postId === detailProject.postId);
  const score = projectLoveScore(detailProject);
  const pos = idx >= 0 ? `${idx + 1} OF ${pool.length}` : '';
  const love = `${score} LOVE`;
  tourCaption.textContent = ['MOST LOVED', pos, love].filter(Boolean).join('  ·  ');
  tourCaption.hidden = false;
}

function startSphereTour() {
  if (tourActive) return;
  if (!currentCommunity) { toast('OPEN A COMMUNITY FIRST'); return; }
  if (pool.length < 2) { toast('NOT ENOUGH PHOTOS TO TOUR YET'); return; }
  const ranked = buildTour();
  if (!ranked.length) return;
  // swap the live pool for the ranked order; stepPhoto / slideshow iterate the
  // pool, so this is all it takes to drive them in love-score order. the saved
  // reference is restored verbatim on stopTour() (nothing rebuilds pool mid-tour).
  tourSavedPool = pool;
  pool = ranked;
  tourActive = true;
  openDetailFor(ranked[0]);
  updateTourCaption();
  // lift into Cinema for the full-screen feel, then let the slideshow drive.
  if (cinema) cinema.open();
  if (!slideshow.playing) startSlideshow();
  // a subtle rise-in on the narration caption (skipped for reduced motion).
  if (tourCaption && !reduceMotion) {
    gsap.fromTo(tourCaption, { opacity: 0, y: 10 },
      { opacity: 1, y: 0, duration: 0.5, ease: 'power2.out' });
  }
  toast('SPHERE TOUR');
}

/* end the tour and put the normal pool order back. safe to call unconditionally
   from the shared exit paths (closeProject / lifecycle resets). */
function stopTour() {
  if (!tourActive) return;
  tourActive = false;
  if (tourSavedPool) { pool = tourSavedPool; tourSavedPool = null; }
  if (tourCaption) {
    gsap.set(tourCaption, { clearProps: 'opacity,transform' });
    tourCaption.hidden = true; tourCaption.textContent = '';
  }
}

if (tourChip) tourChip.addEventListener('click', startSphereTour);

/* ============================================================
   SURPRISE ME - one tap spins the sphere to a random photo and pops it.
   Pure composition of existing primitives: it picks a random project from
   the live pool (preferring one other than the photo already open) and hands
   off to focusCardOnSphere(), which closes any overlay, spins the sphere and
   pulses the card. Zero new backend surface; cannot break existing flows.
   ============================================================ */
const surpriseChip = document.getElementById('surprise-chip');

function surpriseMe() {
  if (!currentCommunity) { toast('OPEN A COMMUNITY FIRST'); return; }
  if (pool.length < 1) { toast('NO PHOTOS TO SURPRISE YET'); return; }
  // avoid landing on the photo already open when there is another to choose.
  const openId = (detail.style.display === 'block' && detailProject) ? detailProject.postId : null;
  let choices = pool;
  if (openId && pool.length > 1) choices = pool.filter(p => p.postId !== openId);
  const pick = choices[Math.floor(Math.random() * choices.length)];
  if (!pick || !pick.postId) return;
  focusCardOnSphere(pick.postId);
  toast('A RANDOM MEMORY');
}

if (surpriseChip) surpriseChip.addEventListener('click', surpriseMe);

/* ============================================================
   DETAIL IMAGE ZOOM + PAN (desktop wheel/drag/dblclick + touch pinch)
   ============================================================ */
const dHero = document.querySelector('.d-hero');
const ZOOM_MIN = 1, ZOOM_MAX = 4, ZOOM_DBL = 2.5;
const detailZoom = { scale: 1, x: 0, y: 0 };

/* clamp the translation so the image can never be dragged fully out of the
   frame. at scale s the image is (s-1)x larger than the frame in each axis,
   so translation is allowed within +/- half of that overflow. */
function clampDetailZoom() {
  const s = detailZoom.scale;
  if (s <= 1) { detailZoom.x = 0; detailZoom.y = 0; return; }
  const rect = dHero.getBoundingClientRect();
  const maxX = rect.width * (s - 1) / 2;
  const maxY = rect.height * (s - 1) / 2;
  detailZoom.x = Math.max(-maxX, Math.min(maxX, detailZoom.x));
  detailZoom.y = Math.max(-maxY, Math.min(maxY, detailZoom.y));
}

function applyDetailZoom() {
  clampDetailZoom();
  const { scale, x, y } = detailZoom;
  // transform-origin is the image center (which sits at the frame center), so
  // x/y is a pure pixel pan measured from that center.
  dEls.img.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
  const zoomed = scale > 1.001;
  dHero.classList.toggle('zoomed', zoomed);
  if (!zoomed) dHero.classList.remove('grabbing');
  // studying a zoomed photo should not get yanked to the next one
  if (zoomed) pauseSlideshow(); else resumeSlideshow();
}

/* reset to identity - called on every photo open / navigation / close so a
   new photo never inherits a stuck zoom. */
function resetDetailZoom() {
  detailZoom.scale = 1; detailZoom.x = 0; detailZoom.y = 0;
  dEls.img.style.transform = '';
  dHero.classList.remove('zoomed', 'grabbing');
}

/* zoom toward a point (px,py measured from the frame's top-left corner) by
   keeping that point visually fixed as the scale changes. */
function zoomAtPoint(px, py, nextScale) {
  const rect = dHero.getBoundingClientRect();
  const prev = detailZoom.scale;
  nextScale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, nextScale));
  if (nextScale === prev) return;
  const cx = rect.width / 2, cy = rect.height / 2;
  // point relative to frame center, in pre-transform image space
  const ix = (px - cx - detailZoom.x) / prev;
  const iy = (py - cy - detailZoom.y) / prev;
  detailZoom.scale = nextScale;
  detailZoom.x = px - cx - ix * nextScale;
  detailZoom.y = py - cy - iy * nextScale;
  applyDetailZoom();
}

dHero.addEventListener('wheel', (e) => {
  if (detail.style.display !== 'block') return;
  const rect = dHero.getBoundingClientRect();
  // at rest (scale 1) an upward scroll starts a zoom; otherwise let the page
  // scroll through normally so reading below the image still works.
  if (detailZoom.scale <= 1 && e.deltaY >= 0) return;
  e.preventDefault();
  const factor = Math.exp(-e.deltaY * 0.0015);
  zoomAtPoint(e.clientX - rect.left, e.clientY - rect.top, detailZoom.scale * factor);
}, { passive: false });

dHero.addEventListener('dblclick', (e) => {
  if (detail.style.display !== 'block') return;
  e.preventDefault();
  const rect = dHero.getBoundingClientRect();
  if (detailZoom.scale > 1.001) resetDetailZoom();
  else zoomAtPoint(e.clientX - rect.left, e.clientY - rect.top, ZOOM_DBL);
}, { passive: false });

/* pointer-based drag-to-pan + two-finger pinch */
const activePointers = new Map();
let dragLast = null, pinchStart = null;

dHero.addEventListener('pointerdown', (e) => {
  if (detail.style.display !== 'block') return;
  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (activePointers.size === 2) {
    const pts = [...activePointers.values()];
    pinchStart = {
      dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y),
      scale: detailZoom.scale,
    };
    dragLast = null;
    return;
  }
  if (detailZoom.scale > 1) {
    dragLast = { x: e.clientX, y: e.clientY };
    dHero.classList.add('grabbing');
    dHero.setPointerCapture(e.pointerId);
    e.preventDefault();
  }
});

dHero.addEventListener('pointermove', (e) => {
  if (!activePointers.has(e.pointerId)) return;
  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (pinchStart && activePointers.size >= 2) {
    const pts = [...activePointers.values()];
    const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    if (pinchStart.dist > 0) {
      const rect = dHero.getBoundingClientRect();
      const mx = (pts[0].x + pts[1].x) / 2 - rect.left;
      const my = (pts[0].y + pts[1].y) / 2 - rect.top;
      zoomAtPoint(mx, my, pinchStart.scale * (dist / pinchStart.dist));
    }
    e.preventDefault();
    return;
  }

  if (dragLast) {
    detailZoom.x += e.clientX - dragLast.x;
    detailZoom.y += e.clientY - dragLast.y;
    dragLast = { x: e.clientX, y: e.clientY };
    applyDetailZoom();
    e.preventDefault();
  }
});

function endPointer(e) {
  const wasPinching = !!pinchStart;
  activePointers.delete(e.pointerId);
  if (activePointers.size < 2) pinchStart = null;
  // pinch just dropped to one finger while still zoomed: hand off to a drag so
  // panning continues seamlessly without a lift-and-retouch.
  if (wasPinching && activePointers.size === 1 && detailZoom.scale > 1) {
    const [p] = activePointers.values();
    dragLast = { x: p.x, y: p.y };
    dHero.classList.add('grabbing');
  }
  if (activePointers.size === 0) { dragLast = null; dHero.classList.remove('grabbing'); }
  if (dHero.hasPointerCapture && dHero.hasPointerCapture(e.pointerId)) {
    dHero.releasePointerCapture(e.pointerId);
  }
}
dHero.addEventListener('pointerup', endPointer);
dHero.addEventListener('pointercancel', endPointer);

// slideshow: pause while the pointer rests on the image (reading a photo),
// resume on leave. defined here because dHero exists in this section.
dHero.addEventListener('pointerenter', pauseSlideshow);
dHero.addEventListener('pointerleave', resumeSlideshow);

// keep the pan clamped correctly if the window is resized while zoomed
window.addEventListener('resize', () => {
  if (detail.style.display === 'block' && detailZoom.scale > 1) applyDetailZoom();
});

function openProject(card) {
  if (ui.locked) return;
  ui.locked = true;
  sel = card;
  hovered = null;
  cardsAnimating = true;
  markSceneDirty();
  state.vx = state.vy = 0;
  canvas.style.cursor = 'default';
  detailFromOverlay = false;
  document.getElementById('back-btn').textContent = '←  BACK TO GALLERY';
  const project = pool[card.pIdx];
  if (project && project.postId) setRoute(photoRoute(project.postId));
  fillDetail(project);

  // recenter the gallery on the chosen card (smoothed by the lerp)
  state.tx = nearestEquiv(-card.u, state.cx, layout.totalW);
  state.ty = nearestEquiv(-card.v, state.cy, layout.totalH);

  const tl = gsap.timeline();
  tl.to(gal, { others: 0, duration: 0.7, ease: 'power2.out' }, 0);
  tl.to(camera, {
    fov: 34, duration: 0.95, ease: 'power3.inOut',
    onUpdate: () => camera.updateProjectionMatrix(),
  }, 0);
  tl.to(card, { pop: 14, duration: 0.95, ease: 'power3.inOut' }, 0.05);
  tl.add(showDetail, 0.45);
}

function showDetail() {
  detail.style.display = 'block';
  detail.setAttribute('aria-hidden', 'false');
  // during a slideshow advance the panel is already open: skip the full slide-up
  // intro and just crossfade the new photo/text in (or hard-cut for reduced motion).
  if (slideshow && slideshow.playing) {
    if (reduceMotion) {
      gsap.set('.d-hero, #d-title, .d-meta, .d-cols', { clearProps: 'opacity,transform,clipPath' });
    } else {
      gsap.fromTo('.d-hero, #d-title, .d-meta, .d-cols',
        { opacity: 0 }, { opacity: 1, duration: 0.5, ease: 'power2.out' });
    }
    return;
  }
  detail.scrollTop = 0;
  gsap.fromTo(detail, { yPercent: 100, y: 0 }, { yPercent: 0, y: 0, duration: 0.85, ease: 'power4.inOut' });
  gsap.fromTo('#d-title span', { yPercent: 110 }, { yPercent: 0, duration: 0.9, delay: 0.45, ease: 'power3.out' });
  gsap.fromTo('.d-meta, .d-cols', { opacity: 0, y: 30 }, { opacity: 1, y: 0, duration: 0.8, delay: 0.6, stagger: 0.1, ease: 'power2.out' });
  gsap.fromTo('.d-hero', { clipPath: 'inset(100% 0 0 0)' }, { clipPath: 'inset(0% 0 0 0)', duration: 1, delay: 0.55, ease: 'power3.inOut' });
}

function closeProject() {
  if (detail.style.display !== 'block') return;
  closeReactionRoster();   // don't leave a reactor popover hanging over the sphere
  if (cinema && cinema.isOpen()) cinema.close();
  stopSlideshow();
  stopTour();          // restore the normal pool order if a tour was running
  resetDetailZoom();
  cardsAnimating = true;
  markSceneDirty();
  if (detailProject && detailProject.postId) clearRouteIf(photoRoute(detailProject.postId));
  detail.setAttribute('aria-hidden', 'true');
  gsap.to(detail, {
    yPercent: 100, duration: 0.7, ease: 'power3.inOut',
    onComplete: () => { detail.style.display = 'none'; },
  });
  // opened from an overlay (album / flat grid / deep link): no sphere restore
  if (detailFromOverlay || !sel) {
    detailFromOverlay = false;
    if (pendingRebuild) { pendingRebuild = false; rebuildGallery(); }
    return;
  }
  gsap.to(gal, { others: 1, duration: 0.8, delay: 0.2 });
  gsap.to(camera, {
    fov: zoomState.target, duration: 0.9, delay: 0.15, ease: 'power3.inOut',
    onUpdate: () => camera.updateProjectionMatrix(),
  });
  gsap.to(sel, {
    pop: 0, duration: 0.9, delay: 0.15, ease: 'power3.inOut',
    onComplete: () => {
      sel = null; ui.locked = false; canvas.style.cursor = 'grab';
      zoomState.current = camera.fov;
      if (pendingRebuild) { pendingRebuild = false; rebuildGallery(); }
    },
  });
}
let pendingRebuild = false;

/* ============================================================
   FIND ON SPHERE - from any overlay (flat grid, saved tray, album,
   profile, room, notifications, detail page) close everything and
   smoothly spin the sphere so the photo's card sits dead-centre, then
   give it a short "pop" pulse so it is easy to spot. Pure client-side
   navigation - reuses the same wrap()/nearestEquiv() math as dragging
   so the sphere always takes the short way around.
   ============================================================ */
function pulseCard(card) {
  if (!card) return;
  gsap.killTweensOf(card, 'pop');
  const t = gsap.timeline();
  t.to(card, { pop: 9, duration: reduceMotion ? 0 : 0.35, ease: 'power2.out', onUpdate: markSceneDirty });
  t.to(card, { pop: 0, duration: reduceMotion ? 0 : 0.7, ease: 'power2.inOut', onUpdate: markSceneDirty }, reduceMotion ? 0 : '+=0.12');
}

/* the live sphere card for a post (or null), plus the "can we spin to it?" test.
   used by every "find on sphere" affordance so they all agree. */
function cardForPost(postId) {
  if (!postId) return null;
  return cards.find(c => pool[c.pIdx] && pool[c.pIdx].postId === postId) || null;
}
function postOnSphere(postId) { return !!cardForPost(postId); }

/* the overlay pin markup + its wiring, shared by flat cards and room tiles.
   glyph is a literal so nothing user-typed touches innerHTML. */
const LOCATE_PIN_HTML = '<span class="locate-pin" role="button" tabindex="0" title="Find on sphere" aria-label="Find on sphere">&#9678;</span>';
function wireLocatePin(container, postId) {
  const pin = container.querySelector('.locate-pin');
  if (!pin) return;
  const go = (e) => { e.stopPropagation(); e.preventDefault(); focusCardOnSphere(postId); };
  pin.addEventListener('click', go);
  pin.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') go(e); });
}

function focusCardOnSphere(postId) {
  if (!postId) return;
  // no sphere to spin (no photos, or gallery not built yet): just open the photo.
  const card = cardForPost(postId);
  if (!card || !cards.length) {
    const p = pool.find(x => x.postId === postId);
    if (p) openDetailFor(p);
    return;
  }

  // close every overlay that might be covering the sphere.
  if (detail.style.display === 'block') closeProject();
  if (flatOpen) closeFlatView();
  if (albumsOpen) closeAlbums();
  if (peopleOpen) closePeople();
  if (atlasOpen) closeAtlas();
  if (roomOpen) closeCommunityRoom();
  if (adminOpen) closeAdminPanel();
  if (recapOpen) closeRecap();
  if (panelOpen) hideFilterPanel();
  if (notifOpen) closeNotifPanel();
  hideEntryScreens();

  // if the card is filtered out, clear the tag filter so it is fully visible.
  if (card.filtered && activeTags.size) {
    activeTags.clear();
    fpTags.querySelectorAll('.fp-tag').forEach(b => b.classList.remove('active'));
    applyFilter();
  }

  interacted = true;              // stop the intro drift from fighting the spin
  state.vx = state.vy = 0;
  const nx = nearestEquiv(-card.u, state.tx, layout.totalW);
  const ny = nearestEquiv(-card.v, state.ty, layout.totalH);
  if (reduceMotion) {
    state.tx = state.cx = nx;
    state.ty = state.cy = ny;
    markSceneDirty();
    pulseCard(card);
  } else {
    gsap.killTweensOf(state, 'tx,ty');
    gsap.to(state, {
      tx: nx, ty: ny, duration: 1.05, ease: 'power3.inOut',
      onUpdate: markSceneDirty,
      onComplete: () => pulseCard(card),
    });
  }
  markSceneDirty();
  toast('FOUND ON SPHERE');
}

/* ---- scope chips (shared by upload + edit forms) ---- */
const SCOPES = ['WEBSITE', '3D', 'AI', 'CAMPAIGN', 'FILM', 'TOOL', 'SOCIAL', 'CONTENT', 'EVENT', 'GAME', 'AR', 'MOTION', 'OOH', 'ILLUSTRATION', 'PHYSICAL', 'PHOTO'];
function buildScopeChips(container, selected = []) {
  container.innerHTML = '';
  const active = new Set(selected.filter(t => SCOPES.includes(t)));
  SCOPES.forEach(t => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'scope-chip' + (active.has(t) ? ' active' : '');
    b.textContent = t;
    b.addEventListener('click', () => {
      if (active.has(t)) { active.delete(t); b.classList.remove('active'); }
      else if (active.size < 3) { active.add(t); b.classList.add('active'); }
    });
    container.appendChild(b);
  });
  return () => [...active];
}

/* ---- own-photo edit + delete (detail page) ---- */
let detailProject = null;
let getDetailScopes = () => [];
const dEditForm = document.getElementById('d-edit-form');
const dOwner = document.getElementById('d-owner');

document.getElementById('d-edit-btn').addEventListener('click', () => {
  const p = detailProject;
  if (!p) return;
  document.getElementById('de-title').value = p.title;
  document.getElementById('de-client').value = p.client.startsWith('@') ? '' : p.client;
  document.getElementById('de-year').value = p.year;
  document.getElementById('de-place').value = p.place || '';
  resetEditPlace(p.place || '', geoOf(p));   // seed geo from THIS photo so a prior pick can't leak in
  document.getElementById('de-caption').value = p.caption || '';
  document.getElementById('de-err').textContent = '';
  getDetailScopes = buildScopeChips(document.getElementById('de-scopes'), p.tags);
  dEditForm.hidden = false;
  dOwner.hidden = true;
});
document.getElementById('de-cancel').addEventListener('click', () => {
  dEditForm.hidden = true;
  dOwner.hidden = false;
});

dEditForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const p = detailProject;
  if (!p) return;
  try {
    const updated = await api.call('PUT', '/api/photos/' + p.postId, {
      title: document.getElementById('de-title').value.trim(),
      client: document.getElementById('de-client').value.trim(),
      year: document.getElementById('de-year').value,
      place: document.getElementById('de-place').value.trim(),
      ...(editGeo || { lat: null, lng: null, country: '', state: '' }),
      caption: document.getElementById('de-caption').value.trim(),
      tags: getDetailScopes(),
    });
    const i = communityPosts.findIndex(x => x.id === updated.id);
    if (i >= 0) communityPosts[i] = updated;
    fillDetail(postToProject(updated));
    pendingRebuild = true;          // card texture refreshes once the page closes
    toast('PHOTO UPDATED');
  } catch (err) {
    document.getElementById('de-err').textContent = String(err.message || 'COULD NOT SAVE').toUpperCase();
  }
});

document.getElementById('d-delete-btn').addEventListener('click', async () => {
  const p = detailProject;
  if (!p) return;
  if (!confirm('Delete this photo from the gallery? This cannot be undone.')) return;
  try {
    await api.call('DELETE', '/api/photos/' + p.postId);
    communityPosts = communityPosts.filter(x => x.id !== p.postId);
    pendingRebuild = true;
    toast('PHOTO DELETED');
    closeProject();
  } catch (err) {
    toast(String(err.message || 'COULD NOT DELETE').toUpperCase());
  }
});

document.getElementById('d-pin-btn').addEventListener('click', async () => {
  const p = detailProject;
  if (!p || !currentCommunity) return;
  try {
    const method = p.pinned ? 'DELETE' : 'POST';
    currentCommunity = await api.call(method, `/api/communities/${encodeURIComponent(currentCommunity.id)}/pins/${encodeURIComponent(p.postId)}`);
    const post = communityPosts.find(x => x.id === p.postId);
    if (post) post.pinned = !p.pinned;
    p.pinned = !p.pinned;
    fillDetail(p);
    await rebuildGallery();
    toast(p.pinned ? 'PHOTO PINNED' : 'PHOTO UNPINNED');
  } catch (err) {
    toast(String(err.message || 'COULD NOT UPDATE PIN').toUpperCase());
  }
});

/* feature (spotlight) the current detail photo, or unfeature it if it already
   is the community's spotlight. Updates currentCommunity from the response so
   the room + detail label stay in sync, then refreshes the open room. */
async function toggleSpotlight(postId) {
  if (!postId || !currentCommunity) return;
  const wasSpotlight = currentCommunity.spotlightPostId === postId;
  try {
    const method = wasSpotlight ? 'DELETE' : 'POST';
    currentCommunity = await api.call(method, `/api/communities/${encodeURIComponent(currentCommunity.id)}/spotlight/${encodeURIComponent(postId)}`);
    if (detailProject && detailProject.postId === postId) fillDetail(detailProject);
    if (roomOpen) renderCommunityRoom();
    toast(wasSpotlight ? 'SPOTLIGHT CLEARED' : 'PHOTO FEATURED');
  } catch (err) {
    toast(String(err.message || 'COULD NOT UPDATE SPOTLIGHT').toUpperCase());
  }
}

document.getElementById('d-spotlight-btn').addEventListener('click', () => {
  if (detailProject) toggleSpotlight(detailProject.postId);
});

document.getElementById('room-spotlight-clear').addEventListener('click', () => {
  if (currentCommunity && currentCommunity.spotlightPostId) toggleSpotlight(currentCommunity.spotlightPostId);
});

document.getElementById('back-btn').addEventListener('click', closeProject);

/* ---- reactions & comments (detail page) ---- */
const dSocial = document.getElementById('d-social');
const dLikeBtn = document.getElementById('d-like');
const dSaveBtn = document.getElementById('d-save');
const dSaveLabel = dSaveBtn ? dSaveBtn.querySelector('.save-label') : null;
const dSaveGlyph = dSaveBtn ? dSaveBtn.querySelector('.bookmark') : null;
const dLikeCount = document.getElementById('d-like-count');
const dReactionsEl = document.getElementById('d-reactions');
const dCommentCount = document.getElementById('d-comment-count');
/* fixed reaction set: keys match the server allow-list, glyphs are the only
   thing rendered. 'heart' stays the legacy like (rendered via #d-like), so the
   bar shows the other four. all glyphs are literals - no user text, no XSS. */
const EMOJI = { heart: '♥', laugh: '😂', wow: '😮', sad: '😢', fire: '🔥' };
const REACTION_KEYS = ['laugh', 'wow', 'sad', 'fire'];
const dLikersEl = document.getElementById('d-likers');
const dCommentsEl = document.getElementById('d-comments');
const dCommentForm = document.getElementById('d-comment-form');
const dCommentInput = document.getElementById('d-comment-input');
const dReplyTarget = document.getElementById('d-reply-target');
// which top-level comment id (if any) the next post replies to; '' means none
let replyTo = '';

let userMeta = {};
async function ensureUserMeta(force) {
  if (!force && Object.keys(userMeta).length) return;
  try {
    const list = await api.call('GET', '/api/users');
    userMeta = {};
    list.forEach(u => { userMeta[u.username] = u; });
  } catch {}
}
function syncPostSocial(p) {
  const cp = communityPosts.find(x => x.id === p.postId);
  if (cp) { cp.likes = p.likes; cp.reactions = p.reactions; cp.comments = p.comments; }
}
/* returns true when a username is a real member we can link to a profile */
function isKnownMember(name) {
  return !!(userMeta[name] || (me && me.username === name));
}
/* fill an element with comment text, turning @username tokens for real
   members into clickable profile links. all text goes in as text nodes
   (or esc'd token spans) so there is zero XSS surface. */
function linkifyComment(el, text) {
  el.textContent = '';
  const re = /@([a-z0-9_]{3,20})/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    const name = m[1].toLowerCase();
    if (!isKnownMember(name)) continue;   // leave unknown @tokens as plain text
    if (m.index > last) el.appendChild(document.createTextNode(text.slice(last, m.index)));
    const span = document.createElement('button');
    span.type = 'button';
    span.className = 'mention';
    span.textContent = '@' + name;
    span.addEventListener('click', () => { closeProject(); openPeople(name); });
    el.appendChild(span);
    last = m.index + m[0].length;
  }
  if (last < text.length) el.appendChild(document.createTextNode(text.slice(last)));
}
/* reflect whether the open photo is in the caller's private saved tray */
function renderSaveState(p) {
  if (!dSaveBtn) return;
  const show = !!(p && p.community && me && p.postId);
  dSaveBtn.hidden = !show;
  if (!show) return;
  const saved = savedIds.has(p.postId);
  dSaveBtn.classList.toggle('saved', saved);
  dSaveBtn.setAttribute('aria-pressed', saved ? 'true' : 'false');
  if (dSaveLabel) dSaveLabel.textContent = saved ? 'SAVED' : 'SAVE';
  if (dSaveGlyph) dSaveGlyph.innerHTML = saved ? '&#9733;' : '&#9734;';   // filled vs outline star
}
/* the compact reaction bar: one chip per extra emoji (laugh/wow/sad/fire).
   each chip shows the emoji + its count, highlights when the current user
   picked it, and toggles on click. counts are numbers and glyphs come from
   the fixed EMOJI map, so nothing user-typed touches innerHTML. a chip with
   reactors also grows a tiny caret that opens a roster popover (see below) so
   you can see WHO reacted without blocking the primary toggle click. */
function renderReactions(p) {
  if (!dReactionsEl) return;
  const reactions = (p.reactions && typeof p.reactions === 'object') ? p.reactions : {};
  closeReactionRoster();   // any old popover belongs to the previous render
  dReactionsEl.innerHTML = '';
  dReactionsEl.hidden = !me;
  if (!me) return;
  REACTION_KEYS.forEach(key => {
    const users = Array.isArray(reactions[key]) ? reactions[key] : [];
    const mine = users.includes(me.username);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'reaction' + (mine ? ' on' : '');
    btn.setAttribute('aria-pressed', mine ? 'true' : 'false');
    btn.title = key.toUpperCase();
    btn.innerHTML = `<span class="r-emoji">${EMOJI[key]}</span>` +
      (users.length ? `<span class="r-count">${users.length}</span>` : '');
    btn.addEventListener('click', () => toggleReaction(p, key));
    dReactionsEl.appendChild(btn);
    // secondary affordance: reveals the roster of reactors. kept separate from
    // the chip so the primary click always toggles and reacting is never blocked.
    if (users.length) {
      const info = document.createElement('button');
      info.type = 'button';
      info.className = 'reaction-who';
      info.setAttribute('aria-label', `See who reacted ${EMOJI[key]}`);
      info.setAttribute('aria-expanded', 'false');
      info.title = 'Who reacted';
      info.innerHTML = '<span class="rw-caret" aria-hidden="true">&#9662;</span>';
      info.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleReactionRoster(p, key, info);
      });
      dReactionsEl.appendChild(info);
    }
  });
}
/* the reaction roster popover: shows every reactor for one emoji (avatar +
   display name + @username), each row jumping to that person's profile via the
   same likerJump() the likers stack uses. only one popover is open at a time;
   it closes on outside pointerdown, Escape, and whenever the reactions re-render
   (fillDetail / renderSocial / a toggle). names run through esc(); glyphs come
   from the fixed EMOJI map, so nothing user-typed touches innerHTML raw. */
let reactionRoster = null;   // { el, key, anchor } | null
function closeReactionRoster() {
  if (!reactionRoster) return;
  const { el, anchor } = reactionRoster;
  if (anchor) anchor.setAttribute('aria-expanded', 'false');
  if (el && el.parentNode) el.parentNode.removeChild(el);
  document.removeEventListener('pointerdown', onReactionRosterPointer, true);
  document.removeEventListener('keydown', onReactionRosterKey, true);
  reactionRoster = null;
}
function onReactionRosterPointer(e) {
  if (!reactionRoster) return;
  const { el, anchor } = reactionRoster;
  if (el.contains(e.target) || (anchor && anchor.contains(e.target))) return;
  closeReactionRoster();
}
function onReactionRosterKey(e) {
  if (e.key === 'Escape') closeReactionRoster();
}
function toggleReactionRoster(p, key, anchor) {
  // clicking the caret of an already-open roster closes it
  if (reactionRoster && reactionRoster.key === key) { closeReactionRoster(); return; }
  closeReactionRoster();
  const reactions = (p.reactions && typeof p.reactions === 'object') ? p.reactions : {};
  const users = Array.isArray(reactions[key]) ? reactions[key] : [];
  if (!users.length) return;
  const el = document.createElement('div');
  el.className = 'reaction-roster';
  el.setAttribute('role', 'menu');
  const head = document.createElement('div');
  head.className = 'rr-head mono dim';
  head.innerHTML = `<span class="rr-emoji">${EMOJI[key]}</span>` +
    `<span>${users.length} REACTED</span>`;
  el.appendChild(head);
  const list = document.createElement('div');
  list.className = 'rr-list';
  users.forEach(name => {
    const meta = userMeta[name] || { username: name };
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'rr-row';
    b.setAttribute('role', 'menuitem');
    b.innerHTML =
      `<span class="avatar sm">${avatarInner(meta)}</span>` +
      `<span class="rr-name">${esc(meta.displayName || name)}</span>` +
      `<span class="mono dim rr-user">@${esc(name)}</span>`;
    b.addEventListener('click', () => { closeReactionRoster(); likerJump(name); });
    list.appendChild(b);
  });
  el.appendChild(list);
  // anchor under the caret, clamped inside the reaction bar so it never clips off
  dReactionsEl.appendChild(el);
  const barRect = dReactionsEl.getBoundingClientRect();
  const anchorRect = anchor.getBoundingClientRect();
  let left = anchorRect.left - barRect.left;
  const maxLeft = Math.max(0, dReactionsEl.clientWidth - el.offsetWidth);
  if (left > maxLeft) left = maxLeft;
  if (left < 0) left = 0;
  el.style.left = left + 'px';
  anchor.setAttribute('aria-expanded', 'true');
  reactionRoster = { el, key, anchor };
  document.addEventListener('pointerdown', onReactionRosterPointer, true);
  document.addEventListener('keydown', onReactionRosterKey, true);
}
async function toggleReaction(p, emoji) {
  if (!p || !me || !REACTION_KEYS.includes(emoji)) return;
  try {
    const r = await api.call('POST', `/api/photos/${p.postId}/react`, { emoji });
    // trust the server's returned maps so counts stay exact
    p.reactions = (r.reactions && typeof r.reactions === 'object') ? r.reactions : {};
    if (Array.isArray(r.likes)) p.likes = r.likes;
    syncPostSocial(p);
    renderSocial(p);
  } catch (e) { toast(String(e.message || 'COULD NOT REACT').toUpperCase()); }
}
function renderSocial(p) {
  if (!p || !p.community) { dSocial.hidden = true; return; }
  dSocial.hidden = false;
  renderSaveState(p);
  // "FIND ON SPHERE" only makes sense when this photo has a live card to spin to.
  const locateBtn = document.getElementById('d-locate');
  if (locateBtn) locateBtn.hidden = !postOnSphere(p.postId);
  const liked = !!(me && p.likes.includes(me.username));
  dLikeBtn.classList.toggle('liked', liked);
  dLikeCount.textContent = p.likes.length;
  renderReactions(p);
  const n = p.comments.length;
  dCommentCount.textContent = `${n} COMMENT${n === 1 ? '' : 'S'}`;
  renderLikers(p);
  dCommentsEl.innerHTML = '';
  // build one comment row (avatar, name, like, delete, linkified text). `reply`
  // flags a child so it renders indented; top-level rows also get a REPLY button.
  const byCreated = (a, b) => a.created - b.created;
  const buildRow = (c, reply) => {
    const meta = userMeta[c.username] || { username: c.username, displayName: c.username };
    const canDel = me && (me.username === c.username || me.username === p.username || isAdminProfile() || isCommunityAdmin());
    const canEdit = !!(me && me.username === c.username);   // author-only, no moderation edit
    const cLikes = Array.isArray(c.likes) ? c.likes : [];
    const cLiked = !!(me && cLikes.includes(me.username));
    const row = document.createElement('div');
    row.className = 'comment' + (reply ? ' reply' : '');
    row.innerHTML =
      `<span class="avatar sm">${avatarInner(meta)}</span>` +
      `<div class="c-body"><div class="c-head">` +
      `<button class="c-name">${esc(meta.displayName || c.username)}</button>` +
      `<span class="mono dim c-time">@${esc(c.username)} · ${timeAgo(c.created)}` +
        (c.edited ? `<span class="c-edited"> · (edited)</span>` : '') +
      `</span>` +
      (canEdit ? `<button class="mono dim c-edit" type="button" title="Edit comment">EDIT</button>` : '') +
      (me ? `<button class="c-like${cLiked ? ' on' : ''}" title="Like comment" aria-pressed="${cLiked ? 'true' : 'false'}">` +
        `<span class="heart">${cLiked ? '♥' : '♡'}</span>` +
        (cLikes.length ? `<span class="c-like-count">${cLikes.length}</span>` : '') +
        `</button>` : '') +
      (canDel ? `<button class="c-del" title="Delete comment">✕</button>` : '') +
      `</div><div class="c-text"></div>` +
      (me && !reply ? `<button class="mono dim c-reply" type="button">REPLY</button>` : '') +
      `</div>`;
    linkifyComment(row.querySelector('.c-text'), c.text);
    row.querySelector('.c-name').addEventListener('click', () => { closeProject(); openPeople(c.username); });
    if (me) row.querySelector('.c-like').addEventListener('click', () => likeComment(p, c));
    if (canDel) row.querySelector('.c-del').addEventListener('click', () => deleteComment(p, c.id));
    if (canEdit) row.querySelector('.c-edit').addEventListener('click', () => editComment(p, c, row));
    const replyBtn = row.querySelector('.c-reply');
    if (replyBtn) replyBtn.addEventListener('click', () => startReply(c.username, c.id));
    return row;
  };
  // two-level tree: each top-level comment, then its direct replies indented
  const tops = p.comments.filter(c => !c.parentId).sort(byCreated);
  tops.forEach(c => {
    dCommentsEl.appendChild(buildRow(c, false));
    p.comments.filter(r => r.parentId === c.id).sort(byCreated)
      .forEach(r => dCommentsEl.appendChild(buildRow(r, true)));
  });
  // if the roster has not loaded yet (e.g. deep-link open), pull it so liker
  // + comment display names/avatars fill in, then re-render if still on this
  // post. an in-flight flag stops overlapping refetches, and we only re-render
  // when the roster actually filled in, so an empty/failed /api/users response
  // does not recurse and hammer the endpoint forever.
  if (!Object.keys(userMeta).length && (p.likes.length || p.comments.length) && !renderSocial._roster) {
    renderSocial._roster = true;
    ensureUserMeta().finally(() => {
      renderSocial._roster = false;
      if (detailProject === p && Object.keys(userMeta).length) renderSocial(p);
    });
  }
}
/* who liked this photo: overlapping avatar stack + "LIKED BY @a, @b +N",
   every avatar/name a button that opens that person's profile. clicking the
   summary expands a full clickable list. names come from p.likes (usernames);
   userMeta gives us display names + avatars (fetched for comments already). */
const MAX_LIKER_AVATARS = 5;
function likerJump(name) { closeProject(); openPeople(name); }
function renderLikers(p) {
  const likes = Array.isArray(p.likes) ? p.likes : [];
  if (!likes.length) { dLikersEl.hidden = true; dLikersEl.innerHTML = ''; return; }
  dLikersEl.hidden = false;
  dLikersEl.classList.remove('expanded');
  dLikersEl.innerHTML = '';

  const stack = document.createElement('div');
  stack.className = 'likers-stack';
  likes.slice(0, MAX_LIKER_AVATARS).forEach((name, i) => {
    const meta = userMeta[name] || { username: name };
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'likers-av';
    b.style.zIndex = String(MAX_LIKER_AVATARS - i);
    b.title = '@' + name;
    b.innerHTML = `<span class="avatar sm">${avatarInner(meta)}</span>`;
    b.addEventListener('click', () => likerJump(name));
    stack.appendChild(b);
  });
  dLikersEl.appendChild(stack);

  // summary line: "LIKED BY @a, @b +N" - names are buttons, extras toggle the list
  const summary = document.createElement('div');
  summary.className = 'likers-summary mono dim';
  const label = document.createElement('span');
  label.className = 'likers-label';
  label.textContent = 'LIKED BY ';
  summary.appendChild(label);
  const named = likes.slice(0, 2);
  named.forEach((name, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'likers-name';
    b.textContent = '@' + name;
    b.addEventListener('click', () => likerJump(name));
    summary.appendChild(b);
    if (i < named.length - 1 && likes.length > 1) summary.appendChild(document.createTextNode(', '));
  });
  const extra = likes.length - named.length;
  if (extra > 0) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'likers-more';
    more.textContent = ` +${extra}`;
    more.addEventListener('click', () => dLikersEl.classList.toggle('expanded'));
    summary.appendChild(more);
  }
  dLikersEl.appendChild(summary);

  // full clickable list, revealed when .expanded is set
  const full = document.createElement('div');
  full.className = 'likers-list';
  likes.forEach(name => {
    const meta = userMeta[name] || { username: name };
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'likers-row';
    b.innerHTML =
      `<span class="avatar sm">${avatarInner(meta)}</span>` +
      `<span class="lr-name">${esc(meta.displayName || name)}</span>` +
      `<span class="mono dim lr-user">@${esc(name)}</span>`;
    b.addEventListener('click', () => likerJump(name));
    full.appendChild(b);
  });
  dLikersEl.appendChild(full);
}
async function deleteComment(p, cid) {
  try {
    await api.call('DELETE', `/api/photos/${p.postId}/comments/${cid}`);
    // mirror the server cascade: deleting a top-level comment also drops its replies
    p.comments = p.comments.filter(c => c.id !== cid && c.parentId !== cid);
    syncPostSocial(p);
    renderSocial(p);
  } catch (e) { toast(String(e.message || 'COULD NOT DELETE').toUpperCase()); }
}
/* author-only in-place edit: swap the comment's text line for a tiny textarea
   with SAVE + CANCEL. SAVE PUTs the new text, updates the local comment (text +
   edited stamp) and re-renders; CANCEL just re-renders the row as it was. */
function editComment(p, c, row) {
  if (!me || me.username !== c.username) return;
  const textEl = row.querySelector('.c-text');
  if (!textEl || row.querySelector('.c-edit-form')) return;   // one editor at a time
  const form = document.createElement('form');
  form.className = 'c-edit-form';
  const ta = document.createElement('textarea');
  ta.maxLength = 500;
  ta.rows = 2;
  ta.value = c.text;
  const actions = document.createElement('div');
  actions.className = 'c-edit-actions';
  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'mono c-edit-save';
  save.textContent = 'SAVE';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'mono dim c-edit-cancel';
  cancel.textContent = 'CANCEL';
  actions.appendChild(save);
  actions.appendChild(cancel);
  form.appendChild(ta);
  form.appendChild(actions);
  textEl.replaceWith(form);
  ta.focus();
  const pos = ta.value.length;
  ta.setSelectionRange(pos, pos);
  cancel.addEventListener('click', () => renderSocial(p));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = ta.value.trim();
    if (!text) { toast('WRITE SOMETHING FIRST'); return; }
    if (text === c.text) { renderSocial(p); return; }   // no-op edit, skip the round trip
    save.disabled = true;
    try {
      const updated = await api.call('PUT', `/api/photos/${p.postId}/comments/${c.id}`, { text });
      c.text = updated.text;
      c.edited = updated.edited;
      syncPostSocial(p);
      renderSocial(p);
      toast('COMMENT UPDATED');
    } catch (err) {
      save.disabled = false;
      toast(String(err.message || 'COULD NOT EDIT').toUpperCase());
    }
  });
}
/* toggle a heart on one comment: optimistic flip of c.likes, same pattern as
   the photo like button, then re-render so the count + fill update. */
async function likeComment(p, c) {
  if (!p || !me || !c) return;
  if (!Array.isArray(c.likes)) c.likes = [];
  const i = c.likes.indexOf(me.username);
  if (i >= 0) c.likes.splice(i, 1); else c.likes.push(me.username);
  syncPostSocial(p);
  renderSocial(p);
  try {
    const r = await api.call('POST', `/api/photos/${p.postId}/comments/${c.id}/like`);
    // reconcile with the server's truth in case of a race
    const has = c.likes.includes(me.username);
    if (r.liked && !has) c.likes.push(me.username);
    else if (!r.liked && has) c.likes.splice(c.likes.indexOf(me.username), 1);
    syncPostSocial(p);
    renderSocial(p);
  } catch (e) {
    // revert on failure
    const has = c.likes.includes(me.username);
    if (has) c.likes.splice(c.likes.indexOf(me.username), 1); else c.likes.push(me.username);
    syncPostSocial(p);
    renderSocial(p);
    toast(String(e.message || 'COULD NOT LIKE').toUpperCase());
  }
}
dLikeBtn.addEventListener('click', async () => {
  const p = detailProject;
  if (!p || !me) return;
  try {
    const r = await api.call('POST', `/api/photos/${p.postId}/like`);
    const i = p.likes.indexOf(me.username);
    if (r.liked && i < 0) p.likes.push(me.username);
    else if (!r.liked && i >= 0) p.likes.splice(i, 1);
    syncPostSocial(p);
    renderSocial(p);
  } catch (e) { toast(String(e.message || 'COULD NOT LIKE').toUpperCase()); }
});
if (dSaveBtn) dSaveBtn.addEventListener('click', async () => {
  const p = detailProject;
  if (!p || !p.postId || !me) return;
  const wasSaved = savedIds.has(p.postId);
  // optimistic flip, same pattern as the like button
  if (wasSaved) savedIds.delete(p.postId); else savedIds.add(p.postId);
  renderSaveState(p);
  try {
    const r = await api.call(wasSaved ? 'DELETE' : 'POST', `/api/photos/${p.postId}/save`);
    if (r.saved) savedIds.add(p.postId); else savedIds.delete(p.postId);
    renderSaveState(p);
    toast(r.saved ? 'SAVED TO COLLECTION' : 'REMOVED FROM SAVED');
    if (flatOpen && flatSavedOnly) renderFlatView();   // keep the SAVED grid live
  } catch (e) {
    // revert on failure
    if (wasSaved) savedIds.add(p.postId); else savedIds.delete(p.postId);
    renderSaveState(p);
    toast(String(e.message || 'COULD NOT SAVE').toUpperCase());
  }
});
/* start replying to a top-level comment: remember its id, show the chip,
   prefill "@user " in the input and focus it so the thread stays readable. */
function startReply(username, cid) {
  if (!me) return;
  replyTo = cid;
  dReplyTarget.hidden = false;
  dReplyTarget.textContent = '';
  dReplyTarget.appendChild(document.createTextNode('Replying to @' + username + ' '));
  const x = document.createElement('span');
  x.className = 'rc-x';
  x.textContent = '✕';
  dReplyTarget.appendChild(x);
  const tag = '@' + username + ' ';
  if (!dCommentInput.value.trim()) dCommentInput.value = tag;
  dCommentInput.focus();
  const pos = dCommentInput.value.length;
  dCommentInput.setSelectionRange(pos, pos);
}
/* cancel a pending reply and hide the chip (does not clear typed text) */
function clearReply() {
  replyTo = '';
  dReplyTarget.hidden = true;
  dReplyTarget.textContent = '';
}
if (dReplyTarget) dReplyTarget.addEventListener('click', clearReply);

dCommentForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const p = detailProject;
  const text = dCommentInput.value.trim();
  if (!p || !text) return;
  // only reply when the target is still a top-level comment on this post
  const parentId = (replyTo && p.comments.some(c => c.id === replyTo && !c.parentId)) ? replyTo : '';
  try {
    const c = await api.call('POST', `/api/photos/${p.postId}/comments`, parentId ? { text, parentId } : { text });
    p.comments.push(c);
    dCommentInput.value = '';
    clearReply();
    hideMentionMenu();
    if (me && !userMeta[me.username]) userMeta[me.username] = me;
    syncPostSocial(p);
    renderSocial(p);
  } catch (e) { toast(String(e.message || 'COULD NOT POST').toUpperCase()); }
});

/* ---- @mention autocomplete (comment input) ---- */
const mentionMenu = document.createElement('div');
mentionMenu.className = 'mention-menu';
mentionMenu.hidden = true;
dCommentForm.appendChild(mentionMenu);
let mentionMatches = [];
let mentionActive = -1;
let mentionStart = -1;   // index of the '@' being completed

function mentionCandidates() {
  // members from the already-fetched roster, plus me (may not be in userMeta yet)
  const map = {};
  Object.values(userMeta).forEach(u => { if (u && u.username) map[u.username] = u; });
  if (me && me.username) map[me.username] = map[me.username] || me;
  return Object.values(map);
}
function hideMentionMenu() {
  if (mentionMenu.hidden) return;
  mentionMenu.hidden = true;
  mentionMenu.innerHTML = '';
  mentionMatches = [];
  mentionActive = -1;
  mentionStart = -1;
}
function renderMentionMenu() {
  mentionMenu.innerHTML = '';
  mentionMatches.forEach((u, i) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'mention-item' + (i === mentionActive ? ' active' : '');
    item.innerHTML =
      `<span class="avatar sm">${avatarInner(u)}</span>` +
      `<span class="mm-body"><span class="mm-name">${esc(u.displayName || u.username)}</span>` +
      `<span class="mono dim mm-user">@${esc(u.username)}</span></span>`;
    // mousedown (not click) so it fires before the input blurs
    item.addEventListener('mousedown', (e) => { e.preventDefault(); pickMention(i); });
    mentionMenu.appendChild(item);
  });
  mentionMenu.hidden = mentionMatches.length === 0;
}
function pickMention(i) {
  const u = mentionMatches[i];
  if (!u || mentionStart < 0) { hideMentionMenu(); return; }
  const val = dCommentInput.value;
  const caret = dCommentInput.selectionStart;
  const before = val.slice(0, mentionStart);
  const after = val.slice(caret);
  const insert = '@' + u.username + ' ';
  dCommentInput.value = before + insert + after;
  const pos = before.length + insert.length;
  dCommentInput.setSelectionRange(pos, pos);
  hideMentionMenu();
  dCommentInput.focus();
}
function updateMentionMenu() {
  const val = dCommentInput.value;
  const caret = dCommentInput.selectionStart;
  // find a trailing "@partial" ending at the caret (partial may be empty)
  const upto = val.slice(0, caret);
  const m = /(^|[^a-z0-9_@])@([a-z0-9_]{0,20})$/i.exec(upto);
  if (!m) { hideMentionMenu(); return; }
  mentionStart = caret - m[2].length - 1;   // position of the '@'
  const q = m[2].toLowerCase();
  mentionMatches = mentionCandidates()
    .filter(u => u.username.includes(q) || (u.displayName || '').toLowerCase().includes(q))
    .sort((a, b) => a.username.localeCompare(b.username))
    .slice(0, 6);
  mentionActive = mentionMatches.length ? 0 : -1;
  renderMentionMenu();
}
dCommentInput.addEventListener('input', updateMentionMenu);
dCommentInput.addEventListener('keydown', (e) => {
  if (mentionMenu.hidden) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); mentionActive = (mentionActive + 1) % mentionMatches.length; renderMentionMenu(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); mentionActive = (mentionActive - 1 + mentionMatches.length) % mentionMatches.length; renderMentionMenu(); }
  else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickMention(mentionActive < 0 ? 0 : mentionActive); }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); hideMentionMenu(); }
});
dCommentInput.addEventListener('blur', () => setTimeout(hideMentionMenu, 120));
// pause the slideshow while someone is writing a comment; resume when they leave
dCommentInput.addEventListener('focus', pauseSlideshow);
dCommentInput.addEventListener('blur', resumeSlideshow);

/* ============================================================
   KEYBOARD SHORTCUTS OVERLAY - a discoverable cheat sheet for the
   power-user keys (arrows / P / F / T / Esc). Press "?" to toggle it.
   Purely additive: a hidden dialog plus focus management, nothing else.
   ============================================================ */
const shortcutsOverlay = document.getElementById('shortcuts-overlay');
const shortcutsClose = document.getElementById('shortcuts-close');
let shortcutsPrevFocus = null;
function shortcutsOpen() { return shortcutsOverlay && !shortcutsOverlay.hidden; }
function openShortcuts() {
  if (!shortcutsOverlay || shortcutsOpen()) return;
  shortcutsPrevFocus = document.activeElement;
  shortcutsOverlay.hidden = false;
  if (shortcutsClose) shortcutsClose.focus();
}
function closeShortcuts() {
  if (!shortcutsOpen()) return;
  shortcutsOverlay.hidden = true;
  if (shortcutsPrevFocus && typeof shortcutsPrevFocus.focus === 'function') shortcutsPrevFocus.focus();
  shortcutsPrevFocus = null;
}
if (shortcutsClose) shortcutsClose.addEventListener('click', closeShortcuts);
if (shortcutsOverlay) shortcutsOverlay.addEventListener('click', (e) => {
  // click on the dim backdrop (not the panel) closes it
  if (e.target === shortcutsOverlay) closeShortcuts();
});

window.addEventListener('keydown', (e) => {
  // shared guard for the detail-page shortcuts (arrows / P / F): they only fire
  // with a photo open, and never while typing in a field or with a modal up.
  const ae = document.activeElement;
  const typing = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA');
  const modalOpen = !uploadModal.hidden || !albumModal.hidden
    || !pickAlbumModal.hidden || !addPhotosModal.hidden;
  const detailKeyOk = detail.style.display === 'block' && !typing && !modalOpen && !shortcutsOpen();
  // "?" toggles the keyboard-shortcuts cheat sheet from anywhere (except while
  // typing). it only listens for an otherwise-unused key, so it is safe to fire
  // globally; Escape (handled below) folds it back before any other handling.
  if (e.key === '?' && !typing) {
    e.preventDefault();
    if (shortcutsOpen()) closeShortcuts(); else openShortcuts();
    return;
  }
  if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && detailKeyOk) {
    e.preventDefault();
    stepPhoto(e.key === 'ArrowLeft' ? -1 : 1);
    return;
  }
  // "P" toggles the slideshow while a photo is open (not while typing / in a modal)
  if ((e.key === 'p' || e.key === 'P') && detailKeyOk) {
    e.preventDefault(); toggleSlideshow(); return;
  }
  // "F" toggles cinema mode while a photo is open (same guard)
  if ((e.key === 'f' || e.key === 'F') && detailKeyOk && cinema && detailProject) {
    e.preventDefault(); cinema.toggle(); return;
  }
  // "T" starts the Sphere Tour from anywhere inside a community. guarded like
  // P/F (never while typing / in a modal) and only when the tour chip is live,
  // which already encodes "community active, enough photos, not entry / mobile".
  if ((e.key === 't' || e.key === 'T') && !typing && !modalOpen && !shortcutsOpen()
      && tourChip && !tourChip.hidden && !tourActive) {
    e.preventDefault(); startSphereTour(); return;
  }
  // "R" surprises with a random photo. guarded exactly like the tour key: never
  // while typing / in a modal, and only when the surprise chip is live (which
  // already encodes "community active, enough photos, not entry / mobile").
  if ((e.key === 'r' || e.key === 'R') && !typing && !modalOpen && !shortcutsOpen()
      && surpriseChip && !surpriseChip.hidden) {
    e.preventDefault(); surpriseMe(); return;
  }
  if (e.key === 'Escape') {
    // the shortcuts cheat sheet sits above everything - fold it first
    if (shortcutsOpen()) { e.preventDefault(); closeShortcuts(); return; }
    // cinema mode sits on top of everything - fold it next
    if (cinema && cinema.isOpen()) { e.preventDefault(); cinema.close(); return; }
    if (!uploadModal.hidden) closeUpload();
    else if (!albumModal.hidden) closeAlbumModal();
    else if (!pickAlbumModal.hidden) closePickAlbum();
    else if (!addPhotosModal.hidden) { closeAddPhotos(); if (viewingAlbum) showAlbum(viewingAlbum.album.id); }
    else if (detail.style.display === 'block' && slideshow.playing) { e.preventDefault(); stopSlideshow(); return; }
    else if (detail.style.display === 'block' && detailZoom.scale > 1.001) { e.preventDefault(); resetDetailZoom(); return; }
    else if (detail.style.display === 'block') closeProject();
    else if (recapOpen) { closeRecap(); clearRouteKind('recap'); }
    else if (atlasOpen) closeAtlas();
    else if (flatOpen) closeFlatView();
    else if (albumsOpen) {
      if (!document.getElementById('album-page').hidden) showAlbumsList();
      else closeAlbums();
    } else if (peopleOpen) {
      if (!profileView.hidden) showPeopleList();
      else closePeople();
    } else if (sel) closeProject();
    hideFilterPanel();
  }
});

/* ============================================================
   FILTER PANEL
   ============================================================ */
const filterBtn = document.getElementById('filter-btn');
const filterPanel = document.getElementById('filter-panel');
const fpTags = document.getElementById('fp-tags');
const activeTags = new Set();
let panelOpen = false;

function buildFilterTags() {
  fpTags.innerHTML = '';
  const counts = new Map();
  pool.forEach(p => [p.cat, ...p.tags].forEach(t => counts.set(t, (counts.get(t) || 0) + 1)));
  [...counts.keys()].sort().forEach(tag => {
    const b = document.createElement('button');
    b.className = 'fp-tag' + (activeTags.has(tag) ? ' active' : '');
    b.textContent = tag;
    b.addEventListener('click', () => {
      b.classList.toggle('active');
      if (activeTags.has(tag)) activeTags.delete(tag); else activeTags.add(tag);
      applyFilter();
    });
    fpTags.appendChild(b);
  });
}

function applyFilter() {
  cards.forEach(c => {
    const p = pool[c.pIdx];
    const all = [p.cat, ...p.tags];
    c.filtered = activeTags.size > 0 && !all.some(t => activeTags.has(t));
  });
  filterBtn.textContent = activeTags.size ? `Filter (${activeTags.size})` : 'Filter';
  cardsAnimating = true;
  markSceneDirty();
}

function showFilterPanel() {
  panelOpen = true;
  filterPanel.hidden = false;
  gsap.fromTo(filterPanel, { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: 0.4, ease: 'power3.out' });
}
function hideFilterPanel() {
  if (!panelOpen) return;
  panelOpen = false;
  gsap.to(filterPanel, { opacity: 0, y: 16, duration: 0.3, ease: 'power2.in', onComplete: () => { filterPanel.hidden = true; } });
}
filterBtn.addEventListener('click', () => (panelOpen ? hideFilterPanel() : showFilterPanel()));
document.getElementById('fp-clear').addEventListener('click', () => {
  activeTags.clear();
  fpTags.querySelectorAll('.fp-tag').forEach(b => b.classList.remove('active'));
  applyFilter();
});

/* ============================================================
   HUD - nav pill, sound, clocks, view toggles
   ============================================================ */
const navBtns = [...document.querySelectorAll('.pill-nav button')];
const pillBg = document.querySelector('.pill-bg');
function movePill(el, instant) {
  gsap.to(pillBg, { x: el.offsetLeft, width: el.offsetWidth, duration: instant ? 0 : 0.5, ease: 'power3.out' });
}
function setNav(view) {
  const target = navBtns.find(b => b.dataset.view === view) || navBtns[0];
  navBtns.forEach(n => n.classList.toggle('active', n === target));
  movePill(target);
}
navBtns.forEach(b => b.addEventListener('click', () => {
  const view = b.dataset.view;
  closeRecap();
  clearRouteKind('recap');
  setNav(view);
  if (view === 'albums') { closeFlatView(); closePeople(); closeAtlas(); openAlbums(); }
  else if (view === 'people') { closeFlatView(); closeAlbums(); closeAtlas(); openPeople(); }
  else if (view === 'atlas') { closeFlatView(); closeAlbums(); closePeople(); openAtlas(); }
  else if (view === 'saved') { closeAlbums(); closePeople(); closeAtlas(); openSaved(); setRoute(communityRoute('saved')); }
  else { closeFlatView(); closeAlbums(); closePeople(); closeAtlas(); }   // gallery
}));

const viewBtns = [document.getElementById('view-grid'), document.getElementById('view-list')];
viewBtns.forEach(b => b.addEventListener('click', () => {
  openFlatView(b.id === 'view-list' ? 'list' : 'grid');
}));

/* sound - click opens a horizontal volume slider; drives an ambient hum */
/* ============================================================
   FLAT GRID / LIST VIEW
   ============================================================ */
const flatEl = document.getElementById('flat-view');
const flatWrap = document.getElementById('flat-grid-wrap');
const flatEmpty = document.getElementById('flat-empty');
const flatGridBtn = document.getElementById('flat-grid');
const flatListBtn = document.getElementById('flat-list');
const flatSearchEl = document.getElementById('fv-search');
const flatSortEl = document.getElementById('fv-sort');
let flatOpen = false;
let flatMode = 'grid';
let flatQuery = '';
let flatSort = 'new';
let flatSavedOnly = false;   // when true, the flat view is the private "SAVED" tray

const flatTitleEl = document.querySelector('#flat-view .people-title');

function filterSortFlat() {
  const q = flatQuery.trim().toLowerCase();
  let list = pool.slice();
  if (flatSavedOnly) list = list.filter(p => p.postId && savedIds.has(p.postId));
  if (q) {
    list = list.filter(p => {
      const tags = Array.isArray(p.tags) ? p.tags.join(' ') : '';
      const hay = `${p.title || ''} ${p.username || ''} ${p.caption || ''} ${tags} ${p.cat || ''} ${p.place || ''}`.toLowerCase();
      return hay.includes(q);
    });
  }
  if (flatSort === 'old') {
    list.sort((a, b) => (a.created || 0) - (b.created || 0));
  } else if (flatSort === 'likes') {
    list.sort((a, b) => (b.likes ? b.likes.length : 0) - (a.likes ? a.likes.length : 0));
  } else if (flatSort === 'comments') {
    list.sort((a, b) => (b.comments ? b.comments.length : 0) - (a.comments ? a.comments.length : 0));
  }
  // 'new' keeps pool order (already pinned-first, newest-first)
  return list;
}

function setFlatMode(mode) {
  flatMode = mode === 'list' ? 'list' : 'grid';
  flatWrap.classList.toggle('list', flatMode === 'list');
  flatGridBtn.classList.toggle('active', flatMode === 'grid');
  flatListBtn.classList.toggle('active', flatMode === 'list');
  viewBtns.forEach(b => b.classList.toggle('active', (flatMode === 'grid' && b.id === 'view-grid') || (flatMode === 'list' && b.id === 'view-list')));
  renderFlatView();
}

function renderFlatView() {
  flatWrap.innerHTML = '';
  const list = filterSortFlat();
  flatEmpty.hidden = list.length > 0;
  if (flatQuery.trim() && (flatSavedOnly ? savedIds.size : pool.length)) {
    flatEmpty.textContent = 'NO PHOTOS MATCH YOUR SEARCH.';
  } else if (flatSavedOnly) {
    flatEmpty.textContent = 'NOTHING SAVED YET. TAP SAVE ON ANY PHOTO TO KEEP IT HERE.';
  } else {
    flatEmpty.textContent = 'NO PHOTOS YET.';
  }
  list.forEach(p => {
    const likes = Array.isArray(p.likes) ? p.likes.length : 0;
    const comments = Array.isArray(p.comments) ? p.comments.length : 0;
    const onSphere = postOnSphere(p.postId);
    const card = document.createElement('button');
    card.className = 'flat-card';
    card.innerHTML =
      `<span class="fc-media">` +
      `<img class="fc-img" src="${esc(p.src || p.heroSrc || '')}" alt="${esc(p.title)}">` +
      (onSphere ? LOCATE_PIN_HTML : '') +
      `</span>` +
      `<span class="fc-body">` +
      `<span class="fc-title">${esc(p.title)}</span>` +
      `<span class="mono dim fc-sub">@${esc(p.username || 'unknown')} <span class="fc-counts"><span>${likes} LIKE${likes === 1 ? '' : 'S'}</span><span>${comments} COMMENT${comments === 1 ? '' : 'S'}</span></span></span>` +
      `</span>`;
    card.addEventListener('click', () => openDetailFor(p));
    wireLocatePin(card, p.postId);
    flatWrap.appendChild(card);
  });
}

function openFlatView(mode = 'grid', saved = false) {
  if (!currentCommunity) { showCommunityHub(); return; }
  closePeople();
  closeAlbums();
  closeAtlas();
  closeRecap();
  flatSavedOnly = !!saved;
  setNav(flatSavedOnly ? 'saved' : 'gallery');
  if (flatTitleEl) flatTitleEl.textContent = flatSavedOnly ? 'SAVED' : 'GALLERY';
  flatEl.classList.toggle('saved-view', flatSavedOnly);
  if (flatSavedOnly && me) refreshSaved().then(() => { if (flatOpen && flatSavedOnly) renderFlatView(); });
  if (!flatOpen) {
    flatOpen = true;
    flatEl.style.display = 'block';
    flatEl.setAttribute('aria-hidden', 'false');
    flatEl.scrollTop = 0;
    gsap.fromTo(flatEl, { yPercent: 100, y: 0 }, { yPercent: 0, y: 0, duration: 0.75, ease: 'power4.inOut' });
  }
  setFlatMode(mode);
}

/* open the private SAVED tray (reuses the flat grid/list renderer) */
function openSaved(mode = 'grid') { openFlatView(mode, true); }

/* open the flat gallery pre-filtered by a search term (used by place chips) */
function openFlatSearch(term) {
  openFlatView('grid', false);
  flatQuery = term || '';
  flatSearchEl.value = flatQuery;
  renderFlatView();
}

function closeFlatView() {
  if (!flatOpen) return;
  markSceneDirty();   // wake the sphere so it paints through the reveal
  flatQuery = '';
  flatSearchEl.value = '';
  flatSavedOnly = false;
  flatEl.classList.remove('saved-view');
  if (flatTitleEl) flatTitleEl.textContent = 'GALLERY';
  flatEl.setAttribute('aria-hidden', 'true');
  gsap.to(flatEl, {
    yPercent: 100, duration: 0.65, ease: 'power3.inOut',
    onComplete: () => { flatEl.style.display = 'none'; flatOpen = false; },
  });
}

document.getElementById('flat-close').addEventListener('click', () => {
  const wasSaved = flatSavedOnly;
  closeFlatView();
  if (wasSaved) { clearRouteKind('saved'); setNav('gallery'); }
});
flatGridBtn.addEventListener('click', () => setFlatMode('grid'));
flatListBtn.addEventListener('click', () => setFlatMode('list'));
flatSearchEl.addEventListener('input', () => { flatQuery = flatSearchEl.value; renderFlatView(); });
flatSortEl.addEventListener('change', () => { flatSort = flatSortEl.value; renderFlatView(); });

const soundWrap = document.getElementById('sound-wrap');
const volumeEl = document.getElementById('volume');
let audioCtx = null;
let gainNode = null;

function ensureAudio() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  // looped brown noise through a low-pass - soft "air" ambience
  const len = audioCtx.sampleRate * 4;
  const buf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) {
    const white = Math.random() * 2 - 1;
    last = (last + 0.02 * white) / 1.02;
    d[i] = last * 3.5;
  }
  const src = audioCtx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  const filter = audioCtx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 420;
  gainNode = audioCtx.createGain();
  gainNode.gain.value = 0;
  src.connect(filter);
  filter.connect(gainNode);
  gainNode.connect(audioCtx.destination);
  src.start();
}

function applyVolume() {
  ensureAudio();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  const v = volumeEl.value / 100;
  gainNode.gain.linearRampToValueAtTime(v * 0.12, audioCtx.currentTime + 0.12);
}

document.getElementById('sound').addEventListener('click', () => {
  const open = soundWrap.classList.toggle('open');
  if (open) applyVolume();
});
volumeEl.addEventListener('input', applyVolume);

/* ============================================================
   LOAD + INTRO
   ============================================================ */
const loaderText = document.getElementById('loader-text');

async function loadPoolImages() {
  const items = pool
    .filter(p => p.src && !p._img)
    .map(p => ({ p, src: p.src }));
  if (items.length === 0) {
    if (loaderText.isConnected) loaderText.textContent = 'LOADING  100%';
    return;
  }
  let loaded = 0;
  let next = 0;
  const workers = Array.from({ length: Math.min(IMAGE_LOAD_CONCURRENCY, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      item.p._img = await loadImage(item.src);
      loaded++;
      if (loaderText.isConnected) {
        loaderText.textContent = `LOADING  ${Math.round((loaded / items.length) * 100)}%`;
      }
    }
  });
  await Promise.all(workers);
}

async function refreshCommunity() {
  if (!currentCommunity) {
    communityPosts = [];
    userMeta = {};
    savedIds = new Set();
    return;
  }
  try { communityPosts = await api.call('GET', '/api/photos'); }
  catch { communityPosts = []; }
  ensureUserMeta(true);   // refresh username -> {displayName, avatar} for comments
  refreshSaved();         // pull this user's private saved tray for the community
}

/* fetch the caller's private saved postIds for the active community */
async function refreshSaved() {
  if (!currentCommunity || !me) { savedIds = new Set(); return; }
  try {
    const r = await api.call('GET', '/api/saved');
    savedIds = new Set(Array.isArray(r.ids) ? r.ids : []);
  } catch { savedIds = new Set(); }
}

/* rebuild the wall in place (after a new photo is posted) */
async function rebuildGallery() {
  buildPool();
  await loadPoolImages();
  disposeGallery();
  buildGallery();
  buildFilterTags();
  applyFilter();
  updateEmptyWall();
  renderMemoryRibbon();
  // refresh the community chips now that the pool is populated: the tour chip's
  // visibility depends on pool.length, and enterCommunity runs its earlier
  // updateCommunityHud() before this rebuild fills the pool.
  updateCommunityHud();
  if (flatOpen) renderFlatView();
}

async function init() {
  // kick off font loading immediately so it overlaps the network + image phase
  const fontsReady = Promise.all([
    document.fonts.load('600 19px Inter'),
    document.fonts.load('italic 900 84px Inter'),
    document.fonts.load('400 12px "Space Mono"'),
    document.fonts.load('700 16px "Space Mono"'),
  ]).catch(() => {});
  await bootstrapSession();
  buildPool();
  await loadPoolImages();
  await fontsReady;

  buildGallery();
  buildFilterTags();
  movePill(document.querySelector('.pill-nav .active'), true);
  updateEmptyWall();

  gsap.to('#loader', {
    autoAlpha: 0, duration: 0.6, delay: 0.2,
    onComplete: () => { document.getElementById('loader').remove(); },
  });

  // intro - tiles fly in from depth while the view sweeps to rest
  state.cx = state.tx = layout.cell * 2.0;
  state.cy = state.ty = -layout.cell * 0.7;
  state.tx = 0; state.ty = 0;
  gsap.to(gal, { fade: 1, duration: 1.0, ease: 'power1.out', delay: 0.15 });
  cards.forEach(c => {
    c.pop = -(20 + Math.random() * 45);
    gsap.to(c, { pop: 0, duration: 1.4 + Math.random() * 0.8, delay: 0.1 + Math.random() * 0.5, ease: 'power3.out' });
  });
  markSceneDirty();
  gsap.delayedCall(1.2, () => {
    introDone = true;
    introDriftUntil = performance.now() + LOW_POWER.introDriftMs;
    markSceneDirty();
  });
  handleHashRoute();
}

/* ============================================================
   AUTH GATE
   ============================================================ */
const landingEl = document.getElementById('landing');
const communityHubEl = document.getElementById('community-hub');
const inviteViewEl = document.getElementById('invite-view');
const communityListEl = document.getElementById('community-list');
const communityEmptyEl = document.getElementById('community-empty');
const communityChip = document.getElementById('community-chip');
const inviteToolsBtn = document.getElementById('invite-tools-btn');
const recapChip = document.getElementById('recap-chip');
const posterChip = document.getElementById('poster-chip');
const communityRoomEl = document.getElementById('community-room');
const communityAdminEl = document.getElementById('community-admin');
const recapOverlayEl = document.getElementById('recap-overlay');
const onboardingModal = document.getElementById('onboarding-modal');
const communityModal = document.getElementById('community-modal');
const enterInviteModal = document.getElementById('enter-invite-modal');
const inviteToolsModal = document.getElementById('invite-tools-modal');
const authEl = document.getElementById('auth');
const authForm = document.getElementById('auth-form');
const aUser = document.getElementById('auth-user');
const aPass = document.getElementById('auth-pass');
const aName = document.getElementById('auth-name');
const aNameRow = document.getElementById('auth-name-row');
const authErr = document.getElementById('auth-err');
const authSubmit = document.getElementById('auth-submit');
const tabLogin = document.getElementById('tab-login');
const tabRegister = document.getElementById('tab-register');
const meChip = document.getElementById('me-chip');
let authMode = 'login';
let pendingInviteCode = '';
let roomOpen = false;
let adminOpen = false;
let recapOpen = false;
let lastRecap = null;          // last recap payload rendered - used for the shareable card
let recapCardBusy = false;     // guards against overlapping card builds
let mosaicPosterBusy = false;  // guards against overlapping sphere-poster builds
let showOnboardingAfterEnter = false;

function overlayOpen() {
  return !landingEl.hidden || !communityHubEl.hidden || !inviteViewEl.hidden || !authEl.hidden
    || roomOpen || adminOpen || recapOpen || peopleOpen || albumsOpen || flatOpen || atlasOpen || !uploadModal.hidden
    || !communityModal.hidden || !enterInviteModal.hidden || !inviteToolsModal.hidden
    || !onboardingModal.hidden
    || !albumModal.hidden || !pickAlbumModal.hidden || !addPhotosModal.hidden
    || detail.style.display === 'block';
}

function setAuthMode(mode) {
  authMode = mode;
  tabLogin.classList.toggle('active', mode === 'login');
  tabRegister.classList.toggle('active', mode === 'register');
  aNameRow.hidden = mode === 'login';
  authSubmit.textContent = mode === 'login' ? 'Log In' : 'Create Account';
  aPass.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  authErr.textContent = '';
}
tabLogin.addEventListener('click', () => setAuthMode('login'));
tabRegister.addEventListener('click', () => setAuthMode('register'));

function updateMeChip() {
  if (!me) { meChip.hidden = true; return; }
  meChip.hidden = false;
  meChip.innerHTML = (me.avatar ? `<img class="chip-av" src="${esc(mediaSrc(me.avatar))}" alt="">` : '') + '@' + esc(me.username);
}
meChip.addEventListener('click', () => { if (me) openPeople(me.username); });

/* ---------------- notifications inbox ---------------- */
const notifBtn = document.getElementById('notif-btn');
const notifBadge = document.getElementById('notif-badge');
const notifPanel = document.getElementById('notifications-panel');
const notifListEl = document.getElementById('notif-list');
const notifEmptyEl = document.getElementById('notif-empty');
let notifications = [];
let notifUnread = 0;
let notifOpen = false;

function updateNotifButtonBadge() {
  notifBtn.hidden = !me;
  if (!me) { closeNotifPanel(); return; }
  if (notifUnread > 0) {
    notifBadge.hidden = false;
    notifBadge.textContent = notifUnread > 99 ? '99+' : String(notifUnread);
  } else {
    notifBadge.hidden = true;
  }
}

async function loadNotifications() {
  if (!me) { notifications = []; notifUnread = 0; updateNotifButtonBadge(); return; }
  try {
    const r = await api.call('GET', '/api/notifications');
    notifications = Array.isArray(r.notifications) ? r.notifications : [];
    notifUnread = Number.isFinite(r.unread) ? r.unread : notifications.filter(n => !n.read).length;
  } catch {
    notifications = [];
    notifUnread = 0;
  }
  updateNotifButtonBadge();
  if (notifOpen) renderNotifications();
}

function notifLabel(n) {
  const title = n.title || 'your photo';
  if (n.type === 'like') return `@${n.actor} liked ${title}`;
  if (n.type === 'reaction') {
    const glyph = EMOJI[n.text];
    return `@${n.actor} reacted ${glyph || ''} to ${title}`;
  }
  if (n.type === 'comment') return `@${n.actor} commented on ${title}`;
  if (n.type === 'mention') return `@${n.actor} mentioned you on ${title}`;
  if (n.type === 'comment_like') return `@${n.actor} liked your comment on ${title}`;
  if (n.type === 'reply') return `@${n.actor} replied to your comment on ${title}`;
  if (n.type === 'spotlight') return `@${n.actor} featured ${title} in the spotlight`;
  return `@${n.actor} on ${title}`;
}

function renderNotifications() {
  notifListEl.innerHTML = '';
  notifications.forEach(n => {
    const row = document.createElement('button');
    row.className = 'notif-row' + (n.read ? '' : ' unread');
    const preview = (n.type === 'comment' || n.type === 'mention' || n.type === 'comment_like' || n.type === 'reply') && n.text ? `"${esc(n.text)}" / ` : '';
    row.innerHTML =
      `<span class="notif-main"><strong>${esc(notifLabel(n))}</strong>` +
      `<small class="mono dim">${preview}${timeAgo(n.created)}</small></span>` +
      (n.read ? '' : `<span class="notif-unread-dot"></span>`);
    row.addEventListener('click', () => openNotification(n));
    notifListEl.appendChild(row);
  });
  notifEmptyEl.hidden = notifications.length > 0;
}

function openNotification(n) {
  closeNotifPanel();
  if (n.postId && n.communityId) {
    setRoute(photoRoute(n.postId, n.communityId));
  }
  // fire-and-forget: mark this one read so the badge updates
  if (!n.read) {
    n.read = true;
    notifUnread = Math.max(0, notifUnread - 1);
    updateNotifButtonBadge();
    api.call('POST', '/api/notifications/read', { ids: [n.id] }).catch(() => {});
  }
}

async function markAllNotifsRead() {
  if (!notifications.some(n => !n.read)) return;
  notifications.forEach(n => { n.read = true; });
  notifUnread = 0;
  updateNotifButtonBadge();
  renderNotifications();
  try { await api.call('POST', '/api/notifications/read', {}); } catch {}
}

function openNotifPanel() {
  notifOpen = true;
  notifBtn.classList.add('active');
  notifPanel.hidden = false;
  renderNotifications();
  gsap.fromTo(notifPanel, { opacity: 0, y: -10 }, { opacity: 1, y: 0, duration: 0.3, ease: 'power3.out' });
}
function closeNotifPanel() {
  if (!notifOpen) { notifPanel.hidden = true; return; }
  notifOpen = false;
  notifBtn.classList.remove('active');
  gsap.to(notifPanel, { opacity: 0, y: -10, duration: 0.2, ease: 'power2.in', onComplete: () => { notifPanel.hidden = true; } });
}
function toggleNotifPanel() {
  if (notifOpen) { closeNotifPanel(); return; }
  openNotifPanel();
  loadNotifications();
}
notifBtn.addEventListener('click', toggleNotifPanel);
document.getElementById('notif-mark-read').addEventListener('click', markAllNotifsRead);
document.addEventListener('pointerdown', e => {
  if (!notifOpen) return;
  if (notifPanel.contains(e.target) || notifBtn.contains(e.target)) return;
  closeNotifPanel();
});

function updateLandingLogin() {
  const b = document.getElementById('landing-login');
  b.textContent = me ? 'MY COMMUNITIES' : 'LOG IN';
  document.getElementById('invite-login').textContent = me ? 'MY COMMUNITIES' : 'LOG IN';
}

function updateCommunityHud() {
  if (!currentCommunity) {
    communityChip.hidden = true;
    inviteToolsBtn.hidden = true;
    if (tourChip) tourChip.hidden = true;
    if (surpriseChip) surpriseChip.hidden = true;
    recapChip.hidden = true;
    if (posterChip) posterChip.hidden = true;
    return;
  }
  communityChip.hidden = false;
  communityChip.textContent = currentCommunity.name.toUpperCase();
  inviteToolsBtn.hidden = !(isCommunityAdmin() || isAdminProfile());
  inviteToolsBtn.textContent = 'Admin';
  // recap is for everyone, but stays out of the entry screens and off mobile
  const narrow = window.matchMedia && window.matchMedia('(max-width: 760px)').matches;
  recapChip.hidden = document.body.classList.contains('entry-mode') || narrow;
  // the tour needs at least two photos to loop through; hide it otherwise so
  // it never becomes a dead button (mirrors the recap chip's placement rules).
  if (tourChip) tourChip.hidden = recapChip.hidden || pool.length < 2;
  // surprise-me appears and disappears in lockstep with the tour chip: it needs
  // at least two photos to jump between and shares the entry / mobile rules.
  if (surpriseChip) surpriseChip.hidden = recapChip.hidden || pool.length < 2;
  // the sphere-poster chip shares the recap chip's entry / mobile placement, but
  // needs at least one photo on the wall to have anything to tile into a poster.
  if (posterChip) posterChip.hidden = recapChip.hidden || pool.length < 1;
}

// neutral fallback tint used on the public landing / entry screens and whenever
// a room has no valid accent, so nothing depends on JS having run.
const NEUTRAL_ACCENT = '#9a9a9a';

/* Tint the page backdrop + card mats with the active community's accent so each
   private room feels like its own space. Reads currentCommunity.accent, validates
   it is a #rrggbb, and publishes it as CSS custom properties for styles.css and
   forwards it to the texture module so newly built cards echo the tint. Falls back
   to a neutral gray in entry-mode or when no valid accent is present. */
function applyCommunityAmbient() {
  const raw = currentCommunity && currentCommunity.accent;
  const entry = document.body.classList.contains('entry-mode');
  const hex = (!entry && /^#[0-9a-f]{6}$/i.test(raw || '')) ? raw : NEUTRAL_ACCENT;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const root = document.documentElement.style;
  // a very faint derived glow for the backdrop / HUD so it stays dark + minimal
  root.setProperty('--community-glow', `rgba(${r},${g},${b},0.10)`);
  setCardAccent(hex);
}

function setEntryMode(on) {
  document.body.classList.toggle('entry-mode', !!on);
  applyCommunityAmbient();
}

function hideEntryScreens() {
  landingEl.hidden = true;
  communityHubEl.hidden = true;
  inviteViewEl.hidden = true;
}

async function clearActiveCommunity() {
  stopTour();   // reset tour state before the pool is rebuilt for the next room
  if (memoryRibbon) memoryRibbon.hidden = true;
  if (!currentCommunity && communityPosts.length === 0 && pool.length === 0) {
    applyCommunityAmbient();
    updateCommunityHud();
    updateEmptyWall();
    return;
  }
  currentCommunity = null;
  communityPosts = [];
  savedIds = new Set();
  applyCommunityAmbient();   // reset to neutral before cards rebuild
  buildPool();
  await loadPoolImages();
  disposeGallery();
  buildGallery();
  buildFilterTags();
  applyFilter();
  updateEmptyWall();
  updateCommunityHud();
}

async function showLanding(clearHash = true) {
  if (clearHash) history.replaceState(null, '', location.pathname + location.search);
  closeFlatView();
  closeAlbums();
  closePeople();
  closeAtlas();
  closeAdminPanel();
  closeCommunityRoom();
  closeRecap();
  if (detail.style.display === 'block') closeProject();
  await clearActiveCommunity();
  hideEntryScreens();
  authEl.hidden = true;
  updateLandingLogin();
  setEntryMode(true);
  landingEl.hidden = false;
}

async function showCommunityHub(clearHash = true) {
  if (!me) { showAuth('login'); return; }
  if (clearHash) history.replaceState(null, '', location.pathname + location.search);
  closeFlatView();
  closeAlbums();
  closePeople();
  closeAtlas();
  closeAdminPanel();
  closeCommunityRoom();
  closeRecap();
  if (detail.style.display === 'block') closeProject();
  await clearActiveCommunity();
  hideEntryScreens();
  authEl.hidden = true;
  updateLandingLogin();
  setEntryMode(true);
  communityHubEl.hidden = false;
  await loadCommunities();
}

function showAuth(mode = 'login', action = null) {
  pendingAuthAction = action;
  setEntryMode(true);
  setAuthMode(mode);
  authErr.textContent = '';
  authEl.hidden = false;
  authEl.style.opacity = '';
  authEl.style.visibility = '';
  setTimeout(() => aUser.focus(), 40);
}

async function bootstrapSession() {
  if (api.token) {
    try {
      me = await api.call('GET', '/api/me');
      authEl.hidden = true;
      updateMeChip();
      updateLandingLogin();
      loadNotifications();
      return;
    } catch { api.setToken(''); }
  }
  me = null;
  updateMeChip();
  updateLandingLogin();
}

async function loadCommunities() {
  try { allCommunities = await api.call('GET', '/api/communities'); }
  catch { allCommunities = []; }
  renderCommunityHub();
}

function renderCommunityHub() {
  communityListEl.innerHTML = '';
  allCommunities.forEach(c => {
    const card = document.createElement('button');
    card.className = 'community-card';
    if (c.coverFile) card.style.backgroundImage = `url('${esc(mediaSrc(c.coverFile))}')`;
    card.innerHTML =
      `<span class="cc-name">${esc(c.name)}</span>` +
      `<span class="mono cc-sub">${c.photoCount} PHOTO${c.photoCount === 1 ? '' : 'S'} / ${c.memberCount} MEMBER${c.memberCount === 1 ? '' : 'S'} / ${esc((c.role || 'member').toUpperCase())}</span>`;
    card.addEventListener('click', () => enterCommunity(c.id));
    communityListEl.appendChild(card);
  });
  communityEmptyEl.hidden = allCommunities.length > 0;
}

let communityLoadSeq = 0;
async function enterCommunity(id, updateHash = true) {
  if (!me) {
    showAuth('login', { type: 'community', id });
    return false;
  }
  // Leaving the current community: tear down any full-screen page that belonged
  // to it. Otherwise switching (e.g. via a #/c/<id> link or back/forward) would
  // strand a stale overlay on top of the new community's sphere, and because that
  // overlay's open-flag stays true the sphere would sit paused/frozen behind it.
  // (Each close is a no-op when its page isn't open.)
  closeFlatView(); closeAlbums(); closePeople(); closeAtlas();
  closeAdminPanel(); closeCommunityRoom(); closeRecap();
  if (detail.style.display === 'block') closeProject();

  // load token: a faster second switch supersedes this one, so a stale response
  // never clobbers the newer community's data (mixed A-under-B renders).
  const token = ++communityLoadSeq;
  stopTour();   // never let a tour's swapped pool leak across communities
  let loaded;
  try {
    loaded = await api.call('GET', '/api/communities/' + encodeURIComponent(id));
  } catch (e) {
    if (token !== communityLoadSeq) return false;
    currentCommunity = null;
    toast(String(e.message || 'COMMUNITY NOT FOUND').toUpperCase());
    await showCommunityHub(false);
    return false;
  }
  if (token !== communityLoadSeq) return false;
  currentCommunity = loaded;
  hideEntryScreens();
  authEl.hidden = true;
  setEntryMode(false);
  updateCommunityHud();
  loadNotifications();
  setNav('gallery');
  await refreshCommunity();
  if (token !== communityLoadSeq) return false;
  await loadCommunityExtras();
  if (token !== communityLoadSeq) return false;
  await rebuildGallery();
  if (token !== communityLoadSeq) return false;
  if (updateHash) setRoute(communityRoute());
  if (showOnboardingAfterEnter) {
    showOnboardingAfterEnter = false;
    openOnboarding();
  }
  return true;
}

function parseInviteCode(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/#\/invite\/([^/?#\s]+)/i) || s.match(/\/invite\/([^/?#\s]+)/i);
  return cleanInviteCode(m ? m[1] : s.split(/[/?#\s]/).filter(Boolean).pop() || s);
}

function cleanInviteCode(code) {
  return String(code || '').trim().replace(/[^a-z0-9_-]/gi, '');
}

async function showInvite(code) {
  pendingInviteCode = cleanInviteCode(code);
  await clearActiveCommunity();
  hideEntryScreens();
  authEl.hidden = true;
  updateLandingLogin();
  setEntryMode(true);
  inviteViewEl.hidden = false;
  document.getElementById('invite-title').textContent = 'Join a community';
  document.getElementById('invite-desc').textContent = '';
  document.getElementById('invite-meta').textContent = '';
  document.getElementById('invite-err').textContent = '';
  document.getElementById('invite-join').disabled = true;
  try {
    const invite = await api.call('GET', '/api/invites/' + encodeURIComponent(pendingInviteCode));
    const c = invite.community;
    document.getElementById('invite-title').textContent = c.name;
    document.getElementById('invite-desc').textContent = c.description || 'You have been invited into this private memory sphere.';
    document.getElementById('invite-meta').textContent =
      `${c.photoCount} PHOTO${c.photoCount === 1 ? '' : 'S'} / ${c.memberCount} MEMBER${c.memberCount === 1 ? '' : 'S'}`;
    document.getElementById('invite-join').disabled = false;
    document.getElementById('invite-join').textContent = me ? 'Join Community' : 'Log In To Join';
  } catch (e) {
    document.getElementById('invite-err').textContent = String(e.message || 'INVITE NOT FOUND').toUpperCase();
  }
}

async function joinInvite(code) {
  const inviteCode = cleanInviteCode(code || pendingInviteCode);
  if (!inviteCode) return;
  if (!me) {
    showAuth('register', { type: 'invite', code: inviteCode });
    return;
  }
  try {
    const c = await api.call('POST', '/api/invites/' + encodeURIComponent(inviteCode) + '/join');
    toast('JOINED COMMUNITY');
    showOnboardingAfterEnter = true;
    await loadCommunities();
    await enterCommunity(c.id);
  } catch (e) {
    document.getElementById('invite-err').textContent = String(e.message || 'COULD NOT JOIN').toUpperCase();
  }
}

async function afterAuthSuccess() {
  const action = pendingAuthAction;
  pendingAuthAction = null;
  gsap.to(authEl, {
    autoAlpha: 0, duration: 0.35,
    onComplete: () => { authEl.hidden = true; authEl.style.opacity = ''; authEl.style.visibility = ''; },
  });
  updateLandingLogin();
  if (action && action.type === 'invite') {
    pendingInviteCode = action.code;
    await joinInvite(action.code);
    return;
  }
  if (action && action.type === 'community') {
    await enterCommunity(action.id);
    return;
  }
  if (action && action.type === 'route') {
    replaceRoute(action.path);
    await handleHashRoute();
    return;
  }
  if (action && action.type === 'create') {
    await showCommunityHub(false);
    openCommunityModal();
    return;
  }
  await showCommunityHub(false);
}

authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  authErr.textContent = '';
  authSubmit.disabled = true;
  try {
    const body = { username: aUser.value.trim(), password: aPass.value };
    if (authMode === 'register') body.displayName = aName.value.trim();
    const r = await api.call('POST', authMode === 'login' ? '/api/login' : '/api/register', body);
    api.setToken(r.token);
    me = r.profile;
    updateMeChip();
    loadNotifications();
    await afterAuthSuccess();
  } catch (err) {
    authErr.textContent = String(err.message || 'SOMETHING WENT WRONG').toUpperCase();
  } finally {
    authSubmit.disabled = false;
  }
});

function openCommunityModal() {
  if (!me) { showAuth('register', { type: 'create' }); return; }
  document.getElementById('cm-name').value = '';
  document.getElementById('cm-desc').value = '';
  document.getElementById('cm-err').textContent = '';
  communityModal.hidden = false;
  gsap.fromTo('#community-modal .modal-box', { scale: 0.94, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.3, ease: 'power2.out' });
}
function closeCommunityModal() { communityModal.hidden = true; }
document.getElementById('community-modal-close').addEventListener('click', closeCommunityModal);
communityModal.addEventListener('pointerdown', e => { if (e.target === communityModal) closeCommunityModal(); });
document.getElementById('cm-create').addEventListener('click', async () => {
  const name = document.getElementById('cm-name').value.trim();
  if (!name) { document.getElementById('cm-err').textContent = 'NAME YOUR COMMUNITY FIRST.'; return; }
  try {
    const c = await api.call('POST', '/api/communities', {
      name,
      description: document.getElementById('cm-desc').value,
    });
    closeCommunityModal();
    toast('COMMUNITY CREATED');
    showOnboardingAfterEnter = true;
    await loadCommunities();
    await enterCommunity(c.id);
  } catch (e) {
    document.getElementById('cm-err').textContent = String(e.message || 'COULD NOT CREATE').toUpperCase();
  }
});

function openEnterInviteModal() {
  document.getElementById('enter-invite-code').value = '';
  document.getElementById('enter-invite-err').textContent = '';
  enterInviteModal.hidden = false;
  gsap.fromTo('#enter-invite-modal .modal-box', { scale: 0.94, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.3, ease: 'power2.out' });
}
function closeEnterInviteModal() { enterInviteModal.hidden = true; }
document.getElementById('enter-invite-close').addEventListener('click', closeEnterInviteModal);
enterInviteModal.addEventListener('pointerdown', e => { if (e.target === enterInviteModal) closeEnterInviteModal(); });
document.getElementById('enter-invite-go').addEventListener('click', () => {
  const code = parseInviteCode(document.getElementById('enter-invite-code').value);
  if (!code) { document.getElementById('enter-invite-err').textContent = 'PASTE AN INVITE CODE OR LINK.'; return; }
  closeEnterInviteModal();
  setRoute(`invite/${code}`);
});

async function openInviteTools() {
  if (!currentCommunity || !(isCommunityAdmin() || isAdminProfile())) return;
  inviteToolsModal.hidden = false;
  document.getElementById('invite-tools-community').textContent = currentCommunity.name.toUpperCase();
  document.getElementById('invite-tools-err').textContent = '';
  gsap.fromTo('#invite-tools-modal .modal-box', { scale: 0.94, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.3, ease: 'power2.out' });
  await renderInviteTools();
}
function closeInviteTools() { inviteToolsModal.hidden = true; }
async function renderInviteTools() {
  const list = document.getElementById('invite-list');
  list.innerHTML = '';
  let invites = [];
  try { invites = await api.call('GET', '/api/communities/' + encodeURIComponent(currentCommunity.id) + '/invites'); }
  catch (e) { document.getElementById('invite-tools-err').textContent = String(e.message || 'COULD NOT LOAD').toUpperCase(); }
  document.getElementById('invite-list-empty').hidden = invites.length > 0;
  invites.forEach(inv => {
    const link = routeUrl(`invite/${inv.code}`);
    const row = document.createElement('div');
    row.className = 'pick-album-row';
    row.innerHTML =
      `<span class="pa-copy">${esc(link)}</span>` +
      `<span class="pa-count">COPY</span>`;
    row.addEventListener('click', () => copyRoute(`invite/${inv.code}`));
    list.appendChild(row);
  });
}
document.getElementById('invite-tools-close').addEventListener('click', closeInviteTools);
inviteToolsModal.addEventListener('pointerdown', e => { if (e.target === inviteToolsModal) closeInviteTools(); });
document.getElementById('invite-create').addEventListener('click', async () => {
  try {
    const inv = await api.call('POST', '/api/communities/' + encodeURIComponent(currentCommunity.id) + '/invites');
    await renderInviteTools();
    await copyRoute(`invite/${inv.code}`);
  } catch (e) {
    document.getElementById('invite-tools-err').textContent = String(e.message || 'COULD NOT CREATE').toUpperCase();
  }
});

async function loadCommunityExtras() {
  if (!currentCommunity) return;
  try { communityPrompts = await api.call('GET', `/api/communities/${encodeURIComponent(currentCommunity.id)}/prompts`); }
  catch { communityPrompts = []; }
  try { communityActivity = await api.call('GET', `/api/communities/${encodeURIComponent(currentCommunity.id)}/activity`); }
  catch { communityActivity = []; }
  try { communityPulse = await api.call('GET', `/api/communities/${encodeURIComponent(currentCommunity.id)}/pulse`); }
  catch { communityPulse = null; }
  try { communityMilestones = await api.call('GET', `/api/communities/${encodeURIComponent(currentCommunity.id)}/milestones`); }
  catch { communityMilestones = null; }
}

async function refreshCurrentCommunity() {
  if (!currentCommunity) return;
  try {
    currentCommunity = await api.call('GET', '/api/communities/' + encodeURIComponent(currentCommunity.id));
    applyCommunityAmbient();
    updateCommunityHud();
  } catch {}
}

function activePrompt() {
  return communityPrompts.find(p => p.id === currentCommunity.activePromptId) || communityPrompts.find(p => p.active);
}

async function openCommunityRoom() {
  if (!currentCommunity) { showCommunityHub(); return; }
  closeFlatView();
  closeAlbums();
  closePeople();
  closeRecap();
  if (detail.style.display === 'block') closeProject();
  await refreshCurrentCommunity();
  await loadCommunityExtras();
  renderCommunityRoom();
  roomOpen = true;
  communityRoomEl.style.display = 'block';
  communityRoomEl.setAttribute('aria-hidden', 'false');
  communityRoomEl.scrollTop = 0;
  gsap.fromTo(communityRoomEl, { yPercent: 100, y: 0 }, { yPercent: 0, y: 0, duration: 0.75, ease: 'power4.inOut' });
}

function closeCommunityRoom() {
  if (!roomOpen) return;
  markSceneDirty();   // wake the sphere so it paints through the reveal
  communityRoomEl.setAttribute('aria-hidden', 'true');
  gsap.to(communityRoomEl, {
    yPercent: 100, duration: 0.65, ease: 'power3.inOut',
    onComplete: () => { communityRoomEl.style.display = 'none'; roomOpen = false; },
  });
}

function renderCommunityRoom() {
  if (!currentCommunity) return;
  const cover = document.getElementById('room-cover');
  cover.style.backgroundImage = currentCommunity.coverFile ? `linear-gradient(to bottom, rgba(0,0,0,.18), rgba(0,0,0,.82)), url('${esc(mediaSrc(currentCommunity.coverFile))}')` : '';
  document.getElementById('room-accent').style.background = currentCommunity.accent || '#fff';
  document.getElementById('room-title').textContent = currentCommunity.name;
  document.getElementById('room-desc').textContent = currentCommunity.description || '';
  document.getElementById('room-welcome').textContent = currentCommunity.welcome || '';
  document.getElementById('room-role').textContent =
    `${(currentCommunity.role || 'member').toUpperCase()} / ${currentCommunity.photoCount} PHOTO${currentCommunity.photoCount === 1 ? '' : 'S'} / ${currentCommunity.memberCount} MEMBER${currentCommunity.memberCount === 1 ? '' : 'S'}`;
  document.getElementById('room-admin-open').hidden = !(isCommunityAdmin() || isAdminProfile());
  const prompt = activePrompt();
  document.getElementById('room-prompt-text').textContent = prompt ? prompt.text : 'No active prompt yet.';
  document.getElementById('room-prompt-upload').disabled = !prompt;

  const pinnedWrap = document.getElementById('room-pinned');
  pinnedWrap.innerHTML = '';
  const pinned = new Set(currentCommunity.pinnedPostIds || []);
  const pinnedPosts = communityPosts.filter(p => pinned.has(p.id));
  pinnedPosts.forEach(post => {
    const onSphere = postOnSphere(post.id);
    const tile = document.createElement('button');
    tile.className = 'mini-photo';
    tile.innerHTML =
      `<span class="mp-media">` +
      `<img src="${esc(mediaSrc(post.file))}" alt="${esc(post.title || '')}">` +
      (onSphere ? LOCATE_PIN_HTML : '') +
      `</span>` +
      `<span>${esc(post.title || 'UNTITLED')}</span>`;
    tile.addEventListener('click', () => openDetailFor(postToProject(post)));
    wireLocatePin(tile, post.id);
    pinnedWrap.appendChild(tile);
  });
  document.getElementById('room-pinned-empty').hidden = pinnedPosts.length > 0;

  renderCommunitySpotlight();

  const feed = document.getElementById('room-feed');
  feed.innerHTML = '';
  communityActivity.forEach(ev => {
    const row = document.createElement('button');
    row.className = 'activity-row';
    const label = activityLabel(ev);
    row.innerHTML =
      (ev.file ? `<img src="${esc(mediaSrc(ev.file))}" alt="">` : `<span class="activity-dot"></span>`) +
      `<span><strong>${esc(label)}</strong><small class="mono dim">@${esc(ev.actor || 'system')} / ${timeAgo(ev.created)}</small></span>`;
    row.addEventListener('click', () => {
      if (ev.photoId) {
        const post = communityPosts.find(p => p.id === ev.photoId);
        if (post) openDetailFor(postToProject(post));
      }
      else if (ev.albumId) openAlbums(ev.albumId);
    });
    feed.appendChild(row);
  });
  document.getElementById('room-feed-empty').hidden = communityActivity.length > 0;

  renderCommunityPulse();
  renderCommunityMilestones();
}

/* the community SPOTLIGHT: one deliberately curated hero photo the owners/admins
   have chosen. The whole card is a doorway back to the sphere - clicking it
   opens the photo (cached detail when possible, else spins the sphere), exactly
   like the pinned tiles. Admins get an inline UNFEATURE control. */
function renderCommunitySpotlight() {
  const panel = document.getElementById('room-spotlight');
  const clearBtn = document.getElementById('room-spotlight-clear');
  if (!panel) return;
  const admin = isCommunityAdmin() || isAdminProfile();
  const spotId = currentCommunity && currentCommunity.spotlightPostId;
  const post = spotId ? communityPosts.find(p => p.id === spotId) : null;
  if (!post) { panel.hidden = true; if (clearBtn) clearBtn.hidden = true; return; }
  panel.hidden = false;
  panel.style.borderColor = currentCommunity.accent || '';
  if (clearBtn) clearBtn.hidden = !admin;
  const onSphere = postOnSphere(post.id);
  const media = document.getElementById('room-spotlight-media');
  media.innerHTML =
    `<img src="${esc(mediaSrc(post.file))}" alt="${esc(post.title || '')}">` +
    (onSphere ? LOCATE_PIN_HTML : '');
  document.getElementById('room-spotlight-title').textContent = post.title || 'UNTITLED';
  document.getElementById('room-spotlight-owner').textContent = '@' + (post.username || 'unknown');
  const card = document.getElementById('room-spotlight-card');
  card.onclick = () => openPulsePhoto(post.id);
  wireLocatePin(card, post.id);
}

/* build one "doorway back to the sphere" photo tile shared by the recap and
   pulse strips: cover image, a locate-pin when the card is on the sphere, the
   title, and a mono sub-label (e.g. "@user / N LOVE"). onClick opens the photo. */
function photoTile(tp, subLabel, onClick) {
  const onSphere = postOnSphere(tp.id);
  const tile = document.createElement('button');
  tile.className = 'mini-photo recap-tile';
  tile.innerHTML =
    `<span class="mp-media">` +
    `<img src="${esc(mediaSrc(tp.file))}" alt="${esc(tp.title || '')}">` +
    (onSphere ? LOCATE_PIN_HTML : '') +
    `</span>` +
    `<span>${esc(tp.title || 'UNTITLED')}</span>` +
    `<small class="mono dim recap-tile-sub">@${esc(tp.username || 'unknown')} / ${esc(subLabel)}</small>`;
  tile.addEventListener('click', () => onClick(tp.id));
  wireLocatePin(tile, tp.id);
  return tile;
}

/* the community PULSE: a server-aggregated "what is resonating right now"
   snapshot. The emoji breakdown uses the fixed EMOJI map (numbers + fixed
   glyphs only, never user text), and each top-photo tile is a doorway back
   to the sphere, reusing the mini-photo + wireLocatePin pattern. */
function renderCommunityPulse() {
  const reactionsWrap = document.getElementById('room-pulse-reactions');
  const photosWrap = document.getElementById('room-pulse-photos');
  const emptyEl = document.getElementById('room-pulse-empty');
  const windowEl = document.getElementById('room-pulse-window');
  if (!reactionsWrap || !photosWrap) return;
  reactionsWrap.innerHTML = '';
  photosWrap.innerHTML = '';
  const pulse = communityPulse;
  const reactions = (pulse && Array.isArray(pulse.reactions)) ? pulse.reactions : [];
  const topPhotos = (pulse && Array.isArray(pulse.topPhotos)) ? pulse.topPhotos : [];

  windowEl.textContent = pulse
    ? (pulse.windowDays ? `LAST ${pulse.windowDays} DAYS` : 'ALL TIME')
    : '';

  reactions.forEach(r => {
    if (!EMOJI[r.emoji]) return;
    const chip = document.createElement('div');
    chip.className = 'pulse-chip' + (r.count ? '' : ' zero');
    chip.title = r.emoji.toUpperCase();
    chip.innerHTML =
      `<span class="pc-emoji">${EMOJI[r.emoji]}</span>` +
      `<span class="pc-count mono">${esc(String(r.count || 0))}</span>`;
    reactionsWrap.appendChild(chip);
  });

  topPhotos.forEach(tp => {
    photosWrap.appendChild(photoTile(tp, `${tp.reactionCount || 0} REACT`, openPulsePhoto));
  });

  const hasPulse = reactions.some(r => r.count) || topPhotos.length > 0;
  emptyEl.hidden = hasPulse;
}

/* the community MILESTONES board: server-computed badges celebrating shared
   progress (photo tiers, everyone contributed, most-loved memory, current
   posting streak). Every field is server-derived text or a fixed glyph, but we
   still esc() all of it. Achieved badges get an accent-tinted ring; locked ones
   are dimmed with a thin progress hint toward the next tier. */
function renderCommunityMilestones() {
  const grid = document.getElementById('room-milestone-grid');
  const emptyEl = document.getElementById('room-milestone-empty');
  if (!grid) return;
  grid.innerHTML = '';
  const badges = (communityMilestones && Array.isArray(communityMilestones.badges)) ? communityMilestones.badges : [];
  const accent = (currentCommunity && currentCommunity.accent) || '#fff';
  badges.forEach(b => {
    const achieved = !!b.achieved;
    const pct = Math.max(0, Math.min(1, Number(b.progress) || 0));
    const card = document.createElement('div');
    card.className = 'milestone-badge' + (achieved ? ' achieved' : ' locked');
    if (achieved) card.style.borderColor = accent;
    card.innerHTML =
      `<span class="ms-icon" ${achieved ? `style="color:${esc(accent)}"` : ''}>${esc(b.icon || '◇')}</span>` +
      `<span class="ms-label mono">${esc(b.label || '')}</span>` +
      `<span class="ms-detail mono dim">${esc(b.detail || '')}</span>` +
      (achieved ? '' : `<span class="ms-progress"><span class="ms-progress-fill" style="width:${(pct * 100).toFixed(0)}%;background:${esc(accent)}"></span></span>`);
    grid.appendChild(card);
  });
  emptyEl.hidden = badges.length > 0;
}

/* a pulse photo tile is a doorway back into the sphere: prefer the local
   cache so the detail view is fully wired, else spin the sphere to it. */
function openPulsePhoto(postId) {
  const post = communityPosts.find(p => p.id === postId);
  if (post) openDetailFor(postToProject(post));
  else focusCardOnSphere(postId);
}

function activityLabel(ev) {
  if (ev.type === 'photo') return `Posted ${ev.title || 'a photo'}`;
  if (ev.type === 'comment') return `Commented on ${ev.title || 'a photo'}`;
  if (ev.type === 'album') return `Created album ${ev.title || ''}`;
  if (ev.type === 'member.joined') return 'Joined the community';
  if (ev.type === 'prompt.created') return `New prompt: ${ev.title || ''}`;
  if (ev.type === 'photo.pinned') return `Pinned ${ev.title || 'a photo'}`;
  if (ev.type === 'photo.spotlighted') return `Featured ${ev.title || 'a photo'} in the spotlight`;
  return ev.title || ev.type;
}

async function openRecap(updateHash = true) {
  if (!currentCommunity) { showCommunityHub(); return; }
  closeFlatView();
  closeAlbums();
  closePeople();
  closeAtlas();
  closeCommunityRoom();
  closeAdminPanel();
  if (detail.style.display === 'block') closeProject();
  let r;
  try { r = await api.call('GET', `/api/communities/${encodeURIComponent(currentCommunity.id)}/recap`); }
  catch (e) { toast(String(e.message || 'COULD NOT LOAD RECAP').toUpperCase()); return; }
  renderRecap(r);
  recapOpen = true;
  recapOverlayEl.style.display = 'block';
  recapOverlayEl.setAttribute('aria-hidden', 'false');
  recapOverlayEl.scrollTop = 0;
  if (updateHash) setRoute(communityRoute('recap'));
  gsap.fromTo(recapOverlayEl, { yPercent: 100, y: 0 }, { yPercent: 0, y: 0, duration: 0.75, ease: 'power4.inOut' });
}

function closeRecap() {
  if (!recapOpen) return;
  markSceneDirty();   // wake the sphere so it paints through the reveal
  recapOverlayEl.setAttribute('aria-hidden', 'true');
  gsap.to(recapOverlayEl, {
    yPercent: 100, duration: 0.65, ease: 'power3.inOut',
    onComplete: () => { recapOverlayEl.style.display = 'none'; recapOpen = false; },
  });
}

function renderRecap(r) {
  if (!r) return;
  lastRecap = r;
  document.getElementById('recap-title').textContent = (r.community && r.community.name) || currentCommunity.name;
  document.getElementById('recap-range').textContent = recapDateLabel(r.range);
  document.getElementById('recap-sub').textContent = 'A shared recap of everything we have built together.';

  const stats = [
    [r.photoCount, `PHOTO${r.photoCount === 1 ? '' : 'S'}`],
    [r.albumCount, `ALBUM${r.albumCount === 1 ? '' : 'S'}`],
    [r.memberCount, `MEMBER${r.memberCount === 1 ? '' : 'S'}`],
    [r.promptCount, `PROMPT${r.promptCount === 1 ? '' : 'S'}`],
  ];
  const statsWrap = document.getElementById('recap-stats');
  statsWrap.innerHTML = '';
  stats.forEach(([n, label]) => {
    const cell = document.createElement('div');
    cell.className = 'recap-stat';
    cell.innerHTML = `<span class="rs-num">${esc(String(n || 0))}</span><span class="mono dim rs-label">${esc(label)}</span>`;
    statsWrap.appendChild(cell);
  });

  const strip = document.getElementById('recap-photos');
  strip.innerHTML = '';
  (r.topPhotos || []).forEach(tp => {
    strip.appendChild(photoTile(tp, `${tp.loveScore || 0} LOVE`, openRecapPhoto));
  });
  document.getElementById('recap-photos-empty').hidden = (r.topPhotos || []).length > 0;

  const membersWrap = document.getElementById('recap-members');
  membersWrap.innerHTML = '';
  (r.topMembers || []).forEach(m => {
    const row = document.createElement('button');
    row.className = 'activity-row recap-member';
    row.innerHTML =
      `<span class="avatar sm">${avatarInner(m)}</span>` +
      `<span><strong>${esc(m.displayName || m.username)}</strong>` +
      `<small class="mono dim">@${esc(m.username)} / ${esc(String(m.photoCount || 0))} PHOTO${m.photoCount === 1 ? '' : 'S'}</small></span>`;
    row.addEventListener('click', () => { closeRecap(); openPeople(m.username); });
    membersWrap.appendChild(row);
  });
  document.getElementById('recap-members-empty').hidden = (r.topMembers || []).length > 0;
}

/* a recap photo tile is a doorway back into the sphere: prefer the local
   cache so the detail view is fully wired, else spin the sphere to it. */
function openRecapPhoto(postId) {
  closeRecap();
  const post = communityPosts.find(p => p.id === postId);
  if (post) openDetailFor(postToProject(post));
  else { clearRouteKind('recap'); focusCardOnSphere(postId); }
}

/* build the recap card and trigger a PNG download via toBlob + object URL */
async function downloadRecapCard() {
  if (recapCardBusy) return;
  if (!lastRecap || !(lastRecap.photoCount || (lastRecap.topPhotos || []).length)) {
    toast('NO RECAP TO SAVE YET');
    return;
  }
  recapCardBusy = true;
  const buildingEl = document.getElementById('recap-building');
  const dlBtn = document.getElementById('recap-download');
  const shareBtn = document.getElementById('recap-share');
  if (buildingEl) buildingEl.hidden = false;
  if (dlBtn) dlBtn.disabled = true;
  if (shareBtn) shareBtn.disabled = true;
  try {
    const canvas = await renderRecapCard(lastRecap, currentCommunity && currentCommunity.name);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('render failed');
    const base = sanitizeBase((lastRecap.community && lastRecap.community.name) || (currentCommunity && currentCommunity.name), 'recap');
    downloadBlob(blob, `${base}-recap.png`);
    toast('SAVING RECAP CARD');
  } catch {
    toast('COULD NOT BUILD CARD');
  } finally {
    if (buildingEl) buildingEl.hidden = true;
    if (dlBtn) dlBtn.disabled = false;
    if (shareBtn) shareBtn.disabled = false;
    recapCardBusy = false;
  }
}

/* ---- shareable album contact sheet ---------------------------------------
   Draws the currently open album into an offscreen portrait canvas as a tiled
   contact sheet (cover-style header + a grid of the album's photos) in the same
   Space Mono / Inter + coverDraw() aesthetic as the recap card. Purely
   client-side; photos load CORS-enabled so Supabase-hosted images do not taint
   the canvas before toBlob(). One broken URL falls back to a placeholder cell
   instead of aborting the sheet. All text is app-generated / trusted fields
   drawn to canvas, never innerHTML. */
let albumSheetBusy = false;    // guards against overlapping sheet builds

/* build the sheet, toggling the busy UI; returns { blob, base } or null */
async function buildAlbumSheet() {
  if (albumSheetBusy) return null;
  if (!viewingAlbum || !viewingAlbum.posts || !viewingAlbum.posts.length) {
    toast('NO PHOTOS TO SAVE YET');
    return null;
  }
  albumSheetBusy = true;
  const buildingEl = document.getElementById('album-sheet-building');
  const btn = document.getElementById('album-contact-sheet');
  if (buildingEl) buildingEl.hidden = false;
  if (btn) btn.disabled = true;
  try {
    const canvas = await renderAlbumContactSheet(viewingAlbum.album, viewingAlbum.posts, currentCommunity && currentCommunity.name);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('render failed');
    return { blob, base: sanitizeBase(viewingAlbum.album && viewingAlbum.album.name, 'album') };
  } catch {
    toast('COULD NOT BUILD SHEET');
    return null;
  } finally {
    if (buildingEl) buildingEl.hidden = true;
    if (btn) btn.disabled = false;
    albumSheetBusy = false;
  }
}

/* download the currently open album as a contact-sheet PNG */
async function downloadAlbumSheet() {
  const built = await buildAlbumSheet();
  if (!built) return;
  downloadBlob(built.blob, `${built.base}-sheet.png`);
  toast('SAVING ALBUM SHEET');
}

/* share the sheet via the Web Share API when available (with a file), else
   fall back to a plain download; guarded so a cancel/failure never leaves a
   dangling toast. */
async function shareAlbumSheet() {
  const built = await buildAlbumSheet();
  if (!built) return;
  const title = String((viewingAlbum && viewingAlbum.album && viewingAlbum.album.name) || 'Album');
  await shareOrDownloadBlob(built.blob, `${built.base}-sheet.png`, title, `${title} - a shared album`, 'SAVING ALBUM SHEET');
}

/* ---- shareable sphere mosaic poster --------------------------------------
   Builds a single keepsake image of the WHOLE community wall (every photo,
   tiled) via renderMosaicPoster in js/mosaic.js, reusing the same coverDraw +
   loadCors + toBlob + download / Web-Share pipeline as the recap card and album
   sheet. The heavy drawing lives in the module (dependency-free, fed the shared
   canvas helpers); this pair just guards the busy UI and hands off the blob. */

/* build the poster, toggling the busy UI; returns { blob, base } or null */
async function buildMosaicPoster() {
  if (mosaicPosterBusy) return null;
  if (!currentCommunity || !communityPosts.length) {
    toast('NO PHOTOS TO SAVE YET');
    return null;
  }
  mosaicPosterBusy = true;
  const buildingEl = document.getElementById('poster-building');
  if (buildingEl) buildingEl.hidden = false;
  if (posterChip) posterChip.disabled = true;
  try {
    const canvas = await renderMosaicPoster(currentCommunity, communityPosts,
      { coverDraw, loadCors, mediaSrc, sanitizeBase });
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('render failed');
    return { blob, base: sanitizeBase(currentCommunity.name, 'sphere') };
  } catch {
    toast('COULD NOT BUILD POSTER');
    return null;
  } finally {
    if (buildingEl) buildingEl.hidden = true;
    if (posterChip) posterChip.disabled = false;
    mosaicPosterBusy = false;
  }
}

/* download the whole sphere as a mosaic-poster PNG */
async function downloadMosaicPoster() {
  const built = await buildMosaicPoster();
  if (!built) return;
  downloadBlob(built.blob, `${built.base}-sphere.png`);
  toast('SAVING SPHERE POSTER');
}

/* share the poster via the Web Share API when available, else download it */
async function shareMosaicPoster() {
  const built = await buildMosaicPoster();
  if (!built) return;
  const title = String((currentCommunity && currentCommunity.name) || 'Our Sphere');
  await shareOrDownloadBlob(built.blob, `${built.base}-sphere.png`, title, `${title} - our shared memory sphere`, 'SAVING SPHERE POSTER');
}

let csCoverData;
/* A closure that re-opens whatever community view is showing right now, so a
   back button can return the user to where they actually were rather than a
   fixed destination. Derived from live view state (not wired per call site);
   null means the sphere, the base view. Reusable by any overlay's back. */
function currentViewRestorer() {
  if (roomOpen) return openCommunityRoom;
  if (recapOpen) return () => openRecap(false);
  if (albumsOpen) return () => openAlbums(undefined, false);
  if (peopleOpen) return () => openPeople(undefined, false);
  if (atlasOpen) return openAtlas;
  if (flatOpen) return () => openFlatView();
  return null;
}

let adminReturn = null;   // restorer for the view to return to when admin closes
async function openAdminPanel() {
  if (!currentCommunity || !(isCommunityAdmin() || isAdminProfile())) return;
  adminReturn = currentViewRestorer();   // remember the actual current view
  closeCommunityRoom();
  closeRecap();
  adminOpen = true;
  communityAdminEl.style.display = 'block';
  communityAdminEl.setAttribute('aria-hidden', 'false');
  communityAdminEl.scrollTop = 0;
  await renderAdminPanel();
  gsap.fromTo(communityAdminEl, { yPercent: 100, y: 0 }, { yPercent: 0, y: 0, duration: 0.75, ease: 'power4.inOut' });
}

function closeAdminPanel() {
  if (!adminOpen) return;
  markSceneDirty();   // wake the sphere so it paints through the reveal
  communityAdminEl.setAttribute('aria-hidden', 'true');
  gsap.to(communityAdminEl, {
    yPercent: 100, duration: 0.65, ease: 'power3.inOut',
    onComplete: () => { communityAdminEl.style.display = 'none'; adminOpen = false; },
  });
}

async function renderAdminPanel() {
  await refreshCurrentCommunity();
  await loadCommunityExtras();
  document.getElementById('admin-title').textContent = `${currentCommunity.name} admin`;
  document.getElementById('cs-name').value = currentCommunity.name || '';
  document.getElementById('cs-desc').value = currentCommunity.description || '';
  document.getElementById('cs-welcome').value = currentCommunity.welcome || '';
  document.getElementById('cs-accent').value = /^#[0-9a-f]{6}$/i.test(currentCommunity.accent || '') ? currentCommunity.accent : '#ffffff';
  csCoverData = undefined;
  await Promise.all([renderAdminMembers(), renderAdminBans(), renderAdminInvites(), renderAdminPrompts(), renderAdminAudit()]);
}

async function renderAdminMembers() {
  const wrap = document.getElementById('admin-members');
  wrap.innerHTML = '';
  let members = [];
  try { members = await api.call('GET', `/api/communities/${encodeURIComponent(currentCommunity.id)}/members`); } catch {}
  members.forEach(member => {
    const row = document.createElement('div');
    row.className = 'admin-row';
    const canPromote = (currentCommunity.role === 'owner' || isAdminProfile()) && member.role !== 'owner' && member.username !== me.username;
    const canRemove = member.role !== 'owner' && member.username !== me.username && (currentCommunity.role === 'owner' || (currentCommunity.role === 'admin' && member.role === 'member') || isAdminProfile());
    row.innerHTML =
      `<span class="avatar sm">${avatarInner(member)}</span>` +
      `<span class="admin-main"><strong>${esc(member.displayName || member.username)}</strong><small class="mono dim">@${esc(member.username)} / ${esc(member.role.toUpperCase())} / ${member.photoCount} PHOTO${member.photoCount === 1 ? '' : 'S'}</small></span>` +
      `<span class="admin-actions"></span>`;
    const actions = row.querySelector('.admin-actions');
    if (canPromote) {
      const nextRole = member.role === 'admin' ? 'member' : 'admin';
      const b = document.createElement('button');
      b.className = 'mono';
      b.textContent = nextRole === 'admin' ? 'PROMOTE' : 'DEMOTE';
      b.addEventListener('click', () => changeMemberRole(member.username, nextRole));
      actions.appendChild(b);
    }
    if (canRemove) {
      const b = document.createElement('button');
      b.className = 'mono danger';
      b.textContent = 'REMOVE';
      b.addEventListener('click', () => removeMember(member.username));
      actions.appendChild(b);
      const bn = document.createElement('button');
      bn.className = 'mono danger';
      bn.textContent = 'BAN';
      bn.addEventListener('click', () => banMember(member.username));
      actions.appendChild(bn);
    }
    wrap.appendChild(row);
  });
}

async function changeMemberRole(username, role) {
  try {
    await api.call('PUT', `/api/communities/${encodeURIComponent(currentCommunity.id)}/members/${encodeURIComponent(username)}/role`, { role });
    toast('ROLE UPDATED');
    await renderAdminPanel();
  } catch (e) { toast(String(e.message || 'COULD NOT UPDATE ROLE').toUpperCase()); }
}

async function removeMember(username) {
  if (!confirm(`Remove @${username} from this community? They can be re-invited later. Their existing posts stay visible.`)) return;
  try {
    await api.call('DELETE', `/api/communities/${encodeURIComponent(currentCommunity.id)}/members/${encodeURIComponent(username)}`, {});
    toast('MEMBER REMOVED');
    await renderAdminPanel();
  } catch (e) { toast(String(e.message || 'COULD NOT REMOVE').toUpperCase()); }
}

async function banMember(username) {
  if (!confirm(`Ban @${username}? They will be removed AND blocked from rejoining until you unban them. Their existing posts stay visible.`)) return;
  try {
    await api.call('DELETE', `/api/communities/${encodeURIComponent(currentCommunity.id)}/members/${encodeURIComponent(username)}`, { ban: true, reason: 'Banned by admin' });
    toast('MEMBER BANNED');
    await renderAdminPanel();
  } catch (e) { toast(String(e.message || 'COULD NOT BAN').toUpperCase()); }
}

async function renderAdminBans() {
  const wrap = document.getElementById('admin-bans');
  wrap.innerHTML = '';
  let bans = [];
  try { bans = await api.call('GET', `/api/communities/${encodeURIComponent(currentCommunity.id)}/bans`); } catch {}
  document.getElementById('admin-bans-empty').hidden = bans.length > 0;
  bans.forEach(ban => {
    const row = document.createElement('div');
    row.className = 'admin-row';
    row.innerHTML =
      `<span class="avatar sm">${avatarInner(ban)}</span>` +
      `<span class="admin-main"><strong>@${esc(ban.username)}</strong><small class="mono dim">BANNED BY @${esc(ban.bannedBy)} / ${timeAgo(ban.bannedAt)}</small></span>` +
      `<span class="admin-actions"><button class="mono">UNBAN</button></span>`;
    row.querySelector('button').addEventListener('click', async () => {
      await api.call('DELETE', `/api/communities/${encodeURIComponent(currentCommunity.id)}/bans/${encodeURIComponent(ban.username)}`);
      toast('USER UNBANNED');
      await renderAdminPanel();
    });
    wrap.appendChild(row);
  });
}

async function renderAdminInvites() {
  const wrap = document.getElementById('admin-invites');
  wrap.innerHTML = '';
  let invites = [];
  try { invites = await api.call('GET', `/api/communities/${encodeURIComponent(currentCommunity.id)}/invites`); } catch {}
  document.getElementById('admin-invites-empty').hidden = invites.length > 0;
  invites.forEach(inv => {
    const link = routeUrl(`invite/${inv.code}`);
    const row = document.createElement('div');
    row.className = 'admin-row';
    row.innerHTML =
      `<span class="admin-main"><strong>${esc(link)}</strong><small class="mono dim">CREATED BY @${esc(inv.createdBy)} / ${timeAgo(inv.created)}</small></span>` +
      `<span class="admin-actions"><button class="mono copy">COPY</button><button class="mono danger revoke">REVOKE</button></span>`;
    row.querySelector('.copy').addEventListener('click', () => copyRoute(`invite/${inv.code}`));
    row.querySelector('.revoke').addEventListener('click', async () => {
      await api.call('DELETE', '/api/invites/' + encodeURIComponent(inv.code));
      toast('INVITE REVOKED');
      await renderAdminPanel();
    });
    wrap.appendChild(row);
  });
}

async function renderAdminPrompts() {
  const wrap = document.getElementById('prompt-list');
  wrap.innerHTML = '';
  communityPrompts.forEach(prompt => {
    const row = document.createElement('div');
    row.className = 'admin-row';
    row.innerHTML =
      `<span class="admin-main"><strong>${esc(prompt.text)}</strong><small class="mono dim">${prompt.active ? 'ACTIVE' : 'PROMPT'} / @${esc(prompt.createdBy)} / ${timeAgo(prompt.created)}</small></span>` +
      `<span class="admin-actions">${prompt.active ? '' : '<button class="mono set-active">MAKE ACTIVE</button>'}<button class="mono danger delete-prompt">DELETE</button></span>`;
    const setBtn = row.querySelector('.set-active');
    if (setBtn) setBtn.addEventListener('click', () => setActivePrompt(prompt.id));
    row.querySelector('.delete-prompt').addEventListener('click', () => deletePrompt(prompt.id));
    wrap.appendChild(row);
  });
}

async function setActivePrompt(id) {
  try {
    await api.call('PUT', '/api/communities/' + encodeURIComponent(currentCommunity.id), { activePromptId: id });
    toast('PROMPT SET');
    await renderAdminPanel();
  } catch (e) { toast(String(e.message || 'COULD NOT SET PROMPT').toUpperCase()); }
}

async function deletePrompt(id) {
  if (!confirm('Delete this prompt? Photos already posted stay in the gallery.')) return;
  try {
    await api.call('DELETE', `/api/communities/${encodeURIComponent(currentCommunity.id)}/prompts/${encodeURIComponent(id)}`);
    toast('PROMPT DELETED');
    await renderAdminPanel();
  } catch (e) { toast(String(e.message || 'COULD NOT DELETE PROMPT').toUpperCase()); }
}

async function renderAdminAudit() {
  const wrap = document.getElementById('admin-audit');
  wrap.innerHTML = '';
  let rows = [];
  try { rows = await api.call('GET', `/api/communities/${encodeURIComponent(currentCommunity.id)}/audit`); } catch {}
  rows.forEach(ev => {
    const row = document.createElement('div');
    row.className = 'admin-row audit-row';
    row.innerHTML =
      `<span class="admin-main"><strong>${esc(ev.action.replace(/\./g, ' ').toUpperCase())}</strong><small class="mono dim">@${esc(ev.actor)} / ${esc(ev.target || '')} / ${timeAgo(ev.created)}</small></span>`;
    wrap.appendChild(row);
  });
}

document.getElementById('community-settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  document.getElementById('cs-err').textContent = '';
  try {
    const body = {
      name: document.getElementById('cs-name').value,
      description: document.getElementById('cs-desc').value,
      welcome: document.getElementById('cs-welcome').value,
      accent: document.getElementById('cs-accent').value,
    };
    if (csCoverData !== undefined) body.cover = csCoverData;
    currentCommunity = await api.call('PUT', '/api/communities/' + encodeURIComponent(currentCommunity.id), body);
    applyCommunityAmbient();
    updateCommunityHud();
    toast('COMMUNITY SAVED');
    await renderAdminPanel();
  } catch (err) {
    document.getElementById('cs-err').textContent = String(err.message || 'COULD NOT SAVE').toUpperCase();
  }
});
document.getElementById('cs-cover').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  csCoverData = await fileToDataURL(f);
  if (!csCoverData) document.getElementById('cs-err').textContent = "COULDN'T READ THAT IMAGE.";
});
document.getElementById('prompt-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = document.getElementById('prompt-text').value.trim();
  if (!text) { document.getElementById('prompt-err').textContent = 'WRITE A PROMPT FIRST.'; return; }
  try {
    await api.call('POST', `/api/communities/${encodeURIComponent(currentCommunity.id)}/prompts`, { text, active: true });
    document.getElementById('prompt-text').value = '';
    document.getElementById('prompt-err').textContent = '';
    toast('PROMPT CREATED');
    await renderAdminPanel();
  } catch (err) {
    document.getElementById('prompt-err').textContent = String(err.message || 'COULD NOT CREATE').toUpperCase();
  }
});
document.getElementById('admin-invite-create').addEventListener('click', async () => {
  try {
    const inv = await api.call('POST', '/api/communities/' + encodeURIComponent(currentCommunity.id) + '/invites');
    await copyRoute(`invite/${inv.code}`);
    await renderAdminPanel();
  } catch (e) { toast(String(e.message || 'COULD NOT CREATE INVITE').toUpperCase()); }
});
document.getElementById('room-close').addEventListener('click', closeCommunityRoom);
document.getElementById('room-switch').addEventListener('click', () => showCommunityHub());
document.getElementById('room-admin-open').addEventListener('click', openAdminPanel);
document.getElementById('room-prompt-upload').addEventListener('click', openUpload);
document.getElementById('admin-close').addEventListener('click', () => { closeAdminPanel(); if (adminReturn) adminReturn(); });

function openOnboarding() {
  if (!currentCommunity) return;
  document.getElementById('onboarding-title').textContent = `Welcome to ${currentCommunity.name}.`;
  onboardingModal.hidden = false;
  gsap.fromTo('#onboarding-modal .modal-box', { scale: 0.94, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.3, ease: 'power2.out' });
}
function closeOnboarding() { onboardingModal.hidden = true; }
document.getElementById('onboarding-close').addEventListener('click', closeOnboarding);
document.getElementById('onboarding-skip').addEventListener('click', closeOnboarding);
document.getElementById('onboarding-upload').addEventListener('click', () => { closeOnboarding(); openUpload(); });
document.getElementById('onboarding-profile').addEventListener('click', () => { closeOnboarding(); openPeople(me.username); });

async function logoutEverywhere() {
  try { await api.call('POST', '/api/logout'); } catch {}
  api.setToken('');
  me = null;
  allCommunities = [];
  pendingAuthAction = null;
  updateMeChip();
  loadNotifications();
  updateLandingLogin();
  await showLanding(true);
}

document.getElementById('pe-delete-account').addEventListener('click', async () => {
  if (!me) return;
  const peErr = document.getElementById('pe-err');
  peErr.textContent = '';
  if (!confirm('Permanently delete your account? This removes your profile, any communities you OWN (and all their photos), and every photo you posted. This cannot be undone.')) return;
  const password = prompt('Type your password to confirm account deletion:');
  if (!password) return;
  try {
    await api.call('DELETE', '/api/account', { password });
    api.setToken('');
    me = null;
    allCommunities = [];
    pendingAuthAction = null;
    updateMeChip();
    loadNotifications();
    updateLandingLogin();
    toast('ACCOUNT DELETED');
    await showLanding(true);
  } catch (e) {
    peErr.textContent = String(e.message || 'COULD NOT DELETE ACCOUNT').toUpperCase();
  }
});

document.getElementById('landing-login').addEventListener('click', () => { if (me) showCommunityHub(); else showAuth('login'); });
document.getElementById('hero-create').addEventListener('click', openCommunityModal);
document.getElementById('hero-invite').addEventListener('click', openEnterInviteModal);
document.getElementById('hub-create').addEventListener('click', openCommunityModal);
document.getElementById('hub-enter-invite').addEventListener('click', openEnterInviteModal);
document.getElementById('hub-back-home').addEventListener('click', () => showLanding(true));
document.getElementById('hub-logout').addEventListener('click', logoutEverywhere);
// the chicken mark doubles as a home button: it closes whatever is open and
// returns to the hero/welcome page (same as the HOME buttons).
document.querySelector('.logo').addEventListener('click', (e) => { e.preventDefault(); showLanding(true); });
document.getElementById('invite-home').addEventListener('click', () => showLanding(true));
document.getElementById('invite-login').addEventListener('click', () => { if (me) showCommunityHub(); else showAuth('login', pendingInviteCode ? { type: 'invite', code: pendingInviteCode } : null); });
document.getElementById('invite-join').addEventListener('click', () => joinInvite(pendingInviteCode));
communityChip.addEventListener('click', openCommunityRoom);
inviteToolsBtn.addEventListener('click', openAdminPanel);
recapChip.addEventListener('click', () => openRecap());
if (posterChip) posterChip.addEventListener('click', () => {
  // prefer the native share sheet where it exists (mobile), else save the file
  if (navigator.share) shareMosaicPoster();
  else downloadMosaicPoster();
});
document.getElementById('recap-close').addEventListener('click', () => { closeRecap(); clearRouteKind('recap'); });
document.getElementById('recap-download').addEventListener('click', downloadRecapCard);
document.getElementById('recap-share').addEventListener('click', () => copyRoute(communityRoute('recap')));

/* ============================================================
   TOAST
   ============================================================ */

/* ============================================================
   PEOPLE DIRECTORY + PROFILES
   ============================================================ */
const peopleEl = document.getElementById('people');
const peopleListEl = document.getElementById('people-list');
const profileView = document.getElementById('profile-view');
const peopleSearch = document.getElementById('people-search');
const peopleGrid = document.getElementById('people-grid');
const peopleEmpty = document.getElementById('people-empty');
const profileEditForm = document.getElementById('profile-edit');
const profileEditBtn = document.getElementById('profile-edit-btn');
const logoutBtn = document.getElementById('logout-btn');
let peopleOpen = false;
let allUsers = [];
let viewingProfile = null;

function openPeople(username, updateHash = true) {
  if (!currentCommunity) { showCommunityHub(); return; }
  closeRecap();
  closeAtlas();
  setNav('people');
  if (peopleOpen) { if (username) showProfile(username, updateHash); return; }
  peopleOpen = true;
  peopleEl.style.display = 'block';
  peopleEl.setAttribute('aria-hidden', 'false');
  peopleEl.scrollTop = 0;
  showPeopleList(!username);
  gsap.fromTo(peopleEl, { yPercent: 100, y: 0 }, { yPercent: 0, y: 0, duration: 0.8, ease: 'power4.inOut' });
  loadPeople().then(() => { if (username) showProfile(username, updateHash); });
}

function closePeople() {
  if (!peopleOpen) return;
  markSceneDirty();   // wake the sphere so it paints through the reveal
  if (viewingProfile) clearRouteIf(profileRoute(viewingProfile.username));
  if (!albumsOpen) setNav('gallery');
  peopleEl.setAttribute('aria-hidden', 'true');
  gsap.to(peopleEl, {
    yPercent: 100, duration: 0.7, ease: 'power3.inOut',
    onComplete: () => { peopleEl.style.display = 'none'; peopleOpen = false; },
  });
}

async function loadPeople() {
  try { allUsers = await api.call('GET', '/api/users'); }
  catch { allUsers = []; }
  renderPeople();
}

function renderPeople() {
  const q = peopleSearch.value.trim().toLowerCase();
  const list = allUsers.filter(u => !q || u.username.includes(q) || u.displayName.toLowerCase().includes(q));
  peopleGrid.innerHTML = '';
  list.forEach(u => {
    const b = document.createElement('button');
    b.className = 'person-card';
    b.innerHTML =
      `<span class="avatar">${avatarInner(u)}</span>` +
      `<span><span class="p-name">${esc(u.displayName)}</span><br>` +
      `<span class="mono dim p-sub">@${esc(u.username)} - ${u.photoCount} PHOTO${u.photoCount === 1 ? '' : 'S'}</span></span>`;
    b.addEventListener('click', () => showProfile(u.username));
    peopleGrid.appendChild(b);
  });
  peopleEmpty.hidden = list.length > 0;
}
peopleSearch.addEventListener('input', renderPeople);

function showPeopleList(clearHash = true) {
  if (clearHash) clearRouteKind('u');
  profileView.hidden = true;
  peopleListEl.hidden = false;
}

/* ============================================================
   PLACES ATLAS - browse memories grouped by where they happened
   ============================================================ */
const atlasEl = document.getElementById('atlas');
const atlasGrid = document.getElementById('atlas-grid');
const atlasEmpty = document.getElementById('atlas-empty');
const atlasSub = document.getElementById('atlas-sub');
let atlasOpen = false;
let atlasGlobe = null;   // live Three.js globe instance while the atlas is open

/* build/update the atlas globe from located places (those with coordinates);
   clicking a pin shows its place + state/country and reveals that place's card. */
function renderAtlasGlobe(places) {
  const wrap = document.getElementById('atlas-globe');
  const canvas = document.getElementById('atlas-globe-canvas');
  const label = document.getElementById('atlas-globe-label');
  const located = (places || []).filter(pl => Number.isFinite(pl.lat) && Number.isFinite(pl.lng));
  // always show the globe in the Places view; with no located photos it simply
  // shows the bare earth, inviting the user to add a location to a photo.
  wrap.hidden = false;
  label.hidden = true;
  if (!located.length) { label.textContent = 'SEARCH A PLACE ON A PHOTO TO PIN IT HERE'; label.hidden = false; }
  if (!atlasGlobe) {
    atlasGlobe = createGlobe(canvas, {
      onPick: pl => {
        const geo = [pl.state, pl.country].filter(Boolean).join(', ');
        label.textContent = geo ? `${pl.place}  ·  ${geo}` : pl.place;
        label.hidden = !label.textContent;
        const card = [...atlasGrid.querySelectorAll('.atlas-card')].find(el => el.dataset.place === (pl.place || ''));
        if (card) { card.scrollIntoView({ behavior: 'smooth', block: 'center' }); card.classList.add('atlas-card-hit'); setTimeout(() => card.classList.remove('atlas-card-hit'), 1400); }
      },
    });
  }
  atlasGlobe.setPoints(located.map(pl => ({ lat: pl.lat, lng: pl.lng, place: pl.place, country: pl.country, state: pl.state, count: pl.count })));
  requestAnimationFrame(() => atlasGlobe && atlasGlobe.resize());
}

function disposeAtlasGlobe() {
  if (atlasGlobe) { atlasGlobe.dispose(); atlasGlobe = null; }
}

/* one place card: a cover image, the place label, a photo count badge, and a
   small thumbstrip. Clicking the card opens the proven flat search filtered by
   the place; clicking a thumb opens that photo directly. All user text esc()'d
   and every image src built with mediaSrc (never '/'+value). */
function renderAtlas(data) {
  const places = (data && Array.isArray(data.places)) ? data.places : [];
  atlasGrid.innerHTML = '';
  atlasEmpty.hidden = places.length > 0;
  const parts = [];
  if (places.length) parts.push(`${places.length} PLACE${places.length === 1 ? '' : 'S'}`);
  if (data && data.unplaced) parts.push(`${data.unplaced} UNPLACED`);
  atlasSub.textContent = parts.join(' / ');
  atlasSub.hidden = !parts.length;

  renderAtlasGlobe(places);

  places.forEach(pl => {
    const card = document.createElement('div');
    card.className = 'atlas-card';
    card.dataset.place = pl.place;
    const coverFile = pl.cover && pl.cover.file;
    const cover = coverFile
      ? `<img src="${esc(mediaSrc(coverFile))}" alt="${esc(pl.place)}">`
      : '';
    card.innerHTML =
      `<button class="atlas-open" type="button">` +
      `<span class="atlas-cover">${cover}<span class="atlas-count mono">${pl.count} PHOTO${pl.count === 1 ? '' : 'S'}</span></span>` +
      `<span class="atlas-body"><span class="atlas-pin" aria-hidden="true">&#9678;</span><span class="atlas-name">${esc(pl.place)}</span></span>` +
      `</button>` +
      `<div class="atlas-thumbs"></div>`;
    card.querySelector('.atlas-open').addEventListener('click', () => openFlatSearch(pl.place));
    const thumbs = card.querySelector('.atlas-thumbs');
    (Array.isArray(pl.photos) ? pl.photos : []).forEach(ph => {
      const t = document.createElement('button');
      t.className = 'atlas-thumb';
      t.type = 'button';
      t.title = ph.title || 'UNTITLED';
      t.innerHTML = `<img src="${esc(mediaSrc(ph.file))}" alt="${esc(ph.title || '')}">`;
      // a thumb is a doorway back into the sphere; openPulsePhoto prefers the
      // local cache (fully wired detail view) else spins the sphere to it.
      t.addEventListener('click', () => openPulsePhoto(ph.id));
      thumbs.appendChild(t);
    });
    atlasGrid.appendChild(card);
  });
}

function openAtlas() {
  if (!currentCommunity) { showCommunityHub(); return; }
  closeFlatView();
  closePeople();
  closeAlbums();
  closeRecap();
  setNav('atlas');
  if (atlasOpen) return;
  atlasOpen = true;
  atlasEl.style.display = 'block';
  atlasEl.setAttribute('aria-hidden', 'false');
  atlasEl.scrollTop = 0;
  atlasGrid.innerHTML = '';
  atlasEmpty.hidden = true;
  atlasSub.hidden = true;
  gsap.fromTo(atlasEl, { yPercent: 100, y: 0 }, { yPercent: 0, y: 0, duration: 0.8, ease: 'power4.inOut' });
  loadAtlas();
}

function closeAtlas() {
  if (!atlasOpen) return;
  markSceneDirty();   // wake the sphere so it paints through the reveal
  disposeAtlasGlobe();
  if (!peopleOpen && !albumsOpen) setNav('gallery');
  atlasEl.setAttribute('aria-hidden', 'true');
  gsap.to(atlasEl, {
    yPercent: 100, duration: 0.7, ease: 'power3.inOut',
    onComplete: () => { atlasEl.style.display = 'none'; atlasOpen = false; },
  });
}

async function loadAtlas() {
  let data = null;
  try { data = await api.call('GET', `/api/communities/${encodeURIComponent(currentCommunity.id)}/places`); }
  catch { data = null; }
  if (atlasOpen) renderAtlas(data);
}

document.getElementById('atlas-close').addEventListener('click', closeAtlas);

/* ============================================================
   ALBUMS
   ============================================================ */
const albumsEl = document.getElementById('albums');
let albumsOpen = false;
let allAlbums = [];
let viewingAlbum = null;   // { album, posts }

function albumCardHTML(a) {
  const cover = a.coverFile ? ` style="background-image:url('${esc(mediaSrc(a.coverFile))}')"` : '';
  return `<div class="album-cover"${cover}>${a.coverFile ? '' : 'EMPTY'}</div>` +
    `<div class="ac-body"><div class="ac-name">${esc(a.name)}</div>` +
    `<div class="mono dim ac-sub">${a.photoCount} PHOTO${a.photoCount === 1 ? '' : 'S'} · @${esc(a.owner)}</div></div>`;
}
function renderAlbumsGrid(gridEl, list, emptyEl) {
  gridEl.innerHTML = '';
  list.forEach(a => {
    const card = document.createElement('button');
    card.className = 'album-card';
    card.innerHTML = albumCardHTML(a);
    card.addEventListener('click', () => openAlbums(a.id));
    gridEl.appendChild(card);
  });
  if (emptyEl) emptyEl.hidden = list.length > 0;
}

function openAlbums(albumId, updateHash = true) {
  if (!currentCommunity) { showCommunityHub(); return; }
  closeRecap();
  closeAtlas();
  setNav('albums');
  if (albumsOpen) { albumId ? showAlbum(albumId, updateHash) : showAlbumsList(); return; }
  albumsOpen = true;
  albumsEl.style.display = 'block';
  albumsEl.setAttribute('aria-hidden', 'false');
  albumsEl.scrollTop = 0;
  showAlbumsList(!albumId);
  gsap.fromTo(albumsEl, { yPercent: 100, y: 0 }, { yPercent: 0, y: 0, duration: 0.8, ease: 'power4.inOut' });
  loadAlbums().then(() => { if (albumId) showAlbum(albumId, updateHash); });
}
function closeAlbums() {
  if (!albumsOpen) return;
  markSceneDirty();   // wake the sphere so it paints through the reveal
  if (viewingAlbum) clearRouteIf(albumRoute(viewingAlbum.album.id));
  if (!peopleOpen) setNav('gallery');
  albumsEl.setAttribute('aria-hidden', 'true');
  gsap.to(albumsEl, {
    yPercent: 100, duration: 0.7, ease: 'power3.inOut',
    onComplete: () => { albumsEl.style.display = 'none'; albumsOpen = false; },
  });
}
function showAlbumsList(clearHash = true) {
  if (clearHash) clearRouteKind('album');
  document.getElementById('album-page').hidden = true;
  document.getElementById('albums-list').hidden = false;
}
async function loadAlbums() {
  try { allAlbums = await api.call('GET', '/api/albums'); } catch { allAlbums = []; }
  renderAlbumsGrid(document.getElementById('albums-grid'), allAlbums, document.getElementById('albums-empty'));
}

async function showAlbum(id, updateHash = true) {
  let data;
  try { data = await api.call('GET', '/api/albums/' + encodeURIComponent(id)); }
  catch (e) { toast(String(e.message || 'ALBUM NOT FOUND').toUpperCase()); return; }
  viewingAlbum = data;
  const a = data.album;
  if (updateHash) setRoute(albumRoute(a.id));
  document.getElementById('albums-list').hidden = true;
  document.getElementById('album-page').hidden = false;
  document.getElementById('album-edit-form').hidden = true;
  albumsEl.scrollTop = 0;
  document.getElementById('album-name').textContent = a.name;
  document.getElementById('album-meta').textContent = `@${a.owner} · ${a.photoCount} PHOTO${a.photoCount === 1 ? '' : 'S'}`;
  document.getElementById('album-desc').textContent = a.description || '';
  const own = me && (me.username === a.owner || isAdminProfile() || isCommunityAdmin());
  document.getElementById('album-actions').hidden = !own;
  // the contact sheet needs at least one photo; hide the action for empty albums
  document.getElementById('album-contact-sheet').hidden = data.posts.length === 0;
  document.getElementById('album-sheet-building').hidden = true;
  renderAlbumPhotos(data, own);
}

function renderAlbumPhotos(data, own) {
  const wrap = document.getElementById('album-photos');
  wrap.innerHTML = '';
  wrap.classList.toggle('is-owner', !!own);
  // snapshot of the current order; a settled drop compares against it to skip no-ops
  const order = data.posts.map(p => p.id);
  data.posts.forEach(post => {
    const tile = document.createElement('div');
    tile.className = 'pp-tile';
    tile.dataset.id = post.id;
    const img = document.createElement('img');
    img.src = mediaSrc(post.file); img.alt = post.title; img.title = post.title;
    img.draggable = false;
    tile.appendChild(img);
    const isCover = data.album.cover === post.id;
    if (isCover) {
      const badge = document.createElement('span');
      badge.className = 'ap-cover-badge';
      badge.textContent = 'COVER';
      tile.appendChild(badge);
    }
    tile.addEventListener('click', (e) => {
      if (e.target.closest('.ap-actions')) return;
      openDetailFor(postToProject(post));
    });
    if (own) {
      const actions = document.createElement('div');
      actions.className = 'ap-actions';
      const coverBtn = document.createElement('button');
      coverBtn.className = 'ap-btn ap-cover-btn' + (isCover ? ' is-cover' : '');
      coverBtn.textContent = isCover ? 'COVER' : 'SET AS COVER';
      coverBtn.title = 'Set as album cover';
      coverBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (isCover) return;
        albumOp({ cover: post.id }, 'COVER SET');
      });
      const rm = document.createElement('button');
      rm.className = 'ap-btn ap-rm-btn'; rm.textContent = '✕'; rm.title = 'Remove from album';
      rm.addEventListener('click', (e) => { e.stopPropagation(); albumOp({ removePhotoId: post.id }, 'REMOVED FROM ALBUM'); });
      actions.appendChild(coverBtn); actions.appendChild(rm);
      tile.appendChild(actions);
      makeTileDraggable(tile, wrap, order);
    }
    wrap.appendChild(tile);
  });
  document.getElementById('album-no-photos').hidden = data.posts.length > 0;
}

/* Make an album tile reorderable via HTML5 drag-and-drop (mouse) with a
   pointer fallback for touch. `order` is the render-time id sequence; a settled
   drop reads the DOM and only persists when the order actually changed (a real
   reorder re-renders the album, so this snapshot never needs updating). */
function makeTileDraggable(tile, wrap, order) {
  tile.draggable = true;
  tile.classList.add('ap-draggable');

  const persist = () => {
    const next = [...wrap.querySelectorAll('.pp-tile')].map(t => t.dataset.id);
    if (next.length === order.length && next.every((id, i) => id === order[i])) return;
    albumOp({ photoIds: next }, 'ORDER SAVED');
  };
  const clearMarks = () => {
    wrap.querySelectorAll('.pp-tile.ap-over').forEach(t => t.classList.remove('ap-over'));
  };
  // slot `moving` before/after `target` depending on which half the pointer is over
  const insertAt = (moving, target, x, y) => {
    const box = target.getBoundingClientRect();
    const after = (y - box.top) > box.height / 2 || (x - box.left) > box.width / 2;
    wrap.insertBefore(moving, after ? target.nextSibling : target);
  };

  /* ---- native drag-and-drop (desktop) ---- */
  tile.addEventListener('dragstart', (e) => {
    tile.classList.add('ap-dragging');
    if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', tile.dataset.id); } catch {} }
  });
  tile.addEventListener('dragend', () => {
    tile.classList.remove('ap-dragging');
    clearMarks();
    persist();
  });
  tile.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    const dragging = wrap.querySelector('.pp-tile.ap-dragging');
    if (!dragging || dragging === tile) return;
    clearMarks();
    tile.classList.add('ap-over');
    insertAt(dragging, tile, e.clientX, e.clientY);
  });
  tile.addEventListener('drop', (e) => { e.preventDefault(); clearMarks(); });

  /* ---- pointer fallback (touch) ---- */
  let touchDragging = false;
  tile.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;  // native DnD handles mouse
    if (e.target.closest('.ap-actions')) return;
    let started = false;
    const startY = e.clientY, startX = e.clientX;
    const move = (ev) => {
      if (!started) {
        if (Math.abs(ev.clientY - startY) < 8 && Math.abs(ev.clientX - startX) < 8) return;
        started = true; touchDragging = true;
        tile.classList.add('ap-dragging');
        try { tile.setPointerCapture(e.pointerId); } catch {}
      }
      ev.preventDefault();
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      const over = el && el.closest && el.closest('.pp-tile');
      if (!over || over === tile || over.parentElement !== wrap) return;
      insertAt(tile, over, ev.clientX, ev.clientY);
    };
    const up = () => {
      tile.removeEventListener('pointermove', move);
      tile.removeEventListener('pointerup', up);
      tile.removeEventListener('pointercancel', up);
      try { tile.releasePointerCapture(e.pointerId); } catch {}
      if (started) { tile.classList.remove('ap-dragging'); clearMarks(); persist(); }
      setTimeout(() => { touchDragging = false; }, 0);
    };
    tile.addEventListener('pointermove', move);
    tile.addEventListener('pointerup', up);
    tile.addEventListener('pointercancel', up);
  });
  // swallow the click that follows a touch drag so it does not open the photo
  tile.addEventListener('click', (e) => { if (touchDragging) { e.stopPropagation(); e.preventDefault(); } }, true);
}

async function albumOp(body, okMsg) {
  if (!viewingAlbum) return;
  try {
    await api.call('PUT', '/api/albums/' + viewingAlbum.album.id, body);
    if (okMsg) toast(okMsg);
    await showAlbum(viewingAlbum.album.id);
    loadAlbums();
  } catch (e) { toast(String(e.message || 'COULD NOT UPDATE').toUpperCase()); }
}

document.getElementById('albums-close').addEventListener('click', closeAlbums);
document.getElementById('album-back').addEventListener('click', showAlbumsList);

/* album edit (name / description) */
document.getElementById('album-edit-btn').addEventListener('click', () => {
  document.getElementById('ae-name').value = viewingAlbum.album.name;
  document.getElementById('ae-desc').value = viewingAlbum.album.description || '';
  document.getElementById('ae-err').textContent = '';
  document.getElementById('album-edit-form').hidden = false;
});
document.getElementById('ae-cancel').addEventListener('click', () => {
  document.getElementById('album-edit-form').hidden = true;
});
document.getElementById('album-edit-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api.call('PUT', '/api/albums/' + viewingAlbum.album.id, {
      name: document.getElementById('ae-name').value,
      description: document.getElementById('ae-desc').value,
    });
    toast('ALBUM SAVED');
    await showAlbum(viewingAlbum.album.id);
    loadAlbums();
  } catch (e2) { document.getElementById('ae-err').textContent = String(e2.message || 'COULD NOT SAVE').toUpperCase(); }
});

document.getElementById('album-delete-btn').addEventListener('click', async () => {
  if (!viewingAlbum) return;
  if (!confirm(`Delete the album "${viewingAlbum.album.name}"? Your photos stay in the gallery.`)) return;
  try {
    await api.call('DELETE', '/api/albums/' + viewingAlbum.album.id);
    toast('ALBUM DELETED');
    showAlbumsList();
    loadAlbums();
  } catch (e) { toast(String(e.message || 'COULD NOT DELETE').toUpperCase()); }
});

/* create-album modal (used from Albums overlay, profile, and add-to-album) */
const albumModal = document.getElementById('album-modal');
let albumModalAddPhotoId = null;
function openAlbumModal(addPhotoId) {
  if (!currentCommunity) { showCommunityHub(); return; }
  albumModalAddPhotoId = addPhotoId || null;
  document.getElementById('am-name').value = '';
  document.getElementById('am-desc').value = '';
  document.getElementById('am-err').textContent = '';
  albumModal.hidden = false;
  gsap.fromTo('#album-modal .modal-box', { scale: 0.94, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.3, ease: 'power2.out' });
}
function closeAlbumModal() { albumModal.hidden = true; }
document.getElementById('album-modal-close').addEventListener('click', closeAlbumModal);
albumModal.addEventListener('pointerdown', (e) => { if (e.target === albumModal) closeAlbumModal(); });
document.getElementById('albums-new').addEventListener('click', () => openAlbumModal());
document.getElementById('profile-new-album').addEventListener('click', () => openAlbumModal());

document.getElementById('am-create').addEventListener('click', async () => {
  const name = document.getElementById('am-name').value.trim();
  if (!name) { document.getElementById('am-err').textContent = 'GIVE THE ALBUM A NAME.'; return; }
  try {
    const album = await api.call('POST', '/api/albums', {
      name,
      description: document.getElementById('am-desc').value,
      photoIds: albumModalAddPhotoId ? [albumModalAddPhotoId] : [],
    });
    closeAlbumModal();
    toast('ALBUM CREATED');
    if (albumsOpen) { await loadAlbums(); showAlbum(album.id); }
    if (peopleOpen && me && !profileView.hidden) showProfile(me.username);
  } catch (e) { document.getElementById('am-err').textContent = String(e.message || 'COULD NOT CREATE').toUpperCase(); }
});

/* add-to-album modal (from a photo's detail page) */
const pickAlbumModal = document.getElementById('pick-album-modal');
let pickAlbumPhotoId = null;
async function openPickAlbum(photoId) {
  stopSlideshow();   // do not keep auto-advancing behind the modal
  pickAlbumPhotoId = photoId;
  pickAlbumModal.hidden = false;
  gsap.fromTo('#pick-album-modal .modal-box', { scale: 0.94, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.3, ease: 'power2.out' });
  await renderPickAlbum();
}
function closePickAlbum() { pickAlbumModal.hidden = true; }
async function renderPickAlbum() {
  const listEl = document.getElementById('pick-album-list');
  listEl.innerHTML = '';
  let mine = [];
  try { mine = await api.call('GET', '/api/albums?user=' + encodeURIComponent(me.username)); } catch {}
  document.getElementById('pick-album-empty').hidden = mine.length > 0;
  for (const a of mine) {
    let inAlbum = false;
    try { const d = await api.call('GET', '/api/albums/' + a.id); inAlbum = d.posts.some(p => p.id === pickAlbumPhotoId); } catch {}
    const row = document.createElement('button');
    row.className = 'pick-album-row' + (inAlbum ? ' in' : '');
    row.innerHTML = `<span>${esc(a.name)}</span><span class="pa-count">${inAlbum ? 'ADDED ✓' : a.photoCount + ' PHOTOS'}</span>`;
    row.addEventListener('click', async () => {
      try {
        await api.call('PUT', '/api/albums/' + a.id, inAlbum ? { removePhotoId: pickAlbumPhotoId } : { addPhotoId: pickAlbumPhotoId });
        toast(inAlbum ? 'REMOVED FROM ALBUM' : 'ADDED TO ALBUM');
        renderPickAlbum();
        if (albumsOpen && viewingAlbum && viewingAlbum.album.id === a.id) showAlbum(a.id);
      } catch (e) { toast(String(e.message || '').toUpperCase()); }
    });
    listEl.appendChild(row);
  }
}
document.getElementById('pick-album-close').addEventListener('click', closePickAlbum);
pickAlbumModal.addEventListener('pointerdown', (e) => { if (e.target === pickAlbumModal) closePickAlbum(); });
document.getElementById('pick-album-new').addEventListener('click', () => { closePickAlbum(); openAlbumModal(pickAlbumPhotoId); });
document.getElementById('d-add-album-btn').addEventListener('click', () => {
  if (detailProject && detailProject.postId) openPickAlbum(detailProject.postId);
});

/* add-photos-to-album modal (from the album page) */
const addPhotosModal = document.getElementById('add-photos-modal');
async function openAddPhotos() {
  if (!viewingAlbum) return;
  addPhotosModal.hidden = false;
  gsap.fromTo('#add-photos-modal .modal-box', { scale: 0.94, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.3, ease: 'power2.out' });
  await renderAddPhotos();
}
function closeAddPhotos() { addPhotosModal.hidden = true; }
async function renderAddPhotos() {
  const grid = document.getElementById('add-photos-grid');
  grid.innerHTML = '';
  const owner = viewingAlbum.album.owner;
  let mine = [];
  try { const d = await api.call('GET', '/api/user/' + encodeURIComponent(owner)); mine = d.posts; } catch {}
  document.getElementById('add-photos-empty').hidden = mine.length > 0;
  const inSet = new Set(viewingAlbum.posts.map(p => p.id));
  mine.forEach(post => {
    const tile = document.createElement('button');
    tile.className = 'ap-pick' + (inSet.has(post.id) ? ' in' : '');
    tile.innerHTML = `<img src="${esc(mediaSrc(post.file))}" alt=""><span class="ap-check">✓</span>`;
    tile.addEventListener('click', async () => {
      const has = tile.classList.contains('in');
      try {
        await api.call('PUT', '/api/albums/' + viewingAlbum.album.id, has ? { removePhotoId: post.id } : { addPhotoId: post.id });
        tile.classList.toggle('in');
        // refresh underlying album view data without closing the modal
        const d = await api.call('GET', '/api/albums/' + viewingAlbum.album.id);
        viewingAlbum = d;
      } catch (e) { toast(String(e.message || '').toUpperCase()); }
    });
    grid.appendChild(tile);
  });
}
document.getElementById('album-add-photos-btn').addEventListener('click', openAddPhotos);
document.getElementById('add-photos-close').addEventListener('click', () => { closeAddPhotos(); if (viewingAlbum) { showAlbum(viewingAlbum.album.id); loadAlbums(); } });
document.getElementById('add-photos-done').addEventListener('click', () => { closeAddPhotos(); if (viewingAlbum) { showAlbum(viewingAlbum.album.id); loadAlbums(); } });
addPhotosModal.addEventListener('pointerdown', (e) => { if (e.target === addPhotosModal) { closeAddPhotos(); if (viewingAlbum) { showAlbum(viewingAlbum.album.id); loadAlbums(); } } });

async function showProfile(username, updateHash = true) {
  let data;
  try { data = await api.call('GET', '/api/user/' + encodeURIComponent(username)); }
  catch (e) { toast(String(e.message || 'USER NOT FOUND').toUpperCase()); return; }
  viewingProfile = data.profile;
  const p = data.profile;
  if (updateHash) setRoute(profileRoute(p.username));
  const own = me && me.username === p.username;
  const canModeratePhotos = own || isAdminProfile() || isCommunityAdmin();

  peopleListEl.hidden = true;
  profileView.hidden = false;
  profileEditForm.hidden = true;
  peopleEl.scrollTop = 0;

  document.getElementById('profile-avatar').innerHTML = avatarInner(p);
  const coverEl = document.getElementById('profile-cover');
  if (p.cover) { coverEl.style.backgroundImage = `url("${esc(mediaSrc(p.cover))}")`; coverEl.hidden = false; }
  else { coverEl.hidden = true; coverEl.style.backgroundImage = ''; }
  document.getElementById('profile-name').textContent = p.displayName;
  document.getElementById('profile-username').textContent = '@' + p.username;
  document.getElementById('profile-meta').textContent =
    `JOINED ${new Date(p.joined).getFullYear()} - ${p.photoCount} PHOTO${p.photoCount === 1 ? '' : 'S'}` +
    (p.location ? ` - ${p.location.toUpperCase()}` : '');
  document.getElementById('profile-bio').textContent = p.bio || (own ? 'No bio yet - hit EDIT PROFILE to add one.' : '');
  const links = document.getElementById('profile-links');
  links.innerHTML = '';
  if (p.website) {
    const a = document.createElement('a');
    const href = /^https?:\/\//i.test(p.website) ? p.website : 'https://' + p.website;
    a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer';
    a.textContent = p.website.toUpperCase();
    links.appendChild(a);
  }
  profileEditBtn.hidden = !own;
  logoutBtn.hidden = !own;

  const photosEl = document.getElementById('profile-photos');
  photosEl.innerHTML = '';
  data.posts.forEach(post => {
    const tile = document.createElement('div');
    tile.className = 'pp-tile';
    const img = document.createElement('img');
    img.src = mediaSrc(post.file);
    img.alt = post.title;
    img.title = post.title;
    tile.appendChild(img);
    tile.style.cursor = 'pointer';
    tile.addEventListener('click', (e) => {
      if (e.target.closest('.pp-del')) return;
      openDetailFor(postToProject(post));
    });
    if (canModeratePhotos) {
      const del = document.createElement('button');
      del.className = 'pp-del';
      del.textContent = '✕';
      del.title = 'Delete photo';
      del.addEventListener('click', async () => {
        if (!confirm('Delete this photo from the gallery? This cannot be undone.')) return;
        try {
          await api.call('DELETE', '/api/photos/' + post.id);
          communityPosts = communityPosts.filter(x => x.id !== post.id);
          toast('PHOTO DELETED');
          await rebuildGallery();
          showProfile(p.username);
        } catch (err) {
          toast(String(err.message || 'COULD NOT DELETE').toUpperCase());
        }
      });
      tile.appendChild(del);
    }
    photosEl.appendChild(tile);
  });
  document.getElementById('profile-no-photos').hidden = data.posts.length > 0;

  // albums owned by this user
  document.getElementById('profile-new-album').hidden = !own;
  let uAlbums = [];
  try { uAlbums = await api.call('GET', '/api/albums?user=' + encodeURIComponent(p.username)); } catch {}
  renderAlbumsGrid(document.getElementById('profile-albums'), uAlbums, document.getElementById('profile-no-albums'));
}

/* avatar/cover edit state: undefined = unchanged, '' = remove, dataURL = new image */
let peAvatarData, peCoverData;
const peAvatarPreview = document.getElementById('pe-avatar-preview');
const peCoverPreview = document.getElementById('pe-cover-preview');

function setEditAvatarPreview(profileLike) {
  peAvatarPreview.innerHTML = avatarInner(profileLike);
}
function setEditCoverPreview(url) {
  if (url) { peCoverPreview.style.backgroundImage = `url("${url}")`; peCoverPreview.classList.add('has'); }
  else { peCoverPreview.style.backgroundImage = ''; peCoverPreview.classList.remove('has'); }
}

profileEditBtn.addEventListener('click', () => {
  document.getElementById('pe-name').value = viewingProfile.displayName;
  document.getElementById('pe-bio').value = viewingProfile.bio;
  document.getElementById('pe-location').value = viewingProfile.location;
  document.getElementById('pe-website').value = viewingProfile.website;
  document.getElementById('pe-err').textContent = '';
  peAvatarData = undefined; peCoverData = undefined;
  setEditAvatarPreview(viewingProfile);
  setEditCoverPreview(viewingProfile.cover ? mediaSrc(viewingProfile.cover) : '');
  profileEditForm.hidden = false;
  profileEditBtn.hidden = true;
});
document.getElementById('pe-cancel').addEventListener('click', () => {
  profileEditForm.hidden = true;
  profileEditBtn.hidden = false;
});

document.getElementById('pe-avatar-file').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  const url = await fileToDataURL(f);
  if (!url) { document.getElementById('pe-err').textContent = "COULDN'T READ THAT IMAGE."; return; }
  peAvatarData = url;
  setEditAvatarPreview({ avatar: url });
});
document.getElementById('pe-avatar-clear').addEventListener('click', () => {
  peAvatarData = '';
  setEditAvatarPreview({ displayName: viewingProfile.displayName, username: viewingProfile.username });
});
document.getElementById('pe-cover-file').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  const url = await fileToDataURL(f);
  if (!url) { document.getElementById('pe-err').textContent = "COULDN'T READ THAT IMAGE."; return; }
  peCoverData = url;
  setEditCoverPreview(url);
});
document.getElementById('pe-cover-clear').addEventListener('click', () => {
  peCoverData = '';
  setEditCoverPreview('');
});

profileEditForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const body = {
      displayName: document.getElementById('pe-name').value,
      bio: document.getElementById('pe-bio').value,
      location: document.getElementById('pe-location').value,
      website: document.getElementById('pe-website').value,
    };
    if (peAvatarData !== undefined) body.avatar = peAvatarData;
    if (peCoverData !== undefined) body.cover = peCoverData;
    me = await api.call('PUT', '/api/profile', body);
    updateMeChip();
    toast('PROFILE SAVED');
    loadPeople();            // refresh directory cards with the new avatar
    showProfile(me.username);
  } catch (err) {
    document.getElementById('pe-err').textContent = String(err.message || 'COULD NOT SAVE').toUpperCase();
  }
});

logoutBtn.addEventListener('click', async () => {
  await logoutEverywhere();
});

document.getElementById('lets-talk').addEventListener('click', () => openPeople());
document.getElementById('people-close').addEventListener('click', closePeople);
document.getElementById('profile-back').addEventListener('click', showPeopleList);

/* ============================================================
   UPLOAD - post a photo to the wall
   ============================================================ */
const uploadModal = document.getElementById('upload-modal');
const uploadFile = document.getElementById('upload-file');
const uploadPreview = document.getElementById('upload-preview');
const uploadBatch = document.getElementById('upload-batch');
const uploadTitle = document.getElementById('upload-title');
const uploadLayout = document.getElementById('upload-layout');
const uploadPrompt = document.getElementById('upload-prompt');
const uploadErr = document.getElementById('upload-err');
const uploadSubmit = document.getElementById('upload-submit');
const dropZone = document.getElementById('drop-zone');
let uploadData = null;
let uploadQueue = [];

let getUploadScopes = () => [];

function openUpload() {
  if (!me) { showAuth('login'); return; }
  if (!currentCommunity) { showCommunityHub(); return; }
  uploadErr.textContent = '';
  document.getElementById('upload-year').value = new Date().getFullYear();
  if (!document.getElementById('upload-client').value) {
    document.getElementById('upload-client').value = me.displayName;
  }
  getUploadScopes = buildScopeChips(document.getElementById('upload-scopes'), ['PHOTO']);
  document.getElementById('upload-place').value = '';
  resetUploadPlace('', null);   // fresh upload: never inherit a prior photo's picked location
  renderUploadPrompts();
  uploadModal.hidden = false;
  gsap.fromTo('.modal-box', { scale: 0.94, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.3, ease: 'power2.out' });
  // pop the file explorer right away (still within the click gesture)
  if (!uploadQueue.length) uploadFile.click();
}

function renderUploadPrompts() {
  uploadPrompt.innerHTML = '<option value="">NO PROMPT</option>';
  communityPrompts.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.text;
    opt.selected = p.id === currentCommunity.activePromptId;
    uploadPrompt.appendChild(opt);
  });
}

document.getElementById('upload-btn').addEventListener('click', openUpload);
document.getElementById('empty-upload').addEventListener('click', openUpload);
function closeUpload() { uploadModal.hidden = true; }
document.getElementById('upload-close').addEventListener('click', closeUpload);
uploadModal.addEventListener('pointerdown', (e) => { if (e.target === uploadModal) closeUpload(); });

async function fileToDataURL(file) {
  try {
    const bmp = await createImageBitmap(file);
    const MAX = 1600;
    const s = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * s);
    c.height = Math.round(bmp.height * s);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.88);
  } catch { return null; }
}

uploadFile.addEventListener('change', async () => {
  const files = [...uploadFile.files];
  if (!files.length) return;
  uploadErr.textContent = '';
  uploadQueue = [];
  for (const f of files) {
    const data = await fileToDataURL(f);
    if (data) uploadQueue.push({ data, name: f.name.replace(/\.[^.]+$/, '') });
  }
  if (!uploadQueue.length) { uploadErr.textContent = "COULDN'T READ THOSE IMAGES."; return; }
  uploadData = uploadQueue[0].data;
  uploadPreview.src = uploadQueue[0].data;
  uploadPreview.hidden = uploadQueue.length !== 1;
  uploadBatch.innerHTML = uploadQueue.map(item => `<span>${esc(item.name)}</span>`).join('');
  dropZone.firstChild.textContent = 'CHANGE PHOTO';
});

/* Place search: turn a PLACE text field into a geocoding search. Typing queries
   /api/geocode (OpenStreetMap, server-side); picking a result stores the real
   location (lat/lng + country/state) via setGeo so it can pin on the atlas
   globe. Editing the text after a pick drops the coordinates so no stale pin is
   saved. Derived from the input's own value - no per-field special-casing. */
let uploadGeo = null;   // chosen location for the current upload (null = none picked)
let editGeo = null;     // chosen location for the detail edit form
function wirePlaceSearch(input, setGeo) {
  if (!input) return () => {};
  const wrap = input.parentElement;
  wrap.style.position = 'relative';
  const menu = document.createElement('div');
  menu.className = 'place-results';
  menu.hidden = true;
  wrap.appendChild(menu);
  let timer = null, picked = '';
  const close = () => { menu.hidden = true; menu.innerHTML = ''; };
  input.setAttribute('autocomplete', 'off');
  input.addEventListener('input', () => {
    if (input.value.trim() !== picked) setGeo(null);
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { close(); return; }
    timer = setTimeout(async () => {
      let results = [];
      try { const r = await api.call('GET', '/api/geocode?q=' + encodeURIComponent(q)); results = r.results || []; }
      catch { results = []; }
      if (input.value.trim() !== q) return;   // a newer keystroke superseded this
      if (!results.length) { close(); return; }
      menu.innerHTML = '';
      results.slice(0, 6).forEach(res => {
        const opt = document.createElement('button');
        opt.type = 'button';
        opt.className = 'place-result mono';
        opt.textContent = res.label;
        opt.addEventListener('click', () => {
          input.value = res.label;
          picked = res.label;
          setGeo({ lat: res.lat, lng: res.lng, country: res.country, state: res.state });
          close();
        });
        menu.appendChild(opt);
      });
      menu.hidden = false;
    }, 350);
  });
  input.addEventListener('blur', () => setTimeout(close, 160));   // let a click land first
  // Sync the field to a known place + geo when a form opens. Without this the last
  // picked location stays live and would be saved onto the next photo edited.
  return (label, geo) => { picked = (label || '').trim(); setGeo(geo || null); close(); };
}
const resetUploadPlace = wirePlaceSearch(document.getElementById('upload-place'), g => { uploadGeo = g; });
const resetEditPlace = wirePlaceSearch(document.getElementById('de-place'), g => { editGeo = g; });

uploadSubmit.addEventListener('click', async () => {
  if (!uploadQueue.length) { uploadErr.textContent = 'PICK AN IMAGE FIRST.'; return; }
  uploadSubmit.disabled = true;
  uploadErr.textContent = '';
  try {
    const uploaded = [];
    for (const item of uploadQueue) {
      const post = await api.call('POST', '/api/photos', {
        title: uploadTitle.value.trim() || item.name,
        image: item.data,
        layout: uploadLayout.value,
        year: document.getElementById('upload-year').value,
        client: document.getElementById('upload-client').value.trim(),
        place: document.getElementById('upload-place').value.trim(),
        ...(uploadGeo || {}),
        caption: document.getElementById('upload-caption').value.trim(),
        tags: getUploadScopes(),
        promptId: uploadPrompt.value,
      });
      uploaded.push(post);
    }
    communityPosts = [...uploaded.reverse(), ...communityPosts];
    closeUpload();
    uploadData = null;
    uploadQueue = [];
    uploadPreview.hidden = true;
    uploadBatch.innerHTML = '';
    uploadTitle.value = '';
    document.getElementById('upload-place').value = '';
    resetUploadPlace('', null);
    document.getElementById('upload-caption').value = '';
    dropZone.firstChild.textContent = 'CLICK TO CHOOSE A PHOTO';
    await loadCommunityExtras();
    toast(uploaded.length === 1 ? 'POSTED TO THE WALL' : `${uploaded.length} PHOTOS POSTED`);
    await rebuildGallery();
  } catch (err) {
    uploadErr.textContent = String(err.message || 'UPLOAD FAILED').toUpperCase();
  } finally {
    uploadSubmit.disabled = false;
  }
});

/* ============================================================
   SHAREABLE LINKS / HASH ROUTER
   ============================================================ */
let mutedHash = '';

function routePath() {
  const raw = (location.hash || '').replace(/^#\/?/, '').replace(/^\/+/, '').replace(/\/+$/, '');
  try { return decodeURIComponent(raw); }
  catch { return raw; }
}

function routeParts() {
  const path = routePath();
  return path ? path.split('/').filter(Boolean) : [];
}

function setRoute(path) {
  if (!path) return;
  const next = '#/' + String(path).replace(/^\/+/, '');
  if (location.hash === next) return;
  mutedHash = next;
  location.hash = next;
  setTimeout(() => { if (mutedHash === next) mutedHash = ''; }, 80);
}

function replaceRoute(path) {
  if (path) history.replaceState(null, '', location.pathname + location.search + '#/' + path);
  else history.replaceState(null, '', location.pathname + location.search);
}

function communityRoute(extra = '') {
  if (!currentCommunity) return '';
  const base = `c/${currentCommunity.slug || currentCommunity.id}`;
  return extra ? `${base}/${String(extra).replace(/^\/+/, '')}` : base;
}

function photoRoute(id, communityId = currentCommunity && (currentCommunity.slug || currentCommunity.id)) {
  return communityId ? `c/${communityId}/photo/${id}` : `photo/${id}`;
}

function profileRoute(username, communityId = currentCommunity && (currentCommunity.slug || currentCommunity.id)) {
  return communityId ? `c/${communityId}/u/${username}` : `u/${username}`;
}

function albumRoute(id, communityId = currentCommunity && (currentCommunity.slug || currentCommunity.id)) {
  return communityId ? `c/${communityId}/album/${id}` : `album/${id}`;
}

function clearRouteIf(path) {
  if (routePath() !== path) return;
  replaceRoute(communityRoute());
}

function clearRouteKind(kind) {
  const parts = routeParts();
  const matches = parts[0] === kind || (parts[0] === 'c' && parts[2] === kind);
  if (!matches) return;
  replaceRoute(communityRoute());
}

function routeUrl(path) {
  return location.origin + location.pathname + location.search + '#/' + path;
}

async function copyRoute(path) {
  const url = routeUrl(path);
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(url);
    else {
      const input = document.createElement('textarea');
      input.value = url;
      input.style.position = 'fixed';
      input.style.opacity = '0';
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      input.remove();
    }
    toast('LINK COPIED');
  } catch {
    toast('COPY FAILED');
  }
}

let hashRouteSeq = 0;
async function handleHashRoute() {
  // route generation: if a newer hashchange fires while we await, abandon this
  // run so overlapping navigations can't land on the wrong overlay/photo.
  const g = ++hashRouteSeq;
  if (location.hash === mutedHash) { mutedHash = ''; return; }
  const parts = routeParts();
  const [kind, id] = parts;
  if (!kind) {
    if (detail.style.display === 'block') closeProject();
    if (flatOpen) closeFlatView();
    if (albumsOpen) closeAlbums();
    if (peopleOpen) closePeople();
    if (atlasOpen) closeAtlas();
    if (me) await showCommunityHub(false);
    else await showLanding(false);
    return;
  }

  if (kind === 'invite' && id) {
    await showInvite(id);
    return;
  }

  if (kind === 'c' && id) {
    const cid = id;
    const view = parts[2] || '';
    const itemId = parts[3] || '';
    if (!me) {
      showAuth('login', { type: 'route', path: parts.join('/') });
      return;
    }
    if (!currentCommunity || (currentCommunity.id !== cid && currentCommunity.slug !== cid)) {
      const ok = await enterCommunity(cid, false);
      if (!ok || g !== hashRouteSeq) return;
    }
    if (!view) {
      if (detail.style.display === 'block') closeProject();
      if (flatOpen) closeFlatView();
      if (albumsOpen) closeAlbums();
      if (peopleOpen) closePeople();
      if (atlasOpen) closeAtlas();
      setNav('gallery');
      return;
    }
    if (view === 'saved') {
      if (detail.style.display === 'block') closeProject();
      closeAlbums();
      closePeople();
      openSaved();
      return;
    }
    if (view === 'recap') {
      closeFlatView();
      closeAlbums();
      closePeople();
      closeAtlas();
      await openRecap(false);
      return;
    }
    if (view === 'photo' && itemId) {
      closeFlatView();
      closeAlbums();
      closePeople();
      closeAtlas();
      let post = communityPosts.find(p => p.id === itemId);
      if (!post) {
        await refreshCommunity();
        if (g !== hashRouteSeq) return;
        buildPool();
        post = communityPosts.find(p => p.id === itemId);
      }
      if (post) openDetailFor(postToProject(post), false);
      else toast('PHOTO NOT FOUND');
      return;
    }
    if (view === 'u' && itemId) {
      if (detail.style.display === 'block') closeProject();
      closeFlatView();
      closeAlbums();
      openPeople(itemId, false);
      return;
    }
    if (view === 'album' && itemId) {
      if (detail.style.display === 'block') closeProject();
      closeFlatView();
      closePeople();
      openAlbums(itemId, false);
      return;
    }
    toast('LINK NOT FOUND');
    return;
  }

  if (kind === 'photo' && id) {
    if (!currentCommunity) { if (me) await showCommunityHub(false); else await showLanding(false); return; }
    closeFlatView();
    closeAlbums();
    closePeople();
    closeAtlas();
    let post = communityPosts.find(p => p.id === id);
    if (!post) {
      await refreshCommunity();
      if (g !== hashRouteSeq) return;
      buildPool();
      post = communityPosts.find(p => p.id === id);
    }
    if (post) openDetailFor(postToProject(post), false);
    else toast('PHOTO NOT FOUND');
    return;
  }

  if (kind === 'u' && id) {
    if (!currentCommunity) { if (me) await showCommunityHub(false); else await showLanding(false); return; }
    if (detail.style.display === 'block') closeProject();
    closeFlatView();
    closeAlbums();
    openPeople(id, false);
    return;
  }

  if (kind === 'album' && id) {
    if (!currentCommunity) { if (me) await showCommunityHub(false); else await showLanding(false); return; }
    if (detail.style.display === 'block') closeProject();
    closeFlatView();
    closePeople();
    openAlbums(id, false);
    return;
  }

  if (kind === 'saved') {
    if (!currentCommunity) { if (me) await showCommunityHub(false); else await showLanding(false); return; }
    if (detail.style.display === 'block') closeProject();
    closeAlbums();
    closePeople();
    openSaved();
    return;
  }

  if (me) await showCommunityHub(false);
  else await showLanding(false);
}

window.addEventListener('hashchange', handleHashRoute);
document.getElementById('d-share').addEventListener('click', () => {
  if (detailProject && detailProject.postId) copyRoute(photoRoute(detailProject.postId));
});
document.getElementById('d-locate').addEventListener('click', () => {
  if (detailProject && detailProject.postId) focusCardOnSphere(detailProject.postId);
});
document.getElementById('d-download').addEventListener('click', () => {
  const p = detailProject;
  if (!p) return;
  const url = p.heroSrc || p.src;
  if (!url) return;
  const extMatch = /\.(jpe?g|png|webp|gif)(?:[?#]|$)/i.exec(url);
  const ext = extMatch ? extMatch[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg';
  const name = sanitizeBase(p.title, 'photo');
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = name + '.' + ext;
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast('SAVING PHOTO');
  } catch {
    window.open(url, '_blank');
    toast('OPENING PHOTO');
  }
});
document.getElementById('profile-share').addEventListener('click', () => {
  if (viewingProfile) copyRoute(profileRoute(viewingProfile.username));
});
document.getElementById('album-share').addEventListener('click', () => {
  if (viewingAlbum) copyRoute(albumRoute(viewingAlbum.album.id));
});
document.getElementById('album-contact-sheet').addEventListener('click', () => {
  // share the whole album as one image when the platform supports it, else download
  if (navigator.share) shareAlbumSheet();
  else downloadAlbumSheet();
});

/* ============================================================
   DISPLAY SETTINGS - render quality (maxDpr) + fps cap
   ============================================================ */
const settingsBtn = document.getElementById('settings-btn');
const settingsPanel = document.getElementById('settings-panel');
const dprSlider = document.getElementById('set-dpr');
const dprVal = document.getElementById('set-dpr-val');
const fpsSlider = document.getElementById('set-fps');
const fpsVal = document.getElementById('set-fps-val');
const themeDarkBtn = document.getElementById('theme-dark');
const themeLightBtn = document.getElementById('theme-light');
let settingsOpen = false;

// light / dark theme: only the chrome (HUD panels, modals, overlay pages)
// recolors via CSS tokens - the 3D scene + vignette stay dark in both themes.
function applyTheme(name) {
  const isLight = name === 'light';
  if (isLight) document.body.dataset.theme = 'light';
  else delete document.body.dataset.theme;   // dark is the tokenless default
  themeDarkBtn.classList.toggle('active', !isLight);
  themeLightBtn.classList.toggle('active', isLight);
  themeDarkBtn.setAttribute('aria-pressed', String(!isLight));
  themeLightBtn.setAttribute('aria-pressed', String(isLight));
}

function applyDpr(v) {
  LOW_POWER.maxDpr = v;
  dprVal.textContent = v + '×';
  canvas.width = 0;          // force syncSize() to re-apply the pixel ratio
  syncSize();
  markSceneDirty();
}
function applyFps(v) {
  LOW_POWER.activeFps = v;
  fpsVal.textContent = v;
  markSceneDirty();          // restart the loop (e.g. when raised back up from 0)
}

// restore saved preferences, falling back to the current defaults
{
  const savedDpr = parseFloat(localStorage.getItem('pg_render_dpr'));
  const savedFps = parseInt(localStorage.getItem('pg_render_fps'), 10);
  const dpr0 = [1, 1.5, 2, 2.5, 3].includes(savedDpr) ? savedDpr : LOW_POWER.maxDpr;
  const fps0 = Number.isFinite(savedFps) && savedFps >= 0 && savedFps <= 144 ? savedFps : LOW_POWER.activeFps;
  dprSlider.value = String(dpr0);
  fpsSlider.value = String(fps0);
  applyDpr(dpr0);
  applyFps(fps0);

  const savedTheme = localStorage.getItem('pg_theme');
  applyTheme(savedTheme === 'light' ? 'light' : 'dark');
}

dprSlider.addEventListener('input', () => {
  const v = parseFloat(dprSlider.value);
  applyDpr(v);
  localStorage.setItem('pg_render_dpr', String(v));
});
fpsSlider.addEventListener('input', () => {
  const v = parseInt(fpsSlider.value, 10);
  applyFps(v);
  localStorage.setItem('pg_render_fps', String(v));
});
themeDarkBtn.addEventListener('click', () => {
  applyTheme('dark');
  localStorage.setItem('pg_theme', 'dark');
});
themeLightBtn.addEventListener('click', () => {
  applyTheme('light');
  localStorage.setItem('pg_theme', 'light');
});

function toggleSettings() {
  settingsOpen = !settingsOpen;
  settingsBtn.classList.toggle('active', settingsOpen);
  if (settingsOpen) {
    settingsPanel.hidden = false;
    gsap.fromTo(settingsPanel, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.3, ease: 'power3.out' });
  } else {
    gsap.to(settingsPanel, { opacity: 0, y: 10, duration: 0.2, ease: 'power2.in', onComplete: () => { settingsPanel.hidden = true; } });
  }
}
settingsBtn.addEventListener('click', toggleSettings);

init();
