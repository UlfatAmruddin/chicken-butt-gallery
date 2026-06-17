/* Image loader with a bounded cache (oldest entries evicted first). Returns a
   Promise<HTMLImageElement|null>; null on load error. */
const IMAGE_CACHE_LIMIT = 240;
const imageCache = new Map();

export function loadImage(src) {
  if (imageCache.has(src)) return imageCache.get(src);
  const promise = new Promise(resolve => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
  imageCache.set(src, promise);
  while (imageCache.size > IMAGE_CACHE_LIMIT) imageCache.delete(imageCache.keys().next().value);
  return promise;
}
