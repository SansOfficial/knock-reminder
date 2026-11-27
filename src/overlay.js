const $ = (s) => document.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);

const SVG_NS = 'http://www.w3.org/2000/svg';
const PAD = 56; // 形象画布四周留给阴影的空白(CSS 像素)

let data;
let running = true;
let hitAt = null; // 唯一的撞击点
let bubbleShown = false;
let audio;
let glass = null; // WebGL 玻璃;拿不到 WebGL 时为 null,退回 SVG 裂纹
let debris = null;
let figW = 0;

// ---------- 声音:用 WebAudio 合成,不依赖音频文件 ----------

function thump(t, from, to, dur, gain) {
  const osc = audio.createOscillator();
  const g = audio.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(from, t);
  osc.frequency.exponentialRampToValueAtTime(to, t + dur * 0.7);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(audio.destination);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

function noise(t, dur, type, freq, gain, q = 0.9) {
  const len = Math.floor(audio.sampleRate * dur);
  const buf = audio.createBuffer(1, len, audio.sampleRate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < len; i++) ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
  const src = audio.createBufferSource();
  src.buffer = buf;
  const f = audio.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  const g = audio.createGain();
  g.gain.value = gain;
  src.connect(f).connect(g).connect(audio.destination);
  src.start(t);
}

// 玻璃碎渣的"叮铃":几个高频、快速衰减的正弦泛音
function tinkle(t, n, gain) {
  for (let i = 0; i < n; i++) {
    const at = t + rand(0.01, 0.16);
    const osc = audio.createOscillator();
    const g = audio.createGain();
    osc.type = 'sine';
    osc.frequency.value = rand(3200, 7800);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain * rand(0.3, 1), at + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, at + rand(0.05, 0.16));
    osc.connect(g).connect(audio.destination);
    osc.start(at);
    osc.stop(at + 0.2);
  }
}

function knockSound(withGlass, heavy) {
  if (!data.sound || data.volume <= 0) return;
  audio ||= new AudioContext();
  const t = audio.currentTime;
  const vol = data.volume;

  // 低频"咚"
  thump(t, 190, 55, 0.24, vol);
  // 重拳再叠一层更低更长的轰鸣
  if (heavy) thump(t, 95, 32, 0.42, vol * 0.9);

  // 指节敲玻璃的"哒"
  noise(t, 0.05, 'bandpass', 1700, vol * 0.8);
  if (withGlass) {
    // 裂开的"咔嚓":短促的宽带噪声 + 碎渣叮铃
    noise(t + 0.004, heavy ? 0.16 : 0.1, 'highpass', 3000, vol * (heavy ? 0.45 : 0.3));
    noise(t + 0.01, 0.03, 'bandpass', 5200, vol * 0.35, 3);
    tinkle(t, heavy ? 6 : 3, vol * 0.05);
  }
}

// ---------- 形象画布 ----------
// 形象画在一张 2D canvas 上(带羽化和投影),再交给玻璃着色器,这样碎片能折射到形象。

let charCv = null;
let charCtx = null;
let maskCv = null;

function setupCharCanvas(w, h) {
  const figure = $('#figure');
  figure.style.width = `${w}px`;
  figure.style.height = `${h}px`;
  const dpr = window.devicePixelRatio || 1;
  charCv = document.createElement('canvas');
  charCv.className = 'char';
  charCv.width = Math.round((w + PAD * 2) * dpr);
  charCv.height = Math.round((h + PAD * 2) * dpr);
  charCv.style.cssText = `left:${-PAD}px;top:${-PAD}px;width:${w + PAD * 2}px;height:${h + PAD * 2}px`;
  charCtx = charCv.getContext('2d');
  charCtx.imageSmoothingQuality = 'high';
  maskCv = document.createElement('canvas');
  maskCv.width = Math.round(w * dpr);
  maskCv.height = Math.round(h * dpr);
  figure.appendChild(charCv);
  figW = w;
}

