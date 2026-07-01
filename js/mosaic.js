/* ---- shareable sphere mosaic poster ---------------------------------------
   Draws the ENTIRE community wall - every photo, tiled - into one offscreen
   canvas so friends can post the shared sphere as a single keepsake image.
   Same Space Mono / Inter dark aesthetic as renderRecapCard / the album sheet:
   a boxed near-black backdrop, a 'SHARED SPHERE' kicker, the community name
   (auto-shrunk to fit), an 'N PHOTOS / M MEMBERS' sub-line, then a dense
   adaptive grid of all photo covers with a graceful '+K MORE' footer when a
   community is too big to tile every cell.

   Dependency-free by design: main.js passes in the shared canvas helpers
   (coverDraw, loadCors, mediaSrc, sanitizeBase) so there is no import cycle and
   Supabase-hosted covers load CORS-enabled and never taint the canvas before
   toBlob(). All text is app-generated / trusted and drawn to the canvas (never
   innerHTML). Returns the canvas; the caller handles toBlob + download / share. */

import { drawShareBackdrop, fitHeadingFont } from './util.js';

const MAX_CELLS = 100;   // hard cap on tiled covers; the rest roll into '+K MORE'

/* build the sphere poster canvas.
   community: the active community ({ name, memberCount, ... }).
   posts:     raw communityPosts (each carries `file`).
   helpers:   { coverDraw, loadCors, mediaSrc, sanitizeBase } from main.js. */
export async function renderMosaicPoster(community, posts, helpers) {
  const { coverDraw, loadCors, mediaSrc } = helpers;
  const W = 1080, H = 1350;               // portrait share-card (4:5), matches recap
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d');
  const pad = 72;

  // shared share-card chrome: backdrop + soft glow + inset border
  drawShareBackdrop(x, W, H);

  // header - kicker + community name (auto-shrink) + photos/members sub-line
  x.textAlign = 'left';
  x.textBaseline = 'alphabetic';
  x.fillStyle = '#8e8e8e';
  x.font = '700 22px "Space Mono"';
  x.fillText('SHARED SPHERE', pad, pad + 8);

  const name = String((community && community.name) || 'OUR SPHERE').toUpperCase();
  x.fillStyle = '#ffffff';
  fitHeadingFont(x, name, W - pad * 2, 92, 44);
  x.fillText(name, pad, pad + 108);

  const total = posts.length;
  const members = (community && community.memberCount) || 0;
  const sub = `${total} PHOTO${total === 1 ? '' : 'S'} / ${members} MEMBER${members === 1 ? '' : 'S'}`;
  x.fillStyle = '#9a9a9a';
  x.font = '400 24px "Space Mono"';
  x.fillText(sub, pad, pad + 152);

  // adaptive grid - fit ALL covers into the remaining space. derive column count
  // from the cell aspect (square) so the tiles roughly fill the poster width, cap
  // the tiled count at MAX_CELLS (a '+K MORE' footer covers any overflow, exactly
  // like the album sheet caps at 12), then fit the cell height to what is left.
  const gridTop = pad + 196;
  const cellGap = 10;
  const footerReserve = 70;                          // room for footer + '+K more' note
  const gridBottomMax = H - pad - footerReserve;
  const gridW = W - pad * 2;
  const gridH = gridBottomMax - gridTop;
  const aspect = gridW / gridH;                       // >1: wider than tall

  const shown = posts.slice(0, MAX_CELLS);
  const count = shown.length || 1;
  // cols chosen so cols/rows tracks the grid aspect, keeping cells near-square
  let cols = Math.max(1, Math.round(Math.sqrt(count * aspect)));
  cols = Math.min(cols, count);
  let rows = Math.ceil(count / cols);
  // a wide last-row gap can leave cells oddly large; nudge cols up if rows overshoot
  while (cols < count && (gridH / rows) > (gridW / cols) * 1.35) {
    cols += 1;
    rows = Math.ceil(count / cols);
  }

  const cellW = (gridW - cellGap * (cols - 1)) / cols;
  const cellH = Math.min(cellW, (gridH - cellGap * (rows - 1)) / rows);
  // center the block vertically in the available band so short walls sit tidy
  const blockH = cellH * rows + cellGap * (rows - 1);
  const startY = gridTop + Math.max(0, (gridH - blockH) / 2);
  const radius = cellW < 90 ? 5 : 8;                  // tighter tiles read better small

  const imgs = await Promise.all(shown.map(p => loadCors(mediaSrc(p.file))));
  shown.forEach((p, i) => {
    const cx = pad + (i % cols) * (cellW + cellGap);
    const cy = startY + Math.floor(i / cols) * (cellH + cellGap);
    x.save();
    x.beginPath();
    x.roundRect(cx, cy, cellW, cellH, radius);
    x.clip();
    x.fillStyle = '#141414';
    x.fillRect(cx, cy, cellW, cellH);
    const img = imgs[i];
    if (img) coverDraw(x, img, { x: cx, y: cy, w: cellW, h: cellH });
    else {
      // placeholder for a photo that failed to load - a broken URL cannot abort.
      // textAlign is restored by the enclosing x.restore(), so no manual reset.
      x.fillStyle = '#5a5a5a';
      x.font = '400 18px "Space Mono"';
      x.textAlign = 'center';
      x.fillText('?', cx + cellW / 2, cy + cellH / 2 + 6);
    }
    x.restore();
    x.strokeStyle = 'rgba(255,255,255,0.10)';
    x.lineWidth = 1;
    x.beginPath();
    x.roundRect(cx + 0.5, cy + 0.5, cellW - 1, cellH - 1, radius);
    x.stroke();
  });

  // footer - brand line, matching the recap card + album sheet; '+K MORE' when
  // the wall overflows the tiled cap so the count never lies.
  x.fillStyle = '#6a6a6a';
  x.font = '400 20px "Space Mono"';
  x.textAlign = 'left';
  if (total > shown.length) {
    x.fillText(`+ ${total - shown.length} MORE ON THE WALL`.toUpperCase(), pad, H - pad + 8 - 28);
  }
  x.fillText('CHICKEN BUTT GALLERY - A PRIVATE MEMORY SPHERE', pad, H - pad + 8);

  return c;
}
