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
// Scene = { id, title, kind: 'builtin'|'video', key|src, createdBy, duration,
//           roles: [{name, owner}], parts: [{id, role, start, end, hint}], takes: [{id, partId, playerId, playerName, src, at}] }
// A "part" is one line of one character. Each part gets at most one take; at playback all takes are stitched together.
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
function hDropTake(sc, t) { HOST.media.delete(t.src); sc.takes.splice(sc.takes.indexOf(t), 1); }
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
      const def = SCENES[d.key]; if (!def) throw new Error('Unknown scene');
      s.scenes.push({ id: uid(), title: def.title, kind: 'builtin', key: d.key, createdBy: pid, duration: def.duration,
        roles: def.roles.map(r => ({ name: r.name, owner: null })),
        parts: def.lines.map((l, i) => ({ id: 'p' + i, role: l.role, start: l.start, end: l.end, hint: l.hint })), takes: [] });
      hEvent('info', `${hName(pid)} added '${def.title}'`); break;
    }
    case 'deleteScene': {
      const sc = hScene(d.sceneId);
      if (!(isHost || sc.createdBy === pid)) throw new Error("Only the host or the scene's creator can delete it");
      sc.takes.forEach(t => HOST.media.delete(t.src)); if (sc.src) HOST.media.delete(sc.src);
      s.scenes.splice(s.scenes.indexOf(sc), 1); break;
    }
    case 'giveRole': {
      const sc = hScene(d.sceneId), r = sc.roles.find(x => x.name === d.role), to = d.to || null;
      if (!r) throw new Error('Character not found');
      if (to && !s.players[to]) throw new Error('Player not found');
      const free = !r.owner || !s.players[r.owner]?.online;
      if (!(r.owner === pid || isHost || sc.createdBy === pid || (free && to === pid))) throw new Error("That character isn't yours to give");
      r.owner = to;
      if (to === pid) hEvent('info', `${hName(pid)} voices ${r.name} in '${sc.title}'`);
      else if (to) {
        hEvent('pass', `${hName(pid)} gave you ${r.name} in '${sc.title}'`, { to, sceneId: sc.id });
        hEvent('info', `${hName(to)} now voices ${r.name} in '${sc.title}'`);
      }
      break;
    }
    case 'setParts': {
      const sc = hScene(d.sceneId);
      if (!(isHost || sc.createdBy === pid)) throw new Error('Only the host or whoever added the clip can cut it');
      const names = [...new Set((d.roles || []).map(n => String(n).trim().slice(0, 24)).filter(Boolean))].slice(0, 10);
      if (!names.length) throw new Error('Add at least one character');
      sc.roles = names.map(name => ({ name, owner: sc.roles.find(r => r.name === name)?.owner || null }));
      const dur = sc.duration || 600;
      const parts = (d.parts || []).slice(0, 80).map(p => ({ role: String(p.role), start: Math.max(0, +p.start || 0), end: Math.min(dur, +p.end || 0), hint: String(p.hint || '').slice(0, 60) }))
        .filter(p => names.includes(p.role) && p.end - p.start >= 0.2).sort((x, y) => x.start - y.start);
      sc.parts = parts.map(p => {
        const same = sc.parts.find(o => o.role === p.role && Math.abs(o.start - p.start) < 0.01 && Math.abs(o.end - p.end) < 0.01);
        return { id: same ? same.id : 'p' + uid(5), ...p };
      });
      for (const t of [...sc.takes]) if (!sc.parts.some(p => p.id === t.partId)) hDropTake(sc, t);
      hEvent('info', `${hName(pid)} cut '${sc.title}' into ${sc.parts.length} lines`); break;
    }
    case 'deleteTake': {
      const sc = hScene(d.sceneId), t = sc.takes.find(x => x.id === d.takeId);
      if (!t) throw new Error('Voice not found');
      if (!(isHost || t.playerId === pid)) throw new Error('Not allowed');
      hDropTake(sc, t); break;
    }
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
    const title = String(meta.title || 'My clip').slice(0, 60), dur = Math.max(1, +meta.duration || 30);
    HOST.media.set(id, blob);
    HOST.S.scenes.push({ id: uid(), title, kind: 'video', src: id, createdBy: pid, duration: dur,
      roles: [{ name: 'Character 1', owner: null }, { name: 'Character 2', owner: null }],
      parts: [{ id: 'p0', role: 'Character 1', start: 0, end: dur, hint: 'whole clip - cut it into lines!' }], takes: [] });
    hEvent('info', `${hName(pid)} uploaded '${title}'`);
  } else {
    const sc = hScene(meta.sceneId), part = sc.parts.find(p => p.id === meta.partId);
    if (!part) throw new Error('That line no longer exists');
    const role = sc.roles.find(r => r.name === part.role);
    if (role?.owner !== pid && pid !== HOST.S.hostId) throw new Error(`You don't voice ${part.role} any more`);
    for (const t of sc.takes.filter(t => t.partId === part.id)) hDropTake(sc, t);
    HOST.media.set(id, blob);
    sc.takes.push({ id: uid(), partId: part.id, playerId: pid, playerName: hName(pid), src: id, at: +meta.at || 0 });
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
// Each recorded line is clipped to its window [s0, s1] (scene time) and placed so that audio time 0 = scene time `at`.
const PRE = 0.25, POST = 0.6, LEAD = 1.5;
function clipItem(buf, at, part) { return { buf, at, s0: part.start - PRE, s1: part.end + POST, partId: part.id }; }
class Mixer {
  constructor() { this.items = []; this.nodes = []; this.ready = Promise.resolve(); this.key = null; }
  set(scene) {
    const list = scene.takes.map(t => ({ t, part: scene.parts.find(p => p.id === t.partId) })).filter(x => x.part);
    const key = list.map(x => x.t.id + x.part.start + x.part.end).join();
    if (key === this.key) return this.ready;
    this.key = key;
    return this.ready = Promise.all(list.map(({ t, part }) => loadBuf(t.src).then(buf => clipItem(buf, t.at, part)).catch(() => null)))
      .then(a => { if (this.key === key) this.items = a.filter(Boolean); });
  }
  play(from = 0, extra = [], excludePart = null) {
    this.stop(); AC.resume();
    const now = AC.currentTime + 0.02;
    for (const it of [...this.items.filter(i => i.partId !== excludePart), ...extra]) {
      const start = Math.max(it.s0, from, it.at);
      const end = Math.min(it.s1, it.at + it.buf.duration);
      if (start >= end) continue;
      const n = AC.createBufferSource(); n.buffer = it.buf; n.connect(AC.destination);
      n.start(now + (start - from), start - it.at, end - start);
      this.nodes.push(n);
    }
  }
  stop() { for (const n of this.nodes) { try { n.stop(); } catch { } } this.nodes = []; }
}

// ================================================================== scene player
class ScenePlayer {
  constructor(el) { this.el = el; this.playing = false; this.onEnd = null; this.onTick = null; this.loadId = 0; this.until = 0; }
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
      this.duration = scene.duration || 30;
      let url; try { url = await mediaURL(scene.src); } catch { this.el.innerHTML = '<div class="loading">⚠ Could not load clip</div>'; return; }
      if (myLoad !== this.loadId) return;
      const v = this.video = document.createElement('video');
      v.src = url; v.muted = true; v.playsInline = true; v.preload = 'auto';
      this.el.innerHTML = ''; this.el.append(v);
      await new Promise(res => { v.onloadedmetadata = res; v.onerror = res; setTimeout(res, 8000); });
      if (isFinite(v.duration) && v.duration > 0) this.duration = v.duration;
      v.onended = () => this._end();
    }
  }
  draw(t) { this.ctx.clearRect(0, 0, SCENE_W, SCENE_H); this.def.draw(this.ctx, t); }
  seek(t) { this.stop(); if (this.def) this.draw(t); else if (this.video) this.video.currentTime = t; this.onTick?.(t); }
  play(from = 0, until = Infinity) {
    this.stop(); this.playing = true; this.until = Math.min(until, this.duration);
    if (this.def) this.t0 = performance.now() - from * 1000;
    else if (this.video) { this.video.currentTime = from; this.video.play().catch(() => { }); }
    else return setTimeout(() => this._end(), 0);
    const loop = () => {
      if (!this.playing) return;
      const t = this.time();
      if (t >= this.until) { if (this.def) this.draw(this.until); else this.video.pause(); return this._end(); }
      if (this.def) this.draw(t);
      this.onTick?.(t); this.raf = requestAnimationFrame(loop);
    };
    loop();
  }
  time() { return this.def ? (performance.now() - this.t0) / 1000 : (this.video?.currentTime || 0); }
  stop() { this.playing = false; cancelAnimationFrame(this.raf); this.video?.pause(); }
  _end() { if (!this.playing) return; this.playing = false; this.onTick?.(Math.min(this.time(), this.until)); this.onEnd?.(); }
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
const ROLE_COLORS = ['#4dabf7', '#ff922b', '#69db7c', '#da77f2', '#ffd43b', '#f783ac', '#38d9a9', '#ff6b6b', '#a9e34b', '#748ffc'];
function roleColor(sc, name, roles = sc.roles) {
  if (sc.kind === 'builtin') { const r = SCENES[sc.key]?.roles.find(x => x.name === name); if (r) return r.color; }
  const i = roles.findIndex(r => (r.name ?? r) === name);
  return ROLE_COLORS[(i < 0 ? 0 : i) % ROLE_COLORS.length];
}
const fmt = t => (Math.round(t * 10) / 10).toFixed(1) + 's';
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
const voicesMe = sc => sc.roles.some(r => r.owner === me.id);
function sceneCard(s) {
  const done = s.parts.filter(p => s.takes.some(t => t.partId === p.id)).length;
  const thumb = s.kind === 'builtin'
    ? `<div class="thumb" style="background-image:url(${builtinThumb(s.key)})"><span class="badge">${s.parts.length} lines</span></div>`
    : `<div class="thumb clip">🎞<span class="badge">uploaded clip · ${s.parts.length} line${s.parts.length === 1 ? '' : 's'}</span></div>`;
  const chips = s.roles.map(r => {
    const p = player(r.owner);
    return `<span class="chip"><span class="dot" style="width:8px;height:8px;border-radius:50%;background:${roleColor(s, r.name)}"></span>${esc(r.name)}: ${p ? esc(p.name) : '<i>free</i>'}</span>`;
  }).join('');
  let actions = `<button class="btn small" data-act="open" data-id="${s.id}">${voicesMe(s) ? '🎙 Record my lines' : '▶ Open'}</button>`;
  if (isHost() || s.createdBy === me.id) actions += `<button class="btn small ghost" data-act="del" data-id="${s.id}" title="Delete scene">🗑</button>`;
  return `<div class="card ${voicesMe(s) ? 'mine' : ''}">${thumb}<div class="card-body">
    <div class="card-title">${esc(s.title)}</div>
    <div class="chips">${chips}</div>
    <div class="progress" title="${done} of ${s.parts.length} lines recorded"><i style="width:${s.parts.length ? done / s.parts.length * 100 : 0}%"></i></div>
    <div class="card-meta">🎙 ${done} / ${s.parts.length} lines recorded</div>
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

  const mine = S.scenes.filter(s => voicesMe(s) || s.createdBy === me.id), rest = S.scenes.filter(s => !mine.includes(s));
  syncList($('#myScenes'), mine, s => s.id, sceneCard, '<div class="empty">No scenes yet. Add one below, or open a friend\'s scene and pick a character to voice!</div>');
  syncList($('#allScenes'), rest, s => s.id, sceneCard, '<div class="empty">No other scenes yet.</div>');

  if (!$('#addScenes').children.length) {
    $('#addScenes').innerHTML = Object.values(SCENES).map(d => `<button class="add-tile" data-act="add" data-key="${d.key}">
      <img src="${builtinThumb(d.key)}" alt=""><div>${esc(d.title)}<br><span class="me-tag">${d.duration}s · ${d.roles.map(r => esc(r.name)).join(' & ')}</span></div></button>`).join('')
      + `<label class="add-tile upload"><div>📁 Upload your own clip<br><span class="me-tag">mp4 / webm, max 60 MB.<br>The game cuts it into lines.</span></div><input type="file" accept="video/*" id="uploadInput" hidden></label>`;
    $('#uploadInput').onchange = uploadVideo;
  }
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if (!b || b.tagName === 'SELECT') return;
  const id = b.dataset.id;
  switch (b.dataset.act) {
    case 'open': openBooth(id); break;
    case 'del': if (confirm('Delete this scene and all its voices?')) api('deleteScene', { sceneId: id }); break;
    case 'add': api('addBuiltin', { key: b.dataset.key }).then(() => toast('Scene added! Open it and pick who voices which character.')); break;
  }
});
function videoDuration(file) {
  return new Promise(res => {
    const v = document.createElement('video'), url = URL.createObjectURL(file);
    const done = d => { URL.revokeObjectURL(url); res(d); };
    v.preload = 'metadata'; v.onloadedmetadata = () => done(isFinite(v.duration) ? v.duration : 30); v.onerror = () => done(30);
    v.src = url; setTimeout(() => done(30), 10000);
  });
}
async function uploadVideo(e) {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  if (f.size > MAX_VIDEO) return toast('That clip is too big (max 60 MB). Try a shorter one!', 'err');
  const t = toast(`Uploading ${esc(f.name)}…`, '', 600000);
  try {
    const duration = await videoDuration(f);
    await upload('video', { title: f.name.replace(/\.[^.]+$/, ''), duration }, f.slice(0, f.size, f.type || 'video/mp4'));
    toast('Clip uploaded! Open it and press “✂ Cut this clip into lines”.', '', 7000);
  } catch (err) { toast('Upload failed: ' + esc(err.message), 'err'); }
  t.remove();
}

// ================================================================== dubbing booth
const booth = { sceneId: null, player: new ScenePlayer($('#boothStage')), mixer: new Mixer(), rec: null, pending: null, busy: false, sel: null, recPart: null };
const ed = { open: false, roles: [], parts: [] };
let micStream = null;
const bScene = () => S?.scenes.find(x => x.id === booth.sceneId);

async function openBooth(sceneId) {
  const s = S.scenes.find(x => x.id === sceneId); if (!s) return;
  closeBooth();
  booth.sceneId = sceneId; booth.pending = null; booth.sel = null; ed.open = false;
  $('#booth').hidden = false; $('#reviewBar').hidden = true;
  $('#boothTitle').textContent = '🎙 ' + s.title;
  $('#origRow').hidden = s.kind !== 'video';
  $('#timeline').innerHTML = '';
  setBusy(true);
  updateBooth();
  await booth.player.load(s);
  if (booth.sceneId !== sceneId) return;
  booth.player.onTick = onBoothTick;
  setBusy(false);
  updateBooth();
}
function closeBooth() { if (cut.sceneId) closeCutter(true); stopAll(); booth.sceneId = null; ed.open = false; $('#booth').hidden = true; }
$('#boothClose').onclick = closeBooth;

function buildTimeline(sc) {
  const tl = $('#timeline'), dur = booth.player.duration || sc.duration || 1;
  const roles = ed.open ? ed.roles : sc.roles.map(r => r.name), parts = ed.open ? ed.parts : sc.parts;
  tl.className = 'timeline';
  tl.innerHTML = roles.map(name => {
    const owner = player(sc.roles.find(r => r.name === name)?.owner);
    return `<div class="lane"><span class="lane-name">${esc(name)}${owner ? ' · ' + esc(owner.name) : ''}</span>${parts.map((p, i) => p.role !== name ? '' :
      `<div class="line-seg ${!ed.open && sc.takes.some(t => t.partId === p.id) ? 'done' : ''} ${!ed.open && owner?.id === me.id ? 'mine' : ''}" data-seg="${ed.open ? i : p.id}"
        style="left:${p.start / dur * 100}%;width:${Math.max(0.5, (p.end - p.start) / dur * 100)}%;background:${roleColor(sc, name, roles)}" title="${esc(p.hint)}">${esc(p.hint || name)}</div>`).join('')}</div>`;
  }).join('') + '<div class="playhead"></div>';
  setPlayhead(booth.player.time ? Math.min(booth.player.time() || 0, dur) : 0);
}
function setPlayhead(t) { const p = $('#timeline .playhead'); if (p) p.style.left = `calc(${Math.min(1, t / (booth.player.duration || 1)) * 100}% - 1px)`; }
$('#timeline').onclick = e => {
  const seg = e.target.closest('[data-seg]');
  if (seg) {
    const sc = bScene(), p = ed.open ? ed.parts[+seg.dataset.seg] : sc.parts.find(x => x.id === seg.dataset.seg);
    if (!p) return;
    if (!ed.open) { booth.sel = p.id; renderParts(sc); }
    if (!booth.busy) booth.player.seek(p.start);
    return;
  }
  if (booth.busy && !ed.open) return;
  const r = $('#timeline').getBoundingClientRect();
  booth.player.seek((e.clientX - r.left) / r.width * booth.player.duration);
};
function onBoothTick(t) {
  setPlayhead(t);
  const cue = $('#cue'), sc = bScene(), p = booth.recPart && sc?.parts.find(x => x.id === booth.recPart);
  if (!p || !booth.player.playing) { cue.hidden = true; return; }
  cue.hidden = false;
  if (t < p.start) { cue.className = 'cue'; cue.textContent = `Get ready… ${Math.ceil(p.start - t)}`; }
  else if (t <= p.end) { cue.className = 'cue go'; cue.textContent = `🗣 ${p.role}: SPEAK!`; }
  else { cue.className = 'cue'; cue.textContent = '…'; }
}

function updateBooth() {
  const sc = bScene();
  if (!sc) { closeBooth(); return toast('That scene was deleted', 'err'); }
  booth.mixer.set(sc);
  if (booth.player.duration) buildTimeline(sc);
  renderRoles(sc); renderParts(sc); renderEditor(sc);
  setBusy(booth.busy);
}
function renderRoles(sc) {
  const canManage = isHost() || sc.createdBy === me.id;
  $('#roleList').innerHTML = sc.roles.map(r => {
    const p = player(r.owner), mine = r.owner === me.id, free = !p || !p.online;
    let actions = '';
    if (!mine && free) actions += `<button class="btn small good" data-role-grab="${esc(r.name)}">✋ I'll voice this</button>`;
    if (mine || canManage) actions += `<select data-role-give="${esc(r.name)}"><option value="">${mine ? 'Give to…' : 'Assign…'}</option>${S.players.filter(x => x.id !== r.owner).map(x => `<option value="${x.id}">${esc(x.name)}${x.id === me.id ? ' (me)' : ''}</option>`).join('')}${r.owner ? '<option value="__none">nobody</option>' : ''}</select>`;
    const n = sc.parts.filter(x => x.role === r.name).length;
    return `<li><span class="dot" style="background:${roleColor(sc, r.name)}"></span><span class="grow"><b>${esc(r.name)}</b> <span class="me-tag">${n} line${n === 1 ? '' : 's'}</span><br>
      ${p ? avatar(p) + ' ' + esc(p.name) + (mine ? ' (you)' : '') : '<span class="me-tag">nobody yet</span>'}</span>${actions}</li>`;
  }).join('');
}
$('#roleList').onclick = e => { const b = e.target.closest('[data-role-grab]'); if (b) api('giveRole', { sceneId: booth.sceneId, role: b.dataset.roleGrab, to: me.id }); };
$('#roleList').onchange = e => {
  const s = e.target.closest('[data-role-give]'); if (!s || !s.value) return;
  const to = s.value === '__none' ? null : s.value; s.value = '';
  api('giveRole', { sceneId: booth.sceneId, role: s.dataset.roleGive, to }).then(() => { if (to && to !== me.id) toast(`${esc(player(to)?.name)} now voices ${esc(s.dataset.roleGive)} ➜`); });
};
function renderParts(sc) {
  if (!sc.parts.length) { $('#partList').innerHTML = '<li class="me-tag">No lines yet — cut the clip first.</li>'; return; }
  $('#partList').innerHTML = sc.parts.map((p, i) => {
    const owner = player(sc.roles.find(r => r.name === p.role)?.owner), mine = owner?.id === me.id;
    const take = sc.takes.find(t => t.partId === p.id);
    const canDel = take && (isHost() || take.playerId === me.id);
    return `<li class="${booth.sel === p.id ? 'sel' : ''}" data-part="${p.id}"><span class="dot" style="background:${roleColor(sc, p.role)}"></span>
      <span class="grow"><b>${i + 1}. ${esc(p.role)}</b> <span class="me-tag">${fmt(p.start)}–${fmt(p.end)}</span>${p.hint ? `<br><span class="me-tag">“${esc(p.hint)}”</span>` : ''}<br>
      ${take ? `<span class="status-ok">✔ ${esc(take.playerName)}</span>` : `<span class="status-no">○ ${owner ? 'waiting for ' + esc(owner.name) : 'nobody voices this yet'}</span>`}</span>
      <button class="btn small ghost" data-pact="watch" title="Watch this line">▶</button>
      ${mine ? `<button class="btn small rec" data-pact="rec">${take ? '🔁 Redo' : '● Record'}</button>` : ''}
      ${canDel ? '<button class="btn small ghost" data-pact="del" title="Delete this recording">🗑</button>' : ''}</li>`;
  }).join('');
}
$('#partList').onclick = e => {
  const li = e.target.closest('[data-part]'); if (!li) return;
  const sc = bScene(), p = sc.parts.find(x => x.id === li.dataset.part); if (!p) return;
  booth.sel = p.id;
  const b = e.target.closest('[data-pact]');
  if (!b) { renderParts(sc); if (!booth.busy) booth.player.seek(p.start); return; }
  if (booth.busy) return;
  if (b.dataset.pact === 'watch') watchPart(p);
  else if (b.dataset.pact === 'rec') recordPart(p);
  else if (b.dataset.pact === 'del') { const t = sc.takes.find(x => x.partId === p.id); if (t && confirm('Delete this recording?')) api('deleteTake', { sceneId: sc.id, takeId: t.id }); }
};

