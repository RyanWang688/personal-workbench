import * as db from './db.js';

const DRAFTS = 'drafts';
const TRASH = 'trash';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = { columns: [], cards: [], query: '', tab: DRAFTS, urls: new Map(), dragId: null };
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('personal-workbench') : null;

// ---------- 文件类型 ----------
const TYPES = [
  { k: 'image', label: '图片', c: '#7048e8', test: (t, e) => t.startsWith('image/') || /^(png|jpe?g|gif|webp|svg|bmp|heic|avif|ico)$/.test(e) },
  { k: 'video', label: '视频', c: '#e8590c', test: (t, e) => t.startsWith('video/') || /^(mp4|mov|webm|mkv|avi)$/.test(e) },
  { k: 'audio', label: '音频', c: '#d6336c', test: (t, e) => t.startsWith('audio/') || /^(mp3|wav|m4a|flac|ogg|aac)$/.test(e) },
  { k: 'pdf', label: 'PDF', c: '#e03131', test: (t, e) => t === 'application/pdf' || e === 'pdf' },
  { k: 'doc', label: '文档', c: '#1c7ed6', test: (t, e) => /^(docx?|rtf|odt|pages)$/.test(e) },
  { k: 'sheet', label: '表格', c: '#2b8a3e', test: (t, e) => /^(xlsx?|csv|ods|numbers|tsv)$/.test(e) },
  { k: 'slide', label: '演示', c: '#f08c00', test: (t, e) => /^(pptx?|key|odp)$/.test(e) },
  { k: 'archive', label: '压缩包', c: '#5c5f66', test: (t, e) => /^(zip|rar|7z|tar|gz|tgz|bz2)$/.test(e) },
  { k: 'code', label: '代码', c: '#0b7285', test: (t, e) => /^(js|ts|jsx|tsx|py|java|c|cpp|h|cs|go|rs|rb|php|html|css|json|xml|yml|yaml|sh|ps1|sql|swift|kt)$/.test(e) },
  { k: 'text', label: '文本', c: '#495057', test: (t, e) => t.startsWith('text/') || /^(txt|md|log|ini|cfg)$/.test(e) },
];
const extOf = (name) => (/\.([a-z0-9]+)$/i.exec(name || '') || [, ''])[1].toLowerCase();
function typeOf(card) {
  const e = extOf(card.name);
  return TYPES.find((t) => t.test(card.type || '', e)) || { k: 'other', label: '文件', c: '#868e96' };
}
const isTextual = (card) => ['text', 'code'].includes(typeOf(card).k) || ['csv', 'tsv', 'svg'].includes(extOf(card.name));
function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB']; let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < 2);
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}
function fmtDate(ts) {
  const d = new Date(ts), now = new Date();
  const hm = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `今天 ${hm}`;
  return d.getFullYear() === now.getFullYear() ? `${d.getMonth() + 1}月${d.getDate()}日` : d.toLocaleDateString('zh-CN');
}
function ago(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

// ---------- 数据 ----------
const byOrder = (a, b) => a.order - b.order;
const colName = (id) => id === DRAFTS ? '草稿区' : id === TRASH ? '回收站' : (state.columns.find((c) => c.id === id)?.title || '未知列');
const findCard = (id) => state.cards.find((c) => c.id === id);
function cardsIn(colId, filtered = true) {
  let list = state.cards.filter((c) => c.columnId === colId);
  if (filtered && state.query) {
    const q = state.query.toLowerCase();
    list = list.filter((c) => (c.name || '').toLowerCase().includes(q) || (c.text || '').toLowerCase().includes(q));
  }
  return colId === TRASH ? list.sort((a, b) => (b.trashedAt || 0) - (a.trashedAt || 0)) : list.sort(byOrder);
}
function orderAt(colId, index, excludeId) {
  const list = cardsIn(colId, false).filter((c) => c.id !== excludeId);
  const prev = list[index - 1], next = list[index];
  if (!prev && !next) return 0;
  if (!prev) return next.order - 1024;
  if (!next) return prev.order + 1024;
  return (prev.order + next.order) / 2;
}

async function load() {
  const [cols, cards] = await Promise.all([db.getAll('columns'), db.getAll('cards')]);
  state.columns = cols.sort(byOrder);
  state.cards = cards;
  const live = new Set(cards.map((c) => c.id));
  for (const [id, url] of state.urls) if (!live.has(id)) { URL.revokeObjectURL(url); state.urls.delete(id); }
}
async function changed() {
  await db.setMeta('lastChange', Date.now());
  channel?.postMessage('changed');
  render();
  refreshStatus();
}
async function saveCard(card) {
  card.updatedAt = Date.now();
  await db.put('cards', card);
}

async function ensureDefaults() {
  if (state.columns.length) return;
  state.columns = ['收件箱', '进行中', '已完成'].map((title, i) => ({ id: uid(), title, order: i * 1024 }));
  await db.putMany('columns', state.columns);
}

// ---------- 渲染 ----------
const highlight = (s) => {
  const t = esc(s);
  if (!state.query) return t;
  const q = esc(state.query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return t.replace(new RegExp(q, 'gi'), (m) => `<mark>${m}</mark>`);
};
function cardHTML(c) {
  const more = `<button class="more" data-action="card-menu" aria-label="更多操作" aria-haspopup="menu"><svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg></button>`;
  if (c.kind === 'note') {
    return `<article class="card note" draggable="true" tabindex="0" data-id="${c.id}" aria-label="便签 ${esc(c.name)}">
      <div class="body"><div class="name">${highlight(c.name || '便签')}</div>
      ${c.text ? `<div class="note-text">${highlight(c.text)}</div>` : ''}
      <div class="meta">便签 · ${fmtDate(c.updatedAt || c.createdAt)}</div></div>${more}</article>`;
  }
  const t = typeOf(c);
  const meta = `${t.label} · ${fmtSize(c.size || 0)} · ${fmtDate(c.createdAt)}`;
  if (t.k === 'image' && extOf(c.name) !== 'heic') {
    return `<article class="card has-img" draggable="true" tabindex="0" data-id="${c.id}" aria-label="${esc(c.name)}">
      <img class="thumb-img" data-thumb="${c.id}" alt="" loading="lazy" draggable="false">
      <div class="body"><div class="name" title="${esc(c.name)}">${highlight(c.name)}</div><div class="meta">${meta}</div></div>${more}</article>`;
  }
  const ext = extOf(c.name).slice(0, 4) || t.label;
  return `<article class="card" draggable="true" tabindex="0" data-id="${c.id}" aria-label="${esc(c.name)}">
    <div class="type-icon" style="--c:${t.c}">${esc(ext)}</div>
    <div class="body"><div class="name" title="${esc(c.name)}">${highlight(c.name)}</div><div class="meta">${meta}</div></div>${more}</article>`;
}
function listHTML(colId, emptyText) {
  const list = cardsIn(colId);
  if (!list.length) return `<div class="empty">${state.query ? '没有匹配的内容' : emptyText}</div>`;
  return list.map(cardHTML).join('');
}
function render() {
  const board = $('#board');
  const scroll = board.scrollLeft;
  const listScroll = Object.fromEntries($$('.list', board).map((l) => [l.dataset.col, l.scrollTop]));
  board.innerHTML = state.columns.map((col) => `
    <section class="column" data-col-id="${col.id}">
      <header class="col-head">
        <h2 class="col-title" data-action="rename-col" title="点击重命名">${esc(col.title)}</h2>
        <span class="col-count">${cardsIn(col.id, false).length}</span>
        <button class="icon-btn" data-action="col-menu" aria-label="列操作" aria-haspopup="menu"><svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg></button>
      </header>
      <div class="list" data-col="${col.id}">${listHTML(col.id, '把文件拖到这里')}</div>
      <div class="col-foot"><button class="add-inline" data-action="add-note-col"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>添加便签</button></div>
    </section>`).join('') + `<button class="add-column" data-action="add-col"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>新建列</button>`;
  board.scrollLeft = scroll;
  $$('.list', board).forEach((l) => { if (listScroll[l.dataset.col]) l.scrollTop = listScroll[l.dataset.col]; });

  const dl = $('#draftsList');
  dl.dataset.col = state.tab;
  dl.innerHTML = listHTML(state.tab, state.tab === DRAFTS ? '暂时不用的东西拖到这里' : '回收站是空的');
  $$('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === state.tab)));
  const nd = cardsIn(DRAFTS, false).length, nt = cardsIn(TRASH, false).length;
  $('#draftsCount').textContent = nd;
  $('#trashCount').textContent = nt;
  $('#draftsBadge').textContent = nd;
  $('#draftsDesc').textContent = state.tab === DRAFTS
    ? '暂存区：放进来的东西不会丢，随时拖回看板。'
    : '删除的卡片先进入这里，可恢复；只有「永久删除」才会真正移除。';
  $('#draftsFoot').innerHTML = state.tab === TRASH && nt ? `<button class="btn" data-action="empty-trash">清空回收站</button>` : '';
  loadThumbs();
}
async function urlFor(id) {
  if (state.urls.has(id)) return state.urls.get(id);
  const card = findCard(id);
  let blob;
  if (card?.kind === 'note') blob = new Blob([card.text || ''], { type: 'text/plain;charset=utf-8' });
  else blob = await db.getBlob(id);
  if (!blob) return null;
  if (card?.kind === 'note') return URL.createObjectURL(blob); // 便签内容会变，不缓存
  const url = URL.createObjectURL(blob);
  state.urls.set(id, url);
  return url;
}
function loadThumbs() {
  $$('img[data-thumb]').forEach(async (img) => {
    const url = await urlFor(img.dataset.thumb);
    if (url) img.src = url;
  });
}

// ---------- 添加文件 ----------
async function addFiles(files, colId, index = null) {
  files = files.filter((f) => f && f.name !== '.DS_Store');
  if (!files.length) return;
  if (!colId) colId = state.columns[0]?.id || DRAFTS;
  if (index == null) index = cardsIn(colId, false).length;
  let ok = 0;
  const t = files.length > 1 ? toast(`正在保存 0/${files.length}…`, { sticky: true }) : null;
  for (const f of files) {
    const card = {
      id: uid(), kind: 'file', name: f.name || `粘贴的文件-${Date.now()}`, type: f.type || '', size: f.size,
      columnId: colId, order: orderAt(colId, index + ok), createdAt: Date.now(), updatedAt: Date.now(),
    };
    try {
      await db.addFile(card, f);
      state.cards.push(card);
      ok++;
      if (t) t.set(`正在保存 ${ok}/${files.length}…`);
    } catch (e) {
      console.error(e);
      const quota = e && (e.name === 'QuotaExceededError' || /quota/i.test(e.message));
      toast(quota ? '存储空间不足，请先备份并清理回收站' : `「${card.name}」保存失败：${e.message || e}`, { error: true });
    }
  }
  t?.close();
  if (ok) {
    toast(`已保存 ${ok} 个文件到「${colName(colId)}」`);
    requestPersist();
    await changed();
  }
}

// 递归读取拖入的文件夹
async function filesFromDataTransfer(dt) {
  const entries = [...(dt.items || [])].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length || !entries.some((e) => e.isDirectory)) return [...(dt.files || [])];
  const out = [];
  const readEntry = (entry) => new Promise((resolve) => {
    if (entry.isFile) return entry.file((f) => { out.push(f); resolve(); }, () => resolve());
    const reader = entry.createReader();
    const all = [];
    const next = () => reader.readEntries(async (batch) => {
      if (batch.length) { all.push(...batch); return next(); }
      for (const e of all) await readEntry(e);
      resolve();
    }, () => resolve());
    next();
  });
  for (const e of entries) await readEntry(e);
  return out;
}

// ---------- 卡片操作 ----------
async function moveCard(id, colId, index = 0) {
  const card = findCard(id);
  if (!card) return;
  if (colId === TRASH) return trashCard(id);
  card.order = orderAt(colId, index, id);
  if (card.columnId === TRASH) delete card.trashedAt;
  card.columnId = colId;
  await saveCard(card);
  await changed();
}
async function trashCard(id) {
  const card = findCard(id);
  if (!card || card.columnId === TRASH) return;
  const from = card.columnId;
  card.prevColumnId = from;
  card.columnId = TRASH;
  card.trashedAt = Date.now();
  await saveCard(card);
  await changed();
  toast(`「${card.name}」已移到回收站`, { action: '撤销', onAction: () => restoreCard(id) });
}
async function restoreCard(id) {
  const card = findCard(id);
  if (!card) return;
  const target = state.columns.some((c) => c.id === card.prevColumnId) || card.prevColumnId === DRAFTS ? card.prevColumnId : (state.columns[0]?.id || DRAFTS);
  card.order = orderAt(target, cardsIn(target, false).length, id);
  card.columnId = target;
  delete card.trashedAt;
  await saveCard(card);
  await changed();
  toast(`已恢复到「${colName(target)}」`);
}
async function purgeCard(id) {
  await db.deleteCard(id);
  const url = state.urls.get(id);
  if (url) { URL.revokeObjectURL(url); state.urls.delete(id); }
  state.cards = state.cards.filter((c) => c.id !== id);
}
async function download(id) {
  const card = findCard(id);
  const url = await urlFor(id);
  if (!url) return toast('找不到文件内容', { error: true });
  const a = document.createElement('a');
  a.href = url;
  a.download = card.kind === 'note' ? `${card.name || '便签'}.txt` : card.name;
  document.body.appendChild(a); a.click(); a.remove();
}
async function newNote(colId) {
  colId = colId || state.columns[0]?.id || DRAFTS;
  const res = await noteEditor({ name: '', text: '' });
  if (!res) return;
  const card = { id: uid(), kind: 'note', name: res.name || '未命名便签', text: res.text, columnId: colId,
    order: orderAt(colId, cardsIn(colId, false).length), createdAt: Date.now(), updatedAt: Date.now() };
  await db.put('cards', card);
  state.cards.push(card);
  await changed();
}
async function editNote(card) {
  const res = await noteEditor(card);
  if (!res) return;
  card.name = res.name || '未命名便签';
  card.text = res.text;
  await saveCard(card);
  await changed();
}

// ---------- 列操作 ----------
async function addColumn() {
  const title = await prompt({ title: '新建列', placeholder: '例如：资料、待审阅…', ok: '创建' });
  if (!title) return;
  const last = state.columns[state.columns.length - 1];
  const col = { id: uid(), title, order: last ? last.order + 1024 : 0 };
  await db.put('columns', col);
  state.columns.push(col);
  await changed();
  $('#board').scrollTo({ left: $('#board').scrollWidth, behavior: 'smooth' });
}
async function renameColumn(col) {
  const title = await prompt({ title: '重命名列', value: col.title, ok: '保存' });
  if (!title || title === col.title) return;
  col.title = title;
  await db.put('columns', col);
  await changed();
}
async function moveColumn(col, dir) {
  const i = state.columns.indexOf(col), j = i + dir;
  if (j < 0 || j >= state.columns.length) return;
  const other = state.columns[j];
  [col.order, other.order] = [other.order, col.order];
  await db.putMany('columns', [col, other]);
  state.columns.sort(byOrder);
  await changed();
}
async function deleteColumn(col) {
  const cards = cardsIn(col.id, false);
  if (state.columns.length <= 1) return toast('至少保留一列', { error: true });
  const ok = await confirmBox({ title: `删除列「${col.title}」？`, body: cards.length ? `列里的 ${cards.length} 张卡片会移到草稿区，不会丢失。` : '这一列是空的。', ok: '删除列', danger: true });
  if (!ok) return;
  let order = orderAt(DRAFTS, cardsIn(DRAFTS, false).length);
  for (const c of cards) { c.columnId = DRAFTS; c.order = order; order += 1024; }
  if (cards.length) await db.putMany('cards', cards);
  await db.del('columns', col.id);
  state.columns = state.columns.filter((c) => c !== col);
  await changed();
}

// ---------- 预览 ----------
async function preview(id) {
  const card = findCard(id);
  if (!card) return;
  if (card.kind === 'note') return editNote(card);
  const url = await urlFor(id);
  const t = typeOf(card);
  const v = $('#viewer'), inner = $('#viewerInner');
  let body;
  if (!url) body = `<div class="viewer-none">找不到文件内容</div>`;
  else if (t.k === 'image') body = `<img src="${url}" alt="${esc(card.name)}">`;
  else if (t.k === 'video') body = `<video src="${url}" controls autoplay></video>`;
  else if (t.k === 'audio') body = `<audio src="${url}" controls autoplay></audio>`;
  else if (t.k === 'pdf') body = `<iframe src="${url}" title="${esc(card.name)}"></iframe>`;
  else if (isTextual(card) && card.size < 2 * 1024 * 1024) {
    const text = await (await db.getBlob(id)).text();
    body = `<pre>${esc(text)}</pre>`;
  } else body = `<div class="viewer-none"><div class="type-icon" style="--c:${t.c}">${esc(extOf(card.name).slice(0, 4) || t.label)}</div><div>此类型无法在浏览器内预览</div><button class="btn primary" data-action="download" data-id="${id}">下载文件</button></div>`;
  inner.innerHTML = `<div class="viewer-head"><div class="name">${esc(card.name)}</div><span class="meta">${fmtSize(card.size)}</span>
    <button class="icon-btn" data-action="download" data-id="${id}" aria-label="下载"><svg viewBox="0 0 24 24"><path d="M12 4v11m0 0-4-4m4 4 4-4"/><path d="M5 19h14"/></svg></button>
    <button class="icon-btn" data-action="close-viewer" aria-label="关闭"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>
    <div class="viewer-body">${body}</div>`;
  v.showModal();
}
// 关闭时清空内容，确保视频/音频停止播放（不只依赖 close 事件）
function closeViewer() { const v = $('#viewer'); if (v.open) v.close(); $('#viewerInner').innerHTML = ''; }
$('#viewer').addEventListener('close', () => { $('#viewerInner').innerHTML = ''; });
$('#viewer').addEventListener('cancel', (e) => { e.preventDefault(); closeViewer(); });
$('#viewer').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeViewer(); });

