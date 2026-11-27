// 玻璃碎裂渲染器(WebGL2)
//
// 屏幕前有一块玻璃,形象在玻璃后面。第一拳在玻璃上砸出唯一的撞击点,
// 之后每一拳都让同一张裂纹网继续往外扩,两拳之间也会慢慢蔓延,直到裂满整个屏幕。
//
// 做法:
//   1. 第一拳时一次性生成整张裂纹网(几条一路裂到屏幕边缘的主裂纹、少量分叉、撞击点附近一两圈环裂)
//   2. 用泛洪填充把屏幕按裂纹切成一块块碎片,每块碎片分到一个"错位量"(离撞击点越近越大),存进法线图
//   3. 着色器里只让"裂纹前沿"以内的碎片错位 → 裂纹长到哪里,哪里的画面就错开
// 浮层读不到下面桌面的像素,所以只有形象会被碎片错开;
// 桌面部分靠裂纹亮线、断面的明暗与色散边、碎片明暗和反光来表现

(() => {
  const TAU = Math.PI * 2;
  const rand = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  // 每一拳把裂纹前沿一口气崩到"撞击点到最远屏幕角距离"的这些比例,三拳裂满
  const STAGES = [0.4, 0.72, 1.08];
  // 裂纹尖端的速度(像素/秒):刚砸中时最快,快到这一拳的终点时减速
  const TIP_SPEED = 2600;
  const TIP_DECEL = 7; // 额外速度 = 剩余距离 × 这个系数
  const REFR = 12; // 碎片因倾斜产生的折射偏移(像素,撞击点附近最大)
  const BEVEL = 7; // 裂纹断面把画面拉扯的幅度(像素)
  const BEVEL_W = 11; // 断面影响的宽度(像素)
  const DIST_MAX = 32; // 距离场存储的最大距离(像素)
  const DEPTH = [0.8, 1.05, 1.25, 1.4, 1.5]; // 每一拳碎片陷得更深

  const VERT = `#version 300 es
in vec2 aPos;
uniform vec2 uRes;
out vec2 vPx;
void main() {
  vPx = vec2(aPos.x * .5 + .5, .5 - aPos.y * .5) * uRes;
  gl_Position = vec4(aPos, 0., 1.);
}`;

  const FRAG = `#version 300 es
precision highp float;
in vec2 vPx;
out vec4 outColor;

uniform vec2 uRes;          // 画布尺寸(CSS 像素)
uniform sampler2D uNorm;    // rg: 碎片错位方向, b: 碎片光泽, a: 有碎片
uniform sampler2D uCrack;   // r: 裂纹线, g: 粉碎区白雾, b: 细碎纹(预乘,带 mipmap,用来取模糊版)
uniform sampler2D uChar;    // 形象(预乘)
uniform vec4 uCharRect;     // 形象贴图在画布上的位置 x, y, w, h
uniform vec2 uCenter;       // 撞击点
uniform float uFront;       // 裂纹前沿离撞击点的距离
uniform float uRefr;        // 碎片错位(像素)
uniform float uFlash;       // 砸中瞬间的闪光
uniform float uAlpha;
uniform float uGlass;       // 玻璃效果整体强度(收起时淡出)
uniform float uFresh;       // 刚崩出的裂纹先亮一下
uniform sampler2D uDist;    // 到最近裂纹的距离(0~1 对应 0~32px)
uniform float uBevel;
uniform float uBevelW;
uniform vec4 uZoom;         // 拳头冲脸:中心 x, y, 径向模糊强度, 色散强度

vec4 charAt(vec2 px) {
  vec2 t = (px - uCharRect.xy) / uCharRect.zw;
  if (t.x < 0. || t.y < 0. || t.x > 1. || t.y > 1.) return vec4(0.);
  return texture(uChar, t);
}

// 出拳时形象沿着"从拳头往外"的方向拉出径向模糊,砸中瞬间红蓝通道再炸开一下
vec4 charFx(vec2 px) {
  if (uZoom.z < .002 && uZoom.w < .002) return charAt(px);
  vec2 c = uZoom.xy;
  float k = uZoom.w * .03;
  vec4 acc = vec4(0.);
  for (int i = 0; i < 12; i++) {
    float t = float(i) / 11.;
    vec2 q = c + (px - c) * (1. - uZoom.z * t);
    if (k > .0005) {
      vec4 r = charAt(c + (q - c) * (1. - k));
      vec4 g = charAt(q);
      vec4 b = charAt(c + (q - c) * (1. + k));
      acc += vec4(r.r, g.g, b.b, max(g.a, max(r.a, b.a)));
    } else {
      acc += charAt(q);
    }
  }
  return acc / 12.;
}

// 玻璃后面能被错开的只有形象(桌面在浮层窗口之外,读不到)
vec4 scene(vec2 px) {
  return charFx(px);
}

// 把一层颜色 col(不透明度 a)叠在已有结果上(预乘)
vec4 over(vec4 dst, vec3 col, float a) {
  return vec4(dst.rgb * (1. - a) + col * a, dst.a + a * (1. - dst.a));
}

void main() {
  vec2 px = vPx;
  vec2 uv = px / uRes;
  float dist = length(px - uCenter);
  float front = 1. - smoothstep(uFront - 70., uFront, dist);
  vec4 nm = texture(uNorm, uv);
  float m = nm.a * front * uGlass;
  vec4 ck = texture(uCrack, uv) * uGlass;
  float halo = textureLod(uCrack, uv, 4.).r * uGlass;

  if (m < .002 && halo < .002 && ck.r + ck.g + ck.b < .002) {
    outColor = charFx(px) * uAlpha;
    return;
  }

  vec2 tilt = nm.a > .004 ? nm.rg / nm.a * 2. - 1. : vec2(0.);
  float sheen = nm.a > .004 ? nm.b / nm.a : 0.;
  float near = exp(-dist / 260.);

  // 裂纹断面:靠近裂纹的几像素里玻璃是斜的,像一道细棱镜。
  // 用距离场的梯度得到"背离裂纹"的方向,越贴近裂纹拉扯越强
  float D = texture(uDist, uv).r * 32.;
  vec2 h = vec2(1.5) / uRes;
  vec2 g = vec2(texture(uDist, uv + vec2(h.x, 0.)).r - texture(uDist, uv - vec2(h.x, 0.)).r,
                texture(uDist, uv + vec2(0., h.y)).r - texture(uDist, uv - vec2(0., h.y)).r);
  vec2 gdir = length(g) > 1e-5 ? normalize(g) : vec2(0.);
  float bev = 1. - clamp(D / uBevelW, 0., 1.);
  bev = bev * bev * front * uGlass;

  vec2 off = tilt * uRefr * m - gdir * uBevel * bev;
  vec2 disp = tilt * m * 1.2 - gdir * bev * 2.6;   // 色散:断面处最明显
  vec4 sR = scene(px + off + disp);
  vec4 sG = scene(px + off);
  vec4 sB = scene(px + off - disp);
  vec4 refr = vec4(sR.r, sG.g, sB.b, max(sG.a, max(sR.a, sB.a)));
  float reach = max(m, max(bev, smoothstep(0., .06, halo)));
  vec4 col = mix(charFx(px), refr, reach);

  // 断面的立体感:朝光的一侧亮,背光的一侧暗
  vec2 L2 = normalize(vec2(-.45, -.75));
  float side = dot(gdir, L2) * bev;
  col = over(col, vec3(1.), clamp(side * .3, 0., .3));
  col = over(col, vec3(0.), clamp(-side * .3, 0., .3));

  // 每块碎片倾斜角度不同,反射的环境光也不同:朝光的亮一点,背光的暗一点
  float face = dot(tilt, -L2) * m;
  col = over(col, face > 0. ? vec3(1.) : vec3(0.), clamp(abs(face) * .1, 0., .1));

  // 桌面看不到被错开,用"玻璃本身"的东西来表现:烟灰色厚度、碎片明暗差
  col = over(col, vec3(.07, .09, .12), .06 * m);
  col = over(col, sheen > .5 ? vec3(1.) : vec3(0.), abs(sheen - .5) * .08 * m);
  // 裂纹两侧一冷一暖的色散边,模拟光线在断面上被分开
  float cA = texture(uCrack, uv + vec2(-1.8, -1.2) / uRes).r * uGlass;
  float cB = texture(uCrack, uv + vec2(1.8, 1.2) / uRes).r * uGlass;
  col = over(col, vec3(1., .55, .25), clamp(cA * (1. - ck.r) * .4, 0., .5));
  col = over(col, vec3(.3, .8, 1.), clamp(cB * (1. - ck.r) * .4, 0., .5));

  // 碎片反光:离撞击点越近越容易闪,远处的大块碎片只轻轻反一点光
  vec3 N = normalize(vec3(-tilt * .85, 1.));
  vec3 H = normalize(normalize(vec3(-.45, -.75, .6)) + vec3(0., 0., 1.));
  float spec = pow(max(dot(N, H), 0.), 70.) * .5 + pow(max(dot(N, H), 0.), 8.) * .05;
  spec *= m * (.5 + .5 * sheen) * (.25 + .75 * near) * (1. + uFlash * 1.6);
  spec += uFlash * .14 * m * sheen * near;
  col = over(col, vec3(.96, .98, 1.), clamp(spec, 0., .7));

  // 粉碎区:白色碎屑雾
  col = over(col, vec3(.93, .95, .97), clamp(ck.g * .8, 0., .9));

  // 裂纹:断面反光是亮线,旁边有一点暗边
  float shadow = texture(uCrack, uv + vec2(1.3, 1.6) / uRes).r * uGlass;
  col = over(col, vec3(.02, .03, .05), clamp(shadow * (1. - ck.r) * .45, 0., .6));
  col = over(col, vec3(.97, .985, 1.), clamp((ck.r * .92 + ck.b * .5) * (1. + uFresh * .6), 0., 1.));
  col = over(col, vec3(.85, .9, 1.), clamp(halo * (.1 + uFresh * .5), 0., .45));

  outColor = col * uAlpha;
}`;

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }

  function canvas2d(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  }

  // ---------- 裂纹网 ----------

  // 从 (x, y) 大致朝 a 方向走,直到走出屏幕或走够 maxLen;偶尔拐个小弯
  function walk(cx, cy, x, y, a, maxLen, W, H) {
    const step = 12;
    const pts = [{ x, y, r: Math.hypot(x - cx, y - cy) }];
    let dir = a;
    let len = 0;
    while (len < maxLen && x > -40 && y > -40 && x < W + 40 && y < H + 40 && pts.length < 3000) {
      dir += rand(-0.07, 0.07) + (a - dir) * 0.06;
      if (Math.random() < 0.035) dir += rand(-0.3, 0.3);
      x += Math.cos(dir) * step;
      y += Math.sin(dir) * step;
      len += step;
      pts.push({ x, y, r: Math.hypot(x - cx, y - cy) });
    }
    return pts;
  }

  // 主裂纹上第一次到达半径 r 的位置
  function at(pts, r) {
    if (pts[0].r > r) return null;
    for (let i = 1; i < pts.length; i++) {
      if (pts[i].r >= r) {
        const a = pts[i - 1];
        const b = pts[i];
        const t = (r - a.r) / (b.r - a.r || 1);
        return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, r };
      }
    }
    return null;
  }

  function buildNetwork(cx, cy, W, H) {
    const R = Math.max(...[[0, 0], [W, 0], [0, H], [W, H]].map(([x, y]) => Math.hypot(x - cx, y - cy)));
    const crushR = rand(12, 18);
    const lines = [];
    const rays = [];

    // 主裂纹:每一条都一路裂到屏幕边缘
    const n = 12 + Math.floor(Math.random() * 5);
    const base = Math.random() * TAU;
    const angles = [];
    for (let i = 0; i < n; i++) angles.push(base + ((i + rand(-0.3, 0.3)) * TAU) / n);
    for (let i = 0; i < n; i++) {
      const a = angles[i];
      const pts = walk(cx, cy, cx + Math.cos(a) * crushR * 0.6, cy + Math.sin(a) * crushR * 0.6, a, Infinity, W, H);
      const k = rand(0.78, 1); // 每条裂纹跑得快慢不一
      rays.push({ a, pts, k });
      let glint = rand(0.6, 1);
      for (let j = 1; j < pts.length; j++) {
        if (j % 3 === 1) glint = clamp(glint + rand(-0.35, 0.35), 0.45, 1);
        const p = pts[j - 1];
        lines.push({ e: p.r / rays[i].k, a: p, b: pts[j], w: 0.85 + 1.5 * Math.exp(-p.r / 140), alpha: glint });
      }
    }

    // 分叉:越往外主裂纹间距越大,用分叉把外圈填起来。
    // 分叉方向落在自己和相邻裂纹之间,所以只会往空隙里长,不会和别的裂纹交叉,一样裂到边缘
    for (let i = 0; i < n; i++) {
      const ray = rays[i];
      const count = (Math.random() < 0.65 ? 1 : 0) + (Math.random() < 0.3 ? 1 : 0);
      for (let q = 0; q < count; q++) {
        const p = ray.pts[Math.floor(ray.pts.length * rand(0.12, 0.55))];
        if (!p) continue;
        const side = Math.random() < 0.5 ? -1 : 1;
        const nb = angles[(i + side + n) % n] + (i + side < 0 ? -TAU : i + side >= n ? TAU : 0);
        const ba = ray.a + (nb - ray.a) * rand(0.35, 0.6);
        const bp = walk(cx, cy, p.x, p.y, ba, Infinity, W, H);
        let glint = rand(0.5, 0.85);
        for (let j = 1; j < bp.length; j++) {
          if (j % 3 === 1) glint = clamp(glint + rand(-0.3, 0.3), 0.45, 0.9);
          lines.push({ e: bp[j - 1].r / ray.k, a: bp[j - 1], b: bp[j], w: 0.8, alpha: glint });
        }
      }
    }

    // 环裂:撞击点附近一两圈,外围偶尔一段大弧
    const rings = [
      { r: rand(34, 50), p: 0.92 },
      { r: rand(90, 135), p: 0.6 },
      { r: R * rand(0.3, 0.42), p: 0.2 },
    ];
    for (const ring of rings) {
      for (let i = 0; i < n; i++) {
        if (Math.random() > ring.p) continue;
        const A = at(rays[i].pts, ring.r);
        const B = at(rays[(i + 1) % n].pts, ring.r);
        if (!A || !B) continue;
        const dx = B.x - A.x;
        const dy = B.y - A.y;
        const L = Math.hypot(dx, dy) || 1;
        const segs = Math.max(2, Math.round(L / 30));
        const bow = rand(-0.04, 0.04) * L;
        const alpha = rand(0.45, 0.85);
        let prev = A;
        for (let s = 1; s <= segs; s++) {
          const t = s / segs;
          const j = s === segs ? 0 : rand(-0.025, 0.025) * L + Math.sin(t * Math.PI) * bow;
          const cur = { x: A.x + dx * t - (dy / L) * j, y: A.y + dy * t + (dx / L) * j };
          lines.push({ e: ring.r / Math.min(rays[i].k, rays[(i + 1) % n].k), a: prev, b: cur, w: rand(0.85, 1.2), alpha });
          prev = cur;
        }
      }
    }

    // 粉碎区
    const crush = [];
    for (let k = 0; k < 18; k++) {
      const a = Math.random() * TAU;
      const r = Math.sqrt(Math.random()) * crushR;
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      const s = crushR * rand(0.25, 0.55);
      const b = Math.random() * TAU;
      crush.push({
        poly: [0, 1, 2].map((q) => ({ x: x + Math.cos(b + q * 2.1 + rand(-0.4, 0.4)) * s, y: y + Math.sin(b + q * 2.1 + rand(-0.4, 0.4)) * s })),
        tx: rand(-1, 1),
        ty: rand(-1, 1),
        sheen: Math.random(),
      });
    }
    const micro = [];
    for (let k = 0; k < 26; k++) {
      const a = Math.random() * TAU;
      const r = Math.sqrt(Math.random()) * crushR * 1.6;
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      const b = Math.random() * TAU;
      const l = crushR * rand(0.2, 0.6);
      micro.push({ a: { x, y }, b: { x: x + Math.cos(b) * l, y: y + Math.sin(b) * l }, alpha: rand(0.3, 0.8) });
    }

    // e:这一段裂纹在前沿走到多远时出现(距离 ÷ 这条裂纹的速度系数)
    lines.sort((a, b) => a.e - b.e);
    const maxE = lines.length ? lines[lines.length - 1].e : R;
    return { cx, cy, R, maxE, crushR, lines, crush, micro };
  }

  // 按裂纹把屏幕切成碎片,每块碎片一个错位方向 → 法线图
  function shardMap(net, W, H) {
    const s = Math.min(1, Math.sqrt(2.4e6 / (W * H)));
    const w = Math.round(W * s);
    const h = Math.round(H * s);
    const c = canvas2d(w, h);
    const x = c.getContext('2d', { willReadFrequently: true });
    x.strokeStyle = '#000';
    x.lineWidth = 1.8;
    x.lineCap = 'round';
    x.beginPath();
    for (const l of net.lines) {
      x.moveTo(l.a.x * s, l.a.y * s);
      x.lineTo(l.b.x * s, l.b.y * s);
    }
    x.stroke();
    const px = x.getImageData(0, 0, w, h).data;

    const N = w * h;
    const lab = new Int32Array(N);
    for (let i = 0; i < N; i++) lab[i] = px[i * 4 + 3] > 50 ? -2 : -1;
    const stack = new Int32Array(N);
    const regions = [];
    for (let i = 0; i < N; i++) {
      if (lab[i] !== -1) continue;
      const id = regions.length;
      let sp = 0;
      let sx = 0;
      let sy = 0;
      let cnt = 0;
      stack[sp++] = i;
      lab[i] = id;
      while (sp) {
        const k = stack[--sp];
        const kx = k % w;
        const ky = (k - kx) / w;
        sx += kx;
        sy += ky;
        cnt++;
        if (kx > 0 && lab[k - 1] === -1) (lab[k - 1] = id), (stack[sp++] = k - 1);
        if (kx < w - 1 && lab[k + 1] === -1) (lab[k + 1] = id), (stack[sp++] = k + 1);
        if (ky > 0 && lab[k - w] === -1) (lab[k - w] = id), (stack[sp++] = k - w);
        if (ky < h - 1 && lab[k + w] === -1) (lab[k + w] = id), (stack[sp++] = k + w);
      }
      regions.push({ x: sx / cnt / s, y: sy / cnt / s, n: cnt });
    }
    // 到最近裂纹的距离场(精确欧氏距离),给着色器做断面效果
    const dist = distanceField(lab, w, h, s);
    // 裂纹线本身归到相邻碎片,免得留下一条没错位的细缝
    for (let pass = 0; pass < 4; pass++) {
      for (let i = 0; i < N; i++) {
        if (lab[i] !== -2) continue;
        const ix = i % w;
        if (ix > 0 && lab[i - 1] >= 0) lab[i] = lab[i - 1];
        else if (i >= w && lab[i - w] >= 0) lab[i] = lab[i - w];
        else if (ix < w - 1 && lab[i + 1] >= 0) lab[i] = lab[i + 1];
        else if (i + w < N && lab[i + w] >= 0) lab[i] = lab[i + w];
      }
    }

    const col = regions.map((r) => {
      const d = Math.hypot(r.x - net.cx, r.y - net.cy);
      // 撞击把玻璃压成一个浅浅的凹锥:碎片都朝撞击点倾斜,越靠近越陡;
      // 方向只带一点随机,相邻碎片偏移相近,只在裂纹处留下小台阶
      const a = Math.atan2(net.cy - r.y, net.cx - r.x) + rand(-0.45, 0.45);
      const mag = (0.2 + 0.8 * Math.exp(-d / (0.22 * net.R))) * rand(0.7, 1);
      return [128 + 127 * Math.cos(a) * mag, 128 + 127 * Math.sin(a) * mag, Math.random() * 255];
    });
    const img = x.createImageData(w, h);
    const o = img.data;
    for (let i = 0; i < N; i++) {
      const cc = lab[i] >= 0 ? col[lab[i]] : null;
      if (!cc) continue;
      o[i * 4] = cc[0];
      o[i * 4 + 1] = cc[1];
      o[i * 4 + 2] = cc[2];
      o[i * 4 + 3] = 255;
    }
    x.putImageData(img, 0, 0);

    // 撞击点的小碎渣盖在最上面
    for (const t of net.crush) {
      x.fillStyle = `rgb(${Math.round((t.tx * 0.5 + 0.5) * 255)},${Math.round((t.ty * 0.5 + 0.5) * 255)},${Math.round(t.sheen * 255)})`;
      x.beginPath();
      t.poly.forEach((p, i) => (i ? x.lineTo(p.x * s, p.y * s) : x.moveTo(p.x * s, p.y * s)));
      x.closePath();
      x.fill();
    }
    return { norm: c, dist };
  }

  // Felzenszwalb 距离变换:先按列、再按行做一维平方距离变换
  function edt1d(f, n, d, v, z) {
    let k = 0;
    v[0] = 0;
    z[0] = -Infinity;
    z[1] = Infinity;
    for (let q = 1; q < n; q++) {
      let sct = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (sct <= z[k]) {
        k--;
        sct = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++;
      v[k] = q;
      z[k] = sct;
      z[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1] < q) k++;
      d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
    }
  }

  function distanceField(lab, w, h, s) {
    const INF = 1e12;
    const g = new Float64Array(w * h);
    for (let i = 0; i < w * h; i++) g[i] = lab[i] === -2 ? 0 : INF;
    const n = Math.max(w, h);
    const f = new Float64Array(n);
    const d = new Float64Array(n);
    const v = new Int32Array(n);
    const z = new Float64Array(n + 1);
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) f[y] = g[y * w + x];
      edt1d(f, h, d, v, z);
      for (let y = 0; y < h; y++) g[y * w + x] = d[y];
    }
    for (let y = 0; y < h; y++) {
      const o = y * w;
      for (let x = 0; x < w; x++) f[x] = g[o + x];
      edt1d(f, w, d, v, z);
      for (let x = 0; x < w; x++) g[o + x] = d[x];
    }
    const c = canvas2d(w, h);
    const cx = c.getContext('2d');
    const img = cx.createImageData(w, h);
    const o = img.data;
    for (let i = 0; i < w * h; i++) {
      const px = Math.min(DIST_MAX, Math.sqrt(g[i]) / s);
      const val = Math.round((px / DIST_MAX) * 255);
      o[i * 4] = o[i * 4 + 1] = o[i * 4 + 2] = val;
      o[i * 4 + 3] = 255;
    }
    cx.putImageData(img, 0, 0);
    return c;
  }

  // ---------- 渲染器 ----------

  class Glass {
    constructor(canvas) {
      this.canvas = canvas;
      const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, alpha: true, antialias: false });
      this.ok = !!gl;
      if (!gl) return;
      this.gl = gl;

      const W = (this.W = window.innerWidth);
      const H = (this.H = window.innerHeight);
      const dpr = (this.dpr = Math.min(window.devicePixelRatio || 1, 2));
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);

      try {
        const prog = gl.createProgram();
        gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
        gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
        this.prog = prog;
      } catch (err) {
        console.error(err);
        this.ok = false;
        return;
      }
      gl.useProgram(this.prog);

      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(this.prog, 'aPos');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

      this.u = {};
      for (const n of ['uRes', 'uNorm', 'uCrack', 'uChar', 'uCharRect', 'uCenter', 'uFront', 'uRefr', 'uFlash', 'uAlpha', 'uGlass', 'uFresh', 'uZoom', 'uDist', 'uBevel', 'uBevelW']) {
        this.u[n] = gl.getUniformLocation(this.prog, n);
      }

      // 裂纹线要清晰,用设备像素
      this.crackC = canvas2d(W * dpr, H * dpr);
      this.crackX = this.crackC.getContext('2d');
      this.crackX.globalCompositeOperation = 'lighter';
      this.crackX.lineCap = 'round';
      this.crackX.lineJoin = 'round';

      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      this.tNorm = this.texture(0);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
      const levels = Math.floor(Math.log2(Math.max(this.crackC.width, this.crackC.height))) + 1;
      this.tCrack = this.texture(1, true);
      gl.texStorage2D(gl.TEXTURE_2D, levels, gl.RGBA8, this.crackC.width, this.crackC.height);
      gl.generateMipmap(gl.TEXTURE_2D);
      this.tChar = this.texture(2);
      this.tDist = this.texture(4);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));

      gl.uniform1i(this.u.uNorm, 0);
      gl.uniform1i(this.u.uCrack, 1);
      gl.uniform1i(this.u.uChar, 2);
      gl.uniform1i(this.u.uDist, 4);
      gl.uniform1f(this.u.uBevel, BEVEL);
      gl.uniform1f(this.u.uBevelW, BEVEL_W);
      gl.uniform2f(this.u.uRes, W, H);
      gl.uniform1f(this.u.uRefr, REFR);
      gl.uniform1f(this.u.uFront, 0);
      gl.uniform1f(this.u.uFresh, 0);
      gl.uniform4f(this.u.uZoom, 0, 0, 0, 0);
      this.zoom = { x: 0, y: 0, blur: 0, kick: 0, until: 0 };
      this.lastT = performance.now();

      this.net = null;
      this.flashT = -1e9;
      this.hitT = -1e9;
      this.alpha = 1;
      this.glassK = 1;
      this.beforeFrame = null;
      this.charSrc = null;
      this.charDirty = false;
      this.lastKey = '';
      this.raf = 0;
    }

    texture(unit, mip = false) {
      const gl = this.gl;
      const t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    }

    // 形象来自一张 2D canvas;rectEl 是它在页面上的位置(随镜头动画变化)
    setCharacter(src, rectEl) {
      this.charSrc = src;
      this.charEl = rectEl;
      this.charDirty = true;
    }

    markChar() {
      this.charDirty = true;
    }

    get cracked() {
      return !!this.net;
    }

    // 第一拳:砸出唯一的撞击点,生成整张裂纹网
    crack(x, y) {
      if (this.net) return this.advance();
      const net = buildNetwork(x, y, this.W, this.H);
      const map = shardMap(net, this.W, this.H);
      const gl = this.gl;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.tNorm);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, map.norm);
      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_2D, this.tDist);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, map.dist);
      gl.uniform2f(this.u.uCenter, x, y);
      this.net = { ...net, i: 0, stage: 0, hits: 1, front: 0, target: net.R * STAGES[0], crushDrawn: false };
      this.last = performance.now();
      this.flashT = this.hitT = performance.now();
    }

    // 后面每一拳:裂纹继续往外扩一段
    advance() {
      const net = this.net;
      if (!net) return;
      net.stage = Math.min(net.stage + 1, STAGES.length - 1);
      net.hits++;
      const last = net.stage === STAGES.length - 1;
      net.target = Math.max(net.target, last ? net.maxE + 20 : net.R * STAGES[net.stage]);
      this.flashT = this.hitT = performance.now();
    }

    // 拳头冲脸的画面效果:hold 毫秒内保持,之后迅速衰减
    punch(x, y, blur, kick, hold) {
      this.zoom = { x, y, blur, kick, until: performance.now() + hold };
    }

    setAlpha(a) {
      this.alpha = a;
    }

    setGlass(k) {
      this.glassK = k;
    }

    start() {
      const loop = () => {
        this.raf = requestAnimationFrame(loop);
        this.frame();
      };
      loop();
    }

    stop() {
      cancelAnimationFrame(this.raf);
    }

    // 把前沿以内、还没画的裂纹画上去;返回这次改动的范围
    grow(net) {
      const cx = this.crackX;
      const k = this.dpr;
      let box = null;
      const add = (x, y, pad) => {
        box ||= [x, y, x, y];
        box[0] = Math.min(box[0], x - pad);
        box[1] = Math.min(box[1], y - pad);
        box[2] = Math.max(box[2], x + pad);
        box[3] = Math.max(box[3], y + pad);
      };
      if (!net.crushDrawn) {
        net.crushDrawn = true;
        const R = net.crushR * 1.6;
        const grd = cx.createRadialGradient(net.cx * k, net.cy * k, 0, net.cx * k, net.cy * k, R * k);
        grd.addColorStop(0, 'rgba(0,255,0,.85)');
        grd.addColorStop(0.45, 'rgba(0,255,0,.4)');
        grd.addColorStop(1, 'rgba(0,255,0,0)');
        cx.fillStyle = grd;
        cx.beginPath();
        cx.arc(net.cx * k, net.cy * k, R * k, 0, TAU);
        cx.fill();
        cx.lineWidth = 0.7 * k;
        for (const l of net.micro) {
          cx.strokeStyle = `rgba(0,0,255,${l.alpha})`;
          cx.beginPath();
          cx.moveTo(l.a.x * k, l.a.y * k);
          cx.lineTo(l.b.x * k, l.b.y * k);
          cx.stroke();
        }
        add(net.cx, net.cy, R * 2);
      }
      const lines = net.lines;
      while (net.i < lines.length && lines[net.i].e <= net.front) {
        const l = lines[net.i++];
        cx.strokeStyle = `rgba(255,0,0,${l.alpha})`;
        cx.lineWidth = l.w * k;
        cx.beginPath();
        cx.moveTo(l.a.x * k, l.a.y * k);
        cx.lineTo(l.b.x * k, l.b.y * k);
        cx.stroke();
        add(l.a.x, l.a.y, 6);
        add(l.b.x, l.b.y, 6);
      }
      return box;
    }

    // 只把改动的区域传到显卡,避免每帧上传整屏
    upload(box) {
      const gl = this.gl;
      const src = this.crackC;
      const k = this.dpr;
      const x0 = clamp(Math.floor(box[0] * k), 0, src.width);
      const y0 = clamp(Math.floor(box[1] * k), 0, src.height);
      const x1 = clamp(Math.ceil(box[2] * k), 0, src.width);
      const y1 = clamp(Math.ceil(box[3] * k), 0, src.height);
      if (x1 <= x0 || y1 <= y0) return;
      const tmp = (this.tmp ||= document.createElement('canvas'));
      tmp.width = x1 - x0;
      tmp.height = y1 - y0;
      const tx = tmp.getContext('2d');
      tx.clearRect(0, 0, tmp.width, tmp.height);
      tx.drawImage(src, x0, y0, tmp.width, tmp.height, 0, 0, tmp.width, tmp.height);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.tCrack);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, x0, y0, gl.RGBA, gl.UNSIGNED_BYTE, tmp);
      gl.generateMipmap(gl.TEXTURE_2D);
    }

    frame() {
      const gl = this.gl;
      const now = performance.now();
      let changed = false;
      this.beforeFrame?.();
      const fdt = Math.min(0.1, (now - this.lastT) / 1000);
      this.lastT = now;
      const z = this.zoom;
      if (z.blur > 0 || z.kick > 0) {
        if (now > z.until) {
          z.blur *= Math.exp(-fdt / 0.08);
          z.kick *= Math.exp(-fdt / 0.07);
          if (z.blur < 0.002) z.blur = 0;
          if (z.kick < 0.002) z.kick = 0;
        }
        gl.uniform4f(this.u.uZoom, z.x, z.y, z.blur, z.kick);
        changed = true;
      } else if (this.zoomWasOn) {
        gl.uniform4f(this.u.uZoom, 0, 0, 0, 0);
        changed = true;
      }
      this.zoomWasOn = z.blur > 0 || z.kick > 0;

      const net = this.net;
      if (net && net.target - net.front > 0.5) {
        const dt = Math.min(0.1, (now - this.last) / 1000);
        const left = net.target - net.front;
        net.front += Math.min(left, (TIP_SPEED + left * TIP_DECEL) * dt);
        const box = this.grow(net);
        if (box) this.upload(box);
        gl.uniform1f(this.u.uFront, net.front * 0.78);
        changed = true;
      }
      this.last = now;

      // 形象位置:换算到画布自己的 CSS 坐标(震屏时两者一起动)
      let rect = [0, 0, 0, 0];
      if (this.charSrc && this.charEl) {
        const cr = this.canvas.getBoundingClientRect();
        const r = this.charEl.getBoundingClientRect();
        const sx = this.W / (cr.width || 1);
        const sy = this.H / (cr.height || 1);
        rect = [(r.left - cr.left) * sx, (r.top - cr.top) * sy, r.width * sx, r.height * sy];
      }
      const flash = clamp(1 - (now - this.flashT) / 260, 0, 1);
      // 砸中后:冲击波扩散、碎片猛地陷下去再弹回、新裂纹发亮
      const th = (now - this.hitT) / 1000;
      const live = net && th < 0.9;
      if (net) {
        const depth = DEPTH[Math.min(net.hits - 1, DEPTH.length - 1)];
        gl.uniform1f(this.u.uRefr, REFR * depth);
        gl.uniform1f(this.u.uFresh, th < 0.9 ? Math.exp(-th / 0.22) : 0);
        if (live) changed = true;
      }
      const key = rect.map((v) => v.toFixed(2)).join() + '|' + this.alpha + '|' + this.glassK;
      if (key !== this.lastKey || flash > 0) changed = true;
      this.lastKey = key;

      if (this.charSrc && this.charDirty) {
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, this.tChar);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.charSrc);
        this.charDirty = false;
        changed = true;
      }
      if (!changed) return;

      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.uniform4f(this.u.uCharRect, ...rect);
      gl.uniform1f(this.u.uFlash, flash * flash);
      gl.uniform1f(this.u.uAlpha, this.alpha);
      gl.uniform1f(this.u.uGlass, this.glassK);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
  }

  // ---------- 飞溅的小碎片(纯 2D) ----------

  class Debris {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(window.innerWidth * this.dpr);
      canvas.height = Math.round(window.innerHeight * this.dpr);
      this.bits = [];
      this.raf = 0;
    }

    burst(x, y, n, scale = 1) {
      for (let i = 0; i < n; i++) {
        const a = rand(-Math.PI * 0.95, -Math.PI * 0.05) + (Math.random() < 0.3 ? Math.PI : 0);
        const v = rand(120, 520) * scale;
        const s = rand(3, 11) * scale;
        const sides = Math.random() < 0.6 ? 3 : 4;
        this.bits.push({
          x: x + rand(-10, 10),
          y: y + rand(-10, 10),
          vx: Math.cos(a) * v,
          vy: Math.sin(a) * v - rand(40, 160),
          rot: Math.random() * TAU,
          vr: rand(-14, 14),
          pts: Array.from({ length: sides }, (_, q) => {
            const ang = (q / sides) * TAU + rand(-0.5, 0.5);
            const rr = s * rand(0.5, 1.2);
            return [Math.cos(ang) * rr, Math.sin(ang) * rr];
          }),
          life: rand(0.55, 0.95),
          t: 0,
        });
      }
      if (!this.raf) {
        this.last = performance.now();
        this.raf = requestAnimationFrame(() => this.tick());
      }
    }

    tick() {
      const now = performance.now();
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      const { ctx, dpr } = this;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      for (const b of this.bits) {
        b.t += dt;
        b.vy += 1500 * dt;
        b.vx *= 0.985;
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        b.rot += b.vr * dt;
        const fade = clamp(1 - b.t / b.life, 0, 1);
        const glint = 0.5 + 0.5 * Math.sin(b.rot * 2.3);
        ctx.save();
        ctx.translate(b.x, b.y);
        ctx.rotate(b.rot);
        ctx.beginPath();
        b.pts.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
        ctx.closePath();
        ctx.fillStyle = `rgba(215,230,245,${(0.18 + glint * 0.35) * fade})`;
        ctx.fill();
        ctx.lineWidth = 0.8;
        ctx.strokeStyle = `rgba(255,255,255,${(0.45 + glint * 0.5) * fade})`;
        ctx.stroke();
        ctx.restore();
      }
      this.bits = this.bits.filter((b) => b.t < b.life);
      this.raf = this.bits.length ? requestAnimationFrame(() => this.tick()) : 0;
      if (!this.raf) ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
  }

  window.Glass = Glass;
  window.Debris = Debris;
})();
