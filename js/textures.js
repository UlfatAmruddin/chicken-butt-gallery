/* Renders a gallery card (header labels + cover artwork + footer tags) onto a
   canvas and returns it as a Three.js texture. Pure given (p, img, maxAniso). */
import * as THREE from './vendor/three.module.js';
import { LOW_POWER } from './config.js';
import { coverDraw } from './util.js';

export function makeCardTexture(p, img, maxAniso) {
  const S = LOW_POWER.cardTextureSize;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const x = c.getContext('2d');
  x.fillStyle = '#000';
  x.fillRect(0, 0, S, S);
  const pad = 18;

  // header — client (left), project title (right)
  x.fillStyle = '#d9d9d9';
  x.font = p.logo === 'mono' ? '700 16px "Space Mono"' : '600 19px Inter';
  x.fillText(p.client, pad, 36);
  x.font = '400 12px "Space Mono"';
  x.fillStyle = '#8e8e8e';
  x.textAlign = 'right';
  x.fillText(p.title, S - pad, 34);
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

  // footer — category, boxed tags, year
  const fy = S - 22;
  x.font = '400 12px "Space Mono"';
  x.fillStyle = '#9a9a9a';
  let tx0 = pad;
  x.fillText(p.cat, tx0, fy);
  tx0 += x.measureText(p.cat).width + 10;
  x.font = '400 11px "Space Mono"';
  for (const t of p.tags) {
    const w = x.measureText(t).width + 14;
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
  x.fillText(String(p.year), S - pad, fy);
  x.textAlign = 'left';

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = Math.min(2, maxAniso);
  return tex;
}
