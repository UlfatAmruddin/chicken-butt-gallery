/* Keepsake share-card renderers extracted from main.js: the recap card and the
   album contact sheet. Pure given their data + the active community name (passed
   in, no shared state), so they live outside the client god-file. The mosaic
   poster lives in js/mosaic.js; all three use the shared canvas chrome in util.js.
   loadCors keeps Supabase-hosted photos from tainting the canvas before toBlob. */
import { coverDraw, mediaSrc, drawShareBackdrop, fitHeadingFont, recapDateLabel, clipText } from './util.js';
import { toast } from './toast.js';

/* CORS-enabled image load shared by the share-card renderers so photos on
   Supabase Storage do not taint the canvas (toBlob would throw SecurityError).
   Public buckets send ACAO; a broken URL resolves to null so callers fall back
   to a placeholder instead of aborting the whole card. */
export function loadCors(src) {
  return new Promise(res => {
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.decoding = 'async';
    im.onload = () => res(im);
    im.onerror = () => res(null);
    im.src = src;
  });
}

/* ---- shareable recap card -------------------------------------------------
   Draws the last-loaded recap object to an offscreen portrait canvas in the
   same Space Mono / Inter + coverDraw() aesthetic as the sphere card textures,
   then hands back the canvas. Purely client-side; mosaic photos load CORS-enabled
   so a Supabase-hosted top photo does not taint the canvas before toBlob().
   All text is app-generated or comes from esc()'d-equivalent trusted fields
   (drawn to canvas, never innerHTML). */