function stopAll() {
  if (booth.rec && booth.rec.state === 'recording') booth.rec.stop();
  booth.player.stop(); booth.mixer.stop();
  $('#stopBtn').hidden = true; $('#recDot').hidden = true; $('#countdown').hidden = true; $('#cue').hidden = true;
  setBusy(false);
}
function setBusy(b) {
  booth.busy = b;
  $('#watchBtn').disabled = b;
  for (const el of document.querySelectorAll('#partList [data-pact], #previewTakeBtn, #saveTakeBtn, #discardTakeBtn')) el.disabled = b;
}
const lineWindow = p => [Math.max(0, p.start - LEAD), Math.min(booth.player.duration, p.end + POST)];
$('#watchBtn').onclick = async () => {
  if (ed.open) return toast('Save or cancel the cut first', 'err');
  muteClip(); booth.recPart = null; setBusy(true); $('#stopBtn').hidden = false;
  await booth.mixer.ready;
  booth.player.onEnd = stopAll;
  booth.player.play(0); booth.mixer.play(0);
};
async function watchPart(p) {
  clipSound(wantOrig()); booth.recPart = null; setBusy(true); $('#stopBtn').hidden = false;
  await booth.mixer.ready;
  const [a, b] = lineWindow(p);
  booth.player.onEnd = stopAll;
  booth.player.play(a, b); booth.mixer.play(a);
}
$('#stopBtn').onclick = () => { if (booth.rec?.state === 'recording') finishRecording(); else stopAll(); };

