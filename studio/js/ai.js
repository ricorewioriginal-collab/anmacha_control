// @ts-check
// KI-Automation im Studio: AI Radio Director pro Sender, Anbieter & API-Keys, Kosten/Budgets, Werkzeuge.
// Alle KI-Aufrufe laufen über den AirDeck-Server – Keys verlassen ihn nie.

import { clockTime, formDialog, h, run, status } from './ui.js';

const TABS = /** @type {const} */ ([['director', 'Director'], ['providers', 'Anbieter & Keys'], ['costs', 'Kosten & Budget'], ['tools', 'Werkzeuge']]);
const KIND_LABEL = /** @type {Record<string,string>} */ ({
  openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google Gemini', openai_compat: 'OpenAI-kompatibel (Ollama, LM Studio, Kokoro …)',
  elevenlabs: 'ElevenLabs', piper: 'Piper (lokal, offline)',
});
const DECISION = /** @type {Record<string,string>} */ ({ break: 'Moderation', news: 'Nachrichten', music: 'Musikplanung', approved: 'Freigegeben', rejected: 'Verworfen', source: 'Quelle' });

/** @typedef {{ api: import('./api.js').Api, url: (p: string) => string, mediaUrl: (id: string) => string }} Ctx */

/** @param {HTMLElement} root @param {Ctx} ctx */
export function mountAi(root, ctx) {
  let tab = 'director';
  /** @type {any} */ let settings = null;
  /** @type {any} */ let station = null;
  /** @type {HTMLAudioElement|null} */ let pre = null;
  const content = h('div', { class: 'lf-content' });

  /** @param {string} title @param {...(Node|string|null|false)} body */
  const card = (title, ...body) => h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', {}, title)), ...body);
  /** @param {string} k @param {any} v */
  const kv = (k, v) => h('div', { class: 'kv' }, h('span', { class: 'muted' }, k), h('span', {}, v === null || v === undefined || v === '' ? '–' : String(v)));
  const money = (/** @type {number} */ v) => `${(v ?? 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 4 })} ${settings?.currency ?? 'EUR'}`;
  const byRole = (/** @type {'text'|'voice'} */ r) => (settings?.providers ?? []).filter((/** @type {any} */ p) => p.role === r);

  async function load() {
    // Einstellungen sind nur für globale Admins sichtbar; Sender-Ansicht auch für Redakteure
    settings = await ctx.api.get('/ai/settings').catch(() => null);
    station = await ctx.api.get(ctx.url('/ai'));
  }

  function render() {
    const head = h('div', { class: 'lf-head' },
      h('div', { class: 'lf-title' }, h('strong', {}, 'KI-Automation'),
        h('span', { class: 'muted' }, station?.config.enabled ? ` · aktiv${station.config.music.enabled ? ' · plant Musik' : ''}${station.config.approval ? ' · mit Freigabe' : ''}` : ' · aus')),
      h('div', { class: 'tabs' }, ...TABS.map(([id, label]) => h('button', { 'aria-pressed': String(tab === id), disabled: !settings && (id === 'providers' || id === 'costs'), onclick: () => { tab = id; render(); } }, label))));
    root.replaceChildren(head, content);
    content.replaceChildren(h('div', { class: 'empty' }, 'Lade …'));
    const fn = { director, providers, costs, tools }[tab];
    run(async () => content.replaceChildren(...(await fn()).filter((x) => x)));
  }

  const refresh = () => run(async () => { await load(); render(); });

  // ---------- Director ----------

  async function director() {
    const c = station.config;
    const st = station.state;
    const textP = settings?.providers.find((/** @type {any} */ p) => p.id === c.text.providerId);
    const voiceP = settings?.providers.find((/** @type {any} */ p) => p.id === c.voice.providerId);
    const noProviders = settings && !settings.providers.length;
    return [
      noProviders ? card('Erste Schritte',
        h('p', {}, 'Die KI-Automation nutzt deine eigenen API-Keys oder lokale Modelle. So geht es los:'),
        h('ol', {},
          h('li', {}, 'Unter „Anbieter & Keys“ einen Text-Anbieter (z. B. OpenAI, Anthropic, Gemini oder lokal Ollama) und einen Sprach-Anbieter (z. B. OpenAI TTS, ElevenLabs, Piper) anlegen.'),
          h('li', {}, 'Hier unter „Einstellungen“ Modell, Stimme, Moderator-Persona und Quellen (Nachrichten/Wetter als RSS/JSON) wählen.'),
          h('li', {}, 'KI-Automation einschalten. Optional „Freigabe“ aktivieren, dann geht nichts ungeprüft auf Sendung.')),
        h('button', { class: 'btn primary', onclick: () => { tab = 'providers'; render(); } }, 'Anbieter einrichten')) : null,
      h('div', { class: 'view-grid' },
        card('Director',
          kv('Status', c.enabled ? 'aktiv' : 'aus'),
          kv('Moderation', c.everySongs ? `nach jedem ${c.everySongs}. Titel (max. ${c.maxWords} Wörter)` : 'aus'),
          kv('Nachrichten', c.topOfHourNews ? 'zur vollen Stunde (aus Quellen)' : 'aus'),
          kv('Musikplanung', c.music.enabled ? `KI, ${c.music.lookahead} Titel voraus${c.music.jingleEvery ? `, Jingle alle ${c.music.jingleEvery}` : ''}` : 'Sendeuhr'),
          kv('Text', c.text.providerId ? `${textP?.name ?? c.text.providerId} · ${c.text.model || '–'}${c.text.fallback ? ` (Fallback: ${c.text.fallback.providerId} · ${c.text.fallback.model})` : ''}` : 'nicht gewählt'),
          kv('Stimme', c.voice.providerId ? `${voiceP?.name ?? c.voice.providerId} · ${c.voice.voice || '–'}` : 'nicht gewählt'),
          kv('Persona', c.persona),
          kv('Quellen', c.sources.map((/** @type {any} */ s) => s.name).join(', ')),
          h('div', { class: 'row' },
            h('button', { class: 'btn primary', onclick: editDirector }, 'Einstellungen …'),
            h('button', { class: 'btn', disabled: st.busy, onclick: () => produce('break') }, 'Jetzt moderieren'),
            h('button', { class: 'btn', disabled: st.busy, onclick: () => produce('news') }, 'Nachrichten jetzt'),
            h('button', { class: 'btn', disabled: st.musicBusy, onclick: planMusic }, 'Musik planen'))),
        card(`Freigaben (${st.pending.length})`,
          st.pending.length ? null : h('div', { class: 'empty' }, c.approval ? 'Keine offenen Freigaben.' : 'Freigabe ist aus – Moderationen gehen direkt in die Queue.'),
          ...st.pending.map((/** @type {any} */ p) => h('div', { class: 'ai-pending' },
            h('div', {}, h('strong', {}, p.kind === 'news' ? 'Nachrichten' : 'Moderation'), h('span', { class: 'muted' }, ` · ${clockTime(p.createdAt)}`)),
            h('p', {}, p.text),
            h('div', { class: 'row' },
              h('button', { class: 'btn small', onclick: () => preview(p.mediaId) }, '▶ Anhören'),
              h('button', { class: 'btn small primary', onclick: () => decide(p.id, 'approve') }, 'Freigeben'),
              h('button', { class: 'btn small danger', onclick: () => decide(p.id, 'reject') }, 'Verwerfen'))))),
      ),
      card('Protokoll',
        st.log.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'list' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Zeit'), h('th', {}, 'Art'), h('th', {}, 'Ergebnis'), h('th', {}, 'Kosten'), h('th', {}, 'Dauer'))),
          h('tbody', {}, ...st.log.map((/** @type {any} */ d) => h('tr', {},
            h('td', { class: 'num muted' }, clockTime(d.at)),
            h('td', {}, DECISION[d.kind] ?? d.kind),
            h('td', { class: d.ok ? '' : 'err' }, `${d.ok ? '' : '⚠ '}${d.detail}`),
            h('td', { class: 'num' }, d.cost ? money(d.cost) : ''),
            h('td', { class: 'num muted' }, d.ms ? `${(d.ms / 1000).toFixed(1)} s` : '')))))) : h('div', { class: 'empty' }, 'Noch keine KI-Entscheidungen.')),
    ];
  }

  /** @param {'break'|'news'} kind */
  async function produce(kind) {
    status(kind === 'news' ? 'KI schreibt Nachrichten …' : 'KI moderiert …');
    const r = await run(() => ctx.api.post(ctx.url('/ai/moderation'), { kind }));
    if (r) status(r.text ? 'Moderation wartet auf Freigabe' : `„${r.title}“ ist als Nächstes in der Queue`);
    refresh();
  }

  async function planMusic() {
    status('KI plant Musik …');
    const r = await run(() => ctx.api.post(ctx.url('/ai/music')));
    if (r) status(r.added ? `${r.added} Titel von der KI eingeplant` : 'KI-Musikplanung ohne Ergebnis – siehe Protokoll', !r.added);
    refresh();
  }

  /** @param {string} id @param {'approve'|'reject'} what */
  async function decide(id, what) {
    await run(() => ctx.api.post(ctx.url(`/ai/pending/${encodeURIComponent(id)}/${what}`)));
    refresh();
  }

  /** @param {string} mediaId */
  function preview(mediaId) {
    pre?.pause();
    pre = new Audio(ctx.mediaUrl(mediaId));
    pre.play().catch(() => status('Anhören nicht möglich', true));
  }

  /** Modellvorschläge vom Anbieter laden (still, wenn nicht möglich). @param {string} id */
  async function modelsOf(id) {
    if (!id) return [];
    return /** @type {string[]} */ (await ctx.api.get(`/ai/providers/${encodeURIComponent(id)}/models`).catch(() => []));
  }

  async function editDirector() {
    const c = station.config;
    const texts = byRole('text');
    const voices = byRole('voice');
    const opts = (/** @type {any[]} */ list) => /** @type {[string,string][]} */ ([['', '– keiner –'], ...list.map((p) => [p.id, `${p.name} (${KIND_LABEL[p.kind] ?? p.kind})`])]);
    const [m1, m2] = await Promise.all([modelsOf(c.text.providerId), modelsOf(c.text.fallback?.providerId ?? '')]);
    const vp = voices.find((/** @type {any} */ p) => p.id === c.voice.providerId);
    const voiceList = vp?.kind === 'elevenlabs' ? /** @type {any[]} */ (await ctx.api.get(`/ai/providers/${vp.id}/voices`).catch(() => [])) : [];
    const v = await formDialog('KI-Director · Einstellungen', [
      { name: 'enabled', label: 'KI-Automation für diesen Sender aktiv', type: 'checkbox', value: c.enabled },
      { name: 'approval', label: 'Freigabe: Moderationen erst nach Prüfung senden', type: 'checkbox', value: c.approval },
      { name: 'everySongs', label: 'Moderation nach jedem n-ten Musiktitel (0 = aus)', type: 'number', value: c.everySongs },
      { name: 'maxWords', label: 'Höchstlänge einer Moderation (Wörter)', type: 'number', value: c.maxWords },
      { name: 'topOfHourNews', label: 'Nachrichten zur vollen Stunde (nur mit Nachrichtenquelle)', type: 'checkbox', value: c.topOfHourNews },
      { name: 'persona', label: 'Moderator / Persona', value: c.persona, hint: 'z. B. „Mia, Morgenmoderatorin, gut gelaunt, kennt die Region“' },
      { name: 'style', label: 'Stil', value: c.style },
      { name: 'language', label: 'Sprache', value: c.language },
      { name: 'textProvider', label: 'Text: Anbieter', value: c.text.providerId, options: opts(texts) },
      { name: 'textModel', label: 'Text: Modell', value: c.text.model, suggest: m1, hint: m1.length ? `${m1.length} Modelle vom Anbieter` : 'Modell-ID eintragen (Liste nach dem Speichern des Anbieters verfügbar)' },
      { name: 'temperature', label: 'Kreativität (0–2, leer = Standard des Modells)', type: 'number', value: c.text.temperature ?? '' },
      { name: 'fbProvider', label: 'Text: Fallback-Anbieter', value: c.text.fallback?.providerId ?? '', options: opts(texts) },
      { name: 'fbModel', label: 'Text: Fallback-Modell', value: c.text.fallback?.model ?? '', suggest: m2 },
      { name: 'voiceProvider', label: 'Stimme: Anbieter', value: c.voice.providerId, options: opts(voices) },
      { name: 'voice', label: 'Stimme', value: c.voice.voice, suggest: voiceList.map((x) => x.id), hint: vp?.kind === 'piper' ? 'Pfad zur .onnx-Stimme, z. B. C:\\Piper\\de_DE-thorsten-high.onnx' : vp?.kind === 'elevenlabs' ? voiceList.map((x) => `${x.name}: ${x.id}`).slice(0, 8).join(' · ') : 'z. B. alloy, nova, onyx (OpenAI) bzw. Stimmname des lokalen Servers' },
      { name: 'voiceModel', label: 'Sprachmodell (optional)', value: c.voice.model ?? '', hint: 'z. B. tts-1 / gpt-4o-mini-tts (OpenAI), eleven_multilingual_v2 (ElevenLabs)' },
      { name: 'speed', label: 'Sprechtempo (0.5–2, leer = normal)', type: 'number', value: c.voice.speed ?? '' },
      { name: 'music', label: 'KI plant die Musik (Sendeuhr nur noch als Rückfall)', type: 'checkbox', value: c.music.enabled },
      { name: 'lookahead', label: 'KI-Musik: Titel im Voraus', type: 'number', value: c.music.lookahead },
      { name: 'jingleEvery', label: 'KI-Musik: Station-ID/Jingle alle n Titel (0 = aus)', type: 'number', value: c.music.jingleEvery },
      { name: 'instructions', label: 'KI-Musik: Vorgaben', type: 'textarea', value: c.music.instructions, hint: 'z. B. „morgens ruhiger Einstieg, ab 16 Uhr mehr Tempo, keine zwei Balladen hintereinander“' },
      { name: 'sources', label: 'Quellen (eine pro Zeile: Name | URL | rss/json/text | news/weather/info)', type: 'textarea', value: c.sources.map((/** @type {any} */ s) => `${s.name} | ${s.url} | ${s.kind} | ${s.use}`).join('\n'), hint: 'Wetter z. B. Open-Meteo: Wetter | https://api.open-meteo.com/v1/forecast?latitude=52.52&longitude=13.41&current=temperature_2m,weather_code | json | weather' },
      { name: 'keepGenerated', label: 'KI-Sprachdateien behalten (ältere werden gelöscht)', type: 'number', value: c.keepGenerated },
    ], 'Speichern');
    if (!v) return;
    const sources = String(v.sources ?? '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const [name, url, kind, use] = l.split('|').map((x) => x.trim());
      return { name, url, kind: kind || 'rss', use: use || 'info' };
    });
    const body = {
      enabled: v.enabled, approval: v.approval, everySongs: v.everySongs ?? 0, maxWords: v.maxWords ?? 45, topOfHourNews: v.topOfHourNews,
      persona: v.persona, style: v.style, language: v.language, keepGenerated: v.keepGenerated ?? 30, sources,
      text: { providerId: v.textProvider, model: v.textModel, ...(v.temperature !== null ? { temperature: v.temperature } : {}), fallback: v.fbProvider ? { providerId: v.fbProvider, model: v.fbModel } : null },
      voice: { providerId: v.voiceProvider, voice: v.voice, model: v.voiceModel, ...(v.speed !== null ? { speed: v.speed } : {}) },
      music: { enabled: v.music, lookahead: v.lookahead ?? 3, jingleEvery: v.jingleEvery ?? 0, instructions: v.instructions },
    };
    if (await run(() => ctx.api.put(ctx.url('/ai'), body))) status('KI-Einstellungen gespeichert');
    refresh();
  }

  // ---------- Anbieter ----------

  async function providers() {
    const list = settings.providers;
    return [
      card('Anbieter & API-Keys',
        h('p', { class: 'muted' }, 'Eigene Keys werden verschlüsselt auf diesem AirDeck gespeichert und nie angezeigt. Lokale Modelle (Ollama, LM Studio, Kokoro, Piper) funktionieren ohne Key und offline.'),
        list.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'list' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Art'), h('th', {}, 'Typ'), h('th', {}, 'Key'), h('th', {}, ''))),
          h('tbody', {}, ...list.map((/** @type {any} */ p) => h('tr', {},
            h('td', {}, p.name, p.enabled ? '' : h('span', { class: 'muted' }, ' (aus)')),
            h('td', {}, p.role === 'voice' ? 'Sprache' : 'Text'),
            h('td', {}, KIND_LABEL[p.kind] ?? p.kind, p.baseUrl ? h('div', { class: 'muted small' }, p.baseUrl) : null),
            h('td', {}, p.hasKey ? '🔒 hinterlegt' : p.kind === 'openai_compat' || p.kind === 'piper' ? 'nicht nötig' : '⚠ fehlt'),
            h('td', { class: 'act' },
              h('button', { class: 'btn small', onclick: () => testProvider(p) }, 'Testen'),
              h('button', { class: 'btn small', onclick: () => editProvider(p) }, 'Bearbeiten'))))))) : h('div', { class: 'empty' }, 'Noch kein Anbieter angelegt.'),
        h('div', { class: 'row' },
          h('button', { class: 'btn primary', onclick: () => editProvider(null, 'text') }, '＋ Text-Anbieter'),
          h('button', { class: 'btn', onclick: () => editProvider(null, 'voice') }, '＋ Sprach-Anbieter'))),
    ];
  }

  /** @param {any} p */
  async function testProvider(p) {
    if (p.role === 'voice' && p.kind !== 'elevenlabs') return status('Sprach-Anbieter testen: unter „Werkzeuge“ einen kurzen Text vertonen');
    status(`Teste ${p.name} …`);
    const list = await run(() => ctx.api.get(`/ai/providers/${encodeURIComponent(p.id)}/${p.kind === 'elevenlabs' ? 'voices' : 'models'}`));
    if (list) status(`${p.name}: Verbindung OK – ${list.length} ${p.kind === 'elevenlabs' ? 'Stimmen' : 'Modelle'} verfügbar`);
  }

  /** @param {any} p @param {'text'|'voice'} [role] */
  async function editProvider(p, role = p?.role) {
    const kinds = /** @type {string[]} */ (settings.kinds[role]);
    const v = await formDialog(p ? `Anbieter: ${p.name}` : role === 'voice' ? 'Sprach-Anbieter anlegen' : 'Text-Anbieter anlegen', [
      { name: 'name', label: 'Name', value: p?.name ?? '', required: true },
      { name: 'kind', label: 'Typ', value: p?.kind ?? kinds[0], options: kinds.map((k) => /** @type {[string,string]} */ ([k, KIND_LABEL[k] ?? k])) },
      { name: 'key', label: p?.hasKey ? 'API-Key (leer = unverändert, "-" = löschen)' : 'API-Key', type: 'password', value: '' },
      { name: 'baseUrl', label: 'Basis-URL (nur kompatible Server/Proxys)', value: p?.baseUrl ?? '', hint: 'Ollama: http://localhost:11434/v1 · LM Studio: http://localhost:1234/v1 · Kokoro-FastAPI: http://localhost:8880/v1' },
      ...(role === 'voice' ? [{ name: 'binPath', label: 'Piper: Pfad zu piper(.exe)', value: p?.binPath ?? '', hint: 'leer = „piper“ aus dem PATH' }] : []),
      { name: 'enabled', label: 'Aktiv', type: 'checkbox', value: p?.enabled ?? true },
      ...(p ? [{ name: 'remove', label: 'Anbieter löschen (Key wird entfernt)', type: 'checkbox', value: false }] : []),
    ]);
    if (!v) return;
    const id = p?.id ?? (v.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'ki') + (settings.providers.some((/** @type {any} */ x) => x.id === v.name.toLowerCase()) ? `-${Date.now().toString(36).slice(-3)}` : '');
    const others = settings.providers.filter((/** @type {any} */ x) => x.id !== p?.id).map((/** @type {any} */ x) => ({ ...x, key: undefined }));
    const next = v.remove ? others : [...others, { id, role, name: v.name, kind: v.kind, baseUrl: v.baseUrl, binPath: v.binPath, enabled: v.enabled, key: v.key || undefined }];
    if (await run(() => ctx.api.put('/ai/settings', { providers: next }))) status(v.remove ? 'Anbieter gelöscht' : 'Anbieter gespeichert');
    refresh();
  }

  // ---------- Kosten ----------

  async function costs() {
    const u = await ctx.api.get('/ai/usage');
    const rows = (/** @type {Record<string, any>} */ m, /** @type {(k:string)=>string} */ name) => Object.entries(m).map(([k, r]) => h('tr', {},
      h('td', {}, name(k)), h('td', { class: 'num' }, String(r.calls)), h('td', { class: 'num' }, `${r.inputTokens.toLocaleString('de-DE')} / ${r.outputTokens.toLocaleString('de-DE')}`),
      h('td', { class: 'num' }, r.chars.toLocaleString('de-DE')), h('td', { class: 'num' }, money(r.cost)), h('td', { class: 'num' }, String(r.errors))));
    const provName = (/** @type {string} */ id) => settings.providers.find((/** @type {any} */ p) => p.id === id)?.name ?? id;
    const table = (/** @type {Node[]} */ body) => h('div', { class: 'table-wrap' }, h('table', { class: 'list' },
      h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'Aufrufe'), h('th', {}, 'Token ein/aus'), h('th', {}, 'Zeichen'), h('th', {}, 'Kosten'), h('th', {}, 'Fehler'))), h('tbody', {}, ...body)));
    return [
      h('div', { class: 'view-grid' },
        card(`Verbrauch ${u.month}`, table(rows(u.byProvider, provName)), h('p', { class: 'muted' }, 'Kosten werden nur berechnet, wenn unten ein Preis hinterlegt ist (keine geschätzten Preise).')),
        card('Pro Sender', table(rows(u.byStation, (k) => k)))),
      card('Preise & Budgets',
        kv('Währung', settings.currency),
        ...settings.pricing.map((/** @type {any} */ p) => kv(`${provName(p.providerId)} · ${p.model}`, `${p.inPerM ?? 0} / ${p.outPerM ?? 0} je 1 Mio. Token${p.perMChars ? ` · ${p.perMChars} je 1 Mio. Zeichen` : ''}`)),
        ...Object.entries(settings.budgets.providers).map(([k, b]) => kv(`Budget ${provName(k)}`, `Warnung ${b.soft ?? '–'} · Stopp ${b.hard ?? '–'}`)),
        ...Object.entries(settings.budgets.stations).map(([k, b]) => kv(`Budget Sender ${k}`, `Warnung ${b.soft ?? '–'} · Stopp ${b.hard ?? '–'}`)),
        h('button', { class: 'btn', onclick: editCosts }, 'Preise & Budgets bearbeiten …')),
      card('Letzte Aufrufe', table(u.recent.slice(0, 40).map((/** @type {any} */ e) => h('tr', {},
        h('td', {}, `${clockTime(e.at)} · ${provName(e.providerId)} · ${e.model || e.kind} · ${e.purpose}${e.ok ? '' : ` ⚠ ${e.error}`}`),
        h('td', { class: 'num' }, `${(e.ms / 1000).toFixed(1)} s`), h('td', { class: 'num' }, `${e.inputTokens} / ${e.outputTokens}`), h('td', { class: 'num' }, String(e.chars)),
        h('td', { class: 'num' }, money(e.cost)), h('td', {}, e.ok ? '' : '1'))))),
    ];
  }

  async function editCosts() {
    const v = await formDialog('Preise & Budgets', [
      { name: 'currency', label: 'Währung (ISO, z. B. EUR, USD)', value: settings.currency },
      { name: 'pricing', label: 'Preise (eine Zeile: Anbieter-ID | Modell oder * | Eingabe je 1 Mio. Token | Ausgabe je 1 Mio. Token | je 1 Mio. Zeichen)', type: 'textarea',
        value: settings.pricing.map((/** @type {any} */ p) => [p.providerId, p.model, p.inPerM ?? '', p.outPerM ?? '', p.perMChars ?? ''].join(' | ')).join('\n'), hint: `Anbieter-IDs: ${settings.providers.map((/** @type {any} */ p) => p.id).join(', ') || '–'} · Preise aus der Preisliste deines Anbieters übernehmen` },
      { name: 'budgets', label: 'Monatsbudgets (eine Zeile: provider:<id> oder station:<id> | Warnung | Stopp)', type: 'textarea',
        value: [...Object.entries(settings.budgets.providers).map(([k, b]) => `provider:${k} | ${b.soft ?? ''} | ${b.hard ?? ''}`), ...Object.entries(settings.budgets.stations).map(([k, b]) => `station:${k} | ${b.soft ?? ''} | ${b.hard ?? ''}`)].join('\n'),
        hint: 'Bei „Stopp“ wird der Anbieter bzw. der Sender für den Rest des Monats nicht mehr genutzt – der Fallback oder die Sendeuhr übernimmt' },
    ], 'Speichern');
    if (!v) return;
    const num = (/** @type {string|undefined} */ x) => (x === undefined || x.trim() === '' ? undefined : Number(x.replace(',', '.')));
    const pricing = String(v.pricing).split('\n').map((l) => l.split('|').map((x) => x.trim())).filter((x) => x[0] && x[1]).map(([providerId, model, i, o, c]) => ({ providerId, model, inPerM: num(i), outPerM: num(o), perMChars: num(c) }));
    /** @type {{providers: Record<string, any>, stations: Record<string, any>}} */
    const budgets = { providers: {}, stations: {} };
    for (const l of String(v.budgets).split('\n')) {
      const [key, soft, hard] = l.split('|').map((x) => x.trim());
      const m = /^(provider|station):(.+)$/.exec(key ?? '');
      if (m) budgets[m[1] === 'provider' ? 'providers' : 'stations'][m[2]] = { soft: num(soft), hard: num(hard) };
    }
    if (await run(() => ctx.api.put('/ai/settings', { currency: v.currency.toUpperCase(), pricing, budgets }))) status('Preise & Budgets gespeichert');
    refresh();
  }

  // ---------- Werkzeuge ----------

  async function tools() {
    const prompt = /** @type {HTMLTextAreaElement} */ (h('textarea', { rows: '5', placeholder: 'z. B. „Schreibe einen 20-Sekunden-Werbespot für die Bäckerei Müller, Angebot: 3 Brötchen 1 €“' }));
    const out = /** @type {HTMLTextAreaElement} */ (h('textarea', { rows: '8', placeholder: 'Ergebnis – hier auch direkt Text zum Vertonen eingeben' }));
    const title = /** @type {HTMLInputElement} */ (h('input', { placeholder: 'Titel in der Bibliothek' }));
    const cat = /** @type {HTMLSelectElement} */ (h('select', {}, ...[['tts', 'TTS'], ['ad', 'Werbung'], ['jingle', 'Jingle'], ['station_id', 'Station ID'], ['news', 'News'], ['voice_track', 'Voice Track'], ['drop', 'Drop']].map(([v, l]) => h('option', { value: v }, l))));
    const presets = [
      ['Werbespot', 'Schreibe einen gesprochenen Radio-Werbespot (ca. 20 Sekunden) für: '],
      ['Station-ID', 'Schreibe 5 kurze Station-IDs (je max. 8 Wörter) für unseren Sender, Stil: '],
      ['Sendungsidee', 'Plane eine einstündige Radiosendung mit Ablauf, Themen und Moderationsideen zum Thema: '],
      ['Hörergruß', 'Formuliere einen kurzen, freundlichen Hörergruß für die Moderation: '],
    ];
    return [
      h('div', { class: 'view-grid' },
        card('Assistent (Text)',
          h('div', { class: 'row' }, ...presets.map(([l, p]) => h('button', { class: 'btn small', onclick: () => { prompt.value = p; prompt.focus(); } }, l))),
          prompt,
          h('button', { class: 'btn primary', onclick: async () => {
            status('KI schreibt …');
            const r = await run(() => ctx.api.post(ctx.url('/ai/text'), { prompt: prompt.value }));
            if (r) { out.value = r.text; status(`Fertig (${r.model}${r.cost ? ` · ${money(r.cost)}` : ''})`); }
          } }, 'Text erzeugen')),
        card('Voice Studio (vertonen → Bibliothek)',
          out,
          h('div', { class: 'row' }, title, cat),
          h('button', { class: 'btn primary', onclick: async () => {
            status('KI spricht …');
            const m = await run(() => ctx.api.post(ctx.url('/ai/speech'), { text: out.value, title: title.value, category: cat.value }));
            if (m) { status(`„${m.title}“ liegt in der Bibliothek (Ordner KI-Studio)`); preview(m.id); }
          } }, 'Vertonen & speichern'))),
    ];
  }

  return {
    show: () => run(async () => { await load(); render(); }),
    /** SSE: neue Entscheidungen/Freigaben live anzeigen */
    onEvent(/** @type {string} */ type) {
      if ((type === 'ai.decision' || type === 'ai.pending') && tab === 'director' && root.isConnected && !root.closest('[hidden]')) refresh();
    },
  };
}
