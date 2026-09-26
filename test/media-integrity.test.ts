// Masterprompt V1 Beta, P1 #11 (Medienverwaltung): Duplicate Detection, Missing Media und Relink
// existierten bisher nur fuer eingebundene Ordner (scanFolder). Dieser Test sichert die neuen
// MediaService-Faehigkeiten fuer die gesamte Bibliothek ab: echte Datei hochladen, vom Datentraeger
// loeschen (simuliert einen unvollstaendigen Restore/manuelles Aufraeumen), Erkennung pruefen, dann
// per Relink auf eine vorhandene, unbekannte Datei im Medienordner umbiegen - ohne zweite Mediendatenbank.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AirDeckApp } from '../src/server/app.ts';
import { createHttpServer } from '../src/server/http.ts';

function wav(seconds: number, freq: number): Buffer {
  const rate = 22050;
  const n = Math.floor(rate * seconds);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(9000 * Math.sin((2 * Math.PI * freq * i) / rate)), 44 + i * 2);
  return b;
}

test('Medien-Integritaetspruefung: Duplikate erkennen, fehlende Datei erkennen, per Relink reparieren', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'airdeck-integrity-'));
  const app = new AirDeckApp(dir, { stableMs: 0, ffmpeg: null });
  const server = createHttpServer(app, join(import.meta.dirname, '../studio'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
  const { token } = app.svc.auth.createToken({ name: 't', scopes: ['*'], roles: ['admin'], stationIds: ['*'] });
  const headers = { Authorization: `Bearer ${token}` };
  const json = { ...headers, 'Content-Type': 'application/json' };

  try {
    // Zwei Titel mit exakt gleichem Interpret/Titel/Laenge hochladen -> muessen als Duplikat erkannt werden.
    const upA = await fetch(`${base}/stations/main/media?name=${encodeURIComponent('Sommerhit.wav')}&category=music`, { method: 'PUT', headers, body: wav(1, 440) });
    const mediaA = await upA.json() as { id: string };
    const upB = await fetch(`${base}/stations/main/media?name=${encodeURIComponent('Sommerhit Kopie.wav')}&category=music`, { method: 'PUT', headers, body: wav(1, 440) });
    const mediaB = await upB.json() as { id: string };
    await fetch(`${base}/stations/main/media/${mediaA.id}`, { method: 'PATCH', headers: json, body: JSON.stringify({ artist: 'Testband', title: 'Sommerhit', durationMs: 1000 }) });
    await fetch(`${base}/stations/main/media/${mediaB.id}`, { method: 'PATCH', headers: json, body: JSON.stringify({ artist: 'Testband', title: 'Sommerhit', durationMs: 1000 }) });

    // Dritter Titel, dessen Datei danach vom Datentraeger verschwindet (unvollstaendiger Restore/manuelles Loeschen).
    const upC = await fetch(`${base}/stations/main/media?name=${encodeURIComponent('Verlorener Titel.wav')}&category=music`, { method: 'PUT', headers, body: wav(1, 660) });
    const mediaC = await upC.json() as { id: string; file: string };
    unlinkSync(join(app.mediaDir, 'main', mediaC.file));

    const check = await (await fetch(`${base}/stations/main/media/integrity`, { headers })).json() as {
      missing: Array<{ id: string }>; duplicates: Array<Array<{ id: string }>>; orphans: string[];
    };
    assert.equal(check.missing.length, 1, 'genau der fehlende Titel wird erkannt');
    assert.equal(check.missing[0]!.id, mediaC.id);
    assert.ok(check.duplicates.some((g) => g.length === 2 && g.some((m) => m.id === mediaA.id) && g.some((m) => m.id === mediaB.id)), 'Duplikat-Gruppe gefunden');
    assert.equal(check.orphans.length, 0, 'keine verwaisten Dateien vorhanden');

    // Verwaiste Datei simulieren, wie sie z. B. bei einem unvollstaendigen Restore uebrig bleibt:
    // Datei liegt im Medienordner, aber kein Bibliothekseintrag zeigt darauf.
    const orphanFile = 'm_wiedergefunden.wav';
    writeFileSync(join(app.mediaDir, 'main', orphanFile), wav(1, 220));

    const check2 = await (await fetch(`${base}/stations/main/media/integrity`, { headers })).json() as { orphans: string[] };
    assert.deepEqual(check2.orphans, [orphanFile], 'verwaiste Datei wird gefunden');

    const relink = await fetch(`${base}/stations/main/media/${mediaC.id}/relink`, { method: 'POST', headers: json, body: JSON.stringify({ file: orphanFile }) });
    assert.equal(relink.status, 200);
    const relinked = await relink.json() as { file: string };
    assert.equal(relinked.file, orphanFile);

    const check3 = await (await fetch(`${base}/stations/main/media/integrity`, { headers })).json() as { missing: unknown[]; orphans: string[] };
    assert.equal(check3.missing.length, 0, 'nach Relink kein fehlender Titel mehr');
    assert.equal(check3.orphans.length, 0, 'Datei ist jetzt wieder referenziert');

    // Relink auf einen Eintrag, dessen Datei noch existiert, muss abgelehnt werden.
    const rejected = await fetch(`${base}/stations/main/media/${mediaA.id}/relink`, { method: 'POST', headers: json, body: JSON.stringify({ file: orphanFile }) });
    assert.equal(rejected.status, 409);
  } finally {
    app.shutdown();
    server.closeAllConnections();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
