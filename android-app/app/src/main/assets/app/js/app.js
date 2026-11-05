/* Atl Player — generic IPTV player for LG webOS
 * Sources: Xtream Codes login or any M3U URL. Everything runs on the TV; no server needed.
 */
(function () {
'use strict';

/* ================= storage ================= */
function load(k, d) { try { var v = localStorage.getItem('atl.' + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
function save(k, v) { try { localStorage.setItem('atl.' + k, JSON.stringify(v)); } catch (e) {} }
var saveT = {};
function saveSoon(k) { clearTimeout(saveT[k]); saveT[k] = setTimeout(function () { save(k, S[k]); }, 2000); }

var DEFAULT_CFG = { type: 'xtream', server: '', user: '', pass: '', m3u: '', liveFormat: 'm3u8', quality: 'fhd265',
  tmdbKey: '', omdbKey: '', osKey: '', prefAudio: 'en', prefSub: 'pt-br', subSize: 48, adultLock: true, pin: '0000', remMin: 10, rateSrc: 'auto', wyzieKey: '' };
var S = {
  cfg: Object.assign({}, DEFAULT_CFG, load('cfg', {})),
  live: [], liveCats: [], movies: [], movieCats: [], series: [], seriesCats: [],
  byKey: {}, favs: load('favs', []), later: load('later', []), pos: load('pos', {}), hist: load('hist', []), intro: load('intro', {}),
  ratings: load('ratings', {}), subs: load('subs', { files: {}, last: {} }), stills: {}, sort: load('sort', 'year'), exp: '', fresh: false,
  brs: load('brs', {}), trk: load('trk', {}), hideBr: load('hideBr', false), rem: load('rem', []), teams: load('teams', []),
  view: null, cat: {}, spot: {}, loaded: false
};
// notes saved before the vote rule carry the unreliable scores: they are fetched again as titles appear
if (load('ratingsV', 0) < 2) { S.ratings = {}; save('ratings', {}); save('ratingsV', 2); }
// notes saved while the OMDb daily limit was hit came back without IMDb and were never asked again
if (load('ratingsV', 0) < 3) { Object.keys(S.ratings).forEach(function (k) { var r = S.ratings[k]; if (r && r.om && !r.imdb) delete r.om; }); save('ratings', S.ratings); save('ratingsV', 3); }
/* the notes live in IndexedDB: localStorage holds ~5 MB shared with everything else, and a full one
 * silently stopped saving them, so every visit looked them all up again */
var notesDb = null, notesWait = [], notesLoaded = false, notesDone, notesReady = new Promise(function (r) { notesDone = r; });
function notesIn() {
  if (notesLoaded) return; notesLoaded = true; notesDone();
  // posters drawn before the notes arrived get theirs now; "Mais Bem Avaliados" is put in order again
  $$('.poster').forEach(function (card) { var it = S.byKey[card.getAttribute('data-key')], c = it && cachedRating(it); if (c) showRate(card, it, c); });
  fillHero();
  var v = S.view, f = document.activeElement;
  if ((v === 'movies' || v === 'series') && S.sort === 'stars' && !S.q && $('#gridWrap') && !(f && f.closest && f.closest('#gridWrap') && +f.getAttribute('data-idx') > 5)) {
    var inGrid = f && f.closest && f.closest('#gridWrap'); showCat(v, S.cat[v] || '__all');
    if (inGrid) { var first = $('#gridWrap .poster'); if (first) focusEl(first); }
  }
}
function withNotesDb(fn) {
  if (notesDb) { fn(notesDb); return; }
  notesWait.push(fn); if (notesWait.length > 1) return;
  var req; try { req = indexedDB.open('atl-notas', 1); } catch (e) { notesWait = []; setTimeout(notesIn, 0); return; }
  req.onupgradeneeded = function () { req.result.createObjectStore('kv'); };
  req.onsuccess = function () { notesDb = req.result; var w = notesWait; notesWait = []; w.forEach(function (f) { f(notesDb); }); };
  req.onerror = function () { notesWait = []; notesIn(); };
}
function saveNotes() {
  withNotesDb(function (db) {
    try { db.transaction('kv', 'readwrite').objectStore('kv').put(S.ratings, 'ratings'); } catch (e) {}
  });
}
withNotesDb(function (db) {
  var r; try { r = db.transaction('kv', 'readonly').objectStore('kv').get('ratings'); } catch (e) { notesIn(); return; }
  r.onerror = notesIn;
  r.onsuccess = function () {
    var kept = r.result || {}, moved = Object.keys(S.ratings).length;
    Object.keys(kept).forEach(function (k) { if (!S.ratings[k]) S.ratings[k] = kept[k]; });
    if (moved) saveNotes(); // the copy that was in localStorage now lives here
    try { localStorage.removeItem('atl.ratings'); } catch (e) {}
    notesIn();
  };
});
// English became the preferred audio after this setting was already saved on the TVs
if (load('audioV', 0) < 1) { S.cfg.prefAudio = 'en'; save('cfg', S.cfg); save('audioV', 1); }
// js/local-config.js é opcional e nunca vai para o repositório nem para o GitHub Pages (a workflow o remove): se existir
// no aparelho, preenche as chaves que ainda faltam; daí em diante cada TV mantém as suas nos Ajustes
var seeded = false;
['tmdbKey', 'osKey', 'omdbKey', 'wyzieKey'].forEach(function (k) { if (window.ATL_LOCAL && window.ATL_LOCAL[k] && !S.cfg[k]) { S.cfg[k] = window.ATL_LOCAL[k]; seeded = true; } });
if (seeded) save('cfg', S.cfg);
// a copy of the last list that loaded, so a list that worked can't be lost
var LIST_KEYS = ['type', 'server', 'user', 'pass', 'm3u', 'liveFormat'];
if (!S.cfg.server && !S.cfg.m3u) Object.assign(S.cfg, load('list', {}));
function keepList() { var o = {}; LIST_KEYS.forEach(function (k) { o[k] = S.cfg[k]; }); save('list', o); }
/* the saved lists, each with the name the user gave it; S.cfg always holds a copy of the active one */
var ENTRY_KEYS = ['type', 'server', 'user', 'pass', 'm3u'];
S.lists = load('lists', null); S.listOn = load('listOn', null); S.draft = null; S.setSec = 'lists';
if (!S.lists) {
  S.lists = [];
  if (S.cfg.server || S.cfg.m3u) { var first = { id: 'l1', name: 'Minha Lista' }; ENTRY_KEYS.forEach(function (k) { first[k] = S.cfg[k]; }); S.lists.push(first); S.listOn = first.id; save('lists', S.lists); save('listOn', S.listOn); }
}

/* ================= helpers ================= */
var $ = function (s, r) { return (r || document).querySelector(s); };
var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function norm(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim(); }
function fmtTime(t) { if (!isFinite(t) || t < 0) return ''; t = Math.floor(t); var h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = t % 60;
  return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (s < 10 ? '0' : '') + s; }
function fmtLeft(s) { var m = Math.max(1, Math.round(s / 60)); return 'Faltam ' + (m < 60 ? m + ' min' : Math.floor(m / 60) + 'h ' + ('0' + m % 60).slice(-2) + 'min'); }
var toastT;
function toast(msg, ms) { var t = $('#toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(toastT); toastT = setTimeout(function () { t.classList.add('hidden'); }, ms || 2600); }
function status(msg) { $('#status').textContent = msg || ''; if (msg) $('#busyMsg').textContent = msg; }
function busyOn() { return !$('#busy').classList.contains('hidden'); }
function setBusy(msg) { $('#busy').classList.toggle('hidden', !msg); if (msg) $('#busyMsg').textContent = msg; }
function setText(sel, txt) { var e = $(sel); if (e) e.textContent = txt; }
function b64(s) { try { return decodeURIComponent(escape(atob(s))); } catch (e) { return s || ''; } }
function timeoutFetch(url, opts, ms) {
  return new Promise(function (res, rej) {
    var done = false, t = setTimeout(function () { if (!done) { done = true; rej(new Error('Tempo esgotado')); } }, ms || 30000);
    fetch(url, opts).then(function (r) { if (!done) { done = true; clearTimeout(t); res(r); } }, function (e) { if (!done) { done = true; clearTimeout(t); rej(e); } });
  });
}
// providers answer 5xx now and then, mostly at startup: the list API gets a few more tries before showing an error
function getJSON(url, opts, tries) {
  var api = /player_api\.php/.test(url), left = tries == null ? (api ? 3 : 0) : tries;
  return timeoutFetch(url, opts || (S.fresh ? { cache: 'reload' } : undefined), api ? 120000 : 40000).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).catch(function (e) {
    if (!left || /HTTP 4|esgotado/.test(e.message)) throw e;
    if (!S.loaded) status('Servidor Ocupado, Tentando de Novo');
    return new Promise(function (res) { setTimeout(res, 2000 * (4 - left)); }).then(function () { return getJSON(url, opts, left - 1); });
  });
}
function yearOf(name) { return (String(name).match(/[\(\[\s-]((?:19|20)\d{2})[\)\]]?/) || [])[1] || ''; }
function playerShown() { return !$('#player').classList.contains('hidden'); }
function miniOn() { return $('#player').classList.contains('mini'); }
// the preview pane plays inside the channel screen; only full screen counts as the player being open
function playerOpen() { return playerShown() && !miniOn(); }

/* images: only load what is on screen, in a reduced size */
function thumb(url, w) { return String(url || '').replace(/(image\.tmdb\.org\/t\/p\/)[^\/]+/, '$1w' + w); }
function imgTag(url, key, w) { return '<img class="lz" alt="" decoding="async"' + (url ? ' data-src="' + esc(thumb(url, w)) + '"' : '') + (key ? ' data-fill="' + esc(key) + '"' : '') + '>'; }
var lazyIO = window.IntersectionObserver ? new IntersectionObserver(function (es) {
  es.forEach(function (e) { if (e.isIntersecting) { lazyIO.unobserve(e.target); reveal(e.target); } });
}, { rootMargin: '300px' }) : null;
function reveal(el) {
  var src = el.getAttribute('data-src');
  if (src) el.src = src; else fillArt(el);
  // the note and the country only come with the TMDB lookup: every poster on screen asks once, not only the focused one
  if (src) { var it = S.byKey[el.getAttribute('data-fill')]; if (it && (S.hideBr || !rateDone(it))) fillArt(el); }
}
function observeImgs(root) { $$('img.lz:not([data-seen])', root).forEach(function (el) { el.setAttribute('data-seen', '1'); if (lazyIO) lazyIO.observe(el); else reveal(el); }); }
function paint(el, html) { el.innerHTML = html; observeImgs(el); }
// TMDB covers what the list lacks; two at a time so scrolling stays smooth
var artQueue = [], artBusy = 0;
function fillArt(el) { if (el.getAttribute('data-fill') && S.cfg.tmdbKey) { artQueue.push(el); if (artQueue.length > 60) artQueue.shift(); pumpArt(); } }
function pumpArt() {
  while (artBusy < 2 && artQueue.length && !playerOpen()) {
    (function (el) {
      var it = S.byKey[el.getAttribute('data-fill')];
      if (!it || !document.body.contains(el)) return;
      artBusy++;
      getRatings(it).then(function (r) {
        artBusy--;
        if (r && r.poster && !el.getAttribute('data-src')) el.src = thumb(r.poster, 185);
        var card = el.closest('.poster');
        if (card && r) { showRate(card, it, r); if (S.hideBr && isBr(it) && card !== document.activeElement) card.style.display = 'none'; }
        pumpArt();
      }, function () { artBusy--; pumpArt(); });
    })(artQueue.pop());
  }
}
document.addEventListener('error', function (e) {
  var t = e.target, src = t && t.getAttribute && t.getAttribute('data-src'); if (!t || t.tagName !== 'IMG') return;
  if (t.getAttribute('data-fill') && S.cfg.tmdbKey && !t._art) { t._art = 1; t.removeAttribute('data-src'); fillArt(t); return; }
  var alts = (t.getAttribute('data-alts') || '').split('|').filter(Boolean);
  if (alts.length) { t.setAttribute('data-alts', alts.slice(1).join('|')); t.setAttribute('data-src', alts[0]); reveal(t); return; }
  // nothing left to try: drop the image so the browser's broken-picture box never shows
  t.style.display = 'none'; if (t.parentNode) t.parentNode.classList.add('noimg');
}, true);

/* title cleanup for rating / subtitle lookup */
function cleanTitle(name) {
  var year = (String(name).match(/[\(\[\s-](19\d{2}|20\d{2})[\)\]]?/) || [])[1] || '';
  var t = String(name)
    .replace(/^\s*(\[[^\]]*\]|\|[^|]*\||[A-Z]{2,3}\s*[:|-])\s*/g, '')
    .replace(/\((19|20)\d{2}\)|\[(19|20)\d{2}\]/g, '')
    .replace(/\b(4k|uhd|fhd|hd|sd|h265|hevc|1080p|720p|dublado|legendado|dub|leg|nacional|\[l\]|\(l\))\b/ig, '')
    .replace(/[\[\(][^\]\)]*[\]\)]/g, '').replace(/\s*[-|:]\s*$/, '').replace(/\s+/g, ' ').trim();
  var bare = t.replace(/^[^A-Za-z0-9\u00C0-\u024F]+/, ''); // lists mark titles with "+ " or "- " in front: the search would not find them
  return { title: bare || t || name, year: year, old: t || name };
}

/* ================= channel quality ================= */
function isUhd(name) { return /(^|[^0-9])4k(?![a-z])|uhd/i.test(name); }
function quality(name) {
  var n = String(name).toLowerCase(), h265 = /h\.?\s?265|hevc/.test(n), uhd = isUhd(n), fhd = uhd || /\b(fhd|full ?hd|1080p?)\b/.test(n), hd = !fhd && /\b(hd|720p?)\b/.test(n), sd = /\b(sd|480p?)\b/.test(n);
  var score = fhd && h265 ? 5 : fhd ? 4 : h265 ? 3 : hd ? 2 : sd ? 1 : 2;
  var label = uhd ? '4K' : fhd ? 'FHD' : hd ? 'HD' : sd ? 'SD' : '';
  return { score: score, h265: h265, label: (label + (h265 ? ' H.265' : '')).trim() };
}
function channelBase(name) {
  return String(name).replace(/\b(4k|uhd|fhd|full ?hd|hd|sd|1080p?|720p?|480p?|h\.?\s?26[45]|hevc)\b/ig, ' ').replace(/[¹²³]/g, ' ')
    .replace(/[\[\(]\s*[\]\)]/g, ' ').replace(/\s+/g, ' ').replace(/^[\s|:-]+|[\s|:-]+$/g, '').trim() || name;
}
// one item per channel: the best version first, the others are the fallback
function groupChannels() {
  var mode = S.cfg.quality, idx = {}, order = [];
  S.live.forEach(function (it, i) {
    it.q = quality(it.name); it.ord = i; it.variants = [it];
    if (mode === 'all') return;
    // 4K channels stay as the list has them: never merged with other versions, never hidden by the H.265 rule
    if (isUhd(it.name)) { order.push(it); return; }
    var k = norm(channelBase(it.name));
    if (!idx[k]) { idx[k] = []; order.push(k); }
    idx[k].push(it);
  });
  if (mode === 'all') return;
  S.live = [];
  order.forEach(function (k) {
    if (typeof k !== 'string') { S.live.push(k); return; }
    var vs = idx[k].slice().sort(function (a, b) { return b.q.score - a.q.score || a.ord - b.ord; });
    if (mode === 'h265') vs = vs.filter(function (v) { return v.q.h265; });
    if (!vs.length) return;
    var m = register(Object.assign({}, vs[0], { name: channelBase(vs[0].name), variants: vs }));
    vs.forEach(function (v) { S.byKey['live:' + v.id] = m; });
    S.live.push(m);
  });
  var used = {}; S.live.forEach(function (it) { used[it.cat] = 1; });
  S.liveCats = S.liveCats.filter(function (c) { return used[String(c.category_id)]; });
}

/* a full M3U link from an Xtream panel already carries server, user and password */
function parseLink(txt) {
  var t = String(txt || '').trim(), m = t.match(/^(https?:\/\/[^\/\s]+)\/(?:get|player_api)\.php\?(.*)$/i);
  if (m) {
    var p = new URLSearchParams(m[2]), u = p.get('username'), w = p.get('password');
    if (u && w != null) return { type: 'xtream', server: m[1], user: u, pass: w };
  }
  return /^https?:\/\//i.test(t) ? { type: 'm3u', m3u: t } : null;
}

/* ================= data loading ================= */
function xurl(action, extra) {
  var c = S.cfg, base = c.server.replace(/\/+$/, '');
  return base + '/player_api.php?username=' + encodeURIComponent(c.user) + '&password=' + encodeURIComponent(c.pass) +
    (action ? '&action=' + action : '') + (extra || '');
}
function xbase() { return S.cfg.server.replace(/\/+$/, ''); }
// the TV's font lacks the math and arrow symbol blocks some lists use as decoration: they would show as crossed boxes
function catMap(list) { var m = {}; (list || []).forEach(function (c) { c.category_name = String(c.category_name).replace(/[\u2900-\u297F\u2A00-\u2AFF]/g, '·'); m[c.category_id] = c.category_name; }); return m; }
function register(item) { S.byKey[item.kind + ':' + item.id] = item; return item; }

function loadXtream() {
  status('Conectando');
  return getJSON(xurl('')).then(function (info) {
    if (!info || !info.user_info || String(info.user_info.auth) === '0') throw new Error('Usuário ou Senha Inválidos');
    S.exp = info.user_info.exp_date || '';
    status('Carregando Categorias');
    return getJSON(xurl('get_live_categories'));
  }).then(function (c) {
    S.liveCats = c || [];
    return getJSON(xurl('get_vod_categories'));
  }).then(function (c) {
    S.movieCats = c || [];
    return getJSON(xurl('get_series_categories'));
  }).then(function (c) {
    S.seriesCats = c || [];
    status('Carregando Canais');
    return getJSON(xurl('get_live_streams'));
  }).then(function (live) {
    var cm = catMap(S.liveCats), fmt = S.cfg.liveFormat;
    S.live = (live || []).map(function (s) { return register({ kind: 'live', id: s.stream_id, name: s.name, logo: s.stream_icon, cat: String(s.category_id), catName: cm[s.category_id] || '',
      epg: s.epg_channel_id, url: xbase() + '/live/' + S.cfg.user + '/' + S.cfg.pass + '/' + s.stream_id + '.' + fmt }); });
    status('Carregando Filmes');
    return getJSON(xurl('get_vod_streams'));
  }).then(function (vod) {
    var cm = catMap(S.movieCats);
    S.movies = (vod || []).map(function (s) { return register({ kind: 'movie', id: s.stream_id, name: s.name, logo: s.stream_icon, cat: String(s.category_id), catName: cm[s.category_id] || '',
      rating: parseFloat(s.rating) || 0, year: s.year || yearOf(s.name), ext: s.container_extension || 'mp4', added: +s.added || 0,
      url: xbase() + '/movie/' + S.cfg.user + '/' + S.cfg.pass + '/' + s.stream_id + '.' + (s.container_extension || 'mp4') }); });
    status('Carregando Séries');
    return getJSON(xurl('get_series'));
  }).then(function (ser) {
    var cm = catMap(S.seriesCats);
    S.series = (ser || []).map(function (s) { return register({ kind: 'series', id: s.series_id, name: s.name, logo: s.cover, cat: String(s.category_id), catName: cm[s.category_id] || '',
      rating: parseFloat(s.rating) || 0, year: (s.releaseDate || s.release_date || '').slice(0, 4) || yearOf(s.name), plot: s.plot, added: +s.last_modified || 0 }); });
  });
}

var ATTR_RE = {}; ['tvg-name', 'tvg-logo', 'group-title', 'tvg-id'].forEach(function (n) { ATTR_RE[n] = new RegExp(n + '="([^"]*)"', 'i'); });
function parseM3U(text) {
  var lines = text.split(/\r?\n/), cur = null, out = [];
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i].trim();
    if (l.indexOf('#EXTINF') === 0) {
      var attr = function (n) { var m = l.match(ATTR_RE[n]); return m ? m[1] : ''; };
      // the name starts at the first comma after the last quoted attribute; it may contain commas itself
      var name = l.substring(l.indexOf(',', l.lastIndexOf('"') + 1) + 1).trim();
      cur = { name: name || attr('tvg-name'), logo: attr('tvg-logo'), group: (attr('group-title') || 'Sem Categoria').replace(/[\u2900-\u297F\u2A00-\u2AFF]/g, '·'), epg: attr('tvg-id') };
    } else if (l && l[0] !== '#' && cur) { cur.url = l; out.push(cur); cur = null; }
  }
  return out;
}
function loadM3U() {
  status('Baixando Lista');
  return timeoutFetch(S.cfg.m3u, S.fresh ? { cache: 'reload' } : {}, 90000).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); }).then(function (txt) {
    if (txt.indexOf('#EXTM3U') < 0 && txt.indexOf('#EXTINF') < 0) throw new Error('O Link Não Parece Ser uma Lista M3U');
    status('Organizando');
    var items = parseM3U(txt), cats = { live: {}, movie: {}, series: {} }, n = 0;
    S.live = []; S.movies = []; S.series = [];
    var seriesIdx = {};
    items.forEach(function (it) {
      var g = norm(it.group), u = it.url.toLowerCase();
      var kind = /\/movie\//.test(u) || /filme|movie|vod|cinema/.test(g) ? 'movie' : (/\/series\//.test(u) || /serie|temporada|season|novela/.test(g) ? 'series' : 'live');
      if (kind === 'live' && /\.(mp4|mkv|avi)(\?|$)/.test(u)) kind = 'movie';
      var cid = kind + '|' + it.group; cats[kind][cid] = it.group;
      if (kind === 'series') {
        // group episodes "Name S01E02" into one series entry
        var m = it.name.match(/^(.*?)[\s._-]*[ST](\d{1,2})\s*E(\d{1,3})/i), sname = m ? m[1].trim() : it.name;
        var sk = cid + '|' + norm(sname), s = seriesIdx[sk];
        if (!s) { s = seriesIdx[sk] = register({ kind: 'series', id: 'm' + norm(cid + sname), name: sname, logo: it.logo, cat: cid, catName: it.group, year: yearOf(sname), added: n, episodes: [] }); S.series.push(s); }
        s.episodes.push({ id: 'e' + norm(it.url), title: it.name, season: m ? +m[2] : 1, num: m ? +m[3] : s.episodes.length + 1, url: it.url });
      } else {
        var item = register({ kind: kind, id: 'm' + norm(it.url), name: it.name, logo: it.logo, cat: cid, catName: it.group, epg: it.epg, url: it.url, year: yearOf(it.name), added: n });
        (kind === 'live' ? S.live : S.movies).push(item);
      }
      n++;
    });
    function toCats(o) { return Object.keys(o).map(function (k) { return { category_id: k, category_name: o[k] }; }); }
    S.liveCats = toCats(cats.live); S.movieCats = toCats(cats.movie); S.seriesCats = toCats(cats.series);
  });
}

/* adult groups are found by their name and never mix with the rest of the app */
var ADULT_RE = /(^|[^a-z])(adult(o|os|a|as)?|xxx|porn\w*|erotic\w*|hentai)([^a-z]|$)|\+18|18\+/;
function catIsAdult(name) { var n = norm(name); return ADULT_RE.test(n) && !/adult swim/.test(n); }
function markAdult() {
  var seen = {};
  function mark(it) { var c = it.catName || ''; if (seen[c] == null) seen[c] = catIsAdult(c); it.adult = seen[c]; }
  S.live.forEach(mark); S.movies.forEach(mark); S.series.forEach(mark);
  var nat = {};
  function markBr(it) { var c = it.catName || ''; if (nat[c] == null) nat[c] = catBr(c); it.br = nat[c] || /\bnacional\b/i.test(it.name); }
  S.movies.forEach(markBr); S.series.forEach(markBr);
  // whatever was watched before the rule existed leaves the history too
  var kept = S.hist.filter(function (h) { var i = S.byKey[h.key]; return !i || !i.adult; });
  if (kept.length !== S.hist.length) { S.hist = kept; save('hist', S.hist); }
  var gone = 0; S.movies.concat(S.series).forEach(function (i) { var k = i.kind + ':' + i.id; if (i.adult && S.pos[k]) { delete S.pos[k]; gone++; } });
  if (gone) save('pos', S.pos);
}
function noAdult(it) { return !it.adult; }
/* Brazilian titles: the group name answers at once; TMDB's origin_country is remembered per title as lookups come in */
function catBr(name) { return /\bnaciona(l|is)\b|brasileir|\bbrasil\b/.test(norm(name)); }
function isBr(it) { return it.br || S.brs[it.kind + ':' + it.id]; }
function noBr(it) { return !isBr(it); }
function groupAdult(view, cat) {
  var cats = view === 'movies' ? S.movieCats : view === 'series' ? S.seriesCats : S.liveCats;
  return cats.some(function (c) { return String(c.category_id) === cat && catIsAdult(c.category_name); });
}

/* the ids in favorites, history and marks only mean something inside one list:
 * each list keeps its own, so changing provider never opens the wrong title and coming back restores them */
var LIST_DATA = ['favs', 'later', 'pos', 'hist', 'intro', 'brs', 'trk'], EMPTY = { favs: [], later: [], pos: {}, hist: [], intro: {}, brs: {}, trk: {} };
function listId() { var c = S.cfg; return c.type === 'xtream' ? 'x:' + norm(c.server) + ':' + c.user : 'm:' + norm(c.m3u); }
function switchListData() {
  var id = listId(), was = load('listId', null);
  // ids used to be just the user: the list in use keeps its data under the new id
  if (was && was === 'x:' + S.cfg.user) { was = id; save('listId', id); }
  if (was && was !== id) {
    var old = {}; LIST_DATA.forEach(function (k) { old[k] = S[k]; });
    save('data.' + was, old);
    var next = load('data.' + id, load('data.x:' + S.cfg.user, {}));
    LIST_DATA.forEach(function (k) { S[k] = next[k] || JSON.parse(JSON.stringify(EMPTY[k])); save(k, S[k]); });
    S.cat = {}; S.spot = {};
  }
  save('listId', id);
}

function loadAll() {
  S.byKey = {};
  var c = S.cfg;
  if (c.type === 'xtream' && !(c.server && c.user)) return Promise.reject(new Error('Configure Sua Lista em Ajustes'));
  if (c.type === 'm3u' && !c.m3u) return Promise.reject(new Error('Configure Sua Lista em Ajustes'));
  return (c.type === 'xtream' ? loadXtream() : loadM3U()).then(function () {
    switchListData();
    S.loaded = true; S.loadError = '';
    keepList();
    groupChannels();
    markAdult();
    sortChannels();
    status(S.live.length + ' Canais · ' + S.movies.length + ' Filmes · ' + S.series.length + ' Séries');
  });
}

