// Dienstmodule (ARCHITECTURE §1: stations, media, playout, planning, outputs, integrations, auth, system).
// Der Sendekern (Sender, Quellen, Relay, Ausgänge, Queue, Playout) liegt in app.ts und wird in Schritt 4
// mit Audio-Engine und Mode-Manager neu gebaut; alles Übrige liegt hier.

import type { AirDeckApp } from '../app.ts';
import { AiToolsService } from './ai.ts';
import { AuthService } from './auth.ts';
import { BridgeService } from './bridges.ts';
import { LautfmService } from './lautfm.ts';
import { NextcloudService } from './nextcloud.ts';
import { NotificationService } from './notifications.ts';
import { StatusService } from './status.ts';
import { SystemService } from './system.ts';

export function createServices(app: AirDeckApp) {
  return {
    auth: new AuthService(app),
    nextcloud: new NextcloudService(app),
    lautfm: new LautfmService(app),
    system: new SystemService(app),
    notifications: new NotificationService(app),
    bridges: new BridgeService(app),
    status: new StatusService(app),
    ai: new AiToolsService(app),
  };
}

export type Services = ReturnType<typeof createServices>;
