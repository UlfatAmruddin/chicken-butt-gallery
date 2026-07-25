/* Renders a gallery card (header labels + cover artwork + footer tags) onto a
   canvas and returns it as a Three.js texture. Pure given (p, img, maxAniso). */
import * as THREE from './vendor/three.module.js';
import { LOW_POWER } from './config.js';
import { coverDraw, clipText } from './util.js';

// active community accent (#rrggbb) echoed in the faint inset frame around each
// print, so cards subtly carry the room color. Neutral gray until a room sets it.
let cardAccent = '#9a9a9a';

/* set the accent used for the inset frame stroke. Ignores anything that is not
   a #rrggbb hex so makeCardTexture stays deterministic and legible. */
export function setCardAccent(hex) {
  cardAccent = /^#[0-9a-f]{6}$/i.test(hex || '') ? hex : '#9a9a9a';
}

/* parse #rrggbb into an [r,g,b] triple */
function hexRgb(hex) {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

export function makeCardTexture(p, img, maxAniso) {
  const S = LOW_POWER.cardTextureSize;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const x = c.getContext('2d');
  x.fillStyle = '#000';
  x.fillRect(0, 0, S, S);
  const pad = 18;

  // soft luminance falloff behind the header/footer label bands so the
  // Space Mono labels stay legible over bright photos (deterministic)
  const bandH = 52;
  const topBand = x.createLinearGradient(0, 0, 0, bandH);
  topBand.addColorStop(0, 'rgba(0,0,0,0.55)');
  topBand.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = topBand;
  x.fillRect(0, 0, S, bandH);
  const botBand = x.createLinearGradient(0, S - bandH, 0, S);
  botBand.addColorStop(0, 'rgba(0,0,0,0)');
  botBand.addColorStop(1, 'rgba(0,0,0,0.55)');
  x.fillStyle = botBand;
  x.fillRect(0, S - bandH, S, bandH);

  // header - client (left), project title (right). both are user-supplied and
  // share one row, so each gets an explicit share of the width: without a budget
  // a long title ran leftwards straight through the username.
  const headerW = S - 2 * pad;
  const gap = 12;
  x.fillStyle = '#d9d9d9';
  x.font = p.logo === 'mono' ? '700 16px "Space Mono"' : '600 19px Inter';
  const clientText = clipText(x, p.client, headerW * 0.45);
  x.fillText(clientText, pad, 36);
  const usedByClient = clientText ? x.measureText(clientText).width : 0;
  x.font = '400 12px "Space Mono"';
  x.fillStyle = '#8e8e8e';
  x.textAlign = 'right';
  x.fillText(clipText(x, p.title, headerW - usedByClient - gap), S - pad, 34);
  x.textAlign = 'left';

  // artwork area
  const top = 52, bottom = S - 52;
  const full = { x: pad, y: top, w: S - 2 * pad, h: bottom - top };
  let r = full;
  if (p.layout === 'portrait') {
    const w = full.w * 0.56;
    r = { x: full.x + (full.w - w) / 2, y: full.y, w, h: full.h };
  } else if (p.layout === 'landscape') {
    const h = full.h * 0.6;
    r = { x: full.x, y: full.y + (full.h - h) / 2, w: full.w, h };
  }
  if (img) coverDraw(x, img, r);

  // premium gallery-print polish - subtle inner-glow vignette + 1px inset
  // frame around the artwork rect (only when the rect has non-zero size)
  if (r.w > 0 && r.h > 0) {
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    const inner = Math.min(r.w, r.h) * 0.34;
    const outer = Math.hypot(r.w, r.h) / 2;
    const vig = x.createRadialGradient(cx, cy, inner, cx, cy, outer);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(0,0,0,0.28)');
    x.fillStyle = vig;
    x.fillRect(r.x, r.y, r.w, r.h);
    // faint inset frame reading as a matted gallery print, tinted with the
    // active community accent at a low alpha so the room color subtly echoes
    const [fr, fg, fb] = hexRgb(cardAccent);
    x.strokeStyle = `rgba(${fr},${fg},${fb},0.14)`;
    x.lineWidth = 1;
    x.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
  }

  // footer - category, boxed tags, year. the year is right-aligned, so the chip
  // run needs a hard stop line or a photo with several tags draws straight
  // through it. chips that do not fit are dropped rather than clipped.
  const fy = S - 22;
  const year = String(p.year);
  x.font = '400 12px "Space Mono"';
  const stop = S - pad - x.measureText(year).width - 12;
  x.fillStyle = '#9a9a9a';
  let tx0 = pad;
  const cat = clipText(x, p.cat, stop - pad);
  x.fillText(cat, tx0, fy);
  tx0 += (cat ? x.measureText(cat).width : 0) + 10;
  x.font = '400 11px "Space Mono"';
  for (const t of p.tags) {
    const w = x.measureText(t).width + 14;
    if (tx0 + w > stop) break;
    const ry = fy - 14;
    x.beginPath();
    x.roundRect(tx0, ry, w, 20, 4);
    x.fillStyle = '#181818'; x.fill();
    x.strokeStyle = '#3d3d3d'; x.lineWidth = 1; x.stroke();
    x.fillStyle = '#bdbdbd';
    x.fillText(t, tx0 + 7, ry + 14);
    tx0 += w + 6;
  }
  x.textAlign = 'right';
  x.font = '400 12px "Space Mono"';
  x.fillStyle = '#8e8e8e';
  x.fillText(year, S - pad, fy);
  x.textAlign = 'left';

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = Math.min(2, maxAniso);
  return tex;
}