/* ================= ratings (TMDB + IMDb via OMDb) ================= */
/* Cache em memória das respostas do TMDB e do OMDb: a mesma URL nunca é pedida duas vezes na sessão, e pedidos
 * ainda em andamento são compartilhados. Falhas não ficam no cache, para poder tentar de novo mais tarde. */
var cacheApi = new Map(), CACHE_API_MAX = 600;
function getJSONCache(url, opts) {
  if (cacheApi.has(url)) return cacheApi.get(url);
  var p = getJSON(url, opts).catch(function (e) { cacheApi.delete(url); throw e; });
  cacheApi.set(url, p);
  if (cacheApi.size > CACHE_API_MAX) cacheApi.delete(cacheApi.keys().next().value); // descarta a mais antiga
  return p;
}
/* Chave recusada pela API (HTTP 401): guarda qual foi, para não repetir centenas de pedidos fadados a falhar.
 * Só volta a tentar quando o usuário salva outra chave nos Ajustes. */
var chaveRecusada = { tmdb: '', omdb: '' };
function notaRecusa(api, chave, e) {
  if (!/HTTP 401/.test(e.message) || chaveRecusada[api] === chave) return;
  chaveRecusada[api] = chave;
  console.log('Sintonia: a chave do ' + (api === 'tmdb' ? 'TMDB' : 'OMDb') + ' foi recusada (HTTP 401); confira em Ajustes > Chaves de API');
  toast('Chave do ' + (api === 'tmdb' ? 'TMDB' : 'OMDb') + ' Recusada. Confira em Ajustes.', 5000);
}
function tmdbFetch(path, params) {
  var k = S.cfg.tmdbKey.trim(), bearer = k.length > 50;
  if (chaveRecusada.tmdb === k) return Promise.reject(new Error('Chave do TMDB recusada'));
  var url = 'https://api.themoviedb.org/3' + path + '?language=pt-BR' + (bearer ? '' : '&api_key=' + encodeURIComponent(k)) + (params || '');
  return getJSONCache(url, bearer ? { headers: { Authorization: 'Bearer ' + k } } : {}).catch(function (e) { notaRecusa('tmdb', k, e); throw e; });
}
/* Nota do IMDb pelo OMDb. A resposta de "limite do dia" (HTTP 200) não pode ficar no cache. */
function omdbFetch(imdbId) {
  var k = S.cfg.omdbKey.trim(), url = 'https://www.omdbapi.com/?i=' + encodeURIComponent(imdbId) + '&apikey=' + encodeURIComponent(k);
  if (chaveRecusada.omdb === k) return Promise.reject(new Error('Chave do OMDb recusada'));
  return getJSONCache(url).then(function (o) {
    if (o && o.Response === 'False') cacheApi.delete(url);
    return o;
  }, function (e) { notaRecusa('omdb', k, e); throw e; });
}
var ratingPending = {}, MIN_VOTES = 50, omdbOff = 0;
// a saved note that needs no new lookup (same test getRatings makes before asking again)
function rateDone(it) { var had = cachedRating(it); return !!had && (had.om || !S.cfg.omdbKey || !had.tmdbId); }
function noteBr(item, r) { var k = item.kind + ':' + item.id; if (r && r.br && !S.brs[k]) { S.brs[k] = 1; saveSoon('brs'); } return r; }
// force: the viewer asked for something that needs the ids, even with the player open
function getRatings(item, force) {
  if (item.kind === 'live' || item.adult) return Promise.resolve(null);
  // the saved notes come from IndexedDB a moment after the app opens: asking the internet before that would repeat them all
  if (!notesLoaded) return notesReady.then(function () { return getRatings(item, force); });
  var ct = cleanTitle(item.name), year = item.year || ct.year, ck = rateKey(item), had = S.ratings[ck];
  // notes saved before the IMDb key existed get looked up again
  if (had && (had.om || !S.cfg.omdbKey || !had.tmdbId)) return Promise.resolve(noteBr(item, had));
  if (playerOpen() && !force) return Promise.resolve(had || null);
  if (ratingPending[ck]) return ratingPending[ck];
  if (!S.cfg.tmdbKey) return Promise.resolve(item.rating ? { list: item.rating } : null);
  var type = item.kind === 'movie' ? 'movie' : 'tv', out = { list: item.rating || 0 };
  var p = tmdbFetch('/search/' + type, '&query=' + encodeURIComponent(ct.title) + (year ? (type === 'movie' ? '&year=' : '&first_air_date_year=') + year : ''))
    .then(function (r) {
      var hit = r.results && r.results[0];
      if (!hit && year) return tmdbFetch('/search/' + type, '&query=' + encodeURIComponent(ct.title)).then(function (r2) { return r2.results && r2.results[0]; });
      return hit;
    }).then(function (hit) {
      if (!hit) return out;
      // a handful of votes easily gives a 10: below that the score says nothing
      if (hit.vote_count >= MIN_VOTES) out.tmdb = Math.round(hit.vote_average * 10) / 10;
      out.overview = hit.overview; out.tmdbId = hit.id;
      out.backdrop = hit.backdrop_path ? 'https://image.tmdb.org/t/p/w1280' + hit.backdrop_path : '';
      out.poster = hit.poster_path ? 'https://image.tmdb.org/t/p/w500' + hit.poster_path : '';
      out.year = (hit.release_date || hit.first_air_date || '').slice(0, 4);
      return tmdbFetch('/' + type + '/' + hit.id, '&append_to_response=external_ids').then(function (x) {
        var ids = x.external_ids || {}, from = x.origin_country || [], made = (x.production_countries || []).map(function (c) { return c.iso_3166_1; });
        out.br = (from.length ? from : made).indexOf('BR') >= 0;
        out.imdbId = ids.imdb_id;
        if (!ids.imdb_id || !S.cfg.omdbKey) return out;
        if (Date.now() < omdbOff) return out;
        return omdbFetch(ids.imdb_id).then(function (o) {
          // the free key answers 1000 a day: over that it says "Request limit reached!" and the title must be asked again later
          if (o && o.Response === 'False' && /limit|key/i.test(o.Error || '')) { omdbOff = Date.now() + 3 * 3600000; return out; }
          out.om = 1;
          if (o && o.imdbRating && o.imdbRating !== 'N/A') out.imdb = parseFloat(o.imdbRating);
          return out;
        }, function () { return out; });
      }, function () { return out; });
    }).then(function (o) {
      delete ratingPending[ck];
      S.ratings[ck] = o; var keys = Object.keys(S.ratings);
      if (keys.length > 20000) keys.slice(0, 2000).forEach(function (k) { delete S.ratings[k]; });
      notesChanged(); return noteBr(item, o);
    }, function () { delete ratingPending[ck]; return out; });
  ratingPending[ck] = p; return p;
}
/* the list's own score usually copies TMDB: it only counts until the lookup answers, and a 10 never does */
function listRate(r, item) { return r && r.tmdbId || +item.rating >= 9.5 ? 0 : +item.rating || 0; }
function rateValue(r, item) {
  var src = S.cfg.omdbKey ? S.cfg.rateSrc : S.cfg.rateSrc === 'imdb' ? 'auto' : S.cfg.rateSrc;
  return (r && (src === 'imdb' ? r.imdb : src === 'tmdb' ? r.tmdb : r.imdb || r.tmdb)) || listRate(r, item);
}
function bestRate(r, item) { var v = rateValue(r, item); return v ? '★ ' + v.toFixed(1) : ''; }
function showRate(card, it, r) { var b = $('.rate', card), t = bestRate(r, it); if (b && t) { b.textContent = t; b.style.display = ''; } else if (b) b.style.display = 'none'; }

/* ================= favorites / watch later ================= */
function isFav(key) { return S.favs.indexOf(key) >= 0; }
function isLater(key) { return S.later.indexOf(key) >= 0; }
function refreshMarks(key) { $$('[data-key="' + key + '"] .marks').forEach(function (e) { e.innerHTML = marks(key); }); }
function marks(key) { return (isFav(key) ? '<i class="mfav">★</i>' : '') + (isLater(key) ? '<i class="mlater">●</i>' : ''); }
function toggleFav(key) {
  if (!key || !S.byKey[key]) return;
  if (S.byKey[key].adult) { toast('Conteúdo Adulto Não Entra nas Listas'); return; }
  var i = S.favs.indexOf(key);
  if (i >= 0) { S.favs.splice(i, 1); toast('Removido dos Favoritos'); } else { S.favs.unshift(key); toast('★ Adicionado aos Favoritos'); }
  save('favs', S.favs); refreshMarks(key);
}
function toggleLater(key) {
  var it = S.byKey[key]; if (!it || it.kind === 'live') return;
  if (it.adult) { toast('Conteúdo Adulto Não Entra nas Listas'); return; }
  var i = S.later.indexOf(key);
  if (i >= 0) { S.later.splice(i, 1); toast('Removido de Assistir Depois'); } else { S.later.unshift(key); toast('Adicionado em Assistir Depois'); }
  save('later', S.later); refreshMarks(key);
}

/* ================= history (Início) ================= */
function histFor(key) { for (var i = 0; i < S.hist.length; i++) if (S.hist[i].key === key) return S.hist[i]; return null; }
function updateHist(item, ep, t, d) {
  var key = item.kind + ':' + item.id;
  S.hist = S.hist.filter(function (h) { return h.key !== key; });
  S.hist.unshift({ key: key, ep: ep ? { id: ep.id, season: ep.season, num: ep.num, title: ep.title, url: ep.url } : null, t: t, d: d, at: Date.now(), name: item.name, logo: item.logo });
  S.hist = S.hist.slice(0, 40); save('hist', S.hist);
}
function dropHist(key) { S.hist = S.hist.filter(function (h) { return h.key !== key; }); save('hist', S.hist); }
function savePos(key, v) {
  S.pos[key] = v; var keys = Object.keys(S.pos);
  if (keys.length > 2000) keys.sort(function (a, b) { return S.pos[a].at - S.pos[b].at; }).slice(0, 300).forEach(function (k) { delete S.pos[k]; });
  save('pos', S.pos);
}
function histLabel(h) { return h.ep ? 'T' + h.ep.season + ' · E' + h.ep.num : 'Filme'; }
function histLeft(h) { return h.d ? fmtLeft(h.d - h.t) : (h.ep ? 'Próximo Episódio' : ''); }
function histPct(h) { return h.d ? Math.min(100, h.t / h.d * 100) : 0; }
function resume(h) {
  var item = S.byKey[h.key]; if (!item) return;
  if (!h.ep) { play(item); return; }
  setBusy('Abrindo ' + h.name);
  fetchEps(item).then(function (eps) {
    setBusy('');
    var i = -1; eps.forEach(function (e, k) { if (String(e.id) === String(h.ep.id)) i = k; });
    play(item, { ep: i >= 0 ? eps[i] : h.ep, list: eps, index: Math.max(0, i) });
  }, function (e) { setBusy(''); toast('Erro: ' + e.message, 4000); });
}

/* ================= rendering ================= */
var TITLES = { home: '', games: 'Jogos do Dia', live: 'Ao Vivo', movies: 'Filmes', series: 'Séries', favorites: 'Favoritos', search: 'Buscar', settings: 'Ajustes' };
var CHUNK = window.ATL_CHUNK || 49;

function chHTML(it, idx) {
  var key = it.kind + ':' + it.id, q = it.variants && it.variants[0].q ? it.variants[0].q.label : '';
  return '<button class="f ch' + (P.tv && P.item === it ? ' playing' : '') + '" data-key="' + key + '" data-idx="' + idx + '">' + logoBox(it) +
    '<div><div class="name">' + esc(it.name) + '<span class="marks">' + marks(key) + '</span></div>' +
    '<div class="sub">' + (q ? '<span class="qual">' + esc(q) + '</span>' : '') + esc(it.catName) + '</div></div></button>';
}
/* each version of a channel brings its own logo: when one link is dead, the next one is tried */
function bankLogo(name) {
  // "Premiere 2" and "Globo SP" have no logo of their own: fall back to "Premiere" and "Globo"
  var words = norm(name).split(/[^a-z0-9]+/).filter(Boolean), bank = window.ATL_LOGOS || {};
  for (var n = words.length; n > 0; n--) { var k = words.slice(0, n).join(''); if (k.length > 2 && bank[k]) return bank[k]; }
  return '';
}
function logoBox(it) {
  var all = [], bank = it.kind === 'live' ? bankLogo(it.name) : ''; (it.variants || [it]).forEach(function (v) { if (v.logo && all.indexOf(v.logo) < 0) all.push(v.logo); });
  all = all.slice(0, 4); if (bank && all.indexOf(bank) < 0) all.push(bank);
  var img = all.length ? imgTag(all[0]).replace('<img ', '<img data-alts="' + esc(all.slice(1).join('|')) + '" ') : '';
  return '<span class="logo' + (all.length ? '' : ' noimg') + '" data-ini="' + esc(String(it.name).replace(/[^A-Za-z0-9À-ɏ]/g, '').slice(0, 2).toUpperCase()) + '">' + img + '</span>';
}
/* how far a title was watched: the movie's own position, or the series' current episode */
function progressBar(key) {
  var p = S.pos[key], h = histFor(key), pct = p && p.d ? p.t / p.d * 100 : h && h.d ? h.t / h.d * 100 : 0;
  return pct ? '<span class="epbar"><span style="width:' + pct + '%"></span></span>' : '';
}
/* a cover made here, under the real one: it shows whenever no picture exists or loads */
var GEN_COLORS = ['#26344a', '#3a2a3f', '#233b35', '#40302a', '#2f2f4d', '#3d2a2e'];
function genCover(name) {
  var t = cleanTitle(name).title.replace(/^[\s+\-–•]+/, ''), h = 0;
  for (var i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) % 997;
  return '<span class="gencover" style="background:' + GEN_COLORS[h % GEN_COLORS.length] + '"><b>' + esc(t) + '</b></span>';
}
function posterHTML(it, idx) {
  var key = it.kind + ':' + it.id, r = cachedRating(it), rate = bestRate(r, it);
  return '<button class="f poster" data-key="' + key + '" data-idx="' + idx + '"><span class="cover">' + genCover(it.name) + imgTag(it.logo, key, 185) +
    '<span class="rate"' + (rate ? '' : ' style="display:none"') + '>' + rate + '</span><span class="marks">' + marks(key) + '</span>' + progressBar(key) + '</span>' +
    '<span class="ptitle">' + esc(it.name) + '</span><span class="pyear">' + esc(it.year || '') + '</span></button>';
}
function cachedRating(it) {
  if (!it._rk) it._rk = rateKey(it);
  var r = S.ratings[it._rk];
  if (!r && notesLoaded && !it._rm) { it._rm = 1; rateKey(it); r = S.ratings[it._rk]; } // key worked out before the saved notes came in
  return r;
}
/* the key a title's note is saved under; a note saved before "+ " and "- " were dropped from the name is moved over */
function rateKey(it) {
  var ct = cleanTitle(it.name), y = it.year || ct.year, k = it.kind + '|' + norm(ct.title) + '|' + y, was = it.kind + '|' + norm(ct.old) + '|' + y;
  if (!S.ratings[k] && was !== k && S.ratings[was]) { S.ratings[k] = S.ratings[was]; delete S.ratings[was]; notesChanged(); }
  return k;
}
function notesChanged() { clearTimeout(saveT.ratings); saveT.ratings = setTimeout(saveNotes, 2000); }

/* incremental grid: renders CHUNK items, appends more as focus nears the end */
function mountGrid(container, items, cls, tpl) {
  container.innerHTML = '';
  if (!items.length) { container.innerHTML = '<div class="empty">Nada por Aqui.</div>'; return; }
  var grid = document.createElement('div'); grid.className = cls; container.appendChild(grid);
  grid._items = items; grid._tpl = tpl; grid._shown = 0;
  growGrid(grid);
  container.onscroll = function () { if (container.scrollTop + container.clientHeight > container.scrollHeight - 500 && grid._shown < grid._items.length) growGrid(grid); };
}
function growGrid(grid, upTo) {
  var from = grid._shown, to = Math.min(grid._items.length, Math.max(from + CHUNK, upTo || 0)), html = '';
  for (var i = from; i < to; i++) html += grid._tpl(grid._items[i], i);
  grid.insertAdjacentHTML('beforeend', html); grid._shown = to;
  observeImgs(grid);
}

/* the "Continuar" card shows the title's wide picture: the saved notes may still be loading, or the title was never looked up */
function fillHero() {
  var hero = $('.hero'), btn = hero && $('[data-hist]', hero), it = btn && S.byKey[btn.getAttribute('data-hist')];
  if (!it || $('img', hero) || !notesLoaded) return; // called again once the saved notes are in
  function put(r) {
    var u = (r && r.backdrop) || it.backdrop || (r && r.poster) || it.logo;
    if (!u || !document.body.contains(hero) || $('img', hero)) return;
    hero.insertAdjacentHTML('afterbegin', '<img class="lz" alt="" data-src="' + esc(thumb(u, 1280)) + '">'); observeImgs(hero);
  }
  var c = cachedRating(it);
  if (c && c.backdrop) put(c); else if (S.cfg.tmdbKey) getRatings(it).then(put, function () { put(c); }); else put(c);
}
function renderHome() {
  var list = S.hist.filter(function (h) { return S.byKey[h.key]; }), h = list[0], rest = list.slice(1, 4);
  var r = h && cachedRating(S.byKey[h.key]);
  var html = '<section class="hero-row">';
  if (h) html += '<div class="hero">' + (r && r.backdrop ? '<img class="lz" alt="" data-src="' + esc(thumb(r.backdrop, 1280)) + '">' : '') + '<div class="hero-shade"></div><div class="hero-body">' +
    '<p class="kicker">CONTINUAR</p><h2>' + esc(h.name) + '</h2><p class="hero-sub">' + esc([h.ep ? 'Temporada ' + h.ep.season + ' · Episódio ' + h.ep.num : '', histLeft(h)].filter(Boolean).join(' · ')) + '</p>' +
    '<div class="hero-act"><button class="f bigbtn" data-hist="' + esc(h.key) + '">▶ Continuar</button><div class="prog"><div style="width:' + histPct(h) + '%"></div></div></div></div></div>';
  else html += '<div class="hero"><div class="hero-body"><p class="kicker">BEM-VINDO</p><h2>Nada em Andamento</h2><p class="hero-sub">Escolha um Filme ou Série para Começar.</p><div class="hero-act"><button class="f bigbtn" data-go="movies">Ver Filmes</button></div></div></div>';
  html += '<div class="side"><button class="f card ball" data-go="games"><span class="kicker green">JOGOS DO DIA</span><strong>Placares e Canais</strong><span class="muted">Ao Vivo, Próximos e Lembretes</span></button>' +
    '<button class="f card later" data-go="favorites"><strong>Assistir Depois</strong><span class="muted">' + S.later.length + ' Títulos</span></button></div></section>';
  if (rest.length) {
    html += '<h2 class="section-title">Assistido Recentemente</h2><section class="recent">';
    rest.forEach(function (x) {
      html += '<button class="f rcard" data-hist="' + esc(x.key) + '"><span class="rcover">' + genCover(x.name) + imgTag(x.logo, x.key, 185) + '</span><span class="rbody"><span><b class="rtag">' + histLabel(x) + '</b><b class="rname">' + esc(x.name) + '</b></span>' +
        '<span><span class="muted">' + esc(histLeft(x)) + '</span><span class="prog"><span style="width:' + histPct(x) + '%"></span></span></span></span></button>';
    });
    html += '</section>';
  }
  var exp = S.exp ? new Date(+S.exp * 1000) : null;
  html += '<footer class="homefoot">' + (exp ? '<span>Vence em: ' + exp.toLocaleDateString('pt-BR') + '</span>' : '') + '<span>Botão Vermelho: Favoritar · Botão Verde: Assistir Depois</span></footer>';
  paint($('#content'), '<div class="scroll home">' + html + '</div>');
  fillHero();
}

/* channels in A-Z order, sorted once per load so every group, CH+/CH- and the preview keep it;
 * numeric: "ESPN 2" before "ESPN 10" */
function sortChannels() {
  var col = window.Intl && Intl.Collator ? new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' }) : null;
  S.live.forEach(function (i) { i._n = i._n || norm(i.name); });
  S.live.sort(function (a, b) { return col ? col.compare(a._n, b._n) : (a._n < b._n ? -1 : a._n > b._n ? 1 : 0); });
}
function liveItems(view, cat) {
  var list = S.live;
  if (cat === '__all') return list.filter(noAdult);
  if (cat === '__fav') return list.filter(function (i) { return !i.adult && isFav(i.kind + ':' + i.id); });
  return list.filter(function (it) { return it.cat === cat; });
}
/* large lists have many groups: the left column shows groups first, channels only after one is chosen */
function groupRows(view) {
  var n = {}, rows = [{ cat: '__all', name: 'Todos os Canais', n: liveItems(view, '__all').length }, { cat: '__fav', name: 'Favoritos', n: liveItems(view, '__fav').length }];
  S.live.forEach(function (i) { n[i.cat] = (n[i.cat] || 0) + 1; });
  S.liveCats.forEach(function (c) { var id = String(c.category_id); if (n[id]) rows.push({ cat: id, name: c.category_name, n: n[id], adult: catIsAdult(c.category_name) }); });
  return rows;
}
/* what most groups of a list repeat is noise on screen ("Filmes | Terror⚡PLUS" inside Filmes). It is worked out
 * from the list itself, so any provider works, and only the text shown changes: the groups stay as they came. */
var GROUP_SEP = /^(.{1,24}?)\s*[|:•·–-]+\s+/;
function groupNoise(view) {
  var cats = view === 'movies' ? S.movieCats : S.seriesCats, n = cats.length, heads = {}, tails = {}, out = { head: '', tail: '' };
  if (S._noiseOf === cats) return S._noise;
  cats.forEach(function (c) {
    // Latin ranges instead of \p{}: the regex must also parse on 2019 TVs, where \p{} stops the whole app
    var name = String(c.category_name), h = name.match(GROUP_SEP), t = name.match(/([A-Za-z0-9À-ɏ+]+)[^A-Za-z0-9À-ɏ+]*$/);
    if (h) heads[h[1]] = (heads[h[1]] || 0) + 1;
    if (t) tails[t[1]] = (tails[t[1]] || 0) + 1;
  });
  function top(o) { var best = ''; Object.keys(o).forEach(function (k) { if (o[k] >= 3 && o[k] >= n / 2 && (!best || o[k] > o[best])) best = k; }); return best; }
  out.head = top(heads); out.tail = top(tails);
  S._noiseOf = cats; S._noise = out;
  return out;
}
function shortGroup(name) {
  if (S.view !== 'movies' && S.view !== 'series') return name;
  var noise = groupNoise(S.view), s = String(name), h = s.match(GROUP_SEP);
  if (h && h[1] === noise.head) s = s.slice(h[0].length);
  if (noise.tail) { var i = s.toLowerCase().lastIndexOf(noise.tail.toLowerCase()); if (i > 0 && !/[A-Za-z0-9À-ɏ]/.test(s.slice(i + noise.tail.length))) s = s.slice(0, i).replace(/[^A-Za-z0-9À-ɏ)\]]+$/, ''); }
  return s.trim() || name;
}
function grpHTML(g, idx) { return '<button class="f grp' + (S.cat[S.view] === g.cat ? ' active' : '') + '" data-grp="' + esc(g.cat) + '" data-idx="' + idx + '"><span>' + esc(shortGroup(g.name)) + '</span>' + (g.adult && S.cfg.adultLock ? LOCK : '') + '<b>' + g.n + '</b></button>'; }
var LOCK = '<svg class="lock" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-label="Bloqueado"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
/* an adult group asks for the password every time it is opened: nothing stays unlocked */
function openGroup(view, cat, from) {
  if (!groupAdult(view, cat) || !S.cfg.adultLock) { showGroup(view, cat); return; }
  lastFocus = from;
  askPin('Conteúdo Adulto', function () { showGroup(view, cat); });
}
function pathLabel(view, cat, n) {
  if (cat === '__groups') return 'Grupos';
  var c = groupRows(view).filter(function (x) { return x.cat === cat; })[0];
  return (c ? c.name : '') + ' · ' + n + ' Canais · Voltar: Grupos';
}
function showGroup(view, cat) { showCat(view, cat); if (restoreSpot(view, cat)) return; var f = $('#gridWrap .ch, #gridWrap .poster'); if (f) focusEl(f); }
function backToGroups(view) {
  var cat = S.cat[view];
  if (P.item && P.item.adult) { stopTv(); setText('#pvName', 'Escolha um Canal'); epgEmpty(''); }
  showCat(view, '__groups');
  if (restoreSpot(view, '__groups')) return;
  var b = $$('.grp').filter(function (x) { return x.getAttribute('data-grp') === cat; })[0] || $('.grp');
  if (b) focusEl(b); else focusContent();
}
function byHistory(kind) {
  var want = kind === 'movies' ? 'movie' : 'series', out = [];
  S.hist.forEach(function (h) { var i = S.byKey[h.key]; if (i && i.kind === want) out.push(i); });
  return out;
}
function itemsFor(kind, cat) {
  var list = kind === 'movies' ? S.movies : S.series, out;
  if (cat.indexOf('__') === 0) list = list.filter(noAdult);
  if (cat === '__continue') return byHistory(kind);
  // what the viewer saved stays visible: the filter only trims the catalog
  if (S.hideBr && cat !== '__fav' && cat !== '__later') list = list.filter(noBr);
  if (cat === '__recent') return list.slice().sort(function (a, b) { return (b.added || 0) - (a.added || 0); }).slice(0, 300);
  if (cat === '__fav') out = list.filter(function (i) { return isFav(i.kind + ':' + i.id); });
  else if (cat === '__later') out = list.filter(function (i) { return isLater(i.kind + ':' + i.id); });
  else if (cat === '__all') out = list.slice();
  else out = list.filter(function (it) { return it.cat === cat; });
  if (S.sort === 'stars') {
    var sc = function (i) { return rateValue(cachedRating(i), i); };
    out = out.map(function (i) { return [sc(i), i]; }).sort(function (a, b) { return b[0] - a[0]; }).map(function (p) { return p[1]; });
  } else out.sort(function (a, b) { return (+b.year || 0) - (+a.year || 0) || (b.added || 0) - (a.added || 0); });
  return out;
}

