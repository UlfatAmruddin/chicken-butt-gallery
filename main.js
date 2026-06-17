import * as THREE from './js/vendor/three.module.js';
import { esc, mediaSrc, avatarInner, wrap, nearestEquiv, timeAgo, coverDraw } from './js/util.js';
import { LOW_POWER, IMAGE_LOAD_CONCURRENCY } from './js/config.js';
import { makeCardTexture } from './js/textures.js';
import { api } from './js/api.js';
import { toast } from './js/toast.js';
import { loadImage } from './js/images.js';
const gsap = window.gsap;

let me = null;               // logged-in user's profile
let currentCommunity = null; // active private community
let allCommunities = [];
let pendingAuthAction = null;
let communityPosts = [];     // posts fetched from the server
let pool = [];               // community posts -> what the wall shows
let communityActivity = [];
let communityPrompts = [];

// give the API client read access to the active community for auto-scoping
api.communityResolver = () => currentCommunity;

function postToProject(p) {
  return {
    src: '/' + p.file,
    client: p.client || '@' + p.username,
    title: (p.title || 'UNTITLED').toUpperCase(),
    cat: 'COMMUNITY',
    tags: (p.tags && p.tags.length) ? p.tags : ['PHOTO'],
    year: p.year || new Date(p.created).getFullYear(),
    caption: p.caption || '',
    layout: p.layout || 'full',
    logo: 'mono',
    community: true,
    communityId: p.communityId,
    username: p.username,
    postId: p.id,
    pinned: !!p.pinned,
    promptId: p.promptId || '',
    likes: Array.isArray(p.likes) ? p.likes : [],
    comments: Array.isArray(p.comments) ? p.comments : [],
  };
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
}

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
  return !!profile && !!profile.isAdmin;   // server-authoritative (publicProfile.isAdmin)
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
  return !!(gsap.globalTimeline && gsap.globalTimeline.isActive());
}

function introDriftActive(now) {
  return introDone && !interacted && now < introDriftUntil && !ui.locked;
}

function galleryMoving(now = performance.now()) {
  return drag.active || ui.locked || introDriftActive(now)
    || Math.abs(state.vx) > LOW_POWER.idleVelocity
    || Math.abs(state.vy) > LOW_POWER.idleVelocity
    || Math.abs(state.tx - state.cx) > LOW_POWER.idlePosition
    || Math.abs(state.ty - state.cy) > LOW_POWER.idlePosition
    || Math.abs(zoomState.target - zoomState.current) > 0.01;
}

function queueRenderFrame() {
  if (renderLoopRunning) return;
  renderLoopRunning = true;
  requestAnimationFrame(renderFrame);
}

function renderFrame(now = performance.now()) {
  renderLoopRunning = false;
  if (document.hidden) {
    clock.getDelta();
    return;
  }
  if (LOW_POWER.activeFps <= 0) { clock.getDelta(); return; }  // user paused rendering (0 fps)

  const active = sceneDirty || cardsAnimating || galleryMoving(now) || hasGsapWork();
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

  const movingNow = galleryMoving(now) || hasGsapWork();
  const needsCardFrames = updateCards(dt);
  const hoverChanged = updateHover(now, movingNow);
  renderer.render(scene, camera);
  sceneDirty = false;
  cardsAnimating = needsCardFrames || hoverChanged;
  if (sceneDirty || cardsAnimating || galleryMoving(now) || hasGsapWork()) queueRenderFrame();
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
  if (ui.locked || overlayOpen()) return;
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
  img: document.getElementById('d-img'),
  p1: document.getElementById('d-p1'),
  p2: document.getElementById('d-p2'),
};

