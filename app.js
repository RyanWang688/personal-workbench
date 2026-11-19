import * as db from './db.js?v=3';
import * as pv from './preview.js?v=3';

const TRASH = 'trash';
const BOARD = 'board';
const ARCHIVE = 'archive';      // 「已完成项目」页面
const PICK = 'archive-pick';    // 拖到「已完成项目」标签上 → 选择文件夹
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ls = {
  get(k, d) { try { const v = localStorage.getItem(`wb:${k}`); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`wb:${k}`, JSON.stringify(v)); } catch {} },
};

// areas：看板列(kind 'column')、功能区(kind 'zone')、画布(kind 'canvas')，统一存在 columns 表
const state = {
  areas: [], cards: [], query: '', urls: new Map(), dragId: null,
  view: ls.get('view', BOARD), zone: ls.get('zone', 'drafts'), cams: ls.get('cams', {}),
  fresh: new Set(), // 新加入的卡片，渲染时播放入场动画
  folder: ls.get('folder', null), // 「已完成项目」里当前打开的文件夹
};
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('personal-workbench') : null;

// ---------- 文件类型 ----------
const TYPES = [
  { k: 'image', label: '图片', c: '#7048e8', test: (t, e) => t.startsWith('image/') || /^(png|jpe?g|gif|webp|svg|bmp|heic|avif|ico)$/.test(e) },
  { k: 'video', label: '视频', c: '#e8590c', test: (t, e) => t.startsWith('video/') || /^(mp4|mov|webm|mkv|avi)$/.test(e) },
  { k: 'audio', label: '音频', c: '#d6336c', test: (t, e) => t.startsWith('audio/') || /^(mp3|wav|m4a|flac|ogg|aac)$/.test(e) },
  { k: 'design', label: '设计稿', c: '#c2255c', test: (t, e) => /^(afpub|afdesign|afphoto|psd|psb|ai|sketch|fig|xd|indd|cdr)$/.test(e) },
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
const kindOf = (a) => a.kind || 'column';
const areasOf = (kind) => state.areas.filter((a) => kindOf(a) === kind).sort(byOrder);
const columns = () => areasOf('column');
const zones = () => areasOf('zone');
const canvases = () => areasOf('canvas');
const area = (id) => state.areas.find((a) => a.id === id);
const isCanvas = (id) => area(id)?.kind === 'canvas';
const areaName = (id) => id === TRASH ? '回收站' : (area(id)?.title || '未知区域');
const fallbackZone = () => (area('drafts') ? 'drafts' : zones()[0]?.id);
const findCard = (id) => state.cards.find((c) => c.id === id);
const matches = (c) => {
  if (!state.query) return true;
  const q = state.query.toLowerCase();
  return (c.name || '').toLowerCase().includes(q) || (c.text || '').toLowerCase().includes(q);
};
function cardsIn(areaId, filtered = true) {
  let list = state.cards.filter((c) => c.columnId === areaId);
  if (filtered) list = list.filter(matches);
  return areaId === TRASH ? list.sort((a, b) => (b.trashedAt || 0) - (a.trashedAt || 0)) : list.sort(byOrder);
}
function orderAt(areaId, index, excludeId) {
  const list = cardsIn(areaId, false).filter((c) => c.id !== excludeId);
  const prev = list[index - 1], next = list[index];
  if (!prev && !next) return 0;
  if (!prev) return next.order - 1024;
  if (!next) return prev.order + 1024;
  return (prev.order + next.order) / 2;
}
const topOrder = (areaId) => Math.max(0, ...cardsIn(areaId, false).map((c) => c.order)) + 1;
// 当前「默认投放位置」：看板 → 第一列；画布 → 画布视野中央
const folders = () => areasOf('folder');
const openFolder = () => (state.view === ARCHIVE && area(state.folder)?.kind === 'folder' ? state.folder : null);
function defaultTarget() {
  if (isCanvas(state.view)) return state.view;
  if (openFolder()) return openFolder();
  return columns()[0]?.id || fallbackZone();
}

async function load() {
  const [areas, cards] = await Promise.all([db.getAll('columns'), db.getAll('cards')]);
  state.areas = areas;
  state.cards = cards;
  const live = new Set(cards.map((c) => c.id));
  for (const [key, url] of state.urls) if (!live.has(key.replace(/^thumb:/, ''))) { URL.revokeObjectURL(url); state.urls.delete(key); }
  if (state.view !== BOARD && state.view !== ARCHIVE && !isCanvas(state.view)) state.view = BOARD;
  if (state.folder && !area(state.folder)) state.folder = null;
  if (state.zone !== TRASH && !area(state.zone)) state.zone = fallbackZone() || TRASH;
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
async function saveArea(a) { await db.put('columns', a); }

async function ensureDefaults() {
  const add = [];
  if (!columns().length) ['收件箱', '进行中', '已完成'].forEach((title, i) => add.push({ id: uid(), kind: 'column', title, order: i * 1024 }));
  if (!zones().length) {
    add.push({ id: 'materials', kind: 'zone', title: '素材区', order: 0, desc: '常用素材：图片、模板、参考资料，随时拖到看板或画布上使用。' });
    add.push({ id: 'drafts', kind: 'zone', title: '草稿区', order: 1024, desc: '暂时不用的东西放这里，不会丢，随时拖回去。' });
    add.push({ id: 'temp', kind: 'zone', title: '临时文件区', order: 2048, ttlDays: 7, desc: '中转用的临时文件。' });
  }
  if (!canvases().length) add.push({ id: uid(), kind: 'canvas', title: '画布', order: 0 });
  if (!add.length) return;
  await db.putMany('columns', add);
  state.areas.push(...add);
  if (!area(state.zone)) state.zone = fallbackZone();
}

// 临时区：过期文件移到回收站（不直接删除）
async function sweepExpired() {
  const now = Date.now();
  const expired = [];
  for (const z of zones()) {
    if (!(z.ttlDays > 0)) continue;
    for (const c of cardsIn(z.id, false)) {
      if (now - (c.enteredAt || c.createdAt) > z.ttlDays * 86400e3) {
        c.prevColumnId = c.columnId; c.columnId = TRASH; c.trashedAt = now; c.updatedAt = now;
        expired.push(c);
      }
    }
  }
  if (!expired.length) return;
  await db.putMany('cards', expired);
  await changed();
  toast(`临时文件区有 ${expired.length} 个过期文件已移到回收站`);
}

// ---------- 卡片 HTML ----------
const highlight = (s) => {
  const t = esc(s);
  if (!state.query) return t;
  const q = esc(state.query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return t.replace(new RegExp(q, 'gi'), (m) => `<mark>${m}</mark>`);
};
const MORE = `<button class="more" data-action="card-menu" aria-label="更多操作" aria-haspopup="menu"><svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg></button>`;
const HANDLE = `<span class="export-handle" draggable="true" title="拖到桌面导出"><svg viewBox="0 0 24 24"><path d="M12 4v11m0 0-4-4m4 4 4-4"/><path d="M5 19h14"/></svg></span>`;
const fmtDur = (s) => { s = Math.round(s || 0); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
function metaText(c, t) {
  const i = c.info || {};
  const bits = [t.label];
  if (i.pages) bits.push(`${i.pages} 页`);
  if (i.sheets > 1) bits.push(`${i.sheets} 个表`);
  if (i.duration) bits.push(fmtDur(i.duration));
  else if (i.w && i.h) bits.push(`${i.w}×${i.h}`);
  bits.push(fmtSize(c.size || 0));
  return bits.join(' · ');
}
// ---------- 智能关联：同一项目的文件自动归组 ----------
// 去掉「-预览 / 封面 / 第N页 / 终稿 / v2 / (2) / 日期」等后缀后，名称相同或以「名称 + 分隔符」开头即视为同一项目；
// 转换生成的文件通过 sourceId 关联到原文件。
const SEP = '[\\s_\\-–—.·]';
const SUFFIX = new RegExp(`(${SEP}*(预览图?|封面|缩略图|第\\s*\\d+\\s*页|终稿|定稿|最终版?|修改版|初稿|final|copy|副本|v\\d+(\\.\\d+)*|\\(\\d+\\)|（\\d+）|\\d{8}|\\d{4}-\\d{1,2}-\\d{1,2}))+$`, 'i');
function baseTitle(c) {
  let s = (c.name || '').replace(/\.[a-z0-9]{1,6}$/i, '').trim(), prev;
  do { prev = s; s = s.replace(SUFFIX, '').trim(); } while (s !== prev && s);
  return s.replace(new RegExp(`${SEP}+$`), '') || (c.name || '').replace(/\.[^.]+$/, '');
}
const relKey = (c) => { const k = baseTitle(c).toLowerCase(); return k.length >= 2 ? k : null; };
const isActive = (c) => c.columnId !== TRASH && area(c.columnId)?.kind !== 'folder';
function buildGroups() {
  const live = state.cards.filter(isActive);
  const parent = new Map(live.map((c) => [c.id, c.id]));
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const union = (a, b) => { if (parent.has(a) && parent.has(b)) parent.set(find(a), find(b)); };
  const keyed = live.map((c) => [c, relKey(c)]).filter(([, k]) => k);
  const sepRe = new RegExp(`^${SEP}`);
  for (let i = 0; i < keyed.length; i++) {
    for (let j = i + 1; j < keyed.length; j++) {
      const [a, ka] = keyed[i], [b, kb] = keyed[j];
      const [short, long] = ka.length <= kb.length ? [ka, kb] : [kb, ka];
      if (ka === kb || (long.startsWith(short) && sepRe.test(long.slice(short.length)))) union(a.id, b.id);
    }
  }
  for (const c of live) if (c.sourceId) union(c.id, c.sourceId);
  const groups = new Map();
  for (const c of live) { const r = find(c.id); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(c.id); }
  state.groups = new Map();
  for (const ids of groups.values()) for (const id of ids) state.groups.set(id, ids);
}
const relatedIds = (id) => state.groups?.get(id) || [id];
const LINK_SVG = `<svg viewBox="0 0 24 24"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>`;
function linkBadge(c) {
  const n = relatedIds(c.id).length;
  return n > 1 ? `<span class="link-badge" title="自动关联了 ${n} 个同项目文件，长按任意一个即可一起打包完成">${LINK_SVG}${n}</span>` : '';
}
const IS_TOUCH = matchMedia('(hover: none) and (pointer: coarse)').matches;

const thumbStateOf = (c) => c.kind !== 'file' ? 'none' : (c.thumb || (pv.likelyThumb(c) ? 'pending' : 'none'));
const PLAY = `<span class="play"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" fill="currentColor" stroke="none"/></svg></span>`;
function cardHTML(c, onCanvas = false) {
  const attrs = onCanvas
    ? `draggable="false" style="left:${Math.round(c.x || 0)}px;top:${Math.round(c.y || 0)}px;z-index:${Math.max(1, Math.round(c.order) || 1)}"`
    : `draggable="${IS_TOUCH ? 'false' : 'true'}"`;
  const cls = `card${onCanvas ? ' on-canvas' : ''}${onCanvas && !matches(c) ? ' dim' : ''}`;
  const extra = onCanvas ? HANDLE : '';
  if (c.kind === 'note') {
    return `<article class="${cls} note" ${attrs} tabindex="0" data-id="${c.id}" aria-label="便签 ${esc(c.name)}">
      <div class="body"><div class="name">${highlight(c.name || '便签')}</div>
      ${c.text ? `<div class="note-text">${highlight(c.text)}</div>` : ''}
      <div class="meta">便签 · ${fmtDate(c.updatedAt || c.createdAt)}${linkBadge(c)}</div></div>${extra}${MORE}</article>`;
  }
  const t = typeOf(c);
  const meta = metaText(c, t) + linkBadge(c);
  const ext = extOf(c.name).slice(0, 5) || t.label;
  const name = `<div class="name" title="${esc(c.name)}&#10;添加于 ${fmtDate(c.createdAt)}">${highlight(c.name)}</div>`;
  const st = thumbStateOf(c);
  if (st !== 'none') {
    const badge = t.k === 'image' ? '' : `<span class="thumb-badge" style="--c:${t.c}">${esc(ext)}</span>`;
    const url = state.urls.get(`thumb:${c.id}`);
    const media = st === 'ok'
      ? `<div class="thumb fit-${c.thumbFit || 'cover'}"><img class="thumb-img${url ? ' loaded' : ''}" data-thumb="${c.id}" ${url ? `src="${url}"` : ''} alt="" draggable="false">${t.k === 'video' ? PLAY : ''}${badge}</div>`
      : `<div class="thumb skel" aria-label="正在生成预览">${badge}</div>`;
    return `<article class="${cls} has-img" ${attrs} tabindex="0" data-id="${c.id}" aria-label="${esc(c.name)}">
      ${media}<div class="body">${name}<div class="meta">${meta}</div></div>${extra}${MORE}</article>`;
  }
  return `<article class="${cls}" ${attrs} tabindex="0" data-id="${c.id}" aria-label="${esc(c.name)}">
    <div class="type-icon" style="--c:${t.c}">${esc(ext.slice(0, 4))}</div>
    <div class="body">${name}<div class="meta">${meta}</div></div>${extra}${MORE}</article>`;
}
function listHTML(areaId, emptyText) {
  const list = cardsIn(areaId);
  if (!list.length) return `<div class="empty">${state.query ? '没有匹配的内容' : emptyText}</div>`;
  return list.map((c) => cardHTML(c)).join('');
}

// ---------- 渲染 ----------
const DOTS = `<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>`;
function render() {
  const before = snapshot();
  buildGroups();
  renderViews();
  const onBoard = state.view === BOARD, onArchive = state.view === ARCHIVE;
  $('#board').hidden = !onBoard;
  $('#archiveView').hidden = !onArchive;
  $('#canvasView').hidden = onBoard || onArchive;
  if (onBoard) renderBoard(); else if (onArchive) renderArchive(); else renderCanvas();
  renderZones();
  loadThumbs();
  playFlip(before);
  queueThumbs();
}
// 渲染期间若用户正在拖拽 / 菜单打开，稍后再刷新，避免打断操作
let renderTimer = 0;
function renderSoon() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => {
    if (cardDrag || state.dragId || !$('#menu').hidden || pan) return renderSoon();
    render();
  }, 60);
}

// ---------- 智能动画（FLIP）：卡片移动、排序、尺寸变化时平滑过渡，新卡片入场 ----------
function snapshot() {
  const m = new Map();
  if (reduceMotion.matches) return m;
  $$('.card[data-id]').forEach((el) => { if (el.offsetParent) m.set(el.dataset.id, el.getBoundingClientRect()); });
  return m;
}
function playFlip(before) {
  if (reduceMotion.matches) { state.fresh.clear(); return; }
  let n = 0;
  $$('.card[data-id]').forEach((el) => {
    if (!el.offsetParent) return;
    const id = el.dataset.id, old = before.get(id);
    const ease = 'cubic-bezier(.2,.8,.2,1)';
    if (old) {
      const now = el.getBoundingClientRect();
      const dx = old.left - now.left, dy = old.top - now.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(old.height - now.height) < 1) return;
      const z = el.classList.contains('on-canvas') ? cam().z : 1;
      el.animate([{ transform: `translate(${dx / z}px, ${dy / z}px)` }, { transform: 'none' }], { duration: 320, easing: ease });
    } else if (state.fresh.has(id)) {
      el.animate([{ opacity: 0, transform: 'translateY(10px) scale(.96)' }, { opacity: 1, transform: 'none' }],
        { duration: 360, delay: Math.min(n++, 10) * 45, easing: ease, fill: 'backwards' });
    }
  });
  state.fresh.clear();
}
async function animateOut(id) {
  const el = $(`.card[data-id="${CSS.escape(id)}"]`);
  if (!el || !el.offsetParent || reduceMotion.matches) return;
  await el.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.9)' }], { duration: 170, easing: 'ease-in', fill: 'forwards' }).finished.catch(() => {});
}

