import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const base = process.env.AIRDECK_SCREENSHOT_URL || 'http://127.0.0.1:8751';
const token = process.env.AIRDECK_SCREENSHOT_TOKEN;
if (!token) throw new Error('AIRDECK_SCREENSHOT_TOKEN fehlt');

const out = new URL('../docs/screenshots/', import.meta.url);
await mkdir(out, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1050 }, deviceScaleFactor: 1 });
await page.addInitScript((t) => localStorage.setItem('airdeck.token', t), token);
await page.goto(base + '/', { waitUntil: 'networkidle' });
await page.waitForSelector('#view-overview:not([hidden])', { timeout: 20_000 });
await page.waitForTimeout(800);

async function view(name, file) {
  await page.locator(`[data-view="${name}"]`).first().click();
  await page.waitForSelector(`#view-${name}:not([hidden])`);
  await page.waitForTimeout(500);
  await page.screenshot({ path: new URL(file, out).pathname, fullPage: true });
}
async function panel(id, file) {
  await page.locator('[data-view="studio"]').first().click();
  await page.waitForSelector('#view-studio:not([hidden])');
  await page.locator('#' + id).scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  await page.locator('#' + id).screenshot({ path: new URL(file, out).pathname });
}

await page.screenshot({ path: new URL('view-dashboard.png', out).pathname, fullPage: true });
for (const [name, file] of [
  ['studio','view-studio.png'],
  ['planning','view-planning.png'],
  ['mediathek','view-mediathek.png'],
  ['playlists','view-playlists.png'],
  ['recorder','view-recorder.png'],
  ['ai','view-ai.png'],
  ['bridges','view-bridges.png'],
  ['listeners','view-listeners.png'],
  ['users','view-users.png'],
  ['handbuch','view-handbuch.png'],
]) await view(name, file);

for (const [id, file] of [
  ['decks','panel-decks.png'],
  ['carts-panel','panel-carts.png'],
  ['work-panel','panel-lib.png'],
  ['queue-panel','panel-queue.png'],
  ['np-panel','panel-np.png'],
  ['live-panel','panel-live.png'],
  ['stream-panel','panel-stream.png'],
  ['playout-panel','panel-playout.png'],
  ['processing-panel','panel-processing.png'],
  ['meter-panel','panel-meters.png'],
  ['sources-panel','panel-sources.png'],
  ['system-panel','panel-system.png'],
]) {
  if (await page.locator('#' + id).count()) await panel(id, file);
}

await browser.close();
console.log('AirDeck-Screenshots aktualisiert.');
