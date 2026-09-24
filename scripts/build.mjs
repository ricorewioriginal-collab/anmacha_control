// Baut das AirDeck-Programm:
//   node scripts/build.mjs            → dist/airdeck.cjs (ein gebündeltes Skript, ohne Abhängigkeiten)
//   node scripts/build.mjs --sea      → dist/AirDeck/AirDeck(.exe) als Einzeldatei mit eingebettetem Node
//                                       (Node Single Executable Application) + studio/ + Startskripte
// ffmpeg wird nicht mitgebaut: liegt es in dist/AirDeck/ffmpeg/, nutzt AirDeck es automatisch.

import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { cpSync, copyFileSync, mkdirSync, rmSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'dist');
const sea = process.argv.includes('--sea');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

await build({
  entryPoints: [join(root, 'src/server/main.ts')],
  outfile: join(dist, 'airdeck.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  legalComments: 'none',
  define: { 'import.meta.url': 'undefined' },
  banner: {
    js: [
      '/* AirDeck ' + version + ' */',
      'const __sea = (() => { try { return require("node:sea").isSea(); } catch { return false; } })();',
      'globalThis.__AIRDECK_PACKAGED = __sea;',
      'globalThis.__AIRDECK_ROOT = __sea ? require("node:path").dirname(process.execPath) : require("node:path").resolve(__dirname, "..");',
    ].join('\n'),
  },
  logLevel: 'warning',
});
console.log('✓ dist/airdeck.cjs');

if (sea) {
  const win = process.platform === 'win32';
  const out = join(dist, 'AirDeck');
  const exe = join(out, win ? 'AirDeck.exe' : 'AirDeck');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(dist, 'sea-config.json'), JSON.stringify({
    main: join(dist, 'airdeck.cjs'),
    output: join(dist, 'sea-prep.blob'),
    disableExperimentalSEAWarning: true,
    useCodeCache: false,
    useSnapshot: false,
  }));
  execFileSync(process.execPath, ['--experimental-sea-config', join(dist, 'sea-config.json')], { stdio: 'inherit' });
  copyFileSync(process.execPath, exe);
  if (!win) chmodSync(exe, 0o755);
  if (win) {
    // Programm-Icon und Versionsinfos in die .exe schreiben (vor dem Einbetten des Programms)
    const { default: rcedit } = await import('rcedit');
    const rc = /** @type {any} */ (rcedit);
    await (typeof rc === 'function' ? rc : rc.rcedit)(exe, {
      icon: join(root, 'assets', 'icons', 'airdeck-windows.ico'),
      'file-version': version, 'product-version': version,
      'version-string': { ProductName: 'AirDeck', FileDescription: 'AirDeck Radio Automation', CompanyName: 'AirDeck', LegalCopyright: 'AirDeck – powered by AnMaCha', OriginalFilename: 'AirDeck.exe' },
    });
    console.log('✓ Icon & Versionsinfo gesetzt');
  }
  if (process.platform === 'darwin') execFileSync('codesign', ['--remove-signature', exe]);
  const postject = join(root, 'node_modules', 'postject', 'dist', 'cli.js');
  execFileSync(process.execPath, [postject, exe, 'NODE_SEA_BLOB', join(dist, 'sea-prep.blob'),
    '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    ...(process.platform === 'darwin' ? ['--macho-segment-name', 'NODE_SEA'] : [])], { stdio: 'inherit' });
  if (process.platform === 'darwin') execFileSync('codesign', ['--sign', '-', exe]);

  cpSync(join(root, 'studio'), join(out, 'studio'), { recursive: true, filter: (src) => !src.endsWith('tsconfig.json') });
  cpSync(join(root, 'packaging', 'windows'), out, { recursive: true, filter: (src) => !src.endsWith('.iss') });
  mkdirSync(join(out, 'icons'), { recursive: true });
  for (const f of ['airdeck-windows.ico', 'airdeck-server.ico']) copyFileSync(join(root, 'assets', 'icons', f), join(out, 'icons', f));
  copyFileSync(join(root, 'README.md'), join(out, 'README.md'));
  mkdirSync(join(out, 'ffmpeg'), { recursive: true });
  console.log(`✓ ${exe}`);
}
