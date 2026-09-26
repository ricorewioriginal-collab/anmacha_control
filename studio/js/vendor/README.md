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
