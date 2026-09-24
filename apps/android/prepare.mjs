// Bereitet das Android-Projekt vor: Studio kopieren, Plattform anlegen, Berechtigungen setzen, synchronisieren.
// Voraussetzungen: Node >= 22, JDK 21, Android SDK (ANDROID_HOME).
import { execSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const here = import.meta.dirname;
const www = join(here, 'www');
const run = (cmd) => execSync(cmd, { cwd: here, stdio: 'inherit' });

rmSync(www, { recursive: true, force: true });
cpSync(resolve(here, '../../studio'), www, { recursive: true, filter: (src) => !src.endsWith('tsconfig.json') });

if (!existsSync(join(here, 'android'))) run('npx cap add android');

// Mikrofon (MIC LIVE) und Klartext-HTTP zum AirDeck-Server im lokalen Netz
const manifest = join(here, 'android/app/src/main/AndroidManifest.xml');
let xml = readFileSync(manifest, 'utf8');
for (const perm of ['android.permission.RECORD_AUDIO', 'android.permission.MODIFY_AUDIO_SETTINGS', 'android.permission.WAKE_LOCK']) {
  if (!xml.includes(perm)) xml = xml.replace('</manifest>', `    <uses-permission android:name="${perm}" />\n</manifest>`);
}
if (!xml.includes('usesCleartextTraffic')) xml = xml.replace('<application', '<application android:usesCleartextTraffic="true"');
writeFileSync(manifest, xml);

run('npx cap sync android');
console.log('✓ Android-Projekt bereit: apps/android/android');
