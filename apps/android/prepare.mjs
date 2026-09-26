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

// Mikrofon (MIC LIVE), Handy-Sender (Vordergrund-Dienst), Kamera (QR-Code beim Koppeln scannen)
// und Klartext-HTTP zum AirDeck-Server im lokalen Netz
const manifest = join(here, 'android/app/src/main/AndroidManifest.xml');
let xml = readFileSync(manifest, 'utf8');
for (const perm of [
  'android.permission.RECORD_AUDIO', 'android.permission.MODIFY_AUDIO_SETTINGS', 'android.permission.WAKE_LOCK',
  'android.permission.FOREGROUND_SERVICE', 'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK',
  'android.permission.FOREGROUND_SERVICE_MICROPHONE', 'android.permission.POST_NOTIFICATIONS', 'android.permission.CAMERA',
]) {
  if (!xml.includes(`"${perm}"`)) xml = xml.replace('</manifest>', `    <uses-permission android:name="${perm}" />\n</manifest>`);
}
if (!xml.includes('usesCleartextTraffic')) xml = xml.replace('<application', '<application android:usesCleartextTraffic="true"');
// Kamera ist optional (Kopplung geht auch per Code-Eingabe) - App bleibt auf Geräten ohne Kamera installierbar
if (!xml.includes('android.hardware.camera')) xml = xml.replace('</manifest>', '    <uses-feature android:name="android.hardware.camera" android:required="false" />\n</manifest>');
if (!xml.includes('EngineService')) {
  xml = xml.replace('</application>', '        <service android:name="app.airdeck.engine.android.EngineService" android:exported="false" android:foregroundServiceType="mediaPlayback|microphone" />\n    </application>');
}
writeFileSync(manifest, xml);

// Handy-Engine (reines Java + Android-Schicht) ins App-Projekt übernehmen
const javaDir = join(here, 'android/app/src/main/java');
cpSync(join(here, 'engine/src'), javaDir, { recursive: true });
cpSync(join(here, 'native'), javaDir, { recursive: true });
// Plugin registrieren: eigene MainActivity (Capacitor legt sie unter der App-ID an)
const appId = JSON.parse(readFileSync(join(here, 'capacitor.config.json'), 'utf8')).appId;
writeFileSync(join(javaDir, ...appId.split('.'), 'MainActivity.java'), `package ${appId};

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import app.airdeck.engine.android.AirDeckEnginePlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AirDeckEnginePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
`);

// Versionsnummer: steigt mit jedem CI-Lauf, damit Updates über die installierte App gehen
const gradleFile = join(here, 'android/app/build.gradle');
let gradle = readFileSync(gradleFile, 'utf8');
const versionCode = Number(process.env.GITHUB_RUN_NUMBER || 1);
gradle = gradle.replace(/versionCode \d+/, `versionCode ${versionCode}`).replace(/versionName "[^"]*"/, `versionName "${version}-${build}"`);
// Offizielle Signatur (Release): Keystore über Umgebungsvariablen, nie im Repository
const ks = process.env.ANDROID_KEYSTORE;
if (ks && !gradle.includes('signingConfigs {')) {
  gradle = gradle.replace(/android \{/, `android {
    signingConfigs {
        release {
            storeFile file(System.getenv("ANDROID_KEYSTORE"))
            storePassword System.getenv("ANDROID_KEYSTORE_PASSWORD")
            keyAlias System.getenv("ANDROID_KEY_ALIAS")
            keyPassword System.getenv("ANDROID_KEY_PASSWORD")
        }
    }`).replace(/buildTypes \{\s*release \{/, (m) => `${m}\n            signingConfig signingConfigs.release`);
}
// MP3-Encoder für den Handy-Sender (LAME als reines Java, LGPL 2.1+)
if (!gradle.includes('de.sciss:jump3r')) gradle = gradle.replace(/dependencies \{/, "dependencies {\n    implementation 'de.sciss:jump3r:1.0.5'");
writeFileSync(gradleFile, gradle);

// AirDeck-App-Icons (Launcher, rund, Adaptive-Icon-Vordergrund) übernehmen
cpSync(join(here, 'res'), join(here, 'android/app/src/main/res'), { recursive: true });

run('npx cap sync android');
console.log('✓ Android-Projekt bereit: apps/android/android');
