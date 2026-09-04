# UPNG.js

Vendored from https://github.com/photopea/UPNG.js

- Commit: 88f504b6577b726975f593caa38ba85d327c7c1f
- License: MIT (see LICENSE)

Decoder, encoder and quantizer are all kept. Four `js65:` marked edits, all additive:

- An ESM export, so the entry can import it.
- The encode half takes `pako` and `window` as parameters instead of reading them as
  free globals, and is called with a `{deflate}` over `__js65_deflate` (which
  jspreprocess binds from the frontend codec) and an empty window.
- `compressPNG` and `_main` are exposed on `UPNG.encode`, so the module can write an
  indexed PNG with the caller's palette. `UPNG.encode` itself always quantizes from
  RGBA, which reorders the palette and merges duplicate entries.