/* channel screen: filters and list on the left; preview and programme guide on the right */
function renderChannels(view) {
  if (groupAdult(view, S.cat[view])) S.cat[view] = '__groups';
  var sel = S.cat[view] || '__groups', html = '<div class="tv"><div class="tvleft"><div class="tvhead"><h1>' + TITLES[view] + '</h1>' + '<button class="f tvrefresh" id="refreshBtn">Atualizar</button></div>';
  html += '<p class="tvpath" id="tvPath"></p><div class="scroll grid-wrap" id="gridWrap"></div></div><div class="tvright"><div class="pvslot"></div><h2 id="pvName">Escolha um Canal</h2><p class="muted" id="pvHint">OK Mostra a Prévia. OK de Novo Abre em Tela Cheia.</p><div id="epgList"></div></div></div>';
  $('#content').innerHTML = html;
  showCat(view, sel);
}
function selectChannel(item, list) {
  lastFocus = document.activeElement;
  $$('.ch.playing').forEach(function (b) { b.classList.remove('playing'); });
  if (lastFocus && lastFocus.classList.contains('ch')) lastFocus.classList.add('playing');
  setText('#pvName', item.name);
  play(item, { list: list, index: Math.max(0, list.indexOf(item)), mini: true });
}
function enterFull() { $('#player').classList.remove('mini'); document.activeElement.blur(); showOSD(); }
function leaveFull() {
  clearTimeout(osdT); $('#player').classList.remove('osd-on'); $('#player').classList.add('mini'); $('#menu').classList.add('hidden');
  setText('#pvName', P.item.name);
  $$('.ch.playing').forEach(function (b) { b.classList.remove('playing'); });
  var b = $('.ch[data-key="' + P.item.kind + ':' + P.item.id + '"]');
  if (b) { b.classList.add('playing'); focusEl(b); } else if (lastFocus && document.body.contains(lastFocus)) lastFocus.focus(); else focusContent();
}
function stopTv() {
  if (!P.tv || !playerShown()) return;
  teardown(); P.tv = false; P.item = null;
  $('#player').classList.add('hidden'); $('#player').classList.remove('mini', 'osd-on');
}
/* movies and series: groups stay on the left, titles on the right */
function renderLibrary(kind) {
  // opening on Continuar instead of Todos: a grid of the whole catalog asks for notes it doesn't need
  var cats = kind === 'movies' ? S.movieCats : S.seriesCats, list = kind === 'movies' ? S.movies : S.series, seen = byHistory(kind), sel = S.cat[kind] || (seen.length ? '__continue' : '__all'), count = {};
  if (sel === '__continue' && !seen.length) sel = '__all';
  if (S.hideBr) { list = list.filter(noBr); cats = cats.filter(function (c) { return !catBr(c.category_name); }); }
  var clean = list.filter(noAdult);
  if (groupAdult(kind, sel) || (S.hideBr && sel.indexOf('__') !== 0 && !cats.some(function (c) { return String(c.category_id) === sel; }))) sel = '__all';
  S.q = ''; S.cat[kind] = sel;
  list.forEach(function (i) { count[i.cat] = (count[i.cat] || 0) + 1; });
  $('#content').innerHTML = '<div class="lib"><div class="libtop"><input id="libQ" class="f inp" readonly type="text" autocomplete="off" placeholder="Pesquisar"><span class="muted" id="libCount"></span><div class="sortbox" role="group" aria-label="Ordenar"><button class="f sort' + (S.sort === 'year' ? ' active' : '') + '" data-sort="year">Mais Novos</button>' +
    '<button class="f sort' + (S.sort === 'stars' ? ' active' : '') + '" data-sort="stars">Mais Bem Avaliados</button><button class="f sort' + (S.hideBr ? ' active' : '') + '" id="hideBr">Ocultar Produções Brasileiras</button></div></div>' +
    '<div class="libbody"><div class="libgroups scroll" id="libGroups"></div><div class="scroll grid-wrap" id="gridWrap"></div></div></div>';
  var rows = seen.length ? [{ cat: '__continue', name: 'Continuar Assistindo', n: seen.length }] : [];
  rows.push({ cat: '__all', name: 'Todos', n: clean.length }, { cat: '__recent', name: 'Adicionados Recentemente', n: Math.min(300, clean.length) });
  rows.push({ cat: '__later', name: 'Assistir Depois', n: itemsFor(kind, '__later').length }, { cat: '__fav', name: 'Favoritos', n: itemsFor(kind, '__fav').length });
  cats.forEach(function (c) { var id = String(c.category_id); if (count[id]) rows.push({ cat: id, name: c.category_name, n: count[id], adult: catIsAdult(c.category_name) }); });
  mountGrid($('#libGroups'), rows, 'chlist', grpHTML);
  var at = rows.map(rowId).indexOf(sel), col = $('#libGroups .chlist');
  if (col && at >= col._shown) growGrid(col, at + 1);
  showCat(kind, sel);
  var on = $('.grp.active'); if (on) on.scrollIntoView({ block: 'center' });
}
/* search inside the open group, narrowing at every letter: titles that start with it first, then any word that does */
function searched(kind, cat) {
  var items = itemsFor(kind, cat), q = norm(S.q), out = items;
  if (q) {
    var safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), first = new RegExp('^[^a-z0-9]*' + safe), word = new RegExp('(^|[^a-z0-9])' + safe), a = [], b = [];
    items.forEach(function (it) { var n = it._n || (it._n = norm(it.name)); if (first.test(n)) a.push(it); else if (word.test(n)) b.push(it); });
    out = a.concat(b);
  }
  setText('#libCount', out.length + (out.length === 1 ? ' Título' : ' Títulos'));
  return out;
}
var qT;
function typedSearch(v) {
  clearTimeout(qT);
  qT = setTimeout(function () { S.q = v; var w = $('#gridWrap'); w.scrollTop = 0; mountGrid(w, searched(S.view, S.cat[S.view]), 'posters', posterHTML); }, 150);
}
function showCat(kind, cat) {
  if (cat !== S.cat[kind]) S.q = '';
  S.cat[kind] = cat; S.spotOff = groupAdult(kind, cat);
  $$('.grp').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-grp') === cat); });
  var wrap = $('#gridWrap'), tv = kind === 'live'; wrap.scrollTop = 0;
  if (cat === '__groups') { var rows = groupRows(kind); mountGrid(wrap, rows, 'chlist', grpHTML); setText('#tvPath', pathLabel(kind, cat, rows.length)); return; }
  var inp = $('#libQ'), active = $('.grp.active span');
  if (inp) { inp.value = S.q || ''; inp.placeholder = 'Pesquisar em ' + (active ? active.textContent : 'Todos'); }
  var items = tv ? liveItems(kind, cat) : searched(kind, cat);
  mountGrid(wrap, items, tv ? 'chlist' : 'posters', tv ? chHTML : posterHTML);
  if (tv) setText('#tvPath', pathLabel(kind, cat, items.length));
  else if (S.sort === 'stars') warmStars(kind, cat, items);
}
/* "Mais Bem Avaliados" can only order titles whose note is known: look up the first ones of the group
 * and put the grid back in order once, while the viewer is still at its top */
var starsWarm = {};
function warmStars(kind, cat, items) {
  var k = kind + '|' + cat; if (starsWarm[k] || S.q || !S.cfg.tmdbKey) return; starsWarm[k] = 1;
  var todo = items.filter(function (it) { return !rateDone(it); }).slice(0, 150);
  if (!todo.length) return;
  function next() {
    if (!todo.length) return Promise.resolve();
    var it = todo.shift();
    return (playerOpen() ? new Promise(function (r) { setTimeout(r, 5000); }) : Promise.resolve()).then(function () { return getRatings(it); }).then(next, next);
  }
  Promise.all([next(), next()]).then(function () {
    if (S.view !== kind || S.cat[kind] !== cat || S.sort !== 'stars' || S.q) return;
    var f = document.activeElement, inGrid = f && f.closest && f.closest('#gridWrap');
    if (inGrid && +f.getAttribute('data-idx') > 5) return; // already browsing further down: the new order waits for the next visit
    showCat(kind, cat);
    if (inGrid) { var first = $('#gridWrap .poster'); if (first) focusEl(first); }
  });
}

/* ================= today's matches =================
 * Futebol na TV (read by the service) has score, status and the channels of each match.
 * ESPN's public scoreboard is the fallback when that site is down; it has no Brazilian channels. */
var LEAGUES = [['bra.1', 'Brasileirão Série A'], ['bra.2', 'Brasileirão Série B'], ['bra.copa_do_brazil', 'Copa do Brasil'], ['conmebol.libertadores', 'Libertadores'], ['conmebol.sudamericana', 'Sul-Americana'],
  ['uefa.champions', 'Champions League'], ['uefa.europa', 'Europa League'], ['eng.1', 'Premier League'], ['esp.1', 'La Liga'], ['ita.1', 'Serie A da Itália'], ['ger.1', 'Bundesliga'], ['fra.1', 'Ligue 1'], ['por.1', 'Liga de Portugal'], ['arg.1', 'Liga Argentina']];
var G = { list: null, filter: 'all', failed: false, timer: null, noChannels: false, chMap: {} };
function hhmm(d) { return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }
function gameStatus(e) {
  var st = e.status || {}, t = st.type || {};
  if (t.state === 'post') return /POSTPONED/.test(t.name) ? 'Adiado' : /CANCELED/.test(t.name) ? 'Cancelado' : 'Encerrado';
  if (t.state === 'in') return /HALFTIME/.test(t.name) ? 'Intervalo' : (st.displayClock || 'Ao Vivo');
  return /POSTPONED/.test(t.name) ? 'Adiado' : hhmm(new Date(e.date));
}
function toGame(e, league) {
  var c = (e.competitions || [{}])[0], ts = c.competitors || [];
  var home = ts.filter(function (x) { return x.homeAway === 'home'; })[0] || ts[0] || {}, away = ts.filter(function (x) { return x.homeAway === 'away'; })[0] || ts[1] || {};
  var state = (e.status && e.status.type && e.status.type.state) || 'pre';
  return { id: e.id, league: league, state: state, status: gameStatus(e), at: Date.parse(e.date) || 0,
    home: (home.team || {}).shortDisplayName || (home.team || {}).displayName || '', away: (away.team || {}).shortDisplayName || (away.team || {}).displayName || '',
    hs: state === 'pre' ? '' : home.score, as: state === 'pre' ? '' : away.score, hl: (home.team || {}).logo, al: (away.team || {}).logo, channels: [] };
}
function fromTvSite(j) {
  var state = j.situacao === 'live' ? 'in' : j.situacao === 'final' ? 'post' : 'pre', at = j.inicio * 1000;
  return { id: j.id, league: j.liga, state: state, at: at, status: state === 'post' ? 'Encerrado' : state === 'in' ? (j.tempo || 'Ao Vivo') : at ? hhmm(new Date(at)) : j.tempo,
    home: j.casa, away: j.fora, hs: state === 'pre' ? '' : j.pc, as: state === 'pre' ? '' : j.pf, hl: '', al: '', channels: j.canais || [] };
}
/* Lê o HTML do Futebol na TV com DOMParser e devolve os jogos (placar, situação, horário e canais).
 * O DOMParser só monta a árvore: scripts e imagens da página não são executados nem carregados. */
function lerJogosDoSite(html) {
  var doc = new DOMParser().parseFromString(html, 'text/html'), jogos = [];
  function txt(el) { return el ? el.textContent.replace(/\s+/g, ' ').trim() : ''; }
  Array.prototype.forEach.call(doc.querySelectorAll('article.match'), function (a) {
    var nomes = Array.prototype.map.call(a.querySelectorAll('.m-name'), txt);
    if (nomes.length !== 2) return;
    var placar = Array.prototype.map.call(a.querySelectorAll('.m-score'), txt), canais = [];
    Array.prototype.forEach.call(a.querySelectorAll('.m-channels b'), function (b) { var c = txt(b); if (c && canais.indexOf(c) < 0) canais.push(c); });
    jogos.push({
      id: a.getAttribute('data-slot') || nomes.join('-'),
      liga: txt(a.querySelector('.m-head b')) || 'Outros jogos',
      situacao: a.getAttribute('data-status') || '',
      inicio: +a.getAttribute('data-ts') || 0,
      tempo: txt(a.querySelector('.m-time strong')),
      casa: nomes[0], fora: nomes[1], pc: placar[0] || '', pf: placar[1] || '',
      canais: canais
    });
  });
  return jogos;
}
/* Jogos de hoje direto do site (o WebView do Android não aplica CORS a páginas locais). */
function tvSiteGames() {
  return timeoutFetch('https://futebolnatv.com.br/', { cache: 'no-store' }, 20000)
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
    .then(function (html) {
      var lista = lerJogosDoSite(html);
      if (!lista.length) throw new Error('sem jogos');
      return lista.map(fromTvSite);
    });
}
function espnGames() {
  var d = new Date(), day = '' + d.getFullYear() + ('0' + (d.getMonth() + 1)).slice(-2) + ('0' + d.getDate()).slice(-2), ok = 0;
  return Promise.all(LEAGUES.map(function (l) {
    return getJSON('https://site.api.espn.com/apis/site/v2/sports/soccer/' + l[0] + '/scoreboard?dates=' + day, {}).then(function (r) {
      ok++; return (r.events || []).map(function (e) { return toGame(e, l[1]); });
    }, function () { return []; });
  })).then(function (all) { if (!ok) throw new Error('sem resposta'); return [].concat.apply([], all); });
}
function fetchGames() {
  return tvSiteGames().then(function (l) { G.noChannels = false; return l; }, function () { G.noChannels = true; return espnGames(); })
    .then(function (l) { G.list = l; G.failed = false; G.at = Date.now(); }, function () { G.failed = true; if (!G.list) G.list = []; });
}
/* Escudos: o TheSportsDB é consultado um nome por vez; quando ele não acha (ou falha), entra a lista de times
 * da ESPN (baixada no máximo uma vez por semana). Os dois resultados ficam no cache do app (LocalStorage). */
var CREST_LEAGUES = ['bra.1', 'bra.2', 'bra.3', 'bra.copa_do_brazil', 'conmebol.libertadores', 'conmebol.sudamericana', 'uefa.champions', 'uefa.europa', 'uefa.europa.conf', 'eng.1', 'eng.2', 'esp.1', 'esp.2', 'ita.1', 'ita.2', 'ger.1', 'ger.2', 'fra.1', 'fra.2', 'por.1', 'arg.1', 'ned.1', 'sco.1', 'usa.1', 'mex.1', 'tur.1', 'bel.1'];
var WEEK = 7 * 864e5, C = Object.assign({ map: {}, miss: {}, at: 0 }, load('crests2', {})), crestBusy = false, crestPause = 0;
function teamKey(s) { return norm(s).replace(/\b(fc|sc|ec|ac|cf|afc|cd|ca|se|fk|sv|club|clube|futebol|de|do|da)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim(); }
function smallLogo(u) { var m = String(u).match(/a\.espncdn\.com(\/i\/teamlogos\/[^?]+)/); return m ? 'https://a.espncdn.com/combiner/i?img=' + m[1] + '&h=80&w=80' : u; }
function crestFor(name) {
  var k = teamKey(name); if (C.map[k]) return C.map[k];
  if (k.length < 6 || k.indexOf(' ') >= 0) return '';
  // "Tottenham" inside "Tottenham Hotspur": only when one team fits, a wrong crest is worse than none
  var re = new RegExp('(^| )' + k + '( |$)'), hits = Object.keys(C.map).filter(function (n) { return re.test(n); }), urls = {};
  hits.forEach(function (n) { urls[C.map[n]] = 1; });
  return Object.keys(urls).length === 1 ? Object.keys(urls)[0] : '';
}
function loadEspnCrests() {
  if (Date.now() - C.at < WEEK || crestBusy) return Promise.resolve();
  crestBusy = true;
  var loaded = 0;
  return CREST_LEAGUES.reduce(function (p, l) {
    return p.then(function () {
      if (S.view !== 'games' || playerShown()) throw new Error('later');
      return timesDaLigaEspn(l).then(function (times) {
        loaded++;
        times.forEach(function (t) { t.nomes.forEach(function (n) { C.map[teamKey(n)] = smallLogo(t.logo); }); });
      }, function () {});
    });
  }, Promise.resolve()).then(function () { if (loaded) { C.at = Date.now(); save('crests2', C); } crestBusy = false; }, function () { crestBusy = false; });
}
/* Chave pública de teste do TheSportsDB (limite de buscas por minuto). A chave "3" passou a responder 403. */
var CHAVE_TSDB = '123';
/* Escudo de um time pelo nome no TheSportsDB; devolve '' se não achar. */
function askCrest(name) {
  return timeoutFetch('https://www.thesportsdb.com/api/v1/json/' + CHAVE_TSDB + '/searchteams.php?t=' + encodeURIComponent(name), {}, 15000)
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function (d) {
      var t = ((d && d.teams) || []).filter(function (x) { return x.strSport === 'Soccer' && x.strBadge; })[0];
      return t ? t.strBadge + '/tiny' : '';
    });
}
/* Times de uma liga na ESPN (nomes e escudo), usados como reserva quando o TheSportsDB não acha o time. */
function timesDaLigaEspn(liga) {
  return timeoutFetch('https://site.api.espn.com/apis/site/v2/sports/soccer/' + encodeURIComponent(liga) + '/teams?limit=200', {}, 15000)
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function (d) {
      var times = (((((d.sports || [])[0] || {}).leagues || [])[0] || {}).teams) || [];
      return times.map(function (x) {
        var t = x.team || {};
        return { nomes: [t.displayName, t.shortDisplayName, t.name, t.location, t.nickname].filter(Boolean), logo: t.logos && t.logos[0] && t.logos[0].href };
      }).filter(function (t) { return t.logo; });
    });
}
function nextCrest() {
  if (S.view !== 'games' || playerShown() || !G.list || crestBusy || Date.now() < crestPause) return;
  var now = Date.now(), name = null;
  G.list.some(function (g) { return [g.home, g.away].some(function (n) { var k = teamKey(n); if (crestFor(n) || (C.miss[k] && now - C.miss[k] < WEEK)) return false; name = n; return true; }); });
  if (!name) return;
  crestBusy = true;
  askCrest(name).then(function (url) {
    crestBusy = false; var k = teamKey(name);
    if (url) { C.map[k] = url; $$('.glogo[data-team="' + k + '"]').forEach(function (e) { e.innerHTML = '<img alt="" decoding="async" src="' + esc(url) + '">'; }); }
    else { C.miss[k] = now; loadEspnCrests().then(repaintGames); } // o TheSportsDB não conhece o time: tenta a ESPN
    save('crests2', C);
  }, function () { crestBusy = false; crestPause = Date.now() + 60000; loadEspnCrests().then(repaintGames); }); // sem resposta (ou limite): usa a ESPN
}
function startCrests() {
  clearInterval(G.crestT); G.crestT = setInterval(function () { if (S.view !== 'games') clearInterval(G.crestT); else nextCrest(); }, 4000);
}
function logoHTML(name, url) { var u = crestFor(name) || url; return '<span class="glogo" data-team="' + esc(teamKey(name)) + '">' + (u ? imgTag(u) : '') + '</span>'; }

/* the site says "SPORTV 2"; the list may say "SporTV 2 FHD": compare without spaces, from the start of the name */
function compact(s) { return norm(s).replace(/[^a-z0-9]/g, ''); }
var CH_ALIAS = { premierefc: 'premiereclubes' };
function channelsNamed(name) {
  var c = compact(name), exact = [], partial = [];
  c = CH_ALIAS[c] || c;
  if (G.chMap[c]) return G.chMap[c];
  // Globo is open TV and a list has one per city (Globo SP, Globo Ceará...): only the 4K one is offered
  if (c === 'globo' || c === 'tvglobo') {
    return (G.chMap[c] = S.live.filter(function (it) {
      var b = compact(channelBase(it.name));
      return !it.adult && isUhd(it.name) && (b.indexOf('globo') === 0 || b.indexOf('tvglobo') === 0) && !/^(tv)?globo(news|play)/.test(b);
    }));
  }
  S.live.forEach(function (it) { if (it.adult) return; var n = it._c || (it._c = compact(it.name)); if (n === c) exact.push(it); else if (n.indexOf(c) === 0) partial.push(it); });
  return (G.chMap[c] = exact.concat(partial));
}
function gameChannels(g) {
  var out = [];
  g.channels.forEach(function (n) { channelsNamed(n).forEach(function (it) { if (out.indexOf(it) < 0) out.push(it); }); });
  return out;
}
function gameHTML(g) {
  var chs = g.channels.map(function (n) { return '<i class="' + (channelsNamed(n).length ? 'have' : '') + '">' + esc(n) + '</i>'; }).join('');
  var rm = remFor(g.id);
  return '<button class="f game ' + g.state + '" data-game="' + esc(g.id) + '"><span class="gstatus">' + esc(g.status) + (rm && !rm.off ? '<span class="gbell">' + BELL + '</span>' : '') + '</span>' +
    '<span class="gteam">' + logoHTML(g.home, g.hl) + '<span class="gname">' + esc(g.home) + '</span><b>' + esc(g.hs) + '</b></span>' +
    '<span class="gteam">' + logoHTML(g.away, g.al) + '<span class="gname">' + esc(g.away) + '</span><b>' + esc(g.as) + '</b></span>' +
    '<span class="gchannels">' + (chs || (g.state === 'post' ? '' : '<i>Canal Não Informado</i>')) + '</span></button>';
}
/* the site only says "PREMIERE" and a list may have eight: the guide tells which one really shows the match */
function checkChannels(g, items) {
  var at = g.state === 'in' ? Date.now() / 1000 : g.at / 1000, keys = [teamKey(g.home), teamKey(g.away)];
  return Promise.all(items.slice(0, 16).map(function (it) {
    return epgFor(it, 8).then(function (l) {
      var p = l.filter(function (x) { return +x.start_timestamp <= at + 600 && +x.stop_timestamp > at; })[0], title = p ? b64(p.title) : '';
      var txt = p ? norm(title + ' ' + b64(p.description || '')) : '';
      return { it: it, title: title, hit: !!p && keys.some(function (k) { return k.length > 2 && txt.indexOf(k) >= 0; }) };
    });
  }));
}
function findGame(id) {
  var g = (G.list || []).filter(function (x) { return String(x.id) === String(id); })[0];
  if (g) return g;
  var r = remFor(id);
  return r ? Object.assign({ state: 'pre', status: hhmm(new Date(r.at)), hs: '', as: '', hl: '', al: '' }, r) : null;
}
function openGame(t) {
  var g = findGame(t.getAttribute('data-game')); if (!g) return;
  if (g.state === 'post') { toast('Este Jogo Já Terminou'); return; }
  if (g.state === 'pre' && g.at > Date.now()) { gameSheet(g, t); return; }
  watchGame(g, t);
}
function watchGame(g, t) {
  var m = gameChannels(g);
  if (!m.length) { toast(g.channels.length ? 'Nenhum Canal Deste Jogo Está na Sua Lista' : 'Canal Não Informado para Este Jogo', 3500); return; }
  lastFocus = t;
  setBusy('Procurando o Canal do Jogo');
  checkChannels(g, m).then(function (rows) {
    setBusy('');
    var hits = rows.filter(function (r) { return r.hit; });
    if (hits.length === 1) { play(hits[0].it, { list: [hits[0].it], index: 0 }); return; }
    if (rows.length === 1 && !rows[0].title) { play(rows[0].it, { list: m, index: 0 }); return; }
    // no guide first: those may have the match; a channel showing something else goes last
    pickChannel(g, hits.length ? hits : rows.filter(function (r) { return !r.title; }).concat(rows.filter(function (r) { return r.title; })), !!hits.length);
  }, function () { setBusy(''); pickChannel(g, m.map(function (it) { return { it: it, title: '' }; }), false); });
}
/* a match on several channels: the viewer chooses; in the player CH+/CH- walk through the others */
function pickChannel(g, rows, sure) {
  var p = $('#pick'), label = g.state === 'in' ? 'Agora: ' : 'No Horário: '; p._items = rows.map(function (r) { return r.it; }); p._game = g.id; p._ask = null;
  paint(p, '<div class="pickbox"><h2>' + esc(g.home + ' x ' + g.away) + '</h2><p class="muted">' + (sure ? 'A Programação Confirma Estes Canais' : 'A Programação Não Confirma o Canal. Veja o que Passa em Cada um.') + ' · Voltar: Cancelar</p><div class="picklist scroll">' + rows.map(function (r, i) {
    var it = r.it, q = it.variants && it.variants[0].q ? it.variants[0].q.label : '';
    return '<button class="f pick" data-i="' + i + '">' + logoBox(it) + '<span class="pickname">' + esc(it.name) + '<small>' + esc(r.title ? label + r.title : 'Sem Programação') + '</small></span>' + (q ? '<span class="qual">' + esc(q) + '</span>' : '') + '</button>';
  }).join('') + '</div></div>');
  p.classList.remove('hidden');
  $('.pick', p).focus();
}
function resumeChoice(r) {
  var a = $('#pick')._ask; closePick();
  a.opts.fromStart = r === '0'; play(a.item, a.opts);
}
function pickOpen() { return !$('#pick').classList.contains('hidden'); }
/* ---- subtitles already downloaded: they cost none of the daily quota again, and keep their sync per title ---- */
function saveSubs() {
  var f = S.subs.files, ids = Object.keys(f).sort(function (a, b) { return f[b].at - f[a].at; });
  ids.slice(15).forEach(function (id) { delete f[id]; });
  save('subs', S.subs);
}
function restoreSub() {
  var l = P.posKey && S.subs.last[P.posKey], f = l && S.subs.files[l.id];
  if (f) useExtSubs(f.text, f.label, l.id);
}
function keepSync() {
  if (!P.posKey || !P.subId) return;
  S.subs.last[P.posKey] = { id: P.subId, off: P.subOffset, rate: P.subRate }; saveSubs();
}
var RATE_SLOW = 23.976 / 25, RATE_FAST = 25 / 23.976;
function syncLabel() { return (P.subOffset > 0 ? '+' : '') + P.subOffset.toFixed(1).replace('.', ',') + ' s · Ritmo ' + (P.subRate === 1 ? 'normal' : 'corrigido'); }
function syncMenu(at) {
  function step(d, i) { return function () { P.subOffset = Math.round((P.subOffset + d) * 10) / 10; keepSync(); syncMenu(i); }; }
  function rate(r, i) { return function () { P.subRate = r; keepSync(); syncMenu(i); }; }
  menu('Sincronia: ' + syncLabel(), [
    { name: 'Legenda Antes da Fala: Atrasar 0,5 s', fn: step(0.5, 0) },
    { name: 'Legenda Antes da Fala: Atrasar 5 s', fn: step(5, 1) },
    { name: 'Legenda Depois da Fala: Adiantar 0,5 s', fn: step(-0.5, 2) },
    { name: 'Legenda Depois da Fala: Adiantar 5 s', fn: step(-5, 3) },
    { name: 'Vai Ficando Adiantada: Corrigir Ritmo', on: P.subRate === RATE_SLOW, fn: rate(RATE_SLOW, 4) },
    { name: 'Vai Ficando Atrasada: Corrigir Ritmo', on: P.subRate === RATE_FAST, fn: rate(RATE_FAST, 5) },
    { name: 'Ritmo Normal', on: P.subRate === 1, fn: rate(1, 6) },
    { name: 'Voltar', fn: subsMenu }
  ], subsMenu);
  var b = $('#menu .opt[data-i="' + (at || 0) + '"]'); if (b) b.focus();
}
function closePick() {
  var p = $('#pick'), id = String(p._game); p.classList.add('hidden'); p.innerHTML = '';
  if (p._game == null) { if (lastFocus && document.body.contains(lastFocus)) lastFocus.focus(); return; }
  var b = $$('.game').filter(function (x) { return x.getAttribute('data-game') === id; })[0];
  if (b) { lastFocus = b; b.focus({ preventScroll: true }); } else focusContent();
}
function paintGames() {
  var w = $('#gamesWrap'); if (!w) return;
  if (G.list === null) { w.innerHTML = '<div class="empty">Buscando os Jogos</div>'; return; }
  if (G.filter === 'rem') { paintReminders(w); return; }
  if (G.failed) { w.innerHTML = '<div class="empty">Não Consegui Buscar os Jogos Agora.<br>Confira a Internet da TV; Vou Tentar de Novo Sozinho.</div>'; return; }
  var active = document.activeElement && document.activeElement.getAttribute('data-game'), order = { 'in': 0, pre: 1, post: 2 }, html = '', leagues = [];
  G.chMap = {};
  G.list.forEach(function (g) { if (leagues.indexOf(g.league) < 0) leagues.push(g.league); });
  leagues.forEach(function (l) {
    var set = G.list.filter(function (g) { return g.league === l && (G.filter === 'all' || g.state === G.filter); })
      .sort(function (a, b) { return order[a.state] - order[b.state] || a.at - b.at; });
    if (set.length) html += '<div class="section-title">' + esc(l) + '</div><div class="games">' + set.map(gameHTML).join('') + '</div>';
  });
  paint(w, html || '<div class="empty">Nenhum Jogo Neste Filtro Hoje.</div>');
  setText('#gamesInfo', G.noChannels ? 'Canais Indisponíveis Agora · ' + hhmm(new Date()) : 'OK: Canal ou Lembrete · Atualizado às ' + hhmm(new Date()));
  var again = active && $$('.game').filter(function (b) { return b.getAttribute('data-game') === active; })[0];
  if (again) again.focus({ preventScroll: true });
}
function renderGames() {
  var opts = [['all', 'Todos'], ['in', 'Ao Vivo'], ['pre', 'Próximos'], ['post', 'Encerrados'], ['rem', 'Meus Lembretes']];
  $('#content').innerHTML = '<div class="lib"><div class="libtop"><div class="chips">' + opts.map(function (o) { return '<button class="f chip gfilter' + (G.filter === o[0] ? ' active' : '') + '" data-gf="' + o[0] + '">' + o[1] + '</button>'; }).join('') +
    '</div><span class="muted" id="gamesInfo"></span></div><div class="scroll grid-wrap" id="gamesWrap"></div></div>';
  paintGames();
  refreshGames();
  startCrests();
  // scores only refresh while this screen is on: nothing runs in the background during playback
  clearInterval(G.timer); G.timer = setInterval(function () { if (S.view !== 'games') clearInterval(G.timer); else if (!playerShown()) refreshGames(); }, 60000);
}
function repaintGames() { if (G.filter !== 'rem') paintGames(); } // the reminders page has no scores to refresh
function refreshGames() { fetchGames().then(repaintGames); }

