// Built-in animated scenes. Each scene is drawn on a 960x540 canvas as a function of time t (seconds).
// `lines` tell dubbers who talks when; the characters' mouths flap during their lines.
const W = 960, H = 540;

function rnd(i) { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }
function speaking(scene, role, t) { return scene.lines.some(l => l.role === role && t >= l.start && t <= l.end); }
function mouthAmt(scene, role, t) {
  if (!speaking(scene, role, t)) return 0;
  return 0.25 + 0.75 * Math.abs(Math.sin(t * 13 + role.length) * Math.sin(t * 7.3));
}
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function ease(x) { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); }

function blob(ctx, x, y, r, color, o = {}) {
  const t = o.t || 0, squash = 1 + Math.sin(t * 3 + x) * 0.03 + (o.bounce || 0);
  ctx.save();
  ctx.translate(x, y);
  if (o.rot) ctx.rotate(o.rot);
  ctx.scale(1 / squash, squash);
  // body
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.ellipse(0, 0, r, r * 1.05, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,.18)';
  ctx.beginPath(); ctx.ellipse(-r * .35, -r * .45, r * .3, r * .18, -0.5, 0, Math.PI * 2); ctx.fill();
  // eyes
  const blink = ((t + x * 0.01) % 3.7) < 0.12;
  const look = o.look || 0;
  for (const s of [-1, 1]) {
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.ellipse(s * r * .32, -r * .2, r * .2, blink ? r * .03 : r * .24, 0, 0, Math.PI * 2); ctx.fill();
    if (!blink) {
      ctx.fillStyle = '#1b1b2f';
      ctx.beginPath(); ctx.arc(s * r * .32 + look * r * .08, -r * .17, r * (o.shock ? .06 : .1), 0, Math.PI * 2); ctx.fill();
    }
  }
  // mouth
  const m = o.mouth || 0;
  ctx.fillStyle = '#3a1020';
  ctx.beginPath();
  if (m > 0.05) { ctx.ellipse(0, r * .32, r * .26, r * .04 + r * .26 * m, 0, 0, Math.PI * 2); ctx.fill(); }
  else { ctx.strokeStyle = '#3a1020'; ctx.lineWidth = r * .06; ctx.arc(0, r * .2, r * .2, 0.2, Math.PI - 0.2); ctx.stroke(); }
  // accessories
  if (o.hat === 'chef') {
    ctx.fillStyle = '#fff';
    ctx.fillRect(-r * .45, -r * 1.25, r * .9, r * .35);
    for (const s of [-1, 0, 1]) { ctx.beginPath(); ctx.arc(s * r * .3, -r * 1.3, r * .3, 0, Math.PI * 2); ctx.fill(); }
  } else if (o.hat === 'helmet') {
    ctx.strokeStyle = 'rgba(200,230,255,.8)'; ctx.lineWidth = r * .08;
    ctx.beginPath(); ctx.arc(0, -r * .05, r * 1.25, 0, Math.PI * 2); ctx.stroke();
  } else if (o.hat === 'antenna') {
    ctx.strokeStyle = color; ctx.lineWidth = r * .08;
    for (const s of [-1, 1]) {
      ctx.beginPath(); ctx.moveTo(s * r * .3, -r * .9); ctx.lineTo(s * r * .55, -r * 1.5); ctx.stroke();
      ctx.fillStyle = '#ffe066'; ctx.beginPath(); ctx.arc(s * r * .55, -r * 1.5, r * .12, 0, Math.PI * 2); ctx.fill();
    }
  } else if (o.hat === 'tie') {
    ctx.fillStyle = '#e03131';
    ctx.beginPath(); ctx.moveTo(0, r * .7); ctx.lineTo(-r * .12, r * 1.05); ctx.lineTo(0, r * 1.2); ctx.lineTo(r * .12, r * 1.05); ctx.fill();
  } else if (o.hat === 'bow') {
    ctx.fillStyle = '#e64980';
    ctx.beginPath(); ctx.moveTo(0, -r * .95); ctx.lineTo(-r * .4, -r * 1.2); ctx.lineTo(-r * .4, -r * .75); ctx.fill();
    ctx.beginPath(); ctx.moveTo(0, -r * .95); ctx.lineTo(r * .4, -r * 1.2); ctx.lineTo(r * .4, -r * .75); ctx.fill();
  }
  ctx.restore();
}

