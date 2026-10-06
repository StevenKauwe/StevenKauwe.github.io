// loops.js: painted loops animate only while on screen; elsewhere, and for reduced motion, they show their still.
(() => {
  const calm = matchMedia('(prefers-reduced-motion: reduce)');
  const loops = [...document.querySelectorAll('img.loop[data-loop]')];
  const near = new Set();
  const show = img => {
    const want = near.has(img) && !calm.matches ? img.dataset.loop : img.dataset.still;
    if (img.getAttribute('src') !== want) img.setAttribute('src', want);
  };
  for (const img of loops) img.dataset.still = img.getAttribute('src');
  const io = new IntersectionObserver(entries => {
    for (const e of entries) { if (e.isIntersecting) near.add(e.target); else near.delete(e.target); show(e.target); }
  }, { rootMargin: '120px 0px' });
  loops.forEach(img => io.observe(img));
  calm.addEventListener('change', () => loops.forEach(show));
})();
