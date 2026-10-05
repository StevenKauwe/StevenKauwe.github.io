# stevenkauwe.github.io

Hosts the browser build of [PhotoCraft](https://github.com/storytold/photocraft), an open-source,
pure-Rust image editor by the [ArtCraft](https://getartcraft.com/) team, at
**https://stevenkauwe.github.io/photocraft/**. Everything runs client-side in WebAssembly
(WebGPU, falling back to WebGL2); no files leave your browser.

Nothing is built here. [`deploy.yml`](.github/workflows/deploy.yml) downloads the
`photocraft-web-*.zip` bundle from PhotoCraft's latest GitHub release and publishes it to Pages,
on every push to `main`, daily, and on demand (Actions → Deploy to GitHub Pages → Run workflow,
optionally with a specific release tag).

PhotoCraft is licensed MIT OR Apache-2.0; both license files and its NOTICE ship alongside the
app in `/photocraft/`. The bundle is deployed unmodified, so it keeps its ArtCraft branding as
the official build. This site is not affiliated with ArtCraft.