/* ================= Lembretes de jogos =================
 * Ficam salvos na TV. Com o app aberto, uma checagem a cada 20 s mostra o aviso na tela; com o app fechado,
 * o Android dispara uma notificação nativa (AlarmManager + LembreteReceiver) no horário agendado pela ponte,
 * e o que passou despercebido aparece quando o app abre. */
var BELL = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-label="Lembrete"><path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 21h4"/></svg>';
var REM_KEEP = 2.5 * 36e5, REM_MINS = [5, 10, 15, 30], remShownAt = 0, remCloseT;
function remFor(id) { return S.rem.filter(function (r) { return String(r.id) === String(id); })[0] || null; }
function remOn(id) { var r = remFor(id); return !!r && !r.off; }
/* O Android perde a agenda se o app fechar, então o alarme fica com o AlarmManager (via SintoniaBridge) e a notificação
 * é disparada pelo LembreteReceiver. O alarme toca 30 s depois da checagem do app: com o app aberto o aviso na tela vem
 * primeiro, marca o lembrete como feito e cancela o alarme. */
function scheduleRem(r) {
  var quando = r.at - S.cfg.remMin * 6e4 + 30000, quer = !r.off && !r.done && quando > Date.now();
  if (!NATIVO) return;
  var id = String(r.id);
  if (!quer) { if (r.sched) { window.SintoniaBridge.cancelarLembrete(id); r.sched = 0; } return; }
  if (r.sched === quando) return; // já agendado para este horário
  r.sched = quando;
  window.SintoniaBridge.agendarLembrete(id, r.home + ' x ' + r.away + ' às ' + hhmm(new Date(r.at)), quando);
}
function saveRem() { S.rem.forEach(scheduleRem); save('rem', S.rem); }
function addRem(g, auto) {
  var old = remFor(g.id); if (old) S.rem.splice(S.rem.indexOf(old), 1);
  S.rem.push({ id: g.id, league: g.league, home: g.home, away: g.away, at: g.at, channels: g.channels, auto: !!auto });
  saveRem();
}
// a team's automatic reminder stays marked as cancelled, or the next check would bring it back
function cancelRem(id) {
  var r = remFor(id); if (!r) return;
  r.off = 1; scheduleRem(r);
  if (!r.auto) S.rem.splice(S.rem.indexOf(r), 1);
  saveRem();
}
function teamOn(name) { var k = teamKey(name); return S.teams.some(function (t) { return t.k === k; }); }
function toggleTeam(name) {
  var k = teamKey(name), on = teamOn(name);
  S.teams = S.teams.filter(function (t) { return t.k !== k; });
  if (!on) S.teams.push({ k: k, name: name });
  save('teams', S.teams); autoRems();
  toast(on ? name + ' Saiu dos Favoritos' : name + ': Lembrete Automático Ligado');
}
function autoRems() {
  var now = Date.now();
  (G.list || []).forEach(function (g) {
    if (g.state === 'pre' && g.at > now && !remFor(g.id) && (teamOn(g.home) || teamOn(g.away))) addRem(g, true);
  });
}
function remTick() {
  var now = Date.now(), lead = S.cfg.remMin * 6e4, kept = S.rem.filter(function (r) { return now < r.at + REM_KEEP; });
  if (kept.length !== S.rem.length) { S.rem = kept; save('rem', kept); }
  if (S.teams.length && now - (G.at || 0) > 36e5 && !playerOpen()) { G.at = now; fetchGames().then(autoRems); }
  if (!S.loaded || remindOpen() || busyOn() || pinOpen()) return;
  var r = S.rem.filter(function (x) { return !x.off && !x.done && now >= x.at - lead; })[0];
  if (r) showRem(r);
}
function showRem(r) {
  var m = Math.round((r.at - Date.now()) / 6e4), box = $('#remind');
  r.done = 1; saveRem();
  box._rem = r;
  box.innerHTML = '<p class="kicker">' + (m > 0 ? 'COMEÇA EM ' + m + ' MIN' : 'JÁ COMEÇOU') + '</p><h3>' + esc(r.home + ' x ' + r.away) + '</h3><p class="muted">' + esc([r.league, hhmm(new Date(r.at))].filter(Boolean).join(' · ')) + '</p>' +
    '<div class="row"><button class="f btn primary" id="remGo">Assistir</button><button class="f btn" id="remNo">Dispensar</button></div><p class="nexthint">OK: Assistir · Voltar: Dispensar</p>';
  box.classList.remove('hidden'); remShownAt = Date.now();
  clearTimeout(remCloseT); remCloseT = setTimeout(closeRem, 3 * 6e4);
}
function remindOpen() { return !$('#remind').classList.contains('hidden'); }
function closeRem() { clearTimeout(remCloseT); $('#remind').classList.add('hidden'); $('#remind').innerHTML = ''; remTick(); }
function watchRem() {
  var r = $('#remind')._rem, g = r && findGame(r.id);
  clearTimeout(remCloseT); $('#remind').classList.add('hidden'); $('#remind').innerHTML = '';
  if (!g) return;
  if (playerOpen()) { if (P.tv) leaveFull(); else closePlayer(); }
  if (!$('#detail').classList.contains('hidden')) closeDetail();
  // the site may only list the channels close to kick-off: ask again before opening
  setBusy('Abrindo o Jogo');
  fetchGames().then(function () { setBusy(''); watchGame(findGame(r.id) || g, document.activeElement); });
}
/* what OK offers on a match that hasn't started */
function gameSheet(g, t) {
  var p = $('#pick'), on = remOn(g.id), opts = [['rem', on ? 'Cancelar Lembrete' : 'Lembrar ' + S.cfg.remMin + ' min Antes'], ['open', 'Abrir Canal Agora']];
  [g.home, g.away].forEach(function (n, i) { opts.push(['t' + i, (teamOn(n) ? 'Tirar ' + n + ' dos Favoritos' : 'Lembrar Sempre de ' + n)]); });
  lastFocus = t; p._game = g.id; p._ask = null; p._sheet = g;
  p.innerHTML = '<div class="pickbox"><h2>' + esc(g.home + ' x ' + g.away) + '</h2><p class="muted">' + esc([g.league, hhmm(new Date(g.at))].filter(Boolean).join(' · ')) + ' · Voltar: Cancelar</p><div class="picklist">' +
    opts.map(function (o) { return '<button class="f pick resume" data-gs="' + o[0] + '"><span class="pickname">' + esc(o[1]) + '</span></button>'; }).join('') + '</div></div>';
  p.classList.remove('hidden'); $('.pick', p).focus();
}
function sheetAction(a) {
  var p = $('#pick'), g = p._sheet, t = lastFocus; closePick();
  if (a === 'rem') {
    if (remOn(g.id)) { cancelRem(g.id); toast('Lembrete Cancelado'); }
    else { addRem(g); toast('Lembrete Salvo: ' + S.cfg.remMin + ' min Antes do Jogo'); }
    paintGames();
  } else if (a === 'open') watchGame(g, t);
  else { toggleTeam(a === 't0' ? g.home : g.away); paintGames(); }
}
function paintReminders(w) {
  var list = S.rem.filter(function (r) { return !r.off; }).sort(function (a, b) { return a.at - b.at; });
  var html = '<div class="section-title">Avisar Antes do Jogo</div><div class="row">' + REM_MINS.map(function (m) { return '<button class="f chip gmin' + (S.cfg.remMin === m ? ' active' : '') + '" data-min="' + m + '">' + m + ' min</button>'; }).join('') + '</div>';
  html += '<div class="section-title">Times Favoritos</div>' + (S.teams.length ? '<div class="row">' + S.teams.map(function (t) { return '<button class="f chip gfav" data-team="' + esc(t.k) + '">' + esc(t.name) + '</button>'; }).join('') + '</div><p class="muted">OK Remove o Time. Jogos Deles Entram Sozinhos nos Lembretes.</p>' : '<p class="muted">Nenhum Ainda. Escolha um Jogo e Toque em "Lembrar Sempre de…".</p>');
  html += '<div class="section-title">Lembretes</div>' + (list.length ? '<div class="games">' + list.map(function (r) { return gameHTML(findGame(r.id)); }).join('') + '</div>' : '<p class="muted">Nenhum. Escolha um Jogo que Ainda Vai Começar e Aperte OK.</p>');
  paint(w, html);
  setText('#gamesInfo', '');
}

function renderFavorites() {
  function uniq(keys) { var seen = [], out = []; keys.forEach(function (k) { var i = S.byKey[k]; if (i && !i.adult && seen.indexOf(i) < 0) { seen.push(i); out.push(i); } }); return out; }
  var favs = uniq(S.favs), later = uniq(S.later);
  var html = '<div class="scroll" id="gridWrap">', idx = 0;
  var live = favs.filter(function (i) { return i.kind === 'live'; }), vod = favs.filter(function (i) { return i.kind !== 'live'; });
  if (later.length) { html += '<div class="section-title">Assistir Depois</div><div class="posters">'; later.forEach(function (i) { html += posterHTML(i, idx++); }); html += '</div>'; }
  if (live.length) { html += '<div class="section-title">Canais Favoritos</div><div class="channels">'; live.forEach(function (i) { html += chHTML(i, idx++); }); html += '</div>'; }
  if (vod.length) { html += '<div class="section-title">Filmes e Séries Favoritos</div><div class="posters">'; vod.forEach(function (i) { html += posterHTML(i, idx++); }); html += '</div>'; }
  if (!idx) html += '<div class="empty">Nada Salvo Ainda.<br>Botão Vermelho do Controle: Favoritar. Botão Verde: Assistir Depois.</div>';
  paint($('#content'), html + '</div>');
}

var searchT;
function renderSearch() {
  $('#content').innerHTML = '<div class="searchbar"><input id="q" class="f inp" readonly type="text" value="' + esc(S.lastSearch || '') + '" placeholder="Digite o Nome do Canal, Filme ou Série…" autocomplete="off"></div>' +
    '<div class="scroll" id="gridWrap" style="height:calc(100% - 110px)"><div class="empty">Busca Sem Acento e Sem Diferenciar Maiúsculas: "sao paulo" Acha "São Paulo".</div></div>';
  var q = $('#q');
  q.addEventListener('input', function () { clearTimeout(searchT); searchT = setTimeout(function () { doSearch(q.value); }, 350); });
  if (S.lastSearch) doSearch(S.lastSearch);
  setTimeout(function () { if (document.activeElement === document.body) q.focus(); }, 50); // readonly: the keyboard only opens on OK
}
function doSearch(text) {
  var wrap = $('#gridWrap'), terms = norm(text).split(' ').filter(Boolean);
  S.lastSearch = text;
  if (!terms.length || norm(text).length < 2) { wrap.innerHTML = ''; return; }
  function match(it) { var n = it._n || (it._n = norm(it.name)); for (var i = 0; i < terms.length; i++) if (n.indexOf(terms[i]) < 0) return false; return true; }
  function score(it) { return it._n.indexOf(terms[0]) === 0 ? 0 : 1; }
  function find(list) { return list.filter(noAdult).filter(match).sort(function (a, b) { return score(a) - score(b) || a.name.length - b.name.length; }).slice(0, 120); }
  var live = find(S.live), mov = find(S.movies), ser = find(S.series), html = '', idx = 0;
  if (live.length) { html += '<div class="section-title">Canais (' + live.length + ')</div><div class="channels">'; live.forEach(function (i) { html += chHTML(i, idx++); }); html += '</div>'; }
  if (mov.length) { html += '<div class="section-title">Filmes (' + mov.length + ')</div><div class="posters">'; mov.forEach(function (i) { html += posterHTML(i, idx++); }); html += '</div>'; }
  if (ser.length) { html += '<div class="section-title">Séries (' + ser.length + ')</div><div class="posters">'; ser.forEach(function (i) { html += posterHTML(i, idx++); }); html += '</div>'; }
  paint(wrap, html || '<div class="empty">Nada Encontrado para "' + esc(text) + '".</div>');
}

/* Ajustes: sections on the left, the chosen one on the right. Moving over a section shows it, OK or right enters it */
var SET_SECS = [['lists', 'Listas'], ['channels', 'Canais'], ['library', 'Filmes e Séries'], ['av', 'Áudio e Legenda'], ['adult', 'Conteúdo Adulto'], ['keys', 'Chaves de API'], ['about', 'Sobre o App']];
function setPanel(sec) {
  var c = S.cfg;
  function seg(name, opts) { return '<div class="row seg">' + opts.map(function (o) { return '<button class="f btn' + (c[name] === o[0] ? ' on' : '') + '" data-seg="' + name + '" data-val="' + o[0] + '">' + o[1] + '</button>'; }).join('') + '</div>'; }
  function row(label, html) { return '<div class="setrow"><span class="setlabel">' + label + '</span>' + html + '</div>'; }
  function keys(names) {
    return KEY_FIELDS.filter(function (k) { return names.indexOf(k[0]) >= 0; }).map(function (k) { return '<label>' + k[1] + (c[k[0]] ? ' · salva ✓' : ' · não informada') + '</label><input class="f inp" readonly id="k_' + k[0] + '" type="password" value="' + esc(c[k[0]]) + '" style="width:100%">'; }).join('') +
      '<div class="row"><button class="f btn" id="saveKeys">Salvar Chaves</button></div>';
  }
  if (sec === 'lists') {
    if (S.draft) return listForm(S.draft);
    return '<h2 class="settitle">Listas</h2>' + (S.lists.length ? S.lists.map(listRow).join('') : '<p class="note">Nenhuma Lista Adicionada</p>') +
      '<div class="row"><button class="f btn primary" id="openRemote">Adicionar pelo Celular</button><button class="f btn" id="newList">Digitar uma Lista</button>' + (S.lists.length ? '<button class="f btn" id="reload">Recarregar Lista</button>' : '') + '</div>';
  }
  if (sec === 'channels') return '<h2 class="settitle">Canais</h2>' +
    row('Qualidade', seg('quality', [['all', 'Todas'], ['fhd265', 'Priorizar FHD H.265'], ['h265', 'Só H.265']])) +
    row('Formato', seg('liveFormat', [['m3u8', 'HLS'], ['ts', 'TS']]));
  if (sec === 'av') return '<h2 class="settitle">Áudio e Legenda</h2>' +
    row('Áudio Preferido', seg('prefAudio', [['pt', 'Português'], ['en', 'Inglês'], ['', 'Padrão do Vídeo']])) +
    row('Legenda Preferida', seg('prefSub', [['pt-br', 'Português'], ['en', 'Inglês']]));
  if (sec === 'library') return '<h2 class="settitle">Filmes e Séries</h2>' +
    row('Classificação', '<button class="f btn dropbtn" id="rateSrc"><span>' + esc(rateLabel()) + '</span><i></i></button>') +
    row('Histórico', '<button class="f btn" id="clearSeen">Limpar Assistidos</button>');
  if (sec === 'keys') return '<h2 class="settitle">Chaves de API</h2>' +
    '<p class="note">Cada Chave Fica Salva Só na TV. TMDB e OMDb Trazem Capas e Notas; Wyzie e OpenSubtitles Buscam Legendas. Deixe um Campo Vazio e Salve para Apagar a Chave.</p>' +
    keys(['tmdbKey', 'omdbKey', 'wyzieKey', 'osKey']);
  if (sec === 'adult') return '<h2 class="settitle">Conteúdo Adulto</h2>' +
    '<div class="row"><button class="f btn" id="adultLock">Bloqueio com Senha: ' + (c.adultLock ? 'ligado' : 'desligado') + '</button><button class="f btn" id="adultPin">Trocar Senha</button></div>';
  return '<h2 class="settitle">Sobre o App</h2>' +
    row('Versão ' + versaoExibida(), '<button class="f btn" id="checkUpdate">Verificar Atualização</button>') +
    '<p class="note">Tudo Fica Salvo Só na TV. O App É Apenas um Player: Ele Não Fornece Canais Nem Conteúdo.</p>';
}
function renderSettings() {
  $('#content').innerHTML = '<div class="setwrap"><div class="setnav">' + SET_SECS.map(function (s) { return '<button class="f btn setsec' + (s[0] === S.setSec ? ' on' : '') + '" data-sec="' + s[0] + '">' + s[1] + '</button>'; }).join('') +
    '</div><div class="scroll setscroll"><div class="form sets" id="setMain">' + setPanel(S.setSec) + '</div></div></div>';
}
function showSec(sec) {
  if (sec === S.setSec) return;
  S.setSec = sec; S.draft = null;
  $$('.setsec').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-sec') === sec); });
  $('#setMain').innerHTML = setPanel(sec); $('.setscroll').scrollTop = 0;
}
function focusPanel() { var f = $('#setMain .f'); if (f) focusEl(f); }
/* Atualização da interface (OTA). No Android, o AtualizacaoInterfaceWorker baixa a interface nova do GitHub Pages
 * a cada 24 h, em segundo plano e só com o vídeo parado. Aqui o usuário pode pedir a verificação na hora:
 * o Android responde em window.sintoniaResultadoAtualizacao(estado, detalhe). A interface nova vale na próxima abertura. */
