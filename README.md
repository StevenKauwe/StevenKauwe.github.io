# stevenkauwe.github.io

Steven Kauwe's site: one page of painted career chapters, films, papers and (soon) an in-browser stem splitter.
Hand-written HTML/CSS plus `loops.js` and `films.js`; no build step. The chapter loops are painted with the brush
engine in `music-to-movie-magic` (`songs/site-chapters/`). The films live in the `films` repo, served at `/films/`;
the potato lives at `/potato/` and streams from `/films/` too.

The root `this-is-the-whole-website.mp4` and `poster.webp` must stay: old links point straight at them.

Local: `node tools/serve.mjs 8777 . ../films` (mounts the films repo at `/films/`, with Range support), then
`node tools/check.mjs http://127.0.0.1:8777/ [check…]` with Chrome on `--remote-debugging-port=9222`.