// ---------- 弹窗 ----------
function dialog(html, onSubmit) {
  const m = $('#modal'), f = $('#modalInner');
  f.innerHTML = html;
  return new Promise((resolve) => {
    // 不依赖 dialog 的 close 事件（部分浏览器不可靠），直接处理表单提交
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      f.onsubmit = null; m.oncancel = null; m.onclose = null;
      if (m.open) m.close();
      resolve(value);
    };
    f.onsubmit = (e) => {
      e.preventDefault();
      const ok = (e.submitter?.value || 'ok') === 'ok';
      finish(ok ? onSubmit(f) : null);
    };
    m.oncancel = () => finish(null);
    m.onclose = () => finish(null);
    m.showModal();
    const first = f.querySelector('input, textarea');
    if (first) { first.focus(); first.select?.(); }
  });
}
// 确认按钮放在 DOM 前面（回车即确认），CSS 用 row-reverse 让它显示在右侧
const actions = (ok, danger) => `<div class="modal-actions"><button class="btn ${danger ? 'danger' : 'primary'}" value="ok">${ok}</button><button class="btn" value="cancel" formnovalidate>取消</button></div>`;
const prompt = ({ title, value = '', placeholder = '', ok = '确定' }) =>
  dialog(`<h3>${esc(title)}</h3><input type="text" name="v" value="${esc(value)}" placeholder="${esc(placeholder)}" maxlength="120" required>${actions(ok)}`,
    (f) => f.v.value.trim());
