// @ts-check
// Vorlagen für laut.fm-Automations-Algorithmen (übernommen aus dem AnMaCha-Radioadmin, automation.html).
// Der laut.fm-Server führt den Funktionskörper beim Mischen einer Playlist aus: function(tracks) → tracks.

export const ALGO_TEMPLATES = [
  {
    name: 'zufall_gewichtet',
    icon: '🎲',
    label: 'Gewichteter Zufall',
    color: 'rgba(255,206,0,.12)',
    border: 'rgba(255,206,0,.25)',
    desc: 'Kürzlich gespielte Tracks werden seltener gewählt. Sorgt dafür dass Songs nicht direkt doppelt kommen.',
    body: `(function(tracks) {
  // Gewichteter Zufall: Tracks nach letztem Spielzeitpunkt gewichten
  // Tags "recent" bekommen weniger Gewicht
  var weighted = tracks.map(function(t) {
    var w = 1.0;
    if (t.tags && t.tags.indexOf('recent') >= 0) w = 0.2;
    return { track: t, weight: w };
  });
  // Fisher-Yates mit Gewichtung
  for (var i = weighted.length - 1; i > 0; i--) {
    var totalW = 0;
    for (var k = 0; k <= i; k++) totalW += weighted[k].weight;
    var rand = Math.random() * totalW;
    var cum = 0, j = 0;
    for (j = 0; j <= i; j++) { cum += weighted[j].weight; if (rand <= cum) break; }
    j = Math.min(j, i);
    var tmp = weighted[i]; weighted[i] = weighted[j]; weighted[j] = tmp;
  }
  return weighted.map(function(w) { return w.track; });
})`
  },
  {
    name: 'tageszeit_mix',
    icon: '🌅',
    label: 'Tageszeit-Mix',
    color: 'rgba(0,180,245,.1)',
    border: 'rgba(0,180,245,.25)',
    desc: 'Morgens ruhigere Tracks, abends energetischere. Sortiert nach Genre-Keywords die zur Uhrzeit passen.',
    body: `(function(tracks) {
  var hour = new Date().getHours();
  var isMorning  = hour >= 6  && hour < 11;  // 06–11: ruhig
  var isDay      = hour >= 11 && hour < 17;  // 11–17: gemischt
  var isEvening  = hour >= 17 && hour < 22;  // 17–22: energetisch
  var isNight    = hour >= 22 || hour < 6;   // 22–06: entspannt/chill

  var calmTags    = ['slow','ballad','chill','acoustic','soft','piano'];
  var energyTags  = ['dance','upbeat','pop','hit','club','party','bass'];
  var relaxTags   = ['easy','lounge','jazz','ambient'];

  function score(t) {
    var g = (t.genre || '').toLowerCase();
    var tags = (t.tags || []).join(' ').toLowerCase();
    var combined = g + ' ' + tags;
    var s = 5; // Basis-Score
    if (isMorning) {
      if (calmTags.some(function(c){return combined.indexOf(c)>=0;})) s += 10;
      if (energyTags.some(function(e){return combined.indexOf(e)>=0;})) s -= 3;
    } else if (isEvening) {
      if (energyTags.some(function(e){return combined.indexOf(e)>=0;})) s += 10;
    } else if (isNight) {
      if (relaxTags.some(function(r){return combined.indexOf(r)>=0;})) s += 8;
      if (calmTags.some(function(c){return combined.indexOf(c)>=0;})) s += 5;
    }
    return s + Math.random() * 2; // leichte Zufallskomponente
  }
  return tracks.slice().sort(function(a, b) { return score(b) - score(a); });
})`
  },
  {
    name: 'artist_trenner',
    icon: '🎤',
    label: 'Artist-Trenner',
    color: 'rgba(0,230,118,.1)',
    border: 'rgba(0,230,118,.25)',
    desc: 'Stellt sicher dass derselbe Artist nie zweimal direkt hintereinander läuft. Ideal für Playlisten mit vielen Titeln eines Künstlers.',
    body: `(function(tracks) {
  if (tracks.length <= 1) return tracks;
  var shuffled = tracks.slice().sort(function() { return Math.random() - 0.5; });
  var result = [], used = new Set();
  // Mehrere Durchläufe bis kein Artist doppelt
  var maxIter = shuffled.length * 3;
  var i = 0;
  while (shuffled.length > 0 && i++ < maxIter) {
    var last = result.length > 0 ? result[result.length-1].artist : null;
    var found = false;
    for (var j = 0; j < shuffled.length; j++) {
      if (shuffled[j].artist !== last || shuffled.length === 1) {
        result.push(shuffled.splice(j, 1)[0]);
        found = true;
        break;
      }
    }
    if (!found) { result.push(shuffled.shift()); } // kein anderer Artist → trotzdem einfügen
  }
  return result.concat(shuffled);
})`
  },
  {
    name: 'jahrzehnte_flow',
    icon: '📅',
    label: 'Jahrzehnte-Flow',
    color: 'rgba(179,136,255,.1)',
    border: 'rgba(179,136,255,.25)',
    desc: 'Mischt Tracks aus verschiedenen Jahrzehnten gleichmäßig durch. Keine 5 Songs aus den 80ern am Stück.',
    body: `(function(tracks) {
  // Gruppiere nach Jahrzehnt
  var byDecade = {};
  tracks.forEach(function(t) {
    var yr = t.release_year || 0;
    var decade = yr > 0 ? Math.floor(yr / 10) * 10 : 9999;
    if (!byDecade[decade]) byDecade[decade] = [];
    byDecade[decade].push(t);
  });
  // Shuffle innerhalb jedes Jahrzehnts
  Object.keys(byDecade).forEach(function(d) {
    byDecade[d].sort(function() { return Math.random() - 0.5; });
  });
  // Round-Robin: abwechselnd aus jedem Jahrzehnt
  var decades = Object.keys(byDecade).sort(function(a,b){return b-a;}); // neueste zuerst
  var result = [], idx = {};
  decades.forEach(function(d) { idx[d] = 0; });
  var total = tracks.length, added = 0;
  while (added < total) {
    var anyAdded = false;
    decades.forEach(function(d) {
      if (idx[d] < byDecade[d].length) {
        result.push(byDecade[d][idx[d]++]);
        added++;
        anyAdded = true;
      }
    });
    if (!anyAdded) break;
  }
  return result;
})`
  },
  {
    name: 'smarter_zufall',
    icon: '🧠',
    label: 'Smarter Zufall',
    color: 'rgba(255,140,0,.1)',
    border: 'rgba(255,140,0,.25)',
    desc: 'Echter Zufall fühlt sich oft "unzufällig" an. Dieser Algorithmus verhindert Cluster (3× gleicher Artist, 3× gleiches Jahrzehnt hintereinander).',
    body: `(function(tracks) {
  var pool = tracks.slice().sort(function() { return Math.random() - 0.5; });
  var result = [];

  function lastN(arr, n, fn) {
    return arr.slice(-n).map(fn);
  }

  while (pool.length > 0) {
    // Suche einen Track der nicht Cluster bildet
    var chosen = null;
    for (var attempt = 0; attempt < Math.min(pool.length, 8); attempt++) {
      var candidate = pool[attempt];
      var recentArtists  = lastN(result, 2, function(t){return t.artist;});
      var recentDecades  = lastN(result, 2, function(t){return t.release_year ? Math.floor(t.release_year/10)*10 : 0;});
      var candidateDecade = candidate.release_year ? Math.floor(candidate.release_year/10)*10 : 0;

      // Akzeptiere wenn Artist nicht doppelt und Jahrzehnt nicht 3× hintereinander
      var artistOk = recentArtists.indexOf(candidate.artist) < 0 || pool.length <= 2;
      var decadeCount = recentDecades.filter(function(d){return d===candidateDecade;}).length;
      var decadeOk = decadeCount < 2 || pool.length <= 3;

      if (artistOk && decadeOk) { chosen = attempt; break; }
    }
    if (chosen === null) chosen = 0; // Fallback
    result.push(pool.splice(chosen, 1)[0]);
  }
  return result;
})`
  },
  {
    name: 'nach_dauer',
    icon: '⏱️',
    label: 'Kurze Tracks zuerst',
    color: 'rgba(0,180,245,.08)',
    border: 'rgba(0,180,245,.2)',
    desc: 'Sortiert nach Tracklänge — kürzere Songs zuerst. Gut für Aufwärm-Playlisten oder morgens.',
    body: `(function(tracks) {
  return tracks.slice().sort(function(a, b) {
    return (a.duration || 999) - (b.duration || 999);
  });
})`
  },
  {
    name: 'alpha_artist',
    icon: '🔤',
    label: 'Alphabetisch (Artist)',
    color: 'rgba(255,255,255,.04)',
    border: 'rgba(255,255,255,.1)',
    desc: 'Sortiert strikt alphabetisch nach Artist-Namen. Ideal für DJ-Vorbereitungs-Playlisten.',
    body: `(function(tracks) {
  return tracks.slice().sort(function(a, b) {
    return (a.artist || '').localeCompare(b.artist || '', 'de', {sensitivity:'base'});
  });
})`
  },
  {
    name: 'neueste_zuerst',
    icon: '🆕',
    label: 'Neueste zuerst',
    color: 'rgba(255,206,0,.08)',
    border: 'rgba(255,206,0,.15)',
    desc: 'Neuere Veröffentlichungen kommen zuerst. Tracks ohne Jahreszahl landen am Ende.',
    body: `(function(tracks) {
  return tracks.slice().sort(function(a, b) {
    return (b.release_year || 0) - (a.release_year || 0);
  });
})`
  },
  {
    name: 'song_jingle_pattern',
    icon: '🎵',
    label: 'Song-Song-Song-Jingle Muster',
    color: 'rgba(179,136,255,.1)',
    border: 'rgba(179,136,255,.25)',
    desc: 'Spielt 3 Songs hintereinander, dann einen Jingle. Nutzt den laut.fm Track-Typ (song/jingle). Perfekt für strukturiertes Programm.',
    body: `(function(tracks) {
  // Trennt Songs (type="song") und Jingles (type="jingle")
  var songs   = tracks.filter(function(t) { return !t.type || t.type === 'song'; });
  var jingles = tracks.filter(function(t) { return t.type === 'jingle'; });

  // Shuffle both lists
  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = a[i]; a[i] = a[j]; a[j] = tmp;
    }
    return a;
  }
  songs   = shuffle(songs);
  jingles = shuffle(jingles);

  if (!jingles.length) return songs; // Kein Jingle? Nur Songs

  // Build pattern: song, song, song, jingle
  var result = [];
  var si = 0, ji = 0;
  while (si < songs.length) {
    // 3 songs
    for (var k = 0; k < 3 && si < songs.length; k++, si++) {
      result.push(songs[si]);
    }
    // 1 jingle (loop if needed)
    if (jingles.length) {
      result.push(jingles[ji % jingles.length]);
      ji++;
    }
  }
  return result;
})`
  },
  {
    name: 'typ_mix_ausgewogen',
    icon: '🎚️',
    label: 'Song/Jingle ausgewogen',
    color: 'rgba(0,230,118,.08)',
    border: 'rgba(0,230,118,.2)',
    desc: 'Mischt Songs und Jingles gleichmäßig nach Track-Typ. Jingles werden gleichmäßig verteilt.',
    body: `(function(tracks) {
  var songs   = tracks.filter(function(t) { return !t.type || t.type === 'song'; });
  var jingles = tracks.filter(function(t) { return t.type === 'jingle'; });
  function shuffle(a) { return a.slice().sort(function() { return Math.random()-.5; }); }
  songs = shuffle(songs); jingles = shuffle(jingles);
  if (!jingles.length) return songs;
  var result = [], ji = 0;
  var interval = Math.max(2, Math.floor(songs.length / (jingles.length || 1)));
  songs.forEach(function(s, i) {
    result.push(s);
    if ((i + 1) % interval === 0 && ji < jingles.length) {
      result.push(jingles[ji++]);
    }
  });
  // Restliche Jingles anhängen
  while (ji < jingles.length) result.push(jingles[ji++]);
  return result;
})`
  },
  {
    name: 'radio_rotation_abc',
    icon: '📻',
    label: 'Profi A/B/C Rotation',
    color: 'rgba(255,100,0,.12)',
    border: 'rgba(255,100,0,.3)',
    desc: 'Klassisches Profi-Radioprinzip: Hit-Songs (A) kommen dreimal öfter als seltene Tracks (C). Genauso läuft echtes Radio – du hörst Hits öfter, ohne dass andere Songs verschwinden.',
    body: `(function(tracks) {
  function cls(t){var p=t.popularity||0;if(p>70||(t.tags||[]).some(function(x){return x==='hit'||x==='current';}))return 0;if(p>35)return 1;return 2;}
  var a=tracks.filter(function(t){return cls(t)===0;});
  var b=tracks.filter(function(t){return cls(t)===1;});
  var cc=tracks.filter(function(t){return cls(t)===2;});
  function sh(x){return x.slice().sort(function(){return Math.random()-.5;});}
  a=sh(a);b=sh(b);cc=sh(cc);
  var res=[],ai=0,bi=0,ci=0,pat=['A','B','A','C','A','B'];
  for(var i=0;i<Math.ceil(tracks.length/pat.length);i++){
    pat.forEach(function(t){
      if(t==='A'&&ai<a.length)res.push(a[ai++]);
      else if(t==='B'&&bi<b.length)res.push(b[bi++]);
      else if(t==='C'&&ci<cc.length)res.push(cc[ci++]);
      else if(ai<a.length)res.push(a[ai++]);
      else if(bi<b.length)res.push(b[bi++]);
      else if(ci<cc.length)res.push(cc[ci++]);
    });
  }
  return res;
})`
  },
  {
    name: 'genre_block',
    icon: '🎸',
    label: 'Genre-Blöcke',
    color: 'rgba(0,180,245,.1)',
    border: 'rgba(0,180,245,.25)',
    desc: 'Spielt je 3 Songs desselben Genres hintereinander, dann wechselt das Genre. Klingt wie echtes Formatradio – keine wilden Stilsprünge mehr, trotzdem Abwechslung.',
    body: `(function(tracks) {
  var byG={};
  tracks.forEach(function(t){var g=(t.genre||'Mix').split('/')[0].trim()||'Mix';if(!byG[g])byG[g]=[];byG[g].push(t);});
  Object.keys(byG).forEach(function(g){byG[g]=byG[g].slice().sort(function(){return Math.random()-.5;});});
  var res=[],ptrs={};Object.keys(byG).forEach(function(g){ptrs[g]=0;});
  var genres=Object.keys(byG),go=true;
  while(go){go=false;genres.forEach(function(g){for(var k=0;k<3;k++){if(ptrs[g]<byG[g].length){res.push(byG[g][ptrs[g]++]);go=true;}}});}
  return res;
})`
  },
  {
    name: 'energy_curve',
    icon: '⚡',
    label: 'Energy-Kurve (Tageszeit)',
    color: 'rgba(255,200,0,.1)',
    border: 'rgba(255,200,0,.25)',
    desc: 'Die Musik passt sich automatisch der Uhrzeit an: Morgens ruhiger, Mittag aufgedreht, Abend maximale Party, Nacht entspannt. Exakt wie ein Programmdirektor es planen würde.',
    body: `(function(tracks) {
  var h=new Date().getHours();
  var tg=h>=6&&h<9?55:h>=9&&h<12?70:h>=12&&h<14?65:h>=14&&h<17?60:h>=17&&h<20?75:h>=20&&h<24?82:38;
  function sc(t){var g=(t.genre||'').toLowerCase(),tags=(t.tags||[]).join(' ').toLowerCase(),s=50;
    if(/dance|club|house|techno|edm/.test(g+tags))s+=28;
    if(/ballad|slow|chill|acoustic/.test(g+tags))s-=25;
    if(/pop|hit|chart/.test(g+tags))s+=8;
    return Math.max(0,Math.min(100,s+Math.random()*8-4));}
  return tracks.slice().sort(function(a,b){var da=Math.abs(sc(a)-tg),db=Math.abs(sc(b)-tg);return Math.abs(da-db)<8?Math.random()-.5:da-db;});
})`
  },
  {
    name: 'kein_repeat',
    icon: '🔁',
    label: 'Kein Künstler-Repeat',
    color: 'rgba(255,64,64,.08)',
    border: 'rgba(255,64,64,.2)',
    desc: 'Kein Künstler kommt zweimal hintereinander. Außerdem wird ein 30%-Schutzfenster eingehalten damit Songs nicht zu früh wiederholt werden – Pflicht-Standard für professionelles Webradio.',
    body: `(function(tracks) {
  if(tracks.length<=1)return tracks;
  var sh=tracks.slice().sort(function(){return Math.random()-.5;});
  var res=[],rA=[],rT=[],win=Math.max(4,Math.floor(sh.length*0.3));
  function ok(t){return rA.indexOf((t.artist||'').toLowerCase())<0&&rT.indexOf((t.title||'').toLowerCase())<0;}
  var rem=sh.slice();
  while(rem.length){var i=rem.findIndex(ok);if(i<0)i=0;var t=rem.splice(i,1)[0];res.push(t);
    rA.push((t.artist||'').toLowerCase());rT.push((t.title||'').toLowerCase());
    if(rA.length>win)rA.shift();if(rT.length>win)rT.shift();}
  return res;
})`
  },
  {
    name: 'clock_format',
    icon: '🕐',
    label: 'Stunden-Uhr Format',
    color: 'rgba(0,230,118,.08)',
    border: 'rgba(0,230,118,.2)',
    desc: 'Echte Sender planen nach dem Clock Format: Jingle zur vollen Stunde, dann Hits, dann normale Songs. Jede Stunde klingt ähnlich strukturiert – professionelle Textur ohne Aufwand.',
    body: `(function(tracks) {
  var songs=tracks.filter(function(t){return !t.type||t.type==='song';});
  var jingles=tracks.filter(function(t){return t.type==='jingle';});
  var hits=songs.filter(function(t){return(t.popularity||0)>60||(t.tags||[]).indexOf('hit')>=0;});
  var fill=songs.filter(function(t){return hits.indexOf(t)<0;});
  function sh(a){return a.slice().sort(function(){return Math.random()-.5;});}
  hits=sh(hits);fill=sh(fill);jingles=sh(jingles);
  var res=[],hi=0,fi=0,ji=0,pat=['jingle','hit','fill','fill','hit','jingle','fill','hit','fill','hit'];
  for(var r=0;r<Math.ceil(tracks.length/pat.length);r++){
    pat.forEach(function(type){
      if(type==='jingle'&&ji<jingles.length)res.push(jingles[ji++]);
      else if(type==='hit'&&hi<hits.length)res.push(hits[hi++]);
      else if(fi<fill.length)res.push(fill[fi++]);
      else if(hi<hits.length)res.push(hits[hi++]);
    });
  }
  return res.slice(0,tracks.length);
})`
  },
  {
    name: 'tempo_rampe',
    icon: '🏎️',
    label: 'Tempo-Rampe',
    color: 'rgba(179,136,255,.1)',
    border: 'rgba(179,136,255,.25)',
    desc: 'Baut das Tempo kontinuierlich auf: von ruhig nach energiegeladen. Perfekt für Abendshows und Events wo die Stimmung im Verlauf steigen soll.',
    body: `(function(tracks) {
  function tempo(t){var g=(t.genre||'').toLowerCase(),tags=(t.tags||[]).join(' ').toLowerCase(),s=50;
    if(/slow|ballad|acoustic|chill/.test(g+tags))s-=22;
    if(/dance|techno|house|edm|club/.test(g+tags))s+=28;
    if(/pop|rock|punk/.test(g+tags))s+=10;
    return s+(Math.random()*6-3);}
  var sc=tracks.map(function(t){return{t:t,s:tempo(t)};}).sort(function(a,b){return a.s-b.s;});
  var third=Math.floor(sc.length/3);
  return sc.slice(0,third).concat(sc.slice(third,third*2),sc.slice(third*2)).map(function(x){return x.t;});
})`
  }
];