export async function renderRecapCard(r, communityName) {
  const W = 1080, H = 1350;               // portrait share-card (4:5)
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d');
  const pad = 72;

  // shared share-card chrome: backdrop + soft glow + inset border
  drawShareBackdrop(x, W, H);

  // header - kicker + community name + date range
  x.textAlign = 'left';
  x.fillStyle = '#8e8e8e';
  x.font = '700 22px "Space Mono"';
  x.fillText('SHARED RECAP', pad, pad + 8);

  const name = String((r.community && r.community.name) || communityName || 'OUR SPHERE').toUpperCase();
  x.fillStyle = '#ffffff';
  // fitHeadingFont stops shrinking at its 44px floor, so a very long community
  // name still runs off the card edge - clip whatever is left over at that size.
  fitHeadingFont(x, name, W - pad * 2, 92, 44);
  x.fillText(clipText(x, name, W - pad * 2), pad, pad + 108);

  x.fillStyle = '#9a9a9a';
  x.font = '400 24px "Space Mono"';
  x.fillText(recapDateLabel(r.range).toUpperCase(), pad, pad + 152);

  // stat grid - 2x2 boxed cells (photos / albums / members / prompts)
  const stats = [
    [r.photoCount, `PHOTO${r.photoCount === 1 ? '' : 'S'}`],
    [r.albumCount, `ALBUM${r.albumCount === 1 ? '' : 'S'}`],
    [r.memberCount, `MEMBER${r.memberCount === 1 ? '' : 'S'}`],
    [r.promptCount, `PROMPT${r.promptCount === 1 ? '' : 'S'}`],
  ];
  const gridTop = pad + 200, gap = 16;
  const cellW = (W - pad * 2 - gap) / 2, cellH = 150;
  stats.forEach(([n, label], i) => {
    const cx = pad + (i % 2) * (cellW + gap);
    const cy = gridTop + Math.floor(i / 2) * (cellH + gap);
    x.beginPath();
    x.roundRect(cx, cy, cellW, cellH, 18);
    x.fillStyle = '#0d0d0d'; x.fill();
    x.strokeStyle = '#1f1f1f'; x.lineWidth = 1.5; x.stroke();
    x.fillStyle = '#ffffff';
    x.font = '600 64px Inter';
    x.textBaseline = 'alphabetic';
    x.fillText(String(n || 0), cx + 26, cy + 82);
    x.fillStyle = '#8e8e8e';
    x.font = '400 20px "Space Mono"';
    x.fillText(String(label), cx + 26, cy + 118);
  });

  // most-loved mosaic - up to 4 covers in a row, drawn with coverDraw()
  const mosaicTop = gridTop + cellH * 2 + gap + 56;
  x.fillStyle = '#8e8e8e';
  x.font = '700 22px "Space Mono"';
  x.fillText('MOST LOVED', pad, mosaicTop);
  const photos = (r.topPhotos || []).slice(0, 4);
  const tileGap = 16;
  const tileW = (W - pad * 2 - tileGap * 3) / 4;
  const tileY = mosaicTop + 24, tileH = tileW;
  const imgs = await Promise.all(photos.map(tp => loadCors(mediaSrc(tp.file))));
  for (let i = 0; i < 4; i++) {
    const tx = pad + i * (tileW + tileGap);
    x.save();
    x.beginPath();
    x.roundRect(tx, tileY, tileW, tileH, 14);
    x.clip();
    x.fillStyle = '#141414';
    x.fillRect(tx, tileY, tileW, tileH);
    const img = imgs[i];
    if (img) coverDraw(x, img, { x: tx, y: tileY, w: tileW, h: tileH });
    x.restore();
    x.strokeStyle = 'rgba(255,255,255,0.10)';
    x.lineWidth = 1;
    x.beginPath();
    x.roundRect(tx + 0.5, tileY + 0.5, tileW - 1, tileH - 1, 14);
    x.stroke();
  }

  // top members - short list of the most active contributors
  let ty = tileY + tileH + 64;
  const members = (r.topMembers || []).slice(0, 3);
  if (members.length) {
    x.fillStyle = '#8e8e8e';
    x.font = '700 22px "Space Mono"';
    x.fillText('MOST ACTIVE', pad, ty);
    ty += 44;
    // each row is a user-supplied name (left) against a right-aligned count, so
    // they share one row from opposite edges. the count is app-generated and the
    // part worth keeping, so it is measured first and the name gets the rest:
    // without a budget a long display name drew straight through the count.
    const rowW = W - pad * 2;
    members.forEach(m => {
      const who = String(m.displayName || m.username || 'someone');
      const count = `${m.photoCount || 0} PHOTO${m.photoCount === 1 ? '' : 'S'}`;
      x.font = '400 22px "Space Mono"';
      const countW = x.measureText(count).width;
      x.fillStyle = '#e8e8e8';
      x.font = '500 30px Inter';
      x.fillText(clipText(x, who, rowW - countW - gap), pad, ty);
      x.fillStyle = '#7a7a7a';
      x.font = '400 22px "Space Mono"';
      x.textAlign = 'right';
      x.fillText(count, W - pad, ty);
      x.textAlign = 'left';
      ty += 46;
    });
  }

  // footer - brand line, matching the detail footer
  x.fillStyle = '#6a6a6a';
  x.font = '400 20px "Space Mono"';
  x.fillText('CHICKEN BUTT GALLERY - A PRIVATE MEMORY SPHERE', pad, H - pad + 8);

  return c;
}