// feather:精灵图格子边缘的硬边要羽化掉
// trail:保留上一帧的比例(0 = 不留残影)
function paintChar(src, sx, sy, sw, sh, feather, trail = 0) {
  const dpr = window.devicePixelRatio || 1;
  const m = maskCv.getContext('2d');
  const W = maskCv.width;
  const H = maskCv.height;
  m.globalCompositeOperation = 'source-over';
  m.clearRect(0, 0, W, H);
  m.imageSmoothingQuality = 'high';
  m.drawImage(src, sx, sy, sw, sh, 0, 0, W, H);
  if (feather) {
    m.globalCompositeOperation = 'destination-in';
    const gx = m.createLinearGradient(0, 0, W, 0);
    gx.addColorStop(0, 'rgba(0,0,0,0)');
    gx.addColorStop(0.1, '#000');
    gx.addColorStop(0.93, '#000');
    gx.addColorStop(1, 'rgba(0,0,0,0)');
    m.fillStyle = gx;
    m.fillRect(0, 0, W, H);
    const gy = m.createLinearGradient(0, 0, 0, H);
    gy.addColorStop(0, 'rgba(0,0,0,0)');
    gy.addColorStop(0.04, '#000');
    m.fillStyle = gy;
    m.fillRect(0, 0, W, H);
  }
  const c = charCtx;
  if (trail > 0) {
    // 快速出拳时不清空,而是把上一帧淡掉,留下一道残影
    c.globalCompositeOperation = 'destination-out';
    c.fillStyle = `rgba(0,0,0,${1 - trail})`;
    c.fillRect(0, 0, charCv.width, charCv.height);
    c.globalCompositeOperation = 'source-over';
  } else {
    c.clearRect(0, 0, charCv.width, charCv.height);
  }
  c.filter = `drop-shadow(0 ${12 * dpr}px ${18 * dpr}px rgba(0,0,0,.42))`;
  c.drawImage(maskCv, PAD * dpr, PAD * dpr);
  c.filter = 'none';
  glass?.markChar();
}

// ---------- 旧版 SVG 裂纹(没有 WebGL 时的退路) ----------

const p = (x, y) => `${x.toFixed(1)} ${y.toFixed(1)}`;

function addSvgCrack(x, y) {
  const scale = rand(0.7, 1.25);
  const rays = 8 + Math.floor(Math.random() * 6);
  const pts = [];
  let d = '';
  for (let i = 0; i < rays; i++) {
    const a = (i / rays) * Math.PI * 2 + rand(-0.25, 0.25);
    const len = rand(90, 300) * scale;
    const segs = 4 + Math.floor(Math.random() * 3);
    const ray = [[x, y]];
    for (let s = 1; s <= segs; s++) {
      const r = (len * s) / segs;
      const j = rand(-0.18, 0.18);
      ray.push([x + Math.cos(a + j) * r, y + Math.sin(a + j) * r]);
    }
    pts.push(ray);
    d += 'M' + ray.map(([px, py]) => p(px, py)).join(' L');
  }
  for (const ring of [1, 2]) {
    for (let i = 0; i < rays; i++) {
      if (Math.random() < 0.3) continue;
      const A = pts[i][ring];
      const B = pts[(i + 1) % rays][ring];
      d += `M${p(A[0], A[1])} L${p(B[0], B[1])}`;
    }
  }
  const g = document.createElementNS(SVG_NS, 'g');
  g.setAttribute('class', 'crack');
  g.style.transformOrigin = `${x}px ${y}px`;
  g.innerHTML = `
    <path d="${d}" fill="none" stroke="rgba(0,0,0,.35)" stroke-width="2.5" stroke-linecap="round"/>
    <path d="${d}" fill="none" stroke="rgba(255,255,255,.9)" stroke-width="1.1" stroke-linecap="round"/>`;
  $('#cracks').appendChild(g);
}

// ---------- 敲击动画 ----------