function versaoExibida() {
  if (!NATIVO) return '(navegador)';
  var b = window.SintoniaBridge, app = '', ifc = '';
  try { app = b.versaoApp(); } catch (e) {}
  try { ifc = b.obterVersaoInterface(); } catch (e) {}
  return (app || '?') + (ifc ? ' · Interface ' + ifc : '');
}
function checkUpdate() {
  if (!NATIVO || !window.SintoniaBridge.verificarAtualizacaoInterface) { toast('Só Funciona na TV'); return; }
  setBusy('Verificando Atualização');
  console.log('Sintonia: verificação da interface pedida pelo usuário');
  window.SintoniaBridge.verificarAtualizacaoInterface();
}
window.sintoniaResultadoAtualizacao = function (estado, detalhe) {
  setBusy('');
  console.log('Sintonia: resultado da atualização da interface: ' + estado + ' (' + detalhe + ')');
  if (estado === 'ATUALIZADA') { toast('Você Já Está na Versão Mais Nova'); return; }
  if (estado === 'ADIADA') { toast('Há um Vídeo em Reprodução: a Atualização Fica para Depois', 6000); return; }
  if (estado !== 'INSTALADA') { toast('Não Consegui Atualizar: ' + (detalhe || 'erro desconhecido'), 6000); return; }
  // recarregar a interface recarrega também a lista: quem decide é o usuário
  chooser('Atualização Pronta', [['depois', 'Usar na Próxima Vez que Abrir o App'], ['agora', 'Reiniciar Agora (Recarrega a Lista)']], 'depois', function (c) {
    if (c !== 'agora') { toast('A Atualização Entra na Próxima Abertura'); return; }
    try { sessionStorage.setItem('atl.after', JSON.stringify({ view: 'settings', spot: S.spot, cat: null, play: null, tv: false, full: false })); } catch (e) {}
    window.SintoniaBridge.reiniciarInterface();
  });
};
var KEY_FIELDS = [['tmdbKey', 'TMDB'], ['omdbKey', 'OMDb (IMDb)'], ['wyzieKey', 'Wyzie'], ['osKey', 'OpenSubtitles']];
function saveKeys() {
  // os campos já vêm preenchidos com a chave atual: campo vazio quer dizer que o usuário apagou a chave
  KEY_FIELDS.forEach(function (k) { var e = $('#k_' + k[0]); if (e) S.cfg[k[0]] = e.value.trim(); });
  save('cfg', S.cfg); toast('Chaves Salvas');
  chaveRecusada = { tmdb: '', omdb: '' }; // chave nova ou corrigida: volta a tentar
  console.log('Sintonia: chaves de API salvas (' + KEY_FIELDS.filter(function (k) { return S.cfg[k[0]]; }).length + ' de ' + KEY_FIELDS.length + ' preenchidas)');
  renderSettings();
  var salvar = $('#saveKeys'); if (salvar) salvar.focus();
}
function rateOptions() {
  var o = [['auto', S.cfg.omdbKey ? 'Automática: IMDb, Depois TMDB' : 'Automática'], ['tmdb', 'TMDB']];
  if (S.cfg.omdbKey) o.splice(1, 0, ['imdb', 'IMDb']);
  return o;
}
function rateLabel() { var o = rateOptions().filter(function (x) { return x[0] === S.cfg.rateSrc; })[0]; return o ? o[1] : rateOptions()[0][1]; }
/* a dropdown that works with the remote: the options open over the screen */
function chooser(title, opts, cur, done) {
  var p = $('#pick'); lastFocus = document.activeElement; p._game = null; p._ask = null; p._choose = done;
  p.innerHTML = '<div class="pickbox"><h2>' + esc(title) + '</h2><div class="picklist">' + opts.map(function (o) { return '<button class="f pick resume' + (o[0] === cur ? ' chosen' : '') + '" data-choose="' + esc(o[0]) + '"><span class="pickname">' + esc(o[1]) + '</span></button>'; }).join('') + '</div></div>';
  p.classList.remove('hidden'); ($('.pick.chosen', p) || $('.pick', p)).focus();
}
function pickRateSrc() {
  chooser('Classificação', rateOptions(), S.cfg.rateSrc, function (v) { S.cfg.rateSrc = v; save('cfg', S.cfg); setText('#rateSrc span', rateLabel()); });
}
function listRow(l) {
  return '<div class="setrow"><button class="f btn listname" data-list="' + esc(l.id) + '" aria-label="Editar ' + esc(l.name) + '">' + esc(l.name) + '</button>' +
    (l.id === S.listOn ? '<span class="setvalue">Em Uso</span>' : '<button class="f btn" data-use="' + esc(l.id) + '">Ativar</button>') + '</div>';
}
function listForm(d) {
  function field(id, label, val, pw) { return '<label>' + label + '</label><input class="f inp" readonly id="' + id + '"' + (pw ? ' type="password"' : '') + ' value="' + esc(val) + '" style="width:100%">'; }
  function kind(v, label) { return '<button class="f btn' + (d.type === v ? ' on' : '') + '" data-ltype="' + v + '">' + label + '</button>'; }
  return '<div id="listForm"><h2 class="settitle">' + (d.id ? 'Editar Lista' : 'Nova Lista') + '</h2>' + field('l_name', 'Nome da Lista', d.name) +
    '<label>Tipo de Lista</label><div class="row seg">' + kind('xtream', 'Login Xtream') + kind('m3u', 'Link M3U') + '</div>' +
    '<div id="xtreamFields"' + (d.type === 'xtream' ? '' : ' class="hidden"') + '>' + field('l_server', 'Servidor (Ex.: http://exemplo.com:8080)', d.server) + field('l_user', 'Usuário', d.user) + field('l_pass', 'Senha', d.pass, true) + '</div>' +
    '<div id="m3uFields"' + (d.type === 'm3u' ? '' : ' class="hidden"') + '>' + field('l_m3u', 'Link da Lista M3U (Colar o Link Completo Preenche Servidor, Usuário e Senha)', d.m3u) + '</div>' +
    '<div class="row">' + (d.id === S.listOn ? '' : '<button class="f btn primary" id="listUse">Salvar e Usar Esta Lista</button>') + '<button class="f btn' + (d.id === S.listOn ? ' primary' : '') + '" id="listSave">Salvar</button>' +
    (d.id && d.id !== S.listOn ? '<button class="f btn" id="listDel">Excluir</button>' : '') + '<button class="f btn" id="listCancel">Cancelar</button></div></div>';
}
function openDraft(d) { if (S.view !== 'settings') go('settings'); S.setSec = 'lists'; S.draft = d; renderSettings(); focusEl($('#l_name')); }
function newDraft() { return { id: null, name: '', type: 'xtream', server: '', user: '', pass: '', m3u: '' }; }
function closeDraft() { S.draft = null; renderSettings(); focusPanel(); }
function saveDraft(use) {
  var d = S.draft, v = function (id) { var e = $('#' + id); return e ? e.value.trim() : ''; }, l = { name: v('l_name') };
  if (!l.name) { toast('Dê um Nome à Lista'); $('#l_name').focus(); return; }
  if (d.type === 'xtream') {
    l.type = 'xtream'; l.server = v('l_server'); l.user = v('l_user'); l.pass = v('l_pass'); l.m3u = '';
    if (!l.server || !l.user) { toast('Preencha Servidor e Usuário'); return; }
    if (!/^https?:\/\//i.test(l.server)) l.server = 'http://' + l.server;
  } else {
    var p = parseLink(v('l_m3u'));
    if (!p) { toast('Link Inválido'); return; }
    Object.assign(l, { server: '', user: '', pass: '', m3u: '' }, p);
  }
  var cur = d.id ? S.lists.filter(function (x) { return x.id === d.id; })[0] : null;
  // a new name changes nothing the TV loaded: only the connection data asks for a reload
  var moved = !cur || ENTRY_KEYS.some(function (k) { return (cur[k] || '') !== (l[k] || ''); });
  if (cur) Object.assign(cur, l);
  else { cur = Object.assign({ id: 'l' + Date.now() }, l); S.lists.push(cur); }
  save('lists', S.lists); S.draft = null;
  if ((use && cur.id !== S.listOn) || (moved && cur.id === S.listOn) || !S.listOn) { activateList(cur.id); return; }
  renderSettings(); focusPanel(); toast('Lista Salva');
}
function setActive(id) {
  var l = S.lists.filter(function (x) { return x.id === id; })[0];
  S.listOn = l ? id : null; save('listOn', S.listOn);
  if (l) { ENTRY_KEYS.forEach(function (k) { S.cfg[k] = l[k]; }); save('cfg', S.cfg); }
}
/* a list that doesn't load never strands the TV: the one that was working comes back */
function activateList(id) {
  var prev = S.listOn === id ? null : S.listOn, l = S.lists.filter(function (x) { return x.id === id; })[0];
  setActive(id); S.loaded = false; S.cat = {};
  setBusy('Carregando ' + l.name);
  loadAll().then(function () { setBusy(''); toast('Lista Carregada ✓'); go('home'); focusNav(); }, function (e) {
    if (!prev) { loadFailed(e); return; }
    setActive(prev); toast(l.name + ' Não Carregou: ' + e.message, 6000); reload();
  });
}
function deleteList() {
  var d = S.draft;
  chooser('Excluir ' + d.name + '?', [['n', 'Cancelar'], ['s', 'Excluir']], 'n', function (v) {
    if (v !== 's') { $('#listDel').focus(); return; }
    S.lists = S.lists.filter(function (x) { return x.id !== d.id; }); save('lists', S.lists); closeDraft(); toast('Lista Excluída');
  });
}
function reload() {
  S.loaded = false; S.cat = {};
  setBusy('Carregando Sua Lista');
  loadAll().then(function () { setBusy(''); toast('Lista Carregada ✓'); go('home'); focusNav(); }, loadFailed);
}
/* a list that fails to load keeps its data: Início explains and offers another try */
function loadFailed(e) { setBusy(''); status(''); S.loadError = e.message; go('home'); focusContent(); }
function focusNav() { ($('.nav.active') || $('.nav')).focus(); }

function greeting() { var h = new Date().getHours(); return h < 12 ? 'Bom Dia' : h < 18 ? 'Boa Tarde' : 'Boa Noite'; }
function clock() {
  if (S.view !== 'home') return;
  var d = new Date(), w = d.toLocaleDateString('pt-BR', { weekday: 'long' });
  status(w.charAt(0).toUpperCase() + w.slice(1).replace('-feira', '') + ' · ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2));
}
setInterval(clock, 20000);

function focusContent() { if (S.view === 'settings') { $('.setsec.on').focus(); return; } if (restoreSpot()) return; var f = $('#content .ch') || $('#content .grp.active') || $('#content .grp') || $('#content .poster') || $('#content .inp') || $('#content .f'); if (f) f.focus(); else focusNav(); }
function go(view) {
  stopTv();
  S.view = view;
  // the main menu only lives on Início; each section takes the whole screen
  $('#app').classList.toggle('norail', view !== 'home');
  $('#app').classList.toggle('tvview', view === 'live');
  $$('.nav').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-view') === view); });
  $('#viewTitle').textContent = view === 'home' ? greeting() : TITLES[view];
  if (view === 'games') { renderGames(); status(''); return; }
  if (view !== 'settings' && !S.loaded) {
    $('#content').innerHTML = S.loadError ? '<div class="empty">Não Consegui Carregar Sua Lista: ' + esc(S.loadError) + '<br>Ela Continua Salva.</div><button class="f btn primary" id="reload">Tentar de Novo</button>'
      : '<div class="empty">Nenhuma Lista Carregada Ainda.<br>Adicione Sua Lista pelo Celular, com Login Xtream ou Link M3U.</div><button class="f btn primary" data-go="settings">Adicionar Lista</button>';
    return;
  }
  if (S.loaded && view !== 'home') status(S.live.length + ' Canais · ' + S.movies.length + ' Filmes · ' + S.series.length + ' Séries');
  if (view === 'home') { renderHome(); clock(); }
  else if (view === 'live') renderChannels(view);
  else if (view === 'movies' || view === 'series') renderLibrary(view);
  else if (view === 'favorites') renderFavorites();
  else if (view === 'search') renderSearch();
  else if (view === 'settings') { S.setSec = 'lists'; S.draft = null; renderSettings(); }
}

/* ================= detail (movie / series) ================= */
var BOOKMARK = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4z"/></svg>';
var STAR = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z"/></svg>';
function laterLabel(key) { return BOOKMARK + (isLater(key) ? 'Na Lista' : 'Assistir Depois'); }
function favLabel(key) { return STAR + (isFav(key) ? 'Nos Favoritos' : 'Favorito'); }
function openDetail(item, toEp) {
  var d = $('#detail'), key = item.kind + ':' + item.id, h = histFor(key);
  d.innerHTML = '<div class="dbg"><img id="dBg" alt=""></div><div class="dshade"></div><div class="dshade2"></div><div class="dhead">' +
    '<div class="dtop"><p class="eyebrow" id="dMeta">' + esc([item.kind === 'movie' ? 'FILME' : 'SÉRIE', item.year, item.catName].filter(Boolean).join(' · ')) + '</p><span class="dload" id="dLoad"><i class="spin sm"></i>Carregando Informações</span></div>' +
    '<h1>' + esc(item.name) + '</h1><div class="ratings" id="dRatings">' + (listRate(cachedRating(item), item) ? '<span class="pill">Lista ' + (+item.rating).toFixed(1) + '</span>' : '') + '</div>' +
    '<div class="plot" id="dPlot">' + esc(item.plot || '') + '</div>' +
    '<div class="row"><button class="f bigbtn" id="dPlay">' + (item.kind === 'series' && !h ? 'Carregando' : '▶ ' + (h ? 'Continuar' : 'Assistir')) + '</button>' +
    '<button class="f dbtn" id="dLater">' + laterLabel(key) + '</button><button class="f dbtn" id="dFav">' + favLabel(key) + '</button></div></div>' +
    (item.kind === 'series' ? '<div class="dlower"><div class="seasons" id="dSeasons" role="tablist" aria-label="Temporadas"></div><div class="episodes scroll" id="dEps"><div class="dwait"><i class="spin sm"></i>Carregando Episódios</div></div></div>' : '');
  d.classList.remove('hidden'); d._item = item; d._eps = null; d._from = lastFocus; d._toEp = !!toEp;
  // the ratings plus the list's own details: the notice stays until both are in
  var waits = 1 + (item.kind === 'series' || S.cfg.type === 'xtream' ? 1 : 0);
  function loaded() { if (--waits <= 0 && d._item === item) { var e = $('#dLoad'); if (e) e.remove(); } }
  setTimeout(function () { var b = (d._toEp && $('#dEps .ep.current')) || $('#dPlay'); if (b) focusEl(b); }, 30);
  function art(r) {
    var bg = $('#dBg'); if (!bg || d._item !== item) return;
    // a wide picture fills the area; a vertical cover is shown whole, never stretched
    var wide = (r && r.backdrop) || item.backdrop, src = wide ? thumb(wide, 1280) : item.logo || (r && r.poster);
    bg.classList.toggle('tall', !wide);
    if (src && bg.getAttribute('src') !== src) bg.src = src;
  }
  d._art = art;
  art(cachedRating(item));
  getRatings(item).then(function (r) {
    if (!r || d._item !== item) return;
    var h2 = '';
    if (r.imdb) h2 += '<span class="pill imdb">IMDb ' + r.imdb.toFixed(1) + '</span>';
    if (r.tmdb) h2 += '<span class="pill tmdb">TMDB ' + r.tmdb.toFixed(1) + '</span>';
    if (listRate(r, item)) h2 += '<span class="pill">Lista ' + (+item.rating).toFixed(1) + '</span>';
    $('#dRatings').innerHTML = h2 + (r.tmdbId && !r.imdb && !r.tmdb ? '<span class="pill">Poucos Votos</span>' : '');
    if (r.overview && !$('#dPlot').textContent) $('#dPlot').textContent = r.overview;
    art(r);
  }).then(loaded, loaded);
  if (item.kind === 'movie' && S.cfg.type === 'xtream') {
    getJSON(xurl('get_vod_info', '&vod_id=' + item.id)).then(function (v) {
      var inf = (v && v.info) || {};
      if (d._item !== item) return;
      if (inf.plot) setText('#dPlot', inf.plot);
      if (inf.backdrop_path && inf.backdrop_path[0]) { item.backdrop = inf.backdrop_path[0]; art(cachedRating(item)); }
      setText('#dMeta', ['FILME', inf.releasedate || item.year, inf.duration, inf.genre].filter(Boolean).join(' · '));
    }).catch(function () {}).then(loaded);
  }
  if (item.kind === 'series') loadEpisodes(item, loaded);
}
function epTitle(t, n) { var m = String(t).match(/S\d+\s*E\d+\s*(?:[-–:]\s*(.+))?$/i); return m ? (m[1] || 'Episódio ' + n) : t; }
function fetchEps(item) {
  if (item._eps) return Promise.resolve(item._eps);
  var p = item.episodes ? Promise.resolve(item.episodes) : getJSON(xurl('get_series_info', '&series_id=' + item.id)).then(function (r) {
    var eps = [];
    if (r && r.info && r.info.plot) item.plot = item.plot || r.info.plot;
    if (r && r.info && r.info.backdrop_path && r.info.backdrop_path[0]) item.backdrop = r.info.backdrop_path[0];
    Object.keys((r && r.episodes) || {}).forEach(function (s) {
      (r.episodes[s] || []).forEach(function (e) {
        eps.push({ id: e.id, title: epTitle(e.title, +e.episode_num), season: +s, num: +e.episode_num, plot: e.info && e.info.plot, img: e.info && e.info.movie_image,
          url: xbase() + '/series/' + S.cfg.user + '/' + S.cfg.pass + '/' + e.id + '.' + (e.container_extension || 'mp4') });
      });
    });
    return eps;
  });
  return p.then(function (eps) { item._eps = eps.slice().sort(function (a, b) { return a.season - b.season || a.num - b.num; }); return item._eps; });
}
function loadEpisodes(item, loaded) {
  var d = $('#detail'), key = item.kind + ':' + item.id;
  fetchEps(item).then(function (eps) {
    if (d._item !== item) return;
    if (!$('#dPlot').textContent && item.plot) $('#dPlot').textContent = item.plot;
    d._art(cachedRating(item));
    if (!eps.length) { $('#dEps').innerHTML = '<div class="empty">Sem Episódios.</div>'; return; }
    d._eps = eps;
    var seasons = []; eps.forEach(function (e) { if (seasons.indexOf(e.season) < 0) seasons.push(e.season); });
    setText('#dMeta', ['SÉRIE', item.year, seasons.length + (seasons.length > 1 ? ' TEMPORADAS' : ' TEMPORADA')].filter(Boolean).join(' · '));
    function done(s) { var l = eps.filter(function (e) { return e.season === s; }); return l.every(function (e) { var p = S.pos['ep:' + e.id]; return p && p.seen; }); }
    $('#dSeasons').innerHTML = seasons.map(function (s) { return '<button class="f season" role="tab" data-s="' + s + '">Temporada ' + s + (done(s) ? ' ✓' : '') + '</button>'; }).join('');
    var h = histFor(key), cur = h && h.ep ? h.ep.season : seasons[0];
    if (seasons.indexOf(cur) < 0) cur = seasons[0];
    if (h && h.ep) $('#dPlay').textContent = '▶ Continuar T' + h.ep.season + ' · E' + h.ep.num;
    else $('#dPlay').textContent = '▶ Assistir T' + eps[0].season + ' · E' + eps[0].num;
    showSeason(item, cur);
    var on = d._toEp && $('#dEps .ep.current'); if (on) focusEl(on);
  }).catch(function (e) { var w = $('#dEps'); if (w) w.innerHTML = '<div class="empty">Erro ao Carregar Episódios: ' + esc(e.message) + '</div>'; setText('#dPlay', 'Sem Episódios'); }).then(loaded);
}
function epHTML(e, i, h) {
  var p = S.pos['ep:' + e.id], cur = h && h.ep && String(h.ep.id) === String(e.id), badge = '', bar = '', pct;
  if (p && p.seen) { badge = '<span class="epbadge seen">Visto</span>'; bar = '<span class="epbar"><span style="width:100%"></span></span>'; }
  else if (p && p.d) { pct = p.t / p.d * 100; badge = '<span class="epbadge">' + esc(fmtLeft(p.d - p.t).replace('faltam', 'Faltam')) + '</span>'; bar = '<span class="epbar"><span style="width:' + pct + '%"></span></span>'; }
  return '<button class="f ep' + (cur ? ' current' : '') + '" data-i="' + i + '"><span class="epthumb"><img class="lz" alt="" decoding="async" data-ep="' + esc(e.id) + '"' + (e.img ? ' data-src="' + esc(thumb(e.img, 500)) + '"' : '') + '>' + bar + badge + '</span><span class="eptitle">E' + e.num + ' · ' + esc(e.title) + '</span></button>';
}
function showSeason(item, s) {
  var d = $('#detail'), h = histFor(item.kind + ':' + item.id), html = '';
  $$('.season').forEach(function (b) { var on = +b.getAttribute('data-s') === s; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
  d._eps.forEach(function (e, i) { if (e.season === s) html += epHTML(e, i, h); });
  paint($('#dEps'), html); $('#dEps').scrollTop = 0;
  loadStills(item, s);
}
/* episode thumbnails come from TMDB and stay in memory for the session */
function loadStills(item, s) {
  var ck = item.id + '|' + s;
  function apply(map) { $$('#dEps img[data-ep]').forEach(function (img) { var e = $('#detail')._eps[+img.parentNode.parentNode.getAttribute('data-i')]; if (e && map[e.num] && !e.img) img.src = map[e.num]; }); }
  if (S.stills[ck]) return apply(S.stills[ck]);
  if (!S.cfg.tmdbKey) return;
  getRatings(item).then(function (r) {
    if (!r || !r.tmdbId) return null;
    return tmdbFetch('/tv/' + r.tmdbId + '/season/' + s).then(function (x) {
      var map = {}; (x.episodes || []).forEach(function (e) { if (e.still_path) map[e.episode_number] = 'https://image.tmdb.org/t/p/w500' + e.still_path; });
      S.stills[ck] = map; if ($('#detail')._item === item) apply(map);
    });
  }).catch(function () {});
}
/* password pad: works with the pointer, the arrows or the remote's number keys */
function askPin(title, done, free) {
  var p = $('#pick'), keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'del', '0', 'x'];
  if (!free && document.activeElement && document.activeElement !== document.body && !lastFocus) lastFocus = document.activeElement;
  p._game = null; p._ask = null; p._pin = { v: '', done: done, free: !!free };
  p.innerHTML = '<div class="pickbox pinbox"><h2>' + esc(title) + '</h2><p class="muted" id="pinMsg">Digite a Senha de 4 Números</p><div class="pindots" id="pinDots"></div><div class="pinpad">' + keys.map(function (k) {
    return k === 'x' ? '<button class="f pinkey" data-k="x">Cancelar</button>' : '<button class="f pinkey" data-k="' + k + '">' + (k === 'del' ? 'Apagar' : k) + '</button>';
  }).join('') + '</div></div>';
  p.classList.remove('hidden'); pinDots(); $('.pinkey', p).focus();
}
function pinOpen() { return pickOpen() && !!$('#pinDots'); }
function pinDots() { var v = $('#pick')._pin.v, h = ''; for (var i = 0; i < 4; i++) h += '<i class="' + (i < v.length ? 'on' : '') + '"></i>'; $('#pinDots').innerHTML = h; }
function pinPress(k) {
  var p = $('#pick'), st = p._pin;
  if (k === 'x') { closePick(); return; }
  if (k === 'del') st.v = st.v.slice(0, -1); else if (st.v.length < 4) st.v += k;
  pinDots();
  if (st.v.length < 4) return;
  if (st.free || st.v === S.cfg.pin) { var v = st.v; closePick(); st.done(v); return; }
  st.v = ''; pinDots(); setText('#pinMsg', 'Senha Incorreta. Tente de Novo.');
}
function toggleAdultLock(btn) {
  lastFocus = btn;
  askPin(S.cfg.adultLock ? 'Desligar o Bloqueio' : 'Ligar o Bloqueio', function () {
    S.cfg.adultLock = !S.cfg.adultLock; save('cfg', S.cfg);
    btn.textContent = 'Bloqueio com Senha: ' + (S.cfg.adultLock ? 'ligado' : 'desligado');
    toast('Bloqueio ' + (S.cfg.adultLock ? 'ligado' : 'desligado'));
  });
}
function changePin(btn) {
  lastFocus = btn;
  askPin('Senha Atual', function () {
    askPin('Nova Senha', function (a) {
      askPin('Repita a Nova Senha', function (b) {
        if (a !== b) { toast('As Senhas Não São Iguais. Nada Mudou.', 3500); return; }
        S.cfg.pin = a; save('cfg', S.cfg); toast('Senha Trocada');
      }, true);
    }, true);
  });
}
/* wiping the history asks first: there is no undo */
function askClearSeen() {
  var p = $('#pick'); lastFocus = document.activeElement; p._game = null; p._ask = null;
  p.innerHTML = '<div class="pickbox"><h2>Limpar Assistidos</h2><p class="muted">Apaga Continuar Assistindo e o Progresso. Sua Lista, Favoritos e Assistir Depois Continuam. Não Dá para Desfazer.</p>' +
    '<div class="picklist">' + [['0', 'Cancelar'], ['movie', 'Filmes'], ['series', 'Séries'], ['all', 'Ambos']].map(function (o) { return '<button class="f pick resume" data-clear="' + o[0] + '"><span class="pickname">' + o[1] + '</span></button>'; }).join('') + '</div></div>';
  p.classList.remove('hidden'); $('.pick', p).focus();
}
function clearSeen(what) {
  var movies = what !== 'series', series = what !== 'movie';
  function gone(k) { return /^movie:/.test(k) ? movies : /^(series|ep):/.test(k) ? series : false; }
  S.hist = S.hist.filter(function (h) { return !gone(h.key); });
  Object.keys(S.pos).forEach(function (k) { if (gone(k)) delete S.pos[k]; });
  save('hist', S.hist); save('pos', S.pos);
  closePick(); toast(what === 'movie' ? 'Filmes Assistidos Apagados' : what === 'series' ? 'Séries Assistidas Apagadas' : 'Assistidos Apagados');
}
/* an unfinished title asks before playing; the Continuar buttons have already answered */
function askResume(item, opts) {
  var p = $('#pick'), key = opts.ep ? 'ep:' + opts.ep.id : item.kind + ':' + item.id, s = S.pos[key];
  if (!s || s.seen || !s.d || s.t <= 60 || s.t >= s.d - 120) { play(item, opts); return; }
  p._ask = { item: item, opts: opts }; p._game = null;
  p.innerHTML = '<div class="pickbox"><h2>' + esc(opts.ep ? 'T' + opts.ep.season + ' · E' + opts.ep.num + ' · ' + opts.ep.title : item.name) + '</h2><p class="muted">Você Parou em ' + fmtTime(s.t) + ' de ' + fmtTime(s.d) + '</p>' +
    '<div class="picklist"><button class="f pick resume" data-r="1"><span class="pickname">Continuar de ' + fmtTime(s.t) + '</span></button><button class="f pick resume" data-r="0"><span class="pickname">Começar do Início</span></button></div></div>';
  p.classList.remove('hidden'); $('.pick', p).focus();
}
// inside the detail lastFocus follows its own buttons: the way back is the poster that opened it
function closeDetail() {
  var d = $('#detail'), f = d._from; d.classList.add('hidden'); d.innerHTML = ''; d._item = null; d._eps = null;
  if (f && document.body.contains(f)) { lastFocus = f; f.focus({ preventScroll: true }); } else focusContent();
}
function refreshDetail() { var d = $('#detail'); if (d._item && d._eps) { var cur = $('.season.on'); if (cur) showSeason(d._item, +cur.getAttribute('data-s')); } }

/* ================= Adicionar lista pelo celular =================
 * No Android, o servidor HTTP (NanoHTTPD, porta 8080) roda dentro do app. O QR Code aponta para ele;
 * quando o celular envia o formulário, o Android chama window.sintoniaReceberLista(nome, url). */
function openRemote() {
  var r = $('#remote');
  r.innerHTML = '<div class="rleft"><h1>Adicione Sua Lista pelo Celular</h1><ol><li><span>1</span>Aponte a Câmera do Celular para o Código</li><li><span>2</span>Cole o Link M3U ou o Login que o Provedor Mandou</li><li><span>3</span>Toque em Enviar. A TV Carrega Sozinha.</li></ol>' +
    '<p class="muted">O Celular Precisa Estar no Mesmo Wi-Fi da TV.</p><p class="muted" id="rUrl"></p></div>' +
    '<div class="rright"><div id="qr" class="qr"></div><div class="rwait"><i></i><span id="rState">Ligando</span></div></div>';
  r.classList.remove('hidden');
  if (!NATIVO) { setText('#rState', 'Só Funciona na TV'); return; }
  var ponte = window.SintoniaBridge, ip = ponte.obterIpLocal();
  if (!ip) { setText('#rState', 'A TV Está Sem Rede. Conecte ao Wi-Fi.'); return; }
  if (!ponte.servidorAtivo()) { setText('#rState', 'Não Consegui Ligar o Servidor (porta ' + ponte.obterPortaServidor() + ')'); return; }
  // o token do QR Code vale só enquanto esta tela está aberta: quem não leu o QR Code não consegue enviar listas
  showQR('http://' + ip + ':' + ponte.obterPortaServidor() + '/?t=' + ponte.obterTokenPareamento());
}
function showQR(url) {
  var q = qrcode(0, 'M'), n, x, y, d = '', cell = 8; q.addData(url); q.make(); n = q.getModuleCount();
  for (y = 0; y < n; y++) for (x = 0; x < n; x++) if (q.isDark(y, x)) d += 'M' + (x + 4) * cell + ' ' + (y + 4) * cell + 'h' + cell + 'v' + cell + 'h-' + cell + 'z';
  var size = (n + 8) * cell;
  $('#qr').innerHTML = '<svg viewBox="0 0 ' + size + ' ' + size + '" role="img" aria-label="QR Code"><path fill="#000" d="' + d + '"/></svg>';
  setText('#rUrl', 'Ou Abra no Navegador: ' + url); setText('#rState', 'Aguardando o Celular');
}
function receiveList(l) {
  var d = newDraft();
  if (l.link) { var p = parseLink(l.link); if (!p) { toast('Link Inválido'); return; } Object.assign(d, p); }
  else if (l.server) { d.server = /^https?:\/\//i.test(l.server) ? l.server : 'http://' + l.server; d.user = l.user || ''; d.pass = l.pass || ''; }
  else return;
  // the same list sent again edits the saved one instead of repeating it
  var had = S.lists.filter(function (x) { return x.type === d.type && (d.type === 'm3u' ? x.m3u === d.m3u : x.server === d.server && x.user === d.user); })[0];
  if (had) { d.id = had.id; d.name = had.name; }
  closeRemote();
  var nome = String(l.nome || '').trim();
  if (!nome) { openDraft(d); toast('Lista Recebida. Dê um Nome a Ela.', 5000); return; }
  // named on the phone: nothing left to type on the TV
  d.name = nome; if (!d.id) { d.id = 'l' + Date.now(); S.lists.push(d); } else Object.assign(had, d);
  save('lists', S.lists); activateList(d.id);
}
/* Chamado pelo Android quando o celular envia o formulário (nome e URL da lista).
 * receiveList valida o link, grava a lista no LocalStorage (save 'lists') e a ativa. */
window.sintoniaReceberLista = function (nome, url) {
  console.log('Sintonia: lista recebida do celular: "' + nome + '"'); // a URL fica fora do log: pode ter usuário e senha
  receiveList({ nome: nome, link: url });
};
function closeRemote() {
  if (NATIVO) { try { window.SintoniaBridge.encerrarPareamento(); } catch (e) {} } // o servidor volta a recusar envios
  $('#remote').classList.add('hidden'); $('#remote').innerHTML = '';
  var b = $('#openRemote'); if (b) b.focus();
}

/* ================= refresh: drop everything the app holds and load the list again ================= */
function refreshApp() {
  var live = playerShown() && P.item && P.item.kind === 'live';
  setBusy('Atualizando: Limpando o Cache e Recarregando a Lista');
  try { sessionStorage.setItem('atl.after', JSON.stringify({ view: S.view || 'home', spot: S.spot, cat: groupAdult(S.view, S.cat[S.view]) ? null : S.cat[S.view], play: live && !P.item.adult ? P.item.kind + ':' + P.item.id : null, tv: !!P.tv, full: playerOpen() })); } catch (e) {}
  if (playerShown()) saveProgress();
  teardown();
  var wipe = window.caches ? caches.keys().then(function (k) { return Promise.all(k.map(function (n) { return caches.delete(n); })); }) : Promise.resolve();
  wipe.catch(function () {}).then(function () { location.reload(); });
}

/* ================= player ================= */

/* ---- Vídeo nativo no Android ----
 * No Fire TV o vídeo é decodificado pelo ExoPlayer (Media3), que desenha atrás do WebView.
 * `criarVideoNativo` devolve um objeto com a mesma interface do <video> que o resto do app usa
 * (play, pause, currentTime, duration, eventos...), mas que controla o ExoPlayer pelo SintoniaBridge.
 * Os estados chegam do Android em window.sintoniaStatusVideo(status, detalhe). */
var NATIVO = !!(window.SintoniaBridge && window.SintoniaBridge.reproduzir);

function criarVideoNativo() {
  var ponte = window.SintoniaBridge, ouvintes = {}, src = '', querTocar = false, metaEnviada = false, ultimaPos = -1;
  function emitir(nome) {
    (ouvintes[nome] || []).slice().forEach(function (fn) {
      try { fn.call(v, { type: nome, target: v }); } catch (e) { console.log('Sintonia: erro no evento "' + nome + '": ' + e); }
    });
  }
  var v = {
    nativo: true,
    textTracks: [],      // legendas embutidas ainda não são repassadas pelo ExoPlayer
    audioTracks: undefined,
    addEventListener: function (nome, fn) { (ouvintes[nome] = ouvintes[nome] || []).push(fn); },
    canPlayType: function () { return 'probably'; }, // o ExoPlayer toca HLS nativamente
    getAttribute: function (nome) { return nome === 'src' ? src : null; },
    removeAttribute: function (nome) { if (nome === 'src') v.parar(); },
    load: function () {},
    play: function () { querTocar = true; if (src) ponte.retomar(); return Promise.resolve(); },
    pause: function () { querTocar = false; if (src) ponte.pausar(); },
    /* Para o ExoPlayer e esquece o conteúdo atual. */
    parar: function () { src = ''; querTocar = false; metaEnviada = false; ultimaPos = -1; ponte.parar(); },
    /* Recebe o status enviado pelo Android: BUFFERING, PLAYING, PAUSED, ENDED ou ERROR. */
    aoStatus: function (status) {
      if (!src) return; // evento atrasado de um vídeo que já foi encerrado
      if (status === 'BUFFERING') { emitir('waiting'); return; }
      if (status === 'PLAYING' || status === 'PAUSED') {
        if (!metaEnviada) { metaEnviada = true; emitir('loadedmetadata'); }
        if (status === 'PLAYING') { querTocar = true; emitir('play'); emitir('playing'); }
        else { querTocar = false; emitir('pause'); }
        return;
      }
      if (status === 'ENDED') { querTocar = false; emitir('ended'); return; }
      if (status === 'ERROR') { querTocar = false; emitir('error'); }
    }
  };
  Object.defineProperty(v, 'src', {
    get: function () { return src; },
    set: function (url) {
      src = String(url || ''); querTocar = !!src; metaEnviada = false; ultimaPos = -1;
      if (src) ponte.reproduzir(src); else ponte.parar();
    }
  });
  Object.defineProperty(v, 'paused', { get: function () { return !(src && querTocar); } });
  Object.defineProperty(v, 'videoWidth', { get: function () { return src ? ponte.obterLarguraVideo() : 0; } });
  Object.defineProperty(v, 'currentTime', {
    get: function () { return src ? ponte.obterPosicaoAtual() / 1000 : 0; },
    set: function (s) { if (src && isFinite(s)) ponte.buscar(Math.round(Math.max(0, s) * 1000)); }
  });
  Object.defineProperty(v, 'duration', {
    get: function () {
      if (!src) return NaN;
      var ms = ponte.obterDuracaoTotal();
      if (ms > 0) return ms / 1000;
      return metaEnviada ? Infinity : NaN; // Infinity = ao vivo; NaN = ainda não se sabe
    }
  });
  // O ExoPlayer não envia "timeupdate": a posição é consultada a cada 250 ms enquanto toca.
  setInterval(function () {
    if (!src || !querTocar || !metaEnviada) return;
    var pos = ponte.obterPosicaoAtual();
    if (pos !== ultimaPos) { ultimaPos = pos; emitir('timeupdate'); }
  }, 250);
  return v;
}

/* Chamado pelo Android a cada mudança de estado do player. */
window.sintoniaStatusVideo = function (status, detalhe) {
  console.log('Sintonia: status do vídeo = ' + status + (detalhe ? ' (' + detalhe + ')' : ''));
  if (NATIVO) video.aoStatus(status, detalhe);
};

/* O vídeo nativo fica atrás do WebView: a interface precisa deixar um "buraco" transparente
 * onde ele deve aparecer. Em tela cheia o app por baixo é escondido; na janela pequena (mini)
 * da tela Ao Vivo o ExoPlayer é posicionado exatamente sobre o retângulo dela. */
var areaVideoAtual = '';
function sincronizarAreaVideo() {
  if (!NATIVO) return;
  var p = $('#player'), oculto = p.classList.contains('hidden'), mini = p.classList.contains('mini');
  document.documentElement.classList.toggle('video-cheio', !oculto && !mini);
  var a = [0, 0, 1, 1];
  if (!oculto && mini) {
    var r = p.getBoundingClientRect(); // a página tem tamanho fixo de 1920x1080
    a = [r.left / 1920, r.top / 1080, r.width / 1920, r.height / 1080];
  }
  var chave = a.join(',');
  if (chave === areaVideoAtual) return;
  areaVideoAtual = chave;
  window.SintoniaBridge.definirAreaVideo(a[0], a[1], a[2], a[3]);
}
if (NATIVO) {
  document.documentElement.classList.add('android');
  new MutationObserver(sincronizarAreaVideo).observe($('#player'), { attributes: true, attributeFilter: ['class'] });
  sincronizarAreaVideo();
}

var video = NATIVO ? criarVideoNativo() : $('#video'), hls = null, P = { item: null, list: null, index: 0, subs: null, subIdx: -1, subOffset: 0, posKey: null, plan: [], cur: null };
var osdT;
function showOSD(stay) {
  var p = $('#player'); p.classList.add('osd-on'); paintTime();
  if (!p.contains(document.activeElement) || document.activeElement === document.body) { var b = $('.pbtn[data-act="play"]'); b.focus(); }
  clearTimeout(osdT); if (!stay) osdT = setTimeout(hideOSD, 5000);
}
function hideOSD() { if (!$('#menu').classList.contains('hidden')) return; $('#player').classList.remove('osd-on'); document.activeElement && document.activeElement.blur(); }
function spinner(on) { $('#spinner').classList.toggle('hidden', !on); }
function nativeHls() { return !!video.canPlayType('application/vnd.apple.mpegurl'); }
function isHlsUrl(u) { return /\.m3u8(\?|$)|output=hls|\/hls(\?|$)/i.test(u); }

/* a fresh <video> for each playback: releases the TV's decoder and whatever the last stream buffered */
function destroyHls() { if (hls) { try { hls.destroy(); } catch (e) {} hls = null; } }
function teardown() {
  destroyHls(); clearTimeout(P.wd); scrubCancel();
  if (NATIVO) { video.parar(); return; } // o ExoPlayer é reaproveitado: basta parar
  try { video.pause(); video.removeAttribute('src'); video.load(); } catch (e) {}
  var v = document.createElement('video'); v.id = 'video'; v.setAttribute('playsinline', '');
  video.parentNode.replaceChild(v, video); video = v; bindVideo(v);
}
function planFor(url, label) {
  var out = [];
  if (isHlsUrl(url)) {
    if (nativeHls()) out.push({ url: url, mode: 'native', label: label });
    if (!NATIVO && window.Hls && Hls.isSupported()) out.push({ url: url, mode: 'hls', label: label }); // no Android o ExoPlayer já toca HLS
    out.push({ url: url.replace(/\.m3u8/, '.ts'), mode: 'native', label: label });
  } else out.push({ url: url, mode: 'native', label: label });
  return out;
}
function play(item, opts) {
  opts = opts || {};
  teardown();
  P.item = item; P.list = opts.list || null; P.index = opts.index || 0; P.ep = opts.ep || null;
  P.tv = !!(opts.mini || opts.tv);
  $('#player').classList.toggle('mini', !!opts.mini);
  P.posKey = item.kind === 'live' || item.adult ? null : (P.ep ? 'ep:' + P.ep.id : item.kind + ':' + item.id);
  P.seek = null; P.resumed = !!opts.fromStart; P.subIdx = -1; P.cur = null; P.mediaRetry = 0; P.markStart = null; P.introDone = false; P.nextCancel = false; P.nextHold = false; P.cardAt = null; P.autoSubDone = false;
  clearExtSubs(); hideCard(); $('#skipIntro').classList.add('hidden');
  restoreSub();
  var vs = item.kind === 'live' && item.variants ? item.variants : null;
  P.plan = [];
  if (vs) vs.forEach(function (v) { P.plan = P.plan.concat(planFor(v.url, v.q ? v.q.label : '')); });
  else P.plan = planFor(P.ep ? P.ep.url : item.url, '');
  setText('#osdTitle', P.ep ? item.name + ' · T' + P.ep.season + ' · E' + P.ep.num : item.name);
  setText('#osdNow', item.kind === 'live' ? (item.catName || '') : (P.ep ? P.ep.title : ''));
  $('#tDur').textContent = ''; $('#tCur').textContent = ''; $('#barFill').style.width = '0';
  $('#player').classList.remove('hidden'); $('#menu').classList.add('hidden');
  setButtons();
  spinner(true); if (!opts.quiet && !opts.mini) showOSD();
  nextAttempt();
  if (item.kind === 'live') loadEPG(item);
}
function nextAttempt() {
  var a = P.plan.shift();
  clearTimeout(P.wd);
  if (!a) { spinner(false); toast('Não Foi Possível Reproduzir Este Conteúdo', 4000); return; }
  if (P.cur && P.cur.label !== a.label && a.label) toast(P.cur.label + ' Falhou, Abrindo ' + a.label, 3500);
  P.cur = a;
  P.wd = setTimeout(nextAttempt, 15000);
  startStream(a);
}
function startStream(a) {
  destroyHls();
  video.removeAttribute('src'); video.load();
  if (a.mode === 'hls') {
    hls = new Hls({ enableWorker: true, lowLatencyMode: false, maxBufferLength: 30, renderTextTracksNatively: true });
    hls.on(Hls.Events.MANIFEST_PARSED, function () { video.play().catch(function () {}); });
    hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, function () { autoAudio(); setButtons(); });
    hls.on(Hls.Events.ERROR, function (ev, data) {
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR && P.mediaRetry++ < 1) { hls.recoverMediaError(); return; }
      destroyHls(); nextAttempt();
    });
    hls.loadSource(a.url); hls.attachMedia(video);
  } else { video.src = a.url; video.play().catch(function () {}); }
}
/* the TV's own decoder comes first; hls.js only steps in to switch audio or subtitles */
function canUpgrade() { return !NATIVO && P.cur && P.cur.mode === 'native' && isHlsUrl(P.cur.url) && !hls && window.Hls && Hls.isSupported(); }
function upgradeToHls(then) {
  P.seek = isFinite(video.duration) ? video.currentTime : null; P.resumed = false;
  P.cur = { url: P.cur.url, mode: 'hls', label: P.cur.label };
  spinner(true); startStream(P.cur);
  closeMenu(); toast('Procurando Faixas');
  if (then) setTimeout(then, 2500);
}

function bindVideo(v) {
  v.addEventListener('playing', function () {
    spinner(false); clearTimeout(P.wd); autoAudio();
    // H.265 the TV can't decode may play sound with no picture: try the next version
    if (P.item && P.item.kind === 'live' && v.videoWidth === 0 && P.plan.length) setTimeout(function () { if (v === video && v.videoWidth === 0) nextAttempt(); }, 2000);
  });
  v.addEventListener('play', paintPlay); v.addEventListener('pause', paintPlay);
  v.addEventListener('waiting', function () { spinner(true); });
  v.addEventListener('loadedmetadata', function () {
    autoAudio(); hookTextTracks(); setButtons(); autoTitleSub();
    if (P.resumed) return; P.resumed = true;
    var saved = P.posKey && S.pos[P.posKey];
    if (P.seek != null) v.currentTime = P.seek;
    else if (saved && saved.t > 60 && saved.t < v.duration - 120) { v.currentTime = saved.t; toast('Continuando de ' + fmtTime(saved.t)); }
  });
  v.addEventListener('error', function () { if (v !== video || hls || !v.getAttribute('src')) return; nextAttempt(); });
  v.addEventListener('ended', function () { if (P.ep && nextEp() && !P.nextCancel) goNext(); else { finish(); closePlayer(); } });
  v.addEventListener('timeupdate', onTime);
}
var lastPosSave = 0;
function paintTime() {
  var d = video.duration, t = video.currentTime;
  $('#tCur').textContent = fmtTime(t);
  if (isFinite(d) && d > 0) { $('#tDur').textContent = fmtTime(d); $('#barFill').style.width = (t / d * 100) + '%'; }
  else { $('#tDur').textContent = 'AO VIVO'; $('#barFill').style.width = '100%'; }
}
function onTime() {
  var d = video.duration, t = video.currentTime, vod = P.posKey && isFinite(d) && d > 0;
  if ($('#player').classList.contains('osd-on')) paintTime();
  if (vod && Date.now() - lastPosSave > 10000) { lastPosSave = Date.now(); saveProgress(); }
  renderExtSub(t);
  if (P.ep && vod) { tickIntro(t); tickNext(t, d); }
}
function saveProgress() {
  var d = video.duration, t = video.currentTime;
  if (!P.posKey || !isFinite(d) || t < 5) return;
  if (t > d * 0.95) { finish(); return; }
  savePos(P.posKey, { t: t, d: d, at: Date.now() });
  updateHist(P.item, P.ep, t, d);
}
/* the title is done: series move on to the next episode in the history, movies leave it */
function finish() {
  if (!P.posKey) return;
  var key = P.item.kind + ':' + P.item.id, n = nextEp();
  if (P.ep) savePos(P.posKey, { t: 0, d: video.duration || 0, at: Date.now(), seen: 1 }); else { delete S.pos[P.posKey]; save('pos', S.pos); }
  if (n) updateHist(P.item, n, 0, 0); else dropHist(key);
}
/* the series page may not be open behind the player (Continuar on Início starts the episode straight away):
 * open it then, on the episode that was playing, instead of falling back to Início */
function playerEpisodes() {
  if (!$('#detail').classList.contains('hidden')) { closePlayer(); return; }
  var item = P.item; closePlayer(); openDetail(item, true);
}
function closePlayer() {
  saveProgress();
  teardown(); clearExtSubs(); hideCard();
  $('#player').classList.add('hidden'); $('#player').classList.remove('osd-on'); $('#menu').classList.add('hidden'); $('#notice').classList.add('hidden'); $('#skipIntro').classList.add('hidden');
  if (!$('#detail').classList.contains('hidden')) {
    var at = lastFocus && lastFocus.getAttribute && lastFocus.getAttribute('data-i');
    refreshDetail();
    var again = at != null && $('.ep[data-i="' + at + '"]');
    if (again) lastFocus = again; else if (!document.body.contains(lastFocus)) lastFocus = $('#dPlay');
  } else if (S.view === 'home') { go('home'); var h = $('[data-hist], [data-go]', $('#content')); if (h) h.focus(); return; }
  if (lastFocus && document.body.contains(lastFocus)) lastFocus.focus({ preventScroll: true }); else if (S.view === 'home') focusNav(); else focusContent();
  pumpArt();
}
function zap(dir) {
  if (!P.list || P.item.kind !== 'live') return;
  var i = (P.index + dir + P.list.length) % P.list.length;
  play(P.list[i], { list: P.list, index: i, tv: P.tv });
}
function epgEmpty(msg) { var e = $('#epgList'); if (e) e.innerHTML = '<p class="muted">' + msg + '</p>'; }
function epgFor(item, limit) {
  if (S.cfg.type !== 'xtream') return Promise.resolve([]);
  var vs = (item.variants || [item]).filter(function (v) { return v.epg; }), now = Date.now() / 1000;
  vs = (vs.length ? vs : [item]).slice(0, 3);
  function tryAt(i) {
    if (i >= vs.length) return Promise.resolve([]);
    return getJSON(xurl('get_short_epg', '&stream_id=' + vs[i].id + '&limit=12')).then(function (r) {
      var l = ((r && r.epg_listings) || []).filter(function (x) { return +x.stop_timestamp > now; }).sort(function (a, b) { return a.start_timestamp - b.start_timestamp; });
      return l.length ? l.slice(0, limit) : tryAt(i + 1);
    }, function () { return tryAt(i + 1); });
  }
  return tryAt(0);
}
function loadEPG(item) {
  epgEmpty('Carregando Programação');
  if (S.cfg.type !== 'xtream') { epgEmpty('Esta Lista Não Traz Programação.'); return; }
  epgFor(item, 6).then(function (l) {
    if (P.item !== item) return;
    if (!l.length) { epgEmpty('A Lista Não Traz Programação Deste Canal.'); return; }
    var now = l[0], next = l[1];
    var hm = function (s) { var dt = new Date((+s) * 1000); return ('0' + dt.getHours()).slice(-2) + ':' + ('0' + dt.getMinutes()).slice(-2); };
    $('#osdNow').textContent = 'Agora: ' + b64(now.title) + ' (' + hm(now.start_timestamp) + '–' + hm(now.stop_timestamp) + ')' + (next ? '   ·   Depois: ' + b64(next.title) : '');
    var e = $('#epgList');
    if (e) e.innerHTML = l.map(function (x, i) { return '<div class="epgrow' + (i ? '' : ' now') + '"><span>' + hm(x.start_timestamp) + '</span><b>' + esc(b64(x.title)) + '</b>' + (i ? '' : '<i>AGORA</i>') + '</div>'; }).join('');
  }).catch(function () { if (P.item === item) epgEmpty('Não Consegui Carregar a Programação.'); });
}

/* ---- next episode card + new season notice ---- */
function nextEp() { return P.ep && P.list && P.list[P.index + 1] || null; }
function hideCard() { $('#nextCard').classList.add('hidden'); P.cardAt = null; }
function cardOpen() { return !$('#nextCard').classList.contains('hidden'); }
function tickNext(t, d) {
  var n = nextEp();
  if (!n || d < 45) return;
  if (d - t > 41) { if (P.cardAt != null) hideCard(); P.nextCancel = false; P.nextHold = false; return; }
  if (P.nextCancel) return;
  if (P.cardAt == null) {
    P.cardAt = t;
    var map = S.stills[P.item.id + '|' + n.season], th = $('#nextThumb');
    if (map && map[n.num]) th.src = map[n.num]; else th.removeAttribute('src');
    setText('#nextTitle', 'T' + n.season + ' · E' + n.num + ' · ' + n.title);
    $('#nextCard').classList.remove('hidden');
  }
  if (P.nextHold) return; // the viewer touched the remote: only OK or the episode's end moves on
  var left = Math.ceil(10 - (t - P.cardAt));
  if (left <= 0) { goNext(); return; }
  setText('#nextCount', 'Próximo Episódio em ' + left + ' s');
}
function cancelNext() { P.nextCancel = true; hideCard(); }
function goNext() {
  var n = nextEp(); if (!n) return;
  var newSeason = n.season !== P.ep.season;
  finish();
  play(P.item, { ep: n, list: P.list, index: P.index + 1, quiet: true });
  if (newSeason) seasonNotice(n);
}
var noticeT;
function seasonNotice(ep) {
  setText('#noticeText', 'Temporada ' + ep.season + ' · Episódio ' + ep.num);
  $('#notice').classList.remove('hidden');
  clearTimeout(noticeT); noticeT = setTimeout(function () { $('#notice').classList.add('hidden'); }, 3000);
}

/* ---- skip intro: marked by hand once per series, then offered inside a time window ---- */
function introKey() { return P.item.kind + ':' + P.item.id; }
function markIntro() {
  if (!P.ep) return;
  var t = video.currentTime;
  if (P.markStart == null) { P.markStart = t; toast('Início Marcado em ' + fmtTime(t) + '. Aperte o amarelo no fim da abertura.', 4000); return; }
  if (t < P.markStart + 5) { toast('O Fim Precisa Vir Depois do Início'); return; }
  S.intro[introKey()] = { s: P.markStart, e: t }; save('intro', S.intro);
  toast('Abertura Salva para Esta Série'); P.markStart = null; setButtons();
}
function tickIntro(t) {
  var m = S.intro[introKey()], show = m && !P.introDone && t >= m.s - 20 && t <= m.e + 40;
  $('#skipIntro').classList.toggle('hidden', !show);
}
function skipOpen() { return !$('#skipIntro').classList.contains('hidden'); }
function skipIntro() {
  var m = S.intro[introKey()], t = video.currentTime;
  if (!m) return;
  // openings drift between episodes: past the marked end, this one started later
  video.currentTime = t < m.e - 5 ? m.e : t + (m.e - m.s);
  P.introDone = true; $('#skipIntro').classList.add('hidden');
  if (document.activeElement === $('#skipIntro')) showOSD();
}
function setButtons() {
  var live = P.item && P.item.kind === 'live';
  $$('.pbtn[data-for="vod"]').forEach(function (b) { b.classList.toggle('hidden', live); });
  $('#seekBar').classList.toggle('f', !live); // live has no position to move to: the arrows skip the bar
  paintPlay();
}
function paintPlay() {
  var b = $('.pbtn[data-act="play"]'), name = video.paused ? 'Continuar' : 'Pausar';
  b.setAttribute('aria-label', name); b.title = name;
  b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + (video.paused ? 'M7 5l13 7-13 7z' : 'M6 5h4v14H6zM14 5h4v14h-4z') + '"/></svg>';
}
/* the bar stays short: everything else lives behind the gear */
function gearMenu(at) {
  var key = introKey(), live = P.item.kind === 'live', a = audioList().filter(function (x) { return x.on; })[0];
  function toggle(fn, i) { return function () { fn(key); gearMenu(i); }; }
  var opts = [{ name: 'Áudio: ' + (a ? a.name.split(' — ')[0] : 'Padrão'), fn: audioMenu }, { name: 'Legenda: ' + (P.subIdx === -1 ? 'Desligada' : 'Ligada'), fn: subsMenu }];
  opts.push({ name: isFav(key) ? 'Tirar dos Favoritos' : 'Favorito', fn: toggle(toggleFav, 2) });
  if (!live) opts.push({ name: isLater(key) ? 'Tirar de Assistir Depois' : 'Assistir Depois', fn: toggle(toggleLater, 3) });
  if (P.ep) opts.push({ name: 'Episódios', fn: playerEpisodes });
  if (live) opts.push({ name: 'Atualizar', fn: refreshApp });
  menu('Opções', opts);
  var b = at != null && $('#menu .opt[data-i="' + at + '"]'); if (b) b.focus();
}

/* ---- language labels ---- */
var LANGS = { pt: 'Português', por: 'Português', pob: 'Português (BR)', 'pt-br': 'Português (BR)', ptbr: 'Português (BR)', en: 'Inglês', eng: 'Inglês', es: 'Espanhol', spa: 'Espanhol',
  fr: 'Francês', fre: 'Francês', fra: 'Francês', it: 'Italiano', ita: 'Italiano', de: 'Alemão', ger: 'Alemão', deu: 'Alemão', ja: 'Japonês', jpn: 'Japonês' };
function langName(code, label) {
  var c = String(code || '').toLowerCase(); var n = LANGS[c] || LANGS[c.split('-')[0]];
  if (label && n && norm(label) !== norm(n)) return n + ' — ' + label;
  return n || label || (code ? code.toUpperCase() : 'Faixa');
}
function isLang(code, label, want) {
  var c = norm(code) + ' ' + norm(label);
  if (want === 'pt') return /\b(pt|por|pob|pt-br|portug|dublado|brazil)/.test(c);
  if (want === 'en') return /\b(en|eng|english|ingles)/.test(c);
  return false;
}

/* ---- audio tracks (hls.js or native webOS audioTracks) ---- */
function audioList() {
  if (hls && hls.audioTracks && hls.audioTracks.length) return hls.audioTracks.map(function (t, i) { return { i: i, name: langName(t.lang, t.name), on: hls.audioTrack === i, code: t.lang, label: t.name }; });
  var at = video.audioTracks, out = [];
  if (at) for (var i = 0; i < at.length; i++) out.push({ i: i, name: langName(at[i].language, at[i].label), on: at[i].enabled, code: at[i].language, label: at[i].label });
  return out;
}
function setAudio(i) {
  if (hls && hls.audioTracks && hls.audioTracks.length) { hls.audioTrack = i; return; }
  var at = video.audioTracks; if (!at) return;
  at[i].enabled = true; // the new one first: the TV never stays a moment without any track
  for (var k = 0; k < at.length; k++) if (k !== i) at[k].enabled = false;
}
function autoAudio() {
  var saved = P.posKey && S.trk[introKey()] && S.trk[introKey()].audio, list = audioList(), want = S.cfg.prefAudio, i;
  if (list.length < 2) return;
  // the title's own choice wins; it is matched by language because track order changes between files
  if (saved) for (i = 0; i < list.length; i++) if (String(list[i].code) === saved) { if (!list[i].on) setAudio(list[i].i); return; }
  if (!want) return;
  for (i = 0; i < list.length; i++) if (isLang(list[i].code, list[i].label, want)) { if (!list[i].on) setAudio(list[i].i); return; }
}

/* ---- subtitles: embedded tracks + external (SRT/VTT, OpenSubtitles) all drawn in our own large overlay ---- */
function textTrackList() {
  var out = [], tt = video.textTracks;
  for (var i = 0; i < tt.length; i++) if (/subtitles|captions/.test(tt[i].kind) || !tt[i].kind) out.push({ i: i, t: tt[i], name: langName(tt[i].language, tt[i].label) });
  return out;
}
function hookTextTracks() {
  var tt = video.textTracks;
  for (var i = 0; i < tt.length; i++) {
    if (tt[i]._hooked) continue; tt[i]._hooked = true;
    (function (track) {
      track.addEventListener('cuechange', function () {
        if (P.subIdx === -1 || P.subs || track.mode !== 'hidden') return;
        var c = track.activeCues, txt = [];
        for (var j = 0; c && j < c.length; j++) txt.push(c[j].text);
        $('#subOverlay').innerHTML = txt.map(function (s) { return esc(s.replace(/<[^>]+>/g, '')).replace(/\n/g, '<br>'); }).join('<br>');
      });
    })(tt[i]);
  }
}
function selectEmbeddedSub(i) {
  clearExtSubs(); var tt = video.textTracks;
  if (hls && hls.subtitleTracks && hls.subtitleTracks.length) {
    // hls.js creates matching textTracks; select by index in hls list
    hls.subtitleTrack = i; hls.subtitleDisplay = false;
    setTimeout(hookTextTracks, 300);
  } else {
    for (var k = 0; k < tt.length; k++) tt[k].mode = k === i ? 'hidden' : 'disabled';
    hookTextTracks();
  }
  P.subIdx = i;
}
function subsOff() {
  setTrk('sub', null);
  if (P.posKey && S.subs.last[P.posKey]) { delete S.subs.last[P.posKey]; saveSubs(); }
  clearExtSubs(); P.subIdx = -1;
  if (hls) hls.subtitleTrack = -1;
  var tt = video.textTracks; for (var k = 0; k < tt.length; k++) tt[k].mode = 'disabled';
  $('#subOverlay').innerHTML = '';
}
function clearExtSubs() { P.subs = null; P.subOffset = 0; P.subRate = 1; P.subId = null; $('#subOverlay').innerHTML = ''; }

function parseSubs(text) {
  text = text.replace(/\r/g, '').replace(/^﻿/, '');
  var blocks = text.split(/\n\n+/), cues = [];
  var ts = function (s) { var m = s.trim().replace(',', '.').match(/(?:(\d+):)?(\d+):(\d+)\.(\d+)/); if (!m) return NaN; return (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]) + (+('0.' + m[4])); };
  blocks.forEach(function (b) {
    var lines = b.split('\n'), k = 0;
    while (k < lines.length && lines[k].indexOf('-->') < 0) k++;
    if (k >= lines.length) return;
    var parts = lines[k].split('-->'), s = ts(parts[0]), e = ts(parts[1].split(' ').filter(Boolean)[0] || '');
    if (isNaN(s) || isNaN(e)) return;
    var said = lines.slice(k + 1).join('\n').replace(/<[^>]+>|\{[^}]+\}/g, '');
    if (!/store\.wyzie\.io/i.test(said)) cues.push({ s: s, e: e, t: said }); // the free plan adds an ad as the first line
  });
  return cues;
}
function useExtSubs(text, label, id) {
  var cues = parseSubs(text);
  if (!cues.length) { toast('Arquivo de Legenda Inválido'); return; }
  var tt = video.textTracks; for (var k = 0; k < tt.length; k++) tt[k].mode = 'disabled';
  if (hls) hls.subtitleTrack = -1;
  var kept = P.posKey && S.subs.last[P.posKey];
  // lines past the end of the video: made for 23,976 fps on a 25 fps file, the pace fix lines it up
  if (!kept || kept.id !== id) kept = { off: 0, rate: subEnd(cues) > video.duration + 5 ? RATE_FAST : 1 };
  P.subs = cues; P.subIdx = 'ext'; P.subOffset = kept.off; P.subRate = kept.rate; P.subLabel = label; P.subId = id || null;
  keepSync();
  toast('Legenda Carregada: ' + label);
}
function renderExtSub(t) {
  if (!P.subs) return; t = (t - P.subOffset) * P.subRate;
  var out = [];
  for (var i = 0; i < P.subs.length; i++) { var c = P.subs[i]; if (c.s > t) break; if (c.e >= t) out.push(c.t); }
  var html = out.map(function (s) { return esc(s).replace(/\n/g, '<br>'); }).join('<br>');
  var ov = $('#subOverlay'); if (ov._h !== html) { ov.innerHTML = html; ov._h = html; }
}
setInterval(function () { if (P.subs && !video.paused) renderExtSub(video.currentTime); }, 200);

