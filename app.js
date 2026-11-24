// Dub Club client. Peer-to-peer: the host's browser runs the game, everyone else connects to it via WebRTC (PeerJS).
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const uid = (n = 8) => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => (b % 36).toString(36)).join('');
const me = { id: null, name: localStorage.getItem('dub_name') || '' };
let S = null, lastVersion = 0, lastEventSeq = null, clockOffset = 0, bestRtt = Infinity;
const serverNow = () => (Date.now() + clockOffset) / 1000;

const ROOM_PREFIX = 'dubclub-v1-';
const PEER_OPTS = { debug: 1, config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }, { urls: 'stun:global.stun.twilio.com:3478' }] } };
const MAX_VIDEO = 60 * 1024 * 1024;
const COLORS = ['#ff6b6b', '#4dabf7', '#ffd43b', '#69db7c', '#da77f2', '#ff922b', '#38d9a9', '#f783ac', '#a9e34b', '#748ffc'];
let peer = null, hostConn = null, amHost = false, roomCode = null, rid = 0;
const pending = new Map();      // client: request id -> {resolve, reject}
const mediaCache = new Map();   // media id -> Promise<Blob>
const mediaWaiters = new Map(); // client: media id -> {resolve, reject}

// ================================================================== HOST: game state lives here
const HOST = { S: null, media: new Map(), conns: new Map() };
function newState() {
  return { version: 1, phase: 'studio', hostId: null, players: {}, scenes: [], events: [], eventSeq: 0, premiere: null };
}
function hEvent(type, text = '', extra = {}) {
  const s = HOST.S; s.eventSeq++;
  s.events.push({ seq: s.eventSeq, type, text, to: null, ...extra });
  s.events = s.events.slice(-60);
}
const hName = pid => HOST.S.players[pid]?.name || 'Someone';
function hScene(id) { const s = HOST.S.scenes.find(x => x.id === id); if (!s) throw new Error('Scene not found'); return s; }
function hTake(s, id) { const t = s.takes.find(x => x.id === id); if (!t) throw new Error('Voice not found'); return t; }
function publicState() {
  const s = HOST.S;
  return { version: s.version, phase: s.phase, hostId: s.hostId, scenes: s.scenes, events: s.events, premiere: s.premiere, serverNow: Date.now() / 1000,
    players: Object.values(s.players).map(p => ({ ...p, isHost: p.id === s.hostId })) };
}
function commit() {
  HOST.S.version++;
  const pub = publicState();
  for (const c of HOST.conns.values()) if (c.open) c.send({ t: 'state', s: pub });
  onState(pub);
}
function act(a, d) {
  const s = HOST.S, pid = d.playerId, isHost = pid === s.hostId;
  if (a === 'join') {
    const name = (d.name || 'Player').trim().slice(0, 20) || 'Player';
    let id = d.playerId;
    if (!s.players[id]) {
      id = uid(10);
      s.players[id] = { id, name, color: COLORS[Object.keys(s.players).length % COLORS.length], online: true };
      hEvent('info', `${name} joined the studio`);
    } else { s.players[id].name = name; s.players[id].online = true; }
    if (!s.hostId) s.hostId = id;
    return { playerId: id };
  }
  if (!s.players[pid]) throw new Error('Unknown player - please rejoin');
  switch (a) {
    case 'addBuiltin': {
      const sc = { id: uid(), title: String(d.title || 'Scene').slice(0, 60), kind: 'builtin', key: d.key, owner: pid, createdBy: pid, takes: [] };
      if (!SCENES[sc.key]) throw new Error('Unknown scene');
      s.scenes.push(sc); hEvent('info', `${hName(pid)} added '${sc.title}'`); break;
    }
    case 'deleteScene': {
      const sc = hScene(d.sceneId);
      if (!(isHost || sc.createdBy === pid)) throw new Error("Only the host or the scene's creator can delete it");
      sc.takes.forEach(t => HOST.media.delete(t.src)); if (sc.src) HOST.media.delete(sc.src);
      s.scenes.splice(s.scenes.indexOf(sc), 1); break;
    }
    case 'give': {
      const sc = hScene(d.sceneId), to = d.to;
      if (!s.players[to]) throw new Error('Player not found');
      const free = !sc.owner || !s.players[sc.owner]?.online;
      if (!(sc.owner === pid || isHost || (free && to === pid))) throw new Error("You don't hold this scene");
      sc.owner = to;
      if (to === pid) hEvent('info', `${hName(pid)} grabbed '${sc.title}'`);
      else {
        hEvent('pass', `${hName(pid)} passed you '${sc.title}'`, { to, sceneId: sc.id });
        hEvent('info', `${hName(pid)} passed '${sc.title}' to ${hName(to)}`);
      }
      break;
    }
    case 'deleteTake': {
      const sc = hScene(d.sceneId), t = hTake(sc, d.takeId);
      if (!(isHost || t.playerId === pid || sc.owner === pid)) throw new Error('Not allowed');
      HOST.media.delete(t.src); sc.takes.splice(sc.takes.indexOf(t), 1); break;
    }
    case 'muteTake': hTake(hScene(d.sceneId), d.takeId).muted = !!d.muted; break;
    case 'react': hEvent('react', '', { emoji: String(d.emoji || '👏').slice(0, 4), fromName: hName(pid) }); break;
    case 'premiereStart': case 'premiereGo': case 'premiereEnd':
      if (!isHost) throw new Error('Only the host controls the premiere');
      if (a === 'premiereEnd') { s.phase = 'studio'; s.premiere = null; hEvent('info', 'The premiere is over - back to the studio!'); }
      else { s.phase = 'premiere'; s.premiere = { index: a === 'premiereStart' ? 0 : +d.index || 0, startedAt: Date.now() / 1000 + 2, token: uid(6) }; }
      break;
    default: throw new Error('Unknown action ' + a);
  }
  return {};
}
function hUpload(pid, kind, meta, blob) {
  if (!HOST.S.players[pid]) throw new Error('Unknown player');
  const id = uid(12);
  if (kind === 'video') {
    if (blob.size > MAX_VIDEO) throw new Error('Clip too big (max 60 MB)');
    HOST.media.set(id, blob);
    const title = String(meta.title || 'My clip').slice(0, 60);
    HOST.S.scenes.push({ id: uid(), title, kind: 'video', src: id, owner: pid, createdBy: pid, takes: [] });
    hEvent('info', `${hName(pid)} uploaded '${title}'`);
  } else {
    const sc = hScene(meta.sceneId);
    HOST.media.set(id, blob);
    sc.takes.push({ id: uid(), playerId: pid, playerName: hName(pid), src: id, offset: +meta.offset || 0, muted: false });
    hEvent('info', `${hName(pid)} recorded a voice for '${sc.title}'`);
  }
  return { mediaId: id };
}
function setupHostConn(c) {
  c.on('data', async msg => {
    try {
      if (msg.t === 'join') {
        const { playerId } = act('join', { playerId: msg.pid, name: msg.name });
        const old = HOST.conns.get(playerId); if (old && old !== c) old.close();
        c.pid = playerId; HOST.conns.set(playerId, c);
        c.send({ t: 'welcome', pid: playerId });
        commit();
      } else if (msg.t === 'ping') c.send({ t: 'pong', ct: msg.ct, st: Date.now() });
      else if (!c.pid) return;
      else if (msg.t === 'act') {
        try { const res = act(msg.a, { ...msg.d, playerId: c.pid }); commit(); c.send({ t: 'res', rid: msg.rid, ok: true, ...res }); }
        catch (e) { c.send({ t: 'res', rid: msg.rid, ok: false, error: e.message }); }
      } else if (msg.t === 'upload') {
        try { const res = hUpload(c.pid, msg.kind, msg.meta, new Blob([msg.data], { type: msg.type })); commit(); c.send({ t: 'res', rid: msg.rid, ok: true, ...res }); }
        catch (e) { c.send({ t: 'res', rid: msg.rid, ok: false, error: e.message }); }
      } else if (msg.t === 'getMedia') {
        const b = HOST.media.get(msg.id);
        c.send({ t: 'media', id: msg.id, type: b?.type || '', data: b ? await b.arrayBuffer() : null });
      }
    } catch (e) { console.warn(e); }
  });
  c.on('close', () => {
    if (c.pid && HOST.conns.get(c.pid) === c) {
      HOST.conns.delete(c.pid);
      const p = HOST.S.players[c.pid];
      if (p) { p.online = false; hEvent('info', `${p.name} left`); commit(); }
    }
  });
}
function hostGame(name) {
  return new Promise((resolve, reject) => {
    const code = Array.from(crypto.getRandomValues(new Uint8Array(5)), b => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[b % 31]).join('');
    const p = new Peer(ROOM_PREFIX + code, PEER_OPTS);
    let started = false;
    p.on('open', () => {
      started = true; peer = p; amHost = true; roomCode = code;
      HOST.S = newState();
      me.id = act('join', { name }).playerId; HOST.S.players[me.id].online = true;
      resolve(); commit();
    });
    p.on('connection', setupHostConn);
    p.on('disconnected', () => { try { p.reconnect(); } catch { } });
    p.on('error', e => {
      if (!started) { p.destroy(); e.type === 'unavailable-id' ? hostGame(name).then(resolve, reject) : reject(new Error('Could not reach the matchmaking server (' + e.type + ')')); }
      else console.warn('peer error', e.type);
    });
  });
}