async function getMic() {
  if (micStream) return micStream;
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Your browser does not allow the microphone here.');
  micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  return micStream;
}
function muteClip() { clipSound(false); }
// Original clip sound: on when watching/recording a single line (so you hear what to dub), off for dubbed playback.
function clipSound(on) {
  const v = booth.player.video; if (!v) return;
  v.muted = !on; v.volume = +$('#origVol').value;
}
const wantOrig = () => $('#hearOrig').checked;
$('#origVol').oninput = () => { if (booth.player.video) booth.player.video.volume = +$('#origVol').value; };
async function recordPart(p) {
  if (ed.open) return toast('Save or cancel the cut first', 'err');
  clipSound(wantOrig());
  let stream;
  try { stream = await getMic(); } catch (e) { return toast('🎤 ' + esc(e.message || 'Microphone not allowed'), 'err', 8000); }
  setBusy(true); $('#reviewBar').hidden = true; booth.pending = null; booth.recPart = p.id;
  await booth.mixer.ready;
  const [a, b] = lineWindow(p);
  booth.player.seek(a);
  const cd = $('#countdown'); cd.hidden = false;
  for (const n of [3, 2, 1]) { cd.textContent = n; await sleep(700); if (!booth.sceneId) return; }
  cd.hidden = true;
  const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find(m => window.MediaRecorder?.isTypeSupported(m)) || '';
  const rec = booth.rec = new MediaRecorder(stream, mime ? { mimeType: mime } : {});
  const chunks = [];
  let at = a;
  rec.ondataavailable = e => e.data.size && chunks.push(e.data);
  rec.onstop = async () => {
    if (!booth.sceneId) return;
    const blob = new Blob(chunks, { type: (rec.mimeType || 'audio/webm').split(';')[0] });
    try {
      const buf = await AC.decodeAudioData(await blob.arrayBuffer());
      booth.pending = { blob, buf, at, part: p };
      $('#reviewText').textContent = `${p.role}'s line recorded!`;
      $('#reviewBar').hidden = false;
    } catch { toast('Recording failed — try again', 'err'); }
  };
  await new Promise(res => { rec.onstart = res; rec.start(); });
  const t0 = performance.now();
  booth.player.onEnd = finishRecording;
  booth.player.play(a, b);
  if ($('#hearOthers').checked) booth.mixer.play(a, [], p.id);
  at = a - (performance.now() - t0) / 1000;
  $('#recDot').hidden = false; $('#stopBtn').hidden = false;
}
function finishRecording() { if (booth.rec?.state === 'recording') booth.rec.stop(); stopAll(); }