// ---------- 缩略图队列 ----------
const thumbQ = [], queued = new Set();
let thumbBusy = false;
function queueThumbs() {
  for (const c of state.cards) {
    if (c.kind === 'file' && !c.thumb && c.columnId !== TRASH && !queued.has(c.id)) { queued.add(c.id); thumbQ.push(c.id); }
  }
  runThumbs();
}
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('超时')), ms))]);
async function runThumbs() {
  if (thumbBusy) return;
  thumbBusy = true;
  while (thumbQ.length) {
    const id = thumbQ.shift();
    queued.delete(id);
    const c = findCard(id);
    if (!c || c.thumb) continue;
    try {
      const blob = await db.getBlob(id);
      if (!blob) continue;
      const r = await withTimeout(pv.makeThumb(c, blob), 45000);
      if (r?.blob) { await db.putThumb(id, r.blob); c.thumb = 'ok'; c.thumbFit = r.fit; c.info = r.info; }
      else c.thumb = 'none';
    } catch (e) {
      console.warn('预览生成失败', c.name, e);
      if (/组件加载失败/.test(e.message)) { thumbQ.length = 0; queued.clear(); break; } // 离线：下次再试
      c.thumb = 'none';
    }
    if (!findCard(id)) continue;
    await db.put('cards', c);
    refreshCard(c);
  }
  thumbBusy = false;
}
// 只替换这一张卡片的 DOM（不整页重绘，不会打断用户点击 / 悬停），周围卡片用 FLIP 平滑让位
function refreshCard(c) {
  const els = $$(`.card[data-id="${CSS.escape(c.id)}"]`);
  if (!els.length) return;
  const before = snapshot();
  for (const el of els) {
    if (el.matches(':active') || el.classList.contains('dragging') || el.classList.contains('lifting')) { renderSoon(); return; }
    const tpl = document.createElement('template');
    tpl.innerHTML = cardHTML(c, el.classList.contains('on-canvas')).trim();
    const next = tpl.content.firstElementChild;
    el.replaceWith(next);
    if (!reduceMotion.matches) next.animate([{ opacity: 0.4 }, { opacity: 1 }], { duration: 300, easing: 'ease-out' });
  }
  loadThumbs();
  playFlip(before);
}
function renderViews() {
  const count = (id) => cardsIn(id, false).length;
  const boardCount = columns().reduce((n, c) => n + count(c.id), 0);
  $('#views').innerHTML = `
    <button role="tab" class="view-tab" data-view="${BOARD}" aria-selected="${state.view === BOARD}">
      <svg viewBox="0 0 24 24"><rect x="4" y="4" width="4.5" height="16" rx="1"/><rect x="10" y="4" width="4.5" height="11" rx="1"/><rect x="16" y="4" width="4" height="7" rx="1"/></svg>看板<b>${boardCount}</b></button>
    <button role="tab" class="view-tab archive-tab" data-view="${ARCHIVE}" data-drop="${PICK}" aria-selected="${state.view === ARCHIVE}" title="彻底完成的项目归档在这里；把卡片拖到这里即可归档">
      ${FOLDER_SVG}已完成项目<b>${folders().length}</b></button>
    <span class="view-sep" aria-hidden="true"></span>
    ${canvases().map((cv) => `<button role="tab" class="view-tab" data-view="${cv.id}" data-drop="${cv.id}" aria-selected="${state.view === cv.id}">
      <svg viewBox="0 0 24 24"><rect x="3.5" y="3.5" width="17" height="17" rx="2"/><circle cx="9" cy="9" r="1"/><circle cx="15" cy="15" r="1"/><circle cx="15" cy="9" r="1"/><circle cx="9" cy="15" r="1"/></svg>${esc(cv.title)}<b>${count(cv.id)}</b>
      ${state.view === cv.id ? `<span class="tab-more" data-action="canvas-menu" role="button" aria-label="画布设置">${DOTS}</span>` : ''}</button>`).join('')}
    <button class="view-add" data-action="add-canvas" title="新建画布"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>画布</button>`;
}
function renderBoard() {
  const board = $('#board');
  const scroll = board.scrollLeft;
  const listScroll = Object.fromEntries($$('.list', board).map((l) => [l.dataset.col, l.scrollTop]));
  board.innerHTML = columns().map((col) => `
    <section class="column" data-col-id="${col.id}">
      <header class="col-head">
        <h2 class="col-title" data-action="rename-area" title="点击重命名">${esc(col.title)}</h2>
        <span class="col-count">${cardsIn(col.id, false).length}</span>
        <button class="icon-btn" data-action="col-menu" aria-label="列操作" aria-haspopup="menu">${DOTS}</button>
      </header>
      <div class="list" data-col="${col.id}">${listHTML(col.id, '把文件拖到这里')}</div>
      <div class="col-foot"><button class="add-inline" data-action="add-note-col"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>添加便签</button></div>
    </section>`).join('') + `<button class="add-column" data-action="add-col"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>新建列</button>`;
  board.scrollLeft = scroll;
  $$('.list', board).forEach((l) => { if (listScroll[l.dataset.col]) l.scrollTop = listScroll[l.dataset.col]; });
}
// ---------- 已完成项目（归档文件夹） ----------
const FOLDER_SVG = `<svg viewBox="0 0 24 24"><path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><path d="m9 13.5 2 2 4-4"/></svg>`;
const folderSize = (id) => cardsIn(id, false).reduce((n, c) => n + (c.size || 0), 0);
function folderCover(f) {
  const list = cardsIn(f.id, false).slice(0, 4);
  if (!list.length) return `<div class="cover-empty">${FOLDER_SVG}</div>`;
  return `<div class="cover-grid n${list.length}">${list.map((c) => {
    if (c.thumb === 'ok') {
      const url = state.urls.get(`thumb:${c.id}`);
      return `<img class="thumb-img${url ? ' loaded' : ''}" data-thumb="${c.id}" ${url ? `src="${url}"` : ''} alt="" draggable="false">`;
    }
    const t = typeOf(c);
    return `<span class="cover-type" style="--c:${c.kind === 'note' ? '#f0b429' : t.c}">${esc(c.kind === 'note' ? '便签' : (extOf(c.name).slice(0, 4) || t.label))}</span>`;
  }).join('')}</div>`;
}
function renderArchive() {
  const el = $('#archiveView');
  const fid = openFolder();
  if (fid) {
    const f = area(fid), n = cardsIn(fid, false).length;
    el.innerHTML = `
      <header class="archive-head">
        <button class="icon-btn back" data-action="folder-back" aria-label="返回已完成项目"><svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg></button>
        <div class="ah-text">
          <div class="crumb"><button class="crumb-link" data-action="folder-back">已完成项目</button><span>/</span></div>
          <h2>${esc(f.title)}</h2>
          <div class="meta">${n} 个文件 · ${fmtSize(folderSize(fid))} · 归档于 ${fmtDate(f.doneAt || Date.now())}</div>
        </div>
        <button class="btn" data-action="folder-zip" ${n ? '' : 'disabled'}><svg viewBox="0 0 24 24"><path d="M12 4v11m0 0-4-4m4 4 4-4"/><path d="M5 19h14"/></svg><span>打包下载</span></button>
        <button class="icon-btn" data-action="folder-menu" aria-label="文件夹设置" aria-haspopup="menu">${DOTS}</button>
      </header>
      <div class="list folder-list" data-col="${fid}">${listHTML(fid, '把卡片或文件拖到这里归档')}</div>`;
    return;
  }
  const q = state.query.toLowerCase();
  const fs = folders().filter((f) => !q || f.title.toLowerCase().includes(q) || cardsIn(f.id).length);
  el.innerHTML = `
    <header class="archive-head">
      <div class="ah-text">
        <h2>已完成项目</h2>
        <div class="meta">在看板上<b>长按任意卡片</b>即可完成项目：同名的关联文件会自动打包成文件夹放到这里。也可以把卡片拖到文件夹上，或在列菜单里「整列归档」。</div>
      </div>
      <button class="btn primary" data-action="add-folder"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg><span>新建项目文件夹</span></button>
    </header>
    ${fs.length ? `<div class="folder-grid">${fs.map((f) => {
      const n = cardsIn(f.id, false).length;
      return `<div class="folder" role="button" tabindex="0" data-folder="${f.id}" data-drop="${f.id}" aria-label="项目文件夹 ${esc(f.title)}，${n} 个文件">
        <div class="folder-tab" aria-hidden="true"></div>
        <div class="folder-cover">${folderCover(f)}</div>
        <div class="folder-info"><div class="folder-name">${highlight(f.title)}</div>
          <div class="meta">${n} 个文件 · ${fmtSize(folderSize(f.id))} · ${fmtDate(f.doneAt || Date.now())}</div></div>
        <button class="more" data-action="folder-menu" data-id="${f.id}" aria-label="文件夹设置" aria-haspopup="menu">${DOTS}</button>
      </div>`;
    }).join('')}</div>`
    : `<div class="archive-empty">${FOLDER_SVG}<b>${state.query ? '没有匹配的项目' : '还没有已完成的项目'}</b><span>${state.query ? '' : '回到看板，长按一个做完的文件 —— 它和同项目的文件会被自动打包送到这里。'}</span></div>`}`;
}
async function createFolder(title) {
  const list = folders();
  const f = { id: uid(), kind: 'folder', title, order: list.length ? list[list.length - 1].order + 1024 : 0, doneAt: Date.now() };
  await saveArea(f);
  state.areas.push(f);
  return f;
}
// 批量归档，可撤销
async function archiveCards(cards, folderId, { animated = false, message, newFolder = false } = {}) {
  if (!cards.length) return;
  const prev = cards.map((c) => ({ c, columnId: c.columnId, order: c.order, x: c.x, y: c.y }));
  if (!animated) await Promise.all(cards.map((c) => animateOut(c.id)));
  let order = orderAt(folderId, cardsIn(folderId, false).length);
  for (const c of cards) { c.columnId = folderId; c.order = order; c.enteredAt = Date.now(); c.updatedAt = Date.now(); order += 1024; }
  await db.putMany('cards', cards);
  await changed();
  toast(message || `已归档 ${cards.length} 个到「${areaName(folderId)}」`, {
    action: '撤销',
    onAction: async () => {
      for (const p of prev) Object.assign(p.c, { columnId: p.columnId, order: p.order, x: p.x, y: p.y });
      await db.putMany('cards', cards);
      // 撤销时，如果文件夹是这次新建的且已空，一并移除
      const f = area(folderId);
      if (newFolder && f && !cardsIn(folderId, false).length) {
        await db.del('columns', folderId);
        state.areas = state.areas.filter((x) => x !== f);
        if (state.folder === folderId) { state.folder = null; ls.set('folder', null); }
      }
      await changed();
    },
  });
}
async function pickFolder() {
  const fs = folders();
  const res = await dialog(`<h3>归档到哪个项目文件夹？</h3>
    <div class="pick-list">${fs.map((f, i) => `<label class="pick"><input type="radio" name="f" value="${f.id}" ${i === 0 ? 'checked' : ''}><span>${esc(f.title)}</span><small>${cardsIn(f.id, false).length} 个文件</small></label>`).join('')}
      <label class="pick new"><input type="radio" name="f" value="__new" ${fs.length ? '' : 'checked'}><input type="text" name="n" placeholder="新建项目文件夹，输入名称…" maxlength="80"></label></div>
    ${actions('归档')}`, (f) => ({ id: f.querySelector('input[name="f"]:checked')?.value, name: f.n.value.trim() }));
  if (!res) return null;
  if (res.name || res.id === '__new' || !res.id) return (await createFolder(res.name || `项目 ${new Date().toLocaleDateString('zh-CN')}`)).id;
  return res.id;
}
async function archiveColumn(col) {
  const cards = cardsIn(col.id, false);
  if (!cards.length) return toast('这一列是空的');
  const name = await prompt({ title: `把「${col.title}」的 ${cards.length} 张卡片归档为已完成项目`, value: '', placeholder: '项目名称，例如：物理宣传册', ok: '归档' });
  if (!name) return;
  const f = await createFolder(name);
  await archiveCards(cards, f.id);
}
async function zipFolder(f) {
  const cards = cardsIn(f.id, false);
  if (!cards.length) return toast('文件夹是空的');
  const t = toast('正在打包…', { sticky: true });
  try {
    const JSZip = await pv.lib('zip');
    const z = new JSZip(), used = new Set();
    for (const c of cards) {
      const raw = (c.kind === 'note' ? `${c.name || '便签'}.txt` : c.name).replace(/[\\/:*?"<>|]/g, '_');
      let name = raw, i = 2;
      while (used.has(name)) name = raw.replace(/(\.[^.]*)?$/, ` (${i++})$1`);
      used.add(name);
      const data = c.kind === 'note' ? (c.text || '') : await db.getBlob(c.id);
      if (data != null) z.file(name, data);
    }
    const blob = await z.generateAsync({ type: 'blob', compression: 'STORE' }, (m) => t.set(`正在打包 ${Math.round(m.percent)}%…`));
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${f.title.replace(/[\\/:*?"<>|]/g, '_')}.zip`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    t.close();
    toast(`已打包 ${cards.length} 个文件（${fmtSize(blob.size)}）`);
  } catch (e) {
    t.close();
    toast(`打包失败：${e.message || e}`, { error: true });
  }
}

function renderZones() {
  const zs = zones();
  const nt = cardsIn(TRASH, false).length;
  $('#zoneTabs').innerHTML = zs.map((z) => `<button role="tab" class="tab" data-zone="${z.id}" data-drop="${z.id}" aria-selected="${state.zone === z.id}">${esc(z.title)} <b>${cardsIn(z.id, false).length}</b></button>`).join('')
    + `<button role="tab" class="tab trash-tab" data-zone="${TRASH}" data-drop="${TRASH}" aria-selected="${state.zone === TRASH}" title="回收站"><svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13"/></svg><b>${nt}</b></button>`
    + `<button class="tab add-zone" data-action="add-zone" title="新建功能区" aria-label="新建功能区"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></button>`;
  const z = area(state.zone);
  const dl = $('#draftsList');
  dl.dataset.col = state.zone;
  dl.innerHTML = listHTML(state.zone, state.zone === TRASH ? '回收站是空的' : `把文件拖到「${esc(z?.title)}」`);
  let desc;
  if (state.zone === TRASH) desc = '删除的卡片先进入这里，可恢复；只有「永久删除」才会真正移除。';
  else desc = (z?.desc || '自定义功能区，放什么都行。') + (z?.ttlDays > 0 ? ` 放入超过 ${z.ttlDays} 天会自动移到回收站。` : '');
  $('#draftsDesc').textContent = desc;
  $('#zoneMenuBtn').hidden = state.zone === TRASH;
  $('#draftsFoot').innerHTML = state.zone === TRASH && nt ? `<button class="btn" data-action="empty-trash">清空回收站</button>` : '';
  $('#zonesBadge').textContent = zs.reduce((n, z2) => n + cardsIn(z2.id, false).length, 0);
}
async function urlFor(id) {
  if (state.urls.has(id)) return state.urls.get(id);
  const card = findCard(id);
  if (card?.kind === 'note') return URL.createObjectURL(new Blob([card.text || ''], { type: 'text/plain;charset=utf-8' }));
  const blob = await db.getBlob(id);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  state.urls.set(id, url);
  return url;
}
async function thumbUrl(id) {
  const key = `thumb:${id}`;
  if (state.urls.has(key)) return state.urls.get(key);
  const b = await db.getThumb(id);
  if (!b) { const c = findCard(id); if (c) { c.thumb = undefined; queueThumbs(); } return null; }
  const url = URL.createObjectURL(b);
  state.urls.set(key, url);
  return url;
}
function loadThumbs() {
  $$('img[data-thumb]:not([src])').forEach(async (img) => {
    const url = await thumbUrl(img.dataset.thumb);
    if (!url) return;
    img.onload = () => img.classList.add('loaded');
    img.src = url;
  });
}

// ---------- 无限画布 ----------
const CARD_W = 232;
const cam = () => state.cams[state.view] || (state.cams[state.view] = { x: 80, y: 60, z: 1 });
const saveCam = () => ls.set('cams', state.cams);
function applyCam() {
  const c = cam();
  $('#world').style.transform = `translate(${c.x}px, ${c.y}px) scale(${c.z})`;
  const vp = $('#viewport');
  vp.style.backgroundPosition = `${c.x}px ${c.y}px`;
  vp.style.backgroundSize = `${24 * c.z}px ${24 * c.z}px`;
  $('#zoomLabel').textContent = `${Math.round(c.z * 100)}%`;
}
function renderCanvas() {
  const list = cardsIn(state.view, false);
  $('#world').innerHTML = list.map((c) => cardHTML(c, true)).join('');
  $('#canvasEmpty').hidden = list.length > 0;
  applyCam();
}
function toWorld(clientX, clientY) {
  const r = $('#viewport').getBoundingClientRect(), c = cam();
  return { x: (clientX - r.left - c.x) / c.z, y: (clientY - r.top - c.y) / c.z };
}
function viewCenter() {
  const r = $('#viewport').getBoundingClientRect();
  if (!r.width) return { x: 0, y: 0 };
  const p = toWorld(r.left + r.width / 2, r.top + r.height / 2);
  return { x: p.x - CARD_W / 2, y: p.y - 40 };
}
// 镜头缓动：按钮缩放 / 显示全部时平滑过渡
let camAnim = 0;
function tweenCam(to) {
  const c = cam();
  cancelAnimationFrame(camAnim);
  if (reduceMotion.matches) { Object.assign(c, to); applyCam(); saveCam(); return; }
  const from = { ...c }, t0 = performance.now(), dur = 280;
  const step = (now) => {
    const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
    c.x = from.x + (to.x - from.x) * e; c.y = from.y + (to.y - from.y) * e; c.z = from.z + (to.z - from.z) * e;
    applyCam();
    if (k < 1) camAnim = requestAnimationFrame(step); else saveCam();
  };
  camAnim = requestAnimationFrame(step);
}
function zoomAt(factor, clientX, clientY, animate = false) {
  const c = cam(), r = $('#viewport').getBoundingClientRect();
  if (clientX == null) { clientX = r.left + r.width / 2; clientY = r.top + r.height / 2; }
  const z = Math.min(3, Math.max(0.15, c.z * factor));
  const px = clientX - r.left, py = clientY - r.top;
  const to = { x: px - (px - c.x) * (z / c.z), y: py - (py - c.y) * (z / c.z), z };
  if (animate) return tweenCam(to);
  Object.assign(c, to);
  applyCam(); saveCam();
}
function zoomFit() {
  const els = $$('#world .card');
  const c = cam();
  if (!els.length) return tweenCam({ x: 80, y: 60, z: 1 });
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const el of els) {
    const x = el.offsetLeft, y = el.offsetTop;
    x1 = Math.min(x1, x); y1 = Math.min(y1, y); x2 = Math.max(x2, x + el.offsetWidth); y2 = Math.max(y2, y + el.offsetHeight);
  }
  const r = $('#viewport').getBoundingClientRect(), pad = 60;
  const z = Math.min(1.2, Math.max(0.15, Math.min((r.width - pad * 2) / (x2 - x1), (r.height - pad * 2) / (y2 - y1))));
  tweenCam({ z, x: (r.width - (x2 - x1) * z) / 2 - x1 * z, y: (r.height - (y2 - y1) * z) / 2 - y1 * z });
}
async function tidyCanvas() {
  const list = cardsIn(state.view, false);
  if (!list.length) return;
  await waitImgs();
  const cols = Math.max(1, Math.ceil(Math.sqrt(list.length * 1.6)));
  const heights = new Array(cols).fill(0);
  for (const card of list) {
    const el = $(`#world .card[data-id="${card.id}"]`);
    const i = heights.indexOf(Math.min(...heights));
    card.x = i * (CARD_W + 52); card.y = heights[i];
    heights[i] += (el?.offsetHeight || 80) + 24;
  }
  await db.putMany('cards', list);
  await changed();
  zoomFit();
}

// 画布交互：平移、缩放、拖动卡片
const vp = $('#viewport');
const pointers = new Map();
let pan = null, pinch = null, cardDrag = null, suppressClick = false;
vp.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 && e.pointerType === 'mouse') return;
  const cardEl = e.target.closest('.card');
  if (cardEl && !e.target.closest('.more, .export-handle')) {
    const card = findCard(cardEl.dataset.id);
    cardDrag = { el: cardEl, card, sx: e.clientX, sy: e.clientY, x: card.x || 0, y: card.y || 0, moved: false, id: e.pointerId };
    try { cardEl.setPointerCapture(e.pointerId); } catch {}
    return;
  }
  if (cardEl) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  try { vp.setPointerCapture(e.pointerId); } catch {}
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) }; pan = null;
  } else {
    const c = cam();
    pan = { sx: e.clientX, sy: e.clientY, x: c.x, y: c.y, moved: false };
  }
});
vp.addEventListener('pointermove', (e) => {
  if (cardDrag && e.pointerId === cardDrag.id) {
    const dx = e.clientX - cardDrag.sx, dy = e.clientY - cardDrag.sy;
    if (!cardDrag.moved && Math.hypot(dx, dy) < 4) return;
    if (!cardDrag.moved) {
      cardDrag.moved = true;
      cardDrag.el.classList.add('lifting');
      cardDrag.el.style.zIndex = topOrder(state.view) + 1;
      document.body.classList.add('is-dragging-card');
    }
    const z = cam().z;
    cardDrag.el.style.left = `${cardDrag.x + dx / z}px`;
    cardDrag.el.style.top = `${cardDrag.y + dy / z}px`;
    highlightZoneUnder(e.clientX, e.clientY, cardDrag.el);
    return;
  }
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch && pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    zoomAt(d / pinch.d, (a.x + b.x) / 2, (a.y + b.y) / 2);
    pinch.d = d;
  } else if (pan) {
    const c = cam();
    c.x = pan.x + e.clientX - pan.sx; c.y = pan.y + e.clientY - pan.sy;
    if (Math.hypot(e.clientX - pan.sx, e.clientY - pan.sy) > 3) { pan.moved = true; vp.classList.add('panning'); }
    applyCam();
  }
});
async function endPointer(e) {
  if (cardDrag && e.pointerId === cardDrag.id) {
    const d = cardDrag; cardDrag = null;
    document.body.classList.remove('is-dragging-card');
    clearDropUI();
    if (!d.moved) return;
    suppressClick = true; setTimeout(() => { suppressClick = false; }, 0);
    d.el.classList.remove('lifting');
    const zone = e.type === 'pointerup' ? zoneUnder(e.clientX, e.clientY, d.el) : null;
    if (zone) return moveCard(d.card.id, zone, 0);
    d.card.x = parseFloat(d.el.style.left); d.card.y = parseFloat(d.el.style.top);
    d.card.order = topOrder(state.view);
    await saveCard(d.card);
    await changed();
    return;
  }
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
  if (pan) { vp.classList.remove('panning'); saveCam(); }
  if (!pointers.size) pan = null;
}
vp.addEventListener('pointerup', endPointer);
vp.addEventListener('pointercancel', endPointer);
// 拖动画布卡片时，经过右侧功能区就高亮，松手即放入
function zoneUnder(x, y, el) {
  el.style.pointerEvents = 'none';
  const hit = document.elementFromPoint(x, y);
  el.style.pointerEvents = '';
  const t = hit?.closest('#drafts [data-drop], #draftsList, .view-tab[data-drop]');
  if (!t) return null;
  const id = t.dataset.drop || t.dataset.col;
  return id && id !== state.view ? id : null;
}
function highlightZoneUnder(x, y, el) {
  clearDropUI();
  const id = zoneUnder(x, y, el);
  if (!id) return;
  const t = id === state.zone ? $('#draftsList') : $(`[data-drop="${CSS.escape(id)}"]`);
  t?.classList.add('drop-active');
}
vp.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) return zoomAt(Math.exp(-e.deltaY * 0.0025), e.clientX, e.clientY);
  const c = cam();
  c.x -= e.deltaX; c.y -= e.deltaY;
  applyCam();
  clearTimeout(vp._t); vp._t = setTimeout(saveCam, 200);
}, { passive: false });
vp.addEventListener('dblclick', async (e) => {
  if (e.target.closest('.card')) return;
  const p = toWorld(e.clientX, e.clientY);
  await newNote(state.view, { x: p.x - CARD_W / 2, y: p.y - 30 });
});