export async function renderAlbumContactSheet(album, posts, communityName) {
  const W = 1080, H = 1350;               // portrait share-card (4:5)
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d');
  const pad = 72;

  // shared share-card chrome: backdrop + soft glow + inset border
  drawShareBackdrop(x, W, H);

  // header - kicker + album name (auto-shrink) + community name + count/owner
  x.textAlign = 'left';
  x.textBaseline = 'alphabetic';
  x.fillStyle = '#8e8e8e';
  x.font = '700 22px "Space Mono"';
  x.fillText('SHARED ALBUM', pad, pad + 8);

  const headerW = W - pad * 2;
  const name = String(album.name || 'ALBUM').toUpperCase();
  x.fillStyle = '#ffffff';
  // fitHeadingFont stops shrinking at its 40px floor, so a very long album name
  // still runs off the card edge - clip whatever is left over at that size.
  fitHeadingFont(x, name, headerW, 84, 40);
  x.fillText(clipText(x, name, headerW), pad, pad + 104);

  const community = String(communityName || 'OUR SPHERE').toUpperCase();
  x.fillStyle = '#9a9a9a';
  x.font = '400 24px "Space Mono"';
  // this line has no auto-shrink, so the community name needs the card width as
  // an explicit budget or it draws through the inset border
  x.fillText(clipText(x, community, headerW), pad, pad + 148);

  const total = posts.length;
  const tail = ` / ${total} PHOTO${total === 1 ? '' : 'S'}`.toUpperCase();
  const owner = `@${album.owner || 'someone'}`.toUpperCase();
  x.fillStyle = '#7a7a7a';
  x.font = '400 22px "Space Mono"';
  // only the handle is user-supplied, so the count is measured first and the
  // handle takes the remainder - clipping the whole line would drop the count
  x.fillText(clipText(x, owner, headerW - x.measureText(tail).width) + tail, pad, pad + 184);

  // photo grid - up to 12 covers, 3 columns, rounded cells with a thin frame.
  // cellH is fitted to the remaining vertical space (not forced square) so the
  // full-height 4-row case (10-12 photos) still clears the footer instead of
  // spilling past the bottom edge; coverDraw center-crops non-square cells.
  const shown = posts.slice(0, 12);
  const cols = 3;
  const cellGap = 16;
  const gridTop = pad + 224;
  const cellW = (W - pad * 2 - cellGap * (cols - 1)) / cols;
  const rows = Math.ceil(shown.length / cols);
  const footerReserve = 70;                         // room for footer + '+N more' note
  const gridBottomMax = H - pad - footerReserve;
  const availH = gridBottomMax - gridTop - cellGap * (rows - 1);
  const cellH = Math.min(cellW, availH / rows);
  const imgs = await Promise.all(shown.map(p => loadCors(mediaSrc(p.file))));
  shown.forEach((p, i) => {
    const cx = pad + (i % cols) * (cellW + cellGap);
    const cy = gridTop + Math.floor(i / cols) * (cellH + cellGap);
    x.save();
    x.beginPath();
    x.roundRect(cx, cy, cellW, cellH, 8);
    x.clip();
    x.fillStyle = '#141414';
    x.fillRect(cx, cy, cellW, cellH);
    const img = imgs[i];
    if (img) coverDraw(x, img, { x: cx, y: cy, w: cellW, h: cellH });
    else {
      // placeholder for a photo that failed to load - a broken URL cannot abort.
      // textAlign is restored by the enclosing x.restore(), so no manual reset.
      x.fillStyle = '#5a5a5a';
      x.font = '400 20px "Space Mono"';
      x.textAlign = 'center';
      x.fillText('?', cx + cellW / 2, cy + cellH / 2 + 8);
    }
    x.restore();
    x.strokeStyle = 'rgba(255,255,255,0.10)';
    x.lineWidth = 1;
    x.beginPath();
    x.roundRect(cx + 0.5, cy + 0.5, cellW - 1, cellH - 1, 8);
    x.stroke();
  });

  // footer - brand line, matching the recap card + detail footer
  x.fillStyle = '#6a6a6a';
  x.font = '400 20px "Space Mono"';
  if (total > shown.length) {
    x.fillText(`+ ${total - shown.length} MORE IN THIS ALBUM`.toUpperCase(), pad, H - pad + 8 - 28);
  }
  x.fillText('CHICKEN BUTT GALLERY - A PRIVATE MEMORY SPHERE', pad, H - pad + 8);

  return c;
}

/* download a blob as a file via an object URL + click */
/* trigger a download of a blob under `filename` via an object URL */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* Web-Share the image where supported, else download it */
/* share a rendered keepsake image via the Web Share API when available (with a
   file), else fall back to a plain download; guarded so a cancel/failure never
   leaves a dangling toast. shared by the album sheet + sphere poster. */
export async function shareOrDownloadBlob(blob, filename, title, text, savingToast) {
  const file = new File([blob], filename, { type: 'image/png' });
  if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title, text });
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return;  // user dismissed the share sheet
      // any other failure: fall through to a download so the keepsake is not lost
    }
  }
  downloadBlob(blob, filename);
  toast(savingToast);
}