function fillDetail(p) {
  dEls.title.textContent = p.title;
  dEls.client.textContent = p.community ? '@' + p.username : p.client;
  dEls.year.textContent = p.year;
  dEls.tags.textContent = [p.cat, ...p.tags].join(' / ');
  dEls.img.src = p.heroSrc || p.src || '';
  detailProject = p;
  const canManage = canManageProject(p);
  document.getElementById('d-owner').hidden = !canManage;
  const pinBtn = document.getElementById('d-pin-btn');
  const canPin = !!(p.community && me && (isCommunityAdmin() || isAdminProfile()));
  pinBtn.hidden = !canPin;
  pinBtn.textContent = p.pinned ? 'UNPIN PHOTO' : 'PIN PHOTO';
  document.getElementById('d-edit-form').hidden = true;
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
  renderSocial(p);
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
  detail.scrollTop = 0;
  detail.setAttribute('aria-hidden', 'false');
  gsap.fromTo(detail, { yPercent: 100, y: 0 }, { yPercent: 0, y: 0, duration: 0.85, ease: 'power4.inOut' });
  gsap.fromTo('#d-title span', { yPercent: 110 }, { yPercent: 0, duration: 0.9, delay: 0.45, ease: 'power3.out' });
  gsap.fromTo('.d-meta, .d-cols', { opacity: 0, y: 30 }, { opacity: 1, y: 0, duration: 0.8, delay: 0.6, stagger: 0.1, ease: 'power2.out' });
  gsap.fromTo('.d-hero', { clipPath: 'inset(100% 0 0 0)' }, { clipPath: 'inset(0% 0 0 0)', duration: 1, delay: 0.55, ease: 'power3.inOut' });
}

