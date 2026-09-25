// Dienstmodule (ARCHITECTURE §1: stations, media, playout, planning, outputs, integrations, auth, system).
// Der Sendekern (Sender, Quellen, Relay, Ausgänge, Queue, Playout) liegt in app.ts und wird in Schritt 4
// mit Audio-Engine und Mode-Manager neu gebaut; alles Übrige liegt hier.

import type { AirDeckApp } from '../app.ts';
import { LautfmService } from './lautfm.ts';
import { NextcloudService } from './nextcloud.ts';
import { SystemService } from './system.ts';

export function createServices(app: AirDeckApp) {
  return {
    nextcloud: new NextcloudService(app),
    lautfm: new LautfmService(app),
    system: new SystemService(app),
  };
}

export type Services = ReturnType<typeof createServices>;