let sprite = null; // 精灵图形象:{ img, cell, cols, idle, combo }

function drawFrame(i, trail = 0) {
  const { img, cell, cols } = sprite;
  paintChar(img, (i % cols) * cell, Math.floor(i / cols) * cell, cell, cell, true, trail);
}

// 拳头在震屏层里的坐标(fx, fy 是拳头在格子里的比例位置)
function fistPoint(fx, fy) {
  const r = $('#figure').getBoundingClientRect();
  return toLocal(r.left + r.width * fx, r.top + r.height * fy);
}

const HIT_STOP = 80; // 打击停顿:砸中后镜头定格的毫秒数

// "镜头":整个形象的缩放/位移,蓄力时往后退,砸中时猛地冲向屏幕再回弹
let camAnim = null;
function cam(keyframes, opts) {
  camAnim?.cancel();
  camAnim = $('#figure').animate(keyframes, { fill: 'forwards', ...opts });
}

async function playIdle(ms) {
  const end = performance.now() + ms;
  for (let k = 0; running && performance.now() < end; k = (k + 1) % sprite.idle.length) {
    const [f, d] = sprite.idle[k];
    drawFrame(f);
    await sleep(d);
  }
}

async function playCombo() {
  const { combo } = sprite;
  const fig = $('#figure');
  for (let k = 0; k < combo.length && running; k++) {
    const [f, d, cue, fx, fy] = combo[k];
    // 下一次砸中在第几帧、拳头在哪:快速出拳帧要提前知道往哪里冲
    let h = k;
    while (h < combo.length && combo[h][2] !== 'hit') h++;
    const hit = combo[h];
    const fast = cue !== 'hit' && hit && d <= 60 && h - k <= 5;
    drawFrame(f, fast ? 0.5 : 0);
    if (cue === 'windup') {
      // 蓄力时长 = 到下一个 hit 之前的帧时长之和,镜头在这段时间里慢慢后退
      let pull = 0;
      for (let j = k; j < combo.length && combo[j][2] !== 'hit'; j++) pull += combo[j][1];
      if (hit) fig.style.transformOrigin = `${hit[3] * 100}% ${hit[4] * 100}%`;
      cam([{ transform: 'none' }, { transform: 'scale(0.93) translate(1.5%, 1.5%)' }], { duration: pull, easing: 'cubic-bezier(.2,.7,.4,1)' });
    }
    if (fast) {
      // 越接近砸中,径向模糊越强
      const [x, y] = fistPoint(hit[3], hit[4]);
      glass?.punch(x, y, 0.04 + 0.02 * (5 - (h - k)), 0, d);
    }
    if (cue === 'hit') {
      // 以拳头为中心猛推镜头,定格 HIT_STOP 毫秒(裂纹就在这时炸开),再回弹
      fig.style.transformOrigin = `${fx * 100}% ${fy * 100}%`;
      const total = HIT_STOP + 360;
      cam(
        [
          { transform: 'scale(1.3)' },
          { transform: 'scale(1.3)', offset: HIT_STOP / total, easing: 'cubic-bezier(.2,.8,.3,1)' },
          { transform: 'scale(0.97)', offset: (HIT_STOP + 170) / total, easing: 'ease-in-out' },
          { transform: 'none' },
        ],
        { duration: total }
      );
      await new Promise(requestAnimationFrame);
      const [x, y] = fistPoint(fx, fy);
      // 定格那一刻画面要清晰,只让颜色炸开一下
      glass?.punch(x, y, 0, 1, HIT_STOP);
      const r = fig.getBoundingClientRect();
      impact(r.left + r.width * fx, r.top + r.height * fy, true);
    }
    await sleep(d);
  }
}