function closeProject() {
  if (detail.style.display !== 'block') return;
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

/* ---- scope chips (shared by upload + edit forms) ----
   Roster comes from the active community (admin-managed); union with the photo's
   existing tags so legacy tags stay visible/editable even after roster edits. */
const SCOPE_PICK_LIMIT = 8;
function buildScopeChips(container, selected = []) {
  container.innerHTML = '';
  const roster = (currentCommunity && Array.isArray(currentCommunity.scopes)) ? currentCommunity.scopes : [];
  const all = [...new Set([...roster, ...selected])];
  const active = new Set(selected.filter(t => all.includes(t)));
  if (!all.length) {
    container.innerHTML = '<span class="mono dim">NO SCOPES YET - AN ADMIN CAN ADD THEM IN THE COMMUNITY ADMIN PANEL.</span>';
    return () => [...active];
  }
  all.forEach(t => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'scope-chip' + (active.has(t) ? ' active' : '');
    b.textContent = t;
    b.addEventListener('click', () => {
      if (active.has(t)) { active.delete(t); b.classList.remove('active'); }
      else if (active.size < SCOPE_PICK_LIMIT) { active.add(t); b.classList.add('active'); }
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

document.getElementById('back-btn').addEventListener('click', closeProject);

/* ---- reactions & comments (detail page) ---- */
const dSocial = document.getElementById('d-social');
const dLikeBtn = document.getElementById('d-like');
const dLikeCount = document.getElementById('d-like-count');
const dCommentCount = document.getElementById('d-comment-count');
const dCommentsEl = document.getElementById('d-comments');
const dCommentForm = document.getElementById('d-comment-form');
const dCommentInput = document.getElementById('d-comment-input');

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
  if (cp) { cp.likes = p.likes; cp.comments = p.comments; }
}
function renderSocial(p) {
  if (!p || !p.community) { dSocial.hidden = true; return; }
  dSocial.hidden = false;
  const liked = !!(me && p.likes.includes(me.username));
  dLikeBtn.classList.toggle('liked', liked);
  dLikeCount.textContent = p.likes.length;
  const n = p.comments.length;
  dCommentCount.textContent = `${n} COMMENT${n === 1 ? '' : 'S'}`;
  dCommentsEl.innerHTML = '';
  p.comments.slice().sort((a, b) => a.created - b.created).forEach(c => {
    const meta = userMeta[c.username] || { username: c.username, displayName: c.username };
    const canDel = me && (me.username === c.username || me.username === p.username || isAdminProfile() || isCommunityAdmin());
    const row = document.createElement('div');
    row.className = 'comment';
    row.innerHTML =
      `<span class="avatar sm">${avatarInner(meta)}</span>` +
      `<div class="c-body"><div class="c-head">` +
      `<button class="c-name">${esc(meta.displayName || c.username)}</button>` +
      `<span class="mono dim c-time">@${esc(c.username)} · ${timeAgo(c.created)}</span>` +
      (canDel ? `<button class="c-del" title="Delete comment">✕</button>` : '') +
      `</div><div class="c-text"></div></div>`;
    row.querySelector('.c-text').textContent = c.text;
    row.querySelector('.c-name').addEventListener('click', () => { closeProject(); openPeople(c.username); });
    if (canDel) row.querySelector('.c-del').addEventListener('click', () => deleteComment(p, c.id));
    dCommentsEl.appendChild(row);
  });
}
async function deleteComment(p, cid) {
  try {
    await api.call('DELETE', `/api/photos/${p.postId}/comments/${cid}`);
    p.comments = p.comments.filter(c => c.id !== cid);
    syncPostSocial(p);
    renderSocial(p);
  } catch (e) { toast(String(e.message || 'COULD NOT DELETE').toUpperCase()); }
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
dCommentForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const p = detailProject;
  const text = dCommentInput.value.trim();
  if (!p || !text) return;
  try {
    const c = await api.call('POST', `/api/photos/${p.postId}/comments`, { text });
    p.comments.push(c);
    dCommentInput.value = '';
    if (me && !userMeta[me.username]) userMeta[me.username] = me;
    syncPostSocial(p);
    renderSocial(p);
  } catch (e) { toast(String(e.message || 'COULD NOT POST').toUpperCase()); }
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!uploadModal.hidden) closeUpload();
    else if (!albumModal.hidden) closeAlbumModal();
    else if (!pickAlbumModal.hidden) closePickAlbum();
    else if (!addPhotosModal.hidden) { closeAddPhotos(); if (viewingAlbum) showAlbum(viewingAlbum.album.id); }
    else if (detail.style.display === 'block') closeProject();
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
  setNav(view);
  if (view === 'albums') { closeFlatView(); closePeople(); openAlbums(); }
  else if (view === 'people') { closeFlatView(); closeAlbums(); openPeople(); }
  else { closeFlatView(); closeAlbums(); closePeople(); }   // gallery
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
let flatOpen = false;
let flatMode = 'grid';

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
  flatEmpty.hidden = pool.length > 0;
  pool.forEach(p => {
    const likes = Array.isArray(p.likes) ? p.likes.length : 0;
    const comments = Array.isArray(p.comments) ? p.comments.length : 0;
    const card = document.createElement('button');
    card.className = 'flat-card';
    card.innerHTML =
      `<img class="fc-img" src="${esc(p.src || p.heroSrc || '')}" alt="${esc(p.title)}">` +
      `<span class="fc-body">` +
      `<span class="fc-title">${esc(p.title)}</span>` +
      `<span class="mono dim fc-sub">@${esc(p.username || 'unknown')} <span class="fc-counts"><span>${likes} LIKE${likes === 1 ? '' : 'S'}</span><span>${comments} COMMENT${comments === 1 ? '' : 'S'}</span></span></span>` +
      `</span>`;
    card.addEventListener('click', () => openDetailFor(p));
    flatWrap.appendChild(card);
  });
}

function openFlatView(mode = 'grid') {
  if (!currentCommunity) { showCommunityHub(); return; }
  closePeople();
  closeAlbums();
  setNav('gallery');
  if (!flatOpen) {
    flatOpen = true;
    flatEl.style.display = 'block';
    flatEl.setAttribute('aria-hidden', 'false');
    flatEl.scrollTop = 0;
    gsap.fromTo(flatEl, { yPercent: 100, y: 0 }, { yPercent: 0, y: 0, duration: 0.75, ease: 'power4.inOut' });
  }
  setFlatMode(mode);
}

function closeFlatView() {
  if (!flatOpen) return;
  flatEl.setAttribute('aria-hidden', 'true');
  gsap.to(flatEl, {
    yPercent: 100, duration: 0.65, ease: 'power3.inOut',
    onComplete: () => { flatEl.style.display = 'none'; flatOpen = false; },
  });
}

document.getElementById('flat-close').addEventListener('click', closeFlatView);
flatGridBtn.addEventListener('click', () => setFlatMode('grid'));
flatListBtn.addEventListener('click', () => setFlatMode('list'));

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
    return;
  }
  try { communityPosts = await api.call('GET', '/api/photos'); }
  catch { communityPosts = []; }
  ensureUserMeta(true);   // refresh username -> {displayName, avatar} for comments
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
const communityRoomEl = document.getElementById('community-room');
const communityAdminEl = document.getElementById('community-admin');
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
const aEmail = document.getElementById('auth-email');
const aEmailRow = document.getElementById('auth-email-row');
const authErr = document.getElementById('auth-err');
const authSubmit = document.getElementById('auth-submit');
const tabLogin = document.getElementById('tab-login');
const tabRegister = document.getElementById('tab-register');
const authTabs = document.getElementById('auth-tabs');
const authEmailForm = document.getElementById('auth-email-form');
const authCodeForm = document.getElementById('auth-code-form');
const meChip = document.getElementById('me-chip');
let authMode = 'login';
let authChallenge = '';   // pending email/2FA challenge token

const deviceToken = {
  get() { return localStorage.getItem('pg_device') || ''; },
  set(t) { if (t) localStorage.setItem('pg_device', t); },
  clear() { localStorage.removeItem('pg_device'); },
};
let pendingInviteCode = '';
let roomOpen = false;
let adminOpen = false;
let showOnboardingAfterEnter = false;

function overlayOpen() {
  return !landingEl.hidden || !communityHubEl.hidden || !inviteViewEl.hidden || !authEl.hidden
    || roomOpen || adminOpen || peopleOpen || albumsOpen || flatOpen || !uploadModal.hidden
    || !communityModal.hidden || !enterInviteModal.hidden || !inviteToolsModal.hidden
    || !onboardingModal.hidden
    || !albumModal.hidden || !pickAlbumModal.hidden || !addPhotosModal.hidden
    || detail.style.display === 'block';
}

function setAuthMode(mode) {
  authMode = mode;
  showAuthStep('credentials');
  tabLogin.classList.toggle('active', mode === 'login');
  tabRegister.classList.toggle('active', mode === 'register');
  aNameRow.hidden = mode === 'login';
  aEmailRow.hidden = mode === 'login';
  authSubmit.textContent = mode === 'login' ? 'Log In' : 'Create Account';
  aPass.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  authErr.textContent = '';
}
/* Toggle the auth box between the credentials, add-email, and code-entry steps. */
function showAuthStep(step) {
  authForm.hidden = step !== 'credentials';
  authTabs.hidden = step !== 'credentials';
  authEmailForm.hidden = step !== 'email';
  authCodeForm.hidden = step !== 'code';
}
/* Route a /api/login or /api/register response: either logged in, or a next step. */
async function handleAuthResult(r) {
  if (r.token) { await finishAuth(r); return; }
  authChallenge = r.challenge || '';
  if (r.step === 'email') {
    document.getElementById('auth-email2').value = '';
    document.getElementById('auth-email-err').textContent = '';
    showAuthStep('email');
  } else if (r.step === 'verify' || r.step === '2fa') {
    document.getElementById('auth-code').value = '';
    document.getElementById('auth-code-err').textContent = '';
    document.getElementById('auth-remember').checked = false;
    document.getElementById('auth-code-msg').textContent =
      (r.step === 'verify' ? 'Verify your email - enter the 6-digit code we sent' : 'Enter the 6-digit code we emailed')
      + (r.email ? ` to ${r.email}.` : '.');
    showAuthStep('code');
  }
}
async function finishAuth(r) {
  api.setToken(r.token);
  if (r.deviceToken) deviceToken.set(r.deviceToken);
  me = r.profile;
  authChallenge = '';
  updateMeChip();
  await afterAuthSuccess();
}
tabLogin.addEventListener('click', () => setAuthMode('login'));
tabRegister.addEventListener('click', () => setAuthMode('register'));

function updateMeChip() {
  if (!me) { meChip.hidden = true; return; }
  meChip.hidden = false;
  meChip.innerHTML = (me.avatar ? `<img class="chip-av" src="/${esc(me.avatar)}" alt="">` : '') + '@' + esc(me.username);
}
meChip.addEventListener('click', () => { if (me) openPeople(me.username); });

function updateLandingLogin() {
  const b = document.getElementById('landing-login');
  b.textContent = me ? 'MY COMMUNITIES' : 'LOG IN';
  document.getElementById('invite-login').textContent = me ? 'MY COMMUNITIES' : 'LOG IN';
}

function updateCommunityHud() {
  if (!currentCommunity) {
    communityChip.hidden = true;
    inviteToolsBtn.hidden = true;
    return;
  }
  communityChip.hidden = false;
  communityChip.textContent = currentCommunity.name.toUpperCase();
  inviteToolsBtn.hidden = !(isCommunityAdmin() || isAdminProfile());
  inviteToolsBtn.textContent = 'Admin';
}

function setEntryMode(on) {
  document.body.classList.toggle('entry-mode', !!on);
}

function hideEntryScreens() {
  landingEl.hidden = true;
  communityHubEl.hidden = true;
  inviteViewEl.hidden = true;
}

async function clearActiveCommunity() {
  if (!currentCommunity && communityPosts.length === 0 && pool.length === 0) {
    updateCommunityHud();
    updateEmptyWall();
    return;
  }
  currentCommunity = null;
  communityPosts = [];
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
  closeAdminPanel();
  closeCommunityRoom();
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
  closeAdminPanel();
  closeCommunityRoom();
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
    if (c.coverFile) card.style.backgroundImage = `url('/${esc(c.coverFile)}')`;
    card.innerHTML =
      `<span class="cc-name">${esc(c.name)}</span>` +
      `<span class="mono cc-sub">${c.photoCount} PHOTO${c.photoCount === 1 ? '' : 'S'} / ${c.memberCount} MEMBER${c.memberCount === 1 ? '' : 'S'} / ${esc((c.role || 'member').toUpperCase())}</span>`;
    card.addEventListener('click', () => enterCommunity(c.id));
    communityListEl.appendChild(card);
  });
  communityEmptyEl.hidden = allCommunities.length > 0;
}

