// films.js: a film card opens the player and streams the film; closing the player stops it and its download.
(() => {
  const dlg = document.querySelector('dialog.player');
  if (!dlg || !dlg.showModal) return;
  const video = dlg.querySelector('video'), title = dlg.querySelector('.player-title');
  for (const a of document.querySelectorAll('a.film')) a.addEventListener('click', e => {
    e.preventDefault();
    title.textContent = a.querySelector('.film-name').textContent;
    video.poster = a.getAttribute('href').replace(/\.mp4$/, '-poster.webp');
    video.src = a.getAttribute('href');
    dlg.showModal();
    video.play().catch(() => {});
  });
  dlg.addEventListener('close', () => { video.pause(); video.removeAttribute('src'); video.load(); });
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
})();
