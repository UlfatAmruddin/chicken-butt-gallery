/* Tunable constants. Kept in one place so the render loop, texture sizing,
   and image loader stay in sync and are easy to tweak for low-end devices. */

export const LOW_POWER = {
  maxDpr: 1,
  activeFps: 60,
  hoverInterval: 85,
  idleVelocity: 0.015,
  idlePosition: 0.004,
  introDriftMs: 2600,
  cardTextureSize: 384,
};

export const IMAGE_LOAD_CONCURRENCY = 6;