async function enterCommunity(id, updateHash = true) {
  if (!me) {
    showAuth('login', { type: 'community', id });
    return false;
  }
  try {
    currentCommunity = await api.call('GET', '/api/communities/' + encodeURIComponent(id));
  } catch (e) {
    currentCommunity = null;
    toast(String(e.message || 'COMMUNITY NOT FOUND').toUpperCase());
    await showCommunityHub(false);
    return false;
  }
  hideEntryScreens();
  authEl.hidden = true;
  setEntryMode(false);
  updateCommunityHud();
  setNav('gallery');
  await refreshCommunity();
  await loadCommunityExtras();
  await rebuildGallery();
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
    if (authMode === 'register') { body.displayName = aName.value.trim(); body.email = aEmail.value.trim(); }
    else body.deviceToken = deviceToken.get();
    const r = await api.call('POST', authMode === 'login' ? '/api/login' : '/api/register', body);
    await handleAuthResult(r);
  } catch (err) {
    authErr.textContent = String(err.message || 'SOMETHING WENT WRONG').toUpperCase();
  } finally {
    authSubmit.disabled = false;
  }
});

// Step: existing account adds an email, then receives a verification code.
authEmailForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('auth-email-err');
  errEl.textContent = '';
  try {
    const r = await api.call('POST', '/api/auth/email', { challenge: authChallenge, email: document.getElementById('auth-email2').value.trim() });
    await handleAuthResult(r);
  } catch (err) {
    errEl.textContent = String(err.message || 'COULD NOT SEND CODE').toUpperCase();
  }
});
document.getElementById('auth-email-back').addEventListener('click', () => setAuthMode(authMode));

