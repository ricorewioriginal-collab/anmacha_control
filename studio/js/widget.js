// @ts-check
// Einbettbares Player-Widget: Jetzt läuft, Fortschritt, Abspielen, letzte Titel. Daten aus /status/… (öffentlich).
(() => {
  const p = new URLSearchParams(location.search);
  const id = p.get('lautfm') ? `lautfm/${p.get('lautfm')}` : p.get('station') ?? '';
  if (p.get('theme') === 'light') document.documentElement.classList.add('light');
  const accent = (p.get('accent') ?? '').replace(/[^0-9a-f]/gi, '');
  if (accent.length === 6 || accent.length === 3) document.documentElement.style.setProperty('--accent', `#${accent}`);
  const hist = Math.max(0, Math.min(10, Number(p.get('history') ?? 3) || 0));
  const $ = (/** @type {string} */ x) => /** @type {HTMLElement} */ (document.getElementById(x));
  /** @type {any} */ let data = null;
  /** @type {HTMLAudioElement|null} */ let audio = null;

  async function load() {
    try {
      const r = await fetch(`status/${id}.json`, { cache: 'no-store' });
      if (!r.ok) throw new Error();
      data = await r.json();
      render();
    } catch {
      $('name').textContent = 'Sender nicht verfügbar';
    }
    setTimeout(load, 15_000);
  }

  function render() {
    const src = data.icestats?.source?.[0];
    $('name').textContent = data.name;
    $('dot').classList.toggle('on', !!src);
    $('title').textContent = data.now?.title || (src ? src.title : 'Gerade offline');
    $('artist').textContent = data.now?.artist ?? '';
    /** @type {HTMLButtonElement} */ ($('play')).disabled = !src;
    if (data.links?.logo) $('cover').style.backgroundImage = `url(${data.links.logo.replace(/^\//, '')})`;
    const list = (data.last_songs ?? []).slice(data.now ? 1 : 0, (data.now ? 1 : 0) + hist);
    const ul = $('hist');
    ul.hidden = !list.length;
    ul.replaceChildren(...list.map((/** @type {any} */ x) => {
      const li = document.createElement('li');
      li.textContent = `${x.started_at ? new Date(x.started_at).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : ''}  ${x.artist ? `${x.artist} – ` : ''}${x.title}`;
      return li;
    }));
  }

  $('play').addEventListener('click', () => {
    const url = data?.icestats?.source?.[0]?.listenurl;
    if (!url) return;
    if (audio && !audio.paused) {
      audio.pause();
      audio.removeAttribute('src');
      audio = null;
      $('play').textContent = '▶';
      return;
    }
    audio = new Audio(url);
    audio.play().then(() => ($('play').textContent = '⏸')).catch(() => ($('play').textContent = '▶'));
  });

  setInterval(() => {
    const n = data?.now;
    if (!n?.started_at || !n?.ends_at) return;
    const a = Date.parse(n.started_at);
    const b = Date.parse(n.ends_at);
    $('pg').style.width = `${Math.max(0, Math.min(100, ((Date.now() - a) / (b - a)) * 100))}%`;
  }, 1000);

  if (id) load();
  else $('name').textContent = 'Kein Sender angegeben (?station= oder ?lautfm=)';
})();
