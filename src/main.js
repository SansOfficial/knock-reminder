const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, dialog, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// 敲击声在浮层弹出时就要响,不能等用户先点一下
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const IS_MAC = process.platform === 'darwin';
const PRELOAD = path.join(__dirname, 'preload.js');

// 内置形象是精灵图:src/characters/<id>/ 下的 sheet.png + meta.json(时间轴说明见该目录 README)
function loadSpriteCharacter(id) {
  const meta = JSON.parse(fs.readFileSync(path.join(__dirname, 'characters', id, 'meta.json'), 'utf8'));
  const base = `characters/${id}/`;
  return {
    id,
    name: meta.name,
    thumb: base + meta.thumb,
    sprite: { ...meta, sheet: base + meta.sheet },
  };
}

const BUILTIN_CHARACTERS = [loadSpriteCharacter('whale-maid')];
const DEFAULT_CHARACTER = BUILTIN_CHARACTERS[0].id;

const DEFAULT_CONFIG = {
  settings: {
    activeStart: '09:00',
    activeEnd: '21:00',
    weekdaysOnly: false,
    sound: true,
    volume: 0.8,
    dim: true,
    scale: 0.55,
    autoCloseSec: 60,
    snoozeMin: 5,
    openAtLogin: false,
    paused: false,
  },
  reminders: [
    { id: 'water', title: '喝水', message: '起来喝口水吧,一次 200ml 就够!', character: 'whale-maid', mode: 'interval', intervalMin: 45, times: [], enabled: true },
    { id: 'kegel', title: '提肛', message: '提肛运动:收紧 3 秒,放松 3 秒,做 10 次~', character: 'whale-maid', mode: 'interval', intervalMin: 60, times: [], enabled: true },
    { id: 'stand', title: '起身活动', message: '坐太久啦,站起来伸个懒腰,看看远处。', character: 'whale-maid', mode: 'interval', intervalMin: 90, times: [], enabled: false },
    { id: 'lunch', title: '吃午饭', message: '到饭点了,好好吃饭!', character: 'whale-maid', mode: 'times', intervalMin: 60, times: ['12:00'], enabled: false },
  ],
  customCharacters: [],
};

let config;
let tray = null;
let settingsWin = null;
let overlayWin = null;
let current = null; // 正在展示的提醒
const queue = [];
const nextAt = {}; // 间隔型提醒的下次触发时间
const intervalOf = {};
const firedKey = {}; // 定点型提醒当天是否已触发
let screenLocked = false;

// ---------- 配置 ----------

const configPath = () => path.join(app.getPath('userData'), 'config.json');

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    return {
      settings: { ...DEFAULT_CONFIG.settings, ...raw.settings },
      reminders: Array.isArray(raw.reminders) ? raw.reminders.map(sanitizeReminder) : structuredClone(DEFAULT_CONFIG.reminders),
      customCharacters: Array.isArray(raw.customCharacters) ? raw.customCharacters : [],
    };
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

function saveConfig() {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2));
}

const clampInt = (v, min, max, dft) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dft;
};
const isHM = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

