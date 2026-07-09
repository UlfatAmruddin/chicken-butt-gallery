/* Atlas globe: a self-contained Three.js earth for the Places Atlas. Draws a
   dark earth onto a canvas from the bundled world-land outline (no map image or
   dependency), drops a pin at each located photo's lat/lng, auto-rotates, and
   supports drag-to-spin and click-a-pin. createGlobe() owns its own renderer and
   render loop; call dispose() when the atlas closes to free GPU resources. */
import * as THREE from './vendor/three.module.js';
import { WORLD_LAND } from './worlddata.js';

const R = 1;                       // globe radius in scene units
const DEG = Math.PI / 180;

/* lat/lng -> a point on the sphere. Matched to the equirectangular texture below
   (u = (lng+180)/360, v = (90-lat)/180) so pins land on the drawn coastlines. */
function latLngToVec3(lat, lng, radius = R) {
  const phi = (90 - lat) * DEG;
  const theta = (lng + 180) * DEG;
  return new THREE.Vector3(
    -radius * Math.sin(phi) * Math.cos(theta),
     radius * Math.cos(phi),
     radius * Math.sin(phi) * Math.sin(theta),
  );
}

/* Rasterize the earth (dark ocean + subtle land) onto an equirectangular canvas.
   The land data never changes, so build the canvas once and cache it at module
   scope; reopening the atlas reuses it instead of re-tracing every ring. */
