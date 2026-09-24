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
// Build-Kennung für die Update-Prüfung der App
const build = (process.env.GITHUB_SHA || execSync('git rev-parse HEAD', { cwd: here, encoding: 'utf8' }).trim()).slice(0, 7);
const version = JSON.parse(readFileSync(resolve(here, '../../package.json'), 'utf8')).version;
writeFileSync(join(www, 'build.json'), JSON.stringify({ build, version, platform: 'android' }));

if (!existsSync(join(here, 'android'))) run('npx cap add android');

// Mikrofon (MIC LIVE) und Klartext-HTTP zum AirDeck-Server im lokalen Netz
const manifest = join(here, 'android/app/src/main/AndroidManifest.xml');
let xml = readFileSync(manifest, 'utf8');
for (const perm of ['android.permission.RECORD_AUDIO', 'android.permission.MODIFY_AUDIO_SETTINGS', 'android.permission.WAKE_LOCK']) {
  if (!xml.includes(perm)) xml = xml.replace('</manifest>', `    <uses-permission android:name="${perm}" />\n</manifest>`);
}
if (!xml.includes('usesCleartextTraffic')) xml = xml.replace('<application', '<application android:usesCleartextTraffic="true"');
writeFileSync(manifest, xml);

// AirDeck-App-Icons (Launcher, rund, Adaptive-Icon-Vordergrund) übernehmen
cpSync(join(here, 'res'), join(here, 'android/app/src/main/res'), { recursive: true });

run('npx cap sync android');
console.log('✓ Android-Projekt bereit: apps/android/android');
