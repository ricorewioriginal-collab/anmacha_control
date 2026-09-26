# Vendored third-party code

Files here are unmodified upstream sources bundled locally so the Studio works fully
offline/self-hosted (no CDN, no network dependency at runtime).

## qrcode.js

- Source: npm package `qrcode-generator` (https://www.npmjs.com/package/qrcode-generator)
- Version: 2.0.4, file `dist/qrcode.mjs` (renamed to `.js` - the Studio's static file server has no
  content-type mapping for `.mjs` and browsers refuse to execute a module script served as
  `application/octet-stream`; content is otherwise byte-for-byte identical)
- Author: Kazuhiko Arase (https://github.com/kazuhikoarase/qrcode-generator)
- License: MIT (license header preserved verbatim at the top of the file)

Used by `../qr.js` to render a real, scannable QR code for device pairing.

One line added on top (`// @ts-nocheck`) so our `checkJs` doesn't stumble over a harmless
IIFE in the unused Kanji-mode branch - no other change, runtime behavior identical to upstream.

## jsqr.js

- Source: npm package `jsqr` (https://www.npmjs.com/package/jsqr), file `dist/jsQR.js`
- Version: 1.4.0
- Author: Cosmo Wolfe et al. (https://github.com/cozmo/jsQR)
- License: Apache-2.0 (license header preserved separately below, not embedded in the
  minified UMD bundle itself - see upstream repository for the full text)

Used by `../qrscan.js` to decode a QR code live from the device camera (device pairing:
scan the same QR code that `qr.js` renders on the AirDeck server, no manual code entry).
Loaded as a classic (non-module) `<script>` in `index.html` before `app.js`, so it sets
the global `window.jsQR` the way the upstream UMD wrapper expects - no bundler needed.

One line added on top (`// @ts-nocheck`) so our `checkJs` doesn't stumble over the
webpack UMD bootstrap (`module`/`exports`/`define` are not typed browser globals) - no
other change, runtime behavior identical to upstream.
