/* Transient bottom toast notification. Self-contained. */
const toastEl = document.getElementById('toast');
const gsap = window.gsap;
let toastTimer = null;

export function toast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  gsap.fromTo(toastEl, { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.3, ease: 'power2.out' });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    gsap.to(toastEl, { opacity: 0, duration: 0.4, onComplete: () => { toastEl.hidden = true; } });
  }, 2600);
}