// 自定义图片没有动作帧,整个身子往屏幕上撞
async function bodySlam() {
  cam([{ transform: 'none' }, { transform: 'translateY(2vh) scale(0.94)' }], { duration: 160, easing: 'ease-out' });
  await sleep(160);
  cam([{ transform: 'translateY(-4vh) scale(1.16)' }, { transform: 'none' }], { duration: 300, easing: 'cubic-bezier(.15,.85,.35,1)' });
  await new Promise(requestAnimationFrame);
  const r = $('#figure').getBoundingClientRect();
  impact(r.left + r.width / 2 + rand(-40, 40), r.top + r.height * 0.3 + rand(-20, 20), false);
  await sleep(300);
}

// 屏幕坐标 → 震屏层里的坐标(震屏会平移/缩放 #shaker)
function toLocal(x, y) {
  const r = $('#shaker').getBoundingClientRect();
  const sx = window.innerWidth / (r.width || 1);
  const sy = window.innerHeight / (r.height || 1);
  return [(x - r.left) * sx, (y - r.top) * sy];
}

function impact(vx, vy, heavy) {
  const [x, y] = toLocal(vx, vy);
  // 整块玻璃只有一个撞击点:第一拳砸出来,之后每一拳都让裂纹继续往外扩
  if (!hitAt) {
    hitAt = [x, y];
    if (glass) glass.crack(x, y);
    else addSvgCrack(x, y);
  } else {
    glass?.advance();
  }
  const glassHit = true;
  debris?.burst(hitAt[0], hitAt[1], heavy ? 12 : 6, Math.max(0.6, figW / 560));
  knockSound(glassHit, heavy);

  // 震屏
  const shaker = $('#shaker');
  const cls = heavy ? 'shake-heavy' : 'shake';
  shaker.classList.remove('shake', 'shake-heavy');
  void shaker.offsetWidth;
  shaker.classList.add(cls);

  // 冲击白光:拳头处一团强光,重击时整屏再闪一下
  const flash = $('#flash');
  const spot = `radial-gradient(circle at ${x}px ${y}px, rgba(255,255,255,.7), rgba(255,255,255,0) ${heavy ? 340 : 240}px)`;
  flash.style.background = heavy ? `${spot}, rgba(255,255,255,.14)` : spot;
  flash.animate([{ opacity: 1 }, { opacity: 0 }], { duration: heavy ? 260 : 200, easing: 'ease-out' });

  // 气泡被震得一歪
  if (bubbleShown) {
    const dx = rand(6, 12) * (Math.random() < 0.5 ? -1 : 1);
    $('#bubble').animate(
      [
        { transform: 'none' },
        { transform: `translate(${dx}px, ${rand(-8, -3)}px) rotate(${dx * 0.18}deg)`, offset: 0.18 },
        { transform: `translate(${-dx * 0.4}px, 2px) rotate(${-dx * 0.06}deg)`, offset: 0.5 },
        { transform: 'none' },
      ],
      { duration: 420, easing: 'ease-out' }
    );
  }

  // 咚!
  const bang = document.createElement('div');
  bang.className = 'bang';
  bang.textContent = ['咚!', '咚咚!', '哐!', '砰!'][Math.floor(Math.random() * 4)];
  bang.style.left = `${x + rand(60, 150)}px`;
  bang.style.top = `${y - rand(50, 90)}px`;
  bang.style.setProperty('--r', `${rand(-16, 10)}deg`);
  $('#bangs').appendChild(bang);
  setTimeout(() => bang.remove(), 850);
}

async function knockLoop() {
  while (running) {
    if (sprite) {
      await playCombo();
    } else {
      for (let i = 0; i < 3 && running; i++) await bodySlam();
    }
    if (!bubbleShown) {
      bubbleShown = true;
      $('#bubble').classList.remove('hidden');
      $('#done').focus();
    }
    if (sprite) await playIdle(1500);
    else await sleep(1500);
  }
}

// ---------- 关闭 ----------