// Step: verify the emailed code (email verification or login 2FA).
authCodeForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('auth-code-err');
  errEl.textContent = '';
  try {
    const r = await api.call('POST', '/api/auth/verify', {
      challenge: authChallenge,
      code: document.getElementById('auth-code').value.trim(),
      rememberDevice: document.getElementById('auth-remember').checked,
    });
    await handleAuthResult(r);
  } catch (err) {
    errEl.textContent = String(err.message || 'WRONG OR EXPIRED CODE').toUpperCase();
  }
});
document.getElementById('auth-code-resend').addEventListener('click', async () => {
  const errEl = document.getElementById('auth-code-err');
  errEl.textContent = '';
  try {
    await api.call('POST', '/api/auth/resend', { challenge: authChallenge });
    toast('NEW CODE SENT');
  } catch (err) {
    errEl.textContent = String(err.message || 'COULD NOT RESEND').toUpperCase();
  }
});
document.getElementById('auth-code-back').addEventListener('click', () => setAuthMode(authMode));

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
}

async function refreshCurrentCommunity() {
  if (!currentCommunity) return;
  try {
    currentCommunity = await api.call('GET', '/api/communities/' + encodeURIComponent(currentCommunity.id));
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
  communityRoomEl.setAttribute('aria-hidden', 'true');
  gsap.to(communityRoomEl, {
    yPercent: 100, duration: 0.65, ease: 'power3.inOut',
    onComplete: () => { communityRoomEl.style.display = 'none'; roomOpen = false; },
  });
}

function renderCommunityRoom() {
  if (!currentCommunity) return;
  const cover = document.getElementById('room-cover');
  cover.style.backgroundImage = currentCommunity.coverFile ? `linear-gradient(to bottom, rgba(0,0,0,.18), rgba(0,0,0,.82)), url('/${esc(currentCommunity.coverFile)}')` : '';
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
    const tile = document.createElement('button');
    tile.className = 'mini-photo';
    tile.innerHTML = `<img src="/${esc(post.file)}" alt="${esc(post.title || '')}"><span>${esc(post.title || 'UNTITLED')}</span>`;
    tile.addEventListener('click', () => openDetailFor(postToProject(post)));
    pinnedWrap.appendChild(tile);
  });
  document.getElementById('room-pinned-empty').hidden = pinnedPosts.length > 0;

  const feed = document.getElementById('room-feed');
  feed.innerHTML = '';
  communityActivity.forEach(ev => {
    const row = document.createElement('button');
    row.className = 'activity-row';
    const label = activityLabel(ev);
    row.innerHTML =
      (ev.file ? `<img src="/${esc(ev.file)}" alt="">` : `<span class="activity-dot"></span>`) +
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
}

function activityLabel(ev) {
  if (ev.type === 'photo') return `Posted ${ev.title || 'a photo'}`;
  if (ev.type === 'comment') return `Commented on ${ev.title || 'a photo'}`;
  if (ev.type === 'album') return `Created album ${ev.title || ''}`;
  if (ev.type === 'member.joined') return 'Joined the community';
  if (ev.type === 'prompt.created') return `New prompt: ${ev.title || ''}`;
  if (ev.type === 'photo.pinned') return `Pinned ${ev.title || 'a photo'}`;
  return ev.title || ev.type;
}

let csCoverData;
async function openAdminPanel() {
  if (!currentCommunity || !(isCommunityAdmin() || isAdminProfile())) return;
  closeCommunityRoom();
  adminOpen = true;
  communityAdminEl.style.display = 'block';
  communityAdminEl.setAttribute('aria-hidden', 'false');
  communityAdminEl.scrollTop = 0;
  await renderAdminPanel();
  gsap.fromTo(communityAdminEl, { yPercent: 100, y: 0 }, { yPercent: 0, y: 0, duration: 0.75, ease: 'power4.inOut' });
}

function closeAdminPanel() {
  if (!adminOpen) return;
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
  await Promise.all([renderAdminMembers(), renderAdminBans(), renderAdminInvites(), renderAdminPrompts(), renderAdminScopes(), renderAdminAudit()]);
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
  if (!confirm(`Remove and ban @${username} from this community? Their existing posts stay visible.`)) return;
  try {
    await api.call('DELETE', `/api/communities/${encodeURIComponent(currentCommunity.id)}/members/${encodeURIComponent(username)}`, { reason: 'Removed by admin' });
    toast('MEMBER REMOVED');
    await renderAdminPanel();
  } catch (e) { toast(String(e.message || 'COULD NOT REMOVE').toUpperCase()); }
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

async function renderAdminScopes() {
  const wrap = document.getElementById('scope-list');
  if (!wrap) return;
  wrap.innerHTML = '';
  const scopes = Array.isArray(currentCommunity.scopes) ? currentCommunity.scopes : [];
  if (!scopes.length) { wrap.innerHTML = '<p class="mono dim">NO SCOPES YET.</p>'; return; }
  scopes.forEach(name => {
    const row = document.createElement('div');
    row.className = 'admin-row';
    row.innerHTML =
      `<span class="admin-main"><strong>${esc(name)}</strong></span>` +
      `<span class="admin-actions"><button class="mono danger delete-scope">DELETE</button></span>`;
    row.querySelector('.delete-scope').addEventListener('click', () => deleteScope(name));
    wrap.appendChild(row);
  });
}

async function deleteScope(name) {
  if (!confirm(`Delete scope "${name}"? It will be removed from photos that use it.`)) return;
  try {
    await api.call('DELETE', `/api/communities/${encodeURIComponent(currentCommunity.id)}/scopes/${encodeURIComponent(name)}`);
    toast('SCOPE DELETED');
    await renderAdminPanel();
  } catch (e) { toast(String(e.message || 'COULD NOT DELETE SCOPE').toUpperCase()); }
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
document.getElementById('scope-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('scope-name').value.trim();
  if (!name) { document.getElementById('scope-err').textContent = 'NAME THE SCOPE FIRST.'; return; }
  try {
    await api.call('POST', `/api/communities/${encodeURIComponent(currentCommunity.id)}/scopes`, { name });
    document.getElementById('scope-name').value = '';
    document.getElementById('scope-err').textContent = '';
    toast('SCOPE ADDED');
    await renderAdminPanel();
  } catch (err) {
    document.getElementById('scope-err').textContent = String(err.message || 'COULD NOT ADD').toUpperCase();
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
document.getElementById('admin-close').addEventListener('click', () => { closeAdminPanel(); openCommunityRoom(); });

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
  updateLandingLogin();
  await showLanding(true);
}

document.getElementById('landing-login').addEventListener('click', () => { if (me) showCommunityHub(); else showAuth('login'); });
document.getElementById('hero-create').addEventListener('click', openCommunityModal);
document.getElementById('hero-invite').addEventListener('click', openEnterInviteModal);
document.getElementById('hub-create').addEventListener('click', openCommunityModal);
document.getElementById('hub-enter-invite').addEventListener('click', openEnterInviteModal);
document.getElementById('hub-back-home').addEventListener('click', () => showLanding(true));
document.getElementById('hub-logout').addEventListener('click', logoutEverywhere);
document.getElementById('invite-home').addEventListener('click', () => showLanding(true));
document.getElementById('invite-login').addEventListener('click', () => { if (me) showCommunityHub(); else showAuth('login', pendingInviteCode ? { type: 'invite', code: pendingInviteCode } : null); });
document.getElementById('invite-join').addEventListener('click', () => joinInvite(pendingInviteCode));
communityChip.addEventListener('click', openCommunityRoom);
inviteToolsBtn.addEventListener('click', openAdminPanel);

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
   ALBUMS
   ============================================================ */
const albumsEl = document.getElementById('albums');
let albumsOpen = false;
let allAlbums = [];
let viewingAlbum = null;   // { album, posts }

function albumCardHTML(a) {
  const cover = a.coverFile ? ` style="background-image:url('/${esc(a.coverFile)}')"` : '';
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
  renderAlbumPhotos(data, own);
}

function renderAlbumPhotos(data, own) {
  const wrap = document.getElementById('album-photos');
  wrap.innerHTML = '';
  data.posts.forEach(post => {
    const tile = document.createElement('div');
    tile.className = 'pp-tile';
    const img = document.createElement('img');
    img.src = '/' + post.file; img.alt = post.title; img.title = post.title;
    tile.appendChild(img);
    tile.addEventListener('click', (e) => {
      if (e.target.closest('.ap-actions')) return;
      openDetailFor(postToProject(post));
    });
    if (own) {
      const actions = document.createElement('div');
      actions.className = 'ap-actions';
      const coverBtn = document.createElement('button');
      coverBtn.className = 'ap-btn' + (data.album.cover === post.id ? ' is-cover' : '');
      coverBtn.textContent = '★'; coverBtn.title = 'Set as cover';
      coverBtn.addEventListener('click', (e) => { e.stopPropagation(); albumOp({ cover: post.id }, 'COVER SET'); });
      const rm = document.createElement('button');
      rm.className = 'ap-btn'; rm.textContent = '✕'; rm.title = 'Remove from album';
      rm.addEventListener('click', (e) => { e.stopPropagation(); albumOp({ removePhotoId: post.id }, 'REMOVED FROM ALBUM'); });
      actions.appendChild(coverBtn); actions.appendChild(rm);
      tile.appendChild(actions);
    }
    wrap.appendChild(tile);
  });
  document.getElementById('album-no-photos').hidden = data.posts.length > 0;
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
    tile.innerHTML = `<img src="/${esc(post.file)}" alt=""><span class="ap-check">✓</span>`;
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
  document.getElementById('pw-form').hidden = true;
  peopleEl.scrollTop = 0;

  document.getElementById('profile-avatar').innerHTML = avatarInner(p);
  const coverEl = document.getElementById('profile-cover');
  if (p.cover) { coverEl.style.backgroundImage = `url("/${esc(p.cover)}")`; coverEl.hidden = false; }
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
    img.src = '/' + post.file;
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
  setEditCoverPreview(viewingProfile.cover ? '/' + viewingProfile.cover : '');
  profileEditForm.hidden = false;
  profileEditBtn.hidden = true;
  // expose the change-password form alongside profile editing (own profile only)
  document.getElementById('pw-current').value = '';
  document.getElementById('pw-new').value = '';
  document.getElementById('pw-confirm').value = '';
  document.getElementById('pw-err').textContent = '';
  document.getElementById('pw-form').hidden = false;
});
document.getElementById('pe-cancel').addEventListener('click', () => {
  profileEditForm.hidden = true;
  profileEditBtn.hidden = false;
  document.getElementById('pw-form').hidden = true;
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

document.getElementById('pw-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('pw-err');
  errEl.textContent = '';
  const currentPassword = document.getElementById('pw-current').value;
  const newPassword = document.getElementById('pw-new').value;
  const confirmPassword = document.getElementById('pw-confirm').value;
  if (newPassword !== confirmPassword) { errEl.textContent = "NEW PASSWORDS DON'T MATCH."; return; }
  try {
    await api.call('PUT', '/api/password', { currentPassword, newPassword });
    document.getElementById('pw-current').value = '';
    document.getElementById('pw-new').value = '';
    document.getElementById('pw-confirm').value = '';
    document.getElementById('pw-form').hidden = true;
    toast('PASSWORD UPDATED');
  } catch (err) {
    errEl.textContent = String(err.message || 'COULD NOT UPDATE').toUpperCase();
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

async function handleHashRoute() {
  if (location.hash === mutedHash) { mutedHash = ''; return; }
  const parts = routeParts();
  const [kind, id] = parts;
  if (!kind) {
    if (detail.style.display === 'block') closeProject();
    if (flatOpen) closeFlatView();
    if (albumsOpen) closeAlbums();
    if (peopleOpen) closePeople();
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
      if (!ok) return;
    }
    if (!view) {
      if (detail.style.display === 'block') closeProject();
      if (flatOpen) closeFlatView();
      if (albumsOpen) closeAlbums();
      if (peopleOpen) closePeople();
      setNav('gallery');
      return;
    }
    if (view === 'photo' && itemId) {
      closeFlatView();
      closeAlbums();
      closePeople();
      let post = communityPosts.find(p => p.id === itemId);
      if (!post) {
        await refreshCommunity();
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
    let post = communityPosts.find(p => p.id === id);
    if (!post) {
      await refreshCommunity();
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

  if (me) await showCommunityHub(false);
  else await showLanding(false);
}

window.addEventListener('hashchange', handleHashRoute);
document.getElementById('d-share').addEventListener('click', () => {
  if (detailProject && detailProject.postId) copyRoute(photoRoute(detailProject.postId));
});
document.getElementById('profile-share').addEventListener('click', () => {
  if (viewingProfile) copyRoute(profileRoute(viewingProfile.username));
});
document.getElementById('album-share').addEventListener('click', () => {
  if (viewingAlbum) copyRoute(albumRoute(viewingAlbum.album.id));
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
let settingsOpen = false;

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