var OS = 'https://api.opensubtitles.com/api/v1';
function osHeaders() { return { 'Api-Key': S.cfg.osKey, 'Content-Type': 'application/json', 'User-Agent': 'Sintonia v1.0', 'X-User-Agent': 'Sintonia v1.0' }; }
/* O Wyzie vem primeiro (1000 downloads por dia, busca pelo ID do TMDB). O OpenSubtitles só tem 5 downloads por dia
 * no plano gratuito, então é a RESERVA: nunca roda sozinho, só quando o Wyzie falhou e o usuário escolhe
 * "Procurar no OpenSubtitles" no menu do player. */
/* o que o usuário escolheu fica salvo com o título: uma série mantém a escolha nos próximos episódios */
function setTrk(k, v) {
  if (!P.posKey) return;
  var key = introKey(), t = S.trk[key] || (S.trk[key] = {});
  if (v == null) delete t[k]; else t[k] = v;
  save('trk', S.trk);
}
/* Busca no Wyzie pelo ID do TMDB (o do IMDb só entra se o TMDB não tiver achado o título). */
function wyzieList(lang) {
  return getRatings(P.item, true).then(function (r) {
    var id = r && (r.tmdbId || r.imdbId);
    if (!id) throw new Error('Título Não Encontrado');
    console.log('Sintonia: buscando legendas no Wyzie (' + (r.tmdbId ? 'TMDB' : 'IMDb') + ' ' + id + ', idioma ' + lang + ')');
    return getJSON('https://sub.wyzie.io/search?id=' + encodeURIComponent(id) + '&language=' + lang.slice(0, 2) + '&format=srt&key=' + encodeURIComponent(S.cfg.wyzieKey) + (P.ep ? '&season=' + P.ep.season + '&episode=' + P.ep.num : ''), {});
  }).then(function (list) {
    var ep = P.ep;
    // the search also brings other episodes of the season: the release name tells them apart
    function other(x) { var m = ep && String(x.release).match(/s(\d+)e(\d+)/i); return m && (+m[1] !== ep.season || +m[2] !== ep.num); }
    return (Array.isArray(list) ? list : []).filter(function (x) { return x.url && !other(x); }).sort(function (a, b) { return wyzieBr(a) - wyzieBr(b); });
  });
}
function wyzieBr(x) { return /brazil|\bbr\b|pt-br/i.test(x.display + ' ' + x.flagUrl) ? 0 : 1; }
/* O plano gratuito do Wyzie injeta um anúncio como PRIMEIRA legenda do arquivo (ex.: "store.wyzie.io").
 * Se o primeiro bloco do SRT citar o Wyzie, ele é descartado inteiro e os blocos seguintes são renumerados.
 * Só o primeiro bloco é examinado: falas reais do filme nunca são tocadas. */