// ================================================================== CLIENT side of the connection
function joinGame(code, name) {
  return new Promise((resolve, reject) => {
    const p = new Peer(PEER_OPTS);
    let done = false;
    const finish = err => { if (done) return; done = true; clearTimeout(timer); if (err) { p.destroy(); reject(err); } else resolve(); };
    const timer = setTimeout(() => finish(new Error("Couldn't connect to that game. Is the host still online?")), 20000);
    p.on('open', () => {
      const c = p.connect(ROOM_PREFIX + code, { reliable: true, serialization: 'binary' });
      c.on('open', () => c.send({ t: 'join', name, pid: localStorage.getItem('dub_pid_' + code) }));
      c.on('data', msg => {
        if (msg.t === 'welcome') {
          peer = p; hostConn = c; roomCode = code; me.id = msg.pid;
          localStorage.setItem('dub_pid_' + code, msg.pid);
          finish(); pingLoop();
        } else if (msg.t === 'state') onState(msg.s);
        else if (msg.t === 'res') { const r = pending.get(msg.rid); pending.delete(msg.rid); r && (msg.ok ? r.resolve(msg) : r.reject(new Error(msg.error))); }
        else if (msg.t === 'media') { const w = mediaWaiters.get(msg.id); mediaWaiters.delete(msg.id); w && (msg.data ? w.resolve(new Blob([msg.data], { type: msg.type })) : w.reject(new Error('Media missing'))); }
        else if (msg.t === 'pong') {
          const now = Date.now(), rtt = now - msg.ct;
          if (rtt < bestRtt * 1.5) { bestRtt = Math.min(bestRtt, rtt); clockOffset = msg.st - (msg.ct + now) / 2; }
        }
      });
      c.on('close', () => { if (done) hostGone(); });
      c.on('error', e => console.warn('conn error', e));
    });
    p.on('error', e => {
      if (e.type === 'peer-unavailable') finish(new Error(`No game found with code ${code}. Maybe the host closed it?`));
      else if (!done) finish(new Error('Connection problem (' + e.type + ')'));
    });
  });
}
async function pingLoop() { while (hostConn?.open) { hostConn.send({ t: 'ping', ct: Date.now() }); await sleep(bestRtt < Infinity ? 5000 : 500); } }
function hostGone() {
  stopAll(); prem.player.stop(); prem.mixer.stop();
  $('#booth').hidden = $('#premiere').hidden = $('#app').hidden = true;
  $('#join').hidden = false; renderJoin();
  $('#joinErr').textContent = 'The host left — the game is over. Host your own or join another one!';
}
function request(msg) {
  return new Promise((resolve, reject) => {
    if (!hostConn?.open) return reject(new Error('Not connected to the host'));
    msg.rid = ++rid; pending.set(msg.rid, { resolve, reject });
    hostConn.send(msg);
    setTimeout(() => { if (pending.delete(msg.rid)) reject(new Error('The host did not answer')); }, msg.t === 'upload' ? 300000 : 15000);
  });
}

