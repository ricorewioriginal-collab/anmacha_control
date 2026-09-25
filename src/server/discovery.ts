// LAN-Erkennung (docs/architecture/NETWORK.md): Clients fragen per UDP-Broadcast „AIRDECK?1“ auf Port 8751,
// laufende AirDeck-Server antworten mit Name, Version, API-Version, HTTP-Port und ob der LAN-Zugriff an ist.
// Der Server antwortet auch, wenn die Oberfläche nur lokal freigegeben ist – dann kann der Client gezielt
// „LAN-Zugriff ist aus“ melden statt „Server nicht erreichbar“. Es wird nichts dauerhaft gesendet.

import { createSocket, type Socket } from 'node:dgram';
import { networkInterfaces } from 'node:os';

export const DISCOVERY_PORT = 8751;
export const PROBE = 'AIRDECK?1';
const REPLY = 'AIRDECK!';

export interface DiscoveryInfo {
  /** Installations-ID (zum Zusammenfassen mehrerer Antworten desselben Servers) */
  id: string;
  name: string;
  host: string;
  version: string;
  api: string;
  port: number;
  /** HTTP im Netzwerk erreichbar (sonst nur auf dem PC selbst) */
  lan: boolean;
}

export interface Found extends DiscoveryInfo {
  address: string;
  url: string | null;
}

/** Antwortet auf Erkennungsanfragen. Liefert null, wenn der Port belegt ist (z. B. zweite Instanz). */
export function startResponder(info: () => DiscoveryInfo, opts: { port?: number; log?: (msg: string) => void } = {}): Promise<{ close(): void } | null> {
  return new Promise((resolve) => {
    const sock = createSocket({ type: 'udp4', reuseAddr: true });
    let window = Date.now();
    let count = 0;
    sock.on('message', (msg, rinfo) => {
      if (msg.length !== PROBE.length || msg.toString('latin1') !== PROBE) return;
      // gegen Missbrauch als Verstärker: höchstens 50 Antworten pro Sekunde
      const now = Date.now();
      if (now - window > 1000) {
        window = now;
        count = 0;
      }
      if (++count > 50) return;
      sock.send(Buffer.from(REPLY + JSON.stringify(info())), rinfo.port, rinfo.address);
    });
    sock.once('error', (err) => {
      opts.log?.(`LAN-Erkennung nicht verfügbar: ${err.message}`);
      sock.close();
      resolve(null);
    });
    sock.bind(opts.port ?? DISCOVERY_PORT, '0.0.0.0', () => {
      sock.removeAllListeners('error');
      sock.on('error', () => {});
      resolve({ close: () => sock.close() });
    });
  });
}

/** Broadcast-Adressen aller IPv4-Netze dieses Rechners (plus 255.255.255.255 und 127.0.0.1). */
export function broadcastAddresses(): string[] {
  const out = new Set(['255.255.255.255', '127.0.0.1']);
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const ip = a.address.split('.').map(Number);
      const mask = a.netmask.split('.').map(Number);
      out.add(ip.map((b, i) => (b & mask[i]!) | (~mask[i]! & 255)).join('.'));
    }
  }
  return [...out];
}

/** AirDeck-Server im Netz suchen. */
export function discover(opts: { timeoutMs?: number; port?: number; targets?: string[] } = {}): Promise<Found[]> {
  const port = opts.port ?? DISCOVERY_PORT;
  return new Promise((resolve) => {
    const found = new Map<string, Found>();
    let sock: Socket;
    try {
      sock = createSocket('udp4');
    } catch {
      return resolve([]);
    }
    sock.on('error', () => {});
    sock.on('message', (msg, rinfo) => {
      const text = msg.toString('utf8');
      if (!text.startsWith(REPLY)) return;
      try {
        const i = JSON.parse(text.slice(REPLY.length)) as DiscoveryInfo;
        if (typeof i.id !== 'string' || typeof i.port !== 'number') return;
        const key = `${i.id}@${rinfo.address}`;
        found.set(key, { ...i, address: rinfo.address, url: i.lan || rinfo.address.startsWith('127.') ? `http://${rinfo.address}:${i.port}` : null });
      } catch {
        // fremde oder kaputte Antwort
      }
    });
    sock.bind(0, () => {
      sock.setBroadcast(true);
      for (const t of opts.targets ?? broadcastAddresses()) sock.send(PROBE, port, t, () => {});
    });
    setTimeout(() => {
      sock.close();
      // derselbe Server über mehrere Wege: die LAN-Adresse vor 127.0.0.1 bevorzugen
      const byId = new Map<string, Found>();
      for (const f of found.values()) {
        const cur = byId.get(f.id);
        if (!cur || (cur.address.startsWith('127.') && !f.address.startsWith('127.'))) byId.set(f.id, f);
      }
      resolve([...byId.values()]);
    }, opts.timeoutMs ?? 1500).unref();
  });
}