const confirmBox = ({ title, body = '', ok = '确定', danger }) =>
  dialog(`<h3>${esc(title)}</h3>${body ? `<p>${esc(body)}</p>` : ''}${actions(ok, danger)}`, () => true);
const noteEditor = (card) =>
  dialog(`<h3>${card.id ? '编辑便签' : '新建便签'}</h3><input type="text" name="n" value="${esc(card.name)}" placeholder="标题" maxlength="120">
    <textarea name="t" placeholder="写点什么…">${esc(card.text)}</textarea>${actions('保存')}`,
    (f) => ({ name: f.n.value.trim(), text: f.t.value }));
$('#modal').addEventListener('click', (e) => { if (e.target === e.currentTarget) { e.currentTarget.close(); e.currentTarget.onclose?.(); } });

// ---------- 菜单 ----------
let menuAnchor = null;
function openMenu(anchor, items) {
  const m = $('#menu');
  m.innerHTML = items.map((it, i) => it === '-' ? '<hr>' : it.label && !it.run ? `<div class="label">${esc(it.label)}</div>`
    : `<button role="menuitem" data-i="${i}" class="${it.danger ? 'danger' : ''}">${esc(it.text)}</button>`).join('');
  m.hidden = false;
  m.onclick = (e) => { const b = e.target.closest('button[data-i]'); if (!b) return; closeMenu(); items[b.dataset.i].run(); };
  const r = anchor.getBoundingClientRect();
  const w = m.offsetWidth, h = m.offsetHeight;
  m.style.left = `${Math.max(8, Math.min(r.right - w, innerWidth - w - 8))}px`;
  m.style.top = `${r.bottom + h + 8 > innerHeight ? Math.max(8, r.top - h - 4) : r.bottom + 4}px`;
  menuAnchor = anchor;
  anchor.setAttribute('aria-expanded', 'true');
  m.querySelector('button')?.focus();
}
function closeMenu() {
  $('#menu').hidden = true;
  menuAnchor?.setAttribute('aria-expanded', 'false');
  menuAnchor = null;
}
function cardMenu(anchor, card) {
  const items = [];
  if (card.columnId === TRASH) {
    items.push({ text: '恢复', run: () => restoreCard(card.id) }, '-',
      { text: '永久删除', danger: true, run: async () => {
        if (await confirmBox({ title: '永久删除？', body: `「${card.name}」将被彻底删除，无法恢复。`, ok: '永久删除', danger: true })) {
          await purgeCard(card.id); await changed();
        } } });
  } else {
    items.push({ text: card.kind === 'note' ? '编辑' : '预览', run: () => preview(card.id) },
      { text: '下载', run: () => download(card.id) },
      { text: '重命名', run: async () => {
        const n = await prompt({ title: '重命名', value: card.name, ok: '保存' });
        if (n && n !== card.name) { card.name = n; await saveCard(card); await changed(); } } },
      '-', { label: '移动到' });
    for (const col of state.columns) if (col.id !== card.columnId) items.push({ text: col.title, run: () => moveCard(card.id, col.id, cardsIn(col.id, false).length) });
    if (card.columnId !== DRAFTS) items.push({ text: '草稿区', run: () => moveCard(card.id, DRAFTS, 0) });
    items.push('-', { text: '删除', danger: true, run: () => trashCard(card.id) });
  }
  openMenu(anchor, items);
}
function colMenu(anchor, col) {
  const i = state.columns.indexOf(col);
  const items = [
    { text: '重命名', run: () => renameColumn(col) },
    { text: '添加便签', run: () => newNote(col.id) },
  ];
  if (i > 0) items.push({ text: '向左移', run: () => moveColumn(col, -1) });
  if (i < state.columns.length - 1) items.push({ text: '向右移', run: () => moveColumn(col, 1) });
  items.push('-', { text: '删除列', danger: true, run: () => deleteColumn(col) });
  openMenu(anchor, items);
}

