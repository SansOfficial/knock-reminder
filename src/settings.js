const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const PRESETS = [
  { title: '喝水', message: '起来喝口水吧,一次 200ml 就够!', intervalMin: 45 },
  { title: '提肛', message: '提肛运动:收紧 3 秒,放松 3 秒,做 10 次~', intervalMin: 60 },
  { title: '起身活动', message: '坐太久啦,站起来伸个懒腰。', intervalMin: 90 },
  { title: '护眼', message: '看看 6 米外的地方,20 秒。', intervalMin: 20 },
  { title: '坐直', message: '背挺直,肩膀放松!', intervalMin: 30 },
];

let cfg;
let draft = null; // 编辑中的提醒
let isNew = false;

const DEFAULT_CHARACTER = 'whale-maid';

const allChars = () => [...cfg.builtinCharacters, ...cfg.customCharacters.map((c) => ({ ...c, custom: true }))];
const findChar = (id) => allChars().find((c) => c.id === id) || cfg.builtinCharacters[0];
const charFace = (c) => `<img src="${esc(c.thumb || c.url)}" alt="">`;

const scheduleText = (r) =>
  r.mode === 'times' ? (r.times.length ? `每天 ${r.times.join('、')}` : '还没设时间') : `每 ${r.intervalMin} 分钟`;

async function save() {
  cfg = await window.api.saveConfig({ settings: cfg.settings, reminders: cfg.reminders });
  render();
}

// ---------- 列表 & 通用设置 ----------

function render() {
  $('#paused').checked = cfg.settings.paused;
  $('#list').innerHTML =
    cfg.reminders
      .map(
        (r) => `
      <div class="card ${r.enabled ? '' : 'off'}" data-id="${esc(r.id)}">
        <div class="avatar">${charFace(findChar(r.character))}</div>
        <div class="info">
          <div class="t">${esc(r.title)}</div>
          <div class="s">${esc(scheduleText(r))}${r.message ? ' · ' + esc(r.message) : ''}</div>
        </div>
        <button class="ghost" data-act="test">试一下</button>
        <button class="ghost" data-act="edit">编辑</button>
        <span class="switch"><input type="checkbox" data-act="toggle" ${r.enabled ? 'checked' : ''}><i></i></span>
      </div>`
      )
      .join('') || '<div class="empty">还没有提醒,点右上角「新建提醒」</div>';

  for (const el of document.querySelectorAll('[data-key]')) {
    const v = cfg.settings[el.dataset.key];
    if (el.type === 'checkbox') el.checked = v;
    else el.value = v;
  }
  $('#scale-val').textContent = `${Math.round((cfg.settings.scale ?? 0.55) * 100)}%`;
}

$('#list').addEventListener('click', (e) => {
  const act = e.target.dataset.act;
  const card = e.target.closest('.card');
  if (!act || !card) return;
  const r = cfg.reminders.find((x) => x.id === card.dataset.id);
  if (act === 'test') window.api.test(r);
  if (act === 'edit') openEditor(r);
});
$('#list').addEventListener('change', (e) => {
  if (e.target.dataset.act !== 'toggle') return;
  const r = cfg.reminders.find((x) => x.id === e.target.closest('.card').dataset.id);
  r.enabled = e.target.checked;
  save();
});

$('#add').addEventListener('click', () => openEditor(null));

$('#paused').addEventListener('change', (e) => {
  cfg.settings.paused = e.target.checked;
  save();
});

for (const el of document.querySelectorAll('[data-key]')) {
  if (el.dataset.key === 'scale') {
    el.addEventListener('input', () => {
      $('#scale-val').textContent = `${Math.round(Number(el.value) * 100)}%`;
    });
  }
  el.addEventListener('change', () => {
    const k = el.dataset.key;
    cfg.settings[k] = el.type === 'checkbox' ? el.checked : el.type === 'number' || el.type === 'range' ? Number(el.value) : el.value;
    save();
  });
}

// ---------- 编辑弹窗 ----------

function openEditor(r) {
  isNew = !r;
  draft = r
    ? structuredClone(r)
    : { id: '', title: '', message: '', character: DEFAULT_CHARACTER, mode: 'interval', intervalMin: 45, times: [], enabled: true };
  $('#editor-title').textContent = isNew ? '新建提醒' : '编辑提醒';
  $('#f-delete').style.visibility = isNew ? 'hidden' : 'visible';
  $('#presets').innerHTML = isNew ? PRESETS.map((p, i) => `<button type="button" data-i="${i}">${esc(p.title)}</button>`).join('') : '';
  fillForm();
  $('#editor').showModal();
  $('#f-title').focus();
}