let leaving = false;
async function leave(action) {
  if (leaving) return;
  leaving = true;
  running = false;
  document.body.classList.add('leaving');
  if (glass) {
    const t0 = performance.now();
    const fade = () => {
      const k = Math.min(1, (performance.now() - t0) / 300);
      glass.setGlass(1 - k);
      if (k < 1) requestAnimationFrame(fade);
    };
    fade();
  }
  $('#buddy').animate([{ transform: 'translateY(0)' }, { transform: 'translateY(120%)' }], {
    duration: 320,
    easing: 'cubic-bezier(.6,-0.3,.7,1)',
    fill: 'forwards',
  });
  await sleep(340);
  action === 'snooze' ? window.api.snooze() : window.api.done();
}

function startCountdown(sec) {
  const el = $('#countdown');
  if (!sec) {
    el.remove();
    $('#bubble .progress').remove();
    return;
  }
  const label = el.querySelector('span');
  const bar = $('#bubble .progress i');
  let left = sec;
  const render = () => (label.textContent = `${left} 秒后自动收起`);
  render();
  bar.animate([{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }], { duration: sec * 1000, easing: 'linear', fill: 'forwards' });
  const timer = setInterval(() => {
    left--;
    if (left <= 0) {
      clearInterval(timer);
      leave('done');
    } else render();
  }, 1000);
}

// ---------- 启动 ----------

(async function init() {
  data = await window.api.overlayData();
  if (!data) return window.api.done();

  const scale = data.scale ?? 0.55;
  document.documentElement.style.setProperty('--scale', scale);
  document.body.classList.toggle('dim', data.dim);
  $('#title').textContent = data.title;
  $('#message').textContent = data.message;
  $('#snooze').textContent = `${data.snoozeMin} 分钟后再敲`;
  const now = new Date();
  $('#clock').textContent = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  glass = new window.Glass($('#glass'));
  if (!glass.ok) glass = null;
  document.body.classList.toggle('webgl', !!glass);
  debris = new window.Debris($('#debris'));

  const vh = window.innerHeight / 100;
  const vw = window.innerWidth / 100;
  if (data.character.type === 'sprite') {
    const meta = data.character.value;
    const img = new Image();
    img.src = meta.sheet;
    await img.decode();
    const size = Math.min(72 * vh, 52 * vw) * scale;
    setupCharCanvas(size, size);
    $('#figure').classList.add('sprite');
    sprite = { img, cell: img.naturalWidth / meta.cols, cols: meta.cols, idle: meta.idle, combo: meta.combo };
    drawFrame(meta.idle[0][0]);
  } else {
    const img = document.createElement('img');
    img.src = data.character.value;
    img.className = 'src';
    await img.decode().catch(() => {});
    const ar = img.naturalWidth / (img.naturalHeight || 1) || 1;
    let h = 40 * vh * scale;
    let w = h * ar;
    if (w > 50 * vw * scale) {
      w = 50 * vw * scale;
      h = w / ar;
    }
    setupCharCanvas(w, h);
    $('#figure').appendChild(img); // 留在页面里,GIF 才会继续动
    const repaint = () => paintChar(img, 0, 0, img.naturalWidth, img.naturalHeight, false);
    repaint();
    if (glass) glass.beforeFrame = repaint; // 每帧重画,兼容动图
    else setInterval(repaint, 50);
  }
  if (glass) {
    glass.setCharacter(charCv, charCv);
    glass.start();
  }

  $('#done').addEventListener('click', () => leave('done'));
  $('#snooze').addEventListener('click', () => leave('snooze'));
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' || e.key === 'Enter') leave('done');
  });

  // 从屏幕下方冒出来
  await $('#buddy').animate(
    [{ transform: 'translateY(110%)' }, { transform: 'translateY(-6%)', offset: 0.75 }, { transform: 'translateY(0)' }],
    { duration: 650, easing: 'cubic-bezier(.2,.9,.3,1)' }
  ).finished;

  startCountdown(data.autoCloseSec);
  if (sprite) await playIdle(400); // 先瞪一眼再动手
  knockLoop();
})();