function sanitizeReminder(r) {
  return {
    id: r.id || `r${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
    title: String(r.title || '提醒').slice(0, 30),
    message: String(r.message || '').slice(0, 200),
    character: r.character || DEFAULT_CHARACTER,
    mode: r.mode === 'times' ? 'times' : 'interval',
    intervalMin: clampInt(r.intervalMin, 1, 1440, 60),
    times: [...new Set((r.times || []).filter(isHM))].sort(),
    enabled: !!r.enabled,
  };
}

function sanitizeSettings(s) {
  const d = DEFAULT_CONFIG.settings;
  const scale = Number(s.scale);
  return {
    activeStart: isHM(s.activeStart) ? s.activeStart : d.activeStart,
    activeEnd: isHM(s.activeEnd) ? s.activeEnd : d.activeEnd,
    weekdaysOnly: !!s.weekdaysOnly,
    sound: !!s.sound,
    volume: Math.min(1, Math.max(0, Number(s.volume) || 0)),
    dim: !!s.dim,
    scale: Number.isFinite(scale) ? Math.min(1.2, Math.max(0.3, Math.round(scale * 100) / 100)) : d.scale,
    autoCloseSec: clampInt(s.autoCloseSec, 0, 3600, d.autoCloseSec),
    snoozeMin: clampInt(s.snoozeMin, 1, 120, d.snoozeMin),
    openAtLogin: !!s.openAtLogin,
    paused: !!s.paused,
  };
}

function publicConfig() {
  return {
    settings: config.settings,
    reminders: config.reminders,
    builtinCharacters: BUILTIN_CHARACTERS,
    customCharacters: config.customCharacters
      .filter((c) => fs.existsSync(c.file))
      .map((c) => ({ id: c.id, name: c.name, url: pathToFileURL(c.file).href })),
  };
}

function applyLoginItem() {
  app.setLoginItemSettings({ openAtLogin: config.settings.openAtLogin, openAsHidden: true, args: ['--hidden'] });
}

// ---------- 调度 ----------

const pad = (n) => String(n).padStart(2, '0');
const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const dayKey = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
const toMin = (s) => {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
};

function dayAllowed(d) {
  const w = d.getDay();
  return !config.settings.weekdaysOnly || (w >= 1 && w <= 5);
}

function inActiveHours(d) {
  const s = toMin(config.settings.activeStart);
  const e = toMin(config.settings.activeEnd);
  const n = d.getHours() * 60 + d.getMinutes();
  if (s === e) return true;
  return s < e ? n >= s && n < e : n >= s || n < e; // 支持跨零点,比如 22:00-02:00
}

function syncSchedule(reset = false) {
  const now = Date.now();
  for (const r of config.reminders) {
    if (r.mode !== 'interval') continue;
    const ms = r.intervalMin * 60000;
    if (reset || !nextAt[r.id] || intervalOf[r.id] !== ms) {
      nextAt[r.id] = now + ms;
      intervalOf[r.id] = ms;
    }
  }
}

function tick() {
  const d = new Date();
  const now = d.getTime();
  const canFire = !config.settings.paused && !screenLocked && dayAllowed(d);
  for (const r of config.reminders) {
    if (!r.enabled) continue;
    if (r.mode === 'times') {
      const t = hm(d);
      if (!r.times.includes(t)) continue;
      const k = `${r.id}@${t}`;
      if (firedKey[k] === dayKey(d)) continue;
      firedKey[k] = dayKey(d);
      if (canFire) enqueue(r);
    } else {
      if (!nextAt[r.id]) syncSchedule();
      if (now < nextAt[r.id]) continue;
      nextAt[r.id] = now + intervalOf[r.id];
      if (canFire && inActiveHours(d)) enqueue(r);
    }
  }
}

function upcoming() {
  if (config.settings.paused) return null;
  const now = new Date();
  let best = null;
  for (const r of config.reminders) {
    if (!r.enabled) continue;
    let t = null;
    if (r.mode === 'interval') {
      t = nextAt[r.id];
    } else {
      for (const hhmm of r.times) {
        const c = new Date(now);
        c.setHours(...hhmm.split(':').map(Number), 0, 0);
        if (c <= now) c.setDate(c.getDate() + 1);
        if (t === null || c.getTime() < t) t = c.getTime();
      }
    }
    if (t && (!best || t < best.t)) best = { t, title: r.title };
  }
  return best ? `${best.title} ${hm(new Date(best.t))}` : null;
}

// ---------- 提醒浮层 ----------

function enqueue(r) {
  if (current?.id === r.id || queue.some((q) => q.id === r.id)) return;
  queue.push(r);
  showNext();
}

function showNext() {
  if (overlayWin || !queue.length) return;
  current = queue.shift();
  openOverlay();
}

function resolveCharacter(id) {
  const c = config.customCharacters.find((x) => x.id === id);
  if (c && fs.existsSync(c.file)) return { type: 'image', value: pathToFileURL(c.file).href };
  const b = BUILTIN_CHARACTERS.find((x) => x.id === id) || BUILTIN_CHARACTERS[0];
  return { type: 'sprite', value: b.sprite };
}

function openOverlay() {
  // 弹在鼠标所在的那块屏幕上,多显示器时更容易被看到
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { x, y, width, height } = display.bounds;
  overlayWin = new BrowserWindow({
    x, y, width, height,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    acceptFirstMouse: true,
    show: false,
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true },
  });
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWin.loadFile(path.join(__dirname, 'overlay.html'));
  overlayWin.once('ready-to-show', () => {
    overlayWin.setBounds({ x, y, width, height });
    overlayWin.show();
    if (IS_MAC) app.focus({ steal: true });
    overlayWin.focus();
  });
  overlayWin.on('closed', () => {
    overlayWin = null;
    current = null;
    setTimeout(showNext, 800);
  });
}

function closeOverlay() {
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.close();
}

// ---------- 设置窗口 & 托盘 ----------

function openSettings() {
  if (settingsWin) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  if (IS_MAC) app.dock?.show();
  settingsWin = new BrowserWindow({
    width: 820,
    height: 720,
    minWidth: 640,
    minHeight: 560,
    title: '敲屏提醒',
    autoHideMenuBar: true,
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true },
  });
  settingsWin.loadFile(path.join(__dirname, 'settings.html'));
  settingsWin.on('closed', () => {
    settingsWin = null;
    if (IS_MAC) app.dock?.hide();
  });
}

function notifySettings() {
  settingsWin?.webContents.send('config:changed', publicConfig());
}

function makeTrayIcon() {
  // 运行时画一个橙色圆形小图标,省得带图片资源
  const S = 32;
  const buf = Buffer.alloc(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = x + 0.5 - S / 2;
      const dy = y + 0.5 - S / 2;
      const a = Math.max(0, Math.min(1, S / 2 - 1 - Math.hypot(dx, dy) + 0.5));
      const inner = Math.max(0, Math.min(1, 6.5 - Math.hypot(dx, dy + 1)));
      const r = 255;
      const g = Math.round(138 + (255 - 138) * inner);
      const b = Math.round(61 + (255 - 61) * inner);
      const i = (y * S + x) * 4;
      buf[i] = Math.round(b * a);
      buf[i + 1] = Math.round(g * a);
      buf[i + 2] = Math.round(r * a);
      buf[i + 3] = Math.round(255 * a);
    }
  }
  return nativeImage.createFromBitmap(buf, { width: S, height: S, scaleFactor: 2 });
}

function buildTrayMenu() {
  if (!tray) return;
  const s = config.settings;
  const next = upcoming();
  const tests = config.reminders.map((r) => ({ label: r.title, click: () => enqueue(r) }));
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: s.paused ? '已暂停' : next ? `下一次:${next}` : '暂无待提醒', enabled: false },
      { type: 'separator' },
      { label: '打开设置', click: openSettings },
      {
        label: '暂停所有提醒',
        type: 'checkbox',
        checked: s.paused,
        click: (item) => {
          s.paused = item.checked;
          if (!s.paused) syncSchedule(true);
          saveConfig();
          notifySettings();
          buildTrayMenu();
        },
      },
      { label: '立即试一下', submenu: tests.length ? tests : [{ label: '(无)', enabled: false }] },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ])
  );
  tray.setToolTip(s.paused ? '敲屏提醒(已暂停)' : '敲屏提醒');
}

// ---------- IPC ----------

ipcMain.handle('config:get', () => publicConfig());

ipcMain.handle('config:save', (_e, incoming) => {
  const before = new Map(config.reminders.map((r) => [r.id, r]));
  const wasPaused = config.settings.paused;
  const wasOpenAtLogin = config.settings.openAtLogin;
  config.settings = sanitizeSettings({ ...config.settings, ...incoming.settings });
  config.reminders = (incoming.reminders || []).map(sanitizeReminder);
  // 新开启或刚恢复的提醒从现在重新计时
  for (const r of config.reminders) {
    const old = before.get(r.id);
    if (!old || (!old.enabled && r.enabled)) delete nextAt[r.id];
  }
  syncSchedule(wasPaused && !config.settings.paused);
  saveConfig();
  if (config.settings.openAtLogin !== wasOpenAtLogin) applyLoginItem();
  buildTrayMenu();
  return publicConfig();
});

ipcMain.handle('reminder:test', (_e, r) => {
  enqueue({ ...sanitizeReminder(r), id: `test-${r.id || Date.now()}` });
});

ipcMain.handle('character:pick', async () => {
  const res = await dialog.showOpenDialog(settingsWin, {
    title: '选择形象图片(推荐透明背景 PNG / GIF)',
    filters: [{ name: '图片', extensions: ['png', 'gif', 'webp', 'jpg', 'jpeg', 'apng'] }],
    properties: ['openFile'],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  const src = res.filePaths[0];
  const dir = path.join(app.getPath('userData'), 'characters');
  fs.mkdirSync(dir, { recursive: true });
  const id = `img-${Date.now()}`;
  const file = path.join(dir, id + path.extname(src).toLowerCase());
  fs.copyFileSync(src, file);
  config.customCharacters.push({ id, name: path.basename(src, path.extname(src)).slice(0, 12), file });
  saveConfig();
  return { id, config: publicConfig() };
});

ipcMain.handle('character:remove', (_e, id) => {
  const c = config.customCharacters.find((x) => x.id === id);
  if (c) {
    fs.rmSync(c.file, { force: true });
    config.customCharacters = config.customCharacters.filter((x) => x.id !== id);
    for (const r of config.reminders) if (r.character === id) r.character = DEFAULT_CHARACTER;
    saveConfig();
  }
  return publicConfig();
});

ipcMain.handle('overlay:data', () => {
  if (!current) return null;
  const s = config.settings;
  return {
    title: current.title,
    message: current.message,
    character: resolveCharacter(current.character),
    sound: s.sound,
    volume: s.volume,
    dim: s.dim,
    scale: s.scale,
    autoCloseSec: s.autoCloseSec,
    snoozeMin: s.snoozeMin,
  };
});

ipcMain.on('overlay:done', closeOverlay);

ipcMain.on('overlay:snooze', () => {
  const r = current;
  closeOverlay();
  if (r) setTimeout(() => enqueue(r), config.settings.snoozeMin * 60000);
});

// ---------- 生命周期 ----------

app.on('second-instance', openSettings);
app.on('window-all-closed', () => {}); // 常驻托盘,不随窗口退出
app.on('activate', openSettings);

app.whenReady().then(() => {
  const firstRun = !fs.existsSync(configPath());
  config = loadConfig();
  if (firstRun) saveConfig();
  syncSchedule(true);

  if (IS_MAC) app.dock?.hide();
  tray = new Tray(makeTrayIcon());
  tray.on('click', () => (IS_MAC ? tray.popUpContextMenu() : openSettings()));
  buildTrayMenu();

  setInterval(tick, 15 * 1000);
  setInterval(buildTrayMenu, 60 * 1000);

  // 合盖/锁屏期间不提醒,回来后从头计时
  powerMonitor.on('lock-screen', () => (screenLocked = true));
  powerMonitor.on('unlock-screen', () => {
    screenLocked = false;
    syncSchedule(true);
  });
  powerMonitor.on('resume', () => syncSchedule(true));

  const openedAtLogin = process.argv.includes('--hidden') || (IS_MAC && app.getLoginItemSettings().wasOpenedAtLogin);
  if (!openedAtLogin) openSettings();

  // npm start -- --demo:启动后立刻敲一次,用来看效果
  if (process.argv.includes('--demo') && config.reminders[0]) setTimeout(() => enqueue(config.reminders[0]), 1500);
});