// ================================================================== API used by the UI (same for host and players)
async function api(action, data = {}) {
  AC.resume();
  try {
    if (amHost) { const r = act(action, { ...data, playerId: me.id }); commit(); return r; }
    return await request({ t: 'act', a: action, d: data });
  } catch (e) { toast(esc(e.message), 'err'); throw e; }
}
async function upload(kind, meta, blob) {
  let res;
  if (amHost) { res = hUpload(me.id, kind, meta, blob); commit(); }
  else res = await request({ t: 'upload', kind, meta, type: blob.type, data: await blob.arrayBuffer() });
  mediaCache.set(res.mediaId, Promise.resolve(blob));
  return res;
}
function getMedia(id) {
  if (!mediaCache.has(id)) {
    const p = amHost
      ? (HOST.media.has(id) ? Promise.resolve(HOST.media.get(id)) : Promise.reject(new Error('Media missing')))
      : new Promise((resolve, reject) => {
        mediaWaiters.set(id, { resolve, reject }); hostConn.send({ t: 'getMedia', id });
        setTimeout(() => { if (mediaWaiters.delete(id)) reject(new Error('Download timed out')); }, 180000);
      });
    p.catch(() => mediaCache.delete(id));
    mediaCache.set(id, p);
  }
  return mediaCache.get(id);
}
const urlCache = new Map();
async function mediaURL(id) { if (!urlCache.has(id)) urlCache.set(id, URL.createObjectURL(await getMedia(id))); return urlCache.get(id); }

// ================================================================== helpers
function toast(html, cls = '', ms = 4500) {
  const el = document.createElement('div'); el.className = 'toast ' + cls; el.innerHTML = html;
  $('#toasts').append(el); setTimeout(() => el.remove(), ms); return el;
}
const player = id => S?.players.find(p => p.id === id);
const isHost = () => S && S.hostId === me.id;
function avatar(p) { return p ? `<span class="avatar" style="background:${esc(p.color)}">${esc(p.name[0]?.toUpperCase())}</span>` : '<span class="avatar" style="background:#555">?</span>'; }
const thumbCache = {};
function builtinThumb(key) {
  if (!thumbCache[key]) {
    const c = document.createElement('canvas'); c.width = SCENE_W; c.height = SCENE_H;
    SCENES[key].draw(c.getContext('2d'), SCENES[key].lines[1]?.start + 0.4 || 2);
    thumbCache[key] = c.toDataURL('image/jpeg', .7);
  }
  return thumbCache[key];
}
const inviteLink = () => location.origin + location.pathname + '#' + roomCode;
async function copyInvite() {
  try { await navigator.clipboard.writeText(inviteLink()); toast('Invite link copied! Send it to your friends 📨'); }
  catch { prompt('Copy this link and send it to your friends:', inviteLink()); }
}

// ================================================================== audio
const AC = new (window.AudioContext || window.webkitAudioContext)();
const bufCache = new Map();
function loadBuf(id) {
  if (!bufCache.has(id)) {
    const p = getMedia(id).then(b => b.arrayBuffer()).then(b => AC.decodeAudioData(b));
    p.catch(() => bufCache.delete(id)); bufCache.set(id, p);
  }
  return bufCache.get(id);
}
class Mixer {
  constructor() { this.bufs = []; this.nodes = []; this.ready = Promise.resolve(); this.key = null; }
  set(takes) {
    const list = takes.filter(t => !t.muted), key = list.map(t => t.id).join();
    if (key === this.key) return this.ready;
    this.key = key;
    return this.ready = Promise.all(list.map(t => loadBuf(t.src).then(buf => ({ buf, offset: t.offset })).catch(() => null)))
      .then(a => { if (this.key === key) this.bufs = a.filter(Boolean); });
  }
  play(from = 0, extra = []) {
    this.stop(); AC.resume();
    for (const b of [...this.bufs, ...extra]) {
      const off = from + b.offset;
      if (off >= b.buf.duration) continue;
      const n = AC.createBufferSource(); n.buffer = b.buf; n.connect(AC.destination); n.start(0, Math.max(0, off));
      this.nodes.push(n);
    }
  }
  stop() { for (const n of this.nodes) { try { n.stop(); } catch { } } this.nodes = []; }
}