// ---------- 添加文件 ----------
async function addFiles(files, areaId, index = null, pos = null, { quiet = false, extra = {} } = {}) {
  files = files.filter((f) => f && f.name !== '.DS_Store');
  if (!files.length) return [];
  if (!areaId || !area(areaId)) areaId = defaultTarget();
  const canvas = isCanvas(areaId);
  if (canvas && !pos) pos = state.view === areaId ? viewCenter() : { x: 0, y: 0 };
  if (index == null) index = cardsIn(areaId, false).length;
  let ok = 0;
  const added = [];
  const t = files.length > 1 ? toast(`正在保存 0/${files.length}…`, { sticky: true }) : null;
  const perRow = Math.max(1, Math.ceil(Math.sqrt(files.length)));
  for (const f of files) {
    const now = Date.now();
    const card = {
      id: uid(), kind: 'file', name: f.name || `粘贴的文件-${now}`, type: f.type || '', size: f.size,
      columnId: areaId, order: canvas ? topOrder(areaId) : orderAt(areaId, index + ok), createdAt: now, updatedAt: now, enteredAt: now, ...extra,
    };
    if (canvas) { card.x = pos.x + (ok % perRow) * (CARD_W + 20); card.y = pos.y + Math.floor(ok / perRow) * 120; }
    try {
      await db.addFile(card, f);
      state.cards.push(card);
      state.fresh.add(card.id);
      added.push(card);
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
    if (!quiet) toast(`已保存 ${ok} 个文件到「${areaName(areaId)}」`);
    requestPersist();
    await changed();
    if (canvas && ok > 1 && state.view === areaId) await masonry(added, pos);
  }
  return added;
}
// 按真实高度瀑布流排列一组画布卡片，避免重叠
const waitImgs = () => Promise.all($$('#world img[data-thumb]').map((img) => (img.complete && img.naturalWidth) ? 0
  : new Promise((r) => { img.addEventListener('load', r, { once: true }); img.addEventListener('error', r, { once: true }); setTimeout(r, 1500); })));
async function masonry(list, pos) {
  await waitImgs();
  const cols = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(list.length))));
  const heights = new Array(cols).fill(0);
  for (const card of list) {
    const el = $(`#world .card[data-id="${card.id}"]`);
    const i = heights.indexOf(Math.min(...heights));
    card.x = pos.x + i * (CARD_W + 52); card.y = pos.y + heights[i];
    heights[i] += (el?.offsetHeight || 80) + 20;
    if (el) { el.style.left = `${card.x}px`; el.style.top = `${card.y}px`; }
  }
  await db.putMany('cards', list);
}
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
async function moveCard(id, areaId, index = 0, pos = null) {
  const card = findCard(id);
  if (!card) return;
  if (areaId === TRASH) return trashCard(id);
  if (isCanvas(areaId)) {
    const p = pos || (state.view === areaId ? viewCenter() : { x: 0, y: 0 });
    card.x = p.x; card.y = p.y;
    card.order = topOrder(areaId);
  } else {
    card.order = orderAt(areaId, index, id);
  }
  if (card.columnId !== areaId) card.enteredAt = Date.now();
  if (card.columnId === TRASH) delete card.trashedAt;
  const moved = card.columnId !== areaId;
  card.columnId = areaId;
  await saveCard(card);
  await changed();
  if (moved && areaId !== state.view && !columns().some((c) => c.id === areaId && state.view === BOARD)) toast(`已移到「${areaName(areaId)}」`);
}
async function trashCard(id) {
  const card = findCard(id);
  if (!card || card.columnId === TRASH) return;
  if (state.zone !== TRASH) await animateOut(id);
  card.prevColumnId = card.columnId;
  card.columnId = TRASH;
  card.trashedAt = Date.now();
  await saveCard(card);
  await changed();
  toast(`「${card.name}」已移到回收站`, { action: '撤销', onAction: () => restoreCard(id) });
}
async function restoreCard(id) {
  const card = findCard(id);
  if (!card) return;
  const target = area(card.prevColumnId) ? card.prevColumnId : (columns()[0]?.id || fallbackZone());
  card.order = isCanvas(target) ? topOrder(target) : orderAt(target, cardsIn(target, false).length, id);
  card.columnId = target;
  card.enteredAt = Date.now();
  delete card.trashedAt;
  await saveCard(card);
  await changed();
  toast(`已恢复到「${areaName(target)}」`);
}
async function purgeCard(id, anim = true) {
  if (anim) await animateOut(id);
  await db.deleteCard(id);
  for (const key of [id, `thumb:${id}`]) {
    const url = state.urls.get(key);
    if (url) { URL.revokeObjectURL(url); state.urls.delete(key); }
  }
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
async function newNote(areaId, pos) {
  areaId = areaId || defaultTarget();
  const res = await noteEditor({ name: '', text: '' });
  if (!res) return;
  const now = Date.now();
  const canvas = isCanvas(areaId);
  const card = { id: uid(), kind: 'note', name: res.name || '未命名便签', text: res.text, columnId: areaId,
    order: canvas ? topOrder(areaId) : orderAt(areaId, cardsIn(areaId, false).length), createdAt: now, updatedAt: now, enteredAt: now };
  if (canvas) Object.assign(card, pos || viewCenter());
  await db.put('cards', card);
  state.cards.push(card);
  state.fresh.add(card.id);
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

// ---------- 区域（列 / 功能区 / 画布）操作 ----------
const KIND_LABEL = { column: '列', zone: '功能区', canvas: '画布', folder: '项目文件夹' };
async function addArea(kind) {
  const title = await prompt({ title: `新建${KIND_LABEL[kind]}`, placeholder: kind === 'zone' ? '例如：灵感、参考图…' : kind === 'canvas' ? '例如：项目脑图' : kind === 'folder' ? '例如：物理宣传册' : '例如：资料、待审阅…', ok: '创建' });
  if (!title) return;
  if (kind === 'folder') { await createFolder(title); return changed(); }
  const list = areasOf(kind);
  const a = { id: uid(), kind, title, order: list.length ? list[list.length - 1].order + 1024 : 0 };
  await saveArea(a);
  state.areas.push(a);
  if (kind === 'zone') { state.zone = a.id; ls.set('zone', a.id); }
  if (kind === 'canvas') setView(a.id);
  await changed();
  if (kind === 'column') $('#board').scrollTo({ left: $('#board').scrollWidth, behavior: 'smooth' });
}
async function renameArea(a) {
  const title = await prompt({ title: `重命名${KIND_LABEL[kindOf(a)]}`, value: a.title, ok: '保存' });
  if (!title || title === a.title) return;
  a.title = title;
  await saveArea(a);
  await changed();
}
async function moveArea(a, dir) {
  const list = areasOf(kindOf(a));
  const i = list.indexOf(a), j = i + dir;
  if (j < 0 || j >= list.length) return;
  const other = list[j];
  [a.order, other.order] = [other.order, a.order];
  await db.putMany('columns', [a, other]);
  await changed();
}
async function deleteArea(a) {
  const kind = kindOf(a);
  if (kind !== 'folder' && areasOf(kind).length <= 1) return toast(`至少保留一个${KIND_LABEL[kind]}`, { error: true });
  const cards = cardsIn(a.id, false);
  let target = kind === 'zone' ? zones().find((z) => z.id !== a.id)?.id : fallbackZone();
  if (target === a.id) target = zones().find((z) => z.id !== a.id)?.id;
  const ok = await confirmBox({ title: `删除${KIND_LABEL[kind]}「${a.title}」？`, body: cards.length ? `里面的 ${cards.length} 张卡片会移到「${areaName(target)}」，不会丢失。` : `这个${KIND_LABEL[kind]}是空的。`, ok: '删除', danger: true });
  if (!ok) return;
  let order = orderAt(target, cardsIn(target, false).length);
  for (const c of cards) { c.columnId = target; c.order = order; c.enteredAt = Date.now(); order += 1024; }
  if (cards.length) await db.putMany('cards', cards);
  await db.del('columns', a.id);
  state.areas = state.areas.filter((x) => x !== a);
  if (state.view === a.id) setView(BOARD);
  if (state.folder === a.id) { state.folder = null; ls.set('folder', null); }
  if (state.zone === a.id) { state.zone = target; ls.set('zone', target); }
  await changed();
}
async function setZoneTtl(z) {
  const v = await prompt({ title: `「${z.title}」自动清理`, value: String(z.ttlDays || ''), placeholder: '天数，留空或 0 表示不自动清理', ok: '保存', optional: true });
  if (v == null) return;
  const n = Math.max(0, Math.floor(Number(v) || 0));
  z.ttlDays = n || undefined;
  await saveArea(z);
  await changed();
  toast(n ? `放入超过 ${n} 天的卡片会自动移到回收站` : '已关闭自动清理');
  sweepExpired();
}
function setView(v) {
  state.view = v;
  ls.set('view', v);
}

// ---------- 预览 ----------
async function preview(id) {
  const card = findCard(id);
  if (!card) return;
  if (card.kind === 'note') return editNote(card);
  const t = typeOf(card);
  const fam = pv.family(card);
  const convs = pv.conversionsFor(card, card.thumb === 'ok');
  $('#viewerInner').innerHTML = `<div class="viewer-head"><div class="type-icon sm" style="--c:${t.c}">${esc(extOf(card.name).slice(0, 4) || t.label)}</div>
    <div class="vh-text"><div class="name">${esc(card.name)}</div><div class="meta">${metaText(card, t)}</div></div>
    <button class="icon-btn" data-action="download" data-id="${id}" aria-label="下载原文件" title="下载原文件"><svg viewBox="0 0 24 24"><path d="M12 4v11m0 0-4-4m4 4 4-4"/><path d="M5 19h14"/></svg></button>
    <button class="icon-btn" data-action="close-viewer" aria-label="关闭"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>
    <div class="viewer-body" id="viewerBody"><div class="spinner" aria-label="加载中"></div></div>
    ${convs.length ? `<div class="convert-bar"><span class="cv-label"><svg viewBox="0 0 24 24"><path d="M4 7h13l-3-3M20 17H7l3 3"/></svg>转换为</span>
      ${convs.map((c) => `<button class="chip" data-action="convert" data-conv="${c.id}" data-id="${id}">${esc(c.label)}</button>`).join('')}
      <span class="cv-status" id="cvStatus" aria-live="polite"></span></div>` : ''}`;
  $('#viewer').showModal();
  const bodyEl = $('#viewerBody');
  const url = await urlFor(id);
  let html, mount;
  try {
    if (!url) html = `<div class="viewer-none">找不到文件内容</div>`;
    else if (fam === 'image') html = `<img src="${url}" alt="${esc(card.name)}">`;
    else if (fam === 'video') html = `<video src="${url}" controls autoplay></video>`;
    else if (fam === 'audio') {
      const tu = card.thumb === 'ok' ? await thumbUrl(id) : null;
      html = `<div class="audio-view">${tu ? `<img src="${tu}" alt="">` : ''}<audio src="${url}" controls autoplay></audio></div>`;
    } else if (fam === 'pdf' && extOf(card.name) === 'pdf') html = `<iframe src="${url}" title="${esc(card.name)}"></iframe>`;
    else {
      const rich = await pv.richPreview(card, await db.getBlob(id), card.thumb === 'ok' ? await thumbUrl(id) : null);
      if (rich) ({ html, mount } = rich);
      else if (isTextual(card) && card.size < 2 * 1024 * 1024) html = `<pre>${esc(await (await db.getBlob(id)).text())}</pre>`;
      else if (card.thumb === 'ok') html = `<figure class="embed-preview"><img src="${await thumbUrl(id)}" alt=""></figure>`;
    }
  } catch (e) {
    console.warn(e);
    html = `<div class="viewer-none">预览失败：${esc(e.message || e)}</div>`;
  }
  if (!html) html = `<div class="viewer-none"><div class="type-icon" style="--c:${t.c}">${esc(extOf(card.name).slice(0, 4) || t.label)}</div><div>此类型无法在浏览器内预览</div><button class="btn primary" data-action="download" data-id="${id}">下载文件</button></div>`;
  if (!$('#viewer').open || $('#viewerBody') !== bodyEl) return; // 已关闭或切换
  bodyEl.innerHTML = html;
  bodyEl.classList.add('ready');
  mount?.(bodyEl);
}
async function runConvert(btn) {
  const card = findCard(btn.dataset.id);
  if (!card || btn.classList.contains('busy')) return;
  const status = $('#cvStatus');
  const say = (s) => { if (status) status.textContent = s; };
  btn.classList.add('busy');
  say('正在转换…');
  try {
    const files = await pv.convert(card, await db.getBlob(card.id), btn.dataset.conv, say);
    const areaId = card.columnId === TRASH ? defaultTarget() : card.columnId;
    const canvas = isCanvas(areaId);
    const idx = canvas ? null : cardsIn(areaId, false).findIndex((c) => c.id === card.id) + 1;
    const pos = canvas ? { x: (card.x || 0) + CARD_W + 60, y: card.y || 0 } : null;
    const added = await addFiles(files, areaId, idx, pos, { quiet: true, extra: { sourceId: card.sourceId || card.id } });
    say(`✓ 已生成 ${added.length} 个文件，放在「${areaName(areaId)}」原文件旁边`);
    toast(`转换完成：${added.map((c) => c.name).slice(0, 2).join('、')}${added.length > 2 ? ` 等 ${added.length} 个` : ''}`,
      { action: '下载', onAction: () => added.forEach((c, i) => setTimeout(() => download(c.id), i * 300)) });
  } catch (e) {
    console.warn(e);
    say('');
    toast(`转换失败：${e.message || e}`, { error: true });
  } finally {
    btn.classList.remove('busy');
  }
}
// 关闭时清空内容，确保视频/音频停止播放（不只依赖 close 事件）
function closeViewer() { const v = $('#viewer'); if (v.open) v.close(); $('#viewerInner').innerHTML = ''; }
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
const prompt = ({ title, value = '', placeholder = '', ok = '确定', optional = false }) =>
  dialog(`<h3>${esc(title)}</h3><input type="text" name="v" value="${esc(value)}" placeholder="${esc(placeholder)}" maxlength="120" ${optional ? '' : 'required'}>${actions(ok)}`,
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
    return openMenu(anchor, items);
  }
  if (isActive(card)) {
    const n = relatedIds(card.id).length;
    items.push({ text: n > 1 ? `✓ 完成项目（打包 ${n} 个关联文件）` : '✓ 完成项目并归档', run: () => completeProject(card.id) }, '-');
  }
  items.push({ text: card.kind === 'note' ? '编辑' : '预览', run: () => preview(card.id) },
    { text: '下载', run: () => download(card.id) },
    { text: '重命名', run: async () => {
      const n = await prompt({ title: '重命名', value: card.name, ok: '保存' });
      if (n && n !== card.name) { card.name = n; await saveCard(card); await changed(); } } });
  const dest = (list, label) => {
    const opts = list.filter((a) => a.id !== card.columnId);
    if (!opts.length) return;
    items.push('-', { label });
    opts.forEach((a) => items.push({ text: a.title, run: () => moveCard(card.id, a.id, kindOf(a) === 'zone' ? 0 : cardsIn(a.id, false).length) }));
  };
  dest(columns(), '移到看板');
  dest(canvases(), '放到画布');
  dest(zones(), '放入功能区');
  items.push('-', { label: '归档到已完成项目' });
  folders().filter((f) => f.id !== card.columnId).forEach((f) => items.push({ text: f.title, run: () => archiveCards([card], f.id) }));
  items.push({ text: '新建项目文件夹并归档…', run: async () => {
    const n = await prompt({ title: '新建项目文件夹', placeholder: '项目名称', ok: '创建并归档' });
    if (n) archiveCards([card], (await createFolder(n)).id);
  } });
  items.push('-', { text: '删除', danger: true, run: () => trashCard(card.id) });
  openMenu(anchor, items);
}
function areaMenu(anchor, a) {
  const kind = kindOf(a);
  const list = areasOf(kind), i = list.indexOf(a);
  const prev = kind === 'column' ? '向左移' : '前移', next = kind === 'column' ? '向右移' : '后移';
  const items = [{ text: '重命名', run: () => renameArea(a) }];
  if (kind !== 'canvas' && kind !== 'folder') items.push({ text: '添加便签', run: () => newNote(a.id) });
  if (kind === 'column') items.push({ text: '整列归档到已完成项目…', run: () => archiveColumn(a) });
  if (kind === 'folder') items.push({ text: '打包下载 zip', run: () => zipFolder(a) });
  if (kind === 'zone') items.push({ text: a.ttlDays ? `自动清理：${a.ttlDays} 天` : '设置自动清理…', run: () => setZoneTtl(a) });
  if (i > 0) items.push({ text: prev, run: () => moveArea(a, -1) });
  if (i < list.length - 1) items.push({ text: next, run: () => moveArea(a, 1) });
  items.push('-', { text: `删除${KIND_LABEL[kind]}`, danger: true, run: () => deleteArea(a) });
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
  const close = () => el.remove();
  if (action) {
    const b = document.createElement('button');
    b.textContent = action;
    b.onclick = () => { close(); onAction(); };
    el.appendChild(b);
  }
  $('#toasts').appendChild(el);
  while ($('#toasts').children.length > 3) $('#toasts').firstChild.remove();
  if (!sticky) setTimeout(close, action || error ? 6000 : 3000);
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
  chip.textContent = `已用 ${fmtSize(used)}${quota ? ` / ${fmtSize(quota)}` : ''} · ${persisted ? '持久存储' : '普通存储'}`;
  chip.className = `status-chip ${persisted ? 'ok' : 'warn'}`;
  let lastBackup = 0, lastChange = 0;
  try { [lastBackup, lastChange] = await Promise.all([db.getMeta('lastBackup', 0), db.getMeta('lastChange', 0)]); } catch { return; }
  const bc = $('#backupChip');
  const stale = state.cards.length && lastChange > lastBackup && (!lastBackup || Date.now() - lastBackup > 3 * 86400e3);
  bc.textContent = lastBackup ? `上次备份 ${ago(lastBackup)}${lastChange > lastBackup ? ' · 有新改动' : ''}` : '尚未备份';
  bc.className = `status-chip ${stale ? 'warn' : lastBackup ? 'ok' : ''}`;
}
async function storageInfo() {
  const persisted = await navigator.storage?.persisted?.();
  const r = await dialog(`<h3>数据存在哪里？</h3>
    <p>所有文件和卡片保存在本浏览器内置的 IndexedDB 数据库中，不会上传到任何服务器。每个文件写入后都会回读校验大小。</p>
    <p>持久存储：<b>${persisted ? '已开启' : '未开启'}</b>。${persisted ? '浏览器不会因空间紧张自动清理这些数据。' : '浏览器可能在磁盘空间不足时清理数据，建议点「申请持久存储」并定期备份。'}</p>
    <p>注意：清除浏览器数据、使用无痕模式或换设备时数据不会跟随，请用「备份」导出 .wbk 文件保存到网盘或硬盘。</p>
    <div class="modal-actions"><button class="btn primary" value="cancel">知道了</button>${persisted ? '' : '<button class="btn" value="ok">申请持久存储</button>'}</div>`, () => true);
  if (r) requestPersist();
}
async function doBackup() {
  const t = toast('正在打包备份…', { sticky: true });
  try {
    const { blob, count, fileCount } = await db.exportBackup();
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    const name = `工作台备份-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.wbk`;
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
    await ensureDefaults();
    toast(`已恢复 ${n} 张卡片`);
    await changed();
  } catch (e) {
    toast(`恢复失败：${e.message || e}`, { error: true });
  }
}

// ---------- 悬停：高亮同项目的关联文件 ----------
let hoverGroup = null;
function highlightGroup(id, cls = 'related') {
  $$(`.card.${cls}`).forEach((el) => el.classList.remove(cls));
  if (!id) return;
  const ids = relatedIds(id);
  if (ids.length < 2 && cls === 'related') return;
  for (const rid of ids) $$(`.card[data-id="${CSS.escape(rid)}"]`).forEach((el) => el.classList.add(cls));
}
document.addEventListener('pointerover', (e) => {
  if (e.pointerType !== 'mouse' || press) return;
  const card = e.target.closest?.('.card');
  const id = card && isActive(findCard(card.dataset.id) || {}) ? card.dataset.id : null;
  if (id === hoverGroup) return;
  hoverGroup = id;
  highlightGroup(id);
});

// ---------- 长按完成项目：自动打包关联文件 → 已完成项目 ----------
const PRESS_DELAY = 160, PRESS_TOTAL = 700;
let press = null, pressFired = false;
function cancelPress() {
  if (!press) return;
  clearTimeout(press.t1); clearTimeout(press.t2);
  press.el.classList.remove('pressing');
  press.ring?.remove();
  highlightGroup(null, 'gather');
  press = null;
}
document.addEventListener('pointerdown', (e) => {
  pressFired = false;
  if (e.button !== 0) return;
  const el = e.target.closest?.('.card');
  if (!el || e.target.closest('.more, .export-handle')) return;
  const card = findCard(el.dataset.id);
  if (!card || !isActive(card)) return;
  cancelPress();
  press = { el, id: card.id, x: e.clientX, y: e.clientY, touch: e.pointerType !== 'mouse' };
  press.t1 = setTimeout(() => {
    if (!press) return;
    el.classList.add('pressing');
    highlightGroup(card.id, 'gather');
    const n = relatedIds(card.id).length;
    const ring = document.createElement('div');
    ring.className = 'press-ring';
    // 触屏时把进度环放到手指上方，避免被手指挡住；靠右时文字翻到左边
    ring.style.left = `${press.x}px`; ring.style.top = `${press.touch ? Math.max(30, press.y - 64) : press.y}px`;
    if (press.x > innerWidth - 220) ring.classList.add('flip');
    ring.style.setProperty('--dur', `${PRESS_TOTAL - PRESS_DELAY}ms`);
    ring.innerHTML = `<svg viewBox="0 0 44 44"><circle class="track" cx="22" cy="22" r="18"/><circle class="bar" cx="22" cy="22" r="18"/></svg><span>按住完成项目${n > 1 ? ` · ${n} 个文件` : ''}</span>`;
    document.body.appendChild(ring);
    press.ring = ring;
  }, PRESS_DELAY);
  press.t2 = setTimeout(() => {
    if (!press) return;
    const id = press.id;
    pressFired = true;
    cardDrag = null; // 画布上不要再移动卡片
    cancelPress();
    navigator.vibrate?.(25);
    completeProject(id);
  }, PRESS_TOTAL);
}, true);
document.addEventListener('pointermove', (e) => {
  if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > (press.touch ? 10 : 6)) cancelPress();
}, true);
['pointerup', 'pointercancel', 'dragstart', 'wheel', 'scroll'].forEach((ev) => document.addEventListener(ev, cancelPress, true));
document.addEventListener('visibilitychange', cancelPress);
// 长按触发后，只吞掉「松手那一下」产生的 click（松手后立即复位，不影响之后点撤销等操作）
document.addEventListener('pointerup', () => { if (pressFired) setTimeout(() => { pressFired = false; }, 0); }, true);
document.addEventListener('click', (e) => { if (pressFired) { e.stopPropagation(); e.preventDefault(); pressFired = false; } }, true);
document.addEventListener('contextmenu', (e) => { if ((press || pressFired) && e.target.closest?.('.card')) { e.preventDefault(); e.stopPropagation(); } }, true);
document.addEventListener('dragstart', (e) => { if (pressFired) e.preventDefault(); }, true);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function completeProject(id) {
  const card = findCard(id);
  if (!card || !isActive(card)) return;
  buildGroups();
  const cards = relatedIds(id).map(findCard).filter((c) => c && isActive(c));
  const title = baseTitle(card);
  let folder = folders().find((f) => f.title === title);
  const isNew = !folder;
  await playPackAnimation(cards, title);
  if (!folder) folder = await createFolder(title);
  await archiveCards(cards, folder.id, {
    animated: true, newFolder: isNew,
    message: `「${title}」已完成，打包了 ${cards.length} 个文件${isNew ? '' : '（并入已有文件夹）'}`,
  });
  bumpArchiveTab();
}
function bumpArchiveTab() {
  const tab = $('.archive-tab');
  if (!tab || reduceMotion.matches) return;
  tab.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.16)', offset: 0.35 }, { transform: 'scale(.96)', offset: 0.7 }, { transform: 'scale(1)' }], { duration: 520, easing: 'ease-out' });
  tab.classList.add('glow');
  setTimeout(() => tab.classList.remove('glow'), 1200);
}
const BOX_HTML = (title, n) => `<div class="pack-lid"></div><div class="pack-body"><span class="pack-tape"></span><span class="pack-title">${esc(title)}</span><span class="pack-count">${n} 个文件</span></div>
  <span class="pack-check"><svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg></span>`;
