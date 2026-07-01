/* ============================================================
   CINEMA MODE - immersive fullscreen photo viewing.
   Pure UI controller: dims the room, centers the photo large, and
   paints an ambient blurred copy of the same image behind it. It knows
   nothing about the backend or the pool - the host wires open()/close()/
   update() and delegates PREV/NEXT/PLAY back through the callbacks below.

   init options:
     getProject() -> the currently open detail project (or null)
     step(dir)    -> advance the detail photo by -1 / +1 (host's stepPhoto)
     isPlaying()  -> true while the slideshow is running (drives PLAY label)
     togglePlay() -> toggle the slideshow
     isPlayable() -> true when the slideshow can actually run; when false the
                     PLAY control is hidden so it matches the detail row's
                     #d-play (which is hidden for private / single-photo views)
   ============================================================ */
const gsap = window.gsap;
const reduceMotion = window.matchMedia
  && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function initCinema({ getProject, step, isPlaying, togglePlay, isPlayable } = {}) {
  const layer = document.getElementById('cinema-layer');
  if (!layer) return null;               // markup missing - no-op controller

  const backdrop = layer.querySelector('.cinema-backdrop');
  const img = layer.querySelector('.cinema-img');
  const meta = layer.querySelector('.cinema-meta');
  const btnPrev = layer.querySelector('.cinema-prev');
  const btnNext = layer.querySelector('.cinema-next');
  const btnClose = layer.querySelector('.cinema-close');
  const btnPlay = layer.querySelector('.cinema-play');

  let open = false;

  /* is the browser currently in the native fullscreen state? */
  function fsElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }

  /* paint the current photo large + its blurred ambient twin behind it.
     src is a ready-to-use image src (already mediaSrc()'d by the host);
     label is plain text (the host escapes nothing here - it is set via
     textContent, never innerHTML). */
  function update(src, label) {
    if (!src) return;
    if (img.getAttribute('src') !== src) {
      img.src = src;
      backdrop.style.backgroundImage = `url("${src.replace(/"/g, '\\"')}")`;
    }
    meta.textContent = label || '';
  }

  /* pull the src/label straight from the host's current project */
  function syncFromProject() {
    const p = getProject && getProject();
    if (!p) return;
    const src = p.heroSrc || p.src || '';
    const who = p.community ? '@' + (p.username || '') : (p.client || '');
    const label = [p.title, who, p.year].filter(Boolean).join('  ·  ');
    update(src, label);
  }

  function reflectPlaying() {
    const playing = !!(isPlaying && isPlaying());
    // hide PLAY when the slideshow is not usable (private / single photo), so
    // this surface matches the detail row where #d-play is simply hidden.
    const playable = isPlayable ? !!isPlayable() : true;
    btnPlay.hidden = !playable;
    btnPlay.classList.toggle('playing', playing);
    btnPlay.setAttribute('aria-pressed', playing ? 'true' : 'false');
    btnPlay.title = playing ? 'Pause slideshow' : 'Play slideshow';
    const glyph = btnPlay.querySelector('.cinema-play-glyph');
    if (glyph) glyph.textContent = playing ? '‖' : '▶';   // pause / play
  }

  function show() {
    if (open) return;
    const p = getProject && getProject();
    if (!p) return;
    open = true;
    syncFromProject();
    reflectPlaying();
    layer.hidden = false;
    layer.setAttribute('aria-hidden', 'false');
    // ask for real fullscreen; a fixed full-viewport overlay is the fallback
    // when the API is missing or the request is denied.
    const req = layer.requestFullscreen || layer.webkitRequestFullscreen;
    if (req) { try { const r = req.call(layer); if (r && r.catch) r.catch(() => {}); } catch { /* fixed overlay fallback */ } }
    if (reduceMotion) {
      gsap.set(layer, { opacity: 1 });
    } else {
      gsap.fromTo(layer, { opacity: 0 }, { opacity: 1, duration: 0.4, ease: 'power2.out' });
    }
  }

  function hide() {
    if (!open) return;
    open = false;
    if (fsElement()) {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit) { try { const r = exit.call(document); if (r && r.catch) r.catch(() => {}); } catch { /* ignore */ } }
    }
    const finish = () => {
      layer.hidden = true;
      layer.setAttribute('aria-hidden', 'true');
      gsap.set(layer, { clearProps: 'opacity' });
    };
    if (reduceMotion) { finish(); }
    else { gsap.to(layer, { opacity: 0, duration: 0.3, ease: 'power2.in', onComplete: finish }); }
  }

  function toggle() { if (open) hide(); else show(); }

  btnPrev.addEventListener('click', () => { if (step) step(-1); });
  btnNext.addEventListener('click', () => { if (step) step(1); });
  btnClose.addEventListener('click', hide);
  // toggle then immediately re-sync the glyph: stopping the slideshow from here
  // does not funnel through fillDetail(), so reflect the new state directly.
  btnPlay.addEventListener('click', () => { if (togglePlay) togglePlay(); reflectPlaying(); });

  // if the user leaves native fullscreen (Esc / OS chrome), fold the overlay too
  const onFsChange = () => { if (open && !fsElement()) hide(); };
  document.addEventListener('fullscreenchange', onFsChange);
  document.addEventListener('webkitfullscreenchange', onFsChange);

  return {
    open: show,
    close: hide,
    toggle,
    update,
    /* re-read the host's current project - call after the detail photo changes */
    refresh() { if (open) { syncFromProject(); reflectPlaying(); } },
    isOpen() { return open; },
  };
}