// ================================================================== scene player
class ScenePlayer {
  constructor(el) { this.el = el; this.playing = false; this.onEnd = null; this.onTick = null; this.loadId = 0; }
  async load(scene) {
    const myLoad = ++this.loadId;
    this.stop(); this.el.innerHTML = ''; this.scene = scene; this.video = null; this.def = null;
    if (scene.kind === 'builtin') {
      this.def = SCENES[scene.key];
      const c = this.canvas = document.createElement('canvas'); c.width = SCENE_W; c.height = SCENE_H;
      this.ctx = c.getContext('2d'); this.el.append(c);
      this.duration = this.def.duration; this.draw(0);
    } else {
      this.el.innerHTML = '<div class="loading">⏳ Loading clip…</div>';
      this.duration = 30;
      let url; try { url = await mediaURL(scene.src); } catch { this.el.innerHTML = '<div class="loading">⚠ Could not load clip</div>'; return; }
      if (myLoad !== this.loadId) return;
      const v = this.video = document.createElement('video');
      v.src = url; v.muted = true; v.playsInline = true; v.preload = 'auto';
      this.el.innerHTML = ''; this.el.append(v);
      await new Promise(res => { v.onloadedmetadata = res; v.onerror = res; setTimeout(res, 8000); });
      this.duration = isFinite(v.duration) && v.duration > 0 ? v.duration : 30;
      v.onended = () => this._end();
    }
  }
  draw(t) { this.ctx.clearRect(0, 0, SCENE_W, SCENE_H); this.def.draw(this.ctx, t); }
  play(from = 0) {
    this.stop(); this.playing = true;
    if (this.def) {
      this.t0 = performance.now() - from * 1000;
      const loop = () => {
        if (!this.playing) return;
        const t = this.time();
        if (t >= this.duration) { this.draw(this.duration); return this._end(); }
        this.draw(t); this.onTick?.(t); this.raf = requestAnimationFrame(loop);
      };
      loop();
    } else if (this.video) {
      this.video.currentTime = from; this.video.play().catch(() => { });
      const loop = () => { if (!this.playing) return; this.onTick?.(this.time()); this.raf = requestAnimationFrame(loop); };
      loop();
    } else setTimeout(() => this._end(), 0);
  }
  time() { return this.def ? (performance.now() - this.t0) / 1000 : (this.video?.currentTime || 0); }
  stop() { this.playing = false; cancelAnimationFrame(this.raf); this.video?.pause(); }
  _end() { if (!this.playing) return; this.playing = false; this.onTick?.(this.duration); this.onEnd?.(); }
}

// ================================================================== start screen
const hashCode = () => (location.hash.slice(1).toUpperCase().match(/^[A-Z0-9]{5}$/) || [])[0];
function renderJoin() {
  const code = hashCode();
  $('#joinCodeBox').hidden = !!code;
  $('#joinLinkBtn').hidden = !code;
  $('#joinLinkBtn').textContent = `🎟 Join game ${code || ''}`;
  $('#hostBtn').className = code ? 'btn ghost' : 'btn big';
  $('#hostBtn').textContent = code ? 'or host your own game' : '🎬 Host a new game';
}
function nameOk() {
  const name = $('#nameInput').value.trim();
  if (!name) { $('#joinErr').textContent = 'Pick a name first!'; $('#nameInput').focus(); return null; }
  localStorage.setItem('dub_name', name); me.name = name; AC.resume(); return name;
}
function busyJoin(on, text) {
  for (const b of document.querySelectorAll('#join button')) b.disabled = on;
  $('#joinErr').textContent = on ? text : '';
}
function enterStudio() {
  $('#join').hidden = true; $('#app').hidden = false;
  history.replaceState(null, '', '#' + roomCode);
  lastVersion = 0; lastEventSeq = null; renderStudio();
}
async function doJoin(code) {
  const name = nameOk(); if (!name) return;
  code = code.toUpperCase().trim();
  if (!/^[A-Z0-9]{5}$/.test(code)) return $('#joinErr').textContent = 'A game code has 5 letters/numbers.';
  busyJoin(true, 'Connecting to the host…');
  try { await joinGame(code, name); busyJoin(false); enterStudio(); }
  catch (e) { busyJoin(false); $('#joinErr').textContent = e.message; }
}
$('#nameInput').value = me.name;
$('#hostBtn').onclick = async () => {
  const name = nameOk(); if (!name) return;
  busyJoin(true, 'Opening your studio…');
  try {
    await hostGame(name); busyJoin(false); enterStudio();
    toast('Your game is live! Click “Copy invite link” and send it to friends.', '', 7000);
  } catch (e) { busyJoin(false); $('#joinErr').textContent = e.message; }
};
$('#joinLinkBtn').onclick = () => doJoin(hashCode());
$('#joinCodeBtn').onclick = () => doJoin($('#codeInput').value);
$('#codeInput').onkeydown = e => { if (e.key === 'Enter') $('#joinCodeBtn').click(); };
$('#nameInput').onkeydown = e => { if (e.key === 'Enter') (hashCode() ? $('#joinLinkBtn') : $('#hostBtn')).click(); };
window.addEventListener('hashchange', () => { if (!roomCode) renderJoin(); });
window.addEventListener('beforeunload', e => { if (amHost) { e.preventDefault(); e.returnValue = ''; } });
renderJoin();