function limparAnuncioWyzie(texto) {
  var t = String(texto || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/^\s+/, '');
  var blocos = t.split(/\n{2,}/);
  if (!blocos.length || !/wyzie/i.test(blocos[0])) return t; // primeiro bloco limpo: nada a fazer
  console.log('Sintonia: anúncio do Wyzie removido da primeira linha da legenda');
  blocos.shift();
  var n = 0;
  return blocos.filter(Boolean).map(function (b) {
    var linhas = b.replace(/\s+$/, '').split('\n');
    if (/^\d+$/.test(linhas[0].trim()) && linhas[1] && linhas[1].indexOf('-->') >= 0) linhas[0] = String(++n);
    return linhas.join('\n');
  }).join('\n\n') + '\n';
}
function wyzieText(x) {
  var had = S.subs.files['w' + x.id];
  if (had) return Promise.resolve(limparAnuncioWyzie(had.text)); // legendas salvas antes desta limpeza também passam por ela
  return timeoutFetch(x.url, {}, 30000).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); }).then(limparAnuncioWyzie);
}
function subEnd(cues) { return cues.length ? cues[cues.length - 1].e : 0; }
function subBd(x) { return /blu-?ray|bd-?rip|br-?rip/i.test([x.release, x.fileName, x.origin].join(' ')); }
function srtTime(t) { var ms = Math.round(t * 1000), p = function (n, w) { return ('00' + n).slice(-w); };
  return p(Math.floor(ms / 36e5), 2) + ':' + p(Math.floor(ms / 6e4) % 60, 2) + ':' + p(Math.floor(ms / 1000) % 60, 2) + ',' + p(ms % 1000, 3); }
function toSrt(cues) { return cues.map(function (c, i) { return (i + 1) + '\n' + srtTime(c.s) + ' --> ' + srtTime(c.e) + '\n' + c.t; }).join('\n\n') + '\n'; }
/* two subtitles of one episode are split into the same lines even when worded apart: their start times give the shift.
 * Each block of 40 lines tries shifts of up to 20 s; a block with too few matches keeps the shift of the one before.
 * Moves the cues in place and returns how much of them matched, so a failed alignment can be thrown away */
function retime(cues, ref) {
  var rs = ref.map(function (c) { return c.s; }), BLOCK = 40, hits = 0, last = 0;
  function near(t) {
    var lo = 0, hi = rs.length - 1;
    while (lo < hi) { var m = (lo + hi) >> 1; if (rs[m] < t) lo = m + 1; else hi = m; }
    return Math.abs(rs[lo] - t) <= 0.25 || (lo > 0 && Math.abs(rs[lo - 1] - t) <= 0.25);
  }
  for (var i = 0; i < cues.length; i += BLOCK) {
    var part = cues.slice(i, i + BLOCK), top = 0, shift = last;
    for (var d = -200; d <= 200; d++) {
      var n = 0;
      for (var k = 0; k < part.length; k++) if (near(part[k].s + d / 10)) n++;
      // on a tie the shift closest to the last block wins
      if (n > top || (n === top && Math.abs(d / 10 - last) < Math.abs(shift - last))) { top = n; shift = d / 10; }
    }
    if (top < part.length * 0.35) shift = last; else hits += top;
    last = shift;
    part.forEach(function (c) { c.s += shift; c.e += shift; });
  }
  cues.sort(function (a, b) { return a.s - b.s; });
  return hits / (cues.length || 1);
}
/* the right subtitle ends just before the video does: credits take up to 6% of it. Brazilian ones are tried first,
 * five downloads at most; with none in that range the closest one wins, and useExtSubs fixes its pace if it runs long */
function autoSub(lang, quiet) {
  var item = P.item, ep = P.ep, d = video.duration;
  if (!isFinite(d)) return;
  if (!quiet) menu('Procurando a Melhor Legenda', []);
  wyzieList(lang).then(function (list) {
    var tries = list.filter(subBd).slice(0, 3).concat(list.filter(function (x) { return !subBd(x); }).slice(0, 2)), best = null;
    if (!tries.length) throw new Error('Nenhuma Legenda');
    function gapOf(g) { return g >= -5 && g <= d * 0.06 ? 0 : Math.abs(g); }
    function next(i) {
      if (i >= tries.length) return best;
      return wyzieText(tries[i]).then(function (txt) {
        var g = gapOf(d - subEnd(parseSubs(txt)));
        if (!best || g < best.g) best = { x: tries[i], txt: txt, g: g };
        return g === 0 ? best : next(i + 1);
      }, function () { return next(i + 1); });
    }
    return next(0).then(function (b) {
      if (!b || lang.slice(0, 2) !== 'pt' || !wyzieBr(b.x) || !subBd(b.x)) return b;
      // the BluRay timing is right but it isn't Brazilian: the Brazilian text takes that timing
      var br = list.filter(function (x) { return !wyzieBr(x); })[0];
      if (!br) return b;
      return wyzieText(br).then(function (txt) {
        var cues = parseSubs(txt);
        if (retime(cues, parseSubs(b.txt)) < 0.35) return b;
        return { x: br, txt: toSrt(cues), g: 0, id: 'w' + br.id + 'r' + b.x.id };
      }, function () { return b; });
    });
  }).then(function (b) {
    if (!b) throw new Error('Nenhuma Legenda');
    if (P.item !== item || P.ep !== ep) return;
    var id = b.id || 'w' + b.x.id, label = b.x.release || b.x.display || 'online';
    S.subs.files[id] = { text: b.txt, label: label, at: Date.now() };
    setTrk('sub', lang.slice(0, 2));
    useExtSubs(b.txt, label, id);
    if (!quiet) closeMenu();
    toast('Legenda Automática Carregada');
  }).catch(function (e) { if (!quiet) askOpenSubs('Legenda Automática: ' + e.message, lang); });
}
function autoTitleSub() {
  var t = P.posKey && S.trk[introKey()];
  if (t && t.sub && !P.subs && !P.autoSubDone && S.cfg.wyzieKey) { P.autoSubDone = true; autoSub(t.sub, true); }
}
/* Única porta de entrada do OpenSubtitles: o menu só oferece a busca quando o Wyzie falhou, e a busca só começa
 * se o usuário escolher a opção (cada download gasta 1 dos 5 do dia). */
function askOpenSubs(title, lang) {
  console.log('Sintonia: Wyzie sem resultado (' + title + '); oferecendo o OpenSubtitles como reserva');
  var opts = S.cfg.osKey ? [{ name: 'Procurar no OpenSubtitles (5 por Dia)', fn: function () { searchOpenSubs(lang); } }]
    : [{ name: 'Cadastre a Chave do OpenSubtitles em Ajustes', fn: subsMenu }];
  menu(title, opts.concat([{ name: 'Voltar', fn: subsMenu }]), subsMenu);
}
function searchOnlineSubs(lang) {
  if (!S.cfg.wyzieKey) { askOpenSubs('Chave do Wyzie Não Cadastrada', lang); return; }
  menu('Buscando Legendas', []);
  wyzieList(lang).then(function (list) {
    var res = list.slice(0, 14);
    if (!res.length) { askOpenSubs('O Wyzie Não Achou Legenda Deste Título', lang); return; }
    var opts = res.map(function (x) {
      return { name: (S.subs.files['w' + x.id] ? 'Já Baixada · ' : '') + (wyzieBr(x) ? '' : 'BR · ') + (x.release || x.fileName || x.display), fn: function () { downloadWyzie(x); } };
    });
    menu('Legendas Encontradas no Wyzie', opts, subsMenu); // o Wyzie achou: o OpenSubtitles não é oferecido
  }).catch(function (e) { askOpenSubs('Wyzie Indisponível: ' + e.message, lang); });
}
function downloadWyzie(x) {
  var id = 'w' + x.id, label = x.release || x.display || 'online';
  menu('Baixando Legenda', []);
  wyzieText(x)
    .then(function (txt) { S.subs.files[id] = { text: txt, label: label, at: Date.now() }; setTrk('sub', String(x.language || 'pt').slice(0, 2)); useExtSubs(txt, label, id); closeMenu(); toast('Legenda Carregada do Wyzie'); })
    .catch(function (e) { menu('Erro: ' + e.message, [{ name: 'Voltar', fn: subsMenu }], subsMenu); });
}
function searchOpenSubs(lang) {
  if (!S.cfg.osKey) { menu('Nenhuma Legenda Encontrada', [{ name: 'Voltar', fn: subsMenu }], subsMenu); return; }
  var ct = cleanTitle(P.item.name), q = '&query=' + encodeURIComponent(ct.title);
  if (P.ep) q += '&season_number=' + P.ep.season + '&episode_number=' + P.ep.num + '&type=episode';
  else { q += '&type=movie'; if (P.item.year || ct.year) q += '&year=' + (P.item.year || ct.year); }
  menu('Buscando Legendas', []);
  console.log('Sintonia: busca no OpenSubtitles pedida pelo usuário (idioma ' + lang + ')');
  getJSON(OS + '/subtitles?languages=' + lang + q, { headers: osHeaders() }).then(function (r) {
    var res = (r.data || []).slice(0, 14);
    if (!res.length) { menu('Nenhuma Legenda Encontrada', [{ name: 'Voltar', fn: subsMenu }]); return; }
    menu('Legendas Encontradas', res.map(function (x) {
      var a = x.attributes, f = a.files && a.files[0];
      return { name: (f && S.subs.files[f.file_id] ? 'Já Baixada · ' : '') + (a.language || '').toUpperCase() + ' · ' + (a.fps ? String(a.fps).replace('.', ',') + ' fps · ' : '') + (a.release || (f && f.file_name) || 'legenda'),
        fn: function () { downloadSub(f.file_id, a.release || 'online'); } };
    }));
  }).catch(function (e) { menu('Erro na Busca: ' + e.message, [{ name: 'Voltar', fn: subsMenu }]); });
}
function downloadSub(fileId, label) {
  var had = S.subs.files[fileId];
  if (had) { useExtSubs(had.text, had.label, fileId); closeMenu(); return; }
  menu('Baixando Legenda', []);
  console.log('Sintonia: baixando legenda do OpenSubtitles (gasta 1 dos 5 downloads diários)');
  getJSON(OS + '/download', { method: 'POST', headers: osHeaders(), body: JSON.stringify({ file_id: fileId, sub_format: 'srt' }) })
    .then(function (r) { if (!r.link) throw new Error(r.message || 'limite diário atingido'); P.subsLeft = r.remaining; return timeoutFetch(r.link, {}, 30000); })
    .then(function (r) { return r.text(); })
    .then(function (txt) { S.subs.files[fileId] = { text: txt, label: label, at: Date.now() }; useExtSubs(txt, label, fileId); closeMenu(); if (P.subsLeft != null) toast('Legenda Carregada · Restam ' + P.subsLeft + ' Downloads Hoje', 4000); })
    .catch(function (e) { menu(/HTTP 40[36]|limite/.test(e.message) ? 'Acabaram os Downloads de Hoje. As Já Baixadas Continuam Disponíveis.' : 'Erro: ' + e.message, [{ name: 'Voltar', fn: subsMenu }]); });
}

/* ---- player menus ---- */
function menu(title, opts, back) {
  var m = $('#menu'); m._back = back || null;
  m.innerHTML = '<h3>' + esc(title) + '</h3>' + opts.map(function (o, i) {
    if (o.input) return '<input class="f inp" readonly id="menuInput" placeholder="' + esc(o.input) + '"><button class="f opt" data-i="' + i + '">Carregar</button>';
    return '<button class="f opt' + (o.on ? ' on' : '') + '" data-i="' + i + '">' + esc(o.name) + '</button>';
  }).join('');
  m._opts = opts; m.classList.remove('hidden'); showOSD(true);
  var first = $('.opt.on', m) || $('.f', m); if (first) first.focus();
}
function closeMenu() { $('#menu').classList.add('hidden'); setButtons(); showOSD(); $('.pbtn[data-act="gear"]').focus(); }
function audioMenu() {
  var l = audioList();
  if (l.length < 2) {
    var one = [{ name: l.length ? l[0].name + ' (Única Faixa)' : 'Este Vídeo Tem Só uma Faixa de Áudio', on: true, fn: closeMenu }];
    if (canUpgrade()) one.push({ name: 'Procurar Mais Faixas de Áudio', fn: function () { upgradeToHls(); } });
    menu('Áudio', one, gearMenu); return;
  }
  menu('Áudio', l.map(function (a) { return { name: a.name, on: a.on, fn: function () { setAudio(a.i); if (a.code) setTrk('audio', String(a.code)); toast('Áudio: ' + a.name); closeMenu(); } }; }), gearMenu);
}
function subsMenu() {
  hookTextTracks();
  var opts = [{ name: 'Desligada', on: P.subIdx === -1, fn: function () { subsOff(); closeMenu(); } }];
  if (hls && hls.subtitleTracks && hls.subtitleTracks.length) hls.subtitleTracks.forEach(function (t, i) { opts.push({ name: langName(t.lang, t.name), on: P.subIdx === i, fn: function () { selectEmbeddedSub(i); closeMenu(); } }); });
  else textTrackList().forEach(function (t) { opts.push({ name: t.name, on: P.subIdx === t.i, fn: function () { selectEmbeddedSub(t.i); closeMenu(); } }); });
  if (P.subs) opts.push({ name: 'Externa: ' + P.subLabel, on: true, fn: closeMenu });
  if (canUpgrade()) opts.push({ name: 'Procurar Legendas Embutidas', fn: function () { upgradeToHls(); } });
  if (P.item.kind !== 'live') {
    if (S.cfg.wyzieKey) opts.push({ name: 'Legenda Automática em Português', fn: function () { autoSub('pt'); } });
    opts.push({ name: 'Escolher Legenda em Português', fn: function () { searchOnlineSubs('pt-br,pt-pt'); } });
    opts.push({ name: 'Escolher Legenda em Inglês', fn: function () { searchOnlineSubs('en'); } });
    opts.push({ name: 'Carregar Legenda por Link (.srt / .vtt)', fn: linkSubMenu });
  }
  if (P.subs) opts.push({ name: 'Ajustar Sincronia (' + syncLabel() + ')', fn: function () { syncMenu(0); } });
  [['Pequena', 38], ['Média', 48], ['Grande', 60], ['Enorme', 74]].forEach(function (s) {
    opts.push({ name: 'Tamanho da Letra: ' + s[0], on: S.cfg.subSize === s[1], fn: function () { S.cfg.subSize = s[1]; save('cfg', S.cfg); applySubSize(); subsMenu(); } });
  });
  menu('Legenda', opts, gearMenu);
}
function linkSubMenu() {
  menu('Link da Legenda', [{ input: 'https://…/legenda.srt', fn: function () {
    var u = ($('#menuInput').value || '').trim(); if (!u) return;
    timeoutFetch(u, {}, 30000).then(function (r) { return r.text(); }).then(function (t) { useExtSubs(t, u.split('/').pop()); closeMenu(); }, function (e) { toast('Erro: ' + e.message); });
  } }]);
}
function applySubSize() { document.documentElement.style.setProperty('--subsize', S.cfg.subSize + 'px'); }

function playerAction(act) {
  if (act === 'play') { if (video.paused) video.play(); else video.pause(); showOSD(); }
  else if (act === 'back10') seek(-10); else if (act === 'fwd10') seek(10);
  else if (act === 'gear') gearMenu();
  else if (act === 'fav') toggleFav(P.item.kind + ':' + P.item.id);
}
function seek(s) { if (isFinite(video.duration)) { video.currentTime = Math.max(0, Math.min(video.duration - 1, video.currentTime + s)); } showOSD(); }

/* ---- fast seek: the arrows move a marker and the video jumps once, when the key is let go ---- */
var SC = { on: false, t: 0, down: 0, from: 0, last: 0, timer: null };
function scrubStep(held) { return held < 1500 ? 10 : held < 3500 ? 30 : held < 6000 ? 60 : 300; }
function scrubPaint() {
  var p = $('#player'), d = video.duration;
  $('#seekMark').style.transform = 'translateX(' + Math.round(SC.t / d * $('.bar').clientWidth) + 'px)';
  $('#seekTip').textContent = fmtTime(SC.t);
  p.classList.add('osd-on', 'scrub'); paintTime();
  clearTimeout(osdT); osdT = setTimeout(hideOSD, 5000);
}
function scrubStart() {
  var d = video.duration; if (!isFinite(d) || d <= 0) return false;
  if (!SC.on) { SC.on = true; SC.t = video.currentTime; }
  return true;
}
function scrubKey(k, dir) {
  var now = Date.now(), held = SC.down === k;
  if (!scrubStart()) { showOSD(); return; }
  if (held && now - SC.last < 250) return; // key repeat speed differs per remote: the jump size is what speeds up
  if (!held) { SC.down = k; SC.from = now; }
  SC.last = now;
  SC.t = Math.max(0, Math.min(video.duration - 1, SC.t + dir * scrubStep(now - SC.from)));
  scrubPaint();
  // the keyup may never arrive (focus changes, pointer): the jump still happens
  clearTimeout(SC.timer); SC.timer = setTimeout(scrubCommit, 1500);
}
function scrubUp() { SC.down = 0; clearTimeout(SC.timer); SC.timer = setTimeout(scrubCommit, 450); }
function scrubTo(pct) {
  if (!scrubStart()) return;
  SC.t = video.duration * pct; scrubPaint();
  clearTimeout(SC.timer); SC.timer = setTimeout(scrubCommit, 300);
}
function scrubCommit() {
  clearTimeout(SC.timer); SC.down = 0;
  if (!SC.on) return;
  SC.on = false; $('#player').classList.remove('scrub');
  video.currentTime = SC.t; paintTime();
}
function scrubCancel() { clearTimeout(SC.timer); SC.on = false; SC.down = 0; $('#player').classList.remove('scrub'); }

