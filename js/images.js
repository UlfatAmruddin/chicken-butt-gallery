/* Image loader with a bounded cache (oldest entries evicted first). Returns a
   Promise<HTMLImageElement|null>; null on load error. */
const IMAGE_CACHE_LIMIT = 240;
const imageCache = new Map();

export function loadImage(src) {
  if (imageCache.has(src)) return imageCache.get(src);
  const promise = new Promise(resolve => {
    const img = new Image();
    // request CORS so cross-origin (Supabase) photos don't taint the card
    // canvas - a tainted CanvasTexture fails to upload to WebGL. Same-origin
    // images are unaffected; Supabase public objects send CORS headers.
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => resolve(img);
    // do not cache the failure: drop the entry so a later call can retry after
    // a transient network error instead of blanking the card for the session.
    img.onerror = () => { imageCache.delete(src); resolve(null); };
    img.src = src;
  });
  imageCache.set(src, promise);
  while (imageCache.size > IMAGE_CACHE_LIMIT) imageCache.delete(imageCache.keys().next().value);
  return promise;
}
