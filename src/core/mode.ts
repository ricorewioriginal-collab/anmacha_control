// Mode-Manager (docs/architecture/ARCHITECTURE.md §4).
//
// Der Operator wählt die Grundbetriebsart AUTO oder MANUAL. LIVE und EMERGENCY ergeben sich aus dem
// Sendezustand und überlagern sie; endet die Überlagerung, gilt wieder die Grundbetriebsart
// („zurück in den vorherigen Modus“).
//
//   LIVE       – eine Live-/Relay-Quelle ist laut Source Priority auf Sendung
//   EMERGENCY  – die Automation ist Programm, hat aber nichts Reguläres mehr (Notfall-Ordner) oder ihre
//                Quelle ist wegen Stille ausgefallen und es gibt keine andere Quelle

export type BaseMode = 'AUTO' | 'MANUAL';
export type Mode = BaseMode | 'LIVE' | 'EMERGENCY';
export const MODES: readonly Mode[] = ['AUTO', 'MANUAL', 'LIVE', 'EMERGENCY'];

export interface ModeInput {
  base: BaseMode;
  /** Quelle auf Sendung, die nicht die eigene Automation ist (Live-Encoder, Studio-Mikrofon, App, Relay) */
  liveOnAir: boolean;
  /** Automation liefert nur noch Notfall-Material bzw. ihre Quelle ist ausgefallen */
  emergency: boolean;
}

export function effectiveMode(i: ModeInput): Mode {
  if (i.liveOnAir) return 'LIVE';
  if (i.emergency) return 'EMERGENCY';
  return i.base;
}

/** Darf die Automation selbstständig den nächsten Titel starten (und damit die Queue verbrauchen)? */
export function automationRuns(mode: Mode): boolean {
  return mode === 'AUTO' || mode === 'EMERGENCY';
}

export interface ModeChange {
  from: Mode;
  to: Mode;
  base: BaseMode;
  reason: string;
}

/** Hält den Zustand je Sender und meldet nur echte Wechsel. */
export class ModeState {
  private input: ModeInput;
  private current: Mode;
  private readonly onChange: (c: ModeChange) => void;

  constructor(base: BaseMode, onChange: (c: ModeChange) => void) {
    this.input = { base, liveOnAir: false, emergency: false };
    this.current = effectiveMode(this.input);
    this.onChange = onChange;
  }

  get mode(): Mode {
    return this.current;
  }

  get base(): BaseMode {
    return this.input.base;
  }

  get emergency(): boolean {
    return this.input.emergency;
  }

  update(patch: Partial<ModeInput>, reason: string): Mode {
    this.input = { ...this.input, ...patch };
    const next = effectiveMode(this.input);
    if (next !== this.current) {
      const from = this.current;
      this.current = next;
      this.onChange({ from, to: next, base: this.input.base, reason });
    }
    return this.current;
  }
}