function sky(ctx, top, bottom) {
  const g = ctx.createLinearGradient(0, 0, 0, H); g.addColorStop(0, top); g.addColorStop(1, bottom);
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
}

const SCENES = {
  interview: {
    title: 'Late Night Interview', duration: 16,
    roles: [{ name: 'Host', color: '#9775fa' }, { name: 'Guest', color: '#ff922b' }],
    lines: [
      { role: 'Host', start: 0.5, end: 3, hint: 'welcomes the guest' },
      { role: 'Guest', start: 3.3, end: 6, hint: 'awkward hello' },
      { role: 'Host', start: 6.3, end: 8.5, hint: 'asks a question' },
      { role: 'Guest', start: 8.8, end: 13, hint: 'a very weird answer' },
      { role: 'Host', start: 13.3, end: 15.6, hint: 'cuts to commercial' },
    ],
    draw(ctx, t) {
      sky(ctx, '#141a3a', '#2b2f6b');
      for (let i = 0; i < 18; i++) { // skyline
        const bw = 40 + rnd(i) * 50, bh = 80 + rnd(i + 9) * 180, bx = i * 55 - 10;
        ctx.fillStyle = '#1e2452'; ctx.fillRect(bx, 330 - bh, bw, bh);
        ctx.fillStyle = 'rgba(255,224,102,.55)';
        for (let w = 0; w < 6; w++) if (rnd(i * 7 + w) > .5) ctx.fillRect(bx + 8 + (w % 2) * 18, 340 - bh + Math.floor(w / 2) * 30, 8, 12);
      }
      ctx.fillStyle = '#5c3d2e'; ctx.fillRect(0, 380, W, 160); // floor
      ctx.fillStyle = '#8f5b3a'; ctx.fillRect(560, 300, 320, 110); ctx.fillRect(540, 270, 360, 40); // couch
      const bounce = t > 10 && t < 12 ? Math.abs(Math.sin(t * 9)) * 0.12 : 0;
      blob(ctx, 250, 290, 75, '#9775fa', { t, mouth: mouthAmt(this, 'Host', t), hat: 'tie', look: 1 });
      ctx.fillStyle = '#6d4c41'; ctx.fillRect(120, 330, 280, 160); // desk
      ctx.fillStyle = '#4e342e'; ctx.fillRect(110, 320, 300, 20);
      ctx.fillStyle = '#fff'; ctx.fillRect(330, 296, 24, 26); // mug
      blob(ctx, 720, 250 - bounce * 120, 70, '#ff922b', { t, mouth: mouthAmt(this, 'Guest', t), look: -1, bounce, shock: t > 13 });
      if (t > 13.3) { ctx.fillStyle = `rgba(0,0,0,${ease((t - 14.6) / 1)})`; ctx.fillRect(0, 0, W, H); }
    },
  },
  space: {
    title: 'Lost in Space', duration: 14,
    roles: [{ name: 'Captain', color: '#4dabf7' }, { name: 'Alien', color: '#69db7c' }],
    lines: [
      { role: 'Captain', start: 0.5, end: 2.6, hint: 'reports to base' },
      { role: 'Alien', start: 3.0, end: 6.0, hint: 'appears, threatening' },
      { role: 'Captain', start: 6.3, end: 8.0, hint: 'panics' },
      { role: 'Alien', start: 8.3, end: 11.0, hint: 'reveals its real demand' },
      { role: 'Captain', start: 11.3, end: 13.6, hint: 'agrees, confused' },
    ],
    draw(ctx, t) {
      ctx.fillStyle = '#05060f'; ctx.fillRect(0, 0, W, H);
      for (let i = 0; i < 120; i++) { // warp stars
        const a = rnd(i) * Math.PI * 2, sp = 60 + rnd(i + 3) * 200, d = ((t * sp + rnd(i + 5) * 600) % 600);
        const x = W / 2 + Math.cos(a) * d, y = 200 + Math.sin(a) * d * .6;
        ctx.strokeStyle = `rgba(255,255,255,${d / 600})`; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * d * .05, y + Math.sin(a) * d * .03); ctx.stroke();
      }
      const screenOn = ease((t - 2.8) * 3) * (1 - ease((t - 11.5) * 3));
      if (screenOn > 0) {
        ctx.fillStyle = `rgba(20,60,30,${screenOn})`; ctx.fillRect(300, 50, 360, 220);
        ctx.strokeStyle = '#8ce99a'; ctx.lineWidth = 6; ctx.strokeRect(300, 50, 360, 220);
        ctx.save(); ctx.globalAlpha = screenOn;
        blob(ctx, 480, 170, 70, '#69db7c', { t, mouth: mouthAmt(this, 'Alien', t), hat: 'antenna' });
        ctx.restore();
        ctx.fillStyle = 'rgba(0,0,0,.15)'; for (let y = 50; y < 270; y += 6) ctx.fillRect(300, y, 360, 2);
      }
      ctx.fillStyle = '#343a40'; ctx.fillRect(0, 380, W, 160); // console
      ctx.beginPath(); ctx.moveTo(0, 380); ctx.lineTo(W, 380); ctx.lineTo(W, 300); ctx.lineTo(820, 360); ctx.lineTo(140, 360); ctx.lineTo(0, 300); ctx.fill();
      for (let i = 0; i < 14; i++) { ctx.fillStyle = ['#ff6b6b', '#ffd43b', '#69db7c', '#4dabf7'][i % 4]; ctx.globalAlpha = .4 + .6 * (Math.sin(t * 5 + i) > 0); ctx.fillRect(60 + i * 62, 420, 30, 14); }
      ctx.globalAlpha = 1;
      const panic = t > 6.2 && t < 8.2 ? Math.sin(t * 40) * 6 : 0;
      blob(ctx, 480 + panic, 450, 80, '#4dabf7', { t, mouth: mouthAmt(this, 'Captain', t), hat: 'helmet', shock: panic !== 0 });
      if (t > 3 && t < 6) { ctx.fillStyle = `rgba(255,0,0,${.18 * (Math.sin(t * 10) > 0)})`; ctx.fillRect(0, 0, W, H); }
    },
  },
  swamp: {
    title: 'Wild Kingdom', duration: 15,
    roles: [{ name: 'Narrator', color: '#ced4da' }, { name: 'Frog', color: '#94d82d' }],
    lines: [
      { role: 'Narrator', start: 0.5, end: 4.6, hint: 'whispers about this rare creature' },
      { role: 'Frog', start: 5.0, end: 7.0, hint: 'the frog... talks back?!' },
      { role: 'Narrator', start: 7.5, end: 11.0, hint: 'the hunt begins' },
      { role: 'Frog', start: 12.0, end: 14.6, hint: 'falls in the water' },
    ],
    draw(ctx, t) {
      sky(ctx, '#8ec5c2', '#3d6b5c');
      for (let i = 0; i < 9; i++) { ctx.fillStyle = i % 2 ? '#2f5d4a' : '#264d3d'; ctx.beginPath(); ctx.arc(i * 120, 300, 110 + rnd(i) * 50, Math.PI, 0); ctx.fill(); }
      ctx.fillStyle = '#2e6e7a'; ctx.fillRect(0, 360, W, 180); // water
      ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.lineWidth = 2;
      for (let i = 0; i < 10; i++) { const y = 380 + i * 16; ctx.beginPath(); for (let x = 0; x <= W; x += 20) ctx.lineTo(x, y + Math.sin(x * .03 + t * 2 + i) * 3); ctx.stroke(); }
      ctx.fillStyle = '#6b4226'; ctx.beginPath(); ctx.ellipse(480, 372, 210, 34, 0, 0, Math.PI * 2); ctx.fill(); // log
      ctx.fillStyle = '#a0522d'; ctx.beginPath(); ctx.ellipse(690, 372, 22, 34, 0, 0, Math.PI * 2); ctx.fill();
      // fly
      const caught = t > 9.2, flyX = 600 + Math.sin(t * 4) * 120, flyY = 200 + Math.cos(t * 6.3) * 50;
      const fall = ease((t - 11.6) * 1.5);
      const fx = 460 + fall * 200, fy = 300 - Math.sin(fall * Math.PI) * 80 + fall * 140;
      if (!caught) { ctx.fillStyle = '#222'; ctx.beginPath(); ctx.arc(flyX, flyY, 6, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = 'rgba(255,255,255,.6)'; ctx.beginPath(); ctx.ellipse(flyX - 4, flyY - 7, 5, 3, Math.sin(t * 60), 0, Math.PI * 2); ctx.fill(); }
      if (t > 8.9 && t < 9.4) { // tongue
        const k = 1 - Math.abs((t - 9.15) / .25), tx = 600 + Math.sin(9.15 * 4) * 120, ty = 200 + Math.cos(9.15 * 6.3) * 50;
        ctx.strokeStyle = '#f06595'; ctx.lineWidth = 8; ctx.beginPath(); ctx.moveTo(fx, fy + 15); ctx.lineTo(fx + (tx - fx) * k, fy + 15 + (ty - fy - 15) * k); ctx.stroke();
      }
      if (fy < 380 || t < 13) blob(ctx, fx, fy, 60, '#94d82d', { t, mouth: mouthAmt(this, 'Frog', t), look: caught ? 0 : (flyX > fx ? 1 : -1), rot: fall * 2.5, shock: t > 11.6 });
      if (t > 12.6) { // splash
        const k = (t - 12.6); ctx.strokeStyle = 'rgba(255,255,255,.8)'; ctx.lineWidth = 4;
        for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.ellipse(660, 440, 30 + k * 90 + i * 25, 8 + k * 20 + i * 6, 0, 0, Math.PI * 2); ctx.stroke(); }
      }
      if (speaking(this, 'Narrator', t)) { ctx.fillStyle = 'rgba(0,0,0,.45)'; ctx.fillRect(20, 20, 210, 40); ctx.fillStyle = '#fff'; ctx.font = 'bold 20px sans-serif'; ctx.fillText('🎙 Narrator...', 34, 47); }
    },
  },
  kitchen: {
    title: 'Cooking Disaster', duration: 14,
    roles: [{ name: 'Chef', color: '#f8f9fa' }, { name: 'Assistant', color: '#f783ac' }],
    lines: [
      { role: 'Chef', start: 0.5, end: 4.0, hint: "introduces today's recipe" },
      { role: 'Assistant', start: 4.5, end: 6.5, hint: 'rushes in, worried' },
      { role: 'Chef', start: 7.0, end: 10.5, hint: 'adds the secret ingredient' },
      { role: 'Assistant', start: 11.2, end: 13.6, hint: 'reacts to the explosion' },
    ],
    draw(ctx, t) {
      ctx.fillStyle = '#fff3bf'; ctx.fillRect(0, 0, W, H);
      for (let x = 0; x < W; x += 60) for (let y = 0; y < 330; y += 60) { ctx.fillStyle = (x + y) % 120 ? '#ffe8a1' : '#fff3bf'; ctx.fillRect(x, y, 60, 60); }
      ctx.fillStyle = '#868e96'; ctx.fillRect(0, 380, W, 160); ctx.fillStyle = '#adb5bd'; ctx.fillRect(0, 370, W, 20);
      const boom = t > 10.8;
      const shake = t > 7 && !boom ? Math.sin(t * 50) * (t - 7) * 2 : 0;
      const sooty = boom ? '#495057' : '#f1f3f5';
      blob(ctx, 300, 290, 72, sooty, { t, mouth: mouthAmt(this, 'Chef', t), hat: boom ? null : 'chef', shock: boom });
      const ax = 900 - ease((t - 4.2) * 1.5) * 200;
      blob(ctx, ax, 300, 58, boom ? '#862e9c' : '#f783ac', { t, mouth: mouthAmt(this, 'Assistant', t), hat: 'bow', look: -1, shock: boom });
      if (!boom) { // pot
        ctx.fillStyle = '#495057'; ctx.fillRect(430 + shake, 300, 140, 80); ctx.fillRect(415 + shake, 295, 170, 14);
        for (let i = 0; i < 5; i++) { const k = (t * .8 + i / 5) % 1; ctx.fillStyle = `rgba(255,255,255,${.6 * (1 - k)})`; ctx.beginPath(); ctx.arc(470 + i * 15 + Math.sin(k * 6 + i) * 10, 280 - k * 120, 12 + k * 20, 0, Math.PI * 2); ctx.fill(); }
        if (t > 8 && t < 9) { ctx.fillStyle = '#e03131'; ctx.font = 'bold 30px sans-serif'; ctx.fillText('???', 480, 260 - (t - 8) * 60); }
      } else {
        const k = t - 10.8;
        ctx.fillStyle = `rgba(255,255,255,${clamp(1 - k * 2, 0, 1)})`; ctx.fillRect(0, 0, W, H);
        for (let i = 0; i < 26; i++) {
          const a = rnd(i) * Math.PI * 2, d = k * (150 + rnd(i + 1) * 300);
          ctx.fillStyle = `rgba(60,60,60,${clamp(.8 - k * .2, 0, .8)})`;
          ctx.beginPath(); ctx.arc(500 + Math.cos(a) * d, 320 + Math.sin(a) * d * .6 - k * 30, 30 + rnd(i + 2) * 40, 0, Math.PI * 2); ctx.fill();
        }
      }
    },
  },
  news: {
    title: 'Breaking News', duration: 13,
    roles: [{ name: 'Anchor', color: '#ffd43b' }, { name: 'Reporter', color: '#38d9a9' }],
    lines: [
      { role: 'Anchor', start: 0.5, end: 3.6, hint: 'announces breaking news' },
      { role: 'Reporter', start: 4.0, end: 8.0, hint: 'reports live from the storm' },
      { role: 'Anchor', start: 8.5, end: 10.6, hint: 'asks a follow-up' },
      { role: 'Reporter', start: 11.0, end: 12.8, hint: 'signs off' },
    ],
    draw(ctx, t) {
      sky(ctx, '#1c3d6e', '#0b1d3a');
      ctx.fillStyle = '#123'; for (let i = 0; i < 12; i++) ctx.fillRect(i * 85, 40 + (i % 3) * 10, 2, 300);
      // field window
      const win = ease((t - 3.6) * 3) * (1 - ease((t - 13) * 3));
      ctx.save(); ctx.beginPath(); ctx.rect(500, 60, 400 * Math.max(win, .001), 260); ctx.clip();
      ctx.fillStyle = '#495057'; ctx.fillRect(500, 60, 400, 260);
      const storm = clamp((t - 4) / 4, 0, 1);
      ctx.fillStyle = '#343a40'; ctx.fillRect(500, 250, 400, 70);
      const blow = t > 7 ? Math.sin(t * 20) * 8 : Math.sin(t * 8) * 3 * storm;
      blob(ctx, 700 + blow, 220, 55, '#38d9a9', { t, mouth: mouthAmt(this, 'Reporter', t), rot: blow * .02, shock: t > 7 });
      // umbrella
      const flip = t > 7 ? Math.min(1, (t - 7) * 2) : 0;
      ctx.save(); ctx.translate(760 + blow, 160 - flip * 120); ctx.rotate(-.3 + flip * 3.5);
      ctx.fillStyle = '#e03131'; ctx.beginPath(); ctx.arc(0, 0, 50, Math.PI, 0); ctx.fill();
      ctx.strokeStyle = '#222'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, 60); ctx.stroke(); ctx.restore();
      ctx.strokeStyle = 'rgba(200,220,255,.6)'; ctx.lineWidth = 2;
      for (let i = 0; i < 40 + storm * 80; i++) { const x = 500 + ((rnd(i) * 400 + t * 300) % 420), y = 60 + ((rnd(i + 7) * 260 + t * 700) % 260); ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - 6 - storm * 10, y + 14); ctx.stroke(); }
      ctx.fillStyle = '#e03131'; ctx.fillRect(510, 70, 60, 22); ctx.fillStyle = '#fff'; ctx.font = 'bold 14px sans-serif'; ctx.fillText('LIVE', 522, 86);
      ctx.restore();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 4; if (win > .01) ctx.strokeRect(500, 60, 400 * win, 260);
      // anchor desk
      blob(ctx, 250, 300, 75, '#ffd43b', { t, mouth: mouthAmt(this, 'Anchor', t), hat: 'tie', look: t > 4 ? 1 : 0 });
      ctx.fillStyle = '#ced4da'; ctx.fillRect(80, 340, 340, 140); ctx.fillStyle = '#1971c2'; ctx.fillRect(80, 340, 340, 18);
      // banner
      ctx.fillStyle = '#c92a2a'; ctx.fillRect(0, 460, 230, 50); ctx.fillStyle = '#fff'; ctx.font = 'bold 24px sans-serif'; ctx.fillText('BREAKING', 40, 494);
      ctx.fillStyle = '#f1f3f5'; ctx.fillRect(230, 460, W - 230, 50); ctx.fillStyle = '#212529'; ctx.font = 'bold 20px sans-serif';
      ctx.fillText('LOCAL STORM REACHES "PRETTY WINDY" LEVELS  •  MORE AT ELEVEN  •  ', 980 - ((t * 120) % 1100), 492);
    },
  },
};

for (const [k, s] of Object.entries(SCENES)) s.key = k;
window.SCENES = SCENES;
window.SCENE_W = W; window.SCENE_H = H;