$('#previewTakeBtn').onclick = async () => {
  const pd = booth.pending; if (!pd) return;
  muteClip(); booth.recPart = null; setBusy(true); $('#stopBtn').hidden = false;
  await booth.mixer.ready;
  const [a, b] = lineWindow(pd.part);
  booth.player.onEnd = stopAll;
  booth.player.play(a, b);
  booth.mixer.play(a, [clipItem(pd.buf, pd.at, pd.part)], pd.part.id);
};
$('#discardTakeBtn').onclick = () => { booth.pending = null; $('#reviewBar').hidden = true; };
$('#saveTakeBtn').onclick = async () => {
  const pd = booth.pending; if (!pd) return;
  setBusy(true);
  try {
    const res = await upload('take', { sceneId: booth.sceneId, partId: pd.part.id, at: pd.at }, pd.blob);
    bufCache.set(res.mediaId, Promise.resolve(pd.buf));
    booth.pending = null; $('#reviewBar').hidden = true;
    const sc = bScene(), next = sc?.parts.find(x => x.start > pd.part.start && sc.roles.find(r => r.name === x.role)?.owner === me.id && !sc.takes.some(t => t.partId === x.id));
    toast(next ? `Saved! 🎉 Next up: your line ${sc.parts.indexOf(next) + 1}` : 'Saved! 🎉');
    if (next) { booth.sel = next.id; renderParts(sc); }
  } catch (e) { toast('Saving failed: ' + esc(e.message), 'err'); }
  setBusy(false);
};

