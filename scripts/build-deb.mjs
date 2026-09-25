// Baut aus dist/AirDeck/ (zuvor: node scripts/build.mjs --sea, unter Linux) ein Debian-Paket
// dist/airdeck_<version>_amd64.deb – Dienst „airdeck-server“ (systemd), Daten unter /var/lib/airdeck.
// Aufruf: node scripts/build.mjs --sea && node scripts/build-deb.mjs
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'dist');
const built = join(dist, 'AirDeck', 'airdeck-server');
if (process.platform !== 'linux') {
  console.error('Ein .deb entsteht nur unter Linux (aktuell: ' + process.platform + ').');
  process.exit(1);
}
if (!existsSync(built)) {
  console.error(`Fehlt: ${built} – zuerst "node scripts/build.mjs --sea" ausführen.`);
  process.exit(1);
}
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

const pkgRoot = join(dist, 'deb-root');
rmSync(pkgRoot, { recursive: true, force: true });

// Programmdateien unter /opt/airdeck (read-only, root:root – der Dienst läuft als eigener Benutzer „airdeck“)
const opt = join(pkgRoot, 'opt', 'airdeck');
mkdirSync(opt, { recursive: true });
cpSync(built, join(opt, 'airdeck-server'));
chmodSync(join(opt, 'airdeck-server'), 0o755);
cpSync(join(dist, 'AirDeck', 'studio'), join(opt, 'studio'), { recursive: true });
cpSync(join(root, 'HAFTUNGSAUSSCHLUSS.md'), join(opt, 'HAFTUNGSAUSSCHLUSS.md'));
cpSync(join(root, 'README.md'), join(opt, 'README.md'));

// /usr/bin/airdeck-server – bequemer Aufruf für den Administrator, z. B. „airdeck-server --new-admin-token“
const bin = join(pkgRoot, 'usr', 'bin');
mkdirSync(bin, { recursive: true });
writeFileSync(join(bin, 'airdeck-server'), '#!/bin/sh\nexec /opt/airdeck/airdeck-server "$@"\n');
chmodSync(join(bin, 'airdeck-server'), 0o755);

// systemd-Dienst
const systemdDir = join(pkgRoot, 'usr', 'lib', 'systemd', 'system');
mkdirSync(systemdDir, { recursive: true });
cpSync(join(root, 'packaging', 'linux', 'airdeck-server.service'), join(systemdDir, 'airdeck-server.service'));

// Paket-Doku (Debian-Konvention)
const docDir = join(pkgRoot, 'usr', 'share', 'doc', 'airdeck');
mkdirSync(docDir, { recursive: true });
cpSync(join(root, 'packaging', 'linux', 'copyright'), join(docDir, 'copyright'));

// DEBIAN-Kontrollordner: control (mit eingesetzter Version) + Maintainer-Skripte
const ctrl = join(pkgRoot, 'DEBIAN');
mkdirSync(ctrl, { recursive: true });
const control = readFileSync(join(root, 'packaging', 'linux', 'control'), 'utf8').replace('__VERSION__', version);
writeFileSync(join(ctrl, 'control'), control);
for (const script of ['postinst', 'prerm', 'postrm']) {
  cpSync(join(root, 'packaging', 'linux', script), join(ctrl, script));
  chmodSync(join(ctrl, script), 0o755);
}

const out = join(dist, `airdeck_${version}_amd64.deb`);
// --root-owner-group: alle Dateien im Archiv gehören root:root, unabhängig vom Baukonto (dpkg ≥ 1.19.1)
execFileSync('dpkg-deb', ['--root-owner-group', '--build', pkgRoot, out], { stdio: 'inherit' });
console.log(`✓ ${out}`);