// ================================================================== state handling
function onState(s) {
  S = s;
  if (!amHost && s.serverNow && clockOffset === 0) clockOffset = s.serverNow * 1000 - Date.now();
  handleEvents();
  if (s.version !== lastVersion) {
    lastVersion = s.version;
    renderStudio();
    if (booth.sceneId) updateBooth();
  }
  handlePremiere();
}
function handleEvents() {
  const evs = S.events;
  if (lastEventSeq === null) { lastEventSeq = evs.length ? evs[evs.length - 1].seq : 0; return; }
  for (const e of evs) {
    if (e.seq <= lastEventSeq) continue;
    if (e.type === 'pass' && e.to === me.id) {
      const t = toast(`📬 ${esc(e.text)}! <button class="btn small">Open</button>`, '', 8000);
      t.querySelector('button').onclick = () => { t.remove(); openBooth(e.sceneId); };
    } else if (e.type === 'react') floater(e.emoji, e.fromName);
  }
  if (evs.length) lastEventSeq = Math.max(lastEventSeq, evs[evs.length - 1].seq);
}
function floater(emoji, from) {
  const el = document.createElement('div'); el.className = 'floater';
  el.style.left = (10 + Math.random() * 80) + '%';
  el.innerHTML = `${esc(emoji)}<small>${esc(from)}</small>`;
  $('#floaters').append(el); setTimeout(() => el.remove(), 3100);
}