// ------------------------------------------------------------------ cutting room (uploaded clips)
const cut = { sceneId: null, roles: [], parts: [], open: null, sel: null, pick: null, dur: 1, stopAt: null, resume: false, dirty: false, raf: 0 };
const cv = () => $('#cutVideo');
function renderEditor(sc) {
  const box = $('#editorBox');
  if (sc.kind !== 'video' || !(isHost() || sc.createdBy === me.id)) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="pass-row"><button class="btn" id="openCutter">✂ Open the cutting room</button>
    <span class="me-tag">Play the clip, mark where each line starts and ends, and say which character speaks it.</span></div>`;
  $('#openCutter').onclick = () => openCutter(sc);
}
async function openCutter(sc) {
  stopAll();
  Object.assign(cut, { sceneId: sc.id, roles: sc.roles.map(r => r.name), parts: sc.parts.map(p => ({ ...p })), open: null, sel: null, pick: null, stopAt: null, dirty: false });
  // a fresh upload has one placeholder line covering the whole clip: drop it so the user starts clean
  if (cut.parts.length === 1 && cut.parts[0].start === 0 && Math.abs(cut.parts[0].end - sc.duration) < 0.05 && !sc.takes.length) cut.parts = [];
  $('#cutter').hidden = false;
  $('#cutTitle').textContent = '✂ Cutting room — ' + sc.title;
  const v = cv(); v.muted = false; v.playbackRate = +$('#cutSpeed').value;
  try { v.src = await mediaURL(sc.src); } catch { toast('Could not load the clip', 'err'); return closeCutter(true); }
  await new Promise(res => { if (v.readyState >= 1) res(); v.onloadedmetadata = res; v.onerror = res; setTimeout(res, 8000); });
  cut.dur = isFinite(v.duration) && v.duration > 0 ? v.duration : sc.duration || 30;
  v.currentTime = 0;
  renderCutter();
  cancelAnimationFrame(cut.raf); cutLoop();
}
function closeCutter(force) {
  if (!force && cut.dirty && !confirm('Throw away your changes to the cut?')) return;
  cv().pause(); cancelAnimationFrame(cut.raf);
  $('#cutter').hidden = true; cut.sceneId = null;
}
const cutT = () => cv().currentTime || 0;
const cutColor = name => ROLE_COLORS[Math.max(0, cut.roles.indexOf(name)) % ROLE_COLORS.length];
function cutSeek(t) { cv().currentTime = Math.max(0, Math.min(cut.dur - 0.01, t)); cut.stopAt = null; }
function cutPlay(on = cv().paused) {
  if (cut.pick) return;
  if (on) cv().play().catch(() => { }); else cv().pause();
}
function cutLoop() {
  if (!cut.sceneId) return;
  const t = cutT(), v = cv();
  if (cut.stopAt !== null && t >= cut.stopAt) { v.pause(); cut.stopAt = null; }
  $('#cutClock').textContent = `${t.toFixed(1)} / ${cut.dur.toFixed(1)}s`;
  $('#cutPlayBtn').textContent = v.paused ? '▶ Play' : '⏸ Pause';
  const head = $('#cutTimeline .playhead'); if (head) head.style.left = `calc(${t / cut.dur * 100}% - 1px)`;
  const pend = $('#cutTimeline .pending-seg');
  if (pend) { const a = cut.open, b = Math.max(a, t); pend.style.left = a / cut.dur * 100 + '%'; pend.style.width = Math.max(0.3, (b - a) / cut.dur * 100) + '%'; }
  const badge = $('#cutOpenBadge');
  badge.hidden = cut.open === null || !!cut.pick;
  if (!badge.hidden) badge.textContent = `● Line started at ${cut.open.toFixed(1)}s — press 🔴 End line (E)`;
  cut.raf = requestAnimationFrame(cutLoop);
}
function renderCutter() { renderCutTimeline(); renderCutRoles(); renderCutSel(); renderCutList(); renderCutPick(); }
function renderCutTimeline() {
  const lanes = cut.roles.map(name => `<div class="lane"><span class="lane-name">${esc(name)}</span>${cut.parts.map((p, i) => p.role !== name ? '' :
    `<div class="line-seg ${cut.sel === i ? 'sel' : ''}" data-ci="${i}" style="left:${p.start / cut.dur * 100}%;width:${Math.max(0.5, (p.end - p.start) / cut.dur * 100)}%;background:${cutColor(name)}">${i + 1}${p.hint ? ' · ' + esc(p.hint) : ''}</div>`).join('')}</div>`).join('');
  const pending = cut.open !== null ? '<div class="lane"><span class="lane-name">new line…</span><div class="pending-seg"></div></div>' : '';
  $('#cutTimeline').innerHTML = pending + lanes + '<div class="playhead"></div>';
}
function renderCutRoles() {
  $('#cutRoles').innerHTML = `<div class="chips">${cut.roles.map((r, i) => `<span class="chip"><span class="dot" style="width:10px;height:10px;border-radius:50%;background:${cutColor(r)}"></span>
    <input data-crname="${i}" value="${esc(r)}" title="Rename"><a href="#" data-cut="delrole" data-i="${i}" title="Remove character">✕</a></span>`).join('')}
    <button class="btn small" data-cut="addrole">+ Character</button></div>`;
}
function renderCutSel() {
  const p = cut.parts[cut.sel];
  if (!p) { $('#cutSel').innerHTML = '<span class="me-tag">Click a line in the timeline or the list to fine-tune it.</span>'; return; }
  $('#cutSel').innerHTML = `
    <div class="row"><b>Line ${cut.sel + 1}</b> <select data-cf="role">${cut.roles.map(r => `<option ${r === p.role ? 'selected' : ''}>${esc(r)}</option>`).join('')}</select>
      <button class="btn small" data-cut="playsel">▶ Play line</button><button class="btn small ghost" data-cut="delsel">🗑 Delete</button></div>
    <div class="row">Start <button class="btn small ghost" data-cut="nudge" data-f="start" data-d="-0.1">−</button><input type="number" step="0.1" data-cf="start" value="${p.start.toFixed(1)}"><button class="btn small ghost" data-cut="nudge" data-f="start" data-d="0.1">+</button>
      <button class="btn small" data-cut="here" data-f="start">⏱ = playhead</button></div>
    <div class="row">End&nbsp; <button class="btn small ghost" data-cut="nudge" data-f="end" data-d="-0.1">−</button><input type="number" step="0.1" data-cf="end" value="${p.end.toFixed(1)}"><button class="btn small ghost" data-cut="nudge" data-f="end" data-d="0.1">+</button>
      <button class="btn small" data-cut="here" data-f="end">⏱ = playhead</button></div>
    <div class="row"><input data-cf="hint" value="${esc(p.hint)}" placeholder="What happens? e.g. angry about the pizza" style="flex:1"></div>`;
}
function renderCutList() {
  $('#cutList').innerHTML = cut.parts.length ? cut.parts.map((p, i) => `<li class="${cut.sel === i ? 'sel' : ''}" data-ci="${i}">
    <span class="dot" style="background:${cutColor(p.role)}"></span><span class="grow"><b>${i + 1}. ${esc(p.role)}</b> <span class="me-tag">${fmt(p.start)}–${fmt(p.end)}</span>${p.hint ? `<br><span class="me-tag">“${esc(p.hint)}”</span>` : ''}</span></li>`).join('')
    : '<li class="me-tag">No lines yet. Press ▶ Play, hit 🟢 Start line when someone starts talking and 🔴 End line when they stop.</li>';
}
function renderCutPick() {
  const box = $('#cutPick');
  if (!cut.pick) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = `<h3>Who says this line? <span class="me-tag">(${fmt(cut.pick.start)} – ${fmt(cut.pick.end)})</span></h3>
    <div class="opts">${cut.roles.map((r, i) => `<button class="btn" data-cut="pick" data-r="${i}" style="background:${cutColor(r)}">${i < 9 ? `<kbd>${i + 1}</kbd> ` : ''}${esc(r)}</button>`).join('')}</div>
    <div class="opts"><input id="cutNewRole" placeholder="New character name" maxlength="24"><button class="btn" data-cut="picknew">+ Add &amp; pick</button></div>
    <div class="opts"><button class="btn ghost" data-cut="pickcancel">Throw this line away</button></div>`;
}
function selectCut(i, seek = true) {
  cut.sel = i; renderCutTimeline(); renderCutSel(); renderCutList();
  if (seek && cut.parts[i]) cutSeek(cut.parts[i].start);
}
function cutStart() {
  if (cut.pick) return;
  cut.open = cutT(); renderCutTimeline();
}
function cutEnd() {
  if (cut.pick) return;
  if (cut.open === null) return toast('Press 🟢 Start line first (when someone starts talking)', 'err');
  const start = cut.open, end = cutT();
  if (end - start < 0.2) return toast('That line is too short — let the clip run a bit longer before ending it', 'err');
  cut.resume = !cv().paused; cv().pause();
  cut.open = null; cut.pick = { start, end };
  renderCutTimeline(); renderCutPick();
}
function cutPickRole(name) {
  const { start, end } = cut.pick;
  cut.parts.push({ role: name, start, end, hint: '' });
  cut.parts.sort((a, b) => a.start - b.start);
  cut.pick = null; cut.dirty = true;
  selectCut(cut.parts.findIndex(p => p.start === start && p.end === end && p.role === name), false);
  renderCutPick();
  if (cut.resume) cv().play().catch(() => { });
}
function cutChanged() { cut.dirty = true; cut.parts.sort((a, b) => a.start - b.start); renderCutTimeline(); renderCutList(); }

$('#cutter').addEventListener('click', async e => {
  const seg = e.target.closest('[data-ci]');
  if (seg) return selectCut(+seg.dataset.ci);
  const b = e.target.closest('[data-cut]'); if (!b) return;
  e.preventDefault();
  const p = cut.parts[cut.sel], sc = bScene();
  switch (b.dataset.cut) {
    case 'play': cutPlay(); break;
    case 'rw': cutSeek(cutT() - +b.dataset.s); break;
    case 'start': cutStart(); break;
    case 'end': cutEnd(); break;
    case 'pick': cutPickRole(cut.roles[+b.dataset.r]); break;
    case 'picknew': {
      const name = $('#cutNewRole').value.trim().slice(0, 24);
      if (!name) return $('#cutNewRole').focus();
      if (!cut.roles.includes(name)) cut.roles.push(name);
      renderCutRoles(); cutPickRole(name); break;
    }
    case 'pickcancel': cut.pick = null; renderCutPick(); renderCutTimeline(); break;
    case 'addrole': cut.roles.push('Character ' + (cut.roles.length + 1)); cut.dirty = true; renderCutter(); break;
    case 'delrole': {
      const i = +b.dataset.i, name = cut.roles[i], n = cut.parts.filter(x => x.role === name).length;
      if (cut.roles.length <= 1) return toast('Keep at least one character', 'err');
      if (n && !confirm(`${name} has ${n} line(s). Remove the character and its lines?`)) return;
      cut.roles.splice(i, 1); cut.parts = cut.parts.filter(x => x.role !== name); cut.sel = null; cut.dirty = true; renderCutter(); break;
    }
    case 'playsel': if (p) { cv().currentTime = Math.max(0, p.start - 0.3); cut.stopAt = p.end + 0.3; cv().play().catch(() => { }); } break;
    case 'delsel': if (p) { cut.parts.splice(cut.sel, 1); cut.sel = null; cut.dirty = true; renderCutter(); } break;
    case 'nudge': if (p) { p[b.dataset.f] = Math.max(0, Math.min(cut.dur, p[b.dataset.f] + +b.dataset.d)); fixPart(p); cutChanged(); renderCutSel(); } break;
    case 'here': if (p) { p[b.dataset.f] = cutT(); fixPart(p); cutChanged(); renderCutSel(); } break;
    case 'auto':
      if (cut.parts.length && !confirm('Auto-cut replaces the lines you already have. Go ahead?')) return;
      await autoCut(sc); break;
    case 'save':
      if (cut.open !== null) return toast('You still have an open line — press 🔴 End line first', 'err');
      if (!cut.parts.length) return toast('Make at least one line first', 'err');
      try {
        await api('setParts', { sceneId: cut.sceneId, roles: cut.roles, parts: cut.parts });
        closeCutter(true); toast('Cut saved! Now pick who voices which character.', '', 6000);
      } catch { }
      break;
    case 'cancel': closeCutter(); break;
  }
});
function fixPart(p) {
  if (p.end - p.start < 0.2) { if (p.end >= cut.dur) p.start = p.end - 0.2; else p.end = p.start + 0.2; }
  cut.sel = null; const i = cut.parts.indexOf(p); cut.parts.sort((a, b) => a.start - b.start); cut.sel = cut.parts.indexOf(p); return i;
}
$('#cutter').addEventListener('input', e => {
  const t = e.target;
  if (t.dataset.crname !== undefined) {
    const i = +t.dataset.crname, old = cut.roles[i], name = t.value.slice(0, 24);
    cut.roles[i] = name; cut.parts.forEach(p => { if (p.role === old) p.role = name; });
    cut.dirty = true; renderCutTimeline(); renderCutList(); return;
  }
  const p = cut.parts[cut.sel], f = t.dataset.cf; if (!p || !f) return;
  if (f === 'start' || f === 'end') { const val = parseFloat(t.value); if (isNaN(val)) return; p[f] = Math.max(0, Math.min(cut.dur, val)); }
  else p[f] = f === 'hint' ? t.value.slice(0, 60) : t.value;
  cut.dirty = true; renderCutTimeline(); renderCutList();
});
$('#cutter').addEventListener('change', e => {
  if (e.target.id === 'cutSpeed') cv().playbackRate = +e.target.value;
  if (e.target.dataset.cf === 'start' || e.target.dataset.cf === 'end') { const p = cut.parts[cut.sel]; if (p) { fixPart(p); cutChanged(); renderCutSel(); } }
  if (e.target.dataset.crname !== undefined) renderCutSel();
});
$('#cutTimeline').addEventListener('click', e => {
  if (e.target.closest('[data-ci]')) return;
  const r = $('#cutTimeline').getBoundingClientRect();
  cutSeek((e.clientX - r.left) / r.width * cut.dur);
});
document.addEventListener('keydown', e => {
  if ($('#cutter').hidden) return;
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName);
  if (cut.pick) {
    if (!typing && /^[1-9]$/.test(e.key) && cut.roles[+e.key - 1]) { e.preventDefault(); cutPickRole(cut.roles[+e.key - 1]); }
    if (e.key === 'Enter' && e.target.id === 'cutNewRole') $('[data-cut="picknew"]').click();
    if (e.key === 'Escape') { cut.pick = null; renderCutPick(); renderCutTimeline(); }
    return;
  }
  if (typing) return;
  const k = e.key.toLowerCase();
  if (k === ' ') { e.preventDefault(); cutPlay(); }
  else if (k === 's') cutStart();
  else if (k === 'e') cutEnd();
  else if (k === 'arrowleft') { e.preventDefault(); cutSeek(cutT() - (e.shiftKey ? 5 : 1)); }
  else if (k === 'arrowright') { e.preventDefault(); cutSeek(cutT() + (e.shiftKey ? 5 : 1)); }
  else if ((k === 'delete' || k === 'backspace') && cut.parts[cut.sel]) { cut.parts.splice(cut.sel, 1); cut.sel = null; cut.dirty = true; renderCutter(); }
  else if (k === 'escape' && cut.open !== null) { cut.open = null; renderCutTimeline(); }
});
async function autoCut(sc) {
  const t = toast('🪄 Listening to the clip…', '', 60000);
  try {
    const blob = await getMedia(sc.src);
    let buf;
    try { buf = await AC.decodeAudioData(await blob.arrayBuffer()); }
    catch { throw new Error("Couldn't read the clip's sound. Cut it by hand with Start / End line."); }
    const chans = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i));
    const win = Math.floor(buf.sampleRate * 0.05), n = Math.floor(buf.length / win), rms = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (const ch of chans) for (let j = i * win; j < (i + 1) * win; j += 4) sum += ch[j] * ch[j];
      rms[i] = Math.sqrt(sum / (win / 4) / chans.length);
    }
    const sorted = Array.from(rms).sort((a, b) => a - b);
    const floor = sorted[Math.floor(n * 0.2)] || 0, peak = sorted[Math.floor(n * 0.95)] || 0;
    if (peak - floor < 0.002) throw new Error('The clip seems to have no talking in it. Cut it by hand.');
    const thr = floor + (peak - floor) * 0.25;
    let segs = [], cur = null;
    for (let i = 0; i < n; i++) {
      const tt = i * 0.05;
      if (rms[i] > thr) { if (cur && tt - cur[1] < 0.45) cur[1] = tt + 0.05; else { cur = [tt, tt + 0.05]; segs.push(cur); } }
    }
    segs = segs.filter(s => s[1] - s[0] >= 0.4).map(([a, b]) => [Math.max(0, a - 0.1), Math.min(buf.duration, b + 0.1)]);
    if (!segs.length) throw new Error('No talking found. Cut it by hand.');
    if (cut.roles.length < 2 && segs.length > 1) cut.roles.push('Character 2');
    cut.parts = segs.map(([a, b], i) => ({ role: cut.roles[i % cut.roles.length], start: a, end: b, hint: '' }));
    cut.sel = null; cut.dirty = true; renderCutter();
    toast(`Found ${segs.length} lines! Click each one and pick the right character, then save.`, '', 8000);
  } catch (e) { toast(esc(e.message), 'err', 7000); }
  t.remove();
}

// ================================================================== premiere
const prem = { token: null, player: new ScenePlayer($('#premStage')), mixer: new Mixer(), auto: true };
function playlist() {
  const voiced = S.scenes.filter(s => s.takes.length);
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
function castOf(s) {
  return s.roles.map(r => {
    const names = [...new Set(s.takes.filter(t => s.parts.find(p => p.id === t.partId)?.role === r.name).map(t => t.playerName))];
    return names.length ? `${r.name}: ${names.join(' & ')}` : null;
  }).filter(Boolean);
}
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
  const cast = castOf(s);
  $('#premTitle').textContent = `🍿 Scene ${P.index + 1} / ${list.length}`;
  $('#premCredits').textContent = cast.length ? cast.join(' · ') : 'No voices (silent film!)';
  titleCard(`${esc(s.title)}<small>${cast.length ? cast.map(esc).join('<br>') : 'a silent masterpiece'}</small>`);
  await prem.player.load(s);
  await prem.mixer.set(s);
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