// ---------- 提示 ----------
function toast(text, { error, action, onAction, sticky } = {}) {
  const el = document.createElement('div');
  el.className = `toast${error ? ' error' : ''}`;
  el.setAttribute('role', error ? 'alert' : 'status');
  const span = document.createElement('span');
  span.textContent = text;
  el.appendChild(span);
  if (action) {
    const b = document.createElement('button');
    b.textContent = action;
    b.onclick = () => { close(); onAction(); };
    el.appendChild(b);
  }
  $('#toasts').appendChild(el);
  const close = () => el.remove();
  if (!sticky) setTimeout(close, action ? 6000 : error ? 6000 : 3000);
  return { close, set: (t) => { span.textContent = t; } };
}

// ---------- 存储 / 备份状态 ----------
async function requestPersist() {
  if (!navigator.storage?.persist) return;
  if (!(await navigator.storage.persisted())) await navigator.storage.persist().catch(() => {});
  refreshStatus();
}
async function refreshStatus() {
  const chip = $('#storageChip');
  let persisted = false, used = 0, quota = 0;
  try {
    persisted = await navigator.storage?.persisted?.() || false;
    ({ usage: used = 0, quota = 0 } = (await navigator.storage?.estimate?.()) || {});
  } catch {}
  chip.textContent = `已用 ${fmtSize(used)}${quota ? ` / ${fmtSize(quota)}` : ''} · ${persisted ? '持久存储已开启' : '普通存储'}`;
  chip.className = `status-chip ${persisted ? 'ok' : 'warn'}`;
  const [lastBackup, lastChange] = await Promise.all([db.getMeta('lastBackup', 0), db.getMeta('lastChange', 0)]);
  const bc = $('#backupChip');
  const stale = state.cards.length && lastChange > lastBackup && (!lastBackup || Date.now() - lastBackup > 3 * 86400e3);
  bc.textContent = lastBackup ? `上次备份 ${ago(lastBackup)}${lastChange > lastBackup ? ' · 有新改动' : ''}` : '尚未备份';
  bc.className = `status-chip ${stale ? 'warn' : lastBackup ? 'ok' : ''}`;
}
async function storageInfo() {
  const persisted = await navigator.storage?.persisted?.();
  await dialog(`<h3>数据存在哪里？</h3>
    <p>所有文件和卡片保存在本浏览器内置的 IndexedDB 数据库中，不会上传到任何服务器。每个文件写入后都会回读校验大小。</p>
    <p>持久存储：<b>${persisted ? '已开启' : '未开启'}</b>。${persisted ? '浏览器不会因空间紧张自动清理这些数据。' : '浏览器可能在磁盘空间不足时清理数据，建议点「申请持久存储」或定期备份。'}</p>
    <p>注意：清除浏览器数据、使用无痕模式或换设备时数据不会跟随，请用「备份」导出 .wbk 文件保存到网盘或硬盘。</p>
    <div class="modal-actions"><button class="btn primary" value="cancel">知道了</button>${persisted ? '' : '<button class="btn" value="ok">申请持久存储</button>'}</div>`, () => true)
    .then((r) => r && requestPersist());
}
async function doBackup() {
  const t = toast('正在打包备份…', { sticky: true });
  try {
    const { blob, count, fileCount } = await db.exportBackup();
    const d = new Date();
    const name = `工作台备份-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}.wbk`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    await db.setMeta('lastBackup', Date.now());
    t.close();
    toast(`已导出 ${count} 张卡片（${fileCount} 个文件，${fmtSize(blob.size)}）`);
    refreshStatus();
  } catch (e) {
    t.close();
    toast(`备份失败：${e.message || e}`, { error: true });
  }
}
async function doRestore(file) {
  try {
    const data = await db.readBackup(file);
    const n = data.manifest.cards?.length || 0;
    const ok = await confirmBox({ title: '从备份恢复？', body: `备份时间 ${new Date(data.manifest.exportedAt).toLocaleString('zh-CN')}，共 ${n} 张卡片。将与现有内容合并（同一张卡片以备份为准），现有其他内容不受影响。`, ok: '开始恢复' });
    if (!ok) return;
    const t = toast(`正在恢复 0/${n}…`, { sticky: true });
    await db.importBackup(data, (i, total) => t.set(`正在恢复 ${i}/${total}…`));
    t.close();
    await load();
    toast(`已恢复 ${n} 张卡片`);
    await changed();
  } catch (e) {
    toast(`恢复失败：${e.message || e}`, { error: true });
  }
}