// ================================================================== studio rendering
function syncList(container, items, key, html, emptyHtml) {
  if (!items.length) { container.innerHTML = emptyHtml; container._map = null; return; }
  const map = container._map || (container.innerHTML = '', new Map()), next = new Map();
  items.forEach((it, i) => {
    const k = key(it), h = html(it); let rec = map.get(k);
    if (!rec || rec.h !== h) {
      const tmp = document.createElement('div'); tmp.innerHTML = h.trim();
      const el = tmp.firstChild; rec?.el.replaceWith(el); rec = { h, el };
    }
    if (container.children[i] !== rec.el) container.insertBefore(rec.el, container.children[i] || null);
    next.set(k, rec);
  });
  for (const [k, rec] of map) if (!next.has(k)) rec.el.remove();
  container._map = next;
}
function sceneCard(s) {
  const holder = player(s.owner), mine = s.owner === me.id;
  const free = !holder || !holder.online;
  const voices = s.takes.length;
  const others = S.players.filter(p => p.id !== me.id);
  const thumb = s.kind === 'builtin'
    ? `<div class="thumb" style="background-image:url(${builtinThumb(s.key)})"><span class="badge">${SCENES[s.key].roles.map(r => esc(r.name)).join(' & ')}</span></div>`
    : `<div class="thumb clip">🎞<span class="badge">uploaded clip</span></div>`;
  let actions = `<button class="btn small" data-act="open" data-id="${s.id}">${mine ? '🎙 Dub it' : '▶ Watch'}</button>`;
  if (mine || isHost()) {
    const targets = isHost() && !mine ? S.players : others;
    if (targets.length) actions += `<select data-act="give" data-id="${s.id}"><option value="">${mine ? 'Pass to…' : 'Give to…'}</option>${targets.map(p => `<option value="${p.id}">${esc(p.name)}${p.id === me.id ? ' (me)' : ''}</option>`).join('')}</select>`;
  } else if (free) actions += `<button class="btn small" data-act="grab" data-id="${s.id}">✋ Grab</button>`;
  if (isHost() || s.createdBy === me.id) actions += `<button class="btn small ghost" data-act="del" data-id="${s.id}" title="Delete scene">🗑</button>`;
  return `<div class="card ${mine ? 'mine' : ''}">${thumb}<div class="card-body">
    <div class="card-title">${esc(s.title)}</div>
    <div class="card-meta">${avatar(holder)} ${holder ? esc(holder.name) + (holder.online ? '' : ' (offline)') : 'nobody'} has it · 🎙 ${voices} voice${voices === 1 ? '' : 's'}</div>
    <div class="card-actions">${actions}</div></div></div>`;
}
function renderStudio() {
  if (!S) return;
  const host = player(S.hostId);
  const withVoices = S.scenes.filter(s => s.takes.length).length;
  $('#hostBar').innerHTML = `<span class="room">Game <b>${esc(roomCode)}</b></span><button class="btn good" id="copyInvite">📋 Copy invite link</button>` + (isHost()
    ? `<button class="btn" id="startPrem" ${S.scenes.length ? '' : 'disabled'}>🍿 Start premiere (${withVoices || S.scenes.length} scenes)</button>`
    : `<span class="me-tag">👑 ${esc(host?.name || '?')} hosts &amp; starts the premiere</span>`);
  $('#copyInvite').onclick = copyInvite;
  $('#startPrem') && ($('#startPrem').onclick = () => api('premiereStart'));

  $('#playerList').innerHTML = S.players.map(p => `<li class="${p.online ? '' : 'off'}">${avatar(p)}<span>${esc(p.name)}</span>
    ${p.id === me.id ? '<span class="me-tag">(you)</span>' : ''}${p.isHost ? ' 👑' : ''}${p.online ? '' : ' <span class="me-tag">offline</span>'}</li>`).join('');
  $('#joinInfo').innerHTML = `Invite friends with this link:<br><b>${esc(inviteLink())}</b><br><span class="me-tag">or the code <b>${esc(roomCode)}</b></span>`
    + (isHost() ? '<br><br>⚠ You are hosting: keep this tab open, or the game ends for everyone.' : '');
  $('#activity').innerHTML = S.events.filter(e => e.type === 'info').slice(-12).reverse().map(e => `<li>${esc(e.text)}</li>`).join('');

  const mine = S.scenes.filter(s => s.owner === me.id), rest = S.scenes.filter(s => s.owner !== me.id);
  syncList($('#myScenes'), mine, s => s.id, sceneCard, '<div class="empty">You hold no scenes. Add one below, grab a free one, or wait until someone passes you one!</div>');
  syncList($('#allScenes'), rest, s => s.id, sceneCard, '<div class="empty">No other scenes yet.</div>');

  if (!$('#addScenes').children.length) {
    $('#addScenes').innerHTML = Object.values(SCENES).map(d => `<button class="add-tile" data-act="add" data-key="${d.key}">
      <img src="${builtinThumb(d.key)}" alt=""><div>${esc(d.title)}<br><span class="me-tag">${d.duration}s · ${d.roles.map(r => esc(r.name)).join(' & ')}</span></div></button>`).join('')
      + `<label class="add-tile upload"><div>📁 Upload your own clip<br><span class="me-tag">mp4 / webm, max 60 MB</span></div><input type="file" accept="video/*" id="uploadInput" hidden></label>`;
    $('#uploadInput').onchange = uploadVideo;
  }
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if (!b || b.tagName === 'SELECT') return;
  const id = b.dataset.id;
  switch (b.dataset.act) {
    case 'open': openBooth(id); break;
    case 'grab': api('give', { sceneId: id, to: me.id }); break;
    case 'del': if (confirm('Delete this scene and all its voices?')) api('deleteScene', { sceneId: id }); break;
    case 'add': api('addBuiltin', { key: b.dataset.key, title: SCENES[b.dataset.key].title }).then(() => toast('Scene added to your pile!')); break;
  }
});
document.addEventListener('change', e => {
  const sel = e.target.closest('select[data-act="give"]'); if (!sel || !sel.value) return;
  const to = sel.value; sel.value = '';
  api('give', { sceneId: sel.dataset.id, to }).then(() => { if (to !== me.id) toast(`Passed to ${esc(player(to)?.name)} ➜`); });
});
async function uploadVideo(e) {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  if (f.size > MAX_VIDEO) return toast('That clip is too big (max 60 MB). Try a shorter one!', 'err');
  const t = toast(`Uploading ${esc(f.name)}…`, '', 600000);
  try {
    await upload('video', { title: f.name.replace(/\.[^.]+$/, '') }, f.slice(0, f.size, f.type || 'video/mp4'));
    toast('Clip uploaded!');
  } catch (err) { toast('Upload failed: ' + esc(err.message), 'err'); }
  t.remove();
}

// ================================================================== dubbing booth
const booth = { sceneId: null, player: new ScenePlayer($('#boothStage')), mixer: new Mixer(), rec: null, pending: null, busy: false };
let micStream = null;

async function openBooth(sceneId) {
  const s = S.scenes.find(x => x.id === sceneId); if (!s) return;
  closeBooth();
  booth.sceneId = sceneId; booth.pending = null;
  $('#booth').hidden = false; $('#reviewBar').hidden = true;
  $('#boothTitle').textContent = '🎙 ' + s.title;
  updateBooth();
  setBusy(true);
  await booth.player.load(s);
  if (booth.sceneId !== sceneId) return;
  booth.player.onTick = t => setPlayhead(t);
  buildTimeline(s);
  setBusy(false);
}
function closeBooth() { stopAll(); booth.sceneId = null; $('#booth').hidden = true; }
$('#boothClose').onclick = closeBooth;

function buildTimeline(s) {
  const tl = $('#timeline'), dur = booth.player.duration;
  if (s.kind !== 'builtin') { tl.className = 'timeline video-only'; tl.innerHTML = '<div class="playhead"></div>'; return; }
  const def = SCENES[s.key];
  tl.className = 'timeline';
  tl.innerHTML = def.roles.map(r => `<div class="lane"><span class="lane-name">${esc(r.name)}</span>${def.lines.filter(l => l.role === r.name).map(l =>
    `<div class="line-seg" style="left:${l.start / dur * 100}%;width:${(l.end - l.start) / dur * 100}%;background:${r.color}" title="${esc(l.hint)}">${esc(r.name)}: ${esc(l.hint)}</div>`).join('')}</div>`).join('')
    + '<div class="playhead"></div>';
}
function setPlayhead(t) { const p = $('#timeline .playhead'); if (p) p.style.left = `calc(${Math.min(1, t / booth.player.duration) * 100}% - 1px)`; }