async function playPackAnimation(cards, title) {
  if (reduceMotion.matches) return;
  const els = cards.map((c) => $$(`.card[data-id="${CSS.escape(c.id)}"]`).find((el) => el.offsetParent)).filter(Boolean);
  const layer = document.createElement('div');
  layer.className = 'pack-layer';
  const box = document.createElement('div');
  box.className = 'pack-box';
  box.innerHTML = BOX_HTML(title, cards.length);
  const bx = innerWidth / 2, by = innerHeight / 2;
  box.style.left = `${bx}px`; box.style.top = `${by}px`;
  layer.appendChild(box);
  document.body.appendChild(layer);
  const ease = 'cubic-bezier(.2,.8,.2,1)';
  layer.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, fill: 'forwards' });
  await box.animate([{ transform: 'scale(.3) translateY(30px)', opacity: 0 }, { transform: 'scale(1.06)', opacity: 1, offset: 0.7 }, { transform: 'scale(1)', opacity: 1 }],
    { duration: 340, easing: ease, fill: 'forwards' }).finished;
  // 卡片依次飞进箱子
  await Promise.all(els.map((el, i) => {
    const r = el.getBoundingClientRect();
    const cl = el.cloneNode(true);
    cl.classList.remove('pressing', 'gather', 'related', 'dragging');
    cl.classList.add('pack-clone');
    Object.assign(cl.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, zIndex: '' });
    layer.insertBefore(cl, box);
    el.style.visibility = 'hidden';
    const dx = bx - (r.left + r.width / 2), dy = by - 10 - (r.top + r.height / 2);
    const rot = (i % 2 ? 1 : -1) * (6 + (i % 3) * 3);
    return cl.animate([
      { transform: 'none', opacity: 1 },
      { transform: `translate(${dx}px, ${dy - 90}px) scale(.42) rotate(${rot}deg)`, opacity: 1, offset: 0.65 },
      { transform: `translate(${dx}px, ${dy + 10}px) scale(.18) rotate(${rot}deg)`, opacity: 0 },
    ], { duration: 680, delay: Math.min(i, 8) * 90, easing: 'cubic-bezier(.45,0,.25,1)', fill: 'forwards' }).finished;
  }));
  box.classList.add('closed');
  box.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.05, .95)' }, { transform: 'scale(1)' }], { duration: 260, easing: 'ease-out' });
  await wait(420);
  const tab = $('.archive-tab');
  const tr = tab?.getBoundingClientRect();
  if (tr && tr.width) {
    const tx = tr.left + tr.width / 2 - bx, ty = tr.top + tr.height / 2 - by;
    layer.animate([{ backgroundColor: getComputedStyle(layer).backgroundColor }, { backgroundColor: 'transparent' }], { duration: 560, fill: 'forwards' });
    await box.animate([
      { transform: 'none', opacity: 1 },
      { transform: `translate(${tx * 0.35}px, ${ty * 0.35 - 40}px) scale(.7)`, opacity: 1, offset: 0.4 },
      { transform: `translate(${tx}px, ${ty}px) scale(.12)`, opacity: 0.4 },
    ], { duration: 560, easing: 'cubic-bezier(.5,0,.3,1)', fill: 'forwards' }).finished;
  }
  layer.remove();
}