/* ================= spatial navigation ================= */
function scope() {
  if (playerOpen()) return !$('#menu').classList.contains('hidden') ? $('#menu') : $('#player');
  if (pickOpen()) return $('#pick');
  if (!$('#remote').classList.contains('hidden')) return $('#remote');
  if (!$('#detail').classList.contains('hidden')) return $('#detail');
  return $('#app');
}
function visible(el) { if (!el.offsetParent && el.tagName !== 'BODY') return false; var r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }
function move(dir) {
  var sc = scope(), cur = document.activeElement;
  var els = $$('.f', sc).filter(visible);
  if (!els.length) return;
  // the menu may be hidden: only ever start from something on screen
  if (!cur || !sc.contains(cur) || cur === document.body || !visible(cur)) {
    if (sc.id === 'app' && S.view !== 'home') { focusContent(); return; } // lost focus goes back to the remembered item, never to the search box
    (els.filter(function (e) { return e.matches('.nav.active, .opt.on'); })[0] || els[0]).focus(); return; }
  // inside a list or grid the up and down arrows stay in it: at the end they stop on the last item
  var col = cur.closest('.chlist, .posters');
  if (col && (dir === 'down' || dir === 'up')) {
    var box = cur.getBoundingClientRect(), mine = els.filter(function (el) { return col.contains(el); });
    if (dir === 'down') {
      els = mine;
      if (col._items && col._shown < col._items.length && !mine.some(function (el) { return el.getBoundingClientRect().top >= box.bottom - 4; })) { growGrid(col); els = $$('.f', col).filter(visible); }
    } else if (mine.some(function (el) { return el.getBoundingClientRect().bottom <= box.top + 4; })) els = mine;
  }
  if (cur.classList.contains('setsec')) {
    if (dir === 'right') { focusPanel(); return; }
    if (dir === 'up' || dir === 'down') els = $$('.setsec');
  }
  var a0 = cur.getBoundingClientRect(), row = cur.classList.contains('game') && (dir === 'up' || dir === 'down');
  if (row) {
    var more = els.filter(function (el) { var q = el.getBoundingClientRect(); return el.classList.contains('game') && (dir === 'up' ? q.bottom <= a0.top + 4 : q.top >= a0.bottom - 4); });
    if (more.length) els = more;
  }
  var a = a0, ax = a.left + a.width / 2, ay = a.top + a.height / 2, best = null, bs = Infinity;
  els.forEach(function (el) {
    if (el === cur) return;
    var r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2, dx = x - ax, dy = y - ay, p, s2;
    if (dir === 'left') { if (r.right > a.left + 4) return; p = -dx; s2 = Math.abs(dy); }
    else if (dir === 'right') { if (r.left < a.right - 4) return; p = dx; s2 = Math.abs(dy); }
    else if (dir === 'up') { if (r.bottom > a.top + 4) return; p = -dy; s2 = Math.abs(dx); }
    else { if (r.top < a.bottom - 4) return; p = dy; s2 = Math.abs(dx); }
    // in Ajustes up and down go row by row, entering each row by its first button, and never leak into the sections
    if ((dir === 'up' || dir === 'down') && cur.closest('.sets')) { if (!el.closest('.sets')) return; s2 = Math.abs(r.left - a.left) * 0.1; }
    if (row) s2 *= 0.02; // leagues with fewer games: the nearest row wins, even with its cards off to one side
    var sc2 = p + s2 * 2.5; if (sc2 < bs) { bs = sc2; best = el; }
  });
  if (!best) return;
  // entering the sidebar or category list: land on the active entry
  if (!cur.classList.contains('nav') && best.classList.contains('nav')) best = $('.nav.active') || best;
  else if (!cur.classList.contains('grp') && best.classList.contains('grp') && $('.grp.active')) best = $('.grp.active');
  else if (!cur.classList.contains('setsec') && best.classList.contains('setsec')) best = $('.setsec.on');
  focusEl(best);
}
/* each screen and each group remembers its selected item; focusEl centers it, so the scroll comes back with it */
var SPOT_ATTRS = ['data-game', 'data-hist', 'data-go', 'data-view', 'data-gf', 'data-key', 'id'];
function rowId(x) { return x.kind ? x.kind + ':' + x.id : x.cat; }
function noteSpot(el) {
  if (!el.closest || !el.closest('#app') || el.tagName === 'INPUT') return;
  var v = S.view, lists = v === 'live' || v === 'movies' || v === 'series';
  if (!lists) {
    for (var i = 0; i < SPOT_ATTRS.length; i++) if (el.hasAttribute(SPOT_ATTRS[i])) { S.spot[v + '|'] = { a: SPOT_ATTRS[i], v: el.getAttribute(SPOT_ATTRS[i]), i: el.getAttribute('data-idx') }; return; }
    return;
  }
  if (el.closest('#libGroups')) { S.spot[v + '|pane'] = 'groups'; return; }
  if (!el.closest('#gridWrap') || S.q || S.spotOff || !el.hasAttribute('data-idx')) return;
  S.spot[v + '|pane'] = 'grid';
  S.spot[v + '|' + S.cat[v]] = { v: el.getAttribute('data-key') || el.getAttribute('data-grp'), i: +el.getAttribute('data-idx') };
}
function spotInGrid(m) {
  var grid = $('#gridWrap .chlist, #gridWrap .posters'); if (!grid || !grid._items || !grid._items.length) return null;
  var list = grid._items, i = m.i;
  // the order may have changed since: look the item up, or stay near where it was
  if (!list[i] || rowId(list[i]) !== m.v) { i = -1; for (var k = 0; k < list.length; k++) if (rowId(list[k]) === m.v) { i = k; break; } }
  if (i < 0) i = Math.min(m.i, list.length - 1);
  if (i >= grid._shown) growGrid(grid, i + 1);
  return grid.children[i];
}
function restoreSpot(view, cat) {
  view = view || S.view;
  var lists = view === 'live' || view === 'movies' || view === 'series', el = null, m;
  if (lists) {
    if (S.spot[view + '|pane'] === 'groups' && cat == null && $('#libGroups')) el = $('.grp.active');
    else { m = S.spot[view + '|' + (cat || S.cat[view])]; if (m) el = spotInGrid(m); }
  } else if ((m = S.spot[view + '|'])) {
    var same = $$('[' + m.a + ']', $('#app')).filter(function (b) { return b.getAttribute(m.a) === m.v && visible(b); });
    el = same.filter(function (b) { return b.getAttribute('data-idx') === m.i; })[0] || same[0];
  }
  if (!el) return false;
  focusEl(el);
  return true;
}
function focusEl(el) {
  el.focus({ preventScroll: true }); noteSpot(el);
  el.scrollIntoView({ block: el.classList.contains('poster') || el.classList.contains('ch') || el.classList.contains('grp') ? 'center' : 'nearest', inline: 'nearest' });
  var grid = el.parentNode;
  if (grid && grid._items && +el.getAttribute('data-idx') >= grid._shown - 18 && grid._shown < grid._items.length) growGrid(grid);
  if (el.classList.contains('poster')) ratePoster(el);
}
var rateT;
function ratePoster(el) {
  clearTimeout(rateT);
  rateT = setTimeout(function () {
    var it = S.byKey[el.getAttribute('data-key')]; if (!it || !S.cfg.tmdbKey) return;
    getRatings(it).then(function (r) { showRate(el, it, r); });
    // warm up the next few posters in the row too
    var sib = el.nextElementSibling, n = 0;
    while (sib && n++ < 5) { (function (s) { var i2 = S.byKey[s.getAttribute('data-key')]; if (i2) getRatings(i2).then(function (r) { showRate(s, i2, r); }); })(sib); sib = sib.nextElementSibling; }
  }, 500);
}

/* ================= input ================= */
var lastFocus = null;
var K = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, BACK: 461, ESC: 27, BKSP: 8, RED: 403, GREEN: 404, YELLOW: 405, BLUE: 406, PLAY: 415, PAUSE: 19, PLAYPAUSE: 10252, FF: 417, RW: 412, STOP: 413, CHUP: 33, CHDOWN: 34 };

/* text boxes stay locked while navigating, otherwise the TV's keyboard pops up on focus; OK unlocks them */
// webOS ignores the box if it is unlocked and focused in the same moment: it needs a beat in between
// and the first keyboard after launch may not answer at all, so it gets one more try
var kbOpen = false;
function editInput(a, again) {
  a.blur();
  setTimeout(function () {
    a.readOnly = false; a.focus();
    try { a.setSelectionRange(a.value.length, a.value.length); } catch (e) {}
    if (!again) setTimeout(function () { if (!kbOpen && document.activeElement === a && !a.readOnly) editInput(a, true); }, 800);
  }, 120);
}
function stopEdit(a) { a.blur(); a.readOnly = true; a.focus({ preventScroll: true }); }
function onBack() {
  var ed = document.activeElement;
  if (ed && ed.tagName === 'INPUT' && !ed.readOnly) { stopEdit(ed); return; }
  if (playerOpen()) {
    if (cardOpen()) { cancelNext(); return; }
    if (!$('#menu').classList.contains('hidden')) { var mb = $('#menu')._back; if (mb) mb(); else closeMenu(); return; }
    if ($('#player').classList.contains('osd-on')) { $('#player').classList.remove('osd-on'); document.activeElement.blur(); return; }
    if (P.tv) leaveFull(); else closePlayer();
    return;
  }
  if (pickOpen()) { closePick(); return; }
  if (!$('#remote').classList.contains('hidden')) { closeRemote(); return; }
  if (!$('#detail').classList.contains('hidden')) { closeDetail(); return; }
  if (S.draft) { closeDraft(); return; }
  if (S.view === 'settings' && ed && ed.closest('.sets')) { $('.setsec.on').focus(); return; }
  // deep inside a group, Voltar first goes back to its top; from the top, it goes to the group list
  if (ed && ed.closest && ed.closest('#gridWrap') && +ed.getAttribute('data-idx') > 0 && S.cat[S.view] !== '__groups') {
    var top = $('#gridWrap [data-idx="0"]');
    if (top) { $('#gridWrap').scrollTop = 0; focusEl(top); return; }
  }
  if ((S.view === 'live') && S.cat[S.view] && S.cat[S.view] !== '__groups') { backToGroups(S.view); return; }
  var cur = document.activeElement, grp = $('#libGroups .grp.active') || $('#libGroups .grp');
  if (grp && cur && (cur.id === 'libQ' || cur.closest('#gridWrap'))) {
    if (groupAdult(S.view, S.cat[S.view])) { showCat(S.view, '__all'); grp = $('#libGroups .grp.active') || grp; }
    focusEl(grp); return;
  }
  if (S.view !== 'home') { go('home'); if (!restoreSpot('home')) focusNav(); return; }
  var a = document.activeElement;
  if (a && !a.classList.contains('nav')) { focusNav(); return; }
  // Nada mais para voltar: na tela principal. No Android, o app nativo decide fechar com base nesta confirmação.
  naTelaPrincipal = true;
}

/* ---- Ponte com o Android (MainActivity.kt) ---- */
var naTelaPrincipal = false;

/* Chamado pelo Android ao pressionar o botão físico Voltar.
 * Retorna true se a interface tratou o Voltar (voltou uma tela, fechou um painel etc.)
 * e false se já estava na tela principal e não há mais para onde voltar (o app pode fechar). */
window.sintoniaVoltar = function () {
  naTelaPrincipal = false;
  try { onBack(); } catch (e) { console.log('Sintonia: erro ao processar Voltar: ' + e); }
  return !naTelaPrincipal;
};

/* Chamado pelo Android para repassar teclas físicas do controle remoto.
 * Simula o evento de teclado com o mesmo keyCode que o webOS enviava. */
window.sintoniaTecla = function (codigo, tipo, repeticao) {
  var alvo = document.activeElement || document.body;
  var ev = new KeyboardEvent(tipo === 'keyup' ? 'keyup' : 'keydown', { bubbles: true, cancelable: true, repeat: !!repeticao });
  Object.defineProperty(ev, 'keyCode', { get: function () { return codigo; } });
  Object.defineProperty(ev, 'which', { get: function () { return codigo; } });
  var naoTratada = alvo.dispatchEvent(ev); // false se algum tratador chamou preventDefault()
  // Evento criado por script não tem a ação padrão do navegador: o OK (Enter) não viraria clique no botão focado.
  // Se o app.js não tratou o OK por conta própria, faz aqui o clique que o navegador faria.
  if (naoTratada && codigo === 13 && tipo !== 'keyup' && !repeticao && alvo !== document.body && alvo.click &&
      alvo.tagName !== 'INPUT' && alvo.tagName !== 'TEXTAREA') {
    console.log('Sintonia: OK sobre <' + alvo.tagName.toLowerCase() + (alvo.id ? '#' + alvo.id : '') + '> virou clique');
    alvo.click();
  }
};

document.addEventListener('keydown', function (e) {
  var k = e.keyCode, a = document.activeElement, inInput = a && a.tagName === 'INPUT' && !a.readOnly;
  var inPlayer = playerOpen();
  if (busyOn()) { e.preventDefault(); return; }
  if (k >= 48 && k <= 57 && pinOpen()) { e.preventDefault(); pinPress(String(k - 48)); return; }
  // the notice takes OK and Voltar without stealing focus; the short delay keeps a press already under way from opening it
  if (remindOpen() && !inInput && !pinOpen()) {
    if (k === K.BACK || k === K.ESC) { e.preventDefault(); closeRem(); return; }
    if (k === K.ENTER && Date.now() - remShownAt > 1200) { e.preventDefault(); watchRem(); return; }
  }
  if (k === K.ENTER && a && a.tagName === 'INPUT' && a.readOnly) { e.preventDefault(); editInput(a); return; }
  if (k === K.BACK || k === K.ESC || (k === K.BKSP && !inInput)) { e.preventDefault(); onBack(); return; }

  if (inPlayer) {
    var osdOn = $('#player').classList.contains('osd-on'), live = P.item && P.item.kind === 'live';
    if (k === K.ENTER && cardOpen()) { e.preventDefault(); goNext(); return; }
    // any other key during the countdown stops it; the key still does its own job
    if (cardOpen() && !P.nextHold) { P.nextHold = true; setText('#nextCount', 'Contagem Parada · OK: Próximo Episódio'); }
    if (k === K.PLAY || k === K.PAUSE || k === K.PLAYPAUSE) { playerAction('play'); e.preventDefault(); return; }
    if (!live && (k === K.FF || k === K.RW)) { scrubKey(k, k === K.FF ? 1 : -1); return; }
    if (k === K.STOP) { if (P.tv) leaveFull(); else closePlayer(); return; }
    if (k === K.CHUP) { zap(1); return; } if (k === K.CHDOWN) { zap(-1); return; }
    if (k === K.RED) { playerAction('fav'); return; }
    if (k === K.GREEN) { toggleLater(introKey()); return; }
    if (k === K.YELLOW) { markIntro(); return; }
    if (k === K.BLUE && live) { refreshApp(); return; }
    if (!live && !inInput && k >= 48 && k <= 57) { e.preventDefault(); scrubTo((k - 48) / 10); return; }
    // the seek bar shows without a button selected: the arrows keep seeking until OK or up/down picks one
    if (!osdOn || a === document.body || !a || !$('#player').contains(a)) {
      e.preventDefault();
      if (k === K.ENTER && skipOpen()) { skipIntro(); return; }
      if (!live && (k === K.LEFT || k === K.RIGHT)) { scrubKey(k, k === K.LEFT ? -1 : 1); return; }
      showOSD(); return;
    }
    if (a.id === 'seekBar') {
      if (k === K.LEFT || k === K.RIGHT) { e.preventDefault(); scrubKey(k, k === K.LEFT ? -1 : 1); return; }
      if (k === K.ENTER) { e.preventDefault(); if (SC.on) scrubCommit(); else playerAction('play'); return; }
      if (k === K.DOWN) { e.preventDefault(); $('.pbtn[data-act="play"]').focus(); showOSD(); return; }
    }
    showOSD(!$('#menu').classList.contains('hidden'));
  }

  var key = a && a.getAttribute && a.getAttribute('data-key');
  if (!key && !$('#detail').classList.contains('hidden') && $('#detail')._item) key = $('#detail')._item.kind + ':' + $('#detail')._item.id;
  if (k === K.RED) { if (key) { toggleFav(key); setText2('#dFav', favLabel(key)); } return; }
  if (k === K.GREEN) { if (key) { toggleLater(key); setText2('#dLater', laterLabel(key)); } return; }
  if (inInput && (k === K.LEFT || k === K.RIGHT)) return;
  if (k === K.LEFT) { e.preventDefault(); move('left'); }
  else if (k === K.RIGHT) { e.preventDefault(); move('right'); }
  else if (k === K.UP) { e.preventDefault(); move('up'); }
  else if (k === K.DOWN) { e.preventDefault(); move('down'); }
  else if (k === K.ENTER && inInput) {
    if (a.id === 'menuInput') { var o = $('#menu')._opts; o[0].fn(); }
    else if (a.id === 'q') { doSearch(a.value); stopEdit(a); }
    else if (a.id === 'libQ') { var first = $('#gridWrap .poster'); if (first) focusEl(first); else stopEdit(a); }
    else stopEdit(a);
  }
});
document.addEventListener('keyup', function (e) { if (SC.down === e.keyCode) scrubUp(); });
function setText2(sel, html) { var e = $(sel); if (e) e.innerHTML = html; }

document.addEventListener('click', function (e) {
  // Magic Remote pointer: a click on the bar goes straight to that point
  var sb = e.target.closest && e.target.closest('#seekBar.f');
  if (sb) { var bx = sb.getBoundingClientRect(); scrubTo(Math.max(0, Math.min(1, (e.clientX - bx.left) / bx.width))); return; }
  var box = e.target.closest && e.target.closest('input.inp');
  if (box) { if (box.readOnly) editInput(box); return; }
  var t = e.target.closest ? e.target.closest('button') : null; if (!t) return;
  if (t.id === 'refreshBtn') { refreshApp(); return; }
  if (t.id === 'skipIntro') { skipIntro(); return; }
  if (t.id === 'remGo') { watchRem(); return; }
  if (t.id === 'remNo') { closeRem(); return; }
  if (t.hasAttribute('data-gs')) { sheetAction(t.getAttribute('data-gs')); return; }
  if (t.classList.contains('gmin')) { S.cfg.remMin = +t.getAttribute('data-min'); save('cfg', S.cfg); $$('.gmin').forEach(function (b) { b.classList.toggle('active', b === t); }); saveRem(); return; }
  if (t.classList.contains('gfav')) { S.teams = S.teams.filter(function (x) { return x.k !== t.getAttribute('data-team'); }); save('teams', S.teams); paintGames(); $('.gfilter.active').focus(); return; }
  if (t.classList.contains('nav')) { go(t.getAttribute('data-view')); if (S.view === 'home') focusNav(); else focusContent(); return; }
  if (t.classList.contains('grp')) { openGroup(S.view, t.getAttribute('data-grp'), t); return; }
  if (t.classList.contains('pinkey')) { pinPress(t.getAttribute('data-k')); return; }
  if (t.classList.contains('gfilter')) { G.filter = t.getAttribute('data-gf'); $$('.gfilter').forEach(function (b) { b.classList.toggle('active', b === t); }); paintGames(); return; }
  if (t.classList.contains('game')) { openGame(t); return; }
  if (t.hasAttribute('data-clear')) { if (t.getAttribute('data-clear') === '0') closePick(); else clearSeen(t.getAttribute('data-clear')); return; }
  if (t.hasAttribute('data-choose')) { var cf = $('#pick')._choose, cv = t.getAttribute('data-choose'); closePick(); cf(cv); return; }
  if (t.id === 'rateSrc') { pickRateSrc(); return; }
  if (t.hasAttribute('data-sec')) { showSec(t.getAttribute('data-sec')); focusPanel(); return; }
  if (t.id === 'newList') { openDraft(newDraft()); return; }
  if (t.hasAttribute('data-list')) { openDraft(JSON.parse(JSON.stringify(S.lists.filter(function (x) { return x.id === t.getAttribute('data-list'); })[0]))); return; }
  if (t.hasAttribute('data-use')) { activateList(t.getAttribute('data-use')); return; }
  if (t.hasAttribute('data-ltype')) {
    S.draft.type = t.getAttribute('data-ltype');
    $$('[data-ltype]').forEach(function (b) { b.classList.toggle('on', b === t); });
    $('#xtreamFields').classList.toggle('hidden', S.draft.type !== 'xtream'); $('#m3uFields').classList.toggle('hidden', S.draft.type !== 'm3u');
    return;
  }
  if (t.id === 'listUse' || t.id === 'listSave') { saveDraft(t.id === 'listUse'); return; }
  if (t.id === 'listDel') { deleteList(); return; }
  if (t.id === 'listCancel') { closeDraft(); return; }
  if (t.classList.contains('resume')) { resumeChoice(t.getAttribute('data-r')); return; }
  if (t.classList.contains('pick')) { var pk = $('#pick'), pl = pk._items, pi = +t.getAttribute('data-i'); closePick(); play(pl[pi], { list: pl, index: pi }); return; }
  if (t.id === 'hideBr') { S.hideBr = !S.hideBr; save('hideBr', S.hideBr); renderLibrary(S.view); $('#hideBr').focus(); return; }
  if (t.classList.contains('sort')) { S.sort = t.getAttribute('data-sort'); save('sort', S.sort); $$('[data-sort]').forEach(function (b) { b.classList.toggle('active', b === t); }); delete S.spot[S.view + '|' + S.cat[S.view]]; showCat(S.view, S.cat[S.view] || '__all'); return; }
  if (t.classList.contains('pbtn')) { playerAction(t.getAttribute('data-act')); return; }
  if (t.classList.contains('opt')) { var o = $('#menu')._opts[+t.getAttribute('data-i')]; if (o && o.fn) o.fn(); return; }
  if (t.hasAttribute('data-seg')) {
    S.cfg[t.getAttribute('data-seg')] = t.getAttribute('data-val');
    $$('[data-seg="' + t.getAttribute('data-seg') + '"]').forEach(function (b) { b.classList.toggle('on', b === t); });
    save('cfg', S.cfg); return;
  }
  if (t.id === 'saveKeys') { saveKeys(); return; }
  if (t.id === 'checkUpdate') { checkUpdate(); return; }
  if (t.id === 'reload') { reload(); return; }
  if (t.id === 'openRemote') { openRemote(); return; }
  if (t.id === 'clearSeen') { askClearSeen(); return; }
  if (t.id === 'adultLock') { toggleAdultLock(t); return; }
  if (t.id === 'adultPin') { changePin(t); return; }
  if (t.hasAttribute('data-hist')) { lastFocus = t; var h = histFor(t.getAttribute('data-hist')); if (h) resume(h); return; }
  if (t.hasAttribute('data-go')) { go(t.getAttribute('data-go')); focusContent(); return; }
  var d = $('#detail');
  if (t.id === 'dPlay') {
    var it = d._item, hh = histFor(it.kind + ':' + it.id); lastFocus = t;
    if (hh) resume(hh);
    else if (it.kind === 'movie') askResume(it, {});
    else if (d._eps) play(it, { ep: d._eps[0], list: d._eps, index: 0 });
    return;
  }
  if (t.id === 'dFav') { var k2 = d._item.kind + ':' + d._item.id; toggleFav(k2); t.innerHTML = favLabel(k2); return; }
  if (t.id === 'dLater') { var k3 = d._item.kind + ':' + d._item.id; toggleLater(k3); t.innerHTML = laterLabel(k3); return; }
  if (t.classList.contains('season')) { showSeason(d._item, +t.getAttribute('data-s')); return; }
  if (t.classList.contains('ep')) { var i = +t.getAttribute('data-i'); lastFocus = t; askResume(d._item, { ep: d._eps[i], list: d._eps, index: i }); return; }
  var key = t.getAttribute('data-key');
  if (key) {
    var item = S.byKey[key]; if (!item) return; lastFocus = t;
    if (item.kind === 'live') {
      var list = (t.parentNode && t.parentNode._items) || $$('[data-key^="live:"]', t.parentNode).map(function (b) { return S.byKey[b.getAttribute('data-key')]; });
      if (S.view === 'live') { if (P.tv && P.item === item) enterFull(); else selectChannel(item, list); }
      else play(item, { list: list, index: Math.max(0, list.indexOf(item)) });
    } else openDetail(item);
  }
});
document.addEventListener('focusin', function (e) { noteSpot(e.target); if (e.target.classList && e.target.classList.contains('setsec')) showSec(e.target.getAttribute('data-sec')); });
document.addEventListener('input', function (e) { if (e.target.id === 'libQ') typedSearch(e.target.value); });
document.addEventListener('focusout', function (e) { if (e.target.matches && e.target.matches('input.inp')) e.target.readOnly = true; });
// the keyboard closed by its own buttons: lock the box again so the arrows keep navigating
document.addEventListener('keyboardStateChange', function (e) {
  var a = document.activeElement; kbOpen = !!(e.detail && e.detail.visibility);
  if (e.detail && e.detail.visibility === false && a && a.tagName === 'INPUT' && !a.readOnly) stopEdit(a);
});
// mouse / Magic Remote pointer
document.addEventListener('mouseover', function (e) { var t = e.target.closest && e.target.closest('.f'); if (t && t !== document.activeElement && scope().contains(t)) t.focus({ preventScroll: true }); });

/* A notificação do Android abre o app com o id do lembrete. Na abertura a interface o busca na ponte;
 * com o app já aberto, o Android chama window.sintoniaAbrirLembrete(id). */
function openLaunchRem(idDireto) {
  var id = idDireto != null ? idDireto : (NATIVO ? window.SintoniaBridge.obterLembreteDeAbertura() : '');
  var r = id && remFor(id);
  if (r) { console.log('Sintonia: abrindo o jogo do lembrete "' + id + '"'); $('#remind')._rem = r; watchRem(); }
}
window.sintoniaAbrirLembrete = function (id) { openLaunchRem(String(id)); };

/* ================= boot ================= */
bindVideo(video);
// No webOS um serviço local baixava imagens que o navegador da TV recusava (ex.: imgur); no Android o WebView as carrega direto.
applySubSize();
var after = null;
try { after = JSON.parse(sessionStorage.getItem('atl.after') || 'null'); sessionStorage.removeItem('atl.after'); } catch (e) {}
S.fresh = !!after;
var configured = S.cfg.server || S.cfg.m3u;
go(configured ? 'home' : 'settings');
// Avisa o Android que a interface iniciou: sem isso, uma interface baixada (OTA) é descartada e o app volta para a do APK.
try { if (NATIVO && window.SintoniaBridge.interfaceCarregada) window.SintoniaBridge.interfaceCarregada(); } catch (e) {}
setTimeout(function () { if (S.loadError) return; if (S.view === 'home') focusNav(); else focusContent(); }, 50);
if (configured) {
  setBusy(after ? 'Atualizando: Recarregando a Lista…' : 'Carregando Sua Lista');
  loadAll().then(function () {
    S.fresh = false;
    setBusy('');
    if (after && after.cat) S.cat[after.view] = after.cat;
    if (after && after.spot) S.spot = after.spot;
    go(after && TITLES[after.view] != null ? after.view : 'home');
    if (S.view === 'home') focusNav(); else focusContent();
    saveRem(); remTick(); setInterval(remTick, 20000);
    openLaunchRem();
    var item = after && after.play && S.byKey[after.play];
    if (item && after.tv) {
      var b = $('.ch[data-key="' + item.kind + ':' + item.id + '"]'); if (b) b.focus();
      selectChannel(item, S.live);
      if (after.full) enterFull();
    } else if (item) play(item, { list: S.live, index: Math.max(0, S.live.indexOf(item)), quiet: true });
    if (after) toast('Atualizado ✓');
  }, function (e) { S.fresh = false; loadFailed(e); });
}

window.__atl = { S: S, P: P, retime: retime, toSrt: toSrt, shortGroup: shortGroup, reload: reload, genCover: genCover, catIsAdult: catIsAdult, useExtSubs: useExtSubs, syncMenu: syncMenu, pickChannel: pickChannel, askResume: askResume, fetchEps: fetchEps, epTitle: epTitle, parseM3U: parseM3U, parseLink: parseLink, quality: quality, channelBase: channelBase, parseSubs: parseSubs, cleanTitle: cleanTitle, play: play, showQR: showQR, receiveList: receiveList, video: function () { return video; } };
})();