function updateBooth() {
  const s = S.scenes.find(x => x.id === booth.sceneId);
  if (!s) { closeBooth(); return toast('That scene was deleted', 'err'); }
  const mine = s.owner === me.id;
  booth.mixer.set(s.takes);
  $('#recBtn').disabled = !mine || booth.busy;
  $('#recBtn').title = mine ? '' : 'You need to hold this scene to record';
  $('#takeList').innerHTML = s.takes.length ? s.takes.map(t => {
    const p = player(t.playerId), canEdit = isHost() || t.playerId === me.id || mine;
    return `<li class="${t.muted ? 'muted' : ''}">${avatar(p)}<span class="grow">${esc(t.playerName)}'s voice</span>
      ${canEdit ? `<button class="btn small ghost" data-take="mute" data-tid="${t.id}" data-m="${t.muted ? 0 : 1}">${t.muted ? '🔇 Unmute' : '🔊 Mute'}</button>
      <button class="btn small ghost" data-take="del" data-tid="${t.id}">🗑</button>` : ''}</li>`;
  }).join('') : '<li class="me-tag">No voices yet — be the first!</li>';
  const holder = player(s.owner);
  const targets = S.players.filter(p => p.id !== s.owner);
  $('#passRow').innerHTML = (mine || isHost()) && targets.length
    ? `<b>${mine ? 'Done? Pass this scene to' : 'Give this scene to'}:</b> <select id="passSel">${targets.map(p => `<option value="${p.id}">${esc(p.name)}${p.online ? '' : ' (offline)'}</option>`).join('')}</select>
       <button class="btn good" id="passBtn">Pass ➜</button>`
    : `<span class="me-tag">${avatar(holder)} ${holder ? esc(holder.name) : 'Nobody'} holds this scene${mine ? ' — invite friends so you can pass it on!' : '. They can pass it to you.'}</span>`;
  if ($('#passBtn')) $('#passBtn').onclick = () => {
    const to = $('#passSel').value;
    api('give', { sceneId: s.id, to }).then(() => { toast(`Passed to ${esc(player(to)?.name)} ➜`); closeBooth(); });
  };
}
$('#takeList').onclick = e => {
  const b = e.target.closest('[data-take]'); if (!b) return;
  if (b.dataset.take === 'mute') api('muteTake', { sceneId: booth.sceneId, takeId: b.dataset.tid, muted: b.dataset.m === '1' });
  else if (confirm('Delete this voice?')) api('deleteTake', { sceneId: booth.sceneId, takeId: b.dataset.tid });
};

function stopAll() {
  if (booth.rec && booth.rec.state === 'recording') booth.rec.stop();
  booth.player.stop(); booth.mixer.stop();
  $('#stopBtn').hidden = true; $('#recDot').hidden = true; $('#countdown').hidden = true;
  setBusy(false);
}
function setBusy(b) {
  booth.busy = b;
  const s = S?.scenes.find(x => x.id === booth.sceneId);
  $('#watchBtn').disabled = b; $('#recBtn').disabled = b || !s || s.owner !== me.id;
  for (const id of ['#previewTakeBtn', '#saveTakeBtn', '#discardTakeBtn']) $(id).disabled = b;
}
$('#watchBtn').onclick = async () => {
  setBusy(true); $('#stopBtn').hidden = false;
  await booth.mixer.ready;
  booth.player.onEnd = stopAll;
  booth.player.play(0); booth.mixer.play(0);
};
$('#stopBtn').onclick = () => { if (booth.rec?.state === 'recording') finishRecording(); else stopAll(); };

async function getMic() {
  if (micStream) return micStream;
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Your browser does not allow the microphone here.');
  micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  return micStream;
}
$('#recBtn').onclick = async () => {
  let stream;
  try { stream = await getMic(); } catch (e) { return toast('🎤 ' + esc(e.message || 'Microphone not allowed'), 'err', 8000); }
  setBusy(true); $('#reviewBar').hidden = true; booth.pending = null;
  await booth.mixer.ready;
  const cd = $('#countdown'); cd.hidden = false;
  for (const n of [3, 2, 1]) { cd.textContent = n; await sleep(750); if (!booth.sceneId) return; }
  cd.hidden = true;
  const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find(m => window.MediaRecorder?.isTypeSupported(m)) || '';
  const rec = booth.rec = new MediaRecorder(stream, mime ? { mimeType: mime } : {});
  const chunks = [];
  rec.ondataavailable = e => e.data.size && chunks.push(e.data);
  rec.onstop = async () => {
    if (!booth.sceneId) return;
    const blob = new Blob(chunks, { type: (rec.mimeType || 'audio/webm').split(';')[0] });
    try {
      const buf = await AC.decodeAudioData(await blob.arrayBuffer());
      booth.pending = { blob, buf, offset: booth.recOffset };
      $('#reviewBar').hidden = false;
    } catch { toast('Recording failed — try again', 'err'); }
  };
  await new Promise(res => { rec.onstart = res; rec.start(); });
  const t0 = performance.now();
  booth.player.onEnd = finishRecording;
  booth.player.play(0);
  if ($('#hearOthers').checked) booth.mixer.play(0);
  booth.recOffset = (performance.now() - t0) / 1000;
  $('#recDot').hidden = false; $('#stopBtn').hidden = false;
};
function finishRecording() { if (booth.rec?.state === 'recording') booth.rec.stop(); stopAll(); }