// ---------- 拖拽 ----------
let indicator = null;
function clearDropUI() {
  indicator?.remove(); indicator = null;
  $$('.drop-active').forEach((el) => el.classList.remove('drop-active'));
}
function dropIndex(list, y) {
  const cards = $$('.card:not(.dragging)', list);
  const i = cards.findIndex((c) => { const r = c.getBoundingClientRect(); return y < r.top + r.height / 2; });
  return { index: i < 0 ? cards.length : i, before: cards[i] || null };
}
// 把「可见列表中的位置」映射成「完整列表中的位置」（搜索过滤时两者不同）
function realIndex(colId, before) {
  if (!before) return cardsIn(colId, false).filter((c) => c.id !== state.dragId).length;
  return cardsIn(colId, false).filter((c) => c.id !== state.dragId).findIndex((c) => c.id === before.dataset.id);
}
const isFileDrag = (e) => !state.dragId && [...(e.dataTransfer?.types || [])].includes('Files');

document.addEventListener('pointerover', (e) => {
  const card = e.target.closest?.('.card');
  if (card && findCard(card.dataset.id)?.kind === 'file') urlFor(card.dataset.id); // 预先准备，以便拖到桌面
});
document.addEventListener('dragstart', (e) => {
  const el = e.target.closest?.('.card');
  if (!el) return;
  const card = findCard(el.dataset.id);
  state.dragId = card.id;
  closeMenu();
  e.dataTransfer.effectAllowed = 'copyMove';
  e.dataTransfer.setData('application/x-workbench-card', card.id);
  e.dataTransfer.setData('text/plain', card.kind === 'note' ? (card.text || card.name) : card.name);
  // Chrome / Edge：拖到桌面或文件夹即可导出文件
  if (card.kind === 'note') {
    const url = URL.createObjectURL(new Blob([card.text || ''], { type: 'text/plain' }));
    e.dataTransfer.setData('DownloadURL', `text/plain:${card.name || '便签'}.txt:${url}`);
  } else if (state.urls.has(card.id)) {
    e.dataTransfer.setData('DownloadURL', `${card.type || 'application/octet-stream'}:${card.name}:${state.urls.get(card.id)}`);
  }
  requestAnimationFrame(() => el.classList.add('dragging'));
  document.body.classList.add('is-dragging-card');
});
document.addEventListener('dragend', () => {
  state.dragId = null;
  $$('.dragging').forEach((el) => el.classList.remove('dragging'));
  document.body.classList.remove('is-dragging-card', 'file-over');
  clearDropUI();
});
let fileDepth = 0;
document.addEventListener('dragenter', (e) => {
  if (isFileDrag(e)) { fileDepth++; document.body.classList.add('file-over'); }
  // 窄屏：拖着卡片经过「草稿区」按钮时自动展开
  if (state.dragId && e.target.closest?.('.drafts-toggle')) document.body.classList.add('drafts-open');
});
document.addEventListener('dragleave', (e) => {
  if (isFileDrag(e) && --fileDepth <= 0) { fileDepth = 0; document.body.classList.remove('file-over'); clearDropUI(); }
});
document.addEventListener('dragover', (e) => {
  const fileDrag = isFileDrag(e);
  if (!fileDrag && !state.dragId) return;
  e.preventDefault(); // 防止浏览器直接打开文件
  const tab = e.target.closest?.('[data-drop]');
  const list = e.target.closest?.('.list');
  clearDropUI();
  e.dataTransfer.dropEffect = fileDrag ? 'copy' : 'move';
  if (tab) { tab.classList.add('drop-active'); return; }
  if (!list || (fileDrag && list.dataset.col === TRASH)) { if (!fileDrag) e.dataTransfer.dropEffect = 'none'; return; }
  list.classList.add('drop-active');
  const { before } = dropIndex(list, e.clientY);
  indicator = document.createElement('div');
  indicator.className = 'drop-indicator';
  list.insertBefore(indicator, before || null);
});
document.addEventListener('drop', async (e) => {
  const fileDrag = isFileDrag(e);
  if (!fileDrag && !state.dragId) return;
  e.preventDefault();
  const dragId = state.dragId;
  const tab = e.target.closest?.('[data-drop]');
  const list = e.target.closest?.('.list');
  const before = list ? dropIndex(list, e.clientY).before : null;
  fileDepth = 0;
  document.body.classList.remove('file-over');
  clearDropUI();
  let colId = tab ? tab.dataset.drop : list?.dataset.col;
  if (fileDrag) {
    const files = await filesFromDataTransfer(e.dataTransfer);
    if (!colId || colId === TRASH) colId = state.columns[0]?.id;
    return addFiles(files, colId, list && colId === list.dataset.col ? realIndex(colId, before) : null);
  }
  if (!colId) return;
  if (tab) return moveCard(dragId, colId, 0);
  state.dragId = dragId;
  const idx = realIndex(colId, before);
  await moveCard(dragId, colId, idx);
});

