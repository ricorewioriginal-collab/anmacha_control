// IcecastOutput: der PUT-Source-Client darf nicht auf die HTTP-Antwort warten, bevor er Audiodaten
// schickt. Manche Icecast-kompatible Server (u. a. vermutlich laut.fm, siehe Nutzerbericht "Verbindung
// steht, aber kein Audiosignal kommt an") antworten selbst erst, sobald Audiodaten angekommen sind -
// wartet der Client seinerseits auf die Antwort, blockieren sich beide Seiten gegenseitig (Deadlock).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { IcecastOutput, type OutputConfig } from '../src/server/icecast.ts';

const cfg = (port: number): OutputConfig => ({
  id: 'out1', stationId: 'main', name: 'Test', type: 'icecast',
  host: '127.0.0.1', port, mount: '/live', username: 'source', passwordRef: 'pw',
  tls: false, sourceTarget: '/live', enabled: true,
});

test('IcecastOutput: kein Deadlock bei Servern, die erst nach Audiodaten antworten (laut.fm-Fall)', async () => {
  const server = createServer((req, res) => {
    let responded = false;
    req.on('data', () => {
      if (!responded) {
        responded = true;
        res.writeHead(200);
        res.end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  try {
    const out = new IcecastOutput(cfg(port), () => 'geheim');
    out.start('audio/mpeg');
    out.write(Buffer.from('erste-audio-daten'));
    const ok = await Promise.race([
      new Promise<boolean>((r) => setTimeout(() => r(false), 3000)),
      new Promise<boolean>((r) => {
        const iv = setInterval(() => {
          if (out.state.bytesSent > 0) { clearInterval(iv); r(true); }
        }, 20);
      }),
    ]);
    assert.equal(ok, true, 'Audiodaten müssen ankommen, ohne auf die Server-Antwort zu warten');
    assert.equal(out.state.status, 'connected');
    out.stop();
  } finally {
    server.close();
  }
});

test('IcecastOutput: normaler Server (antwortet sofort 200) funktioniert weiterhin', async () => {
  const server = createServer((req, res) => {
    res.writeHead(200);
    res.end();
    req.on('data', () => {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  try {
    const out = new IcecastOutput(cfg(port), () => 'geheim');
    out.start('audio/mpeg');
    await new Promise((r) => setTimeout(r, 150));
    out.write(Buffer.from('daten'));
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(out.state.status, 'connected');
    assert.ok(out.state.bytesSent > 0);
    out.stop();
  } finally {
    server.close();
  }
});

test('IcecastOutput: 401 vom Server führt zu Fehlerstatus (kein endloser Retry)', async () => {
  const server = createServer((req, res) => {
    res.writeHead(401);
    res.end();
    req.on('data', () => {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  try {
    const out = new IcecastOutput(cfg(port), () => 'falsch');
    out.start('audio/mpeg');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(out.state.status, 'error');
    assert.equal(out.state.errorCategory, 'auth');
    out.stop();
  } finally {
    server.close();
  }
});