// ---------- 拖拽（HTML5：看板 / 功能区 / 拖入拖出） ----------
let indicator = null;
function clearDropUI() {
  indicator?.remove(); indicator = null;
  $$('.drop-active').forEach((el) => el.classList.remove('drop-active'));
}
function dropBefore(list, y) {
  const cards = $$('.card:not(.dragging)', list);
  return cards.find((c) => { const r = c.getBoundingClientRect(); return y < r.top + r.height / 2; }) || null;
}
// 可见位置 → 完整列表中的位置（搜索过滤时两者不同）
function realIndex(areaId, before) {
  const list = cardsIn(areaId, false).filter((c) => c.id !== state.dragId);
  return before ? list.findIndex((c) => c.id === before.dataset.id) : list.length;
}
const isFileDrag = (e) => !state.dragId && [...(e.dataTransfer?.types || [])].includes('Files');

document.addEventListener('pointerover', (e) => {
  const card = e.target.closest?.('.card');
  if (card && findCard(card.dataset.id)?.kind === 'file') urlFor(card.dataset.id); // 预先准备，以便拖到桌面
});
document.addEventListener('pointerleave', () => { hoverGroup = null; highlightGroup(null); });
document.addEventListener('dragstart', (e) => {
  const el = e.target.closest?.('.card');
  if (!el) return;
  const card = findCard(el.dataset.id);
  state.dragId = card.id;
  closeMenu();
  e.dataTransfer.effectAllowed = 'copyMove';
  e.dataTransfer.setData('application/x-workbench-card', card.id);
  e.dataTransfer.setData('text/plain', card.kind === 'note' ? (card.text || card.name) : card.name);
  if (e.target.closest('.export-handle')) e.dataTransfer.setDragImage(el, 20, 20);
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
  if (state.dragId && e.target.closest?.('.drafts-toggle')) document.body.classList.add('drafts-open');
});
document.addEventListener('dragleave', (e) => {
  if (isFileDrag(e) && --fileDepth <= 0) { fileDepth = 0; document.body.classList.remove('file-over'); clearDropUI(); }
});
document.addEventListener('dragover', (e) => {
  const fileDrag = isFileDrag(e);
  if (!fileDrag && !state.dragId) return;
  e.preventDefault(); // 防止浏览器直接打开文件
  clearDropUI();
  e.dataTransfer.dropEffect = fileDrag ? 'copy' : 'move';
  const tab = e.target.closest?.('[data-drop]');
  if (tab && !(fileDrag && tab.dataset.drop === TRASH)) { tab.classList.add('drop-active'); return; }
  if (e.target.closest?.('#viewport')) { $('#viewport').classList.add('drop-active'); return; }
  const list = e.target.closest?.('.list');
  if (!list || (fileDrag && list.dataset.col === TRASH)) { if (!fileDrag) e.dataTransfer.dropEffect = 'none'; return; }
  list.classList.add('drop-active');
  indicator = document.createElement('div');
  indicator.className = 'drop-indicator';
  list.insertBefore(indicator, dropBefore(list, e.clientY));
});
document.addEventListener('drop', async (e) => {
  const fileDrag = isFileDrag(e);
  if (!fileDrag && !state.dragId) return;
  e.preventDefault();
  const dragId = state.dragId;
  const tab = e.target.closest?.('[data-drop]');
  const onCanvas = !tab && e.target.closest?.('#viewport');
  const list = !tab && !onCanvas && e.target.closest?.('.list');
  const before = list ? dropBefore(list, e.clientY) : null;
  fileDepth = 0;
  document.body.classList.remove('file-over');
  clearDropUI();
  let target = tab ? tab.dataset.drop : onCanvas ? state.view : list?.dataset.col;
  const pos = onCanvas ? (() => { const p = toWorld(e.clientX, e.clientY); return { x: p.x - CARD_W / 2, y: p.y - 30 }; })() : null;
  if (fileDrag) {
    const files = await filesFromDataTransfer(e.dataTransfer);
    if (target === PICK) target = await pickFolder();
    if (!target || target === TRASH) target = defaultTarget();
    return addFiles(files, target, list ? realIndex(target, before) : null, pos);
  }
  if (target === PICK) {
    const fid = await pickFolder();
    return fid && archiveCards([findCard(dragId)].filter(Boolean), fid);
  }
  if (!target || target === findCard(dragId)?.columnId && tab) return;
  await moveCard(dragId, target, tab ? 0 : realIndex(target, before), pos);
});

