# stevenkauwe.github.io

Steven Kauwe's site: one page of painted career chapters, films, papers and (soon) an in-browser stem splitter.
Hand-written HTML/CSS plus `loops.js` and `films.js`; no build step. The chapter loops are painted with the brush
engine in `music-to-movie-magic` (`songs/site-chapters/`). The films live in the `films` repo, served at `/films/`;
the potato lives at `/potato/` and streams from `/films/` too.
`/escher/` is "Paint a current" (Flow): a hand-drawn current is symmetrised under the 17 wallpaper groups and ink
flows along it, Rust on WebAssembly and WebGPU with a CPU fallback. It is a copy of `web/` from the local
`escher-crocs` repo (`build.sh` builds `web/pkg`).
`/river/` is "River": a pigment-grid neural cellular automaton paints the croc in watercolour on WebGL2, with a fixed
pigment budget, so a cut croc regrows as twins and two pushed together fuse. It is a copy of `web/` from the local
`river` repo (training in `river/train/`).
`/browsertabicl/` is "BrowserTabICL": fit a TabICL v2 model on your own CSV table and predict new rows, Rust on
WebAssembly, nothing uploaded. It lives in its own repository, github.com/StevenKauwe/browsertabicl, and is served
from there at `/browsertabicl/` (its `docs/` folder, weights included), so this repo must not have a `browsertabicl/`
folder. Only the home-page card and its picture (`img/apps/browsertabicl-still.webp`) are here.

The root `this-is-the-whole-website.mp4` and `poster.webp` must stay: old links point straight at them.

Local: `node tools/serve.mjs 8777 . ../films` (mounts the films repo at `/films/`, with Range support), then
`node tools/check.mjs http://127.0.0.1:8777/ [check…]` with Chrome on `--remote-debugging-port=9222`.
