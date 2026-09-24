// Liquidsoap-Brücke: erzeugt ein Liquidsoap-Skript (2.x), das den AirDeck-Sendestream annimmt,
// optional nachbearbeitet und an alle konfigurierten Ausgänge verteilt.
// Passwörter stehen nie im Skript – sie kommen aus Umgebungsvariablen.

import type { OutputConfig } from './icecast.ts';

export interface LiquidsoapOptions {
  stationName: string;
  harborPort: number;
  harborMount: string;
  bitrateKbps: number;
  /** Liquidsoap-eigene Dynamik (nrj) zusätzlich zur AirDeck-DSP */
  processing: boolean;
}

const str = (s: string) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const envName = (i: number) => `AIRDECK_LIQ_OUT${i + 1}_PASSWORD`;

export function liquidsoapScript(outputs: OutputConfig[], o: LiquidsoapOptions): { script: string; env: string[] } {
  const active = outputs.filter((x) => x.enabled);
  const env = ['AIRDECK_LIQ_INPUT_PASSWORD', ...active.map((_, i) => envName(i))];
  const mount = o.harborMount.replace(/^\/+/, '') || 'airdeck';
  const lines = [
    `# AirDeck → Liquidsoap für „${o.stationName.replace(/\n/g, ' ')}“ (automatisch erzeugt, Liquidsoap 2.x)`,
    '# Start:  liquidsoap airdeck.liq',
    `# Umgebungsvariablen (Passwörter): ${env.join(', ')}`,
    '#',
    `# In AirDeck einen Ausgang anlegen: Typ Icecast, Host = dieser Rechner, Port ${o.harborPort}, Mount /${mount},`,
    '# Benutzer source, Passwort = AIRDECK_LIQ_INPUT_PASSWORD. Die übrigen Ausgänge in AirDeck dann deaktivieren.',
    '',
    'settings.server.telnet := false',
    'def pw(name) = environment.get(name) end',
    '',
    '# 1) Eingang: der fertig gemischte AirDeck-Sendestream',
    `radio = input.harbor(${str(mount)}, port=${o.harborPort}, password=pw("AIRDECK_LIQ_INPUT_PASSWORD"))`,
    '',
    '# 2) Kein Abbruch bei Verbindungsverlust (AirDeck hat eigene Fallbacks, hier nur Stille als Sicherung)',
    'radio = mksafe(radio)',
    '',
  ];
  if (o.processing) lines.push('# 3) Zusätzliche Dynamik: Kompressor + Normalisierung', 'radio = nrj(radio)', '');
  lines.push('# Ausgänge');
  if (!active.length) lines.push('# (In AirDeck sind noch keine aktiven Ausgänge eingerichtet.)', 'output.dummy(radio)');
  active.forEach((x, i) => {
    const icy = x.type === 'shoutcast';
    const args = [
      `%mp3(bitrate=${Math.round(x.bitrateKbps ?? o.bitrateKbps)})`,
      `host=${str(x.host)}`,
      `port=${Math.round(x.port)}`,
      `user=${str(x.username || 'source')}`,
      `password=pw(${str(envName(i))})`,
      ...(icy ? ['protocol="icy"', ...(x.streamId ? [`icy_id=${Math.round(x.streamId)}`] : [])] : [`mount=${str((x.mount || '/stream') + (x.priority ? `?prio=${x.priority}` : ''))}`]),
      `name=${str(o.stationName)}`,
      'radio',
    ];
    lines.push(`# ${x.name}${x.tls ? ' (TLS: bei Bedarf transport=http.transport.ssl() ergänzen)' : ''}`, `output.icecast(${args.join(', ')})`);
  });
  return { script: lines.join('\n') + '\n', env };
}