let _earthCanvas = null;
function earthCanvas() {
  if (_earthCanvas) return _earthCanvas;
  const W = 2048, H = 1024;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d');
  x.fillStyle = '#0a141f';                 // deep ocean
  x.fillRect(0, 0, W, H);
  const proj = (lng, lat) => [(lng + 180) / 360 * W, (90 - lat) / 180 * H];
  // land fill
  x.fillStyle = '#1b2b3b';
  for (const ring of WORLD_LAND) {
    x.beginPath();
    ring.forEach(([lng, lat], i) => { const [px, py] = proj(lng, lat); i ? x.lineTo(px, py) : x.moveTo(px, py); });
    x.closePath();
    x.fill();
  }
  // faint coastline
  x.lineWidth = 1.2;
  x.strokeStyle = 'rgba(127,220,255,0.22)';
  for (const ring of WORLD_LAND) {
    x.beginPath();
    ring.forEach(([lng, lat], i) => { const [px, py] = proj(lng, lat); i ? x.lineTo(px, py) : x.moveTo(px, py); });
    x.closePath();
    x.stroke();
  }
  _earthCanvas = c;
  return c;
}
function earthTexture() {
  const tex = new THREE.CanvasTexture(earthCanvas());
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export function createGlobe(container, { onPick } = {}) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
  camera.position.set(0, 0, 3.1);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
  renderer.setClearColor(0x000000, 0);
  container.appendChild(renderer.domElement);
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.cursor = 'grab';
  renderer.domElement.style.touchAction = 'none';

  // earth (a group we spin so pins rotate with the surface)
  const world = new THREE.Group();
  scene.add(world);
  const earthTex = earthTexture();
  const earth = new THREE.Mesh(
    new THREE.SphereGeometry(R, 64, 48),
    new THREE.MeshBasicMaterial({ map: earthTex }),
  );
  world.add(earth);
  // a faint atmosphere halo
  const halo = new THREE.Mesh(
    new THREE.SphereGeometry(R * 1.02, 48, 32),
    new THREE.MeshBasicMaterial({ color: 0x2a4a66, transparent: true, opacity: 0.16, side: THREE.BackSide }),
  );
  scene.add(halo);

  const pinsGroup = new THREE.Group();   // pins spin with the earth
  world.add(pinsGroup);
  const pinGeo = new THREE.SphereGeometry(0.028, 16, 16);
  const pinMat = new THREE.MeshBasicMaterial({ color: 0x7fdcff });
  const stemGeo = new THREE.CylinderGeometry(0.005, 0.005, 0.12, 6);
  const stemMat = new THREE.MeshBasicMaterial({ color: 0x7fdcff, transparent: true, opacity: 0.55 });
  let pinMeshes = [];

  function clearPins() {
    pinMeshes.forEach(m => { pinsGroup.remove(m.head); pinsGroup.remove(m.stem); });
    pinMeshes = [];
  }

  function setPoints(points) {
    clearPins();
    (points || []).forEach(p => {
      if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) return;
      const base = latLngToVec3(p.lat, p.lng, R);
      const outN = base.clone().normalize();
      const head = new THREE.Mesh(pinGeo, pinMat);
      head.position.copy(base.clone().addScaledVector(outN, 0.12));
      head.userData.place = p;
      const stem = new THREE.Mesh(stemGeo, stemMat);
      stem.position.copy(base.clone().addScaledVector(outN, 0.06));
      stem.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), outN);
      pinsGroup.add(stem);
      pinsGroup.add(head);
      pinMeshes.push({ head, stem, place: p });
    });
    // spin the globe so the first / most-recent pin faces the camera. A point at
    // longitude L sits at azimuth (pi - theta) with theta=(L+180)deg; rotating by
    // (theta - pi/2) brings it to +Z (toward the camera).
    const first = (points || []).find(p => Number.isFinite(p.lat) && Number.isFinite(p.lng));
    if (first) { targetRotY = ((first.lng + 180) * DEG) - Math.PI / 2; rotY = targetRotY; }
    renderer.render(scene, camera);   // show pins immediately, don't wait on the next frame
  }

  // --- interaction: drag to spin with inertia (no auto-rotate) ---
  let rotY = 0, rotX = 0.35, targetRotY = 0, velY = 0, dragging = false, moved = false, lastX = 0, lastY = 0;
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  // two-finger pinch-to-zoom (touch): wheel is desktop-only, so track active
  // pointers and map the change in finger distance onto the eased targetZoom.
  const activePointers = new Map();
  let pinchStartDist = 0, pinchStartZoom = 0;
  function pointerDist() { const p = [...activePointers.values()]; return p.length >= 2 ? Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) : 0; }

  // --- zoom: mouse wheel / trackpad scroll, eased toward a target distance ---
  const ZOOM_MIN = 1.7, ZOOM_MAX = 6;   // camera distance from the globe (smaller = closer in)
  let targetZoom = camera.position.z;
  function onWheel(e) {
    e.preventDefault();   // zoom the globe rather than scrolling the atlas page
    targetZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, targetZoom + e.deltaY * 0.0016));
    requestFrame();
  }

  let downOnCanvas = false;   // true only between a canvas pointerdown and its pointerup
  function onDown(e) {
    downOnCanvas = true;
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (activePointers.size === 2) {   // second finger: switch from spin to pinch-zoom
      dragging = false; moved = true;
      pinchStartDist = pointerDist();
      pinchStartZoom = targetZoom;
      return;
    }
    dragging = true; moved = false;
    lastX = e.clientX; lastY = e.clientY;
    renderer.domElement.style.cursor = 'grabbing';
    renderer.domElement.setPointerCapture && renderer.domElement.setPointerCapture(e.pointerId);
    requestFrame();
  }
  function onMove(e) {
    if (activePointers.has(e.pointerId)) activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (activePointers.size >= 2 && pinchStartDist > 0) {
      const d = pointerDist();
      if (d > 0) { targetZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, pinchStartZoom * (pinchStartDist / d))); requestFrame(); }
      return;   // pinching, not spinning
    }
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
    lastX = e.clientX; lastY = e.clientY;
    rotY += dx * 0.006;
    rotX = Math.max(-1.2, Math.min(1.2, rotX + dy * 0.006));
    velY = dx * 0.0006;
    targetRotY = null;   // user took control
    requestFrame();
  }
  function onUp(e) {
    activePointers.delete(e.pointerId);
    if (activePointers.size < 2) pinchStartDist = 0;
    dragging = false;
    renderer.domElement.style.cursor = 'grab';
    // onUp is bound on window (so a drag can release off-canvas), but only pick when
    // the interaction actually started on the canvas - otherwise every click anywhere
    // on the page would re-run a full raycast while the atlas is open.
    if (downOnCanvas && !moved) pick(e);
    downOnCanvas = false;
    requestFrame();   // let any fling momentum bleed off, then the loop stops
  }
  function pick(e) {
    const rect = renderer.domElement.getBoundingClientRect();
    ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(pinMeshes.map(m => m.head), false);
    if (hits.length && onPick) onPick(hits[0].object.userData.place);
  }
  renderer.domElement.addEventListener('pointerdown', onDown);
  renderer.domElement.addEventListener('pointermove', onMove);
  renderer.domElement.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);

  function resize() {
    const w = container.clientWidth || 1, h = container.clientHeight || 1;
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    requestFrame();   // repaint at the new size
  }

  // On-demand render loop. The globe does NOT auto-spin: it only draws while the
  // user is dragging or while a fling's momentum is still bleeding off, and the
  // loop stops entirely once it comes to rest - no GPU is spent while the atlas
  // sits idle. Interaction, setPoints and resize all wake it via requestFrame().
  let raf = 0, running = true, rafPending = false;
  function needsFrame() {
    return dragging || Math.abs(velY) > 0.0004
      || Math.abs(targetZoom - camera.position.z) > 0.001
      || (targetRotY !== null && Math.abs(targetRotY - rotY) > 0.0005);
  }
  function requestFrame() {
    if (rafPending || !running) return;
    rafPending = true;
    raf = requestAnimationFrame(frame);
  }
  function frame() {
    rafPending = false;
    if (!running) return;
    if (!dragging) {
      if (targetRotY !== null) { rotY += (targetRotY - rotY) * 0.06; velY = 0; }
      else { rotY += velY; velY *= 0.96; if (Math.abs(velY) < 0.0004) velY = 0; }   // momentum decays to a full stop
    }
    world.rotation.y = rotY;
    world.rotation.x = rotX;
    camera.position.z += (targetZoom - camera.position.z) * 0.2;   // ease toward the zoom target
    if (Math.abs(targetZoom - camera.position.z) < 0.001) camera.position.z = targetZoom;
    renderer.render(scene, camera);
    if (needsFrame()) requestFrame();
  }

  resize();   // initial size + first paint
  // re-size whenever the container gets (or changes) layout - it often has no
  // width at creation time while the atlas panel is still animating in.
  const ro = ('ResizeObserver' in window) ? new ResizeObserver(() => resize()) : null;
  if (ro) ro.observe(container);

  function dispose() {
    running = false;
    if (ro) ro.disconnect();
    cancelAnimationFrame(raf);
    renderer.domElement.removeEventListener('pointerdown', onDown);
    renderer.domElement.removeEventListener('pointermove', onMove);
    renderer.domElement.removeEventListener('wheel', onWheel);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    clearPins();
    pinGeo.dispose(); stemGeo.dispose(); pinMat.dispose(); stemMat.dispose();
    earth.geometry.dispose(); earth.material.dispose(); earthTex.dispose();
    halo.geometry.dispose(); halo.material.dispose();
    renderer.dispose();
    if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
  }

  return { setPoints, resize, dispose };
}