function fillForm() {
  $('#f-title').value = draft.title;
  $('#f-message').value = draft.message;
  $('#f-interval').value = draft.intervalMin;
  for (const el of document.querySelectorAll('input[name=mode]')) el.checked = el.value === draft.mode;
  renderChars();
  renderTimes();
  renderMode();
}

function readForm() {
  draft.title = $('#f-title').value.trim();
  draft.message = $('#f-message').value.trim();
  draft.intervalMin = Number($('#f-interval').value) || 1;
  draft.mode = document.querySelector('input[name=mode]:checked').value;
  return draft;
}

function renderMode() {
  const m = document.querySelector('input[name=mode]:checked').value;
  $('#mode-interval').style.display = m === 'interval' ? '' : 'none';
  $('#mode-times').style.display = m === 'times' ? '' : 'none';
}

function renderChars() {
  $('#f-chars').innerHTML =
    allChars()
      .map(
        (c) => `
      <div class="char ${c.id === draft.character ? 'sel' : ''}" data-id="${esc(c.id)}" title="${esc(c.name)}">
        ${charFace(c)}<span>${esc(c.name)}</span>
        ${c.custom ? '<span class="x" data-remove="1">×</span>' : ''}
      </div>`
      )
      .join('') + '<div class="char upload" data-upload="1"><span class="e">＋</span><span>上传图片</span></div>';
}

function renderTimes() {
  $('#f-times').innerHTML = draft.times.length
    ? draft.times.map((t) => `<span class="tag">${t}<button type="button" data-t="${t}">×</button></span>`).join('')
    : '<span style="color:var(--muted)">还没有时间点</span>';
}

$('#quick').innerHTML = [20, 30, 45, 60, 90].map((m) => `<button type="button" data-m="${m}">${m}</button>`).join('');
$('#quick').addEventListener('click', (e) => {
  if (e.target.dataset.m) $('#f-interval').value = e.target.dataset.m;
});

$('#presets').addEventListener('click', (e) => {
  const p = PRESETS[e.target.dataset.i];
  if (!p) return;
  Object.assign(draft, p, { mode: 'interval' });
  fillForm();
});

$('#f-chars').addEventListener('click', async (e) => {
  const tile = e.target.closest('.char');
  if (!tile) return;
  if (tile.dataset.upload) {
    readForm();
    const res = await window.api.pickCharacter();
    if (!res) return;
    cfg = res.config;
    draft.character = res.id;
    renderChars();
    render();
    return;
  }
  if (e.target.dataset.remove) {
    readForm();
    cfg = await window.api.removeCharacter(tile.dataset.id);
    if (draft.character === tile.dataset.id) draft.character = DEFAULT_CHARACTER;
    renderChars();
    render();
    return;
  }
  draft.character = tile.dataset.id;
  renderChars();
});

for (const el of document.querySelectorAll('input[name=mode]')) el.addEventListener('change', renderMode);

$('#f-time-add').addEventListener('click', () => {
  const t = $('#f-time-new').value;
  if (!t || draft.times.includes(t)) return;
  draft.times = [...draft.times, t].sort();
  renderTimes();
});
$('#f-times').addEventListener('click', (e) => {
  const t = e.target.dataset.t;
  if (!t) return;
  draft.times = draft.times.filter((x) => x !== t);
  renderTimes();
});

$('#f-test').addEventListener('click', () => window.api.test(readForm()));
$('#f-cancel').addEventListener('click', () => $('#editor').close());

$('#f-delete').addEventListener('click', () => {
  // 不用 confirm():弹窗里的「删除」再点一次才真正删除,避免误删
  const btn = $('#f-delete');
  if (btn.dataset.armed !== '1') {
    btn.dataset.armed = '1';
    btn.textContent = '再点一次确认删除';
    setTimeout(() => {
      btn.dataset.armed = '';
      btn.textContent = '删除';
    }, 3000);
    return;
  }
  btn.dataset.armed = '';
  btn.textContent = '删除';
  cfg.reminders = cfg.reminders.filter((r) => r.id !== draft.id);
  $('#editor').close();
  save();
});

$('#form').addEventListener('submit', (e) => {
  readForm();
  if (!draft.title) {
    e.preventDefault();
    return;
  }
  if (draft.mode === 'times' && !draft.times.length) {
    // 填了时间但忘了点「添加」时顺手加上
    const t = $('#f-time-new').value;
    if (t) draft.times = [t];
  }
  if (isNew) cfg.reminders.push(draft);
  else cfg.reminders = cfg.reminders.map((r) => (r.id === draft.id ? draft : r));
  save();
});

window.api.onConfigChanged((c) => {
  cfg = c;
  render();
});

(async () => {
  cfg = await window.api.getConfig();
  render();
})();
