// Lokaler Secret Store: AES-256-GCM verschlüsselt auf Platte.
// Schlüssel aus AIRDECK_SECRET_KEY (64 Hex-Zeichen) oder lokal erzeugter Schlüsseldatei (0600).
// Secrets verlassen den Store nur für den internen Gebrauch – nie über API oder Logs.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './store.ts';

type Encrypted = { iv: string; tag: string; data: string };

export class SecretStore {
  private readonly key: Buffer;
  private readonly file: string;
  private values: Record<string, Encrypted> = {};

  constructor(dataDir: string, envKey = process.env.AIRDECK_SECRET_KEY) {
    this.file = join(dataDir, 'secrets.json');
    this.key = SecretStore.loadKey(dataDir, envKey);
    if (existsSync(this.file)) this.values = JSON.parse(readFileSync(this.file, 'utf8'));
  }

  private static loadKey(dataDir: string, envKey?: string): Buffer {
    if (envKey) {
      if (!/^[0-9a-fA-F]{64}$/.test(envKey)) throw new Error('AIRDECK_SECRET_KEY muss 64 Hex-Zeichen haben');
      return Buffer.from(envKey, 'hex');
    }
    const keyFile = join(dataDir, '.secret.key');
    if (existsSync(keyFile)) return Buffer.from(readFileSync(keyFile, 'utf8').trim(), 'hex');
    const key = randomBytes(32);
    writeFileAtomic(keyFile, key.toString('hex'), 0o600);
    return key;
  }

  set(ref: string, value: string): void {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([c.update(value, 'utf8'), c.final()]);
    this.values[ref] = { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
    this.persist();
  }

  get(ref: string): string | undefined {
    const e = this.values[ref];
    if (!e) return undefined;
    const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(e.iv, 'base64'));
    d.setAuthTag(Buffer.from(e.tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(e.data, 'base64')), d.final()]).toString('utf8');
  }

  has(ref: string): boolean {
    return ref in this.values;
  }

  delete(ref: string): void {
    if (!(ref in this.values)) return;
    delete this.values[ref];
    this.persist();
  }

  private persist(): void {
    writeFileAtomic(this.file, JSON.stringify(this.values), 0o600);
  }
}

/** Entfernt bekannte Secret-Felder aus beliebigen Objekten (für Logs/Antworten). */
export function redact<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (k, v) => (/^(pass|password|secret|token|api[_-]?key)$/i.test(k) && typeof v === 'string' ? '***' : v)),
  );
}