$('#previewTakeBtn').onclick = async () => {
  if (!booth.pending) return;
  setBusy(true); $('#stopBtn').hidden = false;
  await booth.mixer.ready;
  booth.player.onEnd = stopAll;
  booth.player.play(0);
  booth.mixer.play(0, [{ buf: booth.pending.buf, offset: booth.pending.offset }]);
};
$('#discardTakeBtn').onclick = () => { booth.pending = null; $('#reviewBar').hidden = true; };
$('#saveTakeBtn').onclick = async () => {
  const p = booth.pending; if (!p) return;
  setBusy(true);
  try {
    const res = await upload('take', { sceneId: booth.sceneId, offset: p.offset }, p.blob);
    bufCache.set(res.mediaId, Promise.resolve(p.buf));
    booth.pending = null; $('#reviewBar').hidden = true;
    toast('Voice saved! 🎉 Pass the scene on when you\'re done.');
  } catch (e) { toast('Saving failed: ' + esc(e.message), 'err'); }
  setBusy(false);
};

// ================================================================== premiere
const prem = { token: null, player: new ScenePlayer($('#premStage')), mixer: new Mixer(), auto: true };
function playlist() {
  const voiced = S.scenes.filter(s => s.takes.some(t => !t.muted));
  return voiced.length ? voiced : S.scenes;
}
function handlePremiere() {
  const on = S.phase === 'premiere' && S.premiere;
  if (!on) {
    if (!$('#premiere').hidden) { prem.player.stop(); prem.mixer.stop(); $('#premiere').hidden = true; prem.token = null; }
    return;
  }
  if ($('#premiere').hidden) { closeBooth(); $('#premiere').hidden = false; }
  renderPremHost();
  if (S.premiere.token !== prem.token) { prem.token = S.premiere.token; runPremiereScene(S.premiere); }
}
function renderPremHost() {
  const idx = S.premiere.index, n = playlist().length;
  const html = isHost()
    ? `<button class="btn" data-prem="prev" ${idx <= 0 ? 'disabled' : ''}>⏮ Prev</button>
       <button class="btn" data-prem="replay">🔁 Replay</button>
       <button class="btn" data-prem="next" ${idx >= n ? 'disabled' : ''}>⏭ Next</button>
       <label class="chk"><input type="checkbox" id="autoAdv" ${prem.auto ? 'checked' : ''}> Auto-advance</label>
       <button class="btn ghost" data-prem="end">✖ End premiere</button>`
    : `<span class="me-tag">The host controls the show. Throw reactions!</span>`;
  if ($('#premHost')._h !== html) { $('#premHost').innerHTML = html; $('#premHost')._h = html; }
}
$('#premHost').onclick = e => {
  const b = e.target.closest('[data-prem]'); if (!b) return;
  const idx = S.premiere.index;
  if (b.dataset.prem === 'end') return api('premiereEnd');
  api('premiereGo', { index: { prev: idx - 1, replay: idx, next: idx + 1 }[b.dataset.prem] });
};
$('#premHost').onchange = e => { if (e.target.id === 'autoAdv') prem.auto = e.target.checked; };
document.querySelector('.reactions').onclick = e => { const b = e.target.closest('[data-e]'); if (b) api('react', { emoji: b.dataset.e }); };

function titleCard(html) { const c = $('#premCard'); c.hidden = !html; if (html) c.innerHTML = html; }
async function runPremiereScene(P) {
  const token = P.token;
  prem.player.stop(); prem.mixer.stop();
  const list = playlist(), s = list[P.index];
  if (!s) {
    $('#premTitle').textContent = '🍿 The End';
    const names = [...new Set(S.scenes.flatMap(x => x.takes.map(t => t.playerName)))];
    $('#premCredits').textContent = '';
    titleCard(`🎬 The End<small>Starring the voices of ${esc(names.join(', ') || 'nobody (yet)')}</small>`);
    return;
  }
  const voices = [...new Set(s.takes.filter(t => !t.muted).map(t => t.playerName))];
  $('#premTitle').textContent = `🍿 Scene ${P.index + 1} / ${list.length}`;
  $('#premCredits').textContent = voices.length ? 'Voices: ' + voices.join(', ') : 'No voices (silent film!)';
  titleCard(`${esc(s.title)}<small>${voices.length ? 'starring ' + esc(voices.join(' & ')) : 'a silent masterpiece'}</small>`);
  await prem.player.load(s);
  await prem.mixer.set(s.takes);
  if (prem.token !== token) return;
  const wait = P.startedAt - serverNow();
  if (wait > 0) await sleep(wait * 1000);
  if (prem.token !== token) return;
  const elapsed = Math.max(0, serverNow() - P.startedAt);
  if (elapsed >= prem.player.duration) { titleCard('⏳ Waiting for the next scene…'); return; }
  titleCard(null);
  prem.player.onEnd = () => {
    if (prem.token !== token) return;
    prem.mixer.stop();
    const last = P.index + 1 >= list.length;
    titleCard(last ? '🎬 That was the last scene!' : `⏭ Up next: ${esc(list[P.index + 1].title)}`);
    if (isHost() && prem.auto) setTimeout(() => { if (prem.token === token && S.phase === 'premiere') api('premiereGo', { index: P.index + 1 }); }, 2500);
  };
  prem.player.play(elapsed); prem.mixer.play(elapsed);
}