// ---------- 点击 / 键盘 ----------
document.addEventListener('click', async (e) => {
  if (!e.target.closest('#menu') && !e.target.closest('[aria-haspopup="menu"], [data-action="canvas-menu"]')) closeMenu();
  if (suppressClick) return;
  const btn = e.target.closest('[data-action]');
  const viewTab = e.target.closest('[data-view]');
  if (viewTab && !btn) {
    if (viewTab.dataset.view === ARCHIVE && state.view === ARCHIVE) { state.folder = null; ls.set('folder', null); }
    setView(viewTab.dataset.view); return render();
  }
  const folderEl = e.target.closest('[data-folder]');
  if (folderEl && !btn) { state.folder = folderEl.dataset.folder; ls.set('folder', state.folder); return render(); }
  const zoneTab = e.target.closest('[data-zone]');
  if (zoneTab) { state.zone = zoneTab.dataset.zone; ls.set('zone', state.zone); return renderZones(), loadThumbs(); }
  const cardEl = e.target.closest('.card');
  const colEl = e.target.closest('.column');
  const col = colEl && area(colEl.dataset.colId);
  if (!btn) { if (cardEl) preview(cardEl.dataset.id); return; }
  switch (btn.dataset.action) {
    case 'card-menu': return menuAnchor === btn ? closeMenu() : cardMenu(btn, findCard(cardEl.dataset.id));
    case 'col-menu': return menuAnchor === btn ? closeMenu() : areaMenu(btn, col);
    case 'zone-menu': return menuAnchor === btn ? closeMenu() : areaMenu(btn, area(state.zone));
    case 'canvas-menu': return menuAnchor === btn ? closeMenu() : areaMenu(btn, area(state.view));
    case 'rename-area': return renameArea(col);
    case 'add-col': return addArea('column');
    case 'add-zone': return addArea('zone');
    case 'add-canvas': return addArea('canvas');
    case 'add-folder': return addArea('folder');
    case 'folder-back': state.folder = null; ls.set('folder', null); return render();
    case 'folder-zip': return zipFolder(area(openFolder()));
    case 'folder-menu': return menuAnchor === btn ? closeMenu() : areaMenu(btn, area(btn.dataset.id || openFolder()));
    case 'add-note-col': return newNote(col.id);
    case 'new-note': return newNote();
    case 'add-files': return $('#fileInput').click();
    case 'backup': return doBackup();
    case 'restore': return $('#restoreInput').click();
    case 'storage-info': return storageInfo();
    case 'download': return download(btn.dataset.id);
    case 'close-viewer': return closeViewer();
    case 'zoom-in': return zoomAt(1.25, null, null, true);
    case 'zoom-out': return zoomAt(1 / 1.25, null, null, true);
    case 'zoom-reset': return zoomAt(1 / cam().z, null, null, true);
    case 'convert': return runConvert(btn);
    case 'zoom-fit': return zoomFit();
    case 'tidy': return tidyCanvas();
    case 'toggle-drafts': {
      const open = document.body.classList.toggle('drafts-open');
      $('.drafts-toggle').setAttribute('aria-expanded', String(open));
      return;
    }
    case 'empty-trash': {
      const list = cardsIn(TRASH, false);
      if (!(await confirmBox({ title: '清空回收站？', body: `${list.length} 张卡片将被永久删除，无法恢复。建议先备份。`, ok: '永久删除', danger: true }))) return;
      await Promise.all(list.map((c) => animateOut(c.id)));
      for (const c of list) await purgeCard(c.id, false);
      toast(`已永久删除 ${list.length} 张卡片`);
      return changed();
    }
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeMenu(); document.body.classList.remove('drafts-open'); }
  const cardEl = e.target.closest?.('.card');
  if (cardEl && e.target === cardEl) {
    const card = findCard(cardEl.dataset.id);
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); preview(card.id); }
    if (e.key === 'Delete' && card.columnId !== TRASH) trashCard(card.id);
    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); cardMenu($('.more', cardEl), card); }
    // 画布上用方向键微调位置
    if (cardEl.classList.contains('on-canvas') && e.key.startsWith('Arrow')) {
      e.preventDefault();
      const s = e.shiftKey ? 40 : 10;
      card.x = (card.x || 0) + (e.key === 'ArrowLeft' ? -s : e.key === 'ArrowRight' ? s : 0);
      card.y = (card.y || 0) + (e.key === 'ArrowUp' ? -s : e.key === 'ArrowDown' ? s : 0);
      cardEl.style.left = `${card.x}px`; cardEl.style.top = `${card.y}px`;
      clearTimeout(cardEl._t); cardEl._t = setTimeout(() => saveCard(card), 300);
    }
  }
  if (e.target.matches?.('[data-folder]') && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); e.target.click(); }
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
    const areaId = defaultTarget(), now = Date.now();
    const card = { id: uid(), kind: 'note', name: text.trim().split('\n')[0].slice(0, 40), text, columnId: areaId,
      order: isCanvas(areaId) ? topOrder(areaId) : orderAt(areaId, cardsIn(areaId, false).length), createdAt: now, updatedAt: now, enteredAt: now };
    if (isCanvas(areaId)) Object.assign(card, viewCenter());
    db.put('cards', card).then(() => { state.cards.push(card); state.fresh.add(card.id); toast('已粘贴为便签'); changed(); });
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
    await sweepExpired();
    setInterval(sweepExpired, 3600e3);
  } catch (e) {
    console.error(e);
    $('#board').innerHTML = `<div class="empty" style="margin:40px auto;max-width:420px">无法打开本地数据库：${esc(e.message || e)}<br>请确认没有使用无痕模式，或刷新重试。</div>`;
  }
})();