// ---------- 点击 / 键盘 ----------
document.addEventListener('click', async (e) => {
  if (!e.target.closest('#menu') && !e.target.closest('[data-action="card-menu"], [data-action="col-menu"]')) closeMenu();
  const tab = e.target.closest('.tab');
  if (tab) { state.tab = tab.dataset.tab; return render(); }
  const btn = e.target.closest('[data-action]');
  const cardEl = e.target.closest('.card');
  const colEl = e.target.closest('.column');
  const col = colEl && state.columns.find((c) => c.id === colEl.dataset.colId);
  if (!btn) { if (cardEl) preview(cardEl.dataset.id); return; }
  const a = btn.dataset.action;
  switch (a) {
    case 'card-menu': return menuAnchor === btn ? closeMenu() : cardMenu(btn, findCard(cardEl.dataset.id));
    case 'col-menu': return menuAnchor === btn ? closeMenu() : colMenu(btn, col);
    case 'rename-col': return renameColumn(col);
    case 'add-col': return addColumn();
    case 'add-note-col': return newNote(col.id);
    case 'new-note': return newNote();
    case 'add-files': return $('#fileInput').click();
    case 'backup': return doBackup();
    case 'restore': return $('#restoreInput').click();
    case 'storage-info': return storageInfo();
    case 'download': return download(btn.dataset.id);
    case 'close-viewer': return closeViewer();
    case 'toggle-drafts': {
      const open = document.body.classList.toggle('drafts-open');
      $('.drafts-toggle').setAttribute('aria-expanded', String(open));
      return;
    }
    case 'empty-trash': {
      const list = cardsIn(TRASH, false);
      if (!(await confirmBox({ title: '清空回收站？', body: `${list.length} 张卡片将被永久删除，无法恢复。建议先备份。`, ok: '永久删除', danger: true }))) return;
      for (const c of list) await purgeCard(c.id);
      toast(`已永久删除 ${list.length} 张卡片`);
      return changed();
    }
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeMenu(); document.body.classList.remove('drafts-open'); }
  const cardEl = e.target.closest?.('.card');
  if (cardEl && e.target === cardEl) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); preview(cardEl.dataset.id); }
    if (e.key === 'Delete') { const c = findCard(cardEl.dataset.id); c.columnId === TRASH ? null : trashCard(c.id); }
    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); cardMenu($('.more', cardEl), findCard(cardEl.dataset.id)); }
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#search').focus(); }
});
document.addEventListener('contextmenu', (e) => {
  const cardEl = e.target.closest('.card');
  if (!cardEl) return;
  e.preventDefault();
  cardMenu($('.more', cardEl), findCard(cardEl.dataset.id));
});
document.addEventListener('paste', (e) => {
  if (e.target.closest('input, textarea, dialog')) return;
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); return addFiles(files.map((f) => f.name ? f : new File([f], `粘贴的图片-${Date.now()}.png`, { type: f.type }))); }
  const text = e.clipboardData?.getData('text/plain');
  if (text?.trim()) {
    e.preventDefault();
    const colId = state.columns[0]?.id || DRAFTS;
    const card = { id: uid(), kind: 'note', name: text.trim().split('\n')[0].slice(0, 40), text, columnId: colId,
      order: orderAt(colId, cardsIn(colId, false).length), createdAt: Date.now(), updatedAt: Date.now() };
    db.put('cards', card).then(() => { state.cards.push(card); toast('已粘贴为便签'); changed(); });
  }
});
let searchTimer;
$('#search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.query = e.target.value.trim(); render(); }, 120);
});
$('#fileInput').addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = ''; });
$('#restoreInput').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) doRestore(f); });
window.addEventListener('resize', closeMenu);
$('#board').addEventListener('scroll', closeMenu, { passive: true });

// 多个标签页之间保持同步
channel && (channel.onmessage = async () => { await load(); render(); refreshStatus(); });

// ---------- 启动 ----------
(async function init() {
  try {
    await db.open();
    await load();
    await ensureDefaults();
    render();
    refreshStatus();
    if (state.cards.length) requestPersist();
  } catch (e) {
    console.error(e);
    $('#board').innerHTML = `<div class="empty" style="margin:40px auto;max-width:420px">无法打开本地数据库：${esc(e.message || e)}<br>请确认没有使用无痕模式，或刷新重试。</div>`;
  }
})();
