import * as db from './db.js?v=7';
import * as pv from './preview.js?v=7';
import * as collab from './collab.js?v=6';
import * as rn from './rename.js?v=1';
import * as cpv from './canvas-preview.js?v=1';
import * as zip from './zip.js?v=1';
import * as assoc from './assoc.js?v=1';
import * as upTree from './upload-tree.js?v=1';
import * as share from './share.js?v=2';

const TRASH = 'trash';
const BOARD = 'board';
const ARCHIVE = 'archive';      // 「已完成项目」页面
const PICK = 'archive-pick';    // 拖到「已完成项目」标签上 → 选择文件夹
const WORKS = 'works';          // 「作品」页面
const CANVASES = 'canvases';    // 「画布」工作区列表
const CANVAS_PICK = 'canvas-pick';
const STORE = 'store';          // 「云仓库」页面：本机长期保存的文件（区域 kind = 'shelf'）
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
  listLimits: new Map(), // 列表区域当前渲染上限（按区域窗口化渲染，避免千卡级 DOM 卡顿）
  folder: ls.get('folder', null), // 「已完成项目」里当前打开的文件夹
  shelf: ls.get('shelf', null), // 「云仓库」里当前打开的文件夹
  selected: new Set(), // 多选中的卡片
  archCat: ls.get('archCat', 'all'), // 已完成项目的分类筛选
  cats: [], // 已完成项目的分类（含空分类）
  work: ls.get('work', null), workCat: ls.get('workCat', 'all'), workCats: [], // 作品页：当前作品、分类筛选、分类列表
  syncing: new Set(), device: ls.get('device', innerWidth < 720 ? 'phone' : 'desktop'), logFilter: 'all', logLimit: 40,
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
let areaById = new Map();
let cardById = new Map();
let cardsByCol = new Map();
let foldersSorted = [];
let childrenByParent = new Map();
let deepCardsMemo = new Map();
let deepSizeMemo = new Map();
let indexesDirty = true;
const invalidateIndexes = () => { indexesDirty = true; };
function ensureIndexes() {
  if (!indexesDirty && cardById.size === state.cards.length && areaById.size === state.areas.length) return;
  areaById = new Map(state.areas.map((a) => [a.id, a]));
  cardById = new Map(state.cards.map((c) => [c.id, c]));
  cardsByCol = new Map();
  for (const c of state.cards) {
    let arr = cardsByCol.get(c.columnId);
    if (!arr) cardsByCol.set(c.columnId, (arr = []));
    arr.push(c);
  }
  for (const [colId, arr] of cardsByCol) {
    if (colId === TRASH) arr.sort((a, b) => (b.trashedAt || 0) - (a.trashedAt || 0));
    else arr.sort(byOrder);
  }
  foldersSorted = state.areas.filter((a) => (a.kind || 'column') === 'folder').sort(byOrder);
  childrenByParent = new Map();
  for (const f of foldersSorted) {
    const pid = f.parentId && areaById.get(f.parentId)?.kind === 'folder' ? f.parentId : '';
    let subs = childrenByParent.get(pid);
    if (!subs) childrenByParent.set(pid, (subs = []));
    subs.push(f);
  }
  deepCardsMemo = new Map();
  deepSizeMemo = new Map();
  indexesDirty = false;
}
const kindOf = (a) => a.kind || 'column';
const areasOf = (kind) => (kind === 'folder' ? (ensureIndexes(), foldersSorted) : state.areas.filter((a) => kindOf(a) === kind).sort(byOrder));
const columns = () => areasOf('column');
const zones = () => areasOf('zone');
const canvases = () => areasOf('canvas');
const area = (id) => { ensureIndexes(); return areaById.get(id) || state.areas.find((a) => a.id === id); };
const isCanvas = (id) => area(id)?.kind === 'canvas';
const areaName = (id) => id === TRASH ? '回收站' : (area(id)?.title || '未知区域');
const fallbackZone = () => (area('drafts') ? 'drafts' : zones()[0]?.id);
const findCard = (id) => { ensureIndexes(); return cardById.get(id) || state.cards.find((c) => c.id === id); };
const matches = (c) => {
  if (!state.query) return true;
  const q = state.query.toLowerCase();
  return (c.name || '').toLowerCase().includes(q) || (c.text || '').toLowerCase().includes(q);
};
function cardsIn(areaId, filtered = true) {
  ensureIndexes();
  const sorted = cardsByCol.get(areaId) || [];
  if (!filtered || !state.query) return sorted;
  const q = state.query.toLowerCase();
  return sorted.filter((c) => (c.name || '').toLowerCase().includes(q) || (c.text || '').toLowerCase().includes(q));
}
function orderAt(areaId, index, excludeId) {
  const list = excludeId ? cardsIn(areaId, false).filter((c) => c.id !== excludeId) : cardsIn(areaId, false);
  const prev = list[index - 1], next = list[index];
  if (!prev && !next) return 0;
  if (!prev) return next.order - 1024;
  if (!next) return prev.order + 1024;
  return (prev.order + next.order) / 2;
}
const topOrder = (areaId) => Math.max(0, ...cardsIn(areaId, false).map((c) => c.order), ...(area(areaId)?.shapes || []).map((s) => s.z || 0)) + 1;
// 当前「默认投放位置」：看板 → 第一列；画布 → 画布视野中央
const folders = () => areasOf('folder');
// 项目文件夹可以整个移进云仓库：根文件夹带 stored 标记，子文件夹跟着根走
const rootFolderOf = (f) => { let r = f, i = 0; for (let p = parentOf(r); p && i < 50; p = parentOf(r), i++) r = p; return r; };
const isStoredFolder = (f) => f?.kind === 'folder' && !!rootFolderOf(f)?.stored;
const openFolder = () => {
  const f = area(state.folder);
  if (f?.kind !== 'folder') return null;
  if (state.view === ARCHIVE && !isStoredFolder(f)) return f.id;
  if (state.view === STORE && isStoredFolder(f)) return f.id;
  return null;
};
function defaultTarget() {
  if (isCanvas(state.view)) return state.view;
  if (openFolder()) return openFolder();
  if (state.view === WORKS && area(state.work)?.kind === 'work') return state.work;
  if (state.view === STORE) return (area(state.shelf)?.kind === 'shelf' ? state.shelf : null) || areasOf('shelf')[0]?.id || columns()[0]?.id;
  return columns()[0]?.id || fallbackZone();
}

async function load() {
  const [areas, cards] = await Promise.all([db.getAll('columns'), db.getAll('cards')]);
  state.areas = areas;
  state.cards = cards;
  invalidateIndexes();
  ensureIndexes();
  for (const [key, url] of state.urls) if (!cardById.has(key.replace(/^thumb:/, ''))) { URL.revokeObjectURL(url); state.urls.delete(key); }
  for (const id of [...pdfDocs.keys()]) if (!cardById.has(id)) cleanupCanvasPdf(id);
  if (state.view !== BOARD && state.view !== ARCHIVE && state.view !== WORKS && state.view !== CANVASES && state.view !== STORE && !isCanvas(state.view)) state.view = BOARD;
  if (state.folder && !area(state.folder)) state.folder = null;
  if (state.shelf && area(state.shelf)?.kind !== 'shelf') state.shelf = null;
  if (state.work && area(state.work)?.kind !== 'work') state.work = null;
  state.cats = await db.getMeta('categories', []).catch(() => []);
  state.workCats = await db.getMeta('workCategories', []).catch(() => []);
  if (state.zone !== TRASH && !area(state.zone)) state.zone = fallbackZone() || TRASH;
}
let suppressCollabDepth = 0;
const isCollabSuppressed = () => suppressCollabDepth > 0;
async function changed() {
  invalidateIndexes();
  await db.setMeta('lastChange', Date.now());
  if (!isCollabSuppressed() && !collabSession) channel?.postMessage('changed');
  render();
  refreshStatus();
  if (!isCollabSuppressed()) scheduleCollabSync();
}
async function saveCard(card) {
  card.updatedAt = Date.now();
  await db.put('cards', card);
  if (!isCollabSuppressed()) scheduleCollabSync();
}
async function saveArea(a) {
  if (!isCollabSuppressed() && a?.kind === 'canvas') stampCanvasMutations(a);
  await db.put('columns', a);
  if (!isCollabSuppressed() && a?.kind === 'canvas') scheduleCollabSync();
}

async function ensureDefaults() {
  const add = [];
  if (!columns().length) ['收件箱', '进行中', '已完成'].forEach((title, i) => add.push({ id: uid(), kind: 'column', title, order: i * 1024 }));
  if (!zones().length) {
    add.push({ id: 'materials', kind: 'zone', title: '素材区', order: 0, desc: '常用素材：图片、模板、参考资料，随时拖到看板或画布上使用。' });
    add.push({ id: 'drafts', kind: 'zone', title: '草稿区', order: 1024, desc: '暂时不用的东西放这里，不会丢，随时拖回去。' });
    add.push({ id: 'temp', kind: 'zone', title: '临时文件区', order: 2048, ttlDays: 7, desc: '中转用的临时文件。' });
  }
  if (!canvases().length) add.push({ id: uid(), kind: 'canvas', title: '画布', order: 0 });
  if (!areasOf('shelf').length) add.push({ id: 'store-main', kind: 'shelf', title: '长期保存', order: 0 });
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
const RENAME_BTN = `<button type="button" class="quick-rename-btn" data-action="quick-rename" title="快速重命名（F2 · Tab 连续改下一个）" aria-label="快速重命名"><svg viewBox="0 0 24 24"><path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17v3z"/><path d="m13.5 6.5 3 3"/></svg></button>`;
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
const baseTitle = assoc.baseTitle;
const isActive = (c) => c.columnId !== TRASH && !['folder', 'work', 'shelf'].includes(area(c.columnId)?.kind); // 云仓库里的文件不参与智能关联、长按打包
const SENS = assoc.SENS;
const sensKey = () => (SENS[ls.get('assoc', 'normal')] ? ls.get('assoc', 'normal') : 'normal');
const dismissed = new Set(ls.get('dismissed', []));
const pairKey = assoc.pairKey;
let lastAssocSig = '';

function buildGroups(force = false) {
  ensureIndexes();
  const live = state.cards.filter(isActive);
  const key = sensKey();
  const sig = assoc.computeAssocSignature(live, key, dismissed.size);
  if (!force && sig === lastAssocSig && state.groups) return;
  const res = assoc.buildAssocGroups(live, { sensKey: key, dismissed, cardById });
  state.groups = res.groups;
  state.suggestions = res.suggestions;
  state.suggestOf = res.suggestOf;
  lastAssocSig = sig;
}
const suggestionFor = (id) => { const i = state.suggestOf?.get(id); return i == null ? null : state.suggestions[i]; };
const relatedIds = (id) => state.groups?.get(id) || [id];
const LINK_SVG = `<svg viewBox="0 0 24 24"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>`;
function linkBadge(c) {
  const n = relatedIds(c.id).length;
  let html = n > 1 ? `<span class="link-badge" title="已关联 ${n} 个同项目文件，长按任意一个即可一起打包完成">${LINK_SVG}${n}</span>` : '';
  const sg = suggestionFor(c.id);
  if (sg) {
    const others = sg.ids.length - n;
    html += `<button class="suggest-badge" data-action="accept-suggest" data-id="${c.id}" title="可能和另外 ${others} 个文件属于同一项目（相似度 ${Math.round(sg.score * 100)}%），点一下关联">+${others} 建议</button>`;
  }
  return html;
}
const IS_TOUCH = matchMedia('(hover: none) and (pointer: coarse)').matches;
const CHECK_SVG = `<svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>`;
const selBtn = (c) => `<button class="sel" data-action="select" aria-pressed="${state.selected.has(c.id)}" aria-label="选择 ${esc(c.name || '便签')}" title="选择（Shift + 点击可连续选择）">${CHECK_SVG}</button>`;

const thumbStateOf = (c) => c.kind !== 'file' ? 'none' : (c.thumb || (pv.likelyThumb(c) ? 'pending' : 'none'));
const PLAY = `<span class="play"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" fill="currentColor" stroke="none"/></svg></span>`;
// 优先级：方形印章字标（与「方寸」的方块语言一致），不用圆点
const PRIO = { 1: { t: '急', label: '紧急', c: '#e03131' }, 2: { t: '高', label: '高', c: '#e8590c' }, 3: { t: '低', label: '低', c: '#868e96' } };
const prioTag = (c) => { const p = PRIO[c.prio]; return p ? `<span class="prio" style="--pc:${p.c}" title="优先级：${p.label}">${p.t}</span>` : ''; };
async function setPrio(ids, level) {
  const cards = ids.map(findCard).filter(Boolean);
  cards.forEach((c) => { if (level) c.prio = level; else delete c.prio; c.updatedAt = Date.now(); });
  await db.putMany('cards', cards);
  await changed();
  toast(level ? `已设为「${PRIO[level].label}」优先级${cards.length > 1 ? `（${cards.length} 个）` : ''}` : '已清除优先级');
}
const CARD_HANDLES = ['n', 'e', 's', 'w'].map((k) => `<i class="sh-edge se-${k}" data-card-handle="${k}"></i>`).join('')
  + ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((k) => `<i class="sh-h h-${k}" data-card-handle="${k}"></i>`).join('');
const EXPAND_BTN = (id) => `<button type="button" class="card-expand-btn" data-action="card-preview" data-id="${id}" title="弹窗预览与格式转换（或双击卡片）" aria-label="弹窗预览与格式转换"><svg viewBox="0 0 24 24"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg></button>`;
const pdfDocs = new Map();
const pdfPageUrls = new Map();
const pdfPageWidths = new Map();
const pdfRenderTokens = new Map();
function cleanupCanvasPdf(id) {
  const doc = pdfDocs.get(id);
  if (doc) { Promise.resolve(doc).then((d) => d?.destroy?.()).catch(() => {}); pdfDocs.delete(id); }
  pdfRenderTokens.delete(id);
  for (const [k, url] of pdfPageUrls) {
    if (k.startsWith(`${id}:`)) { URL.revokeObjectURL(url); pdfPageUrls.delete(k); pdfPageWidths.delete(k); }
  }
}
function defaultCanvasCardW(c) {
  if (c.kind === 'file') {
    const fam = pv.family(c);
    if (fam === 'image' || fam === 'pdf') return 360;
    if (c.thumb === 'ok') return 260;
  }
  return CARD_W;
}
const canvasCardW = (c) => Math.max(120, Math.round(c.w || defaultCanvasCardW(c)));
function pickCanvasCard(id) {
  state.pickedCard = id || null;
  $$('#world .card.on-canvas').forEach((el) => el.classList.toggle('picked', el.dataset.id === state.pickedCard));
}

function cardHTML(c, onCanvas = false) {
  const fam = c.kind === 'file' ? pv.family(c) : 'note';
  const isCanvasImg = onCanvas && fam === 'image';
  const isCanvasPdf = onCanvas && fam === 'pdf';
  const cw = onCanvas ? canvasCardW(c) : 0;
  const attrs = onCanvas
    ? `draggable="false" style="left:${Math.round(c.x || 0)}px;top:${Math.round(c.y || 0)}px;width:${cw}px;z-index:${Math.max(1, Math.round(c.order) || 1)}"`
    : `draggable="${IS_TOUCH ? 'false' : 'true'}"`;
  const cls = `card${onCanvas ? ' on-canvas' : ''}${onCanvas && c.locked ? ' locked' : ''}${onCanvas && state.pickedCard === c.id ? ' picked' : ''}${isCanvasImg ? ' canvas-hd-card' : ''}${isCanvasPdf ? ' canvas-pdf-card' : ''}${onCanvas && !matches(c) ? ' dim' : ''}${state.selected.has(c.id) ? ' selected' : ''}${PRIO[c.prio] ? ` prio-${c.prio}` : ''}`;
  const extra = (onCanvas ? HANDLE + EXPAND_BTN(c.id) + (c.locked ? `<i class="lock-badge" title="已锁定">${LOCK_SVG}</i>` : CARD_HANDLES) : '') + (c.columnId !== TRASH ? selBtn(c) + RENAME_BTN : '');
  if (c.kind === 'note') {
    return `<article class="${cls} note" ${attrs} tabindex="0" data-id="${c.id}" aria-label="便签 ${esc(c.name)}">
      <div class="body"><div class="name">${prioTag(c)}${highlight(c.name || '便签')}</div>
      ${c.text ? `<div class="note-text">${highlight(c.text)}</div>` : ''}
      <div class="meta">便签 · ${fmtDate(c.updatedAt || c.createdAt)}${linkBadge(c)}</div></div>${extra}${MORE}</article>`;
  }
  const t = typeOf(c);
  const meta = metaText(c, t) + linkBadge(c);
  const ext = extOf(c.name).slice(0, 5) || t.label;
  const name = `<div class="name" title="${esc(c.name)}&#10;添加于 ${fmtDate(c.createdAt)}">${prioTag(c)}${highlight(c.name)}</div>`;
  const mediaCard = (media) => {
    const body = `<div class="body">${name}<div class="meta">${meta}</div></div>`;
    if (onCanvas) {
      const cardExtra = CARD_HANDLES + (c.columnId !== TRASH ? selBtn(c) : '');
      const actions = `${c.columnId !== TRASH ? RENAME_BTN : ''}${EXPAND_BTN(c.id)}${HANDLE}${MORE}`;
      return `<article class="${cls} has-img" ${attrs} tabindex="0" data-id="${c.id}" aria-label="${esc(c.name)}">
        ${media}<div class="canvas-card-hud">${body}<div class="canvas-card-actions">${actions}</div></div>${cardExtra}</article>`;
    }
    return `<article class="${cls} has-img" ${attrs} tabindex="0" data-id="${c.id}" aria-label="${esc(c.name)}">
      ${media}${body}${extra}${MORE}</article>`;
  };
  if (isCanvasImg) {
    const fullUrl = state.urls.get(c.id);
    const tUrl = state.urls.get(`thumb:${c.id}`);
    const src = fullUrl || tUrl || '';
    return mediaCard(`<div class="thumb fit-cover canvas-img-stage"><img class="thumb-img canvas-hd-img${src ? ' loaded' : ''}" data-canvas-img="${c.id}" ${fullUrl ? 'data-hd-ready="1"' : ''} ${src ? `src="${src}"` : ''} alt="${esc(c.name)}" draggable="false"></div>`);
  }
  if (isCanvasPdf) {
    const doc = pdfDocs.get(c.id);
    const total = c.info?.pages || (doc && typeof doc.numPages === 'number' ? doc.numPages : 0);
    const page = Math.max(1, Math.min(c.pdfPage || 1, total || 9999));
    const hdUrl = pdfPageUrls.get(`${c.id}:${page}`) || (page === 1 ? state.urls.get(`thumb:${c.id}`) : null);
    const badge = `<span class="thumb-badge" style="--c:${t.c}">${esc(ext)}</span>`;
    const nav = `<div class="pdf-page-bar" role="toolbar" aria-label="PDF 翻页">
      <button type="button" class="pdf-nav-btn" data-action="pdf-prev" data-id="${c.id}" ${page <= 1 ? 'disabled' : ''} title="上一页" aria-label="上一页"><svg viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg></button>
      <button type="button" class="pdf-page-num" data-action="pdf-jump" data-id="${c.id}" title="点击输入页码跳转"><b class="pdf-cur">${page}</b><span>/</span><span class="pdf-tot">${total || '…'}</span></button>
      <button type="button" class="pdf-nav-btn" data-action="pdf-next" data-id="${c.id}" ${total && page >= total ? 'disabled' : ''} title="下一页" aria-label="下一页"><svg viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg></button>
    </div>`;
    return mediaCard(`<div class="thumb fit-page canvas-pdf-stage"><img class="thumb-img canvas-pdf-img${hdUrl ? ' loaded' : ''}" data-canvas-pdf="${c.id}" data-page="${page}" ${hdUrl ? `src="${hdUrl}"` : ''} alt="${esc(c.name)} 第 ${page} 页" draggable="false">${badge}${nav}</div>`);
  }
  const st = thumbStateOf(c);
  if (st !== 'none') {
    const badge = t.k === 'image' ? '' : `<span class="thumb-badge" style="--c:${t.c}">${esc(ext)}</span>`;
    const url = state.urls.get(`thumb:${c.id}`);
    const media = st === 'ok'
      ? `<div class="thumb fit-${c.thumbFit || 'cover'}"><img class="thumb-img${url ? ' loaded' : ''}" data-thumb="${c.id}" ${url ? `src="${url}"` : ''} alt="" draggable="false">${t.k === 'video' ? PLAY : ''}${badge}</div>`
      : `<div class="thumb skel" aria-label="正在生成预览">${badge}</div>`;
    return mediaCard(media);
  }
  return `<article class="${cls}" ${attrs} tabindex="0" data-id="${c.id}" aria-label="${esc(c.name)}">
    <div class="type-icon" style="--c:${t.c}">${esc(ext.slice(0, 4))}</div>
    <div class="body">${name}<div class="meta">${meta}</div></div>${extra}${MORE}</article>`;
}
const LIST_PAGE_SIZE = 60;
function listHTML(areaId, emptyText) {
  const list = cardsIn(areaId);
  if (!list.length) return `<div class="empty">${state.query ? '没有匹配的内容' : emptyText}</div>`;
  const limit = state.listLimits.get(areaId) || LIST_PAGE_SIZE;
  const slice = list.length > limit ? list.slice(0, limit) : list;
  const more = list.length > limit
    ? `<button type="button" class="load-more-cards" data-action="load-more-cards" data-area="${esc(areaId)}">已显示 ${slice.length} / ${list.length} 项 · 向下滚动或点击加载更多</button>`
    : '';
  return slice.map((c) => cardHTML(c)).join('') + more;
}
function appendMoreCards(areaId, btnEl) {
  const list = cardsIn(areaId);
  if (!list.length || !btnEl?.isConnected) return;
  const prevLimit = state.listLimits.get(areaId) || LIST_PAGE_SIZE;
  if (prevLimit >= list.length) { btnEl.remove(); return; }
  const nextLimit = Math.min(list.length, prevLimit + LIST_PAGE_SIZE);
  state.listLimits.set(areaId, nextLimit);
  const chunkHTML = list.slice(prevLimit, nextLimit).map((c) => cardHTML(c)).join('');
  btnEl.insertAdjacentHTML('beforebegin', chunkHTML);
  const parent = btnEl.parentElement;
  if (nextLimit >= list.length) btnEl.remove();
  else btnEl.textContent = `已显示 ${nextLimit} / ${list.length} 项 · 向下滚动或点击加载更多`;
  loadThumbs(parent || document);
  queueThumbs();
}

// ---------- 渲染 ----------
const DOTS = `<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>`;
function render() {
  invalidateIndexes();
  ensureIndexes();
  const before = snapshot();
  buildGroups();
  renderViews();
  const onBoard = state.view === BOARD, onArchive = state.view === ARCHIVE, onWorks = state.view === WORKS, onStore = state.view === STORE;
  $('#board').hidden = !onBoard;
  $('#archiveView').hidden = !onArchive;
  $('#worksView').hidden = !onWorks;
  $('#storeView').hidden = !onStore;
  $('#canvasDirectory').hidden = state.view !== CANVASES;
  $('#canvasWorkspace').hidden = !isCanvas(state.view);
  if (onBoard) renderBoard();
  else if (onArchive) renderArchive();
  else if (onWorks) renderWorks();
  else if (onStore) renderStore();
  else if (state.view === CANVASES) renderCanvasDirectory();
  else if (isCanvas(state.view)) {
    const title = area(state.view).title;
    $('#canvasTitle').textContent = title;
    $('#canvasTitle').title = title;
    renderCanvas();
    renderCollabUI();
  }
  renderZones();
  loadThumbs();
  playFlip(before);
  queueThumbs();
  for (const id of state.selected) if (!findCard(id)) state.selected.delete(id);
  document.body.classList.toggle('selecting', state.selected.size > 0);
  renderSelBar();
  renderAssocChip();
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
  if (reduceMotion.matches || state.cards.length > 120) return m;
  const mounted = $$('.card[data-id]');
  if (mounted.length > 60) return m;
  mounted.forEach((el) => { if (el.offsetParent) m.set(el.dataset.id, el.getBoundingClientRect()); });
  return m;
}
function playFlip(before) {
  if (reduceMotion.matches || state.cards.length > 120) { state.fresh.clear(); return; }
  const mounted = $$('.card[data-id]');
  if (mounted.length > 60) { state.fresh.clear(); return; }
  let n = 0;
  mounted.forEach((el) => {
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
  if (!el || !el.offsetParent || reduceMotion.matches || state.cards.length > 120) return;
  await el.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.9)' }], { duration: 170, easing: 'ease-in', fill: 'forwards' }).finished.catch(() => {});
}

// ---------- 缩略图队列（仅当前可视卡片 + 上传期间让出全部 I/O + 批量落盘） ----------
const thumbQ = [], queued = new Set();
let thumbBusy = false;
let uploadDepth = 0;
function visibleThumbCandidates() {
  const seen = new Set();
  const front = [];
  const back = [];
  const pushCard = (c, isFront = true) => {
    if (!c || c.kind !== 'file' || c.thumb || c.columnId === TRASH || queued.has(c.id) || seen.has(c.id)) return;
    seen.add(c.id);
    (isFront ? front : back).push(c.id);
  };
  const takeArea = (areaId, cap = LIST_PAGE_SIZE, isFront = true) => {
    const list = cardsIn(areaId, false);
    const lim = Math.min(list.length, cap);
    for (let i = 0; i < lim; i++) pushCard(list[i], isFront);
  };
  if (state.view === BOARD) {
    for (const col of columns()) takeArea(col.id, state.listLimits.get(col.id) || LIST_PAGE_SIZE, true);
  } else if (state.view === ARCHIVE || (state.view === STORE && openFolder())) {
    const fid = openFolder();
    if (fid) {
      const subs = childFolders(fid);
      for (let i = 0; i < Math.min(subs.length, 60); i++) {
        const dc = deepCards(subs[i].id);
        for (let j = 0; j < Math.min(dc.length, 4); j++) pushCard(dc[j], true);
      }
      takeArea(fid, state.listLimits.get(fid) || LIST_PAGE_SIZE, true);
    } else {
      const roots = rootFolders().filter((f) => !f.stored);
      for (let i = 0; i < Math.min(roots.length, 60); i++) {
        const dc = deepCards(roots[i].id);
        for (let j = 0; j < Math.min(dc.length, 4); j++) pushCard(dc[j], true);
      }
    }
  } else if (state.view === WORKS) {
    const wid = area(state.work)?.kind === 'work' ? state.work : null;
    if (wid) takeArea(wid, state.listLimits.get(wid) || LIST_PAGE_SIZE, true);
    else {
      const ws = works();
      for (let i = 0; i < Math.min(ws.length, 40); i++) takeArea(ws[i].id, 2, true);
    }
  } else if (isCanvas(state.view)) {
    takeArea(state.view, 500, true);
  } else if (state.view === STORE) {
    // 云仓库：打开的文件夹 → 它的文件；首页 → 每个文件夹前 4 个（封面）
    const sid = area(state.shelf)?.kind === 'shelf' ? state.shelf : null;
    if (sid) takeArea(sid, state.listLimits.get(sid) || LIST_PAGE_SIZE, true);
    else {
      for (const s of areasOf('shelf').slice(0, 60)) takeArea(s.id, 4, true);
      for (const f of storedFolders().slice(0, 60)) { const dc = deepCards(f.id); for (let j = 0; j < Math.min(dc.length, 4); j++) pushCard(dc[j], true); }
    }
  }
  const draftsOpen = !draftsCollapsed() || document.body.classList.contains('drafts-open');
  if (draftsOpen && state.zone !== TRASH) {
    takeArea(state.zone, state.listLimits.get(state.zone) || LIST_PAGE_SIZE, false);
  }
  return { front, back };
}
function queueThumbs() {
  if (uploadDepth > 0) return;
  const { front, back } = visibleThumbCandidates();
  for (const id of front) queued.add(id);
  for (const id of back) queued.add(id);
  if (front.length) thumbQ.unshift(...front);
  if (back.length) thumbQ.push(...back);
  if (thumbQ.length) runThumbs();
}
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('超时')), ms))]);
const THUMB_BATCH = 8;
const yieldFrame = () => new Promise((r) => setTimeout(r, 20));
async function runThumbs() {
  if (thumbBusy) return;
  thumbBusy = true;
  const pendingCards = [];
  let collabNeedSync = false;
  const flushCards = async () => {
    if (!pendingCards.length) return;
    const batch = pendingCards.splice(0, pendingCards.length);
    await db.putMany('cards', batch);
    if (collabNeedSync && !isCollabSuppressed()) {
      collabNeedSync = false;
      scheduleCollabSync();
    }
  };
  try {
    while (thumbQ.length) {
      while (uploadDepth > 0) await new Promise((r) => setTimeout(r, 100));
      const id = thumbQ.shift();
      queued.delete(id);
      const c = findCard(id);
      if (!c || c.thumb) continue;
      try {
        const blob = await db.getBlob(id);
        if (!blob) continue;
        const r = await withTimeout(pv.makeThumb(c, blob), 15000);
        if (r?.blob) { await db.putThumb(id, r.blob); c.thumb = 'ok'; c.thumbFit = r.fit; c.info = r.info; }
        else c.thumb = 'none';
      } catch (e) {
        console.warn('预览生成失败', c.name, e);
        // 离线 / 存储文件夹尚未授权：先停，下次再试，不把卡片标记成「无预览」
        if (/组件加载失败/.test(e.message) || e.code === 'NEED_PERMISSION') { thumbQ.length = 0; queued.clear(); break; }
        c.thumb = 'none';
      }
      if (!findCard(id)) continue;
      pendingCards.push(c);
      if (isCanvas(c.columnId)) collabNeedSync = true;
      refreshCard(c);
      if (pendingCards.length >= THUMB_BATCH) await flushCards();
      await yieldFrame();
    }
  } finally {
    await flushCards().catch(() => {});
    thumbBusy = false;
  }
}
// 只替换这一张卡片的 DOM（不整页重绘，不会打断用户点击 / 悬停），周围卡片用 FLIP 平滑让位
function refreshCard(c) {
  const els = $$(`.card[data-id="${CSS.escape(c.id)}"]`);
  if (!els.length) return;
  const skipFlip = state.cards.length > 120 || $$('.card[data-id]').length > 60;
  const before = skipFlip ? null : snapshot();
  for (const el of els) {
    if (el.matches(':active') || el.classList.contains('dragging') || el.classList.contains('lifting')) { renderSoon(); return; }
    const tpl = document.createElement('template');
    tpl.innerHTML = cardHTML(c, el.classList.contains('on-canvas')).trim();
    const next = tpl.content.firstElementChild;
    el.replaceWith(next);
    if (!skipFlip && !reduceMotion.matches) next.animate([{ opacity: 0.4 }, { opacity: 1 }], { duration: 300, easing: 'ease-out' });
  }
  loadThumbs();
  if (before) playFlip(before);
}
const CANVAS_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="3.5" width="17" height="17" rx="2"/><circle cx="9" cy="9" r="1"/><circle cx="15" cy="15" r="1"/><circle cx="15" cy="9" r="1"/><circle cx="9" cy="15" r="1"/></svg>`;
function renderViews() {
  const count = (id) => cardsIn(id, false).length;
  const boardCount = columns().reduce((n, c) => n + count(c.id), 0);
  const unreadCm = unreadCommentCountAll();
  $('#views').innerHTML = `
    <button role="tab" class="view-tab" data-view="${BOARD}" aria-selected="${state.view === BOARD}">
      <svg viewBox="0 0 24 24"><rect x="4" y="4" width="4.5" height="16" rx="1"/><rect x="10" y="4" width="4.5" height="11" rx="1"/><rect x="16" y="4" width="4" height="7" rx="1"/></svg>看板<b>${boardCount}</b></button>
    <button role="tab" class="view-tab archive-tab" data-view="${ARCHIVE}" data-drop="${PICK}" aria-selected="${state.view === ARCHIVE}" title="彻底完成的项目归档在这里；把卡片拖到这里即可归档">
      ${FOLDER_SVG}已完成项目<b>${folders().filter((f) => !isStoredFolder(f)).length}</b></button>
    <button role="tab" class="view-tab store-tab" data-view="${STORE}" data-drop="${esc(shelves()[0]?.id || '')}" aria-selected="${state.view === STORE}" title="云仓库：长期保存的文件，不会被自动清理；把卡片或文件拖到这里即可存入">
      ${STORE_SVG}云仓库<b>${shelfCards().length + storedFolders().reduce((n, f) => n + deepCards(f.id).length, 0)}</b></button>
    <button role="tab" class="view-tab works-tab" data-view="${WORKS}" aria-selected="${state.view === WORKS}" title="个人作品：网站、设计、项目，含更新日志和在线预览">
      ${WORK_SVG}作品<b>${works().length}</b></button>
    <span class="view-sep" aria-hidden="true"></span>
    <button role="tab" class="view-tab canvas-tab" data-view="${CANVASES}" data-drop="${CANVAS_PICK}" aria-selected="${state.view === CANVASES || isCanvas(state.view)}" aria-controls="${isCanvas(state.view) ? 'canvasWorkspace' : 'canvasDirectory'}" title="查看全部画布工作区">
      ${CANVAS_SVG}画布<b>${canvases().length}</b>${unreadCm ? `<span class="tab-unread-badge" title="${unreadCm} 条未读备注">${unreadCm}</span>` : ''}</button>`;
}
function renderCanvasMiniPreview(cv, cards) {
  const layout = cpv.computeCanvasPreviewLayout(cards, cv.shapes || [], cv.links || [], {
    getCardWidth: canvasCardW,
  });
  if (layout.empty) {
    return `<span class="cd-empty-state"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg><span>空白画布</span></span>`;
  }

  const shapesSVG = layout.shapes.map((s) => {
    const col = (s.fill === 'none' || s.fill == null) ? null : (SH_COLORS[s.fill] || SH_COLORS[0]);
    const fill = col ? col.bg : 'none';
    const stroke = col ? col.bd : (s.t === 'text' ? 'none' : 'var(--text-3)');
    const sw = s.t === 'text' ? 0 : (s.frame ? 1 : 0.9);
    const dash = s.frame ? ' stroke-dasharray="3 2"' : '';
    const x = s.x.toFixed(1), y = s.y.toFixed(1), w = s.w.toFixed(1), h = s.h.toFixed(1);
    const cx = (s.x + s.w / 2).toFixed(1), cy = (s.y + s.h / 2).toFixed(1);

    let body = '';
    if (s.t === 'diamond') {
      body = `<polygon points="${cx},${y} ${(s.x + s.w).toFixed(1)},${cy} ${cx},${(s.y + s.h).toFixed(1)} ${x},${cy}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${dash}/>`;
    } else if (s.t === 'ellipse') {
      body = `<ellipse cx="${cx}" cy="${cy}" rx="${(s.w / 2).toFixed(1)}" ry="${(s.h / 2).toFixed(1)}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${dash}/>`;
    } else if (s.t !== 'text') {
      const rx = s.t === 'round' ? Math.min(8, Math.min(s.w, s.h) * 0.22) : (s.t === 'sticky' ? 2.5 : 2);
      body = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx.toFixed(1)}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${dash}/>`;
    }

    let labelSVG = '';
    const rawLine = String(s.text || '').trim().split(/\r?\n/)[0].trim();
    if (rawLine && s.w >= 14 && s.h >= 6) {
      const fs = Math.max(4.5, Math.min(11, s.fs || 6.5));
      const maxChars = Math.max(2, Math.floor((s.w - 4) / Math.max(3.8, fs * 0.65)));
      const label = rawLine.length > maxChars ? `${rawLine.slice(0, maxChars - 1)}…` : rawLine;
      const anchor = s.al === 'left' ? 'start' : 'middle';
      const tx = (s.al === 'left' ? s.x + 3 : s.x + s.w / 2).toFixed(1);
      const topAlign = s.va === 'top' || s.frame;
      const ty = (topAlign ? s.y + fs + 2 : s.y + s.h / 2).toFixed(1);
      const tc = col ? '#1f2023' : 'var(--text)';
      labelSVG = `<text x="${tx}" y="${ty}" fill="${tc}" stroke="none" font-size="${fs.toFixed(1)}" font-weight="${s.b || s.frame ? 700 : 500}" text-anchor="${anchor}" dominant-baseline="${topAlign ? 'auto' : 'central'}">${esc(label)}</text>`;
    }
    return body + labelSVG;
  }).join('');

  const linksSVG = layout.links.map((l) => {
    const stroke = l.color || 'var(--text-2)';
    const dash = l.dash ? ' stroke-dasharray="3 2"' : '';
    const heads = l.heads.map((hd) => `<path d="${hd}" fill="${esc(stroke)}" stroke="none"/>`).join('');
    return `<path d="${l.d}" fill="none" stroke="${esc(stroke)}" stroke-width="1.2" stroke-linecap="round"${dash}/>${heads}`;
  }).join('');

  const cardsHTML = layout.cards.map((c) => {
    const pos = `left:${c.leftPct.toFixed(3)}%;top:${c.topPct.toFixed(3)}%;width:${c.widthPct.toFixed(3)}%;height:${c.heightPct.toFixed(3)}%`;
    if (c.card.kind === 'note') {
      const tx = (c.card.name || c.card.text || '便签').trim().slice(0, 18);
      return `<span class="cd-mini-card is-note" style="${pos}"><span class="cd-mini-note-bar"></span><span class="cd-mini-note-tx">${esc(tx)}</span></span>`;
    }
    const fam = pv.family(c.card);
    const cachedSrc = state.urls.get(`thumb:${c.id}`) || (fam === 'image' ? state.urls.get(c.id) : null) || '';
    if (cachedSrc || c.card.thumb === 'ok') {
      return `<span class="cd-mini-card is-img" style="${pos}"><img class="cd-mini-img${cachedSrc ? ' loaded' : ''}" ${cachedSrc ? `src="${cachedSrc}"` : `data-thumb="${c.id}"`} alt="" draggable="false"></span>`;
    }
    const t = typeOf(c.card);
    return `<span class="cd-mini-card is-file" style="${pos}"><span class="cd-mini-dot" style="--c:${t.c}"></span><span class="cd-mini-file-tx">${esc((c.card.name || '').slice(0, 16))}</span></span>`;
  }).join('');

  return `<svg class="cd-svg" viewBox="0 0 ${layout.width} ${layout.height}" preserveAspectRatio="xMidYMid meet">${shapesSVG}${linksSVG}</svg><span class="cd-cards">${cardsHTML}</span>`;
}
function renderCanvasDirectory() {
  const list = canvases();
  const totalCards = list.reduce((n, cv) => n + cardsIn(cv.id, false).length, 0);
  const totalShapes = list.reduce((n, cv) => n + (cv.shapes?.length || 0), 0);
  const totalComments = list.reduce((n, cv) => n + (cv.comments?.length || 0), 0);
  $('#canvasDirectory').innerHTML = `<header class="archive-head canvas-directory-head">
    <div class="ah-text">
      <h2 id="canvasDirectoryTitle" tabindex="-1">画布工作区</h2>
      <div class="meta">${list.length} 个画布 · ${totalCards} 张卡片${totalShapes ? ` · ${totalShapes} 个白板对象` : ''}${totalComments ? ` · ${totalComments} 条备注` : ''} · 把卡片或文件拖到画布上即可放入</div>
    </div>
    <button type="button" class="btn primary" data-action="add-canvas"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg><span>新建画布</span></button>
    </header>
    <ul class="canvas-directory-list">${list.map((cv) => {
      const cvCards = cardsIn(cv.id, false);
      const isEmpty = !cvCards.length && !(cv.shapes?.length) && !(cv.links?.length);
      return `<li class="canvas-directory-item" data-drop="${esc(cv.id)}">
      <button type="button" class="canvas-directory-open" data-view="${esc(cv.id)}" aria-label="打开画布 ${esc(cv.title)}">
        <span class="cd-stage${isEmpty ? ' is-empty' : ''}" aria-hidden="true">${renderCanvasMiniPreview(cv, cvCards)}</span>
        <span class="canvas-directory-foot">
          <span class="canvas-directory-icon">${CANVAS_SVG}</span>
          <span class="canvas-directory-info">
            <strong>${esc(cv.title)}${collabSession?.canvasId === cv.id ? '<span class="canvas-live-pill">多人协作中</span>' : ''}</strong>
            <span>${cvCards.length} 张卡片${cv.shapes?.length ? ` · ${cv.shapes.length} 个白板对象` : ''}${cv.comments?.length ? ` · ${cv.comments.length} 条备注` : ''}</span>
          </span>
        </span>
      </button>
      <button type="button" class="icon-btn cd-menu-btn" data-action="canvas-menu" data-id="${esc(cv.id)}" aria-label="管理画布 ${esc(cv.title)}" aria-haspopup="menu">${DOTS}</button>
    </li>`;
    }).join('')}
    <li class="canvas-directory-item canvas-directory-add">
      <button type="button" class="canvas-directory-open" data-action="add-canvas" aria-label="新建画布">
        <span class="canvas-directory-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></span>
        <span class="canvas-directory-info">
          <strong>新建画布</strong>
          <span>创建一个新的无限画布工作区</span>
        </span>
      </button>
    </li></ul>`;
  loadThumbs();
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
// ---------- 子文件夹：folder.parentId 指向上级文件夹 ----------
const parentOf = (f) => (f?.parentId && area(f.parentId)?.kind === 'folder' ? area(f.parentId) : null);
const childFolders = (id) => { ensureIndexes(); return childrenByParent.get(id) || []; };
const rootFolders = () => { ensureIndexes(); return childrenByParent.get('') || []; };
function descendantIds(id) {
  ensureIndexes();
  const out = [];
  const stack = [...(childrenByParent.get(id) || [])];
  while (stack.length) {
    const cur = stack.pop();
    out.push(cur.id);
    const kids = childrenByParent.get(cur.id);
    if (kids) for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
  return out;
}
function deepCards(id) {
  ensureIndexes();
  let res = deepCardsMemo.get(id);
  if (!res) {
    res = [id, ...descendantIds(id)].flatMap((x) => cardsIn(x, false));
    deepCardsMemo.set(id, res);
  }
  return res;
}
function folderSize(id) {
  ensureIndexes();
  let s = deepSizeMemo.get(id);
  if (s === undefined) {
    s = deepCards(id).reduce((n, c) => n + (c.size || 0), 0);
    deepSizeMemo.set(id, s);
  }
  return s;
}
function ancestors(f) { const out = []; let p = parentOf(f); while (p && out.length < 50) { out.unshift(p); p = parentOf(p); } return out; }
const folderPath = (f) => [...ancestors(f), f].map((x) => x.title).join(' / ');
function folderMeta(f) {
  const n = deepCards(f.id).length, s = childFolders(f.id).length;
  return `${n} 个文件${s ? ` · ${s} 个子文件夹` : ''} · ${fmtSize(folderSize(f.id))}`;
}
function folderCover(f) {
  const list = deepCards(f.id).slice(0, 4);
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
function folderTile(f) {
  const subs = childFolders(f.id).length;
  return `<div class="folder${subs ? ' has-subs' : ''}" role="button" tabindex="0" draggable="${IS_TOUCH ? 'false' : 'true'}" data-folder="${f.id}" data-drop="${f.id}" style="--fc:${folderColor(f)}" aria-label="项目文件夹 ${esc(f.title)}，${folderMeta(f)}" title="拖到另一个文件夹：上半部分合并，下半部分放进去作为子文件夹">
    <span class="merge-hint" aria-hidden="true">松开合并</span>
    <div class="folder-tab" aria-hidden="true"></div>
    <div class="folder-cover">${folderCover(f)}</div>
    <div class="folder-info"><div class="folder-name">${highlight(f.title)}</div>
      <div class="meta">${folderMeta(f)} · ${fmtDate(f.doneAt || Date.now())}</div></div>
    <button class="more" data-action="folder-menu" data-id="${f.id}" aria-label="文件夹设置" aria-haspopup="menu">${DOTS}</button>
  </div>`;
}
function renderArchive() {
  const el = $('#archiveView');
  const fid = openFolder();
  if (fid) return renderFolderPage(el, fid);
  return renderArchiveRoot(el);
}
// 文件夹详情页：已完成项目和云仓库共用（云仓库里的项目文件夹面包屑根是「云仓库」）
function renderFolderPage(el, fid) {
  {
    const f = area(fid), n = deepCards(fid).length, subs = childFolders(fid);
    const own = cardsIn(fid, false).length;
    const stored = isStoredFolder(f);
    const crumbs = [`<button class="crumb-link" data-goto="" data-folderdrop="">${stored ? '云仓库' : '已完成项目'}</button>`,
      ...ancestors(f).map((a) => `<button class="crumb-link" data-goto="${a.id}" data-folderdrop="${a.id}">${esc(a.title)}</button>`)].join('<span>/</span>') + '<span>/</span>';
    el.innerHTML = `
      <header class="archive-head" style="--fc:${folderColor(f)}">
        <button class="icon-btn back" data-action="folder-back" aria-label="返回上一级"><svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg></button>
        <div class="ah-text">
          <div class="crumb">${crumbs}</div>
          <h2><span class="title-sw" aria-hidden="true"></span>${esc(f.title)}</h2>
          <div class="meta">${folderMeta(f)} · ${stored ? '长期保存 · ' : ''}归档于 ${fmtDate(f.doneAt || Date.now())}</div>
        </div>
        <button class="btn primary" data-action="add-files"><svg viewBox="0 0 24 24"><path d="M12 16V4m0 0-4 4m4-4 4 4"/><path d="M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2"/></svg><span>上传文件 / 文件夹</span></button>
        <button class="btn" data-action="batch-rename-folder" ${own ? '' : 'disabled'} title="逐张预览或按序号一键批量重命名当前文件夹内的文件（F2）"><svg viewBox="0 0 24 24"><path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17v3z"/><path d="m13.5 6.5 3 3"/></svg><span>快速重命名</span></button>
        <button class="btn" data-action="add-subfolder"><svg viewBox="0 0 24 24"><path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><path d="M12 11v5M9.5 13.5h5"/></svg><span>新建子文件夹</span></button>
        <button class="btn" data-action="folder-zip" ${n ? '' : 'disabled'}><svg viewBox="0 0 24 24"><path d="M12 4v11m0 0-4-4m4 4 4-4"/><path d="M5 19h14"/></svg><span>打包下载</span></button>
        <button class="btn${activeShare?.area.id === fid ? ' on' : ''}" data-action="area-share" data-id="${fid}" ${n ? '' : 'disabled'} title="生成链接，对方打开即可直接从这台电脑下载">${SHARE_SVG}<span>${activeShare?.area.id === fid ? '分享中' : '分享'}</span></button>
        <button class="icon-btn" data-action="folder-menu" aria-label="文件夹设置" aria-haspopup="menu">${DOTS}</button>
      </header>
      ${subs.length ? `<section class="cat-sec"><h3 class="cat-h"><span>子文件夹</span><b>${subs.length}</b></h3><div class="folder-grid">${subs.map(folderTile).join('')}</div></section>` : ''}
      <section class="cat-sec"><h3 class="cat-h"><span>文件</span><b>${own}</b></h3>
      <div class="list folder-list" data-col="${fid}">${listHTML(fid, subs.length ? '把卡片拖到这里，或拖到上面的子文件夹里' : '把卡片或文件拖到这里归档；也可以「新建子文件夹」再细分')}</div></section>`;
  }
}
function renderArchiveRoot(el) {
  const q = state.query.toLowerCase();
  // 顶层只显示根文件夹（移进云仓库的不算）；搜索时子文件夹里的名称 / 文件命中也算
  const all = rootFolders().filter((f) => !f.stored).filter((f) => !q || [f, ...descendantIds(f.id).map(area)].some((x) => x.title.toLowerCase().includes(q) || cardsIn(x.id).length));
  const cats = allCats();
  const cur = state.archCat === '__none' || cats.includes(state.archCat) ? state.archCat : 'all';
  const inCat = (name) => all.filter((f) => (name === '__none' ? !f.category || !cats.includes(f.category) : f.category === name));
  const grid = (list) => `<div class="folder-grid">${list.map(folderTile).join('')}</div>`;
  const uncategorized = inCat('__none');
  const chip = (key, label, n, drop) => `<button class="cat-chip" role="tab" aria-selected="${cur === key}" data-cat="${esc(key)}" ${drop != null ? `data-catdrop="${esc(drop)}"` : ''}>${esc(label)}<b>${n}</b></button>`;
  const bar = folders().length ? `<div class="cat-bar" role="tablist" aria-label="分类">
      ${chip('all', '全部', all.length)}
      ${cats.map((c) => chip(c, c, inCat(c).length, c)).join('')}
      ${cats.length ? chip('__none', '未分类', uncategorized.length, '') : ''}
      <button class="cat-add" data-action="cat-add" title="新建分类，然后把文件夹拖到分类上">+ 分类</button>
    </div>` : '';
  let body;
  if (!all.length) body = `<div class="archive-empty">${FOLDER_SVG}<b>${state.query ? '没有匹配的项目' : '还没有已完成的项目'}</b><span>${state.query ? '' : '回到看板，长按一个做完的文件 —— 它和同项目的文件会被自动打包送到这里。'}</span></div>`;
  else if (cur !== 'all') body = inCat(cur).length ? grid(inCat(cur)) : `<div class="archive-empty slim"><b>这个分类还是空的</b><span>把文件夹拖到上方的「${esc(cur === '__none' ? '未分类' : cur)}」标签上，或在文件夹菜单里选择分类。</span></div>`;
  else if (!cats.length) body = grid(all);
  else body = [...cats, '__none'].map((c) => { const list = inCat(c); return list.length ? `<section class="cat-sec"><h3 class="cat-h"><span>${esc(c === '__none' ? '未分类' : c)}</span><b>${list.length}</b></h3>${grid(list)}</section>` : ''; }).join('');
  el.innerHTML = `
    <header class="archive-head">
      <div class="ah-text">
        <h2>已完成项目</h2>
        <div class="meta">在看板上<b>长按任意卡片</b>即可完成项目：同名的关联文件会自动打包成文件夹放到这里。文件夹可以拖到分类上归类，拖到另一个文件夹上合并。</div>
      </div>
      <button class="btn" data-action="add-files"><svg viewBox="0 0 24 24"><path d="M12 16V4m0 0-4 4m4-4 4 4"/><path d="M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2"/></svg><span>上传文件 / 文件夹</span></button>
      <button class="btn primary" data-action="add-folder"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg><span>新建项目文件夹</span></button>
    </header>
    ${bar}${body}`;
}
// ---------- 云仓库：本机长期保存的文件 ----------
// 区域 kind = 'shelf'，每个是一个仓库文件夹；不会被自动清理，不参与智能关联 / 长按打包，删除前会再确认一次
const STORE_SVG = `<svg viewBox="0 0 24 24"><path d="M7 18.5a4.5 4.5 0 0 1-.7-8.95A6 6 0 0 1 17.8 8a4.25 4.25 0 0 1-.3 8.5"/><path d="M9 15.5h6v4H9z"/><path d="M12 15.5v-3"/></svg>`;
const shelves = () => areasOf('shelf');
const openShelf = () => (state.view === STORE && area(state.shelf)?.kind === 'shelf' ? state.shelf : null);
const shelfCards = () => shelves().flatMap((s) => cardsIn(s.id, false));
const shelfColor = (s) => FCOLORS[(s.color ?? Math.max(0, shelves().indexOf(s)) + 1) % FCOLORS.length].c;
const storedFolders = () => rootFolders().filter((f) => f.stored);
const inStore = (c) => { const a = area(c?.columnId); return a?.kind === 'shelf' || isStoredFolder(a); };
// 已完成项目 ⇄ 云仓库：整个文件夹（连同子文件夹和全部文件）一起移动，可撤销
async function setFolderStored(f, on) {
  if (!f || f.kind !== 'folder') return;
  const prevParent = f.parentId, prevStored = !!f.stored;
  if (on) { delete f.parentId; f.stored = true; } else delete f.stored;
  if ((prevParent || null) === (f.parentId || null) && prevStored === !!f.stored) return;
  await saveArea(f);
  if (state.folder === f.id || descendantIds(f.id).includes(state.folder)) { state.folder = null; ls.set('folder', null); }
  await changed();
  const tab = $(on ? '.store-tab' : '.archive-tab');
  if (tab && !reduceMotion.matches) tab.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.14)', offset: 0.35 }, { transform: 'scale(1)' }], { duration: 480, easing: 'ease-out' });
  toast(on ? `「${f.title}」已移到云仓库（${deepCards(f.id).length} 个文件）` : `「${f.title}」已移回已完成项目`, {
    action: '撤销', onAction: async () => {
      if (prevParent) f.parentId = prevParent; else delete f.parentId;
      if (prevStored) f.stored = true; else delete f.stored;
      await saveArea(f); await changed();
    },
  });
}
function shelfTile(s) {
  const list = cardsIn(s.id, false), size = list.reduce((n, c) => n + (c.size || 0), 0);
  return `<div class="folder shelf" role="button" tabindex="0" data-shelf="${s.id}" data-drop="${s.id}" style="--fc:${shelfColor(s)}" aria-label="云仓库文件夹 ${esc(s.title)}，${list.length} 个文件" title="点开查看；把卡片或文件拖到这里即可存入">
    <div class="folder-tab" aria-hidden="true"></div>
    <div class="folder-cover">${list.length ? folderCover(s) : `<div class="cover-empty">${STORE_SVG}</div>`}</div>
    <div class="folder-info"><div class="folder-name">${highlight(s.title)}</div>
      <div class="meta">${list.length} 个文件 · ${fmtSize(size)}</div></div>
    <button class="more" data-action="shelf-menu" data-id="${s.id}" aria-label="仓库文件夹设置" aria-haspopup="menu">${DOTS}</button>
  </div>`;
}
function renderStore() {
  const el = $('#storeView');
  const UPLOAD = `<svg viewBox="0 0 24 24"><path d="M12 16V4m0 0-4 4m4-4 4 4"/><path d="M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2"/></svg>`;
  const fid = openFolder(); // 从已完成项目移过来的项目文件夹
  if (fid) return renderFolderPage(el, fid);
  const sid = openShelf();
  if (sid) {
    const s = area(sid), list = cardsIn(sid, false), size = list.reduce((n, c) => n + (c.size || 0), 0);
    el.innerHTML = `
      <header class="archive-head" style="--fc:${shelfColor(s)}">
        <button class="icon-btn back" data-action="shelf-back" aria-label="返回云仓库"><svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg></button>
        <div class="ah-text">
          <div class="crumb"><button class="crumb-link" data-action="shelf-back">云仓库</button><span>/</span></div>
          <h2><span class="title-sw" aria-hidden="true"></span>${esc(s.title)}</h2>
          <div class="meta">${list.length} 个文件 · ${fmtSize(size)} · 长期保存，不会被自动清理</div>
        </div>
        <button class="btn primary" data-action="add-files">${UPLOAD}<span>存入文件</span></button>
        <button class="btn" data-action="shelf-zip" data-id="${sid}" ${list.length ? '' : 'disabled'}><svg viewBox="0 0 24 24"><path d="M12 4v11m0 0-4-4m4 4 4-4"/><path d="M5 19h14"/></svg><span>打包下载</span></button>
        <button class="btn${activeShare?.area.id === sid ? ' on' : ''}" data-action="area-share" data-id="${sid}" ${list.length ? '' : 'disabled'} title="生成链接，对方打开即可直接从这台电脑下载">${SHARE_SVG}<span>${activeShare?.area.id === sid ? '分享中' : '分享'}</span></button>
        <button class="icon-btn" data-action="shelf-menu" data-id="${sid}" aria-label="仓库文件夹设置" aria-haspopup="menu">${DOTS}</button>
      </header>
      <div class="list folder-list store-list" data-col="${sid}">${listHTML(sid, '把文件或卡片拖到这里长期保存；也可以点右上角「存入文件」')}</div>`;
    return;
  }
  const q = state.query.toLowerCase();
  const list = shelves().filter((s) => !q || s.title.toLowerCase().includes(q) || cardsIn(s.id).length);
  const projs = storedFolders().filter((f) => !q || [f, ...descendantIds(f.id).map(area)].some((x) => x.title.toLowerCase().includes(q) || cardsIn(x.id).length));
  const all = [...shelfCards(), ...storedFolders().flatMap((f) => deepCards(f.id))], size = all.reduce((n, c) => n + (c.size || 0), 0);
  el.innerHTML = `
    <header class="archive-head">
      <div class="ah-text">
        <h2>云仓库</h2>
        <div class="meta">${all.length} 个文件 · ${fmtSize(size)} · 专门放要<b>长期保存</b>的文件：不会被自动清理，删除前会再确认一次。把卡片或文件拖到文件夹（或顶部「云仓库」标签）上即可存入。</div>
      </div>
      <button class="btn" data-action="add-files">${UPLOAD}<span>存入文件</span></button>
      <button class="btn primary" data-action="add-shelf"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg><span>新建文件夹</span></button>
    </header>
    ${list.length || projs.length
      // 项目文件夹和仓库文件夹放在同一个网格里，不再分成两块；有内容的排前面，空的默认文件夹排最后
      ? `<div class="folder-grid">${[...projs.map(folderTile), ...list.filter((s) => cardsIn(s.id, false).length).map(shelfTile), ...list.filter((s) => !cardsIn(s.id, false).length).map(shelfTile)].join('')}</div>`
      : `<div class="archive-empty slim"><b>没有匹配的文件夹</b></div>`}
    ${!q && !projs.length && rootFolders().length ? `<div class="store-hint">提示：在「已完成项目」里把项目文件夹拖到顶部「云仓库」标签上（或在文件夹菜单里选「移到云仓库」），整个项目连同子文件夹会一起移过来。</div>` : ''}`;
}
// 从云仓库删除文件：再确认一次（几秒内的连续删除只问一次）
let storeDeleteOkAt = 0;
async function confirmStoreDelete(cards) {
  const list = cards.filter(inStore);
  if (!list.length || Date.now() - storeDeleteOkAt < 4000) return true;
  const ok = await confirmBox({
    title: list.length > 1 ? `从云仓库删除 ${list.length} 个文件？` : `从云仓库删除「${list[0].name}」？`,
    body: '云仓库里是长期保存的文件。删除后会先进回收站，在回收站里仍可恢复。',
    ok: '删除', danger: true,
  });
  if (ok) storeDeleteOkAt = Date.now();
  return ok;
}

// ---------- 文件夹颜色与分类 ----------
const FCOLORS = [
  { n: '苔绿', c: '#37b24d' }, { n: '靛蓝', c: '#4c6ef5' }, { n: '赭橙', c: '#f76707' }, { n: '玫红', c: '#e64980' },
  { n: '葡萄紫', c: '#7950f2' }, { n: '青碧', c: '#1098ad' }, { n: '琥珀', c: '#f59f00' }, { n: '石墨', c: '#868e96' },
];
// 没手动选过颜色的文件夹按排列顺序轮流取色，相邻的不会撞色
const folderColor = (f) => FCOLORS[(f.color ?? Math.max(0, folders().indexOf(f))) % FCOLORS.length].c;
const allCats = () => [...new Set([...(state.cats || []), ...folders().map((f) => f.category).filter(Boolean)])];
async function saveCats() { await db.setMeta('categories', state.cats || []); }
async function addCategory(thenAssign) {
  const name = await prompt({ title: '新建分类', placeholder: '例如：宣传物料、课程资料、客户交付', ok: '创建' });
  if (!name) return null;
  state.cats = [...new Set([...(state.cats || []), name])];
  await saveCats();
  if (thenAssign) await setFolderCat(thenAssign, name);
  else { await changed(); toast(`已新建分类「${name}」，把文件夹拖到它上面即可归类`); }
  return name;
}
async function setFolderCat(f, name) {
  const prev = f.category;
  if (name) f.category = name; else delete f.category;
  await saveArea(f);
  await changed();
  const el = $(`.folder[data-folder="${CSS.escape(f.id)}"]`);
  el?.classList.add('merged'); setTimeout(() => el?.classList.remove('merged'), 1200);
  toast(name ? `「${f.title}」已归入「${name}」` : `「${f.title}」已移出分类`, { action: '撤销', onAction: async () => { if (prev) f.category = prev; else delete f.category; await saveArea(f); await changed(); } });
}
async function renameCategory(old) {
  const name = await prompt({ title: '重命名分类', value: old, ok: '保存' });
  if (!name || name === old) return;
  state.cats = (state.cats || []).map((c) => (c === old ? name : c));
  if (!state.cats.includes(name)) state.cats.push(name);
  const fs = folders().filter((f) => f.category === old);
  fs.forEach((f) => { f.category = name; });
  await db.putMany('columns', fs);
  await saveCats();
  if (state.archCat === old) { state.archCat = name; ls.set('archCat', name); }
  await changed();
}
async function deleteCategory(name) {
  const fs = folders().filter((f) => f.category === name);
  if (!(await confirmBox({ title: `删除分类「${name}」？`, body: fs.length ? `里面的 ${fs.length} 个文件夹会变成「未分类」，文件夹和文件都不会删除。` : '这个分类是空的。', ok: '删除分类', danger: true }))) return;
  fs.forEach((f) => { delete f.category; });
  if (fs.length) await db.putMany('columns', fs);
  state.cats = (state.cats || []).filter((c) => c !== name);
  await saveCats();
  if (state.archCat === name) { state.archCat = 'all'; ls.set('archCat', 'all'); }
  await changed();
}
document.addEventListener('contextmenu', (e) => {
  const chipEl = e.target.closest?.('.cat-chip[data-catdrop]');
  if (!chipEl || !chipEl.dataset.catdrop) return;
  e.preventDefault();
  const name = chipEl.dataset.catdrop;
  openMenu(chipEl, [{ text: '重命名分类', run: () => renameCategory(name) }, '-', { text: '删除分类', danger: true, run: () => deleteCategory(name) }]);
});
// ---------- 文件夹合并：拖一个文件夹到另一个上 ----------
function mergedTitle(a, b) {
  let p = '';
  while (p.length < Math.min(a.length, b.length) && a[p.length] === b[p.length]) p += a[p.length];
  p = p.replace(new RegExp(`${SEP}+$`), '');
  return p.length >= 2 ? p : a; // 没有足够的公共部分时保留目标文件夹的名字
}
// 飞入动画：源文件夹飞进目标，目标弹一下
async function flyInto(sEl, dEl) {
  if (!sEl || !dEl || reduceMotion.matches) return;
  const a = sEl.getBoundingClientRect(), b = dEl.getBoundingClientRect();
  const dx = b.left + b.width / 2 - (a.left + a.width / 2), dy = b.top + b.height / 2 - (a.top + a.height / 2);
  dEl.classList.add('merge-open');
  sEl.style.zIndex = '5';
  await sEl.animate([
    { transform: 'none', opacity: 1 },
    { transform: `translate(${dx * 0.8}px, ${dy * 0.8 - 46}px) scale(.62) rotate(${dx > 0 ? 8 : -8}deg)`, opacity: 1, offset: 0.6 },
    { transform: `translate(${dx}px, ${dy + 10}px) scale(.2)`, opacity: 0 },
  ], { duration: 620, easing: 'cubic-bezier(.45,0,.25,1)', fill: 'forwards' }).finished.catch(() => {});
  await dEl.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.07)', offset: 0.35 }, { transform: 'scale(.97)', offset: 0.7 }, { transform: 'scale(1)' }],
    { duration: 420, easing: 'ease-out' }).finished.catch(() => {});
}
// 把文件夹放进另一个文件夹（dstId 为空 = 移到顶层）
async function nestFolder(srcId, dstId, dEl) {
  const src = area(srcId), dst = dstId ? area(dstId) : null;
  if (!src || src === dst) return;
  if (dst && descendantIds(srcId).includes(dstId)) return toast('不能把文件夹放进它自己的子文件夹里', { error: true });
  const prevParent = src.parentId, prevStored = !!src.stored, wasStored = isStoredFolder(src);
  if ((prevParent || null) === (dstId || null)) return;
  await flyInto($(`.folder[data-folder="${CSS.escape(srcId)}"]`), dEl || (dstId && $(`.folder[data-folder="${CSS.escape(dstId)}"]`)));
  if (dstId) { src.parentId = dstId; delete src.stored; } // 放进别的文件夹：跟着新上级走
  else { delete src.parentId; if (wasStored) src.stored = true; } // 移到顶层：留在原来所在的那一边
  await saveArea(src);
  await changed();
  toast(dst ? `「${src.title}」已放进「${dst.title}」` : `「${src.title}」已移到顶层`, {
    action: '撤销', onAction: async () => { if (prevParent) src.parentId = prevParent; else delete src.parentId; if (prevStored) src.stored = true; else delete src.stored; await saveArea(src); await changed(); },
  });
}
async function mergeFolders(srcId, dstId) {
  const src = area(srcId), dst = area(dstId);
  if (!src || !dst || src === dst) return;
  if (descendantIds(srcId).includes(dstId)) return toast('不能把文件夹合并进它自己的子文件夹', { error: true });
  const cards = cardsIn(srcId, false);
  const kids = childFolders(srcId);
  const prev = { dstTitle: dst.title, cards: cards.map((c) => ({ c, columnId: c.columnId, order: c.order })), kids };
  const title = mergedTitle(dst.title, src.title);
  await flyInto($(`.folder[data-folder="${CSS.escape(srcId)}"]`), $(`.folder[data-folder="${CSS.escape(dstId)}"]`));
  // 数据：卡片并入目标（排在后面），子文件夹一起搬过去，删除源文件夹
  let order = orderAt(dstId, cardsIn(dstId, false).length);
  for (const c of cards) { c.columnId = dstId; c.order = order; order += 1024; c.updatedAt = Date.now(); }
  if (cards.length) await db.putMany('cards', cards);
  kids.forEach((k) => { k.parentId = dstId; });
  if (kids.length) await db.putMany('columns', kids);
  dst.title = title;
  dst.doneAt = Math.max(dst.doneAt || 0, src.doneAt || 0);
  await saveArea(dst);
  await db.del('columns', srcId);
  state.areas = state.areas.filter((x) => x !== src);
  if (state.folder === srcId) { state.folder = dstId; ls.set('folder', dstId); }
  await changed();
  const nEl = $(`.folder[data-folder="${CSS.escape(dstId)}"]`);
  if (nEl && !reduceMotion.matches) {
    nEl.classList.add('merged');
    setTimeout(() => nEl.classList.remove('merged'), 1400);
  }
  toast(`已合并为「${title}」，共 ${cardsIn(dstId, false).length} 个文件`, {
    action: '撤销', onAction: async () => {
      await saveArea(src);
      state.areas.push(src);
      prev.cards.forEach((p) => Object.assign(p.c, { columnId: p.columnId, order: p.order }));
      if (prev.cards.length) await db.putMany('cards', prev.cards.map((p) => p.c));
      prev.kids.forEach((k) => { k.parentId = srcId; });
      if (prev.kids.length) await db.putMany('columns', prev.kids);
      dst.title = prev.dstTitle;
      await saveArea(dst);
      await changed();
    },
  });
}
let dragFolder = null;
// 拖文件夹到顶部标签：未入库的 → 「云仓库」，云仓库里的 → 「已完成项目」；还有云仓库首页的仓库文件夹也能接住项目文件夹
function folderSideTab(target) {
  const f = area(dragFolder);
  if (!f) return null;
  const stored = isStoredFolder(f);
  const tab = target.closest?.('.view-tab.store-tab, .view-tab.archive-tab');
  if (tab) return tab.classList.contains('store-tab') !== stored ? tab : null;
  return null;
}
document.addEventListener('dragstart', (e) => {
  const f = e.target.closest?.('.folder[data-folder]');
  if (!f || e.target.closest('.card')) return;
  dragFolder = f.dataset.folder;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('application/x-workbench-folder', dragFolder);
  requestAnimationFrame(() => f.classList.add('folder-dragging'));
  document.body.classList.add('dragging-folder');
});
// 拖到文件夹上：上半部分 = 合并，下半部分 = 放进去作为子文件夹
const dropMode = (t, y) => { const r = t.getBoundingClientRect(); return y < r.top + r.height * 0.5 ? 'merge' : 'nest'; };
document.addEventListener('dragover', (e) => {
  if (!dragFolder) return;
  const t = e.target.closest?.('.folder[data-folder]');
  const chipEl = e.target.closest?.('.cat-chip[data-catdrop]');
  const crumb = e.target.closest?.('[data-folderdrop]');
  const sideTab = folderSideTab(e.target);
  $$('.folder.merge-target').forEach((el) => { if (el !== t) el.classList.remove('merge-target', 'nest-mode'); });
  $$('.cat-chip.drop-active, .crumb-link.drop-active, .view-tab.folder-drop').forEach((el) => { if (el !== chipEl && el !== crumb && el !== sideTab) el.classList.remove('drop-active', 'folder-drop'); });
  if (sideTab) { e.preventDefault(); e.stopImmediatePropagation(); e.dataTransfer.dropEffect = 'move'; sideTab.classList.add('drop-active', 'folder-drop'); return; }
  if (chipEl && !parentOf(area(dragFolder))) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; chipEl.classList.add('drop-active'); return; }
  if (crumb) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; crumb.classList.add('drop-active'); return; }
  if (!t || t.dataset.folder === dragFolder) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const nest = dropMode(t, e.clientY) === 'nest';
  t.classList.add('merge-target');
  t.classList.toggle('nest-mode', nest);
  const hint = t.querySelector('.merge-hint');
  if (hint) hint.textContent = nest ? '松开放进去' : '松开合并';
});
document.addEventListener('drop', (e) => {
  if (!dragFolder) return;
  const src = dragFolder;
  const sideTab = folderSideTab(e.target);
  if (sideTab) { e.preventDefault(); e.stopImmediatePropagation(); sideTab.classList.remove('drop-active', 'folder-drop'); return setFolderStored(area(src), sideTab.classList.contains('store-tab')); }
  const chipEl = e.target.closest?.('.cat-chip[data-catdrop]');
  if (chipEl && !parentOf(area(src))) { e.preventDefault(); const f = area(src); if (f) setFolderCat(f, chipEl.dataset.catdrop || null); return; }
  const crumb = e.target.closest?.('[data-folderdrop]');
  if (crumb) { e.preventDefault(); return nestFolder(src, crumb.dataset.folderdrop || null, crumb); }
  const t = e.target.closest?.('.folder[data-folder]');
  if (t && t.dataset.folder !== src) {
    e.preventDefault();
    if (dropMode(t, e.clientY) === 'nest') nestFolder(src, t.dataset.folder, t); else mergeFolders(src, t.dataset.folder);
  }
});
document.addEventListener('dragend', () => {
  if (!dragFolder) return;
  dragFolder = null;
  document.body.classList.remove('dragging-folder');
  $$('.folder-dragging, .merge-target, .cat-chip.drop-active, .crumb-link.drop-active, .view-tab.folder-drop').forEach((el) => el.classList.remove('folder-dragging', 'merge-target', 'nest-mode', 'drop-active', 'folder-drop'));
});

async function addSubfolder(parentId) {
  const parent = area(parentId);
  if (!parent) return;
  const title = await prompt({ title: `在「${parent.title}」里新建子文件夹`, placeholder: '例如：设计源文件、导出成品、客户反馈', ok: '创建' });
  if (!title) return;
  const f = await createFolder(title, parentId);
  state.fresh.add(f.id);
  await changed();
  const el = $(`.folder[data-folder="${CSS.escape(f.id)}"]`);
  if (el && !reduceMotion.matches) el.animate([{ opacity: 0, transform: 'translateY(10px) scale(.94)' }, { opacity: 1, transform: 'none' }], { duration: 380, easing: 'cubic-bezier(.2,.8,.2,1)' });
}
async function createFolder(title, parentId) {
  const list = folders();
  const f = { id: uid(), kind: 'folder', title, order: list.length ? list[list.length - 1].order + 1024 : 0, doneAt: Date.now(), color: list.length % FCOLORS.length };
  if (parentId) f.parentId = parentId;
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
    <div class="pick-list">${fs.map((f, i) => `<label class="pick"><input type="radio" name="f" value="${f.id}" ${i === 0 ? 'checked' : ''}><span>${esc(folderPath(f))}</span><small>${cardsIn(f.id, false).length} 个文件</small></label>`).join('')}
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
  if (!(await ensureAccess())) return;
  const cards = deepCards(f.id);
  if (!cards.length) return toast('文件夹是空的');
  const t = toast('正在准备文件…', { sticky: true });
  try {
    const used = new Set();
    const clean = (s) => String(s).replace(/[\\/:*?"<>|]/g, '_');
    // 保留子文件夹结构：zip 里的路径 = 相对当前文件夹的子文件夹路径
    const rel = (folderId) => { const out = []; let x = area(folderId); while (x && x.id !== f.id) { out.unshift(clean(x.title)); x = parentOf(x); } return out.length ? `${out.join('/')}/` : ''; };
    const mapped = cards.map((c) => {
      const raw = rel(c.columnId) + clean(c.kind === 'note' ? `${c.name || '便签'}.txt` : c.name);
      let name = raw, i = 2;
      while (used.has(name)) name = raw.replace(/(\.[^./]*)?$/, ` (${i++})$1`);
      used.add(name);
      return { card: c, name };
    });
    const fileCards = mapped.filter((x) => x.card.kind !== 'note');
    let lastTick = 0;
    const blobs = await db.getBlobsBatch(fileCards.map((x) => x.card.id), {
      onProgress: ({ done, total, bytesDone }) => {
        const now = performance.now();
        if (done === total || now - lastTick >= 80) {
          lastTick = now;
          t.set(`正在读取文件 ${done}/${total}${bytesDone ? `（${fmtSize(bytesDone)}）` : ''}…`);
        }
      },
    });
    const entries = [];
    for (const { card: c, name } of mapped) {
      if (c.kind === 'note') {
        entries.push({ name, data: c.text || '' });
      } else {
        const data = blobs.get(c.id);
        if (data != null) entries.push({ name, size: data.size, data });
      }
    }
    if (!entries.length) {
      t.close();
      return toast('没有可打包的文件内容', { error: true });
    }
    lastTick = 0;
    const blob = await zip.buildStoreZip(entries, {
      onProgress: ({ done, total, bytesDone, bytesTotal }) => {
        const now = performance.now();
        if (done === total || now - lastTick >= 80) {
          lastTick = now;
          const pct = bytesTotal ? Math.min(100, Math.round((bytesDone / bytesTotal) * 100)) : Math.round((done / Math.max(1, total)) * 100);
          t.set(`正在打包 ${done}/${total}（${pct}%${bytesTotal ? ` · ${fmtSize(bytesDone)} / ${fmtSize(bytesTotal)}` : ''}）…`);
        }
      },
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${f.title.replace(/[\\/:*?"<>|]/g, '_')}.zip`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    t.close();
    toast(`已打包 ${entries.length} 个文件（${fmtSize(blob.size)}）`);
  } catch (e) {
    t.close();
    toast(`打包失败：${e.message || e}`, { error: true });
  }
}

// ---------- 分享链接：对方打开链接直接从这台电脑下载（浏览器直连，不上传到任何服务器） ----------
const SHARE_SVG = '<svg viewBox="0 0 24 24"><circle cx="18" cy="5" r="2.6"/><circle cx="6" cy="12" r="2.6"/><circle cx="18" cy="19" r="2.6"/><path d="m8.3 10.8 7.4-4.4M8.3 13.2l7.4 4.4"/></svg>';
let activeShare = null; // { host, area, url, files }
const shareUrl = (id) => { const u = new URL(location.href); u.search = ''; u.hash = ''; u.searchParams.set('share', id); return u.toString(); };
function shareFilesOf(f) {
  const clean = (s) => String(s).replace(/[\\/:*?"<>|]/g, '_');
  const rel = (folderId) => { const out = []; let x = area(folderId); while (x && x.id !== f.id) { out.unshift(clean(x.title)); x = parentOf(x); } return out.length ? `${out.join('/')}/` : ''; };
  const used = new Set();
  return deepCards(f.id).map((c) => {
    const raw = rel(c.columnId) + clean(c.kind === 'note' ? `${c.name || '便签'}.txt` : c.name);
    let name = raw, i = 2;
    while (used.has(name)) name = raw.replace(/(\.[^./]*)?$/, ` (${i++})$1`);
    used.add(name);
    return { card: c, name, size: c.kind === 'note' ? new Blob([c.text || '']).size : (c.size || 0), type: c.kind === 'note' ? 'text/plain' : (c.type || '') };
  });
}
async function startShare(f) {
  if (!f) return;
  if (activeShare && activeShare.area.id === f.id) return renderSharePanel();
  if (!(await ensureAccess())) return;
  const files = shareFilesOf(f);
  if (!files.length) return toast('文件夹是空的，没有可以分享的文件');
  if (activeShare) {
    const ok = await confirmBox({ title: '换成分享这个文件夹？', body: `正在分享「${activeShare.area.title}」，同一时间只能分享一个文件夹。继续会停止之前的分享，旧链接随即失效。`, ok: '换成这个' });
    if (!ok) return;
    stopShare(true);
  }
  const id = share.newShareId();
  const host = new share.ShareHost({
    id, title: f.title,
    files: files.map(({ name, size, type }) => ({ name, size, type })),
    getFile: async (i) => { const it = files[i]; return it.card.kind === 'note' ? (it.card.text || '') : db.getBlob(it.card.id); },
    onStatus: () => renderSharePanel(),
  });
  activeShare = { host, area: f, url: shareUrl(id), files, total: files.reduce((n, x) => n + x.size, 0) };
  renderSharePanel();
  await host.start();
  try { await navigator.clipboard.writeText(activeShare.url); toast('分享链接已复制，发给对方打开即可下载'); } catch {}
}
function stopShare(quiet) {
  if (!activeShare) return;
  activeShare.host.stop();
  activeShare = null;
  $('#sharePanel')?.remove();
  if (!quiet) toast('已停止分享，链接已失效');
}
window.addEventListener('beforeunload', (e) => { if (activeShare?.host.conns.size) { e.preventDefault(); e.returnValue = ''; } });
function renderSharePanel() {
  if (!activeShare) return;
  let el = $('#sharePanel');
  if (!el) {
    el = document.createElement('aside');
    el.id = 'sharePanel'; el.className = 'share-panel'; el.setAttribute('aria-label', '文件夹分享');
    document.body.appendChild(el);
    el.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-share-act]')?.dataset.shareAct;
      if (!act || !activeShare) return;
      if (act === 'copy') copyTextWithToast(activeShare.url, '分享链接已复制');
      if (act === 'stop') stopShare();
      if (act === 'min') { el.classList.toggle('min'); }
    });
  }
  const { host, area: f, url, files, total } = activeShare, st = host.status();
  const stateText = st.state === 'connecting' ? '正在开启分享…'
    : st.state === 'error' ? (host.error || '分享出错')
    : st.sending ? `正在发送「${st.sending.name.split('/').pop()}」${st.sending.size ? ` ${Math.round((st.sending.done / st.sending.size) * 100)}%` : ''}`
    : st.viewers ? `${st.viewers} 人已打开链接` : '分享中 · 等待对方打开链接';
  el.classList.toggle('busy', !!st.sending);
  el.classList.toggle('err', st.state === 'error');
  el.innerHTML = `
    <header><span class="sp-ico">${SHARE_SVG}</span><div class="sp-t"><b>分享「${esc(f.title)}」</b><small>${files.length} 个文件 · ${fmtSize(total)}</small></div>
      <button class="icon-btn" data-share-act="min" aria-label="收起 / 展开">${'<svg viewBox="0 0 24 24"><path d="M6 12h12"/></svg>'}</button></header>
    <div class="sp-body">
      <div class="sp-state"><i class="dot"></i>${esc(stateText)}</div>
      ${st.sentFiles ? `<div class="sp-sub">已发送 ${st.sentFiles} 个文件 · ${fmtSize(st.sentBytes)}</div>` : ''}
      <div class="sp-link"><input readonly value="${esc(url)}" aria-label="分享链接" onclick="this.select()"><button class="btn primary" data-share-act="copy">复制链接</button></div>
      <p class="sp-note">对方打开链接就能看到文件并直接下载。文件从这台电脑直接传过去，不经过服务器；<b>这个页面要一直开着</b>，关掉或点「停止分享」链接就失效。</p>
      <button class="btn danger-ghost" data-share-act="stop">停止分享</button>
    </div>`;
}

// ---- 接收方：带 ?share= 打开时显示下载页 ----
async function initShareFromUrl() {
  const id = share.normalizeShareId(new URLSearchParams(location.search).get('share'));
  if (!id) return false;
  const view = document.createElement('section');
  view.className = 'share-view'; view.setAttribute('role', 'dialog'); view.setAttribute('aria-label', '下载分享的文件');
  document.body.appendChild(view);
  document.body.classList.add('share-open');
  let manifest = null, status = { state: 'connecting' }, busy = false;
  const prog = new Map(); // i -> pct | 'done' | 'err'
  let allProg = null;
  const guest = new share.ShareGuest(id, {
    onStatus: (s) => { status = s; draw(); },
    onManifest: (m) => { manifest = m; draw(); },
  });
  const close = () => {
    guest.close(); view.remove(); document.body.classList.remove('share-open');
    const p = new URLSearchParams(location.search); p.delete('share');
    history.replaceState(null, '', location.pathname + (p.toString() ? `?${p}` : '') + location.hash);
  };
  const saveAs = (blob, name) => {
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  };
  const fetchOne = (i) => guest.get(i, (got, size) => { prog.set(i, size ? Math.round((got / size) * 100) : 0); drawProg(i); });
  async function downloadOne(i) {
    const f = manifest.files[i];
    try { const blob = await fetchOne(i); prog.set(i, 'done'); saveAs(blob, f.name.split('/').pop()); }
    catch (e) { prog.set(i, 'err'); toast(`「${f.name.split('/').pop()}」下载失败：${e.message || e}`, { error: true }); }
    drawProg(i);
  }
  async function downloadAll() {
    const files = manifest.files, total = files.reduce((n, f) => n + f.size, 0);
    if (total > 1.5 * 1024 ** 3 && !(await confirmBox({ title: '文件比较大', body: `一共 ${fmtSize(total)}，打成一个 zip 会占用较多内存。建议分批逐个下载；确定要整包下载吗？`, ok: '整包下载' }))) return;
    busy = true; draw();
    const entries = [];
    let doneBytes = 0;
    try {
      for (const f of files) {
        const blob = await guest.get(f.i, (got) => { allProg = { n: entries.length, total: files.length, bytes: doneBytes + got, all: total }; drawAll(); });
        doneBytes += blob.size; prog.set(f.i, 'done');
        entries.push({ name: f.name, size: blob.size, data: blob });
      }
      allProg = { n: files.length, total: files.length, bytes: total, all: total, packing: true }; drawAll();
      const z = await zip.buildStoreZip(entries);
      saveAs(z, `${String(manifest.title || '分享').replace(/[\\/:*?"<>|]/g, '_')}.zip`);
      toast(`已下载 ${entries.length} 个文件（${fmtSize(z.size)}）`);
    } catch (e) { toast(`下载中断：${e.message || e}`, { error: true }); }
    busy = false; allProg = null; draw();
  }
  function drawProg(i) {
    const row = view.querySelector(`[data-share-i="${i}"]`);
    if (!row) return;
    const p = prog.get(i);
    row.classList.toggle('done', p === 'done');
    const b = row.querySelector('.sf-dl');
    if (b) b.textContent = p === 'done' ? '已下载' : p === 'err' ? '重试' : typeof p === 'number' ? `${p}%` : '下载';
    row.style.setProperty('--p', `${typeof p === 'number' ? p : p === 'done' ? 100 : 0}%`);
  }
  function drawAll() {
    const el = view.querySelector('.sv-all-prog');
    if (!el || !allProg) return;
    el.hidden = false;
    el.querySelector('i').style.width = `${allProg.all ? Math.round((allProg.bytes / allProg.all) * 100) : 0}%`;
    el.querySelector('span').textContent = allProg.packing ? '正在打包 zip…' : `正在下载 ${Math.min(allProg.n + 1, allProg.total)}/${allProg.total} · ${fmtSize(allProg.bytes)} / ${fmtSize(allProg.all)}`;
  }
  function draw() {
    const head = `<header class="sv-head"><span class="sp-ico">${SHARE_SVG}</span><div><h2>${manifest ? esc(manifest.title) : '分享的文件夹'}</h2>
      <p>${manifest ? `${manifest.files.length} 个文件 · ${fmtSize(manifest.files.reduce((n, f) => n + f.size, 0))} · 从对方电脑直接传输，不经过服务器` : '方寸工作台 · 文件分享'}</p></div>
      <button class="icon-btn" data-sv="close" aria-label="关闭"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></header>`;
    let body;
    if (status.state === 'offline' || status.state === 'stopped') body = `<div class="sv-msg"><b>${status.state === 'stopped' ? '对方已停止分享' : '连不上分享者'}</b><span>${status.state === 'stopped' ? '这个链接已经失效，需要对方重新分享。' : '分享者的页面可能已经关闭，或者网络不通。请让对方保持「方寸」页面开着，然后再试。'}</span>${status.state === 'offline' ? '<button class="btn primary" data-sv="retry">重新连接</button>' : ''}</div>`;
    else if (status.state === 'error') body = `<div class="sv-msg"><b>出错了</b><span>${esc(status.msg || '')}</span><button class="btn primary" data-sv="retry">重新连接</button></div>`;
    else if (!manifest) body = '<div class="sv-msg"><span class="sv-spin"></span><span>正在连接分享者…</span></div>';
    else {
      body = `<div class="sv-actions"><button class="btn primary" data-sv="all" ${busy ? 'disabled' : ''}>${busy ? '下载中…' : '全部下载（zip）'}</button>
        <div class="sv-all-prog" hidden><i></i><span></span></div></div>
        <ul class="sv-list">${manifest.files.map((f) => `<li data-share-i="${f.i}"><span class="sf-name" title="${esc(f.name)}">${esc(f.name)}</span><span class="sf-size">${fmtSize(f.size)}</span><button class="btn sf-dl" data-sv="one" data-i="${f.i}" ${busy ? 'disabled' : ''}>下载</button></li>`).join('')}</ul>`;
    }
    view.innerHTML = `<div class="sv-card">${head}${body}</div>`;
    if (manifest) manifest.files.forEach((f) => { if (prog.has(f.i)) drawProg(f.i); });
    drawAll();
  }
  view.addEventListener('click', (e) => {
    const b = e.target.closest('[data-sv]');
    if (!b) return;
    const a = b.dataset.sv;
    if (a === 'close') close();
    if (a === 'retry') { guest.close(); manifest = null; Object.assign(guest, { closed: false }); guest.connect(); }
    if (a === 'all' && manifest && !busy) downloadAll();
    if (a === 'one' && manifest && !busy) downloadOne(+b.dataset.i);
  });
  draw();
  guest.connect();
  return true;
}

// ---------- 作品：个人作品 / 网站项目 —— 分类、更新日志（可从 GitHub 同步）、在线预览 ----------
const works = () => areasOf('work');
const openWork = () => (state.view === WORKS && area(state.work)?.kind === 'work' ? state.work : null);
const WORK_SVG = `<svg viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="17" height="12.5" rx="2"/><path d="M3.5 8.5h17M9 20.5h6M12 17v3.5"/></svg>`;
const ICON_EXT = `<svg viewBox="0 0 24 24"><path d="M14 5h5v5M19 5l-8 8M18 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h4"/></svg>`;
const ICON_GH = `<svg viewBox="0 0 24 24"><path d="M9 19c-4 1.3-4-2-6-2.5M15 21v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1-.3-3.4 1.3a11.6 11.6 0 0 0-6 0C6.8 2.8 5.8 3.1 5.8 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4.4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21"/></svg>`;
const ICON_SYNC = `<svg viewBox="0 0 24 24"><path d="M19.5 10A8 8 0 0 0 5.2 7.2L4 8.5M4 4v4.5h4.5M4.5 14a8 8 0 0 0 14.3 2.8l1.2-1.3M20 20v-4.5h-4.5"/></svg>`;
const ICON_FULL = `<svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>`;
const ICON_LOCK = `<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>`;
const WSTATUS = { live: { t: '已上线', c: '#2f9e44' }, dev: { t: '开发中', c: '#1c7ed6' }, paused: { t: '暂停', c: '#868e96' }, done: { t: '完结', c: '#7950f2' } };
const wstat = (w) => { const s = WSTATUS[w.status] || WSTATUS.dev; return `<span class="wstat" style="--pc:${s.c}">${s.t}</span>`; };
const safeUrl = (u) => (/^https?:\/\/[^\s"'<>]+$/i.test(u || '') ? u : '');
function normUrl(u) {
  u = (u || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  try { const x = new URL(u); return /^https?:$/.test(x.protocol) && x.hostname.includes('.') ? x.href : null; } catch { return null; }
}
const hostOf = (u) => { try { return new URL(u).host.replace(/^www\./, ''); } catch { return ''; } };
// 「用户名/仓库」、仓库链接、或 GitHub Pages 地址都能识别出仓库；识别不了返回 null
function parseRepo(s, owner = '') {
  s = (s || '').trim().replace(/\/+$/, '');
  if (!s) return '';
  // 只写了仓库名：用已知的 GitHub 用户名补全
  if (/^[\w.-]+$/.test(s) && !/\.github\.io$/i.test(s)) return owner ? `${owner}/${s}` : null;
  let m = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?]|$)/i.exec(s);
  if (m) return `${m[1]}/${m[2]}`;
  m = /^(?:https?:\/\/)?([\w-]+)\.github\.io\/?(?:[?#].*)?$/i.exec(s);
  if (m) return `${m[1]}/${m[1].toLowerCase()}.github.io`;
  m = /^(?:https?:\/\/)?([\w-]+)\.github\.io\/([\w.-]+)/i.exec(s);
  if (m) return `${m[1]}/${m[2]}`;
  m = /^([\w-]+)\/([\w.-]+)$/.exec(s);
  return m ? `${m[1]}/${m[2]}` : null;
}
// 猜 GitHub 用户名：网站是 xxx.github.io → xxx；否则用已有作品里最常见的仓库主人，再否则用上次导入时填的用户名
function guessOwner(url) {
  const m = /^(?:https?:\/\/)?([\w-]+)\.github\.io/i.exec(url || '');
  if (m) return m[1];
  const n = {};
  for (const w of works()) { const o = (w.repo || '').split('/')[0]; if (o) n[o] = (n[o] || 0) + 1; }
  return Object.entries(n).sort((a, b) => b[1] - a[1])[0]?.[0] || ls.get('ghUser', '');
}
const workColor = (w) => FCOLORS[(w.color ?? Math.max(0, works().indexOf(w))) % FCOLORS.length].c;
const allWorkCats = () => [...new Set([...(state.workCats || []), ...works().map((w) => w.category).filter(Boolean)])];
const visibleLogs = (w) => (w.logs || []).filter((l) => !l.hidden).sort((a, b) => b.at - a.at);
const lastActivity = (w) => Math.max(w.createdAt || 0, visibleLogs(w)[0]?.at || 0);
const agoLong = (ts) => (Date.now() - ts > 30 * 86400e3 ? fmtDate(ts) : ago(ts));
function dayLabel(ts) {
  const d = new Date(ts), now = new Date(), y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return '今天';
  if (d.toDateString() === y.toDateString()) return '昨天';
  return d.getFullYear() === now.getFullYear() ? `${d.getMonth() + 1}月${d.getDate()}日` : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}
const hm = (ts) => new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
function abbr(t) {
  const s = (t || '').trim();
  if (/^[\x00-\x7f]+$/.test(s)) { const ws = s.split(/[\s\-_.]+/).filter(Boolean); return (ws.length > 1 ? ws[0][0] + ws[1][0] : s.slice(0, 2)).toUpperCase(); }
  return [...s.replace(/\s/g, '')].slice(0, 2).join('');
}
async function saveWorkCats() { await db.setMeta('workCategories', state.workCats || []); }

// 封面：手动指定的图片 → 作品里第一张图片 → 网站实时缩略 → 文字封面
// 被嵌在 iframe 里时（例如作品里预览方寸自己），不再加载网站预览，避免无限套娃，也不重复同步
let EMBEDDED = true;
try { EMBEDDED = window.self !== window.top; } catch {}
const SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads';
function coverCard(w) {
  const pinned = findCard(w.coverId);
  if (pinned && pinned.columnId === w.id && pinned.thumb === 'ok') return pinned;
  return cardsIn(w.id, false).find((c) => c.thumb === 'ok' && typeOf(c).k === 'image');
}
const coverKey = (w) => `${w.cover || 'auto'}|${coverCard(w)?.id || ''}|${safeUrl(w.url)}`;
function workCover(w) {
  const mode = w.cover || 'auto', url = safeUrl(w.url), pic = mode !== 'live' && mode !== 'mono' ? coverCard(w) : null;
  if (pic) {
    const u = state.urls.get(`thumb:${pic.id}`);
    return `<img class="thumb-img${u ? ' loaded' : ''}" data-thumb="${pic.id}" ${u ? `src="${u}"` : ''} alt="" draggable="false">`;
  }
  if (url && mode !== 'mono' && !EMBEDDED) return `<div class="work-live" data-live><iframe src="${esc(url)}" loading="lazy" tabindex="-1" aria-hidden="true" sandbox="allow-scripts allow-same-origin" referrerpolicy="no-referrer" title=""></iframe></div>`;
  return `<div class="work-mono"><b>${esc(abbr(w.title))}</b>${url ? `<span>${esc(hostOf(url))}</span>` : ''}</div>`;
}
function workBody(w) {
  const last = visibleLogs(w)[0], url = safeUrl(w.url), syncing = state.syncing.has(w.id);
  return `<div class="work-top">${wstat(w)}${w.category ? `<span class="work-cat">${esc(w.category)}</span>` : ''}${syncing ? `<span class="work-spin" title="正在同步">${ICON_SYNC}</span>` : ''}</div>
    <h3 class="work-name">${highlight(w.title)}</h3>
    <p class="work-desc">${w.desc ? highlight(w.desc) : `<span class="dim">${url ? esc(hostOf(url)) : '还没有简介'}</span>`}</p>
    <div class="work-last">${last ? `<time>${agoLong(last.at)}</time><span>${esc(last.text)}</span>` : '<span class="dim">还没有更新日志</span>'}</div>
    <div class="work-links">
      ${url ? `<button class="wl" data-action="work-preview" data-id="${w.id}">预览</button><a class="wl" href="${esc(url)}" target="_blank" rel="noopener" title="${esc(url)}">访问${ICON_EXT}</a>` : ''}
      ${w.repo ? `<a class="wl icon" href="https://github.com/${esc(w.repo)}" target="_blank" rel="noopener" title="GitHub：${esc(w.repo)}" aria-label="GitHub 仓库">${ICON_GH}</a>` : ''}
    </div>`;
}
function workTile(w) {
  return `<article class="work" role="button" tabindex="0" data-work="${w.id}" data-drop="${w.id}" draggable="${IS_TOUCH ? 'false' : 'true'}" style="--fc:${workColor(w)}" aria-label="作品 ${esc(w.title)}">
    <div class="work-cover">${workCover(w)}</div>
    <div class="work-body">${workBody(w)}</div>
    <button class="more" data-action="work-menu" data-id="${w.id}" aria-label="作品设置" aria-haspopup="menu">${DOTS}</button>
  </article>`;
}
const workMatch = (w) => {
  const q = state.query.toLowerCase();
  return !q || [w.title, w.desc, w.url, w.repo, w.category, ...(w.tags || []), ...(w.logs || []).map((l) => l.text)].some((s) => (s || '').toLowerCase().includes(q)) || cardsIn(w.id).length > 0;
};
function renderWorks() {
  const el = $('#worksView');
  const wid = openWork();
  if (wid) return renderWorkDetail(el, area(wid));
  const all = works().filter(workMatch).sort((a, b) => lastActivity(b) - lastActivity(a));
  const cats = allWorkCats();
  const cur = state.workCat === '__none' || cats.includes(state.workCat) ? state.workCat : 'all';
  const inCat = (name) => all.filter((w) => (name === '__none' ? !w.category || !cats.includes(w.category) : w.category === name));
  const shown = cur === 'all' ? all : inCat(cur);
  const live = works().filter((w) => w.status === 'live').length;
  const lastAt = Math.max(0, ...works().map(lastActivity));
  const chip = (key, label, n, drop) => `<button class="cat-chip" role="tab" aria-selected="${cur === key}" data-wcat="${esc(key)}" ${drop != null ? `data-wcatdrop="${esc(drop)}"` : ''}>${esc(label)}<b>${n}</b></button>`;
  const head = `<header class="archive-head works-head">
      <div class="ah-text"><h2>作品</h2>
        <div class="meta">${works().length ? `${works().length} 个作品 · ${live} 个已上线${lastAt ? ` · 最近更新 ${agoLong(lastAt)}` : ''}` : '放你做过的网站、设计和项目：分类整理，更新日志自动从 GitHub 同步，点开就能预览。'}</div></div>
      <button class="btn" data-action="work-import">${ICON_GH}<span>从 GitHub 导入</span></button>
      ${works().some((w) => w.repo) ? `<button class="btn" data-action="work-sync-all" ${state.syncing.size ? 'disabled' : ''}>${ICON_SYNC}<span>${state.syncing.size ? '同步中…' : '同步全部'}</span></button>` : ''}
      <button class="btn primary" data-action="work-new"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg><span>新建作品</span></button>
    </header>`;
  const bar = works().length ? `<div class="cat-bar" role="tablist" aria-label="作品分类">
      ${chip('all', '全部', all.length)}${cats.map((c) => chip(c, c, inCat(c).length, c)).join('')}
      ${cats.length ? chip('__none', '未分类', inCat('__none').length, '') : ''}
      <button class="cat-add" data-action="wcat-add" title="新建分类，然后把作品拖到分类上">+ 分类</button></div>` : '';
  let grid;
  if (!works().length) grid = `<div class="archive-empty works-empty">${WORK_SVG}<b>还没有作品</b><span>点「新建作品」填上网站链接；或「从 GitHub 导入」一次把仓库都加进来 —— 提交记录会自动变成更新日志。</span></div>`;
  else if (!shown.length) grid = `<div class="archive-empty slim"><b>${state.query ? '没有匹配的作品' : '这个分类还是空的'}</b><span>${state.query ? '' : '把作品拖到上方的分类标签上，或在作品菜单里选择分类。'}</span></div>`;
  else grid = `<div class="work-grid">${shown.map(workTile).join('')}</div>`;
  const feedList = all.flatMap((w) => visibleLogs(w).slice(0, 30).map((l) => ({ l, w }))).sort((a, b) => b.l.at - a.l.at).slice(0, 40);
  let day = '';
  const feed = works().length ? `<aside class="works-feed" aria-label="更新动态"><h3 class="cat-h"><span>更新动态</span><b>${feedList.length}</b></h3>
      ${feedList.length ? `<ol class="feed">${feedList.map(({ l, w }) => {
        const d = dayLabel(l.at), sep = d !== day ? `<li class="feed-day">${d}</li>` : ''; day = d;
        return `${sep}<li class="feed-item" data-work="${w.id}" style="--fc:${workColor(w)}" role="button" tabindex="0"><span class="fi-sq" aria-hidden="true"></span>
          <div class="fi-main"><div class="fi-top"><b>${esc(w.title)}</b><time>${hm(l.at)}</time></div>
          <div class="fi-text">${l.ver ? `<span class="tl-ver">${esc(l.ver)}</span>` : ''}${esc(l.text)}</div></div></li>`;
      }).join('')}</ol>` : `<p class="feed-empty">作品的更新会按时间汇总在这里。</p>`}</aside>` : '';
  // 封面里有实时网页（iframe）：结构没变时只更新文字部分，避免每次刷新都重新加载网站
  const key = `${cur}|${shown.map((w) => `${w.id}:${coverKey(w)}:${workColor(w)}`).join(',')}`;
  if (el.dataset.wkey === key && !el.dataset.wid && $('.work-grid', el)) {
    $('.works-head', el).outerHTML = head;
    const oldBar = $('.cat-bar', el); if (oldBar) oldBar.outerHTML = bar;
    for (const w of shown) { const b = $(`.work[data-work="${CSS.escape(w.id)}"] .work-body`, el); if (b) b.innerHTML = workBody(w); }
    const oldFeed = $('.works-feed', el); if (oldFeed) oldFeed.outerHTML = feed;
  } else {
    el.dataset.wkey = key; el.dataset.wid = '';
    el.innerHTML = `${head}<div class="works-layout"><div class="works-main">${bar}${grid}</div>${feed}</div>`;
  }
  fitPreview();
  autoSync();
}

const DEVICES = { desktop: { w: 1280, label: '电脑' }, tablet: { w: 820, label: '平板' }, phone: { w: 390, label: '手机' } };
function sitePreviewHTML(w, url, { modal = false } = {}) {
  const dev = DEVICES[state.device] ? state.device : 'desktop';
  return `<section class="site-prev${modal ? ' in-modal' : ''}" data-url="${esc(url)}" data-device="${dev}">
    <div class="sp-bar">
      <div class="sp-url" title="${esc(url)}">${ICON_LOCK}<span>${esc(url.replace(/^https?:\/\//, '').replace(/\/$/, ''))}</span></div>
      <div class="seg" role="group" aria-label="预览尺寸">${Object.entries(DEVICES).map(([k, d]) => `<button type="button" data-action="sp-device" data-d="${k}" aria-pressed="${dev === k}">${d.label}</button>`).join('')}</div>
      <button class="icon-btn" data-action="sp-reload" title="刷新预览" aria-label="刷新预览">${ICON_SYNC}</button>
      ${modal ? '' : `<button class="icon-btn" data-action="sp-full" title="放大预览（Esc 退出）" aria-label="放大预览">${ICON_FULL}</button>`}
      <a class="icon-btn" href="${esc(url)}" target="_blank" rel="noopener" title="新窗口打开" aria-label="新窗口打开">${ICON_EXT}</a>
      ${modal ? `<button class="icon-btn" data-action="close-viewer" aria-label="关闭"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>` : ''}
    </div>
    <div class="sp-stage"><div class="sp-frame"><iframe class="sp-iframe" src="${esc(url)}" title="${esc(w.title)} 网站预览" sandbox="${SANDBOX}" allow="fullscreen; clipboard-write" referrerpolicy="no-referrer-when-downgrade"></iframe></div>
      <div class="sp-loading"><div class="spinner"></div>正在加载 ${esc(hostOf(url))}…</div></div>
    <p class="sp-note">预览一直空白？有的网站禁止被嵌入，请点右上角「新窗口打开」。</p>
  </section>`;
}
// 按所选设备宽度渲染网页，再整体缩放到容器里（桌面版网页在小窗口里也是完整布局）
function fitPreview() {
  $$('.site-prev').forEach((sp) => {
    if (!sp.getClientRects().length) return;
    const stage = $('.sp-stage', sp), frame = $('.sp-frame', sp), ifr = $('iframe', sp);
    const dw = DEVICES[sp.dataset.device]?.w || 1280, pad = sp.dataset.device === 'desktop' ? 0 : 24;
    const W = stage.clientWidth - pad * 2, H = stage.clientHeight - pad * 2;
    const s = Math.min(1, W / dw);
    Object.assign(ifr.style, { width: `${dw}px`, height: `${H / s}px`, transform: `scale(${s})` });
    Object.assign(frame.style, { width: `${dw * s}px`, height: `${H}px` });
  });
  $$('[data-live]').forEach((el) => { if (el.offsetParent) el.style.setProperty('--s', el.clientWidth / 1280); });
}
addEventListener('resize', () => { clearTimeout(fitPreview.t); fitPreview.t = setTimeout(fitPreview, 80); });
document.addEventListener('load', (e) => {
  if (e.target.matches?.('.sp-iframe')) e.target.closest('.site-prev')?.classList.add('loaded');
  if (e.target.matches?.('.work-live iframe')) e.target.parentElement.classList.add('loaded');
}, true);
function previewSite(w) {
  const url = safeUrl(w?.url);
  if (!url) return;
  if (EMBEDDED) return window.open(url, '_blank', 'noopener');
  const v = $('#viewer');
  v.classList.add('site-viewer');
  $('#viewerInner').innerHTML = sitePreviewHTML(w, url, { modal: true });
  v.showModal();
  fitPreview();
  requestAnimationFrame(fitPreview);
}

function renderWorkDetail(el, w) {
  const url = safeUrl(w.url), syncing = state.syncing.has(w.id), logs = visibleLogs(w);
  const metaParts = [`${logs.length} 条更新`];
  if (w.repoInfo?.lang) metaParts.push(esc(w.repoInfo.lang));
  if (w.repo) metaParts.push(w.syncError ? `<span class="warn-text">同步失败：${esc(w.syncError)}</span>` : w.syncedAt ? `${ago(w.syncedAt)}同步` : '尚未同步');
  metaParts.push(`创建于 ${fmtDate(w.createdAt || Date.now())}`);
  const head = `<header class="archive-head wd-head" style="--fc:${workColor(w)}">
      <button class="icon-btn back" data-action="work-back" aria-label="返回作品"><svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg></button>
      <div class="ah-text">
        <div class="crumb"><button class="crumb-link" data-wgoto="">作品</button><span>/</span>${w.category ? `<button class="crumb-link" data-wgoto="" data-wcat="${esc(w.category)}">${esc(w.category)}</button><span>/</span>` : ''}</div>
        <h2><span class="title-sw" aria-hidden="true"></span>${esc(w.title)}${wstat(w)}</h2>
        <div class="meta">${metaParts.join(' · ')}</div>
      </div>
      ${url ? `<a class="btn" href="${esc(url)}" target="_blank" rel="noopener">${ICON_EXT}<span>打开网站</span></a>` : ''}
      ${w.repo ? `<button class="btn" data-action="work-sync" ${syncing ? 'disabled' : ''} title="从 GitHub 同步提交记录">${ICON_SYNC}<span>${syncing ? '同步中…' : '同步'}</span></button>` : ''}
      <button class="btn" data-action="work-edit"><svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg><span>编辑</span></button>
      <button class="icon-btn" data-action="work-menu" aria-label="作品设置" aria-haspopup="menu">${DOTS}</button>
    </header>`;
  const f = state.logFilter || 'all';
  const list = logs.filter((l) => f === 'all' || (f === 'git' ? l.src === 'git' : l.src !== 'git'));
  const limit = state.logLimit || 40;
  let day = '';
  const items = list.slice(0, limit).map((l) => {
    const d = dayLabel(l.at), sep = d !== day ? `<li class="tl-day">${d}</li>` : ''; day = d;
    const git = l.src === 'git', link = safeUrl(l.link);
    return `${sep}<li class="tl-item ${git ? 'git' : 'manual'}" data-log="${l.id}">
      <span class="tl-mark" aria-hidden="true"></span>
      <div class="tl-body">
        <div class="tl-text">${l.ver ? `<span class="tl-ver">${esc(l.ver)}</span>` : ''}${highlight(l.text)}</div>
        ${l.detail ? `<details class="tl-detail"><summary>详情</summary><div>${esc(l.detail)}</div></details>` : ''}
        <div class="tl-meta"><time>${hm(l.at)}</time>${git ? ` · 代码提交${link ? ` <a href="${esc(link)}" target="_blank" rel="noopener">${esc((l.sha || '').slice(0, 7))}</a>` : ''}${l.author ? ` · ${esc(l.author)}` : ''}` : ' · 手动记录'}</div>
      </div>
      <button class="more" data-action="log-menu" data-id="${l.id}" aria-label="这条日志的操作" aria-haspopup="menu">${DOTS}</button>
    </li>`;
  }).join('');
  const nGit = logs.filter((l) => l.src === 'git').length;
  const seg = (k, label, n) => `<button type="button" data-action="log-filter" data-f="${k}" aria-pressed="${f === k}">${label}<b>${n}</b></button>`;
  const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60e3).toISOString().slice(0, 10);
  const info = [
    url && `<div class="wi-row"><span>网站</span><a href="${esc(url)}" target="_blank" rel="noopener">${esc(url.replace(/^https?:\/\//, '').replace(/\/$/, ''))}</a></div>`,
    w.repo && `<div class="wi-row"><span>仓库</span><a href="https://github.com/${esc(w.repo)}" target="_blank" rel="noopener">${esc(w.repo)}</a></div>`,
    w.repoInfo?.stars != null && `<div class="wi-row"><span>星标</span><b>${w.repoInfo.stars}</b></div>`,
    w.category && `<div class="wi-row"><span>分类</span><b>${esc(w.category)}</b></div>`,
  ].filter(Boolean).join('');
  const rest = `<div class="wd-rest" style="--fc:${workColor(w)}">
      <section class="wd-log">
        <div class="wd-log-head"><h3 class="cat-h"><span>更新日志</span><b>${logs.length}</b></h3>
          ${nGit ? `<div class="seg" role="group" aria-label="筛选">${seg('all', '全部', logs.length)}${seg('manual', '手动', logs.length - nGit)}${seg('git', '提交', nGit)}</div>` : ''}</div>
        <form class="log-compose" id="logForm">
          <textarea name="t" rows="2" placeholder="记录这次更新了什么…（第一行是标题，Ctrl + Enter 保存）" maxlength="2000"></textarea>
          <div class="lc-row"><input type="text" name="v" placeholder="版本号（可选）" maxlength="20"><input type="date" name="d" value="${today}" max="${today}" aria-label="日期"><button class="btn primary">记录</button></div>
        </form>
        ${list.length ? `<ol class="timeline">${items}</ol>` : `<p class="feed-empty">${w.repo ? '还没有记录。点「同步 GitHub」把提交记录拉进来，或者在上面手动写一条。' : '还没有记录。在上面写下第一条更新；填上 GitHub 仓库后，提交记录会自动同步进来。'}</p>`}
        ${list.length > limit ? `<button class="btn ghost tl-more" data-action="log-more">显示更多（还有 ${list.length - limit} 条）</button>` : ''}
      </section>
      <aside class="wd-side">
        <section class="wd-info">
          ${w.desc ? `<p class="wi-desc">${esc(w.desc)}</p>` : `<p class="wi-desc dim">还没有简介，点「编辑」补充。</p>`}
          ${(w.tags || []).length ? `<div class="wi-tags">${w.tags.map((t) => `<span>${esc(t)}</span>`).join('')}</div>` : ''}
          ${info}
        </section>
        <h3 class="cat-h"><span>文件</span><b>${cardsIn(w.id, false).length}</b></h3>
        <div class="list folder-list work-files" data-col="${w.id}">${listHTML(w.id, '截图、设计稿、文档拖到这里；第一张图片会当作封面')}</div>
      </aside>
    </div>`;
  const prev = $('.site-prev:not(.in-modal)', el);
  if (el.dataset.wid === w.id && (prev?.dataset.url || '') === url && $('.wd-head', el)) {
    // 只替换标题和日志区，网站预览（iframe）保持不动；保留正在写的日志草稿
    const form = $('#logForm', el), draft = form && { t: form.t.value, v: form.v.value, d: form.d.value, focus: form.contains(document.activeElement) && document.activeElement.name };
    $('.wd-head', el).outerHTML = head;
    $('.wd-rest', el).outerHTML = rest;
    const nf = $('#logForm', el);
    if (draft && nf) { nf.t.value = draft.t; nf.v.value = draft.v; nf.d.value = draft.d || nf.d.value; if (draft.focus) nf[draft.focus]?.focus(); }
  } else {
    el.dataset.wid = w.id; el.dataset.wkey = '';
    el.innerHTML = head + (url && !EMBEDDED ? sitePreviewHTML(w, url) : '') + rest;
  }
  fitPreview();
  requestAnimationFrame(fitPreview);
}

// ---------- 作品：新建 / 编辑 ----------
async function editWork(w) {
  const isNew = !w;
  let v = w ? { wt: w.title, wu: w.url || '', wr: w.repo || '', wc: w.category || '', ws: w.status || 'dev', wd: w.desc || '', wg: (w.tags || []).join('，') }
    : { wt: '', wu: '', wr: '', wc: state.workCat !== 'all' && state.workCat !== '__none' ? state.workCat : '', ws: 'live', wd: '', wg: '' };
  const m = $('#modal');
  for (;;) {
    m.classList.add('wide');
    const res = await dialog(`<h3>${isNew ? '新建作品' : '编辑作品'}</h3>
      <label class="field"><span>名称</span><input type="text" name="wt" value="${esc(v.wt)}" placeholder="例如：个人主页、PTE 备考站（只填仓库时可留空）" maxlength="80"></label>
      <label class="field"><span>网站链接</span><input type="text" name="wu" value="${esc(v.wu)}" placeholder="https://… 填了就能直接预览" maxlength="300" inputmode="url"></label>
      <label class="field"><span>GitHub 仓库 <em>可选，用来同步更新日志；GitHub Pages 网站会自动识别</em></span><input type="text" name="wr" value="${esc(v.wr)}" placeholder="仓库名（如 pte-coach）、用户名/仓库名，或仓库链接" maxlength="200"></label>
      <div class="field-row">
        <label class="field"><span>分类</span><input type="text" name="wc" value="${esc(v.wc)}" placeholder="例如：网站、设计、小工具" maxlength="40" list="wcatList">
          <datalist id="wcatList">${allWorkCats().map((c) => `<option value="${esc(c)}">`).join('')}</datalist></label>
        <label class="field"><span>状态</span><select name="ws">${Object.entries(WSTATUS).map(([k, s]) => `<option value="${k}" ${v.ws === k ? 'selected' : ''}>${s.t}</option>`).join('')}</select></label>
      </div>
      <label class="field"><span>简介</span><textarea name="wd" rows="3" maxlength="500" placeholder="一两句话说明这个作品">${esc(v.wd)}</textarea></label>
      <label class="field"><span>标签</span><input type="text" name="wg" value="${esc(v.wg)}" placeholder="用逗号分隔，例如：React，个人项目" maxlength="200"></label>
      ${actions(isNew ? '创建' : '保存')}`, (f) => Object.fromEntries(['wt', 'wu', 'wr', 'wc', 'ws', 'wd', 'wg'].map((k) => [k, f[k].value.trim()])));
    m.classList.remove('wide');
    if (!res) return null;
    v = res;
    const url = normUrl(res.wu);
    if (url === null) { toast('网站链接格式不对，例如 https://example.com', { error: true }); continue; }
    let owner = guessOwner(url);
    if (res.wr && /^[\w.-]+$/.test(res.wr) && !owner) {
      owner = await prompt({ title: `「${res.wr}」是哪个 GitHub 账号的？`, placeholder: 'GitHub 用户名', ok: '确定' });
      if (!owner) continue;
      if (!/^[A-Za-z0-9-]{1,39}$/.test(owner)) { toast('GitHub 用户名只包含字母、数字和横线', { error: true }); continue; }
      ls.set('ghUser', owner);
    }
    const repo = res.wr ? parseRepo(res.wr, owner) : (url && parseRepo(url)) || '';
    if (repo === null) { toast('GitHub 仓库请填仓库名、「用户名/仓库名」或仓库链接', { error: true }); continue; }
    if (!res.wt) {
      if (!repo) { toast('请填写名称', { error: true }); continue; }
      res.wt = repo.split('/')[1];
    }
    if (isNew) w = { id: uid(), kind: 'work', order: 0, createdAt: Date.now(), color: works().length % FCOLORS.length, logs: [] };
    const repoChanged = repo !== (w.repo || '');
    if (repoChanged && w.repo) w.logs = (w.logs || []).filter((l) => l.src !== 'git'); // 换了仓库：旧仓库的提交记录不再属于它
    Object.assign(w, { title: res.wt, url, repo, status: res.ws, desc: res.wd, tags: res.wg.split(/[,，、;；]/).map((s) => s.trim()).filter(Boolean) });
    if (repoChanged) { delete w.syncedAt; delete w.syncError; delete w.repoInfo; }
    if (res.wc) { w.category = res.wc; if (!allWorkCats().includes(res.wc)) { state.workCats = [...(state.workCats || []), res.wc]; await saveWorkCats(); } } else delete w.category;
    await saveArea(w);
    if (isNew) { state.areas.push(w); state.work = w.id; ls.set('work', w.id); }
    await changed();
    toast(isNew ? `已创建作品「${w.title}」${repo ? '，正在同步更新日志…' : ''}` : '已保存');
    if (repo && repoChanged) syncMany([w], { quiet: !isNew });
    return w;
  }
}

// ---------- GitHub 同步（公开仓库，无需登录；每小时 60 次额度） ----------
async function gh(path) {
  let r;
  try { r = await fetch(`https://api.github.com${path}`, { headers: { Accept: 'application/vnd.github+json' } }); } catch { throw new Error('连不上 GitHub，请检查网络'); }
  if (r.status === 403 || r.status === 429) {
    const reset = +r.headers.get('x-ratelimit-reset');
    const e = new Error(`GitHub 访问次数暂时用完${reset ? `，${new Date(reset * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 后恢复` : '，请稍后再试'}`);
    e.code = 'RATE'; throw e;
  }
  if (r.status === 404) throw new Error('找不到这个仓库或账号（私有仓库无法同步）');
  if (r.status === 409) return []; // 空仓库
  if (!r.ok) throw new Error(`GitHub 返回 ${r.status}`);
  return r.json();
}
function mergeCommits(w, commits) {
  const seen = new Set((w.logs || []).map((l) => l.sha).filter(Boolean));
  let added = 0;
  w.logs = w.logs || [];
  for (const c of commits || []) {
    if (!c?.sha || seen.has(c.sha)) continue;
    const [title, ...rest] = (c.commit?.message || '').split('\n');
    w.logs.push({ id: uid(), src: 'git', sha: c.sha, at: Date.parse(c.commit?.author?.date || c.commit?.committer?.date) || Date.now(),
      text: title.trim() || '(无说明)', detail: rest.join('\n').trim() || undefined, link: c.html_url, author: c.commit?.author?.name });
    seen.add(c.sha); added++;
  }
  return added;
}
async function syncWork(w) {
  state.syncing.add(w.id);
  render();
  try {
    const [info, commits] = await Promise.all([gh(`/repos/${w.repo}`), gh(`/repos/${w.repo}/commits?per_page=100`)]);
    const added = mergeCommits(w, commits);
    w.repoInfo = { stars: info.stargazers_count, lang: info.language, pushedAt: Date.parse(info.pushed_at) || 0 };
    if (!w.desc && info.description) w.desc = info.description;
    if (!w.url) { const u = normUrl(info.homepage || '') || (info.has_pages ? pagesUrl(info) : ''); if (u) w.url = u; }
    w.syncedAt = Date.now(); delete w.syncError;
    return added;
  } catch (e) {
    w.syncError = e.message; w.syncTry = Date.now();
    throw e;
  } finally {
    state.syncing.delete(w.id);
    if (area(w.id)) await saveArea(w);
    await changed();
  }
}
async function syncMany(list, { quiet = false } = {}) {
  list = list.filter((w) => w?.repo && !state.syncing.has(w.id));
  if (!list.length) return;
  let added = 0, failed = 0, lastErr = null;
  for (const w of list) {
    try { added += await syncWork(w); } catch (e) { failed++; lastErr = e; if (e.code === 'RATE') break; }
  }
  if (lastErr && (!quiet || lastErr.code === 'RATE') && failed) toast(list.length === 1 ? `同步失败：${lastErr.message}` : `${failed} 个作品同步失败：${lastErr.message}`, { error: true });
  else if (added) toast(`同步完成：新增 ${added} 条更新日志`);
  else if (!quiet) toast('已是最新，没有新的提交');
}
// 打开作品页时，超过 1 小时没同步的作品在后台自动同步
let autoSyncAt = 0;
function autoSync() {
  if (EMBEDDED || Date.now() - autoSyncAt < 10 * 60e3 || !navigator.onLine) return;
  const stale = works().filter((w) => w.repo && Date.now() - Math.max(w.syncedAt || 0, w.syncTry || 0) > 3600e3);
  if (!stale.length) return;
  autoSyncAt = Date.now();
  setTimeout(() => syncMany(stale, { quiet: true }), 600);
}
const pagesUrl = (r) => {
  const o = (r.owner?.login || '').toLowerCase();
  return r.name.toLowerCase() === `${o}.github.io` ? `https://${r.name.toLowerCase()}/` : `https://${o}.github.io/${r.name}/`;
};
async function importFromGitHub() {
  const user = await prompt({ title: '从 GitHub 导入作品', value: ls.get('ghUser', ''), placeholder: 'GitHub 用户名', ok: '查找公开仓库' });
  if (!user) return;
  if (!/^[A-Za-z0-9-]{1,39}$/.test(user)) return toast('GitHub 用户名只包含字母、数字和横线', { error: true });
  ls.set('ghUser', user);
  const t = toast('正在读取公开仓库…', { sticky: true });
  let repos;
  try { repos = await gh(`/users/${encodeURIComponent(user)}/repos?per_page=100&sort=pushed&type=owner`); } catch (e) { t.close(); return toast(`读取失败：${e.message}`, { error: true }); }
  t.close();
  if (!repos.length) return toast('这个账号还没有公开仓库');
  const have = new Set(works().map((w) => (w.repo || '').toLowerCase()));
  const siteOf = (r) => normUrl(r.homepage || '') || (r.has_pages ? pagesUrl(r) : '');
  const m = $('#modal');
  m.classList.add('wide');
  const res = await dialog(`<h3>选择要导入的仓库</h3>
    <p class="stor-note">已默认勾选有网站（GitHub Pages 或主页链接）的仓库。导入后会自动把最近的提交记录同步成更新日志。</p>
    <div class="pick-list gh-list">${repos.map((r) => {
      const done = have.has(r.full_name.toLowerCase()), site = siteOf(r);
      return `<label class="pick${done ? ' done' : ''}"><input type="checkbox" name="r" value="${esc(r.full_name)}" ${done ? 'disabled' : site && !r.fork && !r.archived ? 'checked' : ''}>
        <span><b>${esc(r.name)}</b>${r.description ? `<em>${esc(r.description)}</em>` : ''}</span>
        <small>${done ? '已添加' : [site && '有网站', r.fork && '复刻', r.archived && '已归档', agoLong(Date.parse(r.pushed_at))].filter(Boolean).join(' · ')}</small></label>`;
    }).join('')}</div>
    <label class="field"><span>放到分类 <em>可选</em></span><input type="text" name="c" value="${esc(allWorkCats()[0] || '网站')}" maxlength="40" list="wcatList2">
      <datalist id="wcatList2">${allWorkCats().map((c) => `<option value="${esc(c)}">`).join('')}</datalist></label>
    ${actions('导入')}`, (f) => ({ names: [...f.querySelectorAll('input[name="r"]:checked')].map((i) => i.value), cat: f.c.value.trim() }));
  m.classList.remove('wide');
  if (!res || !res.names.length) return;
  const byName = new Map(repos.map((r) => [r.full_name, r]));
  await createWorksFromRepos(res.names.map((n) => byName.get(n)), res.cat);
}
// 用 GitHub 仓库信息批量建作品，然后只拉提交记录（仓库信息已经有了，省一半 API 额度）
async function createWorksFromRepos(repos, cat) {
  const base = works().length;
  const list = repos.map((r, i) => {
    const site = normUrl(r.homepage || '') || (r.has_pages ? pagesUrl(r) : '');
    const w = { id: uid(), kind: 'work', order: 0, title: r.name, url: site, repo: r.full_name, desc: r.description || '', tags: r.topics || [],
      status: r.archived ? 'done' : site ? 'live' : 'dev', createdAt: Date.parse(r.created_at) || Date.now(), color: (base + i) % FCOLORS.length, logs: [],
      syncTry: Date.now(), // 下面马上同步，别让自动同步再拉一遍
      repoInfo: { stars: r.stargazers_count, lang: r.language, pushedAt: Date.parse(r.pushed_at) || 0 } };
    if (cat) w.category = cat;
    return w;
  });
  if (cat && !allWorkCats().includes(cat)) { state.workCats = [...(state.workCats || []), cat]; await saveWorkCats(); }
  await db.putMany('columns', list);
  state.areas.push(...list);
  await changed();
  toast(`已导入 ${list.length} 个作品，正在同步更新日志…`);
  let added = 0;
  for (const w of list) {
    state.syncing.add(w.id); render();
    try { added += mergeCommits(w, await gh(`/repos/${w.repo}/commits?per_page=100`)); w.syncedAt = Date.now(); delete w.syncError; }
    catch (e) { w.syncError = e.message; w.syncTry = Date.now(); if (e.code === 'RATE') { toast(e.message, { error: true }); state.syncing.clear(); await db.putMany('columns', list.filter((x) => area(x.id))); break; } }
    finally { state.syncing.delete(w.id); if (area(w.id)) await saveArea(w); await changed(); }
  }
  if (added) toast(`同步完成：${list.length} 个作品共 ${added} 条更新日志`);
}

// 链接 ?add=用户名/仓库1,仓库2,… 一次添加多个仓库为作品（先确认，已添加的跳过）
async function addReposFromLink() {
  const p = new URLSearchParams(location.search);
  const raw = p.get('add');
  if (raw === null) return;
  p.delete('add');
  history.replaceState(null, '', location.pathname + (p.toString() ? `?${p}` : '') + location.hash);
  if (EMBEDDED) return;
  let owner = '';
  const names = [];
  for (const part of raw.split(/[,\s]+/).filter(Boolean)) {
    const r = parseRepo(part, owner);
    if (r) { owner = r.split('/')[0]; names.push(r); }
  }
  const have = new Set(works().map((w) => (w.repo || '').toLowerCase()));
  const todo = [...new Set(names)].filter((n) => !have.has(n.toLowerCase())).slice(0, 30);
  setView(WORKS); state.work = null; ls.set('work', null); render();
  if (!todo.length) return names.length && toast('这些仓库都已经在作品里了');
  const ok = await dialog(`<h3>添加 ${todo.length} 个作品？</h3>
    <p class="stor-note">将从 GitHub 读取这些公开仓库，自动填好网站链接、简介，并同步提交记录为更新日志。</p>
    <ul class="add-list">${todo.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>${actions('添加')}`, () => true);
  if (!ok) return;
  const t = toast('正在读取仓库信息…', { sticky: true });
  const repos = [], missing = [];
  for (const n of todo) {
    try { repos.push(await gh(`/repos/${n}`)); }
    catch (e) { if (e.code === 'RATE') { t.close(); return toast(e.message, { error: true }); } missing.push(n.split('/')[1]); }
  }
  t.close();
  if (missing.length) toast(`找不到：${missing.join('、')}（可能是私有仓库或名字有误）`, { error: true });
  if (repos.length) await createWorksFromRepos(repos, allWorkCats()[0] || '网站');
}

// ---------- 作品：日志、分类、菜单 ----------
async function addLog(w, raw, ver, dateStr) {
  const [title, ...rest] = raw.split('\n');
  let at = Date.now();
  if (dateStr) { const d = new Date(`${dateStr}T00:00`); if (!isNaN(d) && d.toDateString() !== new Date().toDateString()) at = d.getTime() + 12 * 3600e3; }
  const l = { id: uid(), src: 'manual', at, text: title.trim(), detail: rest.join('\n').trim() || undefined, ver: ver || undefined };
  w.logs = [...(w.logs || []), l];
  if (state.logFilter === 'git') state.logFilter = 'all';
  await saveArea(w);
  await changed();
  const el = $(`.tl-item[data-log="${CSS.escape(l.id)}"]`);
  if (el && !reduceMotion.matches) el.animate([{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'none' }], { duration: 320, easing: 'cubic-bezier(.2,.8,.2,1)' });
}
function logMenu(anchor, w, id) {
  const l = (w?.logs || []).find((x) => x.id === id);
  if (!l) return;
  const undoable = async (msg, apply, revert) => { apply(); await saveArea(w); await changed(); toast(msg, { action: '撤销', onAction: async () => { revert(); await saveArea(w); await changed(); } }); };
  const items = [];
  if (l.src === 'git') {
    if (safeUrl(l.link)) items.push({ text: '在 GitHub 查看这次提交', run: () => window.open(l.link, '_blank', 'noopener') });
    items.push({ text: '隐藏这条', run: () => undoable('已隐藏这条提交记录', () => { l.hidden = true; }, () => { delete l.hidden; }) });
  } else {
    items.push({ text: '编辑', run: async () => {
      const r = await dialog(`<h3>编辑更新日志</h3><textarea name="t" maxlength="2000">${esc([l.text, l.detail].filter(Boolean).join('\n'))}</textarea>
        <label class="field"><span>版本号</span><input type="text" name="v" value="${esc(l.ver || '')}" maxlength="20"></label>${actions('保存')}`, (f) => ({ t: f.t.value.trim(), v: f.v.value.trim() }));
      if (!r || !r.t) return;
      const [title, ...rest] = r.t.split('\n');
      l.text = title.trim(); l.detail = rest.join('\n').trim() || undefined; l.ver = r.v || undefined;
      await saveArea(w); await changed();
    } });
    items.push('-', { text: '删除', danger: true, run: () => { const before = w.logs; undoable('已删除这条日志', () => { w.logs = before.filter((x) => x !== l); }, () => { w.logs = before; }); } });
  }
  openMenu(anchor, items);
}
async function setWorkCat(w, name) {
  const prev = w.category;
  if (name) w.category = name; else delete w.category;
  await saveArea(w); await changed();
  toast(name ? `「${w.title}」已归入「${name}」` : `「${w.title}」已移出分类`, { action: '撤销', onAction: async () => { if (prev) w.category = prev; else delete w.category; await saveArea(w); await changed(); } });
}
async function addWorkCat(thenAssign) {
  const name = await prompt({ title: '新建作品分类', placeholder: '例如：网站、设计、小工具、课程作业', ok: '创建' });
  if (!name) return;
  state.workCats = [...new Set([...(state.workCats || []), name])];
  await saveWorkCats();
  if (thenAssign) return setWorkCat(thenAssign, name);
  await changed();
  toast(`已新建分类「${name}」，把作品拖到它上面即可归类`);
}
async function renameWorkCat(old) {
  const name = await prompt({ title: '重命名分类', value: old, ok: '保存' });
  if (!name || name === old) return;
  state.workCats = [...new Set((state.workCats || []).map((c) => (c === old ? name : c)))];
  const ws = works().filter((w) => w.category === old);
  ws.forEach((w) => { w.category = name; });
  if (ws.length) await db.putMany('columns', ws);
  await saveWorkCats();
  if (state.workCat === old) { state.workCat = name; ls.set('workCat', name); }
  await changed();
}
async function deleteWorkCat(name) {
  const ws = works().filter((w) => w.category === name);
  if (!(await confirmBox({ title: `删除分类「${name}」？`, body: ws.length ? `里面的 ${ws.length} 个作品会变成「未分类」，作品本身不会删除。` : '这个分类是空的。', ok: '删除分类', danger: true }))) return;
  ws.forEach((w) => { delete w.category; });
  if (ws.length) await db.putMany('columns', ws);
  state.workCats = (state.workCats || []).filter((c) => c !== name);
  await saveWorkCats();
  if (state.workCat === name) { state.workCat = 'all'; ls.set('workCat', 'all'); }
  await changed();
}
function exportChangelog(w) {
  const logs = visibleLogs(w);
  if (!logs.length) return toast('还没有更新日志');
  const iso = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  let md = `# ${w.title} 更新日志\n\n`, day = '';
  if (safeUrl(w.url)) md += `网站：${w.url}\n\n`;
  for (const l of logs) {
    if (iso(l.at) !== day) { day = iso(l.at); md += `\n## ${day}\n\n`; }
    md += `- ${l.ver ? `**${l.ver}** ` : ''}${l.text}${l.sha ? ` (${l.sha.slice(0, 7)})` : ''}\n`;
    if (l.detail) md += l.detail.split('\n').map((s) => `  ${s}`).join('\n') + '\n';
  }
  const url = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
  const a = document.createElement('a');
  a.href = url; a.download = `${w.title.replace(/[\\/:*?"<>|]/g, '_')}-更新日志.md`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
function workMenu(anchor, w) {
  if (!w) return;
  const items = [{ text: '编辑…', run: () => editWork(w) }];
  if (cardsIn(w.id, false).length) items.push({ text: '快速重命名文件…', run: () => openBatchRename(cardsIn(w.id, false), w.title) });
  if (safeUrl(w.url)) items.push({ text: '预览网站', run: () => previewSite(w) });
  if (w.repo) items.push({ text: '同步 GitHub 更新日志', run: () => syncMany([w]) });
  items.push({ text: '导出更新日志（Markdown）', run: () => exportChangelog(w) });
  items.push({ label: '状态' });
  Object.entries(WSTATUS).forEach(([k, s]) => items.push({ text: s.t, swatch: s.c, checked: (w.status || 'dev') === k, run: async () => { w.status = k; await saveArea(w); await changed(); } }));
  items.push({ label: '分类' });
  allWorkCats().forEach((c) => items.push({ text: c, checked: w.category === c, run: () => setWorkCat(w, c) }));
  items.push({ text: '新建分类…', run: () => addWorkCat(w) });
  if (w.category) items.push({ text: '移出分类', run: () => setWorkCat(w, null) });
  items.push({ label: '封面' });
  [['auto', '自动'], ['image', '用图片'], ['live', '网站实时画面'], ['mono', '文字']].forEach(([k, t]) => items.push({ text: t, checked: (w.cover || 'auto') === k, run: async () => { if (k === 'auto') delete w.cover; else w.cover = k; await saveArea(w); await changed(); } }));
  items.push({ label: '颜色' });
  FCOLORS.forEach((fc, i) => items.push({ text: fc.n, swatch: fc.c, checked: workColor(w) === fc.c, run: async () => { w.color = i; await saveArea(w); await changed(); } }));
  const nWorkCards = cardsIn(w.id, false).length;
  items.push('-');
  if (nWorkCards) items.push({ text: `清空内容到回收站（${nWorkCards}）`, danger: true, run: () => clearAreaToTrash(w) });
  items.push({ text: '删除作品', danger: true, run: () => deleteArea(w) });
  openMenu(anchor, items);
}
let dragWork = null;
document.addEventListener('dragstart', (e) => {
  const t = e.target.closest?.('.work[data-work]');
  if (!t || e.target.closest('.card, a')) return;
  dragWork = t.dataset.work;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('application/x-workbench-work', dragWork);
  requestAnimationFrame(() => t.classList.add('folder-dragging'));
  document.body.classList.add('dragging-work');
});
document.addEventListener('dragover', (e) => {
  if (!dragWork) return;
  const chipEl = e.target.closest?.('.cat-chip[data-wcatdrop]');
  $$('.cat-chip.drop-active').forEach((el) => { if (el !== chipEl) el.classList.remove('drop-active'); });
  if (chipEl) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; chipEl.classList.add('drop-active'); }
});
document.addEventListener('drop', (e) => {
  if (!dragWork) return;
  const chipEl = e.target.closest?.('.cat-chip[data-wcatdrop]');
  if (chipEl) { e.preventDefault(); const w = area(dragWork); if (w) setWorkCat(w, chipEl.dataset.wcatdrop || null); }
});
document.addEventListener('dragend', () => {
  if (!dragWork) return;
  dragWork = null;
  document.body.classList.remove('dragging-work');
  $$('.folder-dragging, .cat-chip.drop-active').forEach((el) => el.classList.remove('folder-dragging', 'drop-active'));
});
document.addEventListener('contextmenu', (e) => {
  const chipEl = e.target.closest?.('.cat-chip[data-wcatdrop]');
  if (!chipEl || !chipEl.dataset.wcatdrop) return;
  e.preventDefault();
  const name = chipEl.dataset.wcatdrop;
  openMenu(chipEl, [{ text: '重命名分类', run: () => renameWorkCat(name) }, '-', { text: '删除分类', danger: true, run: () => deleteWorkCat(name) }]);
});
document.addEventListener('submit', (e) => {
  if (e.target.id !== 'logForm') return;
  e.preventDefault();
  const f = e.target, text = f.t.value.trim(), w = area(openWork());
  if (!text) return f.t.focus();
  if (!w) return;
  const ver = f.v.value.trim(), d = f.d.value;
  f.t.value = ''; f.v.value = '';
  addLog(w, text, ver, d);
});

function fmtZoneCount(n) {
  if (n < 1000) return String(n);
  if (n < 10000) return `${(Math.floor(n / 100) / 10).toFixed(n % 1000 >= 100 ? 1 : 0).replace(/\.0$/, '')}k`;
  return `${Math.floor(n / 1000)}k+`;
}
function syncZoneScrollState(zt = $('#zoneTabs')) {
  if (!zt) return;
  const maxScroll = zt.scrollWidth - zt.clientWidth;
  zt.classList.toggle('can-scroll-l', zt.scrollLeft > 2);
  zt.classList.toggle('can-scroll-r', maxScroll > 2 && zt.scrollLeft < maxScroll - 2);
}
function renderZones() {
  const zs = zones();
  const nt = cardsIn(TRASH, false).length;
  const zt = $('#zoneTabs');
  const oldTab = zt?.querySelector('.tab[aria-selected="true"]');
  const prevInk = oldTab ? { left: oldTab.offsetLeft, width: oldTab.offsetWidth, zone: oldTab.dataset.zone } : null;
  zt.innerHTML = zs.map((z) => {
    const n = cardsIn(z.id, false).length;
    return `<button role="tab" class="tab" data-zone="${z.id}" data-drop="${z.id}" aria-selected="${state.zone === z.id}" title="${esc(z.title)} · ${n} 个"><span>${esc(z.title)}</span><b>${fmtZoneCount(n)}</b></button>`;
  }).join('')
    + `<button role="tab" class="tab trash-tab" data-zone="${TRASH}" data-drop="${TRASH}" aria-selected="${state.zone === TRASH}" title="回收站 · ${nt} 个" aria-label="回收站，${nt} 个"><svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13"/></svg><b>${fmtZoneCount(nt)}</b></button>`
    + `<i class="zone-ink" id="zoneInk" aria-hidden="true"></i>`;
  const z = area(state.zone);
  const dl = $('#draftsList');
  dl.dataset.col = state.zone;
  dl.innerHTML = listHTML(state.zone, state.zone === TRASH ? '回收站是空的' : `把文件拖到「${esc(z?.title)}」`);
  let desc;
  if (state.zone === TRASH) desc = '删除的卡片先进入这里，可恢复；只有「永久删除」才会真正移除。';
  else desc = (z?.desc || '自定义功能区，放什么都行。') + (z?.ttlDays > 0 ? ` 放入超过 ${z.ttlDays} 天会自动移到回收站。` : '');
  $('#draftsDesc').textContent = desc;
  $('#zoneMenuBtn').hidden = state.zone === TRASH;
  const curZoneCount = state.zone === TRASH ? nt : cardsIn(state.zone, false).length;
  $('#draftsFoot').innerHTML = state.zone === TRASH
    ? (nt ? `<button class="btn" type="button" data-action="empty-trash">清空回收站（${nt}）</button>` : '')
    : (curZoneCount ? `<button class="btn clear-zone-btn" type="button" data-action="clear-zone">清空「${esc(z?.title)}」到回收站（${curZoneCount}）</button>` : '');
  $('#zonesBadge').textContent = fmtZoneCount(zs.reduce((n, z2) => n + cardsIn(z2.id, false).length, 0));
  renderRail(zs, nt);
  syncZoneInk(prevInk);
}
function syncZoneInk(prevInk = null) {
  const zt = $('#zoneTabs'), ink = $('#zoneInk'), active = zt?.querySelector('.tab[aria-selected="true"]');
  if (!zt || !ink || !active) return;
  if (zt.scrollWidth > zt.clientWidth + 2) {
    const aL = active.offsetLeft, aR = aL + active.offsetWidth;
    if (aL < zt.scrollLeft) zt.scrollLeft = Math.max(0, aL - 8);
    else if (aR > zt.scrollLeft + zt.clientWidth) zt.scrollLeft = aR - zt.clientWidth + 8;
  }
  syncZoneScrollState(zt);
  const pad = 6;
  const nextLeft = active.offsetLeft + pad;
  const nextW = Math.max(16, active.offsetWidth - pad * 2);
  ink.style.left = `${nextLeft}px`;
  ink.style.width = `${nextW}px`;
  if (prevInk && prevInk.zone && prevInk.zone !== state.zone && prevInk.width > 0 && !reduceMotion.matches) {
    const fromLeft = prevInk.left + pad;
    const fromW = Math.max(16, prevInk.width - pad * 2);
    const dir = nextLeft >= fromLeft ? 1 : -1;
    const minL = Math.min(fromLeft, nextLeft), maxR = Math.max(fromLeft + fromW, nextLeft + nextW);
    const stretchW = Math.min(maxR - minL, Math.max(fromW, nextW) * 1.9);
    const midLeft = dir > 0 ? (nextLeft + nextW - stretchW) : nextLeft;
    const overshootLeft = nextLeft + dir * 3.5;
    ink.animate([
      { left: `${fromLeft}px`, width: `${fromW}px`, transform: 'scaleY(1)' },
      { left: `${midLeft}px`, width: `${stretchW}px`, transform: 'scaleY(1.3)', offset: 0.36 },
      { left: `${overshootLeft}px`, width: `${Math.max(12, nextW * 0.92)}px`, transform: 'scaleY(0.94)', offset: 0.74 },
      { left: `${nextLeft}px`, width: `${nextW}px`, transform: 'scaleY(1)' },
    ], { duration: 420, easing: 'cubic-bezier(.22, 1, .36, 1)' });
    active.animate([
      { transform: 'translateY(0) scale(1)' },
      { transform: 'translateY(-2px) scale(1.06)', offset: 0.38 },
      { transform: 'translateY(0.5px) scale(0.98)', offset: 0.74 },
      { transform: 'translateY(0) scale(1)' },
    ], { duration: 380, easing: 'cubic-bezier(.22, 1.4, .36, 1)' });
    const dl = $('#draftsList'), dd = $('#draftsDesc');
    dl?.animate([
      { opacity: 0.35, transform: `translateX(${dir * 14}px) scale(.985)` },
      { opacity: 1, transform: `translateX(${-dir * 2}px) scale(1.003)`, offset: 0.68 },
      { opacity: 1, transform: 'none' },
    ], { duration: 360, easing: 'cubic-bezier(.22, 1, .36, 1)' });
    dd?.animate([
      { opacity: 0.3, transform: `translateX(${dir * 8}px)` },
      { opacity: 1, transform: 'none' },
    ], { duration: 280, easing: 'cubic-bezier(.22, 1, .36, 1)' });
  }
}

// ---------- 功能区：可收起成窄侧栏、拖左边缘调宽度、拖东西过来自动弹开 ----------
const RAIL_W = 64, DW_MIN = 240, DW_MAX = 560;
const ZONE_ICONS = {
  materials: '<rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m5 18 5-5 3 3 2-2 4 4"/>',
  drafts: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13 7 4 4"/>',
  temp: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
  [TRASH]: '<path d="M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13"/>',
};
const zoneIcon = (id) => ZONE_ICONS[id] || '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M4 10h16"/>';
let lastZoneCounts = null, peekTimer = 0;
const draftsCollapsed = () => document.body.classList.contains('drafts-collapsed');
function renderRail(zs, nt) {
  const counts = new Map([...zs.map((z) => [z.id, cardsIn(z.id, false).length]), [TRASH, nt]]);
  const item = (id, title, n, i, extra = '') => `<button class="rail-btn${state.zone === id ? ' on' : ''}${extra}" data-rail-zone="${id}" data-drop="${id}" style="--i:${i}"
      title="${esc(title)} · ${n} 个${id === TRASH ? '' : '（可以把文件拖到这里）'}" aria-label="${esc(title)}，${n} 个">
      <svg viewBox="0 0 24 24" aria-hidden="true">${zoneIcon(id)}</svg><span class="rail-name">${esc(title.slice(0, 2))}</span>${n ? `<b class="rail-n">${n > 99 ? '99+' : n}</b>` : ''}</button>`;
  $('#draftsRail').innerHTML = `<button class="rail-btn rail-expand" data-action="expand-drafts" style="--i:0" title="展开功能区（Ctrl+\\）" aria-label="展开功能区">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 6l-6 6 6 6M18 6l-6 6 6 6"/></svg></button>
    <span class="rail-sep"></span>
    ${zs.map((z, i) => item(z.id, z.title, counts.get(z.id), i + 1)).join('')}
    <span class="rail-sep rail-sep-bottom"></span>
    ${item(TRASH, '回收站', nt, zs.length + 1, ' rail-trash')}`;
  // 数量变多时，让数字跳一下（收起时在侧栏上跳，展开时在标签上跳）
  if (lastZoneCounts) {
    for (const [id, n] of counts) {
      if (n > (lastZoneCounts.get(id) || 0)) {
        const el = draftsCollapsed() ? $(`#draftsRail [data-rail-zone="${CSS.escape(id)}"]`) : $(`#zoneTabs [data-zone="${CSS.escape(id)}"] b`);
        el?.classList.add('bump');
      }
    }
  }
  lastZoneCounts = counts;
}
function syncSidebarToggleChip() {
  const chip = $('#sidebarToggleChip');
  if (!chip) return;
  const col = draftsCollapsed();
  const tip = col ? '展开右侧功能区（Ctrl+\\）' : '收起右侧功能区，扩大工作空间（Ctrl+\\）';
  chip.setAttribute('aria-pressed', String(!col));
  chip.classList.toggle('active-panel', !col);
  chip.title = tip;
  chip.dataset.tip = tip;
  chip.setAttribute('aria-label', tip);
}
function setDraftsCollapsed(v) {
  document.body.classList.toggle('drafts-collapsed', v);
  document.body.classList.remove('drafts-peek');
  ls.set('draftsCollapsed', v);
  $('#drafts').setAttribute('data-state', v ? 'collapsed' : 'open');
  syncSidebarToggleChip();
  const btn = v ? $('#draftsRail .rail-expand') : $('#drafts .collapse-drafts');
  setTimeout(() => { if (state.view && isCanvas(state.view)) positionFmt(); if (!v) syncZoneInk(); }, 450);
  return btn;
}
function toggleCanvasMax(force) {
  const next = typeof force === 'boolean' ? force : !document.body.classList.contains('canvas-maximized');
  document.body.classList.toggle('canvas-maximized', next);
  document.body.classList.remove('drafts-peek');
  $$('.canvas-max-btn').forEach((b) => {
    b.setAttribute('aria-pressed', String(next));
    b.classList.toggle('on', next);
    b.title = next ? '退出最大化工作区（F 或 Esc）' : '最大化工作空间：隐藏顶栏与右侧功能区（快捷键 F）';
  });
  setTimeout(() => { if (isCanvas(state.view)) positionFmt(); }, 80);
}
// 拖东西靠近收起或最大化的功能区：临时弹开，放下后自动收回
function peekDrafts(on) {
  clearTimeout(peekTimer);
  const canPeek = draftsCollapsed() || document.body.classList.contains('canvas-maximized');
  if (on) { if (canPeek) document.body.classList.add('drafts-peek'); return; }
  if (document.body.classList.contains('drafts-peek')) peekTimer = setTimeout(() => document.body.classList.remove('drafts-peek'), 650);
}
(function initDrafts() {
  const setDw = (val) => {
    $('#drafts').style.setProperty('--dw', `${val}px`);
    document.body.style.setProperty('--dw', `${val}px`);
  };
  const w = Math.min(DW_MAX, Math.max(DW_MIN, +ls.get('draftsW', 320) || 320));
  setDw(w);
  if (ls.get('draftsCollapsed', false)) { document.body.classList.add('drafts-collapsed', 'drafts-instant'); requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove('drafts-instant'))); }
  syncSidebarToggleChip();
  // 拖左边缘调宽度；拖到很窄松手 = 收起；从收起状态往左拖 = 展开
  const rz = $('#draftsResizer'), d = $('#drafts');
  let rs = null;
  rz.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    try { rz.setPointerCapture(e.pointerId); } catch {}
    rs = { x: e.clientX, w: draftsCollapsed() ? RAIL_W : d.getBoundingClientRect().width, moved: false };
    document.body.classList.add('drafts-resizing');
  });
  rz.addEventListener('pointermove', (e) => {
    if (!rs) return;
    const w = rs.w + (rs.x - e.clientX);
    if (Math.abs(rs.x - e.clientX) > 3) rs.moved = true;
    if (!rs.moved) return;
    if (w < 170) { d.classList.add('will-collapse'); return; }
    d.classList.remove('will-collapse');
    if (draftsCollapsed()) setDraftsCollapsed(false);
    rs.cur = Math.min(DW_MAX, Math.max(DW_MIN, w));
    setDw(rs.cur);
    syncZoneInk();
  });
  const end = () => {
    if (!rs) return;
    document.body.classList.remove('drafts-resizing');
    if (d.classList.contains('will-collapse')) {
      // 拖窄到收起：宽度恢复成上次保存的值，下次展开还是原来的宽度
      setDw(Math.min(DW_MAX, Math.max(DW_MIN, +ls.get('draftsW', 320) || 320)));
      d.classList.remove('will-collapse'); setDraftsCollapsed(true);
    }
    else if (rs.cur) { ls.set('draftsW', Math.round(rs.cur)); if (isCanvas(state.view)) positionFmt(); syncZoneInk(); }
    rs = null;
  };
  rz.addEventListener('pointerup', end);
  rz.addEventListener('pointercancel', end);
  rz.addEventListener('dblclick', () => setDraftsCollapsed(!draftsCollapsed()));
  const ztEl = $('#zoneTabs');
  if (ztEl) {
    ztEl.addEventListener('scroll', () => syncZoneScrollState(ztEl), { passive: true });
    ztEl.addEventListener('wheel', (e) => {
      if (ztEl.scrollWidth <= ztEl.clientWidth + 2) return;
      const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (dx) { e.preventDefault(); ztEl.scrollLeft += dx; syncZoneScrollState(ztEl); }
    }, { passive: false });
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => { if (!draftsCollapsed()) { syncZoneInk(); syncZoneScrollState(ztEl); } }).observe(ztEl);
    }
  }
  // 侧栏上点某个功能区：展开并切到那个区
  $('#draftsRail').addEventListener('click', (e) => {
    const b = e.target.closest('[data-rail-zone]');
    if (!b) return;
    state.zone = b.dataset.railZone; ls.set('zone', state.zone);
    renderZones(); loadThumbs();
    setDraftsCollapsed(false);
  });
  // 拖动文件 / 卡片经过收起的功能区：临时弹开
  d.addEventListener('dragenter', (e) => { if (draftsCollapsed() && (state.dragId || isFileDrag(e))) peekDrafts(true); });
  document.addEventListener('dragend', () => peekDrafts(false));
  document.addEventListener('drop', () => peekDrafts(false));
  document.addEventListener('dragleave', (e) => { if (!e.relatedTarget && document.body.classList.contains('drafts-peek')) peekDrafts(false); });
  // 画布上拖卡片（指针拖动）经过功能区或右边缘：同样弹开
  document.addEventListener('pointermove', (e) => {
    const canPeek = draftsCollapsed() || document.body.classList.contains('canvas-maximized');
    if (!cardDrag?.moved || !canPeek) return;
    const r = d.getBoundingClientRect();
    const edge = r.width > 0 ? r.left - 24 : innerWidth - 28;
    if (e.clientX >= edge) peekDrafts(true);
  }, true);
  document.addEventListener('pointerup', () => { if (document.body.classList.contains('drafts-peek') && !state.dragId) peekDrafts(false); }, true);
  // 数字跳动的动画放完就去掉，下次还能再跳
  document.addEventListener('animationend', (e) => { if (e.animationName === 'zoneBump') e.target.closest('.bump')?.classList.remove('bump'); });
})();
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
async function getCanvasPdfDoc(id) {
  if (pdfDocs.has(id)) return pdfDocs.get(id);
  const p = (async () => {
    const blob = await db.getBlob(id);
    if (!blob) return null;
    return pv.pdfDoc(blob);
  })();
  pdfDocs.set(id, p);
  try {
    const doc = await p;
    if (!doc) pdfDocs.delete(id);
    else pdfDocs.set(id, doc);
    return doc;
  } catch (e) {
    pdfDocs.delete(id);
    throw e;
  }
}
function updatePdfNavDOM(cardEl, page, total) {
  if (!cardEl) return;
  const curEl = cardEl.querySelector('.pdf-cur');
  const totEl = cardEl.querySelector('.pdf-tot');
  const prevBtn = cardEl.querySelector('[data-action="pdf-prev"]');
  const nextBtn = cardEl.querySelector('[data-action="pdf-next"]');
  if (curEl) curEl.textContent = String(page);
  if (totEl && total) totEl.textContent = String(total);
  if (prevBtn) prevBtn.disabled = page <= 1;
  if (nextBtn) nextBtn.disabled = total ? page >= total : false;
}
async function ensureCanvasPdf(img, force = false) {
  const id = img.dataset.canvasPdf;
  const card = findCard(id);
  if (!card) return;
  const cardEl = img.closest('.card');
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const zoom = Math.max(1, Math.min(2.5, cam().z || 1));
  const cssW = card.w || cardEl?.offsetWidth || 360;
  const targetW = Math.min(2800, Math.max(1200, Math.ceil((cssW * dpr * zoom) / 200) * 200));
  const rawPage = Math.max(1, card.pdfPage || 1);
  const key0 = `${id}:${rawPage}`;
  if (!force && pdfPageUrls.has(key0) && (pdfPageWidths.get(key0) || 0) >= targetW * 0.85) {
    const u = pdfPageUrls.get(key0);
    if (img.getAttribute('src') !== u) img.src = u;
    img.classList.add('loaded');
    if (card.info?.pages) updatePdfNavDOM(cardEl, rawPage, card.info.pages);
    return;
  }
  if (!img.getAttribute('src')) {
    const fallback = pdfPageUrls.get(key0) || (rawPage === 1 ? state.urls.get(`thumb:${id}`) || await thumbUrl(id) : null);
    if (fallback && img.isConnected && !img.getAttribute('src')) { img.src = fallback; img.classList.add('loaded'); }
  }
  const token = (pdfRenderTokens.get(id) || 0) + 1;
  pdfRenderTokens.set(id, token);
  const stage = img.closest('.canvas-pdf-stage');
  stage?.classList.add('pdf-loading');
  try {
    const doc = await getCanvasPdfDoc(id);
    if (!doc || pdfRenderTokens.get(id) !== token) { stage?.classList.remove('pdf-loading'); return; }
    const total = doc.numPages || 1;
    const page = Math.max(1, Math.min(rawPage, total));
    const key = `${id}:${page}`;
    if (card.info?.pages !== total || card.pdfPage !== page) {
      card.info = { ...card.info, pages: total };
      card.pdfPage = page;
      db.put('cards', card);
    }
    updatePdfNavDOM(cardEl, page, total);
    if (!force && pdfPageUrls.has(key) && (pdfPageWidths.get(key) || 0) >= targetW * 0.85) {
      const u = pdfPageUrls.get(key);
      $$(`img[data-canvas-pdf="${CSS.escape(id)}"]`).forEach((el) => {
        el.dataset.page = String(page);
        el.src = u;
        el.classList.add('loaded');
        el.closest('.canvas-pdf-stage')?.classList.remove('pdf-loading');
        updatePdfNavDOM(el.closest('.card'), page, total);
      });
      return;
    }
    const cnv = await pv.renderPdfPage(doc, page, targetW);
    if (pdfRenderTokens.get(id) !== token) return;
    if (cnv.width && cnv.height && (card.info?.w !== cnv.width || card.info?.h !== cnv.height)) {
      card.info = { ...card.info, pages: total, w: cnv.width, h: cnv.height };
      db.put('cards', card);
    }
    const pageBlob = await new Promise((r) => cnv.toBlob(r, 'image/png'));
    if (!pageBlob || pdfRenderTokens.get(id) !== token) return;
    const nextUrl = URL.createObjectURL(pageBlob);
    const oldUrl = pdfPageUrls.get(key);
    pdfPageUrls.set(key, nextUrl);
    pdfPageWidths.set(key, targetW);
    $$(`img[data-canvas-pdf="${CSS.escape(id)}"]`).forEach((el) => {
      el.dataset.page = String(page);
      el.onload = () => {
        el.classList.add('loaded');
        el.closest('.canvas-pdf-stage')?.classList.remove('pdf-loading');
        if (boardOf()?.links.length) drawLinks();
        if (hoverRef === id) { const ce = el.closest('.card.on-canvas'); if (ce) showDots(ce); }
      };
      el.src = nextUrl;
      updatePdfNavDOM(el.closest('.card'), page, total);
    });
    if (oldUrl && oldUrl !== nextUrl) setTimeout(() => URL.revokeObjectURL(oldUrl), 1000);
  } catch (e) {
    console.warn('画布 PDF 渲染失败', card.name, e);
    stage?.classList.remove('pdf-loading');
  }
}
async function setCanvasPdfPage(card, nextPage) {
  if (!card) return;
  const doc = await getCanvasPdfDoc(card.id).catch(() => null);
  const total = card.info?.pages || doc?.numPages || 1;
  const page = Math.max(1, Math.min(Math.round(nextPage) || 1, total));
  card.pdfPage = page;
  saveCard(card);
  sendCollabCardLive([card], `翻到第 ${page} 页`);
  const cached = pdfPageUrls.get(`${card.id}:${page}`);
  $$(`img[data-canvas-pdf="${CSS.escape(card.id)}"]`).forEach((img) => {
    img.dataset.page = String(page);
    updatePdfNavDOM(img.closest('.card'), page, total);
    if (cached) { img.src = cached; img.classList.add('loaded'); }
    ensureCanvasPdf(img);
  });
}
function loadCanvasMedia() {
  $$('img[data-canvas-img]').forEach(async (img) => {
    if (img.dataset.hdReady === '1' && img.getAttribute('src')) return;
    const id = img.dataset.canvasImg;
    if (!img.getAttribute('src') && state.urls.has(`thumb:${id}`)) {
      img.src = state.urls.get(`thumb:${id}`);
      img.classList.add('loaded');
    }
    const fullUrl = await urlFor(id);
    if (!fullUrl || !img.isConnected) return;
    img.dataset.hdReady = '1';
    img.onload = () => {
      img.classList.add('loaded');
      const c = findCard(id);
      if (c && img.naturalWidth && (!c.info?.w || !c.info?.h)) {
        c.info = { ...c.info, w: img.naturalWidth, h: img.naturalHeight };
        db.put('cards', c);
      }
      if (boardOf()?.links.length) drawLinks();
      if (hoverRef === id) { const el = img.closest('.card.on-canvas'); if (el) showDots(el); }
    };
    img.src = fullUrl;
  });
  $$('img[data-canvas-pdf]').forEach((img) => ensureCanvasPdf(img));
}
let pdfZoomTimer = 0;
function scheduleCanvasPdfSharpen() {
  clearTimeout(pdfZoomTimer);
  pdfZoomTimer = setTimeout(() => {
    if (isCanvas(state.view)) $$('#world img[data-canvas-pdf]').forEach((img) => ensureCanvasPdf(img));
  }, 220);
}
const thumbHydrateQ = [];
let thumbHydrateActive = 0;
const THUMB_CONCURRENCY = 6;
function drainThumbHydrate() {
  while (thumbHydrateActive < THUMB_CONCURRENCY && thumbHydrateQ.length) {
    const img = thumbHydrateQ.shift();
    if (!img || !img.isConnected || img.getAttribute('src')) continue;
    thumbHydrateActive++;
    thumbUrl(img.dataset.thumb).then((url) => {
      if (!url || !img.isConnected) return;
      img.onload = () => img.classList.add('loaded');
      img.src = url;
    }).catch(() => {}).finally(() => {
      thumbHydrateActive--;
      drainThumbHydrate();
    });
  }
}
function enqueueThumbHydrate(img) {
  if (!img || img._thumbQueued || img.getAttribute('src')) return;
  img._thumbQueued = true;
  thumbHydrateQ.push(img);
  drainThumbHydrate();
}
const thumbIO = typeof IntersectionObserver === 'function'
  ? new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        thumbIO.unobserve(entry.target);
        enqueueThumbHydrate(entry.target);
      }
    }, { rootMargin: '320px' })
  : null;
function loadThumbs(root = document) {
  const scope = root && typeof root.querySelectorAll === 'function' ? root : document;
  scope.querySelectorAll('img[data-thumb]:not([src])').forEach((img) => {
    const cached = state.urls.get(`thumb:${img.dataset.thumb}`);
    if (cached) {
      img.src = cached;
      img.classList.add('loaded');
      return;
    }
    if (!thumbIO || img.closest('#modal, #viewer, #world')) {
      enqueueThumbHydrate(img);
      return;
    }
    if (!img._thumbObserved) {
      img._thumbObserved = true;
      thumbIO.observe(img);
    }
  });
  if (scope === document) loadCanvasMedia();
}

// ---------- 无限画布 ----------
const CARD_W = 232;
const cam = () => state.cams[state.view] || (state.cams[state.view] = { x: 80, y: 60, z: 1 });
const saveCam = () => ls.set('cams', state.cams);
// ---------- 画布背景：点阵 / 方格 / 纯色，间距随缩放自适应 ----------
// 世界坐标里网格是 24 单位；屏幕上的间距始终保持在 12–48px：缩小时自动换到更粗一级的网格，
// 细的一层随缩放渐隐渐现，切换时不会突然跳变（100% 时和原来一样是 24px）
const CANVAS_BGS = { dots: '点阵', grid: '方格', none: '纯色' };
const canvasBg = () => (CANVAS_BGS[area(state.view)?.bg] ? area(state.view).bg : 'dots');
function applyCanvasBg(vp, c) {
  let s = 24 * c.z;
  while (s < 12) s *= 2;
  while (s >= 24) s /= 2;
  const f = Math.min(1, Math.max(0, (s - 12) / 12)); // 细的一层：间距越接近 12px 越淡
  const bg = canvasBg();
  if (vp.dataset.bg !== bg) vp.dataset.bg = bg;
  vp.style.setProperty('--gs', `${s}px`);
  vp.style.setProperty('--gs2', `${s * 2}px`);
  vp.style.setProperty('--gf', `${Math.round(f * 100)}%`);
  // 点阵用居中的圆点，偏移半格让两层的点落在同一组网格交点上
  vp.style.backgroundPosition = bg === 'dots' ? `${c.x - s}px ${c.y - s}px, ${c.x - s / 2}px ${c.y - s / 2}px` : `${c.x}px ${c.y}px`;
}
async function setCanvasBg(v) {
  const a = area(state.view);
  if (!a || !CANVAS_BGS[v]) return;
  if (v === 'dots') delete a.bg; else a.bg = v;
  await saveArea(a);
  applyCanvasBg($('#viewport'), cam());
  changed();
}
function canvasBgMenu(anchor) {
  const cur = canvasBg();
  openMenu(anchor, [{ label: '画布背景' }, ...Object.entries(CANVAS_BGS).map(([k, n]) => ({ text: n, checked: cur === k, run: () => setCanvasBg(k) }))]);
}
function applyCam() {
  const c = cam();
  $('#world').style.transform = `translate(${c.x}px, ${c.y}px) scale(${c.z})`;
  const vp = $('#viewport');
  applyCanvasBg(vp, c);
  $('#zoomLabel').textContent = `${Math.round(c.z * 100)}%`;
  $('#world').style.setProperty('--iz', (1 / c.z).toFixed(4)); // 选框、手柄不随缩放变粗变细
  positionFmt();
  positionCommentPop();
  scheduleCanvasPdfSharpen();
  if (c.z !== applyCam.linkZ) { applyCam.linkZ = c.z; if ($('#links')) drawLinks(); } // 缩放变了：重画箭头头部大小
}
function renderCanvas() {
  const list = cardsIn(state.view, false);
  const b = boardOf();
  // 正在编辑文字时重新渲染：先记住内容，渲染完接着编辑
  const editing = editingShape && shapeById(editingShape);
  if (editing) { const tx = $(`.shape[data-sid="${CSS.escape(editing.id)}"] .sh-tx`); if (tx) editing.text = tx.innerText.replace(/\n$/, ''); }
  if (state.bsel?.type === 'shape') { state.bsel.ids = state.bsel.ids.filter((id) => shapeById(id)); if (!state.bsel.ids.length) state.bsel = null; }
  else if (state.bsel && !b?.links.find((l) => l.id === state.bsel.id)) state.bsel = null;
  boardRendering = true;
  $('#world').innerHTML = `<svg class="links" id="links" aria-hidden="true"></svg>${list.map((c) => cardHTML(c, true)).join('')}${(b?.shapes || []).map(shapeHTML).join('')}
    <div class="group-box" id="groupBox" hidden></div><div class="guides" id="guides"></div>
    <div class="conn-dots" id="connDots" hidden>${['t', 'r', 'b', 'l'].map((k) => `<i class="cd cd-${k}" data-dot="${k}" title="拖出箭头；拖到空白处会新建一个相连的形状"></i>`).join('')}</div>
    <div class="comment-layer" id="commentLayer"></div>
    <div class="collab-layer" id="collabLayer" aria-hidden="true"></div>`;
  boardRendering = false;
  $('#canvasEmpty').hidden = list.length > 0 || (b?.shapes.length || 0) > 0 || (b?.comments.length || 0) > 0;
  $('#viewport').dataset.tool = state.tool;
  decorateBoard();
  applyCam();
  drawLinks();
  renderCommentsLayer();
  renderCommentCenterUI();
  renderCommentThreadPop();
  if (!$('#commentsPopover').hidden) renderCommentsPopover();
  renderCollabOverlay();
  if (editing) {
    editingShape = null;
    // 只有它仍是唯一选中的形状时才接着编辑；选中别的了就结束编辑（文字已写回，后台保存）
    if (isPicked(editing.id) && selIds().length === 1) startEdit(editing.id, { keep: true });
    else { editSnap = null; if (b) saveArea(b); }
  }
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
// 平移惯性（Miro 同款）：松手时按最后 0.1 秒的速度继续滑动，摩擦衰减直到停下；任何点击 / 滚轮 / 缩放立刻停住
const INERTIA_TAU = 325; // 衰减时间常数（毫秒），越大滑得越远
function stopInertia() { if (camAnim) { cancelAnimationFrame(camAnim); camAnim = 0; } }
function startInertia(vx, vy) {
  stopInertia();
  if (reduceMotion.matches || Math.hypot(vx, vy) < 0.25) return; // 太慢就不滑（px/ms）
  const c = cam(), max = 4; // 限制最高速度，避免甩飞
  const k = Math.min(1, max / Math.hypot(vx, vy)); vx *= k; vy *= k;
  let last = performance.now();
  const t0 = last;
  const step = (now) => {
    const dt = Math.min(40, now - last); last = now;
    c.x += vx * dt; c.y += vy * dt;
    const decay = Math.exp(-dt / INERTIA_TAU);
    vx *= decay; vy *= decay;
    applyCam();
    if (Math.hypot(vx, vy) > 0.02 && now - t0 < 2000) camAnim = requestAnimationFrame(step);
    else { camAnim = 0; saveCam(); }
  };
  camAnim = requestAnimationFrame(step);
}
function zoomAt(factor, clientX, clientY, animate = false) {
  stopInertia();
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
  const els = $$('#world .card, #world .shape');
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
// 整理排列：选中了多个形状 → 把这些形状排成整齐的网格；否则 → 把文件卡片排成瀑布流（放在白板形状右侧，不压住它们）
async function tidyCanvas() {
  const picked = selShapes();
  if (picked.length > 1) return tidyShapes(picked);
  const list = cardsIn(state.view, false);
  if (!list.length) {
    return toast(boardOf()?.shapes.length
      ? '「整理排列」会把文件卡片排整齐；要整理便签和形状，先选中它们（Shift + 拖动框选，或 Ctrl+A 全选）再点这里'
      : '「整理排列」会把画布上的文件卡片排成整齐的网格，现在还没有文件卡片');
  }
  await waitImgs();
  const before = list.map((c) => ({ c, x: c.x, y: c.y }));
  const sb = unionBox(boardOf()?.shapes || []);
  const ox = sb ? Math.round(sb.x + sb.w + 120) : 0, oy = sb ? Math.round(sb.y) : 0;
  const cols = Math.max(1, Math.ceil(Math.sqrt(list.length * 1.6)));
  const colW = Math.max(CARD_W, ...list.map((c) => $(`#world .card[data-id="${c.id}"]`)?.offsetWidth || canvasCardW(c)));
  const heights = new Array(cols).fill(0);
  for (const card of list) {
    const el = $(`#world .card[data-id="${card.id}"]`);
    const i = heights.indexOf(Math.min(...heights));
    card.x = ox + i * (colW + 52); card.y = oy + heights[i];
    heights[i] += (el?.offsetHeight || 80) + 24;
  }
  await db.putMany('cards', list);
  await changed();
  zoomFit();
  toast(`已整理 ${list.length} 张文件卡片`, { action: '撤销', onAction: async () => {
    before.forEach(({ c, x, y }) => { c.x = x; c.y = y; });
    await db.putMany('cards', list); await changed();
  } });
}
async function tidyShapes(list) {
  record();
  const ub = unionBox(list);
  // 按原来的位置从上到下、从左到右排序，保持大致顺序
  const sorted = [...list].sort((a, b) => (Math.abs(a.y - b.y) > 60 ? a.y - b.y : a.x - b.x));
  const cols = Math.max(1, Math.ceil(Math.sqrt(sorted.length)));
  const gap = 40, cw = Math.max(...sorted.map((s) => s.w)), rows = [];
  sorted.forEach((s, i) => { (rows[Math.floor(i / cols)] ||= []).push(s); });
  let y = ub.y;
  for (const row of rows) {
    const rh = Math.max(...row.map((s) => s.h));
    row.forEach((s, j) => { s.x = Math.round(ub.x + j * (cw + gap) + (cw - s.w) / 2); s.y = Math.round(y + (rh - s.h) / 2); });
    y += rh + gap;
  }
  await saveBoard();
  toast(`已整理 ${list.length} 个形状`, { action: '撤销', onAction: () => undoBoard() });
}

// 画布交互：中键平移、滚轮缩放、左键框选与拖动卡片
const vp = $('#viewport');
const pointers = new Map();
let pan = null, pinch = null, cardDrag = null, suppressClick = false;
// 阻止 Windows 浏览器中键按下时触发原生自动滚屏图标，确保中键平滑拖拽画布
vp.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
vp.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });
vp.addEventListener('pointerdown', (e) => {
  const mouse = e.pointerType === 'mouse';
  if (mouse && e.button > 1) return; // 右键仅用于菜单，不拖拽画布
  if (e.target.closest('.canvas-empty .btn')) return; // 空画布上的「从模板开始」按钮：别让画布抢走这次点击
  // 鼠标仅中键（e.button === 1）或按住空格可拖拽平移屏幕；左键在空白处用于拉框多选
  const forcePan = (mouse && e.button === 1) || (spaceDown && (!mouse || e.button === 0));
  if (forcePan) e.preventDefault();
  // Ctrl/⌘ + 卡片交给转换圆环；Shift + 卡片：不拖动 = 多选，拖动 = 锁定水平/垂直移动
  if (!forcePan && (e.target.closest('.card .sel') || (e.ctrlKey || e.metaKey) && e.target.closest('.card'))) return;
  const cardHandle = !forcePan && e.target.closest('[data-card-handle]');
  if (cardHandle) {
    const cardEl = cardHandle.closest('.card.on-canvas');
    const card = cardEl && findCard(cardEl.dataset.id);
    if (card) {
      if (state.bsel) {
        state.bsel = null;
        $$('#world .shape.picked').forEach((x) => { x.classList.remove('picked'); x.querySelectorAll('.sh-h').forEach((h) => h.remove()); });
        decorateBoard(); drawLinks(); positionFmt();
      }
      pickCanvasCard(card.id);
      const thumbEl = cardEl.querySelector('.thumb'), imgEl = cardEl.querySelector('.thumb-img');
      const ow = cardEl.offsetWidth, oh = cardEl.offsetHeight;
      const mediaH = thumbEl ? thumbEl.offsetHeight : 0;
      const bodyH = Math.max(0, oh - mediaH);
      const ar = (imgEl?.naturalWidth && imgEl?.naturalHeight) ? (imgEl.naturalWidth / imgEl.naturalHeight)
        : (card.info?.w && card.info?.h) ? (card.info.w / card.info.h)
        : (mediaH > 20 ? ow / mediaH : null);
      cardDrag = {
        mode: 'resize', el: cardEl, card, k: cardHandle.dataset.cardHandle,
        sx: e.clientX, sy: e.clientY,
        o: { x: card.x || 0, y: card.y || 0, w: ow, h: oh, mediaH, bodyH, ar },
        moved: false, id: e.pointerId, snapT: snapTargets(new Set(), card.id),
      };
      cardEl.classList.add('resizing');
      try { cardEl.setPointerCapture(e.pointerId); } catch {}
      e.preventDefault();
      return;
    }
  }
  if (!forcePan && pointers.size === 0 && boardDown(e)) return; // 白板：形状、连线、工具、左键空白处框选
  const cardEl = forcePan ? null : e.target.closest('.card');
  if (cardEl && !e.target.closest('.more, .export-handle, .card-expand-btn, .pdf-page-bar, .quick-rename-btn, .inline-rn-wrap, .canvas-card-hud, [data-card-handle]')) {
    const card = findCard(cardEl.dataset.id);
    if (cardEl.classList.contains('on-canvas')) pickCanvasCard(card.id);
    if (card?.locked && cardEl.classList.contains('on-canvas')) { decorateBoard(); return; } // 锁定的卡片：只能选中，不能拖
    const isMulti = cardEl.classList.contains('on-canvas') && !e.altKey && state.selected.has(card.id) && (state.selected.size > 1 || selShapes().length > 0);
    const groupCards = isMulti
      ? [...state.selected].map(findCard).filter((c) => c && c.columnId === state.view && !c.locked)
      : [card];
    const items = groupCards.map((c) => {
      const el = $(`#world .card[data-id="${CSS.escape(c.id)}"]`) || (c.id === card.id ? cardEl : null);
      return el ? { card: c, el, x: c.x || 0, y: c.y || 0, w: el.offsetWidth || canvasCardW(c), h: el.offsetHeight || 120 } : null;
    }).filter(Boolean);
    const shapeItems = isMulti ? freeShapes(selShapes()).map((s) => ({ s, el: shEl(s.id), x: s.x, y: s.y, w: s.w, h: s.h })) : [];
    cardDrag = {
      mode: 'move', el: cardEl, card, items, shapeItems,
      sx: e.clientX, sy: e.clientY, x: card.x || 0, y: card.y || 0,
      w: cardEl.offsetWidth || canvasCardW(card), h: cardEl.offsetHeight || 120,
      moved: false, id: e.pointerId, alt: e.altKey,
    };
    if (e.altKey) e.preventDefault();
    try { cardEl.setPointerCapture(e.pointerId); } catch {}
    return;
  }
  if (cardEl) return;
  // 鼠标左键不拖拽屏幕（仅中键或按住空格或触屏双指平移）
  if (mouse && !forcePan) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  try { vp.setPointerCapture(e.pointerId); } catch {}
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) }; pan = null;
  } else {
    const c = cam();
    pan = { sx: e.clientX, sy: e.clientY, x: c.x, y: c.y, moved: false, right: false, target: e.target, samples: [{ t: performance.now(), x: e.clientX, y: e.clientY }] };
  }
});
vp.addEventListener('pointerdown', stopInertia, true); // 滑动中再按下：立刻停住（像 Miro 一样「接住」画布）
// 右键拖动后不弹菜单；macOS 按下右键就会触发菜单，先压住，松手时没拖动再弹卡片菜单
let rightPanAt = 0;
vp.addEventListener('pointerup', () => { if (pan?.right) { pan.released = true; if (pan.moved) rightPanAt = Date.now(); } }, true);
vp.addEventListener('contextmenu', (e) => {
  if (pan?.right && !pan.released) { e.preventDefault(); e.stopImmediatePropagation(); pan.menuHeld = true; return; }
  if (Date.now() - rightPanAt < 400) { e.preventDefault(); e.stopImmediatePropagation(); }
}, true);
vp.addEventListener('pointermove', (e) => {
  if (boardMove(e)) return;
  if (cardDrag && e.pointerId === cardDrag.id) {
    if (cardDrag.mode === 'resize') {
      const z = cam().z, dx = (e.clientX - cardDrag.sx) / z, dy = (e.clientY - cardDrag.sy) / z;
      if (!cardDrag.moved && Math.hypot(e.clientX - cardDrag.sx, e.clientY - cardDrag.sy) < 3) return;
      if (!cardDrag.moved) {
        cardDrag.moved = true;
        hideDots();
        cardDrag.el.style.zIndex = topOrder(state.view) + 1;
        document.body.classList.add('is-dragging-card');
      }
      const { o, k } = cardDrag, minW = 140, maxW = 4800, tol = 7 / z, snapOn = !(e.ctrlKey || e.metaKey);
      let x = o.x, y = o.y, w = o.w, h = o.h, gx = null, gy = null, sizeTag = '';
      if (o.ar) {
        if (k === 'e' || k === 'w') {
          w = Math.min(maxW, Math.max(minW, k === 'e' ? o.w + dx : o.w - dx));
          if (snapOn) {
            gx = nearest([k === 'e' ? o.x + w : o.x + o.w - w], cardDrag.snapT.xs, tol);
            if (gx) w = Math.min(maxW, Math.max(minW, k === 'e' ? w + gx.d : w - gx.d));
            else {
              const sw = nearest([w], cardDrag.snapT.ws, tol);
              if (sw) { w = Math.min(maxW, Math.max(minW, w + sw.d)); sizeTag = '等宽'; }
            }
          }
          if (k === 'w') x = o.x + o.w - w;
        } else if (k === 's' || k === 'n') {
          let mh = Math.max(60, k === 's' ? o.mediaH + dy : o.mediaH - dy);
          if (snapOn) {
            const candY = k === 's' ? o.y + mh + o.bodyH : o.y + o.h - (mh + o.bodyH);
            gy = nearest([candY], cardDrag.snapT.ys, tol);
            if (gy) mh = Math.max(60, k === 's' ? mh + gy.d : mh - gy.d);
          }
          w = Math.min(maxW, Math.max(minW, mh * o.ar));
          if (snapOn && !gy) {
            const sw = nearest([w], cardDrag.snapT.ws, tol);
            if (sw) { w = Math.min(maxW, Math.max(minW, w + sw.d)); sizeTag = '等宽'; }
          }
          x = o.x + (o.w - w) / 2;
        } else {
          const sgnX = k.includes('e') ? 1 : -1, sgnY = k.includes('s') ? 1 : -1;
          const dwX = sgnX * dx, dwY = sgnY * dy * o.ar;
          const dw = Math.abs(dwX) >= Math.abs(dwY) ? dwX : dwY;
          w = Math.min(maxW, Math.max(minW, o.w + dw));
          if (snapOn) {
            const edgeX = k.includes('e') ? o.x + w : o.x + o.w - w;
            gx = nearest([edgeX], cardDrag.snapT.xs, tol);
            if (gx) w = Math.min(maxW, Math.max(minW, k.includes('e') ? w + gx.d : w - gx.d));
            else {
              const candH = w / o.ar + o.bodyH;
              const edgeY = k.includes('s') ? o.y + candH : o.y + o.h - candH;
              gy = nearest([edgeY], cardDrag.snapT.ys, tol);
              if (gy) {
                const targetH = Math.max(60 + o.bodyH, k.includes('s') ? candH + gy.d : candH - gy.d);
                w = Math.min(maxW, Math.max(minW, (targetH - o.bodyH) * o.ar));
              } else {
                const sw = nearest([w], cardDrag.snapT.ws, tol);
                if (sw) { w = Math.min(maxW, Math.max(minW, w + sw.d)); sizeTag = '等宽'; }
              }
            }
          }
          if (k.includes('w')) x = o.x + o.w - w;
        }
        h = w / o.ar + o.bodyH;
        if (k.includes('n')) y = o.y + o.h - h;
      } else {
        if (k.includes('e')) {
          w = Math.min(maxW, Math.max(minW, o.w + dx));
          if (snapOn && (gx = nearest([x + w], cardDrag.snapT.xs, tol))) w += gx.d;
          else if (snapOn) { const sw = nearest([w], cardDrag.snapT.ws, tol); if (sw) { w += sw.d; sizeTag = '等宽'; } }
        }
        if (k.includes('w')) {
          x = o.x + dx;
          if (snapOn && (gx = nearest([x], cardDrag.snapT.xs, tol))) x += gx.d;
          w = Math.min(maxW, Math.max(minW, o.x + o.w - x));
          x = o.x + o.w - w;
        }
        if (k.includes('s')) h = Math.max(60, o.h + dy);
        if (k.includes('n')) { h = Math.max(60, o.h - dy); y = o.y + o.h - h; }
      }
      if (e.altKey) { x = o.x + (o.w - w) / 2; y = o.y + (o.h - h) / 2; gx = gy = null; }
      cardDrag.cur = { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
      cardDrag.el.style.left = `${cardDrag.cur.x}px`;
      cardDrag.el.style.top = `${cardDrag.cur.y}px`;
      cardDrag.el.style.width = `${cardDrag.cur.w}px`;
      showGuides(gx, gy, cardDrag.cur);
      showSizeTip(e, cardDrag.cur.w, cardDrag.el.offsetHeight || cardDrag.cur.h, sizeTag);
      drawLinks();
      sendCollabCardLive([{ ...cardDrag.card, x: cardDrag.cur.x, y: cardDrag.cur.y, w: cardDrag.cur.w }], '正在缩放卡片');
      return;
    }
    let dx = e.clientX - cardDrag.sx, dy = e.clientY - cardDrag.sy;
    if (!cardDrag.moved && Math.hypot(dx, dy) < 4) return;
    if (!cardDrag.moved) {
      cardDrag.moved = true;
      hideDots();
      const topZ = topOrder(state.view);
      (cardDrag.items || [{ el: cardDrag.el }]).forEach((it, i) => {
        it.el.classList.add('lifting');
        it.el.style.zIndex = topZ + 1 + i;
      });
      document.body.classList.add('is-dragging-card');
      cardDrag.snapT = snapTargets(
        new Set((cardDrag.shapeItems || []).map((it) => it.s.id)),
        new Set((cardDrag.items || [{ card: cardDrag.card }]).map((it) => it.card.id)),
      );
      if (cardDrag.alt) {
        // Alt + 拖动：原卡片留在原地（半透明占位），拖走的是副本
        const ph = cardDrag.el.cloneNode(true);
        ph.removeAttribute('data-id'); ph.classList.remove('lifting'); ph.classList.add('copy-source');
        cardDrag.el.before(ph); cardDrag.ph = ph;
        cardDrag.el.classList.add('copying');
      }
    }
    const z = cam().z, tol = 7 / z, snapOn = !(e.ctrlKey || e.metaKey);
    const lock = e.shiftKey ? (Math.abs(dx) > Math.abs(dy) ? 'x' : 'y') : null; // Shift：只水平或只垂直
    let mx = lock === 'y' ? 0 : dx / z;
    let my = lock === 'x' ? 0 : dy / z;
    const list = cardDrag.items?.length ? cardDrag.items : [{ card: cardDrag.card, el: cardDrag.el, x: cardDrag.x, y: cardDrag.y, w: cardDrag.w || cardDrag.el.offsetWidth, h: cardDrag.h || cardDrag.el.offsetHeight }];
    const ob = unionBox(list);
    let gx = null, gy = null;
    if (snapOn && cardDrag.snapT) {
      const bx = ob.x + mx, by = ob.y + my;
      if (lock !== 'y') {
        gx = nearest([bx, bx + ob.w / 2, bx + ob.w], cardDrag.snapT.xs, tol)
          || nearestGapX({ x: bx, y: by, w: ob.w, h: ob.h }, cardDrag.snapT.boxes, tol);
      }
      if (lock !== 'x') {
        gy = nearest([by, by + ob.h / 2, by + ob.h], cardDrag.snapT.ys, tol)
          || nearestGapY({ x: bx, y: by, w: ob.w, h: ob.h }, cardDrag.snapT.boxes, tol);
      }
      if (gx) mx += gx.d;
      if (gy) my += gy.d;
    }
    for (const it of list) {
      it.el.style.left = `${Math.round(it.x + mx)}px`;
      it.el.style.top = `${Math.round(it.y + my)}px`;
    }
    for (const sit of cardDrag.shapeItems || []) {
      sit.s.x = Math.round(sit.x + mx);
      sit.s.y = Math.round(sit.y + my);
      if (sit.el) { sit.el.style.left = `${sit.s.x}px`; sit.el.style.top = `${sit.s.y}px`; }
    }
    showGuides(gx, gy, { x: Math.round(ob.x + mx), y: Math.round(ob.y + my), w: ob.w, h: ob.h });
    drawLinks();
    highlightZoneUnder(e.clientX, e.clientY, cardDrag.el);
    sendCollabCardLive(list.map((it) => ({ ...it.card, x: Math.round(it.x + mx), y: Math.round(it.y + my) })), '正在移动卡片');
    if (cardDrag.shapeItems?.length) sendCollabShapeLive(cardDrag.shapeItems.map((sit) => sit.s), '正在移动形状');
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
    // 记录最近 100ms 的轨迹，用来算松手时的速度
    const now = performance.now();
    pan.samples.push({ t: now, x: e.clientX, y: e.clientY });
    while (pan.samples.length > 2 && now - pan.samples[0].t > 100) pan.samples.shift();
    applyCam();
  }
});
// 复制一张画布卡片到指定位置（文件连同内容一起复制；便签复制文字）
async function duplicateCardAt(card, pos) {
  if (card.kind === 'file') {
    if (!(await ensureAccess())) return renderCanvas();
    const b = await db.getBlob(card.id);
    if (!b) { renderCanvas(); return toast('找不到文件内容，无法复制', { error: true }); }
    const m = /^(.*?)(\.[^.]+)?$/.exec(card.name);
    const [c] = await addFiles([new File([b], `${m[1]} 副本${m[2] || ''}`, { type: card.type || b.type })], card.columnId, null, pos, { quiet: true, extra: { sourceId: card.sourceId || card.id } });
    if (c) toast(`已复制「${card.name}」`, { action: '撤销', onAction: () => trashCard(c.id) });
    return;
  }
  const now = Date.now();
  const c = { ...card, id: uid(), x: Math.round(pos.x), y: Math.round(pos.y), order: topOrder(card.columnId), createdAt: now, updatedAt: now, enteredAt: now };
  delete c.projectId; delete c.projectName;
  await db.put('cards', c);
  state.cards.push(c);
  await changed();
  toast('已复制便签', { action: '撤销', onAction: () => trashCard(c.id) });
}
async function endPointer(e) {
  if (await boardUp(e)) return;
  if (cardDrag && e.pointerId === cardDrag.id) {
    const d = cardDrag; cardDrag = null;
    setTimeout(flushDeferredCollab, 0);
    document.body.classList.remove('is-dragging-card');
    clearDropUI();
    if (d.mode === 'resize') {
      d.el.classList.remove('resizing');
      clearGuides(); hideSizeTip();
      if (!d.moved || !d.cur) return;
      suppressClick = true; setTimeout(() => { suppressClick = false; }, 0);
      d.card.x = d.cur.x; d.card.y = d.cur.y; d.card.w = d.cur.w;
      d.card.order = topOrder(state.view);
      await saveCard(d.card);
      const pdfImg = d.el.querySelector('img[data-canvas-pdf]');
      if (pdfImg) ensureCanvasPdf(pdfImg);
      await changed();
      return;
    }
    if (!d.moved) return;
    clearGuides();
    suppressClick = true; setTimeout(() => { suppressClick = false; }, 0);
    (d.items || [{ el: d.el }]).forEach((it) => it.el.classList.remove('lifting', 'copying'));
    d.ph?.remove();
    if (d.alt) {
      if (e.type !== 'pointerup') return renderCanvas();
      // 原卡片回到原位，在松手的位置放一个副本
      const pos = { x: parseFloat(d.el.style.left), y: parseFloat(d.el.style.top) };
      d.el.style.left = `${d.card.x || 0}px`; d.el.style.top = `${d.card.y || 0}px`;
      return duplicateCardAt(d.card, pos);
    }
    const zone = e.type === 'pointerup' ? zoneUnder(e.clientX, e.clientY, d.el) : null;
    if (zone === CANVAS_PICK || zone === PICK) {
      renderCanvas();
      const id = zone === CANVAS_PICK ? await pickCanvas(d.card.columnId) : await pickFolder();
      if (!id) return;
      const cards = d.items?.length > 1 ? d.items.map((it) => it.card) : [d.card];
      return zone === CANVAS_PICK ? moveMany(cards.map((c) => c.id), id) : archiveCards(cards, id);
    }
    if (zone) {
      if (d.items?.length > 1) return moveMany(d.items.map((it) => it.card.id), zone);
      return moveCard(d.card.id, zone, 0);
    }
    if (d.items?.length > 1 || d.shapeItems?.length) {
      const topZ = topOrder(state.view);
      d.items.forEach((it, i) => {
        it.card.x = parseFloat(it.el.style.left);
        it.card.y = parseFloat(it.el.style.top);
        it.card.order = topZ + i;
        it.card.updatedAt = Date.now();
      });
      await db.putMany('cards', d.items.map((it) => it.card));
      if (d.shapeItems?.length) await saveArea(boardOf());
      await changed();
      return;
    }
    d.card.x = parseFloat(d.el.style.left); d.card.y = parseFloat(d.el.style.top);
    d.card.order = topOrder(state.view);
    await saveCard(d.card);
    await changed();
    return;
  }
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
  if (pan) {
    vp.classList.remove('panning'); saveCam();
    // 惯性：松手前最后一小段在动才滑（停住再松手就不滑）
    if (pan.moved && e.type === 'pointerup' && !pointers.size && pan.samples?.length > 1) {
      const now = performance.now(), s = pan.samples, a = s[0], b = s[s.length - 1];
      const dt = b.t - a.t;
      if (dt > 8 && now - b.t < 60) startInertia((b.x - a.x) / dt, (b.y - a.y) / dt);
    }
    if (pan.right && pan.moved) rightPanAt = Date.now();
    else if (pan.right && pan.menuHeld && e.type === 'pointerup') {
      const cardEl = pan.target?.closest?.('.card');
      if (cardEl && findCard(cardEl.dataset.id)) cardMenu($('.more', cardEl), findCard(cardEl.dataset.id));
    }
  }
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
  // 高亮指针下面的那个放置目标（功能区标签、收起侧栏上的图标或列表）
  el.style.pointerEvents = 'none';
  const t = document.elementFromPoint(x, y)?.closest('#drafts [data-drop], #draftsList, .view-tab[data-drop]');
  el.style.pointerEvents = '';
  const id = t && (t.dataset.drop || t.dataset.col);
  if (id && id !== state.view) t.classList.add('drop-active');
}
vp.addEventListener('wheel', (e) => {
  e.preventDefault();
  stopInertia();
  // 触控板双指捏合（浏览器会带上 Ctrl）→ 缩放
  if (e.ctrlKey || e.metaKey) return zoomAt(Math.exp(-e.deltaY * 0.0025), e.clientX, e.clientY);
  // 鼠标滚轮直接缩放（以鼠标位置为中心）；触控板双指滑动仍然是平移，Shift + 滚轮左右平移
  // 区分方法：鼠标滚轮按「格」滚 —— Chrome / Edge / Safari 里每格 wheelDelta 是 120 的整数倍，Firefox 里按「行」滚；
  // 触控板滑动的数值是连续的小步，通常不是 120 的倍数，还常带横向分量（系统缩放、浏览器缩放不影响这个判断）
  // 上下滚动一律是缩放（不再猜是鼠标还是触控板：高精度滚轮、平滑滚动的鼠标以前会被误判成触控板而变成上下平移）；
  // 只有明显的横向滑动（触控板左右滑）或 Shift + 滚轮才平移画面
  const lineMode = e.deltaMode === 1, pageMode = e.deltaMode === 2;
  const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY);
  if (!e.shiftKey && !horizontal && e.deltaY) {
    const d = Math.max(-150, Math.min(150, e.deltaY * (lineMode ? 40 : pageMode ? 400 : 1)));
    return zoomAt(Math.exp(-d * 0.0018), e.clientX, e.clientY);
  }
  const c = cam();
  if (e.shiftKey && !e.deltaX) { c.x -= e.deltaY; } else { c.x -= e.deltaX; } // 横向平移（纵向交给缩放）
  applyCam();
  clearTimeout(vp._t); vp._t = setTimeout(saveCam, 200);
}, { passive: false });
vp.addEventListener('dblclick', async (e) => {
  // 第一下点击会选中形状并重绘画布，原来被点的元素已被替换，事件目标可能变成画布背景；
  // 所以按鼠标位置重新找一次「真正点到的东西」，避免在已有便签上又新建一张
  const hit = document.elementFromPoint(e.clientX, e.clientY) || e.target;
  if (hit.closest('.comment-pin, .comment-thread-pop, .comments-popover') || e.target.closest('.comment-pin, .comment-thread-pop, .comments-popover')) return;
  const hitCard = hit.closest('.card.on-canvas') || e.target.closest('.card.on-canvas');
  if (hitCard) {
    if (hit.closest('.pdf-page-bar, [data-card-handle], .more, .sel, .export-handle, .card-expand-btn, .quick-rename-btn, .inline-rn-wrap, .canvas-card-hud')) return;
    return preview(hitCard.dataset.id);
  }
  if (hit.closest('.card, .fmt-bar, .canvas-palette, .canvas-tools, .canvas-workspace-head') || e.target.closest('.card, .fmt-bar')) return;
  const sh = hit.closest('.shape') || e.target.closest('.shape');
  // 画框：只有双击标题才改名；双击框内空白处不做任何事
  const inFrameBody = sh?.classList.contains('st-frame') && !hit.closest('.sh-tx');
  if (sh && !inFrameBody) return editingShape === sh.dataset.sid ? undefined : startEdit(sh.dataset.sid);
  if (editingShape) return;
  const ln = hit.closest('[data-lid]') || e.target.closest('[data-lid]');
  if (ln) return editLinkLabel(ln.dataset.lid);
  // 双击空白处不再自动新建便签（用左侧工具栏的便签工具或按 N）
});

// ---------- 画布白板：便签、形状、文字、箭头连线（存于画布区域的 shapes / links） ----------
const SH_COLORS = [
  { n: '黄', bg: '#fff1a6', bd: '#d4b235' }, { n: '橙', bg: '#ffdcbd', bd: '#dc8c42' }, { n: '粉', bg: '#ffd5e0', bd: '#d76a8a' },
  { n: '紫', bg: '#e6dcff', bd: '#9076dc' }, { n: '蓝', bg: '#d4e5ff', bd: '#5788d8' }, { n: '绿', bg: '#d2f1d8', bd: '#47a65f' },
  { n: '灰', bg: '#e7e7ea', bd: '#97999f' }, { n: '白', bg: '#ffffff', bd: '#c2c3c9' },
];
const LINK_COLORS = [null, '#f2643b', '#d6455d', '#3b82f6', '#2f9e55', '#8b5cf6'];
const SHAPE_NAMES = { sticky: '便签', rect: '矩形', round: '圆角矩形', ellipse: '圆形', diamond: '菱形', text: '文字', frame: '画框' };
const SH_DEF = {
  sticky: { w: 200, h: 200, fill: 0, fs: 18, al: 'center' }, rect: { w: 200, h: 120, fill: 4, fs: 16, al: 'center' },
  round: { w: 200, h: 120, fill: 5, fs: 16, al: 'center' }, ellipse: { w: 160, h: 160, fill: 2, fs: 16, al: 'center' },
  diamond: { w: 180, h: 140, fill: 3, fs: 16, al: 'center' }, text: { w: 240, h: 44, fill: 'none', fs: 20, al: 'left' },
  // 画框：纯背景的分组框，永远在最底层（箭头画在它上面），拖动时带着框里的东西一起走
  frame: { w: 640, h: 420, fill: 'none', fs: 14, al: 'left' },
};
const FONT_SIZES = [12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 64, 80, 96];
const TOOL_KEYS = { v: 'select', n: 'sticky', t: 'text', r: 'rect', o: 'ellipse', d: 'diamond', a: 'frame', l: 'arrow', c: 'comment' };
const isFrame = (s) => s?.t === 'frame';
// 完全落在画框范围内的形状 / 卡片
const insideBox = (f, b) => b.x >= f.x - 1 && b.y >= f.y - 1 && b.x + b.w <= f.x + f.w + 1 && b.y + b.h <= f.y + f.h + 1;
const TOOL_HINT = {
  frame: '拖出一个画框，把相关内容框在一起；拖动画框时，框里的便签、形状和文件会一起移动',
  sticky: '点击贴一张便签，或拖出大小', text: '点击放置文字框，然后直接输入', rect: '点击放置，或拖出大小（Shift 画正方形）',
  ellipse: '点击放置，或拖出大小（Shift 画正圆）', diamond: '点击放置，或拖出大小', arrow: '从一个对象拖到另一个对象',
  comment: '点击画布或任意卡片 / 形状添加备注评论，协作者会收到实时提醒',
};
const ALIGN_OPS = { smart: '✨ 智能对齐行列', l: '左对齐', ch: '水平居中', r: '右对齐', t: '顶部对齐', cv: '垂直居中', b: '底部对齐', dh: '横向均匀分布', dv: '纵向均匀分布', ew: '统一等宽' };
state.tool = 'select';
state.toolLock = false;
state.bsel = null; // { type: 'shape', ids: [...] } | { type: 'link', id }
let editingShape = null, editSnap = null, editOrig = '', bd = null, hoverRef = null, boardRendering = false;
let spaceDown = false, fmtPop = null, boardClip = null, lastPointer = null, pasteN = 0;
const boardOf = (id = state.view) => { const a = area(id); if (!a || a.kind !== 'canvas') return null; a.shapes ||= []; a.links ||= []; a.comments ||= []; return a; };
const shapeById = (id) => boardOf()?.shapes.find((s) => s.id === id);
const linkById = (id) => boardOf()?.links.find((l) => l.id === id);
const shColor = (s) => (s.fill === 'none' || s.fill == null ? null : SH_COLORS[s.fill] || SH_COLORS[0]);
const isTypingTarget = (t) => t?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t?.tagName || '');
const selIds = () => (state.bsel?.type === 'shape' ? state.bsel.ids : []);
const isPicked = (id) => selIds().includes(id);
const selShapes = () => selIds().map(shapeById).filter(Boolean);
const pickShapes = (ids) => (ids.length ? { type: 'shape', ids: [...new Set(ids)] } : null);
const unionBox = (list) => {
  if (!list.length) return null;
  const x1 = Math.min(...list.map((b) => b.x)), y1 = Math.min(...list.map((b) => b.y));
  return { x: x1, y: y1, w: Math.max(...list.map((b) => b.x + b.w)) - x1, h: Math.max(...list.map((b) => b.y + b.h)) - y1 };
};
const shEl = (id) => $(`#world .shape[data-sid="${CSS.escape(id)}"]`);
// ---- 锁定：锁住的形状 / 卡片不能拖动、缩放、编辑、删除，框选也选不到（单击仍可选中，用来解锁） ----
const LOCK_SVG = '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
const isLocked = (x) => !!(x && (x.lk || x.locked));
const freeShapes = (list) => list.filter((s) => !s.lk);
async function toggleLock(on) {
  const shapes = selShapes(), cards = [...new Set([...selectedCanvasCards(), ...(state.pickedCard ? [findCard(state.pickedCard)] : [])])].filter((c) => c && c.columnId === state.view);
  if (!shapes.length && !cards.length) return;
  if (on == null) on = ![...shapes, ...cards].every(isLocked); // 有没锁的 → 全部锁上；全锁着 → 全部解锁
  if (shapes.length) { record(); shapes.forEach((s) => { if (on) s.lk = true; else delete s.lk; }); await saveArea(boardOf()); }
  if (cards.length) { cards.forEach((c) => { if (on) c.locked = true; else delete c.locked; c.updatedAt = Date.now(); }); await db.putMany('cards', cards); }
  await changed();
  toast(`${on ? '已锁定' : '已解锁'} ${shapes.length + cards.length} 个对象${on ? '（Ctrl + Shift + L 解锁）' : ''}`);
}

function shapeHTML(s) {
  const col = shColor(s);
  const sel = isPicked(s.id), single = sel && selIds().length === 1;
  // 画框始终压在最底层：比箭头层（z-index 0）、所有形状和卡片都低，框之间仍保持各自先后
  const zi = isFrame(s) ? -100000 + Math.max(-50000, Math.min(50000, Number.isFinite(s.z) ? s.z : 0)) : (Number.isFinite(s.z) ? s.z : 1);
  const style = `left:${Math.round(s.x)}px;top:${Math.round(s.y)}px;width:${Math.round(s.w)}px;height:${Math.round(s.h)}px;z-index:${zi};`
    + `--fs:${s.fs || 16}px;--sb:${col ? col.bg : 'transparent'};--sd:${col ? col.bd : 'var(--text-3)'};--tc:${col ? '#1f2023' : 'var(--text)'};text-align:${s.al || 'center'}`;
  const bg = s.t === 'diamond'
    ? '<svg class="sh-bg" viewBox="0 0 100 100" preserveAspectRatio="none"><polygon points="50,1.5 98.5,50 50,98.5 1.5,50" vector-effect="non-scaling-stroke"/></svg>'
    : '<div class="sh-bg"></div>';
  // 整条边都能拖（看不见的感应条），四个角另有放大的感应区；看得见的小方块只是提示
  const handles = single && !s.lk ? ['n', 'e', 's', 'w'].map((k) => `<i class="sh-edge se-${k}" data-handle="${k}"></i>`).join('')
    + ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((k) => `<i class="sh-h h-${k}" data-handle="${k}"></i>`).join('') : '';
  return `<div class="shape st-${s.t}${col ? '' : ' nofill'}${sel ? ' picked' : ''}${s.b ? ' bold' : ''}${s.frame ? ' frame' : ''}${s.va === 'top' ? ' va-top' : ''}${s.lk ? ' locked' : ''}" data-sid="${s.id}" style="${style}">${bg}<div class="sh-tx" data-ph="${s.t === 'text' ? '输入文字' : isFrame(s) ? '画框' : '双击输入'}">${esc(s.text || '')}</div>${handles}${s.lk ? `<i class="lock-badge" title="已锁定">${LOCK_SVG}</i>` : ''}</div>`;
}
// 重绘后的装饰：便签字号自适应、多选外框
function decorateBoard() {
  autoContrast(); // 文字 / 边框 / 箭头颜色按实际背景自动取对比色，不会出现灰字压灰底
  fitAllShapeText(); // 所有形状：文字放不下就缩小字号，绝不溢出
  const box = $('#groupBox');
  if (!box) return;
  // 多选外框：形状 + 卡片一起算；没锁的对象有 2 个以上时，四个角可以拖动整体等比缩放
  const g = groupItems();
  const all = [...g.shapes.map((x) => x.o), ...g.cards.map((x) => x.o)];
  const n = selShapes().length + selectedCanvasCards().length;
  const ub = n > 1 ? unionBox([...selShapes(), ...selectedCanvasCards().map(cardBox).filter(Boolean)]) : null;
  box.hidden = !ub;
  box.classList.toggle('can-scale', all.length > 1);
  if (!box.firstElementChild) box.innerHTML = ['nw', 'ne', 'se', 'sw'].map((k) => `<i class="gb-h gb-${k}" data-ghandle="${k}" title="拖动角点：整体等比缩放（Alt 以中心缩放）"></i>`).join('');
  if (ub) Object.assign(box.style, { left: `${ub.x}px`, top: `${ub.y}px`, width: `${ub.w}px`, height: `${ub.h}px` });
}
// ---- 自动对比度 ----
// 每个形状的文字颜色按「它实际压在什么上面」来选：自己的填充色 → 下面最上层的有色形状 / 画框 → 画布底色，
// 在深色 / 浅色两种字色里挑对比度高的（WCAG 对比度），箭头颜色在画布底色上对比不足 3:1 时自动提亮 / 压暗
const TXT_DARK = [31, 32, 35], TXT_LIGHT = [241, 241, 243];
function parseRGB(str) {
  const s = String(str || '').trim();
  let m = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (m) { const h = m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1]; return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); }
  m = s.match(/rgba?\(([^)]+)\)/i);
  if (m) { const p = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat); if (p.length >= 3 && (p[3] == null || p[3] > 0.05)) return p.slice(0, 3); }
  return null;
}
const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const mixRGB = (a, b, t) => a.map((v, i) => Math.round(v * (1 - t) + b[i] * t));
const rgbStr = (c) => `rgb(${c.map(Math.round).join(',')})`;
function canvasBgRGB() {
  for (let el = $('#viewport'); el; el = el.parentElement) {
    const c = parseRGB(getComputedStyle(el).backgroundColor);
    if (c) return c;
  }
  return parseRGB(getComputedStyle(document.body).backgroundColor) || [255, 255, 255];
}
// 在背景 bg 上可读的文字色
const readableOn = (bg) => (contrast(TXT_DARK, bg) >= contrast(TXT_LIGHT, bg) ? TXT_DARK : TXT_LIGHT);
// 颜色 c 放在背景 bg 上对比不足 min 时，往白或黑一点点推，直到够清楚
function ensureContrast(c, bg, min = 3) {
  if (contrast(c, bg) >= min) return c;
  const to = lum(bg) < 0.4 ? [255, 255, 255] : [0, 0, 0];
  for (let t = 0.1; t <= 1; t += 0.1) { const m = mixRGB(c, to, t); if (contrast(m, bg) >= min) return m; }
  return to;
}
let contrastCanvasBg = null;
function autoContrast() {
  const b = boardOf();
  if (!b) return;
  const base = canvasBgRGB();
  contrastCanvasBg = base;
  const zOf = (s) => (isFrame(s) ? -1e6 + (Number.isFinite(s.z) ? s.z : 0) : (Number.isFinite(s.z) ? s.z : 1));
  // 每个形状自身的「底色」（不透明的有色形状直接用填充色；画框是淡淡的一层，按 24% 混到画布色上）
  const own = (s) => {
    const col = shColor(s);
    if (!col) return null;
    const c = parseRGB(col.bg);
    return isFrame(s) ? mixRGB(base, c, 0.24) : c;
  };
  const filled = b.shapes.filter((s) => own(s)).sort((x, y) => zOf(y) - zOf(x)); // 上层在前
  for (const s of b.shapes) {
    const el = shEl(s.id);
    if (!el) continue;
    let bg = isFrame(s) ? null : own(s);
    if (!bg) {
      // 画框标题在框外面，压在画布上；其他没有填充的形状找它中心点下面最上层的有色形状
      const cx = s.x + s.w / 2, cy = s.y + s.h / 2;
      const under = isFrame(s) ? null : filled.find((u) => u !== s && zOf(u) < zOf(s) && cx >= u.x && cx <= u.x + u.w && cy >= u.y && cy <= u.y + u.h);
      bg = under ? own(under) : base;
    }
    const tc = readableOn(bg);
    el.style.setProperty('--tc', rgbStr(tc));
    // 没有填充的形状：边框也按底色取一个看得清的中间灰
    if (!shColor(s)) el.style.setProperty('--sd-auto', rgbStr(mixRGB(tc, bg, 0.45)));
    else el.style.removeProperty('--sd-auto');
  }
}
// 切换深色 / 浅色主题时重新计算（画布底色变了）
const recontrast = () => requestAnimationFrame(() => { if (isCanvas(state.view)) { autoContrast(); drawLinks(); } });
new MutationObserver(recontrast).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', recontrast);
// 箭头颜色：在画布底色上不够清楚时自动调整（默认色用主题文字色，本来就清楚）
const linkColorFor = (color) => {
  if (!color) return 'var(--text-2)';
  const c = parseRGB(color), bg = contrastCanvasBg || canvasBgRGB();
  return c ? rgbStr(ensureContrast(c, bg, 3)) : color;
};
function cardBox(c) {
  const el = $(`#world .card[data-id="${CSS.escape(c.id)}"]`);
  return el ? { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight } : null;
}
// 参与整体缩放的对象（锁定的不动）
function groupItems() {
  const shapes = freeShapes(selShapes()).map((s) => ({ s, o: { x: s.x, y: s.y, w: s.w, h: s.h, fs: s.fs || SH_DEF[s.t]?.fs || 16 } }));
  const cards = selectedCanvasCards().filter((c) => !c.locked).map((c) => {
    const el = $(`#world .card[data-id="${CSS.escape(c.id)}"]`);
    return el ? { card: c, el, o: { x: c.x || 0, y: c.y || 0, w: el.offsetWidth, h: el.offsetHeight } } : null;
  }).filter(Boolean);
  return { shapes, cards };
}

// ---- 撤销 / 重做（每个画布各自一份历史） ----
const hist = new Map();
const H = () => { let h = hist.get(state.view); if (!h) hist.set(state.view, (h = { u: [], r: [] })); return h; };
const snapBoard = () => { const b = boardOf(); return JSON.stringify({ s: b.shapes, l: b.links, c: b.comments }, (k, v) => (k === '_t' ? undefined : v)); };
function record(snap = snapBoard()) {
  const h = H();
  if (h.u[h.u.length - 1] === snap) return;
  h.u.push(snap);
  if (h.u.length > 100) h.u.shift();
  h.r.length = 0;
}
async function undoBoard(redo = false) {
  if (editingShape) await finishEdit();
  const h = H(), from = redo ? h.r : h.u, to = redo ? h.u : h.r;
  if (!from.length) return toast(redo ? '没有可以重做的操作' : '没有可以撤销的操作');
  to.push(snapBoard());
  const { s, l, c } = JSON.parse(from.pop());
  const b = boardOf();
  b.shapes = s; b.links = l;
  if (Array.isArray(c)) b.comments = c;
  state.bsel = null;
  await saveBoard();
}

// ---- 连线几何 ----
function boxOf(ref) {
  if (!ref) return null;
  if (ref.id) {
    const s = shapeById(ref.id);
    if (s) return { x: s.x, y: s.y, w: s.w, h: s.h, t: s.t };
    const el = $(`#world .card[data-id="${CSS.escape(ref.id)}"]`);
    if (el) return { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight, t: 'card' };
    return null;
  }
  return ref.x != null ? { x: ref.x, y: ref.y, w: 0, h: 0, t: 'pt' } : null;
}
const centerOf = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
// 从 b 的中心朝 (tx, ty) 出发，落在 b 的边框外一点
function edgePoint(b, tx, ty) {
  const c = centerOf(b), dx = tx - c.x, dy = ty - c.y;
  if (b.t === 'pt' || (!dx && !dy)) return c;
  const g = 5, hw = b.w / 2 + g, hh = b.h / 2 + g;
  let k;
  if (b.t === 'ellipse') k = 1 / Math.sqrt((dx * dx) / (hw * hw) + (dy * dy) / (hh * hh));
  else if (b.t === 'diamond') k = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
  else k = Math.min(hw / Math.abs(dx || 1e-9), hh / Math.abs(dy || 1e-9));
  return { x: c.x + dx * k, y: c.y + dy * k };
}
function linkGeom(l, override) {
  const A = boxOf(override?.from || l.from), B = boxOf(override?.to || l.to);
  if (!A || !B) return null;
  const ca = centerOf(A), cb = centerOf(B);
  const p1 = edgePoint(A, cb.x, cb.y), p2 = edgePoint(B, ca.x, ca.y);
  if (Math.hypot(p2.x - p1.x, p2.y - p1.y) < 2) return null;
  let d, c1 = p1, c2 = p2, mid;
  if (l.curve) {
    const dx = p2.x - p1.x, dy = p2.y - p1.y, horiz = Math.abs(dx) >= Math.abs(dy);
    c1 = horiz ? { x: p1.x + dx / 2, y: p1.y } : { x: p1.x, y: p1.y + dy / 2 };
    c2 = horiz ? { x: p2.x - dx / 2, y: p2.y } : { x: p2.x, y: p2.y - dy / 2 };
    d = `M${p1.x} ${p1.y}C${c1.x} ${c1.y} ${c2.x} ${c2.y} ${p2.x} ${p2.y}`;
    mid = { x: (p1.x + 3 * c1.x + 3 * c2.x + p2.x) / 8, y: (p1.y + 3 * c1.y + 3 * c2.y + p2.y) / 8 };
  } else {
    d = `M${p1.x} ${p1.y}L${p2.x} ${p2.y}`;
    mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
  }
  return { d, p1, p2, c1, c2, mid };
}
function arrowHead(tip, from, size = 13) {
  const a = Math.atan2(tip.y - from.y, tip.x - from.x), w = 0.42;
  const p = (ang) => `${tip.x - size * Math.cos(ang)} ${tip.y - size * Math.sin(ang)}`;
  return `M${tip.x} ${tip.y}L${p(a - w)}L${p(a + w)}Z`;
}
function linkSVG(l, g, { temp = false } = {}) {
  const sel = !temp && state.bsel?.type === 'link' && state.bsel.id === l.id;
  const color = linkColorFor(l.color);
  // 缩小时箭头按比例放大，屏幕上始终清楚（最多放大 4 倍）
  const ah = 13 * Math.min(4, Math.max(1, 1 / (cam().z || 1)));
  const heads = (l.end !== 'none' ? `<path class="ah" d="${arrowHead(g.p2, g.c2 === g.p2 ? g.p1 : g.c2, ah)}"/>` : '')
    + (l.end === 'both' ? `<path class="ah" d="${arrowHead(g.p1, g.c1 === g.p1 ? g.p2 : g.c1, ah)}"/>` : '');
  const label = l.label ? `<text class="lbl" x="${g.mid.x}" y="${g.mid.y}">${esc(l.label)}</text>` : '';
  const ends = sel ? `<circle class="lend" data-lend="from" cx="${g.p1.x}" cy="${g.p1.y}"/><circle class="lend" data-lend="to" cx="${g.p2.x}" cy="${g.p2.y}"/>` : '';
  return `<g class="link${sel ? ' picked' : ''}${temp ? ' temp' : ''}" ${temp ? '' : `data-lid="${l.id}"`} style="--lc:${color}">
    ${temp ? '' : `<path class="hit" d="${g.d}"/>`}<path class="ln${l.dash ? ' dash' : ''}" d="${g.d}"/>${heads}${label}${ends}</g>`;
}
function drawLinks() {
  const svg = $('#links');
  const b = boardOf();
  if (!svg || !b) return;
  let html = '';
  for (const l of b.links) {
    const g = linkGeom(l, bd?.mode === 'link' && bd.lid === l.id ? { [bd.end]: bd.cur } : null);
    if (g) html += linkSVG(l, g);
  }
  if (bd?.mode === 'link' && !bd.lid && bd.moved) {
    const g = linkGeom({ end: 'arrow' }, { from: bd.from, to: bd.target || bd.cur });
    if (g) html += linkSVG({ end: 'arrow' }, g, { temp: true });
  }
  svg.innerHTML = html;
  syncCommentPinPositions();
}
// 缩略图加载后卡片变高，连线跟着重算
$('#world').addEventListener('load', () => { if (boardOf()?.links.length) drawLinks(); }, true);

// ---- 工具 ----
function setTool(t, lock = false) {
  state.tool = t;
  state.toolLock = lock && t !== 'select';
  $$('#canvasPalette [data-tool]').forEach((b) => {
    const on = b.dataset.tool === t;
    b.classList.toggle('on', on); b.classList.toggle('locked', on && state.toolLock); b.setAttribute('aria-pressed', on);
  });
  $('#viewport').dataset.tool = t;
  const hint = $('#toolHint');
  if (hint) {
    hint.hidden = t === 'select';
    if (t !== 'select') hint.innerHTML = `${esc(TOOL_HINT[t] || '')}<span>${state.toolLock ? '已锁定，可以连续放置' : '双击工具可连续使用'} · Esc 退出</span>`;
  }
  hideDots();
}
function afterCreateTool() { if (!state.toolLock) setTool('select'); }
$('#canvasPalette').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tool]');
  if (b) setTool(state.tool === b.dataset.tool && b.dataset.tool !== 'select' && !state.toolLock ? 'select' : b.dataset.tool);
});
$('#canvasPalette').addEventListener('dblclick', (e) => {
  const b = e.target.closest('[data-tool]');
  if (b && b.dataset.tool !== 'select') setTool(b.dataset.tool, true);
});

async function saveBoard() { const b = boardOf(); if (b) { await saveArea(b); await changed(); } }
function selectBoard(sel) {
  state.bsel = sel;
  if (sel) state.pickedCard = null;
  fmtPop = null;
  if (sel && state.selected.size) clearSelection();
  renderCanvas();
}
function newShape(t, x, y, w, h, like) {
  const d = SH_DEF[t];
  const s = { id: uid(), t, x: Math.round(x), y: Math.round(y), w: Math.round(w || d.w), h: Math.round(h || d.h), text: '', fill: d.fill, fs: d.fs, al: d.al, z: topOrder(state.view) };
  if (like && like.t === t) Object.assign(s, { fill: like.fill, fs: like.fs, al: like.al, b: like.b });
  else if (like && like.t !== 'text' && t !== 'text' && shColor(like)) s.fill = like.fill;
  if (!s.b) delete s.b;
  if (t === 'frame') s.text = `画框 ${(boardOf()?.shapes.filter(isFrame).length || 0) + 1}`;
  return s;
}
async function createShape(t, x, y, w, h, { like, linkFrom } = {}) {
  const b = boardOf();
  if (!b) return;
  record();
  const s = newShape(t, x, y, w, h, like);
  b.shapes.push(s);
  if (linkFrom) b.links.push({ id: uid(), from: linkFrom, to: { id: s.id }, end: 'arrow' });
  state.bsel = pickShapes([s.id]);
  afterCreateTool();
  renderCanvas();
  const el = shEl(s.id);
  if (el && !reduceMotion.matches) el.animate([{ transform: 'scale(.97)', opacity: 0.6 }, { transform: 'none', opacity: 1 }], { duration: 170, easing: 'cubic-bezier(.2,.9,.3,1.2)' });
  if (t !== 'frame') startEdit(s.id, { fresh: true }); // 先进入编辑，马上就能打字；保存在后台进行（画框只选中，双击改标题）
  await saveBoard();
  return s;
}
// 在已选形状旁边（某个方向）新建一个相连的同款形状
async function createConnected(s, dir) {
  const gap = 90, w = s.w, h = s.h;
  const pos = { ArrowRight: [s.x + s.w + gap, s.y], ArrowLeft: [s.x - gap - w, s.y], ArrowDown: [s.x, s.y + s.h + gap], ArrowUp: [s.x, s.y - gap - h] }[dir];
  await createShape(s.t === 'text' ? 'rect' : s.t, pos[0], pos[1], w, h, { like: s, linkFrom: { id: s.id } });
}

// ---- 编辑文字 ----
// 结束另一个正在编辑的形状：把文字写回数据并保存，不重绘（避免和 startEdit 互相触发）
function commitEditingText() {
  const id = editingShape;
  if (!id) return;
  editingShape = null;
  const s = shapeById(id), el = shEl(id), tx = el?.querySelector('.sh-tx');
  if (s && tx) {
    s.text = tx.innerText.replace(/\n$/, '').replace(/^\n+|\n+$/g, '');
    tx.contentEditable = 'false';
    el.classList.remove('editing');
    if (editSnap && s.text !== editOrig) record(editSnap);
  }
  editSnap = null;
  const b = boardOf();
  if (b) saveArea(b);
}
function startEdit(id, opts = {}) {
  if (!shapeById(id)) return;
  if (shapeById(id).lk) { toast('已锁定：先解锁（Ctrl + Shift + L）才能编辑文字'); return; }
  if (editingShape && editingShape !== id) commitEditingText();
  // 先确保它是唯一选中的（只重绘一次，不递归）
  if (!(isPicked(id) && selIds().length === 1)) { state.bsel = pickShapes([id]); renderCanvas(); }
  const s = shapeById(id), el = shEl(id);
  if (!s || !el) return;
  if (!opts.keep) { editSnap = opts.fresh ? null : snapBoard(); editOrig = s.text || ''; }
  const tx = el.querySelector('.sh-tx');
  editingShape = id;
  el.classList.add('editing');
  try { tx.contentEditable = 'plaintext-only'; } catch { tx.contentEditable = 'true'; }
  if (tx.contentEditable !== 'plaintext-only') tx.contentEditable = 'true';
  tx.focus({ preventScroll: true });
  const r = document.createRange();
  r.selectNodeContents(tx);
  if (opts.keep || s.text) r.collapse(false);
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
  fitShapeText(s, el);
}
// 便签：字多了自动缩小字号（不改便签大小）；其他形状：字多了自动长高
// 文字放不下时自动缩小字号（设置的字号是上限，最小 10px），按各形状实际的内边距算可用高度；
// 便签、矩形、圆形、菱形都适用，文字框会自己长高、画框的标题在框外，所以不需要
function fitSticky(s, el) {
  const tx = el?.querySelector('.sh-tx');
  if (!tx || s.t === 'text' || s.t === 'frame') return;
  let fs = s.fs || SH_DEF[s.t]?.fs || 16;
  el.style.setProperty('--fs', `${fs}px`);
  if (!s.text && !el.classList.contains('editing')) return;
  const cs = getComputedStyle(el);
  const avail = el.clientHeight - parseFloat(cs.paddingTop || 0) - parseFloat(cs.paddingBottom || 0);
  const availW = el.clientWidth - parseFloat(cs.paddingLeft || 0) - parseFloat(cs.paddingRight || 0);
  const over = () => tx.scrollHeight > avail + 1 || tx.scrollWidth > availW + 1;
  if (!over()) return;
  // 像 Miro 一样：二分查找能完整放下全部文字的最大字号，没有最小字号限制，保证内容全部可见
  let lo = 1, hi = fs;
  for (let i = 0; i < 10 && hi - lo > 0.1; i++) {
    const mid = (lo + hi) / 2;
    el.style.setProperty('--fs', `${mid}px`);
    if (over()) hi = mid; else lo = mid;
  }
  el.style.setProperty('--fs', `${Math.floor(lo * 10) / 10}px`);
}
const fitAllShapeText = () => { for (const s of boardOf()?.shapes || []) if (s.text && s.t !== 'text' && s.t !== 'frame') fitSticky(s, shEl(s.id)); };
// 网页字体加载完成后字宽会变，重新量一次，避免文字溢出
document.fonts?.ready?.then(() => { if (isCanvas(state.view)) fitAllShapeText(); });
document.fonts?.addEventListener?.('loadingdone', () => { if (isCanvas(state.view)) fitAllShapeText(); });
function fitShapeText(s, el) {
  if (s.t !== 'text') { fitSticky(s, el); return; } // 便签和各种形状：大小不变，字自动缩小
  if (s.t === 'frame') return; // 画框的标题在框外，不影响框的大小
  const tx = el.querySelector('.sh-tx');
  const need = tx.scrollHeight + (s.t === 'text' ? 8 : s.t === 'diamond' ? s.h * 0.5 : s.t === 'ellipse' ? s.h * 0.3 : 28);
  if (need > s.h) el.style.height = `${Math.ceil(need)}px`;
  else if (s.t === 'text') el.style.height = `${Math.max(SH_DEF.text.h, Math.ceil(need))}px`;
  drawLinks();
}
async function finishEdit() {
  const id = editingShape;
  if (!id) return;
  editingShape = null;
  const s = shapeById(id), el = shEl(id);
  if (!s || !el) return;
  const tx = el.querySelector('.sh-tx');
  tx.contentEditable = 'false';
  el.classList.remove('editing');
  s.text = tx.innerText.replace(/\n$/, '').replace(/^\n+|\n+$/g, '');
  s.h = Math.max(s.t === 'text' ? 24 : 30, parseFloat(el.style.height) || s.h);
  if (editSnap && s.text !== editOrig) record(editSnap);
  editSnap = null;
  const b = boardOf();
  if (s.t === 'text' && !s.text.trim()) { b.shapes = b.shapes.filter((x) => x !== s); b.links = b.links.filter((l) => l.from.id !== id && l.to.id !== id); state.bsel = null; }
  await saveBoard();
  flushDeferredCollab();
}
document.addEventListener('input', (e) => {
  if (!editingShape || !e.target.matches?.('.sh-tx')) return;
  const s = shapeById(editingShape), el = e.target.closest('.shape');
  if (s && el) {
    fitShapeText(s, el);
    const liveText = e.target.innerText.replace(/\n$/, '').replace(/^\n+|\n+$/g, '');
    const liveH = Math.max(s.t === 'text' ? 24 : 30, parseFloat(el.style.height) || s.h);
    sendCollabShapeLive([{ ...s, text: liveText, h: liveH }], '正在输入文字');
  }
});
document.addEventListener('focusout', (e) => { if (editingShape && !boardRendering && e.target.matches?.('.sh-tx') && e.target.isConnected) finishEdit(); });

// ---- 连接点（悬停形状或卡片时出现，按住拖出箭头；拖到空白处会新建一个相连的形状） ----
function showDots(el) {
  const dots = $('#connDots');
  if (!dots) return;
  const ref = el.dataset.sid || el.dataset.id;
  const b = boxOf({ id: ref });
  if (!b) return hideDots();
  hoverRef = ref;
  Object.assign(dots.style, { left: `${b.x}px`, top: `${b.y}px`, width: `${b.w}px`, height: `${b.h}px` });
  dots.hidden = false;
}
function hideDots() { const d = $('#connDots'); if (d) d.hidden = true; hoverRef = null; }
vp.addEventListener('pointerover', (e) => {
  if (bd || cardDrag || pan || editingShape || spaceDown || e.pointerType === 'touch' || !['select', 'arrow'].includes(state.tool)) return;
  if (e.target.closest('.conn-dots')) return;
  const el = e.target.closest('.shape, .card.on-canvas');
  // 画框不显示连接点（它只是背景），箭头连的是框里的东西
  if (el && !el.classList.contains('st-frame') && !(el.classList.contains('picked') && selIds().length > 1)) showDots(el); else hideDots();
});
vp.addEventListener('pointerleave', () => { if (!bd) hideDots(); });
vp.addEventListener('pointermove', (e) => {
  lastPointer = { x: e.clientX, y: e.clientY };
  if (collabSession && isCanvas(state.view) && state.view === collabSession.canvasId) {
    const p = toWorld(e.clientX, e.clientY);
    sendCollabCursor(Math.round(p.x), Math.round(p.y));
  }
}, true);

// ---- 对齐吸附（边缘、中心线、等距间距、等宽等高尺寸吸附） ----
function snapTargets(exclude = new Set(), excludeCards = null) {
  const exCards = excludeCards instanceof Set ? excludeCards : new Set(excludeCards ? [excludeCards] : []);
  const xs = [], ys = [], ws = [], hs = [], boxes = [];
  const add = (b) => {
    xs.push(b.x, b.x + b.w / 2, b.x + b.w);
    ys.push(b.y, b.y + b.h / 2, b.y + b.h);
    ws.push(b.w); hs.push(b.h);
    boxes.push({ x: b.x, y: b.y, w: b.w, h: b.h });
  };
  for (const s of boardOf()?.shapes || []) if (!exclude.has(s.id)) add(s);
  for (const el of $$('#world .card.on-canvas')) if (!exCards.has(el.dataset.id)) add({ x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight });
  return { xs, ys, ws, hs, boxes };
}
function nearest(vals, cands, tol) {
  let best = null;
  for (let i = 0; i < vals.length; i++) for (const c of cands) {
    const d = c - vals[i];
    if (Math.abs(d) <= tol && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, at: c };
  }
  return best;
}
function nearestGapX(box, boxes, tol) {
  if (!boxes?.length) return null;
  const row = boxes.filter((b) => Math.min(box.y + box.h, b.y + b.h) - Math.max(box.y, b.y) > -Math.min(box.h, b.h) * 0.8);
  const lefts = row.filter((b) => b.x + b.w <= box.x + tol * 2).sort((a, b) => (b.x + b.w) - (a.x + a.w));
  const rights = row.filter((b) => b.x >= box.x + box.w - tol * 2).sort((a, b) => a.x - b.x);
  const L = lefts[0], LL = lefts[1], R = rights[0], RR = rights[1], cy = box.y + box.h / 2;
  if (L && R) {
    const g = ((R.x - (L.x + L.w)) - box.w) / 2, tx = L.x + L.w + g, d = tx - box.x;
    if (g >= 4 && Math.abs(d) <= tol) {
      return { d, gaps: [{ axis: 'x', p1: L.x + L.w, p2: tx, cross: cy, val: Math.round(g) }, { axis: 'x', p1: tx + box.w, p2: R.x, cross: cy, val: Math.round(g) }] };
    }
  }
  if (L && LL) {
    const g0 = L.x - (LL.x + LL.w), tx = L.x + L.w + g0, d = tx - box.x;
    if (g0 >= 4 && g0 <= 480 && Math.abs(d) <= tol) {
      return { d, gaps: [{ axis: 'x', p1: LL.x + LL.w, p2: L.x, cross: L.y + L.h / 2, val: Math.round(g0) }, { axis: 'x', p1: L.x + L.w, p2: tx, cross: cy, val: Math.round(g0) }] };
    }
  }
  if (R && RR) {
    const g0 = RR.x - (R.x + R.w), tx = R.x - g0 - box.w, d = tx - box.x;
    if (g0 >= 4 && g0 <= 480 && Math.abs(d) <= tol) {
      return { d, gaps: [{ axis: 'x', p1: tx + box.w, p2: R.x, cross: cy, val: Math.round(g0) }, { axis: 'x', p1: R.x + R.w, p2: RR.x, cross: R.y + R.h / 2, val: Math.round(g0) }] };
    }
  }
  if (L) { const tx = L.x + L.w + 24, d = tx - box.x; if (Math.abs(d) <= tol * 0.7) return { d, gaps: [{ axis: 'x', p1: L.x + L.w, p2: tx, cross: cy, val: 24 }] }; }
  if (R) { const tx = R.x - 24 - box.w, d = tx - box.x; if (Math.abs(d) <= tol * 0.7) return { d, gaps: [{ axis: 'x', p1: tx + box.w, p2: R.x, cross: cy, val: 24 }] }; }
  return null;
}
function nearestGapY(box, boxes, tol) {
  if (!boxes?.length) return null;
  const col = boxes.filter((b) => Math.min(box.x + box.w, b.x + b.w) - Math.max(box.x, b.x) > -Math.min(box.w, b.w) * 0.8);
  const tops = col.filter((b) => b.y + b.h <= box.y + tol * 2).sort((a, b) => (b.y + b.h) - (a.y + a.h));
  const bots = col.filter((b) => b.y >= box.y + box.h - tol * 2).sort((a, b) => a.y - b.y);
  const T = tops[0], TT = tops[1], B = bots[0], BB = bots[1], cx = box.x + box.w / 2;
  if (T && B) {
    const g = ((B.y - (T.y + T.h)) - box.h) / 2, ty = T.y + T.h + g, d = ty - box.y;
    if (g >= 4 && Math.abs(d) <= tol) {
      return { d, gaps: [{ axis: 'y', p1: T.y + T.h, p2: ty, cross: cx, val: Math.round(g) }, { axis: 'y', p1: ty + box.h, p2: B.y, cross: cx, val: Math.round(g) }] };
    }
  }
  if (T && TT) {
    const g0 = T.y - (TT.y + TT.h), ty = T.y + T.h + g0, d = ty - box.y;
    if (g0 >= 4 && g0 <= 480 && Math.abs(d) <= tol) {
      return { d, gaps: [{ axis: 'y', p1: TT.y + TT.h, p2: T.y, cross: T.x + T.w / 2, val: Math.round(g0) }, { axis: 'y', p1: T.y + T.h, p2: ty, cross: cx, val: Math.round(g0) }] };
    }
  }
  if (B && BB) {
    const g0 = BB.y - (B.y + B.h), ty = B.y - g0 - box.h, d = ty - box.y;
    if (g0 >= 4 && g0 <= 480 && Math.abs(d) <= tol) {
      return { d, gaps: [{ axis: 'y', p1: ty + box.h, p2: B.y, cross: cx, val: Math.round(g0) }, { axis: 'y', p1: B.y + B.h, p2: BB.y, cross: B.x + B.w / 2, val: Math.round(g0) }] };
    }
  }
  if (T) { const ty = T.y + T.h + 24, d = ty - box.y; if (Math.abs(d) <= tol * 0.7) return { d, gaps: [{ axis: 'y', p1: T.y + T.h, p2: ty, cross: cx, val: 24 }] }; }
  if (B) { const ty = B.y - 24 - box.h, d = ty - box.y; if (Math.abs(d) <= tol * 0.7) return { d, gaps: [{ axis: 'y', p1: ty + box.h, p2: B.y, cross: cx, val: 24 }] }; }
  return null;
}
function showGuides(gx, gy, box) {
  const g = $('#guides');
  if (!g) return;
  const ext = 4000;
  let html = (gx?.at != null ? `<i class="gl gx" style="left:${gx.at}px;top:${box.y - ext}px;height:${box.h + ext * 2}px"></i>` : '')
    + (gy?.at != null ? `<i class="gl gy" style="top:${gy.at}px;left:${box.x - ext}px;width:${box.w + ext * 2}px"></i>` : '');
  for (const gp of [...(gx?.gaps || []), ...(gy?.gaps || [])]) {
    const p1 = Math.min(gp.p1, gp.p2), len = Math.max(0, Math.abs(gp.p2 - gp.p1));
    if (len < 4) continue;
    html += gp.axis === 'x'
      ? `<i class="gl-gap gap-x" style="left:${p1}px;top:${gp.cross}px;width:${len}px"><span>${gp.val}</span></i>`
      : `<i class="gl-gap gap-y" style="top:${p1}px;left:${gp.cross}px;height:${len}px"><span>${gp.val}</span></i>`;
  }
  g.innerHTML = html;
}
const clearGuides = () => { const g = $('#guides'); if (g) g.innerHTML = ''; };
function showSizeTip(e, w, h, tag = '') {
  const tip = $('#sizeTip'), cv = $('#canvasView').getBoundingClientRect();
  if (!tip) return;
  tip.hidden = false;
  tip.textContent = `${Math.round(w)} × ${Math.round(h)}${tag ? ` · ${tag}` : ''}`;
  tip.style.left = `${e.clientX - cv.left + 14}px`; tip.style.top = `${e.clientY - cv.top + 16}px`;
}
const hideSizeTip = () => { const t = $('#sizeTip'); if (t) t.hidden = true; };

// ---- 按下 / 拖动 / 松开 ----
function boardDown(e) {
  if (!isCanvas(state.view)) return false;
  if (e.target.closest('.sh-tx[contenteditable="true"], .sh-tx[contenteditable="plaintext-only"]')) return true;
  if (editingShape) finishEdit();
  const p = toWorld(e.clientX, e.clientY);
  const handle = e.target.closest('[data-handle]'), dot = e.target.closest('[data-dot]'), lend = e.target.closest('[data-lend]');
  const shapeEl = e.target.closest('.shape'), linkEl = e.target.closest('[data-lid]'), cardEl = e.target.closest('.card');
  const pinEl = e.target.closest('.comment-pin[data-cid]');
  const capture = () => { try { vp.setPointerCapture(e.pointerId); } catch {} };
  const base = { pid: e.pointerId, sx: e.clientX, sy: e.clientY, moved: false, snap: snapBoard() };
  if (pinEl) {
    const cid = pinEl.dataset.cid;
    if (cid === 'draft') {
      $('#commentThreadPop textarea')?.focus();
      return true;
    }
    const cm = commentById(cid);
    if (cm) {
      bd = { ...base, mode: 'comment-drag', cm, pinEl, o: commentPos(cm) };
      capture();
      return true;
    }
  }
  if (state.tool === 'comment' && e.button === 0) {
    const hitTarget = shapeEl?.dataset.sid || (cardEl?.classList.contains('on-canvas') ? cardEl.dataset.id : null);
    openCommentDraftAt(p.x, p.y, hitTarget);
    e.preventDefault();
    return true;
  }
  const gh = e.target.closest('[data-ghandle]');
  if (gh && e.button === 0) {
    const g = groupItems();
    const ob = unionBox([...g.shapes.map((x) => x.o), ...g.cards.map((x) => x.o)]);
    if (ob && g.shapes.length + g.cards.length > 1) {
      const k = gh.dataset.ghandle;
      // 锚点 = 对角（Alt：中心）；拖动的角点沿对角线投影得到缩放比例
      const corner = { x: k.includes('w') ? ob.x : ob.x + ob.w, y: k.includes('n') ? ob.y : ob.y + ob.h };
      bd = { ...base, mode: 'gresize', g, ob, k, corner };
      $('#groupBox')?.classList.add('scaling');
      capture(); e.preventDefault(); return true;
    }
  }
  if (handle && shapeEl) {
    const s = shapeById(shapeEl.dataset.sid);
    if (s?.lk) return true;
    bd = { ...base, mode: 'resize', s, el: shapeEl, k: handle.dataset.handle, o: { x: s.x, y: s.y, w: s.w, h: s.h } };
    capture(); return true;
  }
  if (lend) {
    const l = linkById(lend.closest('[data-lid]').dataset.lid);
    bd = { ...base, mode: 'link', lid: l.id, end: lend.dataset.lend, from: lend.dataset.lend === 'from' ? l.to : l.from, cur: p };
    capture(); hideDots(); return true;
  }
  if (dot || (state.tool === 'arrow' && !e.target.closest('.more, .export-handle, .sel, .quick-rename-btn, .inline-rn-wrap, .canvas-card-hud'))) {
    const owner = dot ? hoverRef : ((shapeEl && !shapeEl.classList.contains('st-frame') ? shapeEl.dataset.sid : null) || (cardEl && cardEl.classList.contains('on-canvas') ? cardEl.dataset.id : null));
    bd = { ...base, mode: 'link', fromDot: !!dot, from: owner ? { id: owner } : { x: Math.round(p.x), y: Math.round(p.y) }, cur: p };
    capture(); hideDots(); e.preventDefault(); return true;
  }
  if (SH_DEF[state.tool]) {
    bd = { ...base, mode: 'create', t: state.tool, p0: p };
    capture(); return true;
  }
  if (linkEl) { selectBoard({ type: 'link', id: linkEl.dataset.lid }); return true; }
  if (shapeEl) {
    const id = shapeEl.dataset.sid;
    const was = isPicked(id);
    // Shift + 点击：加入 / 移出多选（已选中的在松手且没拖动时才移出，这样 Shift + 拖动可以锁定方向移动整组）
    if (!was) {
      if (!e.shiftKey && state.selected.size) clearSelection();
      state.bsel = pickShapes(e.shiftKey ? [...selIds(), id] : [id]);
      fmtPop = null;
      renderCanvas();
    }
    const items = freeShapes(selShapes()).map((s) => ({ s, o: { x: s.x, y: s.y } }));
    const cardItems = (!e.altKey && state.selected.size)
      ? selectedCanvasCards().filter((c) => !c.locked).map((c) => {
        const el = $(`#world .card[data-id="${CSS.escape(c.id)}"]`);
        return el ? { card: c, el, x: c.x || 0, y: c.y || 0, w: el.offsetWidth || canvasCardW(c), h: el.offsetHeight || 120 } : null;
      }).filter(Boolean)
      : [];
    // 拖动画框：完全在框里的形状、文件卡片一起移动（Alt 复制时只复制画框和里面的形状）
    for (const f of items.map((it) => it.s).filter(isFrame)) {
      const have = new Set(items.map((it) => it.s.id));
      for (const s of boardOf().shapes) if (!have.has(s.id) && s !== f && !s.lk && insideBox(f, s)) items.push({ s, o: { x: s.x, y: s.y } });
      if (e.altKey) continue;
      const haveCards = new Set(cardItems.map((c) => c.card.id));
      for (const el of $$('#world .card.on-canvas')) {
        const c = findCard(el.dataset.id);
        const box = { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
        if (c && !c.locked && !haveCards.has(c.id) && insideBox(f, box)) { cardItems.push({ card: c, el, x: c.x || 0, y: c.y || 0, w: box.w, h: box.h }); haveCards.add(c.id); }
      }
    }
    if (!items.length && !cardItems.length) {
      // 全是锁定的：只选中，不拖动；单击已选中的锁定对象提示怎么解锁
      if (was && !e.shiftKey && shapeById(id)?.lk) toast('已锁定：先解锁（Ctrl + Shift + L 或格式条上的锁）才能移动和编辑');
      bd = { ...base, mode: 'locked', clicked: id, shiftToggle: e.shiftKey && was };
      capture(); return true;
    }
    bd = { ...base, mode: 'move', items, cardItems, clicked: id, was: was && !e.shiftKey && selIds().length === 1 && !cardItems.length, shiftToggle: e.shiftKey && was, alt: e.altKey };
    if (e.altKey) e.preventDefault();
    capture(); return true;
  }
  if (e.button === 0 && state.tool === 'select' && !cardEl) {
    // 左键在空白处按下并拖动：直接拉出多选框（Shift 可叠加多选）；若仅单击空白处则取消选中
    bd = { ...base, mode: 'marquee', p0: p, add: e.shiftKey, base: e.shiftKey ? [...selIds()] : [], baseCards: e.shiftKey ? [...state.selected] : [] };
    capture(); return true;
  }
  if (state.bsel) {
    // 点在卡片上：只去掉形状的选中样式，不整体重绘（后面还要拖这张卡片）
    if (cardEl) {
      state.bsel = null;
      $$('#world .shape.picked').forEach((x) => { x.classList.remove('picked'); x.querySelectorAll('.sh-h').forEach((h) => h.remove()); });
      decorateBoard(); drawLinks(); positionFmt();
    } else selectBoard(null);
  }
  if (!cardEl && state.pickedCard) pickCanvasCard(null);
  return false;
}
// Alt + 拖动开始时：在原位置生成副本（连同它们之间的连线），之后拖动的是副本，原形状留在原地
function makeDragCopies(d) {
  const b = boardOf(), map = new Map(), top = topOrder(state.view);
  const inner = innerLinks(new Set(d.items.map((it) => it.s.id)));
  const copies = d.items.map((it, i) => {
    const c = { ...it.s, x: it.o.x, y: it.o.y, id: uid(), z: top + i };
    delete c._t; map.set(it.s.id, c.id); return c;
  });
  b.shapes.push(...copies);
  for (const l of inner) b.links.push({ ...l, id: uid(), from: { id: map.get(l.from.id) }, to: { id: map.get(l.to.id) } });
  for (const it of d.items) { const el = shEl(it.s.id); if (el) { el.classList.remove('picked'); el.querySelectorAll('.sh-h, .sh-edge').forEach((h) => h.remove()); } }
  state.bsel = pickShapes(copies.map((c) => c.id));
  $('#groupBox').insertAdjacentHTML('beforebegin', copies.map(shapeHTML).join(''));
  d.items = copies.map((c) => ({ s: c, o: { x: c.x, y: c.y } }));
  d.copied = true;
  drawLinks();
}
function boardMove(e) {
  if (!bd || e.pointerId !== bd.pid) return false;
  const z = cam().z, dx = (e.clientX - bd.sx) / z, dy = (e.clientY - bd.sy) / z;
  if (!bd.moved && Math.hypot(e.clientX - bd.sx, e.clientY - bd.sy) < 4) return true;
  if (!bd.moved) {
    bd.moved = true; hideDots(); $('#fmtBar').hidden = true; document.body.classList.add('board-dragging');
    if (bd.mode === 'move' && bd.alt) makeDragCopies(bd); // Alt + 拖动：原形状留在原地，拖走的是副本
    if (bd.mode === 'move' || bd.mode === 'resize') {
      bd.snapT = snapTargets(
        new Set(bd.mode === 'move' ? bd.items.map((i) => i.s.id) : [bd.s.id]),
        new Set(bd.mode === 'move' ? (bd.cardItems || []).map((c) => c.card.id) : []),
      );
    }
  }
  const tol = 6 / z, snapOn = !(e.ctrlKey || e.metaKey); // 按住 Ctrl / ⌘ 暂时关闭吸附
  if (bd.mode === 'move') {
    const ob = unionBox(bd.items.map((i) => ({ ...i.s, x: i.o.x, y: i.o.y })));
    let mx = dx, my = dy, gx = null, gy = null;
    const lock = e.shiftKey ? (Math.abs(dx) > Math.abs(dy) ? 'x' : 'y') : null; // Shift：只水平或只垂直
    if (lock === 'x') my = 0;
    if (lock === 'y') mx = 0;
    if (snapOn) {
      const bx = ob.x + mx, by = ob.y + my;
      if (lock !== 'y') gx = nearest([bx, bx + ob.w / 2, bx + ob.w], bd.snapT.xs, tol) || nearestGapX({ x: bx, y: by, w: ob.w, h: ob.h }, bd.snapT.boxes, tol);
      if (lock !== 'x') gy = nearest([by, by + ob.h / 2, by + ob.h], bd.snapT.ys, tol) || nearestGapY({ x: bx, y: by, w: ob.w, h: ob.h }, bd.snapT.boxes, tol);
      if (gx) mx += gx.d;
      if (gy) my += gy.d;
    }
    for (const it of bd.items) {
      it.s.x = Math.round(it.o.x + mx); it.s.y = Math.round(it.o.y + my);
      const el = shEl(it.s.id);
      if (el) { el.style.left = `${it.s.x}px`; el.style.top = `${it.s.y}px`; }
    }
    for (const cit of bd.cardItems || []) {
      if (cit.el) {
        cit.el.style.left = `${Math.round(cit.x + mx)}px`;
        cit.el.style.top = `${Math.round(cit.y + my)}px`;
      }
    }
    showGuides(gx, gy, { x: ob.x + mx, y: ob.y + my, w: ob.w, h: ob.h });
    drawLinks();
    sendCollabShapeLive(bd.items.map((it) => it.s), '正在移动形状');
    if (bd.cardItems?.length) {
      sendCollabCardLive(bd.cardItems.map((cit) => ({
        ...cit.card,
        x: Math.round(cit.x + mx),
        y: Math.round(cit.y + my),
      })), '正在移动卡片');
    }
  } else if (bd.mode === 'resize') {
    const { o, k, s } = bd, min = 30;
    let { x, y, w, h } = o, gx = null, gy = null;
    if (k.includes('e')) { w = Math.max(min, o.w + dx); if (snapOn && (gx = nearest([x + w], bd.snapT.xs, tol))) w += gx.d; }
    if (k.includes('w')) { x = o.x + dx; if (snapOn && (gx = nearest([x], bd.snapT.xs, tol))) x += gx.d; w = Math.max(min, o.x + o.w - x); x = o.x + o.w - w; }
    if (k.includes('s')) { h = Math.max(min, o.h + dy); if (snapOn && (gy = nearest([y + h], bd.snapT.ys, tol))) h += gy.d; }
    if (k.includes('n')) { y = o.y + dy; if (snapOn && (gy = nearest([y], bd.snapT.ys, tol))) y += gy.d; h = Math.max(min, o.y + o.h - y); y = o.y + o.h - h; }
    if (k.length === 2 && (e.shiftKey || (s.t === 'ellipse' && o.w === o.h))) {
      const m = Math.max(w, h); if (k.includes('w')) x = o.x + o.w - m; if (k.includes('n')) y = o.y + o.h - m; w = h = m; gx = gy = null;
    }
    if (e.altKey) {
      // Alt：以中心为基准对称缩放
      if (k.includes('e') || k.includes('w')) { w = Math.max(min, o.w + 2 * (w - o.w)); x = o.x + (o.w - w) / 2; }
      if (k.includes('n') || k.includes('s')) { h = Math.max(min, o.h + 2 * (h - o.h)); y = o.y + (o.h - h) / 2; }
      gx = gy = null;
    }
    Object.assign(s, { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) });
    Object.assign(bd.el.style, { left: `${s.x}px`, top: `${s.y}px`, width: `${s.w}px`, height: `${s.h}px` });
    fitSticky(s, bd.el); // 缩放时字号跟着适配（文字框、画框会自动跳过）
    showGuides(gx, gy, s);
    showSizeTip(e, s.w, s.h);
    drawLinks();
    sendCollabShapeLive([s], '正在缩放形状');
  } else if (bd.mode === 'gresize') {
    // 整体等比缩放：位置、大小、字号一起按比例变化
    const { ob, corner, g } = bd, center = e.altKey;
    const A = center ? { x: ob.x + ob.w / 2, y: ob.y + ob.h / 2 } : { x: corner.x === ob.x ? ob.x + ob.w : ob.x, y: corner.y === ob.y ? ob.y + ob.h : ob.y };
    const vx = corner.x - A.x, vy = corner.y - A.y, len2 = vx * vx + vy * vy || 1;
    const k = Math.max(0.05, Math.min(20, ((corner.x + dx - A.x) * vx + (corner.y + dy - A.y) * vy) / len2));
    const sc = (o) => ({ x: A.x + (o.x - A.x) * k, y: A.y + (o.y - A.y) * k, w: o.w * k, h: o.h * k });
    for (const it of g.shapes) {
      const n = sc(it.o);
      Object.assign(it.s, { x: Math.round(n.x), y: Math.round(n.y), w: Math.max(8, Math.round(n.w)), h: Math.max(8, Math.round(n.h)), fs: Math.max(4, Math.round(it.o.fs * k * 2) / 2) });
      const el = shEl(it.s.id);
      if (el) {
        Object.assign(el.style, { left: `${it.s.x}px`, top: `${it.s.y}px`, width: `${it.s.w}px`, height: `${it.s.h}px` });
        el.style.setProperty('--fs', `${it.s.fs}px`);
        fitSticky(it.s, el);
      }
    }
    for (const it of g.cards) {
      const n = sc(it.o);
      it.nx = Math.round(n.x); it.ny = Math.round(n.y); it.nw = Math.max(120, Math.round(n.w));
      Object.assign(it.el.style, { left: `${it.nx}px`, top: `${it.ny}px`, width: `${it.nw}px` });
    }
    const nb = sc(ob), box = $('#groupBox');
    if (box) Object.assign(box.style, { left: `${nb.x}px`, top: `${nb.y}px`, width: `${nb.w}px`, height: `${nb.h}px` });
    bd.k2 = k;
    showSizeTip(e, nb.w, nb.h, `${Math.round(k * 100)}%`);
    drawLinks();
    if (g.shapes.length) sendCollabShapeLive(g.shapes.map((it) => it.s), '正在缩放');
    if (g.cards.length) sendCollabCardLive(g.cards.map((it) => ({ ...it.card, x: it.nx, y: it.ny, w: it.nw })), '正在缩放');
  } else if (bd.mode === 'create') {
    const p = toWorld(e.clientX, e.clientY);
    let w = Math.abs(p.x - bd.p0.x), h = Math.abs(p.y - bd.p0.y);
    if (e.shiftKey) w = h = Math.max(w, h);
    let x = p.x < bd.p0.x ? bd.p0.x - w : bd.p0.x, y = p.y < bd.p0.y ? bd.p0.y - h : bd.p0.y;
    if (e.altKey) { w *= 2; h *= 2; x = bd.p0.x - w / 2; y = bd.p0.y - h / 2; } // Alt：从按下的点向四周画
    if (!bd.ghost) { bd.ghost = document.createElement('div'); bd.ghost.className = `shape-ghost st-${bd.t}`; $('#world').appendChild(bd.ghost); }
    Object.assign(bd.ghost.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
    bd.box = { x, y, w, h };
    showSizeTip(e, w, h);
  } else if (bd.mode === 'marquee') {
    const p = toWorld(e.clientX, e.clientY);
    const r = { x: Math.min(p.x, bd.p0.x), y: Math.min(p.y, bd.p0.y), w: Math.abs(p.x - bd.p0.x), h: Math.abs(p.y - bd.p0.y) };
    if (!bd.ghost) { bd.ghost = document.createElement('div'); bd.ghost.className = 'marquee'; $('#world').appendChild(bd.ghost); }
    Object.assign(bd.ghost.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
    const hit = boardOf().shapes.filter((s) => !s.lk && s.x < r.x + r.w && s.x + s.w > r.x && s.y < r.y + r.h && s.y + s.h > r.y).map((s) => s.id);
    bd.hits = [...new Set([...bd.base, ...hit])];
    $$('#world .shape').forEach((el) => el.classList.toggle('picked', bd.hits.includes(el.dataset.sid)));
    const hitCards = $$('#world .card.on-canvas:not(.locked)').filter((el) => {
      const cx = el.offsetLeft, cy = el.offsetTop, cw = el.offsetWidth, ch = el.offsetHeight;
      return cx < r.x + r.w && cx + cw > r.x && cy < r.y + r.h && cy + ch > r.y;
    }).map((el) => el.dataset.id);
    bd.cardHits = [...new Set([...(bd.baseCards || []), ...hitCards])];
    $$('#world .card.on-canvas').forEach((el) => el.classList.toggle('selected', bd.cardHits.includes(el.dataset.id)));
  } else if (bd.mode === 'comment-drag') {
    const nx = Math.round(bd.o.x + dx), ny = Math.round(bd.o.y + dy);
    bd.pinEl.style.setProperty('--cx', `${nx}px`);
    bd.pinEl.style.setProperty('--cy', `${ny}px`);
    bd.cur = { x: nx, y: ny };
    if (openCommentId === bd.cm.id) positionCommentPop();
  } else if (bd.mode === 'link') {
    bd.cur = toWorld(e.clientX, e.clientY);
    const hit = document.elementFromPoint(e.clientX, e.clientY)?.closest('.shape:not(.st-frame), .card.on-canvas');
    const id = hit && (hit.dataset.sid || hit.dataset.id);
    $$('.link-target').forEach((x) => x.classList.remove('link-target'));
    if (id && id !== bd.from.id) { hit.classList.add('link-target'); bd.target = { id }; } else bd.target = null;
    if (bd.lid) bd.cur = bd.target || { x: bd.cur.x, y: bd.cur.y };
    drawLinks();
  }
  return true;
}
async function boardUp(e) {
  if (!bd || e.pointerId !== bd.pid) return false;
  const d = bd; bd = null;
  setTimeout(flushDeferredCollab, 0);
  document.body.classList.remove('board-dragging');
  $$('.link-target').forEach((x) => x.classList.remove('link-target'));
  d.ghost?.remove();
  clearGuides(); hideSizeTip();
  if (e.type === 'pointercancel') { renderCanvas(); return true; }
  if (d.moved) { suppressClick = true; setTimeout(() => { suppressClick = false; }, 0); }
  const b = boardOf();
  if (d.mode === 'gresize') {
    $('#groupBox')?.classList.remove('scaling');
    if (!d.moved) return true;
    if (d.g.shapes.length) record(d.snap);
    if (d.g.cards.length) {
      const before = d.g.cards.map((it) => ({ c: it.card, x: it.card.x, y: it.card.y, w: it.card.w }));
      d.g.cards.forEach((it) => { if (it.nx != null) Object.assign(it.card, { x: it.nx, y: it.ny, w: it.nw, updatedAt: Date.now() }); });
      await db.putMany('cards', d.g.cards.map((it) => it.card));
      if (!d.g.shapes.length) toast(`已缩放 ${d.g.cards.length} 张卡片`, { action: '撤销', onAction: async () => {
        before.forEach(({ c, x, y, w }) => { c.x = x; c.y = y; if (w === undefined) delete c.w; else c.w = w; });
        await db.putMany('cards', before.map((p) => p.c)); await changed();
      } });
    }
    await saveBoard();
    return true;
  }
  if (d.mode === 'locked') {
    if (d.shiftToggle && !d.moved) selectBoard(pickShapes(selIds().filter((x) => x !== d.clicked)));
    else { decorateBoard(); positionFmt(); }
    return true;
  }
  if (d.mode === 'move' || d.mode === 'resize') {
    if (d.moved) {
      record(d.snap);
      if (d.cardItems?.length) {
        d.cardItems.forEach((cit) => {
          if (cit.el) {
            cit.card.x = parseFloat(cit.el.style.left);
            cit.card.y = parseFloat(cit.el.style.top);
            cit.card.updatedAt = Date.now();
          }
        });
        await db.putMany('cards', d.cardItems.map((cit) => cit.card));
      }
      await saveBoard();
      if (d.copied) toast(`已复制 ${d.items.length} 个形状`);
    }
    else if (d.shiftToggle) selectBoard(pickShapes(selIds().filter((x) => x !== d.clicked))); // Shift + 点已选中的 → 移出多选
    else if (d.mode === 'move' && d.was && !isFrame(shapeById(d.clicked))) startEdit(d.clicked); // 再点一下已选中的形状 → 编辑文字（画框改名用双击标题）
    else { decorateBoard(); positionFmt(); }
    return true;
  }
  if (d.mode === 'comment-drag') {
    if (d.moved && d.cur) {
      record(d.snap);
      d.pinEl.style.pointerEvents = 'none';
      const under = document.elementFromPoint(e.clientX, e.clientY)?.closest('.shape, .card.on-canvas');
      d.pinEl.style.pointerEvents = '';
      const tid = under ? (under.dataset.sid || under.dataset.id) : null;
      const bx = tid ? boxOf({ id: tid }) : null;
      d.cm.x = d.cur.x;
      d.cm.y = d.cur.y;
      if (tid && bx) {
        d.cm.targetId = tid;
        d.cm.dx = Math.round(d.cur.x - bx.x);
        d.cm.dy = Math.round(d.cur.y - bx.y);
      } else {
        delete d.cm.targetId;
        delete d.cm.dx;
        delete d.cm.dy;
      }
      await saveBoard();
      if (openCommentId === d.cm.id) renderCommentThreadPop();
    } else {
      openCommentThread(d.cm.id);
    }
    return true;
  }
  if (d.mode === 'marquee') {
    if (!d.moved) {
      if (!d.add) {
        if (state.selected.size) clearSelection();
        if (state.pickedCard) pickCanvasCard(null);
        if (state.bsel) selectBoard(null);
      }
      return true;
    }
    const shHits = d.hits || d.base || [];
    const cHits = d.cardHits || d.baseCards || [];
    state.selected = new Set(cHits);
    state.pickedCard = cHits.length === 1 && !shHits.length ? cHits[0] : null;
    document.body.classList.toggle('selecting', state.selected.size > 0);
    renderSelBar();
    state.bsel = pickShapes(shHits);
    fmtPop = null;
    renderCanvas();
    return true;
  }
  if (d.mode === 'create') {
    const box = d.moved && d.box && d.box.w > 12 && d.box.h > 12 ? d.box : null;
    const def = SH_DEF[d.t];
    if (box) await createShape(d.t, box.x, box.y, Math.max(40, box.w), Math.max(d.t === 'text' ? def.h : 40, box.h));
    else await createShape(d.t, d.p0.x - def.w / 2, d.p0.y - def.h / 2);
    return true;
  }
  if (d.mode === 'link') {
    if (d.lid) {
      const l = linkById(d.lid);
      if (l && d.moved) { record(d.snap); l[d.end] = d.target || { x: Math.round(d.cur.x), y: Math.round(d.cur.y) }; await saveBoard(); }
      else drawLinks();
      return true;
    }
    const dist = Math.hypot(e.clientX - d.sx, e.clientY - d.sy);
    if (!d.moved || (!d.target && !d.from.id && dist < 30)) { drawLinks(); return true; }
    // 从连接点拖到空白处：在松手的位置新建一个相连的同款形状，直接输入
    if (!d.target && d.fromDot && d.from.id && dist > 40 && !e.altKey) {
      const src = shapeById(d.from.id), t = src ? (src.t === 'text' ? 'rect' : src.t) : 'sticky';
      const w = src && src.t !== 'text' ? src.w : SH_DEF[t].w, h = src && src.t !== 'text' ? src.h : SH_DEF[t].h;
      await createShape(t, d.cur.x - w / 2, d.cur.y - h / 2, w, h, { like: src, linkFrom: d.from });
      return true;
    }
    record(d.snap);
    const l = { id: uid(), from: d.from, to: d.target || { x: Math.round(d.cur.x), y: Math.round(d.cur.y) }, end: 'arrow' };
    b.links.push(l);
    state.bsel = { type: 'link', id: l.id };
    afterCreateTool();
    await saveBoard();
    return true;
  }
  return true;
}

// ---- 删除 / 复制 / 粘贴 / 层级 / 对齐 ----
async function deleteBoardSel() {
  const b = boardOf(), sel = state.bsel;
  if (!b || !sel) return;
  if (sel.type === 'shape' && !freeShapes(selShapes()).length) return toast('选中的对象已锁定，先解锁才能删除');
  record();
  let n = 1;
  if (sel.type === 'shape') {
    const ids = new Set(freeShapes(selShapes()).map((s) => s.id)); n = ids.size; // 锁定的留下
    if (ids.size < sel.ids.length) setTimeout(() => toast(`${sel.ids.length - ids.size} 个锁定的对象没有删除`), 1200);
    b.shapes = b.shapes.filter((s) => !ids.has(s.id));
    b.links = b.links.filter((l) => !ids.has(l.from.id) && !ids.has(l.to.id));
  } else b.links = b.links.filter((l) => l.id !== sel.id);
  state.bsel = null;
  await saveBoard();
  toast(sel.type === 'shape' ? `已删除${n > 1 ? ` ${n} 个形状` : ''}` : '已删除连线', { action: '撤销', onAction: () => undoBoard() });
}
// 复制一组形状（连同它们之间的连线），偏移 dx/dy 放下并选中
async function cloneShapes(list, links, dx, dy) {
  const b = boardOf();
  if (!b || !list.length) return;
  record();
  const map = new Map(), top = topOrder(state.view);
  const copies = list.map((s, i) => { const c = { ...s, id: uid(), x: Math.round(s.x + dx), y: Math.round(s.y + dy), z: top + i }; delete c._t; map.set(s.id, c.id); return c; });
  b.shapes.push(...copies);
  for (const l of links) if (map.has(l.from.id) && map.has(l.to.id)) b.links.push({ ...l, id: uid(), from: { id: map.get(l.from.id) }, to: { id: map.get(l.to.id) } });
  state.bsel = pickShapes(copies.map((c) => c.id));
  await saveBoard();
}
const innerLinks = (ids) => boardOf().links.filter((l) => ids.has(l.from.id) && ids.has(l.to.id));
function duplicateSel() { const list = selShapes(); return cloneShapes(list, innerLinks(new Set(list.map((s) => s.id))), 24, 24); }
const CLIP_MARK = '方寸白板:';
function copySel() {
  const list = selShapes();
  if (!list.length) return false;
  boardClip = { id: uid(), shapes: JSON.parse(JSON.stringify(list)), links: JSON.parse(JSON.stringify(innerLinks(new Set(list.map((s) => s.id))))) };
  pasteN = 0;
  return true;
}
async function pasteClip() {
  if (!boardClip) return;
  const ub = unionBox(boardClip.shapes), vr = $('#viewport').getBoundingClientRect();
  let dx, dy;
  const inside = lastPointer && lastPointer.x > vr.left && lastPointer.x < vr.right && lastPointer.y > vr.top && lastPointer.y < vr.bottom;
  if (inside && pasteN === 0) { const p = toWorld(lastPointer.x, lastPointer.y); dx = p.x - ub.x - ub.w / 2; dy = p.y - ub.y - ub.h / 2; pasteN = 1; }
  else { pasteN++; dx = dy = 24 * pasteN; }
  await cloneShapes(boardClip.shapes, boardClip.links, dx, dy);
}
// 复制 / 剪切 / 粘贴走系统剪贴板事件：系统剪贴板里放一个标记，粘贴时认出来才粘贴形状，否则照常粘贴文件和文字
// （个别环境按快捷键不触发剪贴板事件：键盘处理里留了 60ms 的兜底，事件来了就取消兜底）
let clipTimer = 0, copiedAt = 0;
const boardClipboardOK = (e) => isCanvas(state.view) && !editingShape && !isTypingTarget(e.target) && !$('#modal').open && !$('#viewer').open && !getSelection().toString();
function doCopy(cut) {
  if (!copySel()) return false;
  copiedAt = Date.now();
  if (cut) deleteBoardSel(); else toast(`已复制 ${boardClip.shapes.length} 个形状，Ctrl+V 粘贴`);
  return true;
}
// 按键时已经复制好了；系统的 copy / cut 事件只负责把标记写进系统剪贴板（右键菜单复制时也走这里）
function onCopyEvent(e, cut) {
  if (!boardClipboardOK(e)) return;
  if (!(Date.now() - copiedAt < 500 && boardClip) && !(selIds().length && doCopy(cut))) return;
  e.preventDefault(); e.clipboardData.setData('text/plain', CLIP_MARK + boardClip.id);
}
document.addEventListener('copy', (e) => onCopyEvent(e, false), true);
document.addEventListener('cut', (e) => onCopyEvent(e, true), true);
window.addEventListener('paste', (e) => {
  // 正在编辑便签 / 形状文字：一律按纯文本插入（去掉网页、Word 带来的格式），字多了照常自动缩字号或长高
  const tx = editingShape && (e.target.closest?.('.sh-tx') || e.target.parentElement?.closest('.sh-tx'));
  if (tx) {
    e.preventDefault(); e.stopImmediatePropagation();
    const text = (e.clipboardData?.getData('text/plain') || '').replace(/\r\n?/g, '\n');
    if (text) document.execCommand('insertText', false, text);
    const s = shapeById(editingShape), el = tx.closest('.shape');
    if (s && el) fitShapeText(s, el);
    return;
  }
  if (!isCanvas(state.view) || editingShape || isTypingTarget(e.target)) return;
  clearTimeout(clipTimer); // 系统粘贴事件来了：只有剪贴板里是我们的标记才粘贴形状，否则交给原来的文件 / 文字粘贴
  if (!boardClip || e.clipboardData?.getData('text/plain') !== CLIP_MARK + boardClip.id) return;
  e.preventDefault(); e.stopImmediatePropagation();
  pasteClip();
}, true);
// 对一组通用画布框 { x, y, w, h } 进行原地智能对齐：自动吸附接近的行列、统一同列相近宽度、均分同列/同行间距
function smartSnapBoxes(boxes, tol = 56) {
  if (boxes.length < 2) return;
  const cluster1D = (items, getVal) => {
    const sorted = [...items].sort((a, b) => getVal(a) - getVal(b));
    const groups = [];
    for (const it of sorted) {
      const v = getVal(it), last = groups[groups.length - 1];
      if (last && Math.abs(v - last.avg) <= tol) {
        last.list.push(it);
        last.avg = last.list.reduce((s, x) => s + getVal(x), 0) / last.list.length;
      } else groups.push({ list: [it], avg: v });
    }
    return groups.filter((g) => g.list.length > 1);
  };
  // 1) 同列吸附（按水平中心聚类）
  for (const col of cluster1D(boxes, (b) => b.x + b.w / 2)) {
    const ws = col.list.map((b) => b.w);
    const minW = Math.min(...ws), maxW = Math.max(...ws);
    if (maxW - minW > 0 && maxW - minW <= 72) {
      const targetW = Math.round(ws.reduce((a, b) => a + b, 0) / ws.length);
      col.list.forEach((b) => { b.w = targetW; b.wChanged = true; });
    }
    const leftSpread = Math.max(...col.list.map((b) => b.x)) - Math.min(...col.list.map((b) => b.x));
    const centerSpread = Math.max(...col.list.map((b) => b.x + b.w / 2)) - Math.min(...col.list.map((b) => b.x + b.w / 2));
    if (leftSpread <= centerSpread + 8) {
      const targetX = Math.round(col.list.reduce((s, b) => s + b.x, 0) / col.list.length);
      col.list.forEach((b) => { b.x = targetX; });
    } else {
      const cx = col.list.reduce((s, b) => s + b.x + b.w / 2, 0) / col.list.length;
      col.list.forEach((b) => { b.x = Math.round(cx - b.w / 2); });
    }
    // 同列纵向等距整理（若纵向依次排列且间距不均或重叠）
    const vSorted = [...col.list].sort((a, b) => a.y - b.y);
    const gaps = [];
    for (let i = 1; i < vSorted.length; i++) gaps.push(vSorted[i].y - (vSorted[i - 1].y + vSorted[i - 1].h));
    if (gaps.length && gaps.every((g) => g >= -60 && g <= 160)) {
      const avgGap = Math.max(20, Math.round((gaps.reduce((a, b) => a + b, 0) / gaps.length) / 4) * 4);
      let curY = vSorted[0].y;
      for (const b of vSorted) { b.y = Math.round(curY); curY += b.h + avgGap; }
    }
  }
  // 2) 同行吸附（按顶部或垂直中心聚类）
  for (const row of cluster1D(boxes, (b) => b.y + b.h / 2)) {
    const topSpread = Math.max(...row.list.map((b) => b.y)) - Math.min(...row.list.map((b) => b.y));
    const midSpread = Math.max(...row.list.map((b) => b.y + b.h / 2)) - Math.min(...row.list.map((b) => b.y + b.h / 2));
    if (topSpread <= midSpread + 12) {
      const targetY = Math.round(row.list.reduce((s, b) => s + b.y, 0) / row.list.length);
      row.list.forEach((b) => { b.y = targetY; });
    } else {
      const cy = row.list.reduce((s, b) => s + b.y + b.h / 2, 0) / row.list.length;
      row.list.forEach((b) => { b.y = Math.round(cy - b.h / 2); });
    }
  }
}
async function alignSel(op) {
  const list = selShapes();
  if (list.length < 2) return;
  record();
  if (op === 'smart') {
    smartSnapBoxes(list);
    return saveBoard();
  }
  const ub = unionBox(list);
  if (op === 'l') list.forEach((s) => { s.x = ub.x; });
  if (op === 'r') list.forEach((s) => { s.x = ub.x + ub.w - s.w; });
  if (op === 'ch') list.forEach((s) => { s.x = Math.round(ub.x + ub.w / 2 - s.w / 2); });
  if (op === 't') list.forEach((s) => { s.y = ub.y; });
  if (op === 'b') list.forEach((s) => { s.y = ub.y + ub.h - s.h; });
  if (op === 'cv') list.forEach((s) => { s.y = Math.round(ub.y + ub.h / 2 - s.h / 2); });
  if (op === 'ew') {
    const tw = Math.round(list.reduce((sum, s) => sum + s.w, 0) / list.length);
    list.forEach((s) => { s.w = tw; });
  }
  if (op === 'dh' || op === 'dv') {
    const k = op === 'dh' ? 'x' : 'y', sz = op === 'dh' ? 'w' : 'h';
    const sorted = [...list].sort((a, b) => a[k] - b[k]);
    const gap = Math.max(16, (ub[sz] - sorted.reduce((t, s) => t + s[sz], 0)) / Math.max(1, sorted.length - 1));
    let at = ub[k];
    for (const s of sorted) { s[k] = Math.round(at); at += s[sz] + gap; }
  }
  await saveBoard();
}
function selectedCanvasCards() {
  return [...state.selected].map(findCard).filter((c) => c && c.columnId === state.view);
}
async function alignCanvasCards(op) {
  const cards = selectedCanvasCards();
  if (cards.length < 2) return toast('请先选择至少 2 张画布卡片');
  const before = cards.map((c) => ({ c, x: c.x, y: c.y, w: c.w }));
  const items = cards.map((c) => {
    const el = $(`#world .card[data-id="${CSS.escape(c.id)}"]`);
    const w = el?.offsetWidth || canvasCardW(c), h = el?.offsetHeight || 160;
    return { c, x: c.x || 0, y: c.y || 0, w, h, ar: h > 40 ? w / h : 1 };
  });
  if (op === 'smart') {
    smartSnapBoxes(items);
  } else {
    const ub = unionBox(items);
    if (op === 'l') items.forEach((it) => { it.x = ub.x; });
    if (op === 'r') items.forEach((it) => { it.x = ub.x + ub.w - it.w; });
    if (op === 'ch') items.forEach((it) => { it.x = Math.round(ub.x + ub.w / 2 - it.w / 2); });
    if (op === 't') items.forEach((it) => { it.y = ub.y; });
    if (op === 'b') items.forEach((it) => { it.y = ub.y + ub.h - it.h; });
    if (op === 'cv') items.forEach((it) => { it.y = Math.round(ub.y + ub.h / 2 - it.h / 2); });
    if (op === 'ew') {
      const tw = Math.round(items.reduce((s, it) => s + it.w, 0) / items.length);
      items.forEach((it) => { it.w = tw; it.wChanged = true; });
    }
    if (op === 'dh' || op === 'dv') {
      const k = op === 'dh' ? 'x' : 'y', sz = op === 'dh' ? 'w' : 'h';
      const sorted = [...items].sort((a, b) => a[k] - b[k]);
      const rawGap = (ub[sz] - sorted.reduce((t, it) => t + it[sz], 0)) / Math.max(1, sorted.length - 1);
      const gap = Math.max(24, rawGap);
      let at = ub[k];
      for (const it of sorted) { it[k] = Math.round(at); at += it[sz] + gap; }
    }
  }
  items.forEach((it) => {
    it.c.x = Math.round(it.x);
    it.c.y = Math.round(it.y);
    if (it.wChanged) it.c.w = Math.round(it.w);
    it.c.updatedAt = Date.now();
  });
  await db.putMany('cards', cards);
  await changed();
  toast(`已${ALIGN_OPS[op] || '对齐'} ${cards.length} 张卡片`, {
    action: '撤销',
    onAction: async () => {
      before.forEach(({ c, x, y, w }) => { c.x = x; c.y = y; if (w === undefined) delete c.w; else c.w = w; });
      await db.putMany('cards', cards);
      await changed();
    },
  });
}
async function autoAlignCanvas() {
  if (!isCanvas(state.view)) return;
  const pickedShapes = selShapes();
  const pickedCards = selectedCanvasCards();
  if (pickedShapes.length >= 2 && !pickedCards.length) return alignSel('smart');
  if (pickedCards.length >= 2 && !pickedShapes.length) return alignCanvasCards('smart');
  const b = boardOf();
  const allShapes = pickedShapes.length ? pickedShapes : (b?.shapes || []);
  const allCards = pickedCards.length ? pickedCards : cardsIn(state.view, false);
  if (allShapes.length + allCards.length < 2) return toast('画布上至少需要 2 个元素才能自动对齐');
  await waitImgs();
  const snap = snapBoard();
  const cardBefore = allCards.map((c) => ({ c, x: c.x, y: c.y, w: c.w }));
  const boxes = [
    ...allShapes.map((s) => ({ kind: 'shape', ref: s, x: s.x, y: s.y, w: s.w, h: s.h })),
    ...allCards.map((c) => {
      const el = $(`#world .card[data-id="${CSS.escape(c.id)}"]`);
      return { kind: 'card', ref: c, x: c.x || 0, y: c.y || 0, w: el?.offsetWidth || canvasCardW(c), h: el?.offsetHeight || 160 };
    }),
  ];
  smartSnapBoxes(boxes);
  for (const bx of boxes) {
    bx.ref.x = Math.round(bx.x);
    bx.ref.y = Math.round(bx.y);
    if (bx.wChanged) bx.ref.w = Math.round(bx.w);
  }
  if (allShapes.length) { record(snap); await saveArea(b); }
  if (allCards.length) await db.putMany('cards', allCards);
  await changed();
  toast(`已智能对齐 ${boxes.length} 个画布元素`, {
    action: '撤销',
    onAction: async () => {
      if (allShapes.length) {
        const prev = JSON.parse(snap);
        b.shapes = prev.s; b.links = prev.l;
        await saveArea(b);
      }
      if (allCards.length) {
        cardBefore.forEach(({ c, x, y, w }) => { c.x = x; c.y = y; if (w === undefined) delete c.w; else c.w = w; });
        await db.putMany('cards', allCards);
      }
      await changed();
    },
  });
}
async function editLinkLabel(id) {
  const l = linkById(id);
  if (!l) return;
  state.bsel = { type: 'link', id };
  const t = await prompt({ title: '连线上的文字', value: l.label || '', placeholder: '例如：然后、依赖、反馈', ok: '保存', optional: true });
  if (t === null || t === undefined || (t || '') === (l.label || '')) return renderCanvas();
  record();
  if (t) l.label = t; else delete l.label;
  await saveBoard();
}

// ---- 浮动格式条 ----
const FI = {
  minus: '<path d="M6 12h12"/>', plus: '<path d="M12 6v12M6 12h12"/>', bold: '<path d="M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z"/>',
  left: '<path d="M4 6h16M4 10h10M4 14h16M4 18h10"/>', center: '<path d="M4 6h16M7 10h10M4 14h16M7 18h10"/>',
  front: '<rect x="8" y="8" width="12" height="12" rx="1.5"/><path d="M4 16V5a1 1 0 0 1 1-1h11"/>', copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>', label: '<path d="M5 6V4h14v2M12 4v16M9 20h6"/>',
  dash: '<path d="M3 12h4M10 12h4M17 12h4"/>', curve: '<path d="M4 18C10 18 14 6 20 6"/>', swap: '<path d="M4 8h14l-3-3M20 16H6l3 3"/>',
  chev: '<path d="m7 10 5 5 5-5"/>', lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  back: '<rect x="4" y="4" width="12" height="12" rx="1.5"/><path d="M20 8v11a1 1 0 0 1-1 1H8"/>',
};
const fbtn = (act, icon, tip, on) => `<button type="button" class="icon-btn${on ? ' on' : ''}" data-fmt="${act}" data-tip="${tip}" aria-label="${tip}"${on != null ? ` aria-pressed="${!!on}"` : ''}><svg viewBox="0 0 24 24">${FI[icon]}</svg></button>`;
function positionFmt() {
  const bar = $('#fmtBar');
  if (!bar) return;
  const sel = state.bsel;
  const items = !sel ? [] : sel.type === 'shape' ? selShapes() : [linkById(sel.id)].filter(Boolean);
  if (!items.length || !isCanvas(state.view) || bd?.moved) { bar.hidden = true; delete bar.dataset.for; return; }
  const key = `${sel.type}:${JSON.stringify(items, (k, v) => (k === '_t' ? undefined : v))}:${fmtPop}`;
  if (bar.dataset.for !== key) {
    bar.dataset.for = key;
    if (sel.type === 'shape') {
      const s = items[items.length - 1], many = items.length > 1, col = shColor(s);
      const sameT = items.every((x) => x.t === s.t);
      bar.innerHTML = `${many ? `<span class="fb-count">${items.length} 个</span>` : ''}
        <select data-fmt="shape" aria-label="形状" data-tip="形状">${sameT ? '' : '<option value="" selected>混合</option>'}${Object.entries(SHAPE_NAMES).map(([k, n]) => `<option value="${k}" ${sameT && k === s.t ? 'selected' : ''}>${n}</option>`).join('')}</select>
        <span class="sep"></span>
        <button type="button" class="fb-chip${fmtPop === 'fill' ? ' open' : ''}" data-fmt="pop" data-v="fill" data-tip="填充颜色" aria-label="填充颜色" aria-expanded="${fmtPop === 'fill'}">
          <i class="sw${col ? '' : ' none'}" style="--c:${col ? col.bg : 'transparent'};--d:${col ? col.bd : 'var(--border)'}"></i><svg viewBox="0 0 24 24">${FI.chev}</svg></button>
        <span class="sep"></span>
        ${fbtn('fs-', 'minus', '缩小字号 · Ctrl+Shift+,')}
        <select data-fmt="fs" aria-label="字号" data-tip="字号">${[...new Set([...FONT_SIZES, s.fs])].sort((a, b) => a - b).map((n) => `<option value="${n}" ${n === s.fs ? 'selected' : ''}>${n}</option>`).join('')}</select>
        ${fbtn('fs+', 'plus', '放大字号 · Ctrl+Shift+.')}
        ${fbtn('bold', 'bold', '加粗 · Ctrl+B', items.every((x) => x.b))}${fbtn('align', s.al === 'left' ? 'left' : 'center', s.al === 'left' ? '左对齐' : '居中')}
        ${many ? `<span class="sep"></span><select data-fmt="arrange" aria-label="对齐与分布" data-tip="对齐与分布"><option value="" selected>对齐…</option>${Object.entries(ALIGN_OPS).filter(([k]) => items.length > 2 || !k.startsWith('d')).map(([k, n]) => `<option value="${k}">${n}</option>`).join('')}</select>` : ''}
        <span class="sep"></span>
        ${fbtn('front', 'front', '置于顶层 · Ctrl+]')}${fbtn('back', 'back', '置于底层 · Ctrl+[')}${fbtn('dup', 'copy', '复制一份 · Ctrl+D')}${fbtn('lock', 'lock', items.every((x) => x.lk) ? '解锁 · Ctrl+Shift+L' : '锁定 · Ctrl+Shift+L', items.every((x) => x.lk))}${fbtn('del', 'trash', '删除 · Delete')}
        ${fmtPop === 'fill' ? `<div class="fb-pop" role="menu">${SH_COLORS.map((c, k) => `<button type="button" class="sw${col && s.fill === k ? ' on' : ''}" data-fmt="fill" data-v="${k}" style="--c:${c.bg};--d:${c.bd}" data-tip="${c.n}" aria-label="${c.n}"></button>`).join('')}<button type="button" class="sw none${col ? '' : ' on'}" data-fmt="fill" data-v="none" data-tip="无填充" aria-label="无填充"></button></div>` : ''}`;
    } else {
      const l = items[0];
      bar.innerHTML = `<select data-fmt="end" aria-label="箭头" data-tip="箭头"><option value="arrow" ${!l.end || l.end === 'arrow' ? 'selected' : ''}>→ 单向</option><option value="both" ${l.end === 'both' ? 'selected' : ''}>↔ 双向</option><option value="none" ${l.end === 'none' ? 'selected' : ''}>— 无箭头</option></select>
        ${fbtn('swap', 'swap', '反转方向')}${fbtn('dash', 'dash', '虚线', !!l.dash)}${fbtn('curve', 'curve', '曲线', !!l.curve)}
        <span class="sep"></span>
        <button type="button" class="fb-chip${fmtPop === 'line' ? ' open' : ''}" data-fmt="pop" data-v="line" data-tip="线条颜色" aria-label="线条颜色" aria-expanded="${fmtPop === 'line'}">
          <i class="sw line" style="--c:${l.color || 'var(--text-2)'}"></i><svg viewBox="0 0 24 24">${FI.chev}</svg></button>
        <span class="sep"></span>
        ${fbtn('label', 'label', '线上文字 · 双击连线')}${fbtn('del', 'trash', '删除 · Delete')}
        ${fmtPop === 'line' ? `<div class="fb-pop" role="menu">${LINK_COLORS.map((c, k) => `<button type="button" class="sw line${(l.color || null) === c ? ' on' : ''}" data-fmt="lcolor" data-v="${k}" style="--c:${c || 'var(--text-2)'}" aria-label="线条颜色 ${k + 1}"></button>`).join('')}</div>` : ''}`;
    }
  }
  // 位置：选中对象上方，放不下就放下方
  const c = cam(), vr = $('#viewport').getBoundingClientRect(), cv = $('#canvasView').getBoundingClientRect();
  let bx, by, bh;
  if (sel.type === 'shape') { const ub = unionBox(items); bx = ub.x + ub.w / 2; by = ub.y; bh = ub.h; }
  else { const g = linkGeom(items[0]); if (!g) { bar.hidden = true; return; } bx = g.mid.x; by = g.mid.y - 10; bh = 20; }
  bar.hidden = false;
  const sx = vr.left - cv.left + c.x + bx * c.z, top = vr.top - cv.top + c.y + by * c.z - bar.offsetHeight - 16;
  const below = vr.top - cv.top + c.y + (by + bh) * c.z + 16;
  bar.style.left = `${Math.min(cv.width - bar.offsetWidth / 2 - 8, Math.max(bar.offsetWidth / 2 + 8, sx))}px`;
  const flip = top < 8;
  bar.style.top = `${flip ? Math.min(below, cv.height - bar.offsetHeight - 70) : top}px`;
  bar.classList.toggle('below', flip);
}
async function applyFmt(act, v) {
  const sel = state.bsel;
  if (!sel) return;
  if (act === 'pop') { fmtPop = fmtPop === v ? null : v; return positionFmt(); }
  if (act === 'del') return deleteBoardSel();
  if (act === 'dup') return duplicateSel();
  if (act === 'lock') return toggleLock();
  if (act === 'arrange') return v && alignSel(v);
  if (act === 'label') return editLinkLabel(sel.id);
  if (act === 'shape' && !v) return;
  record();
  if (act === 'fill' || act === 'lcolor') fmtPop = null;
  if (sel.type === 'shape') {
    const list = selShapes();
    const top = topOrder(state.view), boldOn = !list.every((x) => x.b), al = list[list.length - 1].al === 'left' ? 'center' : 'left';
    const bottom = Math.min(1, ...boardOf().shapes.map((s) => (Number.isFinite(s.z) ? s.z : 1)), ...cardsIn(state.view, false).map((c) => c.order || 1));
    list.forEach((s, i) => {
      if (act === 'shape') {
        const was = s.t; s.t = v;
        if (v === 'text' && was !== 'text') { s.fill = 'none'; s.al = 'left'; }
        if (was === 'text' && v !== 'text' && !shColor(s)) { s.fill = SH_DEF[v].fill; s.al = 'center'; }
        if (v === 'ellipse' || v === 'sticky') { const m = Math.max(s.w, s.h); if (Math.abs(s.w - s.h) < m * 0.5) s.w = s.h = m; }
        // 变成画框：保留原来的颜色（显示成淡淡的底色），标题左对齐；从画框变回来：文字居中
        if (v === 'frame' && was !== 'frame') { s.al = 'left'; s.fs = SH_DEF.frame.fs; if (!s.text) s.text = '画框'; }
        if (was === 'frame' && v !== 'frame') { s.al = SH_DEF[v].al; s.fs = SH_DEF[v].fs; }
      }
      if (act === 'fill') s.fill = v === 'none' ? 'none' : +v;
      if (act === 'fs') s.fs = +v;
      if (act === 'fs-' || act === 'fs+') {
        const cur = s.fs || 16;
        s.fs = act === 'fs+' ? FONT_SIZES.find((n) => n > cur) || cur : [...FONT_SIZES].reverse().find((n) => n < cur) || cur;
      }
      if (act === 'bold') { if (boldOn) s.b = true; else delete s.b; }
      if (act === 'align') s.al = al;
      if (act === 'front') s.z = top + i;
      if (act === 'back') s.z = bottom - list.length + i;
    });
    if (['fs', 'fs-', 'fs+', 'bold', 'shape'].includes(act)) {
      // 字变大后放不下：自动长高（便签除外，便签会自动缩小字号）
      renderCanvas();
      for (const s of list) {
        if (s.t === 'sticky') continue;
        const tx = shEl(s.id)?.querySelector('.sh-tx');
        if (tx) { const pad = s.t === 'text' ? 8 : s.t === 'diamond' ? s.h * 0.5 : s.t === 'ellipse' ? s.h * 0.3 : 28; s.h = Math.max(s.t === 'text' ? 24 : s.h, Math.ceil(tx.scrollHeight + pad)); }
      }
    }
  } else {
    const l = linkById(sel.id);
    if (!l) return;
    if (act === 'end') l.end = v;
    if (act === 'swap') [l.from, l.to] = [l.to, l.from];
    if (act === 'dash') l.dash = !l.dash;
    if (act === 'curve') l.curve = !l.curve;
    if (act === 'lcolor') { const c = LINK_COLORS[+v]; if (c) l.color = c; else delete l.color; }
  }
  await saveBoard();
}
$('#fmtBar').addEventListener('pointerdown', (e) => { e.stopPropagation(); if (e.target.closest('button')) e.preventDefault(); /* 不抢走正在编辑文字的焦点 */ });
$('#fmtBar').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-fmt]');
  if (b) applyFmt(b.dataset.fmt, b.dataset.v);
});
$('#fmtBar').addEventListener('change', (e) => {
  const s = e.target.closest('select[data-fmt]');
  if (s) applyFmt(s.dataset.fmt, s.value);
});

// ---- 缩放到选中 / 快捷键速查 ----
function zoomToBox(box, maxZ = 2) {
  const r = $('#viewport').getBoundingClientRect(), pad = 80;
  const z = Math.min(maxZ, Math.max(0.15, Math.min((r.width - pad * 2) / Math.max(box.w, 1), (r.height - pad * 2) / Math.max(box.h, 1))));
  tweenCam({ z, x: r.width / 2 - (box.x + box.w / 2) * z, y: r.height / 2 - (box.y + box.h / 2) * z });
}
function zoomToSelection() {
  const sel = state.bsel;
  let box = sel?.type === 'shape' ? unionBox(selShapes()) : null;
  if (sel?.type === 'link') { const g = linkGeom(linkById(sel.id)); if (g) box = unionBox([{ x: g.p1.x, y: g.p1.y, w: 0, h: 0 }, { x: g.p2.x, y: g.p2.y, w: 0, h: 0 }]); }
  if (!box && state.selected.size) {
    box = unionBox([...state.selected].map((id) => $(`#world .card[data-id="${CSS.escape(id)}"]`)).filter(Boolean)
      .map((el) => ({ x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight })));
  }
  if (!box) return zoomFit();
  zoomToBox(box);
}

// ---- 模板：一键插入一套预设的便签、形状和连线 ----
// 用小工具函数描述模板：frame 分区框、note 便签、box 形状、text 文字、link 连线（坐标是模板内部的相对坐标）
function tplBuilder() {
  const shapes = [], links = [];
  const add = (o) => {
    const d = SH_DEF[o.t];
    const s = { id: uid(), text: '', fill: d.fill, fs: d.fs, al: d.al, ...o };
    if (!s.b) delete s.b;
    shapes.push(s);
    return shapes.length - 1;
  };
  return {
    shapes, links,
    frame: (x, y, w, h, title) => add({ t: 'rect', x, y, w, h, text: title, fill: 'none', fs: 18, b: true, al: 'left', va: 'top', frame: true }),
    note: (x, y, text, fill = 0, w = 240, h = 110) => add({ t: 'sticky', x, y, w, h, text, fill, fs: 15, al: 'left' }),
    box: (x, y, w, h, text, o = {}) => add({ t: 'round', x, y, w, h, text, fill: 4, fs: 15, al: 'center', ...o }),
    wire: (x, y, w, h, text, fs = 13) => add({ t: 'rect', x, y, w, h, text, fill: 6, fs, al: 'center' }),
    text: (x, y, w, text, fs = 20, b = false) => add({ t: 'text', x, y, w, h: Math.round(fs * 1.5 * (text.split('\n').length) + 10), text, fs, b, fill: 'none', al: 'left' }),
    link: (a, b, o = {}) => { links.push({ id: uid(), from: { id: shapes[a].id }, to: { id: shapes[b].id }, end: 'arrow', ...o }); },
  };
}
const TEMPLATES = [
  {
    id: 'poster', name: '海报设计', desc: '需求 → 灵感 → 草图 → 定稿检查 → 输出规格，附一张海报版式线框',
    build(T) {
      T.text(0, 0, 900, '海报设计 · 〔项目名称〕', 32, true);
      const cols = [
        ['① 需求 Brief', 0, ['目的：这张海报要达成什么？', '受众：给谁看？在哪里看到？', '核心信息：标题 / 时间 / 地点 / 行动号召', '截止日期 · 交付规格']],
        ['② 灵感参考', 1, ['配色参考（把参考图拖进来）', '字体参考', '版式 / 构图参考', '关键词：氛围、风格、情绪']],
        ['③ 草图方案', 4, ['方案 A', '方案 B', '方案 C', '选定方案 & 理由']],
        ['④ 定稿检查', 5, ['☐ 文字校对：错别字、日期、电话', '☐ 品牌规范：Logo / 标准色 / 字体', '☐ 印刷：出血 3mm、CMYK、300dpi', '☐ 层级清晰：3 秒看懂主题']],
        ['⑤ 输出规格', 3, ['印刷：A3 297×420mm · A4 210×297mm', '竖屏：1080×1920（手机、电梯屏）', '方图 1080×1080 · 小红书 1080×1440', '格式：PDF（印刷）· PNG / JPG（线上）']],
      ];
      const frames = cols.map(([title, fill, notes], i) => {
        const x = i * 340, f = T.frame(x, 80, 300, 600, title);
        notes.forEach((n, j) => T.note(x + 30, 140 + j * 130, n, fill));
        return f;
      });
      frames.slice(1).forEach((f, i) => T.link(frames[i], f));
      const lf = T.frame(0, 760, 440, 660, '版式线框（A 系列比例 1 : 1.414）');
      T.wire(30, 820, 380, 76, '主标题', 22);
      T.wire(30, 908, 380, 40, '副标题 / 一句话卖点');
      T.wire(30, 960, 380, 270, '主视觉：插画 / 照片 / 图形', 16);
      T.wire(30, 1242, 250, 90, '时间 · 地点 · 信息区');
      T.wire(292, 1242, 118, 90, '二维码');
      T.wire(30, 1344, 380, 44, 'Logo / 主办方 / 版权');
      const tip = T.note(500, 820, '层级：标题 > 主视觉 > 信息 > Logo\n四周留白 ≥ 页面宽度的 5%', 0, 280, 130);
      T.link(tip, lf, { end: 'none', dash: true });
    },
  },
  {
    id: 'web', name: '网页开发', desc: '目标 → 站点地图 → 首页线框 → 开发任务看板 → 上线检查',
    build(T) {
      T.text(0, 0, 900, '网页开发 · 〔站点名称〕', 32, true);
      const f1 = T.frame(0, 80, 300, 600, '① 目标与受众');
      ['网站要解决什么问题？', '目标用户是谁？他们从哪来？', '成功指标：访问量 / 转化 / 停留', '参考网站：…'].forEach((n, j) => T.note(30, 140 + j * 130, n, 0));
      const f2 = T.frame(340, 80, 520, 600, '② 站点地图');
      const home = T.box(510, 150, 180, 56, '首页', { b: true });
      const kids = ['关于', '作品 / 产品', '博客', '联系'].map((n, i) => T.box(362 + i * 124, 290, 110, 52, n, { fill: 4, fs: 14 }));
      kids.forEach((k) => T.link(home, k, { curve: true }));
      T.link(kids[1], T.box(486, 420, 110, 52, '详情页', { fill: 7, fs: 14 }));
      T.link(kids[2], T.box(610, 420, 110, 52, '文章页', { fill: 7, fs: 14 }));
      T.note(370, 540, '每个页面写一句：用户来这里要做什么？', 0, 460, 100);
      const f3 = T.frame(900, 80, 420, 600, '③ 首页线框');
      T.wire(920, 140, 380, 44, 'Logo · 导航菜单 · 按钮');
      T.wire(920, 196, 380, 150, 'Hero：大标题 + 一句话 + 行动按钮', 15);
      [0, 1, 2].forEach((i) => T.wire(920 + i * 130, 358, 120, 110, `亮点 ${i + 1}`));
      T.wire(920, 480, 380, 100, '内容区：作品 / 案例 / 评价');
      T.wire(920, 592, 380, 60, '页脚：联系方式 · 社交链接');
      const f4 = T.frame(1360, 80, 660, 600, '④ 开发任务');
      [['待办', 0, ['搭建项目 & 目录结构', '响应式布局', 'SEO：标题 / 描述 / 分享图', '表单 / 联系方式']], ['进行中', 1, ['首页开发']], ['完成', 5, ['域名 & 代码仓库']]]
        .forEach(([h, fill, notes], i) => {
          T.text(1385 + i * 212, 130, 190, h, 17, true);
          notes.forEach((n, j) => T.note(1385 + i * 212, 175 + j * 122, n, fill, 190, 104));
        });
      const f5 = T.frame(2060, 80, 300, 600, '⑤ 上线检查');
      ['☐ 手机 / 平板适配', '☐ Lighthouse 性能 ≥ 90', '☐ 404 页面 & 死链检查', '☐ HTTPS · 统计分析 · 备份'].forEach((n, j) => T.note(2090, 140 + j * 130, n, 5));
      [f1, f2, f3, f4, f5].slice(1).forEach((f, i) => T.link([f1, f2, f3, f4, f5][i], f));
    },
  },
  {
    id: 'feature', name: '功能开发', desc: '用户故事 → 验收标准 → 方案判断 → 任务拆分 → 测试 → 发布，带风险与复盘',
    build(T) {
      T.text(0, 0, 900, '功能开发 · 〔功能名称〕', 32, true);
      const story = T.note(0, 90, '用户故事\n作为〔角色〕，我想要〔做什么〕，以便〔得到什么〕', 0, 300, 170);
      const req = T.frame(360, 80, 300, 440, '需求与验收标准');
      ['验收 1：…', '验收 2：…', '边界：空数据 / 出错 / 无网络'].forEach((n, j) => T.note(390, 140 + j * 125, n, 5, 240, 105));
      const q = T.box(720, 110, 200, 140, '需要改后端？', { t: 'diamond', fill: 3, b: true });
      const api = T.box(990, 30, 220, 110, '接口设计\n请求 / 返回 / 错误码', { fill: 4 });
      const fe = T.box(990, 230, 220, 110, '前端实现\n组件 / 状态 / 交互', { fill: 4 });
      const tasks = T.frame(1270, 30, 300, 520, '任务拆分');
      ['UI 组件', '状态 / 数据流', '接口联调', '埋点 & 日志'].forEach((n, j) => T.note(1300, 90 + j * 112, n, 0, 240, 96));
      const test = T.box(1630, 120, 200, 110, '测试\n单元 · 手动 · 回归', { fill: 5 });
      const ship = T.box(1890, 120, 180, 110, '发布\n灰度 → 全量', { fill: 1, b: true });
      const retro = T.note(1890, 300, '上线后复盘：数据怎么样？用户反馈？', 3, 200, 140);
      T.note(360, 560, '风险 / 待确认', 2, 300, 120);
      T.note(720, 330, '相关文档 / 设计稿链接', 7, 220, 110);
      T.link(story, req); T.link(req, q);
      T.link(q, api, { label: '是' }); T.link(q, fe, { label: '否' });
      T.link(api, fe); T.link(fe, tasks); T.link(tasks, test); T.link(test, ship); T.link(ship, retro, { dash: true });
    },
  },
  {
    id: 'brainstorm', name: '头脑风暴', desc: '中心主题 + 六个方向，先求多再求好',
    build(T) {
      T.text(0, 0, 700, '头脑风暴：先求多，再求好', 28, true);
      const c = T.box(380, 330, 240, 150, '中心主题', { t: 'ellipse', fill: 1, fs: 22, b: true });
      const fills = [0, 4, 5, 2, 3, 0];
      fills.forEach((fill, i) => {
        const a = -Math.PI / 2 + i * (Math.PI / 3), x = 500 + Math.cos(a) * 380 - 100, y = 405 + Math.sin(a) * 280 - 75;
        T.link(c, T.note(Math.round(x), Math.round(y), `想法 ${i + 1}`, fill, 200, 150), { end: 'none' });
      });
    },
  },
  {
    id: 'retro', name: '项目复盘', desc: '做得好 / 待改进 / 行动项，开会时一起填',
    build(T) {
      T.text(0, 0, 700, '项目复盘 · 〔项目名称〕', 32, true);
      [['做得好', 5, ['…', '…', '…']], ['待改进', 2, ['…', '…', '…']], ['行动项', 4, ['要做什么 · 负责人 · 截止日期', '…', '…']]]
        .forEach(([title, fill, notes], i) => {
          T.frame(i * 340, 80, 300, 500, title);
          notes.forEach((n, j) => T.note(i * 340 + 30, 140 + j * 135, n, fill, 240, 115));
        });
    },
  },
];
// 模板预览：按模板数据画一张缩略图
function tplPreview(T) {
  const ub = unionBox(T.shapes), pad = 30;
  const vb = `${ub.x - pad} ${ub.y - pad} ${ub.w + pad * 2} ${ub.h + pad * 2}`;
  const byId = new Map(T.shapes.map((s) => [s.id, s]));
  const lines = T.links.map((l) => {
    const a = byId.get(l.from.id), b = byId.get(l.to.id);
    return a && b ? `<line x1="${a.x + a.w / 2}" y1="${a.y + a.h / 2}" x2="${b.x + b.w / 2}" y2="${b.y + b.h / 2}" class="tp-ln"/>` : '';
  }).join('');
  const shapes = T.shapes.map((s) => {
    const col = shColor(s), fill = col ? col.bg : 'none';
    if (s.t === 'text') return `<rect x="${s.x}" y="${s.y + s.h * 0.25}" width="${Math.min(s.w, s.text.length * s.fs * 0.9)}" height="${s.h * 0.5}" rx="6" class="tp-tx"/>`;
    if (s.t === 'ellipse') return `<ellipse cx="${s.x + s.w / 2}" cy="${s.y + s.h / 2}" rx="${s.w / 2}" ry="${s.h / 2}" fill="${fill}"/>`;
    if (s.t === 'diamond') return `<polygon points="${s.x + s.w / 2},${s.y} ${s.x + s.w},${s.y + s.h / 2} ${s.x + s.w / 2},${s.y + s.h} ${s.x},${s.y + s.h / 2}" fill="${fill}"/>`;
    return `<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" rx="${s.frame ? 16 : s.t === 'round' ? 14 : 4}" fill="${fill}" class="${s.frame ? 'tp-fr' : ''}"/>`;
  }).join('');
  return `<svg viewBox="${vb}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">${lines}${shapes}</svg>`;
}
async function pickTemplate() {
  if (!isCanvas(state.view)) return toast('先打开一张画布，再插入模板');
  const m = $('#modal');
  m.classList.add('wide', 'tpl-modal');
  const p = dialog(`<h3>从模板开始</h3><p class="stor-note">插入后都是普通的便签和形状，双击就能改文字，可以随意增删；Ctrl+Z 可以整体撤销。</p>
    <div class="tpl-grid">${TEMPLATES.map((t) => { const T = tplBuilder(); t.build(T); return `<button type="submit" value="ok" class="tpl-card" data-tpl="${t.id}">
      <span class="tpl-prev">${tplPreview(T)}</span><b>${esc(t.name)}</b><small>${esc(t.desc)}</small></button>`; }).join('')}</div>
    <div class="modal-actions"><button class="btn" value="cancel" formnovalidate>取消</button></div>`, (f) => f.dataset.pick);
  delete $('#modalInner').dataset.pick;
  const id = await p;
  m.classList.remove('wide', 'tpl-modal');
  if (id) insertTemplate(id);
}
// 点哪张模板卡片，就记下哪个（随后表单提交时读取）
$('#modalInner').addEventListener('click', (e) => { const b = e.target.closest?.('[data-tpl]'); if (b) e.currentTarget.dataset.pick = b.dataset.tpl; });
async function insertTemplate(id) {
  const tpl = TEMPLATES.find((t) => t.id === id), b = boardOf();
  if (!tpl || !b) return;
  if (editingShape) await finishEdit();
  const T = tplBuilder();
  tpl.build(T);
  record();
  const ub = unionBox(T.shapes);
  // 放在现有内容的右边，不和已有的东西重叠；空画布就放在原点
  const existing = unionBox([...b.shapes, ...$$('#world .card.on-canvas').map((el) => ({ x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight }))]);
  const ox = existing ? existing.x + existing.w + 240 - ub.x : -ub.x, oy = existing ? existing.y - ub.y : -ub.y;
  const top = topOrder(state.view);
  T.shapes.forEach((s, i) => { s.x = Math.round(s.x + ox); s.y = Math.round(s.y + oy); s.z = top + i; });
  b.shapes.push(...T.shapes);
  b.links.push(...T.links);
  state.bsel = null;
  setTool('select');
  await saveBoard();
  zoomToBox({ x: ub.x + ox, y: ub.y + oy, w: ub.w, h: ub.h }, 1);
  toast(`已插入「${tpl.name}」模板，双击便签就能改文字`, { action: '撤销', onAction: () => undoBoard() });
}
const SHORTCUTS = [
  ['工具', [['V', '选择'], ['N', '便签'], ['T', '文字'], ['R', '矩形'], ['O', '圆形'], ['D', '菱形'], ['L', '箭头连线'], ['C', '备注评论'], ['双击工具', '锁定工具，连续放置'], ['Esc', '退出工具 / 取消选中']]],
  ['拖动', [['Shift + 拖动', '只水平或只垂直移动'], ['Alt + 拖动', '复制一份拖走（形状、文件卡片都可以）'], ['Ctrl + 拖动', '暂时关闭对齐吸附（文件卡片上是转换圆环）'], ['Shift + 拖角', '等比缩放'], ['Alt + 拖边 / 角', '以中心对称缩放'], ['Shift / Alt + 画形状', '画正方形 / 从中心向外画'], ['拖连接点到空白处', '新建一个相连的形状']]],
  ['选择', [['左键拖空白处', '拉出多选框（框选卡片与形状）'], ['Shift + 点击', '加选 / 减选'], ['Ctrl + A', '全选画布内容'], ['Enter / 双击', '编辑文字 / 预览卡片'], ['Esc / Ctrl + Enter', '结束编辑']]],
  ['编辑', [['Ctrl + Z', '撤销'], ['Ctrl + Y / Ctrl + Shift + Z', '重做'], ['Ctrl + C / X / V', '复制 / 剪切 / 粘贴'], ['Ctrl + D', '原地复制'], ['Ctrl + Shift + L', '锁定 / 解锁'], ['多选后拖外框角点', '整体等比缩放（Alt 以中心）'], ['Delete', '删除'], ['方向键', '微移（Shift 每次 40）'], ['Ctrl + 方向键', '在该方向新建相连形状'], ['Ctrl + ] / [', '置于顶层 / 底层'], ['Ctrl + B', '加粗'], ['Ctrl + Shift + . / ,', '放大 / 缩小字号']]],
  ['视图', [['F', '最大化工作空间 / 沉浸模式'], ['鼠标中键 + 拖动', '平移画布（或空格 + 拖动），快速甩动松手会惯性滑动'], ['滚轮', '缩放（以鼠标位置为中心）'], ['Shift + 滚轮', '左右平移'], ['触控板双指上下滑 / 左右滑', '缩放 / 左右平移'], ['Shift + 1', '显示全部'], ['Shift + 2', '缩放到选中'], ['Shift + 0', '回到 100%'], ['?', '打开这张速查表']]],
];
function showShortcuts() {
  const m = $('#modal');
  m.classList.add('wide');
  const kbd = (s) => s.split(/( \+ | \/ )/).map((p) => (/^( \+ | \/ )$/.test(p) ? `<i>${p.trim()}</i>` : `<kbd>${esc(p)}</kbd>`)).join('');
  dialog(`<h3>画布快捷键</h3><div class="shortcut-grid">${SHORTCUTS.map(([g, rows]) => `<section><h4>${g}</h4>${rows.map(([k, d]) => `<div class="sc-row"><span class="sc-keys">${kbd(k)}</span><span>${esc(d)}</span></div>`).join('')}</section>`).join('')}</div>
    <div class="modal-actions"><button class="btn primary" value="ok">知道了</button></div>`, () => true).then(() => m.classList.remove('wide'));
}

// ---- 键盘 ----
document.addEventListener('keydown', (e) => {
  if (!isCanvas(state.view) || $('#modal').open || $('#viewer').open || ring) return;
  if (e.key === 'Alt') { e.preventDefault(); return; } // Alt 用于拖动复制，别让浏览器把焦点移到菜单栏
  if (editingShape) {
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); e.stopPropagation(); $(`.shape[data-sid="${CSS.escape(editingShape)}"] .sh-tx`)?.blur(); }
    return;
  }
  if (isTypingTarget(e.target) || e.altKey) return;
  const k = e.key.toLowerCase(), sel = state.bsel, mod = e.ctrlKey || e.metaKey;
  const onCard = e.target.closest?.('.card, button, a');
  if (e.key === ' ' && !onCard) { e.preventDefault(); if (!spaceDown) { spaceDown = true; vp.classList.add('space-pan'); hideDots(); } return; }
  if (mod && k === 'z') { e.preventDefault(); undoBoard(e.shiftKey); return; }
  if (mod && k === 'y') { e.preventDefault(); undoBoard(true); return; }
  if (mod && (k === 'c' || k === 'x') && selIds().length && !getSelection().toString()) { doCopy(k === 'x'); return; }
  if (mod && k === 'v' && boardClip) { clearTimeout(clipTimer); clipTimer = setTimeout(pasteClip, 60); return; }
  if (mod && k === 'a') {
    e.preventDefault();
    const cIds = cardsIn(state.view, false).map((c) => c.id);
    state.selected = new Set(cIds);
    document.body.classList.toggle('selecting', state.selected.size > 0);
    renderSelBar();
    state.bsel = pickShapes(boardOf().shapes.filter((s) => !s.lk).map((s) => s.id)); // 全选不含锁定的（和 Miro 一样）
    renderCanvas();
    return;
  }
  // Ctrl + Shift + L：锁定 / 解锁选中的形状和卡片
  if (mod && e.shiftKey && (e.code === 'KeyL' || k === 'l')) { e.preventDefault(); toggleLock(); return; }
  // 视图：F 最大化工作区，Shift+1 显示全部，Shift+2 缩放到选中，Shift+0 回到 100%；? 打开快捷键速查
  if (!mod && !e.shiftKey && k === 'f' && !onCard) { e.preventDefault(); toggleCanvasMax(); return; }
  if (!mod && e.shiftKey && e.code === 'Digit1') { e.preventDefault(); zoomFit(); return; }
  if (!mod && e.shiftKey && e.code === 'Digit2') { e.preventDefault(); zoomToSelection(); return; }
  if (!mod && e.shiftKey && e.code === 'Digit0') { e.preventDefault(); zoomAt(1 / cam().z, null, null, true); return; }
  if (!mod && (e.key === '?' || (e.shiftKey && e.code === 'Slash'))) { e.preventDefault(); showShortcuts(); return; }
  if (!mod && TOOL_KEYS[k] && !onCard) { e.preventDefault(); setTool(TOOL_KEYS[k]); return; }
  if (e.key === 'Escape') {
    if (openCommentId) { closeCommentPop(); e.stopPropagation(); }
    else if (!$('#commentsPopover').hidden) { toggleCommentsPopover(false); e.stopPropagation(); }
    else if (state.tool !== 'select') { setTool('select'); e.stopPropagation(); }
    else if (fmtPop) { fmtPop = null; positionFmt(); e.stopPropagation(); }
    else if (sel) { selectBoard(null); e.stopPropagation(); }
    else if (document.body.classList.contains('canvas-maximized') && !state.selected.size && !state.pickedCard) { toggleCanvasMax(false); e.stopPropagation(); }
    return;
  }
  if (!sel) return;
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteBoardSel(); return; }
  if (sel.type !== 'shape') return;
  const list = selShapes();
  if (!list.length) return;
  if (mod && k === 'd') { e.preventDefault(); duplicateSel(); return; }
  // 层级 / 文字：Ctrl+] 置顶、Ctrl+[ 置底、Ctrl+B 加粗、Ctrl+Shift+. / , 放大 / 缩小字号
  if (mod && (e.code === 'BracketRight' || e.key === ']' || e.key === '}')) { e.preventDefault(); applyFmt('front'); return; }
  if (mod && (e.code === 'BracketLeft' || e.key === '[' || e.key === '{')) { e.preventDefault(); applyFmt('back'); return; }
  if (mod && k === 'b') { e.preventDefault(); applyFmt('bold'); return; }
  if (mod && e.shiftKey && (e.code === 'Period' || e.key === '>' || e.key === '.')) { e.preventDefault(); applyFmt('fs+'); return; }
  if (mod && e.shiftKey && (e.code === 'Comma' || e.key === '<' || e.key === ',')) { e.preventDefault(); applyFmt('fs-'); return; }
  if (e.key === 'Enter' && list.length === 1) { e.preventDefault(); startEdit(list[0].id); return; }
  if (e.key.startsWith('Arrow')) {
    e.preventDefault();
    if (mod && list.length === 1) { createConnected(list[0], e.key); return; }
    const st = e.shiftKey ? 40 : 10;
    if (!list[0]._t) record();
    for (const s of freeShapes(list)) {
      s.x += e.key === 'ArrowLeft' ? -st : e.key === 'ArrowRight' ? st : 0;
      s.y += e.key === 'ArrowUp' ? -st : e.key === 'ArrowDown' ? st : 0;
      const el = shEl(s.id);
      if (el) { el.style.left = `${s.x}px`; el.style.top = `${s.y}px`; }
    }
    drawLinks(); decorateBoard(); positionFmt();
    sendCollabShapeLive(list, '正在微调位置');
    clearTimeout(list[0]._t);
    list[0]._t = setTimeout(() => { list.forEach((s) => delete s._t); saveArea(boardOf()); }, 400);
  }
}, true);
document.addEventListener('keyup', (e) => { if (e.key === ' ' && spaceDown) { spaceDown = false; vp.classList.remove('space-pan'); } });
window.addEventListener('blur', () => { spaceDown = false; vp.classList.remove('space-pan'); });

// ---------- 极速统一上传（多文件 / 多层级文件夹保留子文件夹结构） ----------
let activeUploadModal = null;

function formatThroughput(bytes, startMs) {
  const sec = (performance.now() - startMs) / 1000;
  if (sec < 0.08 || !bytes) return '';
  return ` · ${(bytes / (1024 * 1024 * sec)).toFixed(1)} MB/s`;
}

async function addFiles(files, areaId, index = null, pos = null, { quiet = false, extra = {} } = {}) {
  files = (files || []).filter((f) => f && !upTree.isIgnoredFile(f.name));
  if (!files.length) return [];
  if (!areaId || !area(areaId)) {
    areaId = state.view === CANVASES ? await pickCanvas() : defaultTarget();
    if (!areaId) return [];
  }
  const canvas = isCanvas(areaId);
  if (canvas && !pos) pos = state.view === areaId ? viewCenter() : { x: 0, y: 0 };
  const existing = cardsIn(areaId, false);
  if (index == null) index = existing.length;
  const n = files.length;
  const baseCanvasOrder = canvas ? topOrder(areaId) : 0;
  let orderForIndex;
  if (canvas) {
    orderForIndex = (i) => baseCanvasOrder + i;
  } else {
    const prev = existing[index - 1];
    const next = existing[index];
    if (!prev && !next) orderForIndex = (i) => i * 1024;
    else if (!prev) orderForIndex = (i) => next.order - (n - i) * 1024;
    else if (!next) orderForIndex = (i) => prev.order + (i + 1) * 1024;
    else {
      const step = (next.order - prev.order) / (n + 1);
      orderForIndex = (i) => prev.order + step * (i + 1);
    }
  }
  const batchId = n > 1 ? uid() : undefined;
  if (batchId && !extra.batchId) extra = { batchId, ...extra };
  const totalBytes = files.reduce((s, f) => s + (f.size || 0), 0);
  const showProgress = n > 1 || totalBytes >= 10 * 1024 * 1024;
  const t = showProgress
    ? toast(n === 1 ? `正在保存「${files[0].name || '文件'}」（${fmtSize(totalBytes)}）…` : `正在极速保存 0/${n}（${fmtSize(totalBytes)}）…`, { sticky: true })
    : null;
  const perRow = Math.max(1, Math.ceil(Math.sqrt(n)));
  const now = Date.now();
  const entries = files.map((f, i) => {
    const card = {
      id: uid(), kind: 'file', name: f.name || `粘贴的文件-${now + i}`, type: f.type || '', size: f.size,
      columnId: areaId, order: orderForIndex(i), createdAt: now + i, updatedAt: now + i, enteredAt: now + i, ...extra,
    };
    if (canvas) { card.x = pos.x + (i % perRow) * (CARD_W + 20); card.y = pos.y + Math.floor(i / perRow) * 120; }
    return { card, blob: f };
  });
  const startMs = performance.now();
  let lastTick = 0;
  let added = [], errors = [];
  uploadDepth++;
  try {
    ({ ok: added, errors } = await db.addFilesBatch(entries, {
      onProgress: t ? ({ done, total, bytesDone, bytesTotal }) => {
        const ts = performance.now();
        if (done === total || ts - lastTick >= 80) {
          lastTick = ts;
          const speed = formatThroughput(bytesDone, startMs);
          if (total === 1) t.set(`正在写入「${entries[0].card.name}」（${fmtSize(bytesDone)} / ${fmtSize(bytesTotal)}${speed}）…`);
          else t.set(`正在极速上传 ${done}/${total}（${fmtSize(bytesDone)} / ${fmtSize(bytesTotal)}${speed}）…`);
        }
      } : undefined,
    }));
  } finally {
    t?.close();
    uploadDepth = Math.max(0, uploadDepth - 1);
  }
  for (const card of added) {
    state.cards.push(card);
    state.fresh.add(card.id);
  }
  if (errors.length) {
    console.error(errors[0].error);
    const quota = errors.some(({ error: e }) => e && (e.name === 'QuotaExceededError' || /quota/i.test(e.message)));
    if (quota) toast('存储空间不足，请先备份并清理回收站', { error: true });
    else if (errors.length === 1) toast(`「${errors[0].card.name}」保存失败：${errors[0].error?.message || errors[0].error}`, { error: true });
    else toast(`有 ${errors.length} 个文件保存失败：${errors[0].error?.message || errors[0].error}`, { error: true });
  }
  const ok = added.length;
  if (ok) {
    const elapsed = ((performance.now() - startMs) / 1000).toFixed(2);
    if (!quiet) toast(`已保存 ${ok} 个文件到「${areaName(areaId)}」${ok > 10 || totalBytes >= 10 * 1024 * 1024 ? `（${elapsed}s）` : ''}`);
    requestPersist();
    await changed();
    if (canvas && ok > 1 && state.view === areaId) await masonry(added, pos);
  }
  return added;
}
// 按真实高度瀑布流排列一组画布卡片，避免重叠
const waitImgs = () => Promise.all($$('#world img[data-thumb], #world img[data-canvas-img], #world img[data-canvas-pdf]').map((img) => (img.complete && img.naturalWidth) ? 0
  : new Promise((r) => { img.addEventListener('load', r, { once: true }); img.addEventListener('error', r, { once: true }); setTimeout(r, 1500); })));
async function masonry(list, pos) {
  await waitImgs();
  const cols = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(list.length))));
  const colW = Math.max(CARD_W, ...list.map((c) => $(`#world .card[data-id="${c.id}"]`)?.offsetWidth || canvasCardW(c)));
  const heights = new Array(cols).fill(0);
  for (const card of list) {
    const el = $(`#world .card[data-id="${card.id}"]`);
    const i = heights.indexOf(Math.min(...heights));
    card.x = pos.x + i * (colW + 52); card.y = pos.y + heights[i];
    heights[i] += (el?.offsetHeight || 80) + 20;
    if (el) { el.style.left = `${card.x}px`; el.style.top = `${card.y}px`; }
  }
  await db.putMany('cards', list);
}
function captureDataTransferSync(dt) {
  const entries = [...(dt?.items || [])].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  const files = [...(dt?.files || [])];
  return { entries, files };
}
async function scanTransferPayload({ entries, files }, onTick) {
  if (!entries?.length || !entries.some((e) => e.isDirectory)) {
    return upTree.extractFromFileList(files);
  }
  const rawDirs = [];
  const fileTasks = [];
  let dirCount = 0;

  const walkEntry = async (entry, prefix = '') => {
    if (!entry) return;
    if (entry.isFile) {
      if (!upTree.isIgnoredFile(entry.name)) {
        const relPath = upTree.normalizeRelPath(prefix ? `${prefix}/${entry.name}` : entry.name);
        fileTasks.push({ entry, relPath });
      }
      return;
    }
    if (entry.isDirectory) {
      const dirRel = upTree.normalizeRelPath(prefix ? `${prefix}/${entry.name}` : entry.name);
      if (dirRel) {
        rawDirs.push(dirRel);
        dirCount++;
        onTick?.({ dirs: dirCount, files: fileTasks.length });
      }
      const reader = entry.createReader();
      const children = [];
      await new Promise((resolve) => {
        const next = () => reader.readEntries((batch) => {
          if (batch.length) { children.push(...batch); next(); }
          else resolve();
        }, () => resolve());
        next();
      });
      await Promise.all(children.map((ch) => walkEntry(ch, dirRel)));
    }
  };

  await Promise.all(entries.map((e) => walkEntry(e, '')));

  const rawFiles = new Array(fileTasks.length);
  let cursor = 0;
  let resolved = 0;
  const workers = Math.min(fileTasks.length, 32);
  await Promise.all(Array.from({ length: workers }, async () => {
    while (cursor < fileTasks.length) {
      const idx = cursor++;
      const { entry, relPath } = fileTasks[idx];
      const file = await new Promise((res) => entry.file(res, () => res(null)));
      if (file) rawFiles[idx] = { file, relPath };
      resolved++;
      if (resolved % 100 === 0 || resolved === fileTasks.length) {
        onTick?.({ dirs: dirCount, files: resolved, total: fileTasks.length });
      }
    }
  }));

  return { files: rawFiles.filter(Boolean), dirs: rawDirs };
}

async function executeUploadPlan(plan, { mode = 'folder-tree', targetAreaId = null, category = undefined, openOnFinish = true } = {}) {
  if (!plan?.files?.length && !plan?.dirPaths?.length) return [];
  if (mode === 'flat') {
    if (!plan.files.length) return [];
    return addFiles(plan.files.map((x) => x.file), targetAreaId);
  }

  const rootParentId = targetAreaId && area(targetAreaId)?.kind === 'folder' ? targetAreaId : null;
  const existing = folders();
  const baseOrder = existing.length ? existing[existing.length - 1].order + 1024 : 0;
  const now = Date.now();
  const startMs = performance.now();
  const { createdFolders, pathToFolderId, topFolderIds } = upTree.planFolderCreation(
    plan.dirPaths,
    existing,
    rootParentId,
    { baseOrder, colorStart: existing.length, colorCount: FCOLORS.length, category, now, makeId: uid },
  );

  if (createdFolders.length) {
    await db.putMany('columns', createdFolders);
    state.areas.push(...createdFolders);
  }

  const perFolderOrder = new Map();
  const batchId = plan.files.length > 1 ? uid() : undefined;
  const entries = plan.files.map((item, i) => {
    const colId = item.dirPath ? (pathToFolderId.get(item.dirPath) || rootParentId) : (rootParentId || topFolderIds[0] || defaultTarget());
    let nextOrder = perFolderOrder.get(colId);
    if (nextOrder === undefined) nextOrder = orderAt(colId, cardsIn(colId, false).length);
    perFolderOrder.set(colId, nextOrder + 1024);
    const f = item.file;
    const card = {
      id: uid(),
      kind: 'file',
      name: item.fileName || f.name || `文件-${now + i}`,
      type: f.type || '',
      size: f.size,
      columnId: colId,
      order: nextOrder,
      createdAt: now + i,
      updatedAt: now + i,
      enteredAt: now + i,
      ...(batchId ? { batchId } : {}),
    };
    return { card, blob: f };
  });

  const t = entries.length > 1 || plan.stats.totalBytes >= 5 * 1024 * 1024
    ? toast(`正在极速上传 ${createdFolders.length} 个文件夹、0/${entries.length} 个文件…`, { sticky: true })
    : null;
  let lastTick = 0;
  let added = [], errors = [];
  if (entries.length) {
    uploadDepth++;
    try {
      ({ ok: added, errors } = await db.addFilesBatch(entries, {
        onProgress: t ? ({ done, total, bytesDone, bytesTotal }) => {
          const ts = performance.now();
          if (done === total || ts - lastTick >= 80) {
            lastTick = ts;
            const speed = formatThroughput(bytesDone, startMs);
            t.set(`正在极速上传 ${done}/${total}（${fmtSize(bytesDone)} / ${fmtSize(bytesTotal)}${speed}）…`);
          }
        } : undefined,
      }));
    } finally {
      t?.close();
      uploadDepth = Math.max(0, uploadDepth - 1);
    }
  } else {
    t?.close();
  }

  for (const card of added) {
    state.cards.push(card);
    state.fresh.add(card.id);
  }
  if (errors.length) {
    console.error(errors[0].error);
    toast(`有 ${errors.length} 个文件保存失败：${errors[0].error?.message || errors[0].error}`, { error: true });
  }

  if (openOnFinish) {
    state.view = ARCHIVE;
    ls.set('view', ARCHIVE);
    if (rootParentId) {
      state.folder = rootParentId;
      ls.set('folder', rootParentId);
    } else if (topFolderIds.length === 1) {
      state.folder = topFolderIds[0];
      ls.set('folder', topFolderIds[0]);
    } else {
      state.folder = null;
      ls.set('folder', null);
    }
  }

  requestPersist();
  await changed();

  const elapsed = ((performance.now() - startMs) / 1000).toFixed(2);
  const createdIds = createdFolders.map((f) => f.id);
  const msg = createdFolders.length && added.length
    ? `已极速创建 ${createdFolders.length} 个文件夹并上传 ${added.length} 个文件（${elapsed}s）`
    : createdFolders.length
      ? `已创建 ${createdFolders.length} 个文件夹`
      : `已上传 ${added.length} 个文件（${elapsed}s）`;

  toast(msg, {
    action: (createdIds.length || added.length) ? '撤销' : undefined,
    onAction: async () => {
      if (added.length) await purgeMany(added.map((c) => c.id));
      for (const fid of createdIds) await db.del('columns', fid);
      const dropSet = new Set(createdIds);
      state.areas = state.areas.filter((a) => !dropSet.has(a.id));
      if (dropSet.has(state.folder)) {
        state.folder = rootParentId && area(rootParentId) ? rootParentId : null;
        ls.set('folder', state.folder);
      }
      await changed();
      toast('已撤销本次批量上传');
    },
  });
  return added;
}

function defaultUploadDestValue(preferDest = null) {
  if (preferDest) return preferDest;
  const fid = openFolder();
  if (fid) return `folder:${fid}`;
  if (state.view === ARCHIVE) return 'archive-root';
  if (isCanvas(state.view)) return `area:${state.view}`;
  if (state.view === WORKS && area(state.work)?.kind === 'work') return `area:${state.work}`;
  if (state.view === STORE && shelves().length) return `area:${openShelf() || shelves()[0].id}`; // 在云仓库里上传：默认存进当前打开的仓库文件夹
  const firstCol = columns()[0]?.id || fallbackZone();
  return firstCol ? `area:${firstCol}` : 'archive-root';
}

function buildDestSelectOptions(selectedVal) {
  const opts = [];
  opts.push(`<option value="archive-root"${selectedVal === 'archive-root' ? ' selected' : ''}>已完成项目（保留并自动创建多文件夹 / 子文件夹层级）</option>`);
  const fs = folders();
  if (fs.length) {
    opts.push('<optgroup label="放进已有项目文件夹（自动保留子文件夹）">');
    for (const f of fs) {
      const val = `folder:${f.id}`;
      opts.push(`<option value="${val}"${selectedVal === val ? ' selected' : ''}>${esc(folderPath(f))}</option>`);
    }
    opts.push('</optgroup>');
  }
  const shs = shelves();
  if (shs.length) {
    opts.push('<optgroup label="存入云仓库（长期保存）">');
    for (const s of shs) {
      const val = `area:${s.id}`;
      opts.push(`<option value="${val}"${selectedVal === val ? ' selected' : ''}>云仓库 · ${esc(s.title)}</option>`);
    }
    opts.push('</optgroup>');
  }
  const cols = columns();
  if (cols.length) {
    opts.push('<optgroup label="平铺到看板列">');
    for (const c of cols) {
      const val = `area:${c.id}`;
      opts.push(`<option value="${val}"${selectedVal === val ? ' selected' : ''}>看板 · ${esc(c.title)}</option>`);
    }
    opts.push('</optgroup>');
  }
  const zs = zones();
  if (zs.length) {
    opts.push('<optgroup label="平铺到右侧功能区">');
    for (const z of zs) {
      const val = `area:${z.id}`;
      opts.push(`<option value="${val}"${selectedVal === val ? ' selected' : ''}>功能区 · ${esc(z.title)}</option>`);
    }
    opts.push('</optgroup>');
  }
  const cvs = canvases();
  if (cvs.length) {
    opts.push('<optgroup label="放到画布">');
    for (const cv of cvs) {
      const val = `area:${cv.id}`;
      opts.push(`<option value="${val}"${selectedVal === val ? ' selected' : ''}>画布 · ${esc(cv.title)}</option>`);
    }
    opts.push('</optgroup>');
  }
  return opts.join('');
}

async function openUploadModal({ initialRaw = null, preferDest = null } = {}) {
  const m = $('#modal'), f = $('#modalInner');
  const rawFiles = [...(initialRaw?.files || [])];
  const rawDirs = [...(initialRaw?.dirs || [])];
  let stripSingleRoot = false;
  let wrapperName = '';
  let userPickedDest = Boolean(preferDest);
  let destVal = defaultUploadDestValue(preferDest);

  f.innerHTML = `<div class="upload-modal">
    <div class="up-head">
      <h3>极速上传 · 统一文件与多文件夹</h3>
      <span class="up-head-tip">多通道并发写入，不卡主界面</span>
    </div>
    <div class="up-dropzone" id="upDropzone" tabindex="0">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4m0 0-4 4m4-4 4 4"/><path d="M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2"/></svg>
      <div class="up-drop-title">将多个文件夹（如 2000、2001…）或文件拖放到这里</div>
      <div class="up-drop-sub">支持任意深度的子文件夹；或点击下方按钮多次追加</div>
      <div class="up-pick-btns">
        <button type="button" class="btn primary-soft" id="upPickDirBtn">选择文件夹</button>
        <button type="button" class="btn" id="upPickFilesBtn">选择多个文件</button>
      </div>
    </div>
    <div class="up-summary" id="upSummary" hidden>
      <div class="up-sum-bar">
        <span class="up-sum-text" id="upSumText"></span>
        <button type="button" class="up-clear-btn" id="upClearBtn">清空重选</button>
      </div>
      <div class="up-dir-chips" id="upDirChips"></div>
    </div>
    <div class="up-options">
      <label class="up-check" id="upStripWrap" hidden>
        <input type="checkbox" id="upStripRoot">
        <span id="upStripLabel"></span>
      </label>
      <div class="up-field">
        <label for="upWrapperName">归入统一父文件夹名称（可选，例如：Specialist 历年真题）</label>
        <input type="text" id="upWrapperName" placeholder="留空则直接保留原有各顶层文件夹（如 2000、2001…）" maxlength="100" autocomplete="off">
      </div>
      <div class="up-field">
        <label for="upDest">导入位置</label>
        <select id="upDest">${buildDestSelectOptions(destVal)}</select>
      </div>
      <p class="up-hint-note" id="upHintNote"></p>
    </div>
    <div class="modal-actions">
      <button type="button" class="btn primary" id="upSubmitBtn" disabled>开始上传</button>
      <button type="button" class="btn" id="upCancelBtn">取消</button>
    </div>
  </div>`;

  const dz = $('#upDropzone');
  const sumBox = $('#upSummary');
  const sumText = $('#upSumText');
  const dirChips = $('#upDirChips');
  const stripWrap = $('#upStripWrap');
  const stripCb = $('#upStripRoot');
  const stripLabel = $('#upStripLabel');
  const wrapInput = $('#upWrapperName');
  const destSel = $('#upDest');
  const hintNote = $('#upHintNote');
  const submitBtn = $('#upSubmitBtn');
  let curPlan = null;

  const refresh = (autoSwitchToArchive = false) => {
    curPlan = upTree.buildUploadPlan(rawFiles, rawDirs, { stripSingleRoot, wrapperName });
    if (autoSwitchToArchive && curPlan.hasDirs && !userPickedDest && destSel.value.startsWith('area:') && state.view !== STORE) {
      destSel.value = 'archive-root';
    }
    destVal = destSel.value;
    const { fileCount, dirCount, totalBytes, singleRootName, canStripRoot } = curPlan.stats;
    const hasAny = fileCount > 0 || dirCount > 0;
    sumBox.hidden = !hasAny;
    submitBtn.disabled = !hasAny;
    if (hasAny) {
      sumText.textContent = dirCount
        ? `已识别 ${dirCount} 个文件夹（${curPlan.topDirs.length} 个顶层目录） · ${fileCount} 个文件 · ${fmtSize(totalBytes)}`
        : `已选择 ${fileCount} 个文件 · ${fmtSize(totalBytes)}`;
      const shown = curPlan.topDirs.slice(0, 24);
      const moreCount = curPlan.topDirs.length - shown.length;
      dirChips.hidden = !shown.length;
      dirChips.innerHTML = shown.map((d) => `<span class="up-chip" title="${esc(d)}">📁 ${esc(d)}</span>`).join('')
        + (moreCount > 0 ? `<span class="up-chip more">+${moreCount} 个文件夹</span>` : '');
      submitBtn.textContent = fileCount ? `开始极速上传（${fileCount}）` : `创建 ${dirCount} 个文件夹`;
    } else {
      submitBtn.textContent = '开始上传';
    }

    stripWrap.hidden = !canStripRoot;
    if (canStripRoot) {
      stripLabel.textContent = `不创建外层总目录「${singleRootName}」，直接展开内部子文件夹到当前层级`;
    }
    const isTreeDest = destVal === 'archive-root' || destVal.startsWith('folder:');
    if (curPlan.hasDirs && !isTreeDest) {
      hintNote.textContent = '提示：当前选择了看板/功能区/画布的平铺位置，上传后文件将展开放在同一列表；如需保留文件夹与子文件夹结构，请选「已完成项目」。';
    } else if (isTreeDest && curPlan.hasDirs) {
      hintNote.textContent = '将自动创建对应的全部文件夹与子文件夹，并在保持顺序的同时极速写入内容。';
    } else {
      hintNote.textContent = wrapperName.trim()
        ? `将创建文件夹「${wrapperName.trim()}」并把所选文件放进去。`
        : '提示：如果填入「父文件夹名称」，松散文件也会自动收纳进同一个文件夹。';
    }
  };

  const addRaw = (raw) => {
    if (!raw) return;
    if (raw.files?.length) rawFiles.push(...raw.files);
    if (raw.dirs?.length) rawDirs.push(...raw.dirs);
    refresh(true);
  };

  activeUploadModal = { addRaw };
  refresh(Boolean(initialRaw?.dirs?.length || rawFiles.some((x) => String(x.relPath || '').includes('/'))));

  $('#upPickDirBtn').onclick = () => $('#dirInput').click();
  $('#upPickFilesBtn').onclick = () => $('#fileInput').click();
  $('#upClearBtn').onclick = () => {
    rawFiles.length = 0;
    rawDirs.length = 0;
    stripSingleRoot = false;
    stripCb.checked = false;
    refresh(false);
  };
  stripCb.onchange = () => { stripSingleRoot = stripCb.checked; refresh(false); };
  wrapInput.oninput = () => {
    wrapperName = wrapInput.value;
    if (wrapperName.trim() && !userPickedDest && destSel.value.startsWith('area:') && state.view !== STORE) destSel.value = 'archive-root';
    refresh(false);
  };
  destSel.onchange = () => { userPickedDest = true; refresh(false); };

  dz.addEventListener('dragover', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault(); e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    dz.classList.add('drag-over');
  });
  dz.addEventListener('dragleave', (e) => {
    if (!dz.contains(e.relatedTarget)) dz.classList.remove('drag-over');
  });
  dz.addEventListener('drop', async (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault(); e.stopPropagation();
    dz.classList.remove('drag-over');
    const snap = captureDataTransferSync(e.dataTransfer);
    const prevText = sumText.textContent;
    if (snap.entries.some((en) => en.isDirectory)) {
      sumBox.hidden = false;
      sumText.textContent = '正在高速扫描文件夹结构…';
    }
    const raw = await scanTransferPayload(snap, ({ dirs, files }) => {
      sumText.textContent = `正在扫描：${dirs} 个文件夹、${files} 个文件…`;
    });
    if (!raw.files.length && !raw.dirs.length && prevText) sumText.textContent = prevText;
    addRaw(raw);
  });

  const cleanup = () => {
    activeUploadModal = null;
    f.onsubmit = null;
    m.oncancel = null;
    m.onclose = null;
  };
  const closeSelf = () => {
    cleanup();
    if (m.open) m.close();
  };
  f.onsubmit = (e) => { e.preventDefault(); };
  m.oncancel = () => cleanup();
  m.onclose = () => cleanup();
  $('#upCancelBtn').onclick = () => closeSelf();
  submitBtn.onclick = async () => {
    if (!curPlan || (!curPlan.files.length && !curPlan.dirPaths.length)) return;
    const plan = curPlan;
    const sel = destSel.value;
    closeSelf();
    if (sel === 'archive-root' || sel.startsWith('folder:')) {
      const targetAreaId = sel.startsWith('folder:') ? sel.slice(7) : null;
      const cat = (!targetAreaId && state.view === ARCHIVE && state.archCat && state.archCat !== 'all' && state.archCat !== '__none') ? state.archCat : undefined;
      await executeUploadPlan(plan, { mode: 'folder-tree', targetAreaId, category: cat, openOnFinish: true });
    } else if (sel.startsWith('area:')) {
      await executeUploadPlan(plan, { mode: 'flat', targetAreaId: sel.slice(5) });
    }
  };
  m.showModal();
}

async function handleDirectInputUpload(raw) {
  const plan = upTree.buildUploadPlan(raw.files, raw.dirs);
  if (!plan.files.length && !plan.dirPaths.length) return;
  if (plan.hasDirs) {
    if (openFolder()) return executeUploadPlan(plan, { mode: 'folder-tree', targetAreaId: openFolder(), openOnFinish: true });
    if (state.view === ARCHIVE) {
      const cat = (state.archCat && state.archCat !== 'all' && state.archCat !== '__none') ? state.archCat : undefined;
      return executeUploadPlan(plan, { mode: 'folder-tree', targetAreaId: null, category: cat, openOnFinish: true });
    }
    return openUploadModal({ initialRaw: raw, preferDest: 'archive-root' });
  }
  return addFiles(plan.files.map((x) => x.file), defaultTarget());
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
  if (!(await confirmStoreDelete([card]))) return; // 云仓库里的文件：删除前再确认一次
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
  cleanupCanvasPdf(id);
  state.cards = state.cards.filter((c) => c.id !== id);
}
async function purgeMany(ids) {
  const list = [...new Set(ids || [])];
  if (!list.length) return;
  if (list.length <= 40) await Promise.all(list.map((id) => animateOut(id)));
  await db.deleteCardsBatch(list);
  for (const id of list) {
    for (const key of [id, `thumb:${id}`]) {
      const url = state.urls.get(key);
      if (url) { URL.revokeObjectURL(url); state.urls.delete(key); }
    }
    cleanupCanvasPdf(id);
    state.selected.delete(id);
  }
  const dropSet = new Set(list);
  state.cards = state.cards.filter((c) => !dropSet.has(c.id));
}
async function clearAreaToTrash(a) {
  if (!a || a.id === TRASH) return;
  const cards = cardsIn(a.id, false);
  if (!cards.length) return toast(`「${a.title}」已经是空的`);
  const kind = kindOf(a);
  if (cards.length >= 5) {
    const ok = await confirmBox({
      title: `清空「${a.title}」到回收站？`,
      body: `${KIND_LABEL[kind] || '当前区域'}内的 ${cards.length} 张卡片将全部移到回收站，可随时撤销或从回收站恢复。`,
      ok: '移到回收站',
      danger: true,
    });
    if (!ok) return;
  }
  if (cards.length <= 40) await Promise.all(cards.map((c) => animateOut(c.id)));
  const snap = cards.map((c) => ({ c, prevColumnId: c.prevColumnId, columnId: c.columnId, order: c.order, trashedAt: c.trashedAt }));
  const now = Date.now();
  for (const c of cards) {
    c.prevColumnId = a.id;
    c.columnId = TRASH;
    c.trashedAt = now;
    c.updatedAt = now;
    state.selected.delete(c.id);
  }
  await db.putMany('cards', cards);
  await changed();
  if (isCanvas(a.id) && collabSession?.canvasId === a.id) scheduleCollabSync();
  toast(`已把「${a.title}」的 ${cards.length} 张卡片移到回收站`, {
    action: '撤销',
    onAction: async () => {
      const fallback = area(a.id) ? a.id : defaultTarget();
      for (const s of snap) {
        s.c.columnId = area(s.columnId) ? s.columnId : fallback;
        s.c.prevColumnId = s.prevColumnId;
        s.c.order = s.order;
        if (s.trashedAt) s.c.trashedAt = s.trashedAt; else delete s.c.trashedAt;
        s.c.updatedAt = Date.now();
      }
      await db.putMany('cards', snap.map((s) => s.c));
      await changed();
      if (isCanvas(a.id) && collabSession?.canvasId === a.id) scheduleCollabSync();
    },
  });
}
async function download(id) {
  if (!(await ensureAccess())) return;
  const card = findCard(id);
  let url;
  try { url = await urlFor(id); } catch (e) { return toast(e.message || '读取失败', { error: true }); }
  if (!url) return toast('找不到文件内容', { error: true });
  const a = document.createElement('a');
  a.href = url;
  a.download = card.kind === 'note' ? `${card.name || '便签'}.txt` : card.name;
  document.body.appendChild(a); a.click(); a.remove();
}
async function newNote(areaId, pos) {
  areaId = areaId || (state.view === CANVASES ? await pickCanvas() : defaultTarget());
  if (!areaId) return;
  const res = await noteEditor({ name: '', text: '' });
  if (!res) return;
  const now = Date.now();
  const canvas = isCanvas(areaId);
  const card = { id: uid(), kind: 'note', name: res.name || '未命名便签', text: res.text, columnId: areaId,
    order: canvas ? topOrder(areaId) : orderAt(areaId, cardsIn(areaId, false).length), createdAt: now, updatedAt: now, enteredAt: now };
  if (canvas) Object.assign(card, pos || (state.view === areaId ? viewCenter() : { x: 0, y: 0 }));
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
const KIND_LABEL = { column: '列', zone: '功能区', canvas: '画布', folder: '项目文件夹', work: '作品', shelf: '云仓库文件夹' };
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
  if (kind !== 'folder' && kind !== 'work' && areasOf(kind).length <= 1) return toast(`至少保留一个${KIND_LABEL[kind]}`, { error: true });
  const cards = cardsIn(a.id, false);
  const nextZone = zones().find((z) => z.id !== a.id)?.id || TRASH;
  const kids = kind === 'folder' ? childFolders(a.id) : [];
  const parts = [];
  if (cards.length) parts.push(`里面的 ${cards.length} 张卡片会移到「回收站」`);
  if (kids.length) parts.push(`${kids.length} 个子文件夹会移到${parentOf(a) ? `「${parentOf(a).title}」` : '顶层'}`);
  if (kind === 'work' && visibleLogs(a).length) parts.push(`${visibleLogs(a).length} 条更新日志会一起删除`);
  const ok = await confirmBox({
    title: `删除${KIND_LABEL[kind]}「${a.title}」？`,
    body: parts.length ? `${parts.join('，')}，可在回收站随时恢复。` : `这个${KIND_LABEL[kind]}是空的。`,
    ok: '删除',
    danger: true,
  });
  if (!ok) return;
  const kidSnap = kids.map((k) => ({ k, parentId: k.parentId }));
  const cardSnap = cards.map((c) => ({ c, prevColumnId: c.prevColumnId, columnId: c.columnId, order: c.order, trashedAt: c.trashedAt }));
  if (kids.length) {
    kids.forEach((k) => { if (a.parentId) k.parentId = a.parentId; else delete k.parentId; });
    await db.putMany('columns', kids);
  }
  const now = Date.now();
  for (const c of cards) {
    c.prevColumnId = a.id;
    c.columnId = TRASH;
    c.trashedAt = now;
    c.updatedAt = now;
    state.selected.delete(c.id);
  }
  if (cards.length) await db.putMany('cards', cards);
  await db.del('columns', a.id);
  state.areas = state.areas.filter((x) => x !== a);
  if (state.view === a.id) setView(kind === 'canvas' ? CANVASES : BOARD);
  if (state.folder === a.id) { state.folder = a.parentId && area(a.parentId) ? a.parentId : null; ls.set('folder', state.folder); }
  if (state.work === a.id) { state.work = null; ls.set('work', null); }
  if (state.zone === a.id) { state.zone = nextZone; ls.set('zone', nextZone); }
  await changed();
  toast(`已删除${KIND_LABEL[kind]}「${a.title}」${cards.length ? `，${cards.length} 张卡片已移到回收站` : ''}`, {
    action: '撤销',
    onAction: async () => {
      await db.put('columns', a);
      if (!state.areas.includes(a)) state.areas.push(a);
      if (kidSnap.length) {
        kidSnap.forEach(({ k, parentId }) => { if (parentId) k.parentId = parentId; else delete k.parentId; });
        await db.putMany('columns', kidSnap.map((s) => s.k));
      }
      if (cardSnap.length) {
        cardSnap.forEach(({ c, prevColumnId, columnId, order, trashedAt }) => {
          c.columnId = columnId;
          c.prevColumnId = prevColumnId;
          c.order = order;
          if (trashedAt) c.trashedAt = trashedAt; else delete c.trashedAt;
          c.updatedAt = Date.now();
        });
        await db.putMany('cards', cardSnap.map((s) => s.c));
      }
      await changed();
    },
  });
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
async function pickCanvas(exceptId) {
  const options = canvases().filter((cv) => cv.id !== exceptId);
  if (!options.length) { toast('没有其他可选画布'); return null; }
  return dialog(`<h3>放到哪个画布？</h3>
    <div class="pick-list">${options.map((cv, i) => `<label class="pick">
      <input type="radio" name="canvas" value="${esc(cv.id)}" ${i === 0 ? 'checked' : ''}>
      <span>${esc(cv.title)}</span><small>${cardsIn(cv.id, false).length} 张卡片</small>
    </label>`).join('')}</div>${actions('放入画布')}`,
    (f) => f.querySelector('[name="canvas"]:checked')?.value);
}
function setView(v) {
  if (v !== state.view) {
    openCommentId = null;
    draftComment = null;
    const tp = $('#commentThreadPop');
    if (tp) tp.hidden = true;
    const cp = $('#commentsPopover');
    if (cp) cp.hidden = true;
  }
  if (!isCanvas(v) && document.body.classList.contains('canvas-maximized')) toggleCanvasMax(false);
  state.view = v;
  ls.set('view', v);
  if (collabSession) setRoomUrlParam(v === collabSession.canvasId ? collabSession.roomId : '');
}

// ---------- 预览 ----------
async function preview(id) {
  const card = findCard(id);
  if (!card) return;
  if (card.kind === 'note') return editNote(card);
  if (!(await ensureAccess())) return;
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
  let html, mount, url;
  try {
    url = await urlFor(id);
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
// 转换一个文件，结果放在原文件旁边（画布上放右侧），返回新卡片
async function convertOne(card, convId, say = () => {}) {
  const blob = await db.getBlob(card.id);
  if (!blob) throw new Error(`找不到「${card.name}」的文件内容`);
  const assignments = convId === 'pdf-split' ? await choosePdfSplit(card, blob) : undefined;
  if (assignments === null) return null;
  const files = await pv.convert(card, blob, convId, say, { assignments });
  const added = await placeBeside(card, files);
  if (!added.length) throw new Error('转换结果保存失败');
  return added;
}
async function placeBeside(card, files) {
  const areaId = card.columnId === TRASH ? defaultTarget() : card.columnId;
  const canvas = isCanvas(areaId);
  const idx = canvas ? null : cardsIn(areaId, false).findIndex((c) => c.id === card.id) + 1;
  const pos = canvas ? { x: (card.x || 0) + canvasCardW(card) + 60, y: card.y || 0 } : null;
  return addFiles(files, areaId, idx, pos, { quiet: true, extra: { sourceId: card.sourceId || card.id } });
}
const confirmPdfCompression = () => confirmBox({
  title: '压缩 PDF？',
  body: '会先尝试无损压缩。若效果有限，会尝试将页面转为图片，压缩副本中的文字将无法选中或搜索。原 PDF 会保留。',
  ok: '开始压缩',
});
async function runConvert(btn) {
  if (!(await ensureAccess())) return;
  const card = findCard(btn.dataset.id);
  if (!card || btn.classList.contains('busy')) return;
  const status = $('#cvStatus');
  const say = (s) => { if (status) status.textContent = s; };
  btn.classList.add('busy');
  say('正在转换…');
  try {
    if (btn.dataset.conv === 'pdf-compress' && !(await confirmPdfCompression())) { say(''); return; }
    const added = await convertOne(card, btn.dataset.conv, say);
    if (!added) { say(''); return; }
    say(`✓ 已生成 ${added.length} 个文件，放在「${areaName(added[0]?.columnId)}」原文件旁边`);
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
function closeViewer() { const v = $('#viewer'); if (v.open) v.close(); $('#viewerInner').innerHTML = ''; v.classList.remove('site-viewer'); }
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
    const first = f.querySelector('[autofocus]') || f.querySelector('input, textarea');
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

async function choosePdfSplit(card, blob) {
  const modal = $('#modal');
  modal.classList.add('pdf-split-modal');
  modal.setAttribute('aria-labelledby', 'pdfSplitTitle');
  const assignments = new Map();
  const pendingThumbnails = new Set();
  let pdf, page = 1, part = 1, partCount = 2, selectionAnchor = null;
  let active = true, renderId = 0, thumbnails, drawingThumbnails = false;
  const partHue = (number) => (216 + (number - 1) * 137.508) % 360;
  const result = dialog(`<h3 id="pdfSplitTitle" tabindex="-1" autofocus>拆分 PDF</h3>
    <p class="pdf-split-name">${esc(card.name)}</p>
    <div class="pdf-split-layout">
      <section class="pdf-split-preview" aria-label="PDF 预览">
        <div class="pdf-split-paper" id="pdfSplitPaper" aria-live="polite"><p>正在打开 PDF…</p></div>
        <nav class="pdf-split-nav" aria-label="预览翻页">
          <button type="button" class="btn" id="pdfSplitPrev" disabled>上一页</button>
          <label>第 <input type="number" id="pdfSplitPage" aria-label="预览页码" min="1" step="1" value="1" disabled> 页</label>
          <span id="pdfSplitTotal"></span>
          <button type="button" class="btn" id="pdfSplitNext" disabled>下一页</button>
        </nav>
      </section>
      <section class="pdf-split-options" aria-label="分组勾选">
        <div class="pdf-split-parts-head">
          <h4>拆分部分</h4>
          <button type="button" class="btn" id="pdfSplitAdd" disabled>添加部分</button>
        </div>
        <div class="pdf-split-parts" id="pdfSplitParts" role="group" aria-label="选择要编辑的部分"></div>
        <p>先选部分，再勾选页面。Shift + 点击可连续勾选，点击缩略图可预览。未分组页面不导出。</p>
        <div class="pdf-split-pages" id="pdfSplitPages" role="group" aria-label="勾选页面"></div>
        <p id="pdfSplitSummary" role="status"></p>
      </section>
    </div>${actions('开始拆分')}`, () => new Map(assignments));
  const paper = $('#pdfSplitPaper'), pageInput = $('#pdfSplitPage'), grid = $('#pdfSplitPages');
  const prev = $('#pdfSplitPrev'), next = $('#pdfSplitNext'), add = $('#pdfSplitAdd'), parts = $('#pdfSplitParts');
  const submit = $('#modalInner button[value="ok"]'), summary = $('#pdfSplitSummary');
  submit.disabled = true;

  function addPartButton(number) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn pdf-split-part';
    button.dataset.part = number;
    button.style.setProperty('--part-hue', partHue(number));
    button.innerHTML = `<span>第 ${number} 部分</span><small></small>`;
    parts.append(button);
    return button;
  }
  function updateSummary() {
    const counts = new Map();
    for (const number of assignments.values()) counts.set(number, (counts.get(number) || 0) + 1);
    for (const button of parts.children) {
      const number = Number(button.dataset.part);
      button.setAttribute('aria-pressed', String(part === number));
      button.lastElementChild.textContent = (counts.get(number) || 0) + ' 页';
    }
    submit.disabled = !assignments.size;
    summary.textContent = assignments.size
      ? `已分组 ${assignments.size}/${pdf.numPages} 页 · 将生成 ${counts.size} 份 PDF`
      : '勾选至少一页即可拆分';
  }
  function syncTile(tile) {
    const number = Number(tile.dataset.page), assigned = assignments.get(number);
    const check = $('input', tile), badge = $('.pdf-split-page-part', tile);
    check.checked = assigned === part;
    check.indeterminate = Boolean(assigned && assigned !== part);
    tile.classList.toggle('assigned', Boolean(assigned));
    if (assigned) tile.style.setProperty('--part-hue', partHue(assigned));
    badge.textContent = assigned ? `第 ${assigned} 部分` : '';
    check.title = assigned && assigned !== part ? `移到第 ${part} 部分` : '';
  }
  function selectPart(number) {
    if (part !== number) selectionAnchor = null;
    part = number;
    grid.style.setProperty('--active-hue', partHue(number));
    for (const tile of grid.children) syncTile(tile);
    updateSummary();
  }
  function selectPage(check, checked, extend) {
    const tile = check.closest('[data-page]'), number = Number(tile.dataset.page);
    if (extend && selectionAnchor !== null) {
      const first = Math.min(selectionAnchor, number), last = Math.max(selectionAnchor, number);
      for (let n = first; n <= last; n++) {
        assignments.set(n, part);
        syncTile(grid.children[n - 1]);
      }
    } else {
      if (checked) {
        assignments.set(number, part);
        selectionAnchor = number;
      } else {
        assignments.delete(number);
        if (selectionAnchor === number) selectionAnchor = null;
      }
      syncTile(tile);
    }
    updateSummary();
  }
  async function showPage() {
    const id = ++renderId, n = page;
    prev.disabled = n <= 1;
    next.disabled = n >= pdf.numPages;
    pageInput.value = n;
    $('[aria-current="page"]', grid)?.removeAttribute('aria-current');
    const tile = grid.children[n - 1];
    $('.pdf-split-thumb', tile).setAttribute('aria-current', 'page');
    const tileBox = tile.getBoundingClientRect(), gridBox = grid.getBoundingClientRect();
    if (tileBox.top < gridBox.top || tileBox.bottom > gridBox.bottom) grid.scrollTop += tileBox.top - gridBox.top;
    paper.textContent = `正在加载第 ${n} 页…`;
    try {
      const canvas = await pv.renderPdfPage(pdf, n, 1100, 1400);
      if (!active || id !== renderId) return;
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', `PDF 第 ${n} 页`);
      paper.replaceChildren(canvas);
    } catch {
      if (active && id === renderId) paper.textContent = `第 ${n} 页无法预览，可继续勾选页面。`;
    }
  }
  function jump() {
    const value = pageInput.valueAsNumber;
    if (Number.isInteger(value) && value >= 1 && value <= pdf.numPages && value !== page) {
      page = value;
      showPage();
    } else pageInput.value = page;
  }
  async function drawThumbnails() {
    if (drawingThumbnails) return;
    drawingThumbnails = true;
    try {
      for (const tile of pendingThumbnails) {
        if (!active) break;
        pendingThumbnails.delete(tile);
        thumbnails.unobserve(tile);
        try {
          const canvas = await pv.renderPdfPage(pdf, Number(tile.dataset.page), 140, 170);
          if (active) $('.pdf-split-thumb', tile).replaceChildren(canvas);
        } catch { /* 页码仍可用于预览和勾选。 */ }
      }
    } finally { drawingThumbnails = false; }
  }

  prev.onclick = () => { page--; showPage(); };
  next.onclick = () => { page++; showPage(); };
  pageInput.onchange = jump;
  pageInput.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); jump(); } };
  parts.onclick = (e) => {
    const button = e.target.closest('[data-part]');
    if (button) selectPart(Number(button.dataset.part));
  };
  add.onclick = () => {
    const button = addPartButton(++partCount);
    selectPart(partCount);
    add.disabled = partCount >= pdf.numPages;
    button.focus();
  };
  grid.onclick = (e) => {
    const check = e.target.closest('input[type="checkbox"]');
    if (check) return selectPage(check, check.checked, e.shiftKey);
    const label = e.shiftKey && e.target.closest('label');
    if (label) {
      e.preventDefault();
      const input = $('input', label);
      input.focus({ preventScroll: true });
      return selectPage(input, !input.checked, true);
    }
    const thumbnail = e.target.closest('.pdf-split-thumb');
    if (!thumbnail) return;
    page = Number(thumbnail.parentElement.dataset.page);
    showPage();
  };

  async function loadPdf() {
    try {
      const doc = await pv.pdfDoc(blob);
      if (!active) { await doc.destroy(); return; }
      pdf = doc;
      $('#pdfSplitTotal').textContent = `共 ${pdf.numPages} 页`;
      if (pdf.numPages < 2) {
        paper.textContent = '这份 PDF 只有一页，无需拆分。';
        return;
      }
      pageInput.max = pdf.numPages;
      pageInput.disabled = false;
      add.disabled = pdf.numPages <= partCount;
      addPartButton(1);
      addPartButton(2);
      grid.innerHTML = Array.from({ length: pdf.numPages }, (_, i) => {
        const n = i + 1;
        return `<div class="pdf-split-tile" data-page="${n}">
          <button type="button" class="pdf-split-thumb" aria-label="预览第 ${n} 页"><span aria-hidden="true">${n}</span></button>
          <label><input type="checkbox" aria-describedby="pdfSplitPart${n}">第 ${n} 页</label>
          <span class="pdf-split-page-part" id="pdfSplitPart${n}"></span>
        </div>`;
      }).join('');
      selectPart(1);
      showPage();
      thumbnails = new IntersectionObserver((entries) => {
        for (const { target, isIntersecting } of entries) {
          if (isIntersecting) pendingThumbnails.add(target);
          else pendingThumbnails.delete(target);
        }
        drawThumbnails();
      }, { root: grid, rootMargin: '100px 0px' });
      for (const tile of grid.children) thumbnails.observe(tile);
    } catch {
      if (active) paper.textContent = '无法打开 PDF。请检查文件是否已损坏或受密码保护。';
    }
  }
  loadPdf();
  try { return await result; }
  finally {
    active = false;
    thumbnails?.disconnect();
    pendingThumbnails.clear();
    modal.classList.remove('pdf-split-modal');
    modal.removeAttribute('aria-labelledby');
    if (pdf) await pdf.destroy().catch(console.warn);
  }
}

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
    : `<button role="menuitem" data-i="${i}" class="${it.danger ? 'danger' : ''}">${it.swatch ? `<span class="sw" style="background:${it.swatch}"></span>` : ''}${it.tag ? `<span class="prio" style="--pc:${it.tag.c}">${it.tag.t}</span>` : ''}${esc(it.text)}${it.checked ? '<span class="chk">✓</span>' : ''}</button>`).join('');
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
    items.push({ text: n > 1 ? `✓ 完成项目（打包 ${n} 个关联文件）` : '✓ 完成项目并归档', run: () => completeProject(card.id) },
      { text: state.selected.has(card.id) ? '取消选择' : '选择（多选）', run: () => toggleSelect(card.id) });
    if (n > 1) items.push({ text: '从项目关联中移除', run: async () => {
      card.noAuto = true; delete card.projectId; delete card.projectName;
      await saveCard(card); await changed();
      toast(`「${card.name}」已不再和其他文件关联`);
    } });
    items.push('-');
  }
  items.push({ label: '优先级' });
  for (const lv of [1, 2, 3]) items.push({ text: PRIO[lv].label, tag: PRIO[lv], checked: card.prio === lv, run: () => setPrio([card.id], lv) });
  if (card.prio) items.push({ text: '清除优先级', run: () => setPrio([card.id], 0) });
  items.push('-');
  items.push({ text: '转换圆环…（Ctrl + 拖动）', run: () => {
    const b = ($(`.card[data-id="${CSS.escape(card.id)}"]`) || anchor).getBoundingClientRect();
    openRing(card, b.left + b.width / 2, b.top + b.height / 2, { sticky: true });
  } });
  items.push({ text: card.kind === 'note' ? '编辑' : '预览', run: () => preview(card.id) },
    { text: '下载', run: () => download(card.id) },
    { text: '重命名', run: () => startInlineRename(card.id) });
  if (isCanvas(card.columnId)) {
    items.push({ text: '添加备注评论…', run: () => openCommentDraftOnTarget(card.id) });
    items.push({ text: card.locked ? '解锁（Ctrl + Shift + L）' : '锁定位置（Ctrl + Shift + L）', run: async () => {
      if (card.locked) delete card.locked; else card.locked = true;
      await saveCard(card); await changed();
      toast(card.locked ? `已锁定「${card.name}」` : `已解锁「${card.name}」`);
    } });
  }
  if (isCanvas(card.columnId) && card.w) {
    items.push({ text: '重置画布卡片大小', run: async () => { delete card.w; await saveCard(card); await changed(); } });
  }
  const dest = (list, label) => {
    const opts = list.filter((a) => a.id !== card.columnId);
    if (!opts.length) return;
    items.push('-', { label });
    opts.forEach((a) => items.push({ text: a.title, run: () => moveCard(card.id, a.id, kindOf(a) === 'zone' ? 0 : cardsIn(a.id, false).length) }));
  };
  dest(columns(), '移到看板');
  dest(canvases(), '放到画布');
  dest(zones(), '放入功能区');
  dest(works(), '放到作品');
  dest(shelves(), '存入云仓库（长期保存）');
  const host = area(card.columnId);
  if (host?.kind === 'work' && card.thumb === 'ok') items.push({ text: host.coverId === card.id ? '✓ 作品封面' : '设为作品封面', run: async () => { host.coverId = card.id; if (host.cover === 'live' || host.cover === 'mono') delete host.cover; await saveArea(host); await changed(); toast(`已设为「${host.title}」的封面`); } });
  items.push('-', { label: '归档到已完成项目' });
  folders().filter((f) => f.id !== card.columnId).forEach((f) => items.push({ text: folderPath(f), run: () => archiveCards([card], f.id) }));
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
  if (cardsIn(a.id, false).length) items.push({ text: '快速重命名文件…', run: () => openBatchRename(cardsIn(a.id, false), a.title) });
  if (kind !== 'canvas' && kind !== 'folder') items.push({ text: '添加便签', run: () => newNote(a.id) });
  if (kind === 'column') items.push({ text: '整列归档到已完成项目…', run: () => archiveColumn(a) });
  if (kind === 'folder') {
    items.push({ text: '新建子文件夹…', run: () => addSubfolder(a.id) });
    items.push({ text: '打包下载 zip', run: () => zipFolder(a) });
    items.push({ text: '分享链接（对方直接下载）…', run: () => startShare(a) });
    if (!isStoredFolder(a)) items.push({ text: parentOf(a) ? '移到云仓库（单独成一个项目）' : '移到云仓库（长期保存）', run: () => setFolderStored(a, true) });
    else if (!parentOf(a)) items.push({ text: '移回已完成项目', run: () => setFolderStored(a, false) });
    if (!parentOf(a)) {
      items.push({ label: '分类' });
      allCats().forEach((c) => items.push({ text: c, checked: a.category === c, run: () => setFolderCat(a, c) }));
      items.push({ text: '新建分类…', run: () => addCategory(a) });
      if (a.category) items.push({ text: '移出分类', run: () => setFolderCat(a, null) });
    }
    items.push({ label: '颜色' });
    FCOLORS.forEach((fc, i) => items.push({ text: fc.n, swatch: fc.c, checked: folderColor(a) === fc.c, run: async () => { a.color = i; await saveArea(a); await changed(); } }));
    // 放进别的文件夹（排除自己和自己的子孙）
    const blocked = new Set([a.id, ...descendantIds(a.id)]);
    const targets = folders().filter((f) => !blocked.has(f.id) && f.id !== a.parentId);
    if (targets.length || parentOf(a)) {
      items.push({ label: '移到…' });
      if (parentOf(a)) items.push({ text: '已完成项目（顶层）', run: () => nestFolder(a.id, null) });
      targets.forEach((f) => items.push({ text: folderPath(f), run: () => nestFolder(a.id, f.id) }));
    }
    const others = folders().filter((f) => !blocked.has(f.id));
    if (others.length) { items.push({ label: '合并到…' }); others.forEach((f) => items.push({ text: folderPath(f), run: () => mergeFolders(a.id, f.id) })); }
  }
  if (kind === 'shelf') items.push({ text: '打包下载 zip', run: () => zipFolder(a) }, { text: '分享链接（对方直接下载）…', run: () => startShare(a) });
  if (kind === 'zone') items.push({ text: a.ttlDays ? `自动清理：${a.ttlDays} 天` : '设置自动清理…', run: () => setZoneTtl(a) });
  if (i > 0) items.push({ text: prev, run: () => moveArea(a, -1) });
  if (i < list.length - 1) items.push({ text: next, run: () => moveArea(a, 1) });
  const nCards = cardsIn(a.id, false).length;
  items.push('-');
  if (nCards) {
    const clearLabel = kind === 'column' ? `清空此列到回收站（${nCards}）` : kind === 'zone' ? `清空本区到回收站（${nCards}）` : `清空内容到回收站（${nCards}）`;
    items.push({ text: clearLabel, danger: true, run: () => clearAreaToTrash(a) });
  }
  items.push({ text: `删除${KIND_LABEL[kind]}`, danger: true, run: () => deleteArea(a) });
  openMenu(anchor, items);
}

// ---------- 提示 ----------
function toast(text, { error, action, onAction, sticky, commentAlert, color, duration } = {}) {
  const el = document.createElement('div');
  el.className = `toast${error ? ' error' : ''}${commentAlert ? ' comment-alert' : ''}`;
  if (commentAlert && color) el.style.setProperty('--c', color);
  el.setAttribute('role', error ? 'alert' : 'status');
  const span = document.createElement('span');
  span.textContent = text;
  el.appendChild(span);
  const close = () => el.remove();
  if (action) {
    const b = document.createElement('button');
    b.textContent = action;
    b.onclick = () => { close(); onAction?.(); };
    el.appendChild(b);
  }
  $('#toasts').appendChild(el);
  while ($('#toasts').children.length > 3) $('#toasts').firstChild.remove();
  const waitMs = duration ?? (commentAlert ? 8000 : (action || error ? 6000 : 3000));
  if (!sticky) setTimeout(close, waitMs);
  return { close, set: (t) => { span.textContent = t; } };
}

// ---------- 存储 / 备份状态 ----------
async function requestPersist() {
  if (!navigator.storage?.persist) return;
  if (!(await navigator.storage.persisted())) await navigator.storage.persist().catch(() => {});
  refreshStatus();
}
const STORAGE_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M3 13h18"/><circle cx="7.5" cy="16" r="1" fill="currentColor" stroke="none"/><circle cx="11.5" cy="16" r="1" fill="currentColor" stroke="none"/></svg>`;
const BACKUP_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 4.5 6v5.5c0 5 3.2 8.7 7.5 10 4.3-1.3 7.5-5 7.5-10V6z"/><path d="m9 12 2 2 4-4"/></svg>`;
async function refreshStatus() {
  const chip = $('#storageChip');
  let persisted = false, used = 0, quota = 0;
  try {
    persisted = await navigator.storage?.persisted?.() || false;
    ({ usage: used = 0, quota = 0 } = (await navigator.storage?.estimate?.()) || {});
  } catch {}
  let mode = 'idb', perm = 'none', dir = null;
  try { mode = await db.storageMode(); if (mode === 'folder') { dir = await db.getDir(); perm = await db.dirPermission(); } } catch {}
  let stTip, stCls;
  if (mode === 'folder' && perm !== 'granted') {
    stTip = `存储文件夹「${dir?.name}」需要授权 · 点此授权`;
    stCls = 'status-chip icon-chip warn';
  } else if (mode === 'folder') {
    stTip = `文件存在「${dir?.name}」· 容量随硬盘`;
    stCls = 'status-chip icon-chip ok';
  } else {
    stTip = `已用 ${fmtSize(used)}${quota ? ` / ${fmtSize(quota)}` : ''} · ${persisted ? '持久存储' : '普通存储'}`;
    stCls = `status-chip icon-chip ${persisted && (!quota || used / quota < 0.8) ? 'ok' : 'warn'}`;
    // 浏览器空间用到八成时提醒扩容
    if (quota && used / quota > 0.8 && !refreshStatus.warned) { refreshStatus.warned = true; toast('浏览器存储快满了，可以在「存储与容量」里把文件改存到电脑文件夹来扩容', { action: '去设置', onAction: storageInfo }); }
  }
  chip.innerHTML = `${STORAGE_SVG}<i class="st-dot" aria-hidden="true"></i>`;
  chip.className = stCls;
  chip.title = stTip;
  chip.dataset.tip = stTip;
  chip.setAttribute('aria-label', stTip);

  let lastBackup = 0, lastChange = 0;
  try { [lastBackup, lastChange] = await Promise.all([db.getMeta('lastBackup', 0), db.getMeta('lastChange', 0)]); } catch { return; }
  const bc = $('#backupChip');
  const stale = state.cards.length && lastChange > lastBackup && (!lastBackup || Date.now() - lastBackup > 3 * 86400e3);
  const bkTip = lastBackup ? `上次备份 ${ago(lastBackup)}${lastChange > lastBackup ? ' · 有新改动（点击立即备份）' : '（点击立即备份）'}` : '尚未备份（点击立即备份）';
  bc.innerHTML = `${BACKUP_SVG}<i class="st-dot" aria-hidden="true"></i>`;
  bc.className = `status-chip icon-chip ${stale ? 'warn' : lastBackup ? 'ok' : ''}`;
  bc.title = bkTip;
  bc.dataset.tip = bkTip;
  bc.setAttribute('aria-label', bkTip);
}
// 文件存在电脑文件夹时，读取前确认已授权（必须在用户点击里调用，浏览器才会弹出授权）
async function ensureAccess() {
  try {
    if ((await db.storageMode()) !== 'folder') return true;
    if ((await db.dirPermission()) === 'granted') return true;
    const p = await db.dirPermission(true);
    refreshStatus();
    if (p === 'granted') { queueThumbs(); return true; }
    toast('没有获得存储文件夹的访问权限，暂时无法打开文件', { error: true });
    return false;
  } catch { return true; }
}
async function storagePanelHTML() {
  let persisted = false, used = 0, quota = 0;
  try { persisted = await navigator.storage?.persisted?.(); ({ usage: used = 0, quota = 0 } = (await navigator.storage?.estimate?.()) || {}); } catch {}
  const st = await db.storageStats();
  const mode = await db.storageMode();
  const dir = await db.getDir();
  const perm = mode === 'folder' ? await db.dirPermission() : 'none';
  const pct = quota ? Math.min(100, (used / quota) * 100) : 0;
  const supported = db.folderSupported();
  return `<h3>存储与容量</h3>
    <div class="stor ${mode === 'idb' ? 'on' : ''}">
      <div class="stor-head"><b>浏览器数据库</b>${mode === 'idb' ? '<span class="tag">当前使用</span>' : ''}</div>
      <div class="bar"><span style="width:${pct.toFixed(1)}%" class="${pct > 80 ? 'hot' : ''}"></span></div>
      <div class="stor-meta">已用 ${fmtSize(used)} / 浏览器分配 ${fmtSize(quota)} · ${st.idbCount} 个文件 · ${persisted ? '持久存储已开启' : '普通存储（空间紧张时可能被浏览器清理）'}</div>
      <p class="stor-note">容量由浏览器按系统盘剩余空间分配，网页无法自行调高。</p>
      ${persisted ? '' : '<button type="button" class="btn" data-st="persist">申请持久存储</button>'}
    </div>
    <div class="stor ${mode === 'folder' ? 'on' : ''}">
      <div class="stor-head"><b>电脑文件夹（扩容）</b>${mode === 'folder' ? '<span class="tag">当前使用</span>' : ''}</div>
      ${mode === 'folder' ? `
        <div class="stor-meta">文件夹「${esc(dir?.name)}」/${db.FOLDER_SUB} · ${st.extCount} 个文件，${fmtSize(st.extBytes)} · ${perm === 'granted' ? '已授权' : '<b class="warn-text">需要授权</b>'}</div>
        <p class="stor-note">新加入的文件直接写进这个文件夹，容量 = 这块硬盘的剩余空间；在资源管理器里也能看到这些文件。请不要手动改名或删除「${db.FOLDER_SUB}」里的文件。</p>
        <div class="stor-act">
          ${perm === 'granted' ? '' : '<button type="button" class="btn primary" data-st="grant">授权访问</button>'}
          ${st.idbCount ? `<button type="button" class="btn" data-st="migrate">把浏览器里的 ${st.idbCount} 个文件也移过来</button>` : ''}
          <button type="button" class="btn" data-st="pick">更换文件夹</button>
          <button type="button" class="btn ghost" data-st="stop">停止使用（搬回浏览器）</button>
        </div>`
      : `
        <p class="stor-note">选一个硬盘空间充足的文件夹（比如 D 盘），之后加入的文件直接存到那里，不再占用浏览器空间，容量就是整块硬盘的剩余空间。也可以把现有文件一起迁移过去。</p>
        ${supported ? '<button type="button" class="btn primary" data-st="pick">选择文件夹，扩容</button>' : '<p class="stor-note warn-text">当前浏览器不支持，请用电脑版 Chrome 或 Edge 打开。</p>'}`}
    </div>
    <p class="stor-note">无论存在哪里，都建议定期点「备份」导出 .wbk 文件，防止误删或换电脑时丢失。</p>
    <div class="modal-actions"><button type="button" class="btn" data-st="close">关闭</button></div>`;
}
async function storageInfo() {
  const m = $('#modal'), f = $('#modalInner');
  m.classList.add('wide');
  const paint = async () => { f.innerHTML = await storagePanelHTML(); };
  await paint();
  f.onsubmit = (e) => e.preventDefault();
  const close = () => { m.classList.remove('wide'); f.onclick = null; if (m.open) m.close(); };
  m.oncancel = close;
  f.onclick = async (e) => {
    const b = e.target.closest('[data-st]');
    if (!b) return;
    const act = b.dataset.st;
    if (act === 'close') return close();
    if (act === 'persist') { await requestPersist(); return paint(); }
    if (act === 'grant') { await db.dirPermission(true); refreshStatus(); queueThumbs(); return paint(); }
    if (act === 'pick') { close(); return pickStorageFolder(); }
    if (act === 'migrate') { close(); return migrateFolder(); }
    if (act === 'stop') { close(); return stopFolder(); }
  };
  if (!m.open) m.showModal();
}
async function pickStorageFolder() {
  if (!db.folderSupported()) return toast('这个功能需要电脑版 Chrome 或 Edge', { error: true });
  let h;
  try { h = await window.showDirectoryPicker({ id: 'workbench-store', mode: 'readwrite', startIn: 'documents' }); } catch { return; }
  if (h.requestPermission && (await h.requestPermission({ mode: 'readwrite' })) !== 'granted') return toast('需要读写权限才能把文件存到这个文件夹', { error: true });
  await db.setDir(h);
  await db.setMeta('storageMode', 'folder');
  refreshStatus();
  toast(`以后加入的文件会存到「${h.name}/${db.FOLDER_SUB}」`);
  const st = await db.storageStats();
  if (st.idbCount && await confirmBox({ title: `把浏览器里现有的 ${st.idbCount} 个文件（${fmtSize(st.idbBytes)}）也移过去？`, body: '每个文件写入文件夹并核对大小无误后，才会从浏览器里删除，释放浏览器空间。', ok: '开始迁移' })) await migrateFolder();
}
async function migrateFolder() {
  if (!(await ensureAccess())) return;
  const t = toast('正在迁移…', { sticky: true });
  try {
    const { moved, bytes } = await db.migrateToFolder((i, n) => t.set(`正在迁移 ${i}/${n}…`));
    t.close();
    toast(`已迁移 ${moved} 个文件（${fmtSize(bytes)}），浏览器空间已释放`);
  } catch (e) {
    t.close();
    toast(`迁移中断：${e.message || e}。已迁移的文件都已核对，没迁的仍安全留在浏览器里`, { error: true });
  }
  refreshStatus();
}
async function stopFolder() {
  const st = await db.storageStats();
  const ok = await confirmBox({ title: '停止使用电脑文件夹？', body: st.extCount ? `文件夹里的 ${st.extCount} 个文件（${fmtSize(st.extBytes)}）会搬回浏览器，需要浏览器有足够空间。` : '之后的新文件会存回浏览器。', ok: '停止使用' });
  if (!ok || !(await ensureAccess())) return;
  const t = toast('正在搬回浏览器…', { sticky: true });
  try {
    await db.migrateToBrowser((i, n) => t.set(`正在搬回 ${i}/${n}…`));
    await db.clearDir();
    t.close();
    toast('已停止使用文件夹，文件都在浏览器里');
  } catch (e) {
    t.close();
    toast(`搬回中断：${e.message || e}（文件夹仍在使用）`, { error: true });
  }
  refreshStatus();
}
async function doBackup() {
  if (!(await ensureAccess())) return;
  const t = toast('正在打包备份…', { sticky: true });
  let lastTick = 0;
  try {
    const { blob, count, fileCount, missing } = await db.exportBackup(({ done, total, bytesDone }) => {
      const now = performance.now();
      if (done === total || now - lastTick >= 80) {
        lastTick = now;
        t.set(`正在打包备份 ${done}/${total}${bytesDone ? `（${fmtSize(bytesDone)}）` : ''}…`);
      }
    });
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    const name = `方寸备份-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.wbk`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    await db.setMeta('lastBackup', Date.now());
    t.close();
    toast(`已导出 ${count} 张卡片（${fileCount} 个文件，${fmtSize(blob.size)}）${missing ? `；有 ${missing} 个文件在存储文件夹里找不到，已跳过` : ''}`, missing ? { error: true } : {});
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
  if (!id) return highlightIds([], cls);
  const ids = relatedIds(id);
  if (ids.length < 2 && cls === 'related') return highlightIds([], cls);
  highlightIds(ids, cls);
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
  if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
  const el = e.target.closest?.('.card');
  if (!el || e.target.closest('.more, .export-handle, .card-expand-btn, .sel, .suggest-badge, .pdf-page-bar, .quick-rename-btn, .inline-rn-wrap, .canvas-card-hud, [data-card-handle]')) return;
  const card = findCard(el.dataset.id);
  if (!card || !isActive(card)) return;
  cancelPress();
  press = { el, id: card.id, x: e.clientX, y: e.clientY, touch: e.pointerType !== 'mouse' };
  press.t1 = setTimeout(() => {
    if (!press) return;
    el.classList.add('pressing');
    const targets = pressTargets(card.id);
    highlightIds(targets, 'gather');
    const n = targets.length;
    const ring = document.createElement('div');
    ring.className = 'press-ring';
    // 触屏时把进度环放到手指上方，避免被手指挡住；靠右时文字翻到左边
    ring.style.left = `${press.x}px`; ring.style.top = `${press.touch ? Math.max(30, press.y - 64) : press.y}px`;
    if (press.x > innerWidth - 220) ring.classList.add('flip');
    ring.style.setProperty('--dur', `${PRESS_TOTAL - PRESS_DELAY}ms`);
    ring.innerHTML = `<svg viewBox="0 0 44 44"><circle class="track" cx="22" cy="22" r="18"/><circle class="bar" cx="22" cy="22" r="18"/></svg><span>${state.selected.has(card.id) && state.selected.size > 1 ? '按住一起完成' : '按住完成项目'}${n > 1 ? ` · ${n} 个文件` : ''}</span>`;
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

// ---------- 转换圆环：按住 Ctrl / ⌘ 拖动卡片，松手在哪一格就执行哪一格 ----------
// 正面 = 格式转换，背面 = 常用操作；Tab / 滚轮翻面，Esc 取消。卡片菜单「转换圆环…」可点选使用并调整大小。
const RING_SHORT = {
  'img-png': ['PNG'], 'img-jpg': ['JPG'], 'img-webp': ['WEBP'], 'img-pdf': ['PDF'], 'img-small': ['压缩', 'JPG · 2048px'],
  'pdf-png': ['PNG', '每页一张'], 'pdf-jpg': ['JPG', '每页一张'], 'pdf-txt': ['TXT', '提取文字'],
  'pdf-md': ['MD', '提取文字'], 'pdf-compress': ['压缩 PDF'], 'pdf-split': ['拆分 PDF', '勾选分组'],
  'docx-html': ['HTML', '网页'], 'docx-txt': ['TXT', '纯文本'], 'docx-md': ['MD', 'Markdown'], 'text-md': ['MD', 'Markdown'],
  'sheet-xlsx': ['XLSX', 'Excel'], 'sheet-csv': ['CSV'], 'sheet-json': ['JSON'], 'md-html': ['HTML', '网页'],
  'audio-wav': ['WAV'], 'video-png': ['封面', 'PNG'], 'video-jpg': ['封面', 'JPG'], 'video-wav': ['音频', 'WAV'],
  'thumb-png': ['预览图', 'PNG'], 'thumb-jpg': ['预览图', 'JPG'],
};
const FAM_LABEL = { image: '图片', video: '视频', audio: '音频', pdf: 'PDF', affinity: 'Affinity', docx: 'Word', sheet: '表格', md: 'Markdown', zipdoc: '文档', text: '文本', other: '文件' };
const RICON = {
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  down: '<path d="M12 4v11m0 0-4-4m4 4 4-4"/><path d="M5 19h14"/>',
  pen: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13 7 4 4"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  check: '<path d="M4 7h16v13H4z"/><path d="m8.5 13.5 2.5 2.5 4.5-5"/><path d="M4 7l2-3h12l2 3"/>',
  flag: '<path d="M5 21V4h11l-2 4 2 4H5"/>',
  zone: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M14 4v16"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  merge: '<path d="M7 3h7l4 4v14H7z"/><path d="M4 6v15h11"/>',
  conv: '<path d="M4 7h13l-3-3M20 17H7l3 3"/>',
};
let ring = null, ringPending = null, ringFired = false;
const ringEligible = (c) => c && (c.kind === 'file' || c.kind === 'note') && c.columnId !== TRASH;
const ringScale = () => Math.min(1.4, Math.max(0.7, +ls.get('ringScale', 1) || 1));

function ringTargets(card) {
  if (state.selected.has(card.id) && state.selected.size > 1) {
    const list = [...state.selected].map(findCard).filter(ringEligible);
    return [card, ...list.filter((c) => c.id !== card.id)];
  }
  return [card];
}
const isPdfFile = (c) => c.kind === 'file' && (extOf(c.name) === 'pdf' || c.type === 'application/pdf');

function ringFaces(card, list) {
  const front = [];
  if (card.kind === 'note') front.push({ id: 'note-txt', label: 'TXT', sub: '纯文本' }, { id: 'note-md', label: 'MD', sub: 'Markdown' });
  else {
    for (const c of pv.conversionsFor(card, card.thumb === 'ok')) {
      const [label, sub] = RING_SHORT[c.id] || [c.label];
      const n = list.filter((x) => x.kind === 'file' && pv.conversionsFor(x, x.thumb === 'ok').some((y) => y.id === c.id)).length;
      front.push({ id: c.id, label, sub: n > 1 ? `${n} 个文件${sub ? ` · ${sub}` : ''}` : sub });
    }
    const imgs = list.filter((x) => x.kind === 'file' && pv.family(x) === 'image' && extOf(x.name) !== 'svg');
    if (imgs.length > 1 && imgs.includes(card)) front.push({ id: 'merge-pdf', label: '合并 PDF', sub: `${imgs.length} 张合成一份`, icon: 'merge' });
    const pdfs = list.filter(isPdfFile);
    if (pdfs.length > 1 && pdfs.includes(card)) front.push({ id: 'merge-pdf-files', label: '合并 PDF', sub: `${pdfs.length} 份合为一份`, icon: 'merge' });
  }
  const many = list.length > 1, files = list.filter((c) => c.kind === 'file');
  const zone = zones().find((z) => z.id !== card.columnId);
  const urgent = list.every((c) => c.prio === 1);
  const back = [
    !many && { id: 'a-preview', label: card.kind === 'note' ? '编辑' : '预览', icon: 'eye' },
    { id: 'a-download', label: '下载', sub: many ? `${list.length} 个` : '', icon: 'down' },
    !many && { id: 'a-rename', label: '重命名', icon: 'pen' },
    files.length && { id: 'a-copy', label: '复制一份', sub: files.length > 1 ? `${files.length} 个` : '', icon: 'copy' },
    isActive(card) && { id: 'a-done', label: '完成项目', sub: '打包归档', icon: 'check' },
    { id: 'a-prio', label: urgent ? '取消「急」' : '标为「急」', icon: 'flag' },
    zone && { id: 'a-zone', label: `放入${zone.title}`, sub: '功能区', icon: 'zone' },
    { id: 'a-trash', label: '删除', sub: many ? `${list.length} 个` : '', icon: 'trash', danger: true },
  ].filter(Boolean);
  return { front, back };
}

function openRing(card, x, y, { sticky = false } = {}) {
  closeRing();
  const list = ringTargets(card);
  const faces = ringFaces(card, list);
  const el = document.createElement('div');
  el.className = `cring${sticky ? ' sticky' : ''}`;
  el.setAttribute('role', 'menu');
  el.setAttribute('aria-label', '转换圆环');
  el.innerHTML = `<div class="cr-faces" role="tablist"></div><div class="cr-disc"></div>
    <div class="cr-hint">${sticky ? '点一格执行 · Tab / 滚轮翻面 · Esc 关闭' : '松手执行 · 滚轮 / Tab 翻面 · 中心或 Esc 取消'}</div>
    ${sticky ? `<label class="cr-size"><span>圆环大小</span><input type="range" min="70" max="140" step="5" value="${Math.round(ringScale() * 100)}"><output>${Math.round(ringScale() * 100)}%</output></label>` : ''}`;
  document.body.appendChild(el);
  const t = typeOf(card);
  ring = { el, card, list, faces, face: faces.front.length ? 'front' : 'back', hover: -1, sticky, t, x, y };
  layoutRing();
  if (!sticky) {
    const g = document.createElement('div');
    g.className = 'cring-ghost';
    g.style.setProperty('--c', t.c);
    g.textContent = list.length > 1 ? `${list.length} 个` : (extOf(card.name).slice(0, 4).toUpperCase() || t.label);
    document.body.appendChild(g);
    ring.ghost = g;
    moveGhost(x, y);
  }
  document.body.classList.add('ring-open');
  renderRing();
  el.animate([{ opacity: 0, transform: 'translate(-50%,-50%) scale(.82)' }, { opacity: 1, transform: 'translate(-50%,-50%) scale(1)' }],
    { duration: reduceMotion.matches ? 0 : 180, easing: 'cubic-bezier(.2,.9,.3,1.2)' });
}
function layoutRing() {
  const s = ringScale(), R = Math.round(150 * s), r = Math.round(58 * s), pad = 70; // 上方放正 / 背面切换，下方放提示
  ring.R = R; ring.r = r;
  ring.cx = Math.min(innerWidth - R - 12, Math.max(R + 12, ring.x));
  ring.cy = Math.min(innerHeight - R - pad - (ring.sticky ? 40 : 0), Math.max(R + pad, ring.y));
  ring.el.style.cssText = `left:${ring.cx}px;top:${ring.cy}px;--R:${R}px;--r:${r}px`;
}
function ringItems() { return ring.faces[ring.face]; }
function sectorPath(a0, a1, R, r) {
  const p = (a, rad) => `${(Math.cos(a) * rad).toFixed(2)} ${(Math.sin(a) * rad).toFixed(2)}`;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M${p(a0, R)}A${R} ${R} 0 ${large} 1 ${p(a1, R)}L${p(a1, r)}A${r} ${r} 0 ${large} 0 ${p(a0, r)}Z`;
}
function renderRing() {
  const { el, R, r, faces, face, list, card, t } = ring;
  const items = ringItems(), n = items.length, span = (Math.PI * 2) / Math.max(n, 1);
  const segs = items.map((it, i) => {
    const a0 = -Math.PI / 2 - span / 2 + i * span, a1 = a0 + span, mid = (a0 + a1) / 2, lr = (R + r) / 2 + 4;
    const d = n === 1 ? `M0 ${-R}A${R} ${R} 0 1 1 0 ${R}A${R} ${R} 0 1 1 0 ${-R}ZM0 ${-r}A${r} ${r} 0 1 0 0 ${r}A${r} ${r} 0 1 0 0 ${-r}Z` : sectorPath(a0, a1, R, r);
    return { it, i, d, lx: Math.cos(mid) * lr, ly: Math.sin(mid) * lr };
  });
  const count = (k) => faces[k].length;
  el.querySelector('.cr-faces').innerHTML = `
      <button type="button" data-face="front" class="${face === 'front' ? 'on' : ''}" ${count('front') ? '' : 'disabled'}>转换 <b>${count('front')}</b></button>
      <button type="button" data-face="back" class="${face === 'back' ? 'on' : ''}">操作 <b>${count('back')}</b></button>`;
  el.querySelector('.cr-disc').innerHTML = `
      <svg viewBox="${-R} ${-R} ${2 * R} ${2 * R}" aria-hidden="true">
        <circle class="cr-bg" r="${R + 2}"/>
        ${segs.map((g) => `<path class="cr-seg${g.it.danger ? ' danger' : ''}" data-i="${g.i}" d="${g.d}"/>`).join('')}
      </svg>
      ${segs.map((g) => `<div class="cr-label${g.it.danger ? ' danger' : ''}" data-i="${g.i}" role="menuitem" style="left:calc(50% + ${g.lx.toFixed(1)}px);top:calc(50% + ${g.ly.toFixed(1)}px)">
        ${g.it.icon ? `<svg viewBox="0 0 24 24">${RICON[g.it.icon]}</svg>` : ''}<b>${esc(g.it.label)}</b>${g.it.sub ? `<small>${esc(g.it.sub)}</small>` : ''}</div>`).join('')}
      <div class="cr-center" style="--c:${t.c}">
        <b>${list.length > 1 ? `${list.length} 个文件` : esc(card.kind === 'note' ? '便签' : FAM_LABEL[pv.family(card)] || t.label)}</b>
        <small class="cr-name">${esc(list.length > 1 ? `从「${card.name}」开始` : card.name)}</small>
        <small class="cr-act">${face === 'front' ? '转换为' : '操作'}</small>
      </div>`;
  setRingHover(ring.hover >= n ? -1 : ring.hover);
}
function setRingHover(i) {
  if (!ring) return;
  ring.hover = i;
  ring.el.querySelectorAll('[data-i]').forEach((x) => x.classList.toggle('hot', +x.dataset.i === i));
  const it = ringItems()[i];
  const act = ring.el.querySelector('.cr-act');
  if (act) act.textContent = it ? `${ring.face === 'front' ? '转换为 ' : ''}${it.label}` : ring.face === 'front' ? '转换为' : '操作';
}
function ringIndexAt(x, y) {
  const dx = x - ring.cx, dy = y - ring.cy, d = Math.hypot(dx, dy), n = ringItems().length;
  if (!n || d < ring.r * 0.92) return -1;
  if (ring.sticky && d > ring.R + 6) return -1;
  const span = (Math.PI * 2) / n;
  let a = Math.atan2(dy, dx) + Math.PI / 2 + span / 2;
  a = ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  return Math.min(n - 1, Math.floor(a / span));
}
function moveGhost(x, y) { if (ring?.ghost) ring.ghost.style.transform = `translate(${x + 14}px, ${y + 14}px)`; }
async function flipRing(to) {
  if (!ring || ring.flipping) return;
  const next = to || (ring.face === 'front' ? 'back' : 'front');
  if (next === ring.face || !ring.faces[next].length) return;
  ring.flipping = true;
  const disc = ring.el.querySelector('.cr-disc'), dur = reduceMotion.matches ? 0 : 110;
  // 动画在后台标签页可能不跑，加超时兜底，免得卡住
  const play = (frames, easing) => Promise.race([disc.animate(frames, { duration: dur, easing }).finished.catch(() => {}), wait(dur + 60)]);
  await play([{ transform: 'rotateY(0)' }, { transform: 'rotateY(90deg)' }], 'ease-in');
  if (!ring) return;
  ring.face = next; ring.hover = -1;
  renderRing();
  if (ring.lastX != null) setRingHover(ringIndexAt(ring.lastX, ring.lastY));
  await play([{ transform: 'rotateY(-90deg)' }, { transform: 'rotateY(0)' }], 'ease-out');
  if (ring) ring.flipping = false;
}
function closeRing(chosen) {
  if (!ring) return;
  const { el, ghost } = ring;
  ring = null;
  document.body.classList.remove('ring-open');
  ghost?.remove();
  if (reduceMotion.matches) return el.remove();
  el.style.pointerEvents = 'none';
  el.setAttribute('aria-hidden', 'true');
  el.classList.add('closing');
  const dur = chosen ? 220 : 140;
  el.animate([{ opacity: 1, transform: 'translate(-50%,-50%) scale(1)' }, { opacity: 0, transform: `translate(-50%,-50%) scale(${chosen ? 1.06 : 0.9})` }],
    { duration: dur, easing: 'ease-out', fill: 'forwards' });
  setTimeout(() => el.remove(), dur + 40);
}
async function ringChoose(i) {
  const it = ringItems()[i];
  if (!it) return closeRing();
  const { card, list } = ring;
  closeRing(true);
  try { await ringRun(it, card, list); } catch (e) { console.warn(e); toast(`操作失败：${e.message || e}`, { error: true }); }
}
async function ringRun(it, card, list) {
  const files = list.filter((c) => c.kind === 'file');
  const ids = list.map((c) => c.id);
  switch (it.id) {
    case 'a-preview': return preview(card.id);
    case 'a-download': return list.forEach((c, i) => setTimeout(() => download(c.id), i * 300));
    case 'a-rename': {
      const n = await prompt({ title: '重命名', value: card.name, ok: '保存' });
      if (n && n !== card.name) { card.name = n; await saveCard(card); await changed(); }
      return;
    }
    case 'a-copy': {
      if (!(await ensureAccess())) return;
      let n = 0;
      for (const c of files) {
        const b = await db.getBlob(c.id);
        if (!b) continue;
        const m = /^(.*?)(\.[^.]+)?$/.exec(c.name);
        n += (await placeBeside(c, [new File([b], `${m[1]} 副本${m[2] || ''}`, { type: c.type || b.type })])).length;
      }
      return toast(n ? `已复制 ${n} 个文件，放在原文件旁边` : '没有找到文件内容', { error: !n });
    }
    case 'a-done': return completeProject(card.id);
    case 'a-prio': return setPrio(ids, list.every((c) => c.prio === 1) ? 0 : 1);
    case 'a-zone': {
      const z = zones().find((x) => x.id !== card.columnId);
      for (const id of ids) await moveCard(id, z.id, 0);
      return toast(`已放入「${z.title}」`);
    }
    case 'a-trash': {
      for (const id of ids) await trashCard(id);
      clearSelection();
      return;
    }
    case 'note-txt': case 'note-md': {
      const md = it.id === 'note-md';
      const text = card.kind === 'note' && card.name && card.text && !card.text.startsWith(card.name) ? `${md ? '# ' : ''}${card.name}\n\n${card.text}` : (card.text || card.name || '');
      const added = await placeBeside(card, [new File([text], `${(card.name || '便签').replace(/[\\/:*?"<>|]/g, ' ').slice(0, 60)}.${md ? 'md' : 'txt'}`, { type: md ? 'text/markdown' : 'text/plain;charset=utf-8' })]);
      return toast(`已生成「${added[0]?.name}」`);
    }
    case 'merge-pdf': case 'merge-pdf-files': {
      if (!(await ensureAccess())) return;
      const pdf = it.id === 'merge-pdf-files';
      const inputs = files.filter(pdf ? isPdfFile : (c) => pv.family(c) === 'image' && extOf(c.name) !== 'svg');
      if (pdf) {
        const order = new Map($$('.card[data-id]').map((el, i) => [el.dataset.id, i]));
        inputs.sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity));
      }
      const t = toast('正在合并 PDF…', { sticky: true });
      try {
        const blobs = [];
        for (const c of inputs) {
          const blob = await db.getBlob(c.id);
          if (!blob) throw new Error(`找不到「${c.name}」的文件内容`);
          blobs.push(blob);
        }
        const name = `${inputs[0].name.replace(/\.[^.]+$/, '')}-合并`;
        const f = pdf ? await pv.mergePdfs(blobs, name, (s) => t.set(s))
          : await pv.mergeImagesPdf(blobs.map((blob) => ({ blob })), name, (s) => t.set(s));
        const [added] = await placeBeside(card, [f]);
        if (!added) throw new Error('合并结果保存失败');
        return toast(`已合并为「${added.name}」`, { action: '下载', onAction: () => download(added.id) });
      } finally { t.close(); }
    }
  }
  // 格式转换：对所有支持这项转换的已选文件执行
  if (!(await ensureAccess())) return;
  const todo = files.filter((c) => pv.conversionsFor(c, c.thumb === 'ok').some((x) => x.id === it.id));
  if (it.id === 'pdf-compress' && !(await confirmPdfCompression())) return;
  const t = toast(`正在转换为 ${it.label}…`, { sticky: true });
  const added = []; let fail = 0, err = null;
  for (let k = 0; k < todo.length; k++) {
    const c = todo[k];
    try {
      const results = await convertOne(c, it.id, (s) => t.set(todo.length > 1 ? `${k + 1}/${todo.length} · ${s}` : s));
      if (results === null) break;
      added.push(...results);
    } catch (e) { fail++; err = e; console.warn(e); }
    if (todo.length > 1) t.set(`正在转换 ${k + 1}/${todo.length}…`);
  }
  t.close();
  if (!added.length && !fail) return;
  if (fail && !added.length) return toast(`转换失败：${err.message || err}`, { error: true });
  toast(`转换完成：${added.map((c) => c.name).slice(0, 2).join('、')}${added.length > 2 ? ` 等 ${added.length} 个` : ''}${fail ? `（${fail} 个失败）` : ''}`,
    { action: '下载', onAction: () => added.forEach((c, i) => setTimeout(() => download(c.id), i * 300)) });
}

document.addEventListener('pointerdown', (e) => {
  ringFired = false;
  if (ring) {
    if (!ring.sticky) return;
    // 点选模式：点在圆环上执行，点在别处关闭
    if (e.target.closest('.cr-faces, .cr-size')) return;
    const i = ringIndexAt(e.clientX, e.clientY);
    e.preventDefault(); e.stopPropagation(); ringFired = true;
    if (i >= 0) ringChoose(i);
    else if (Math.hypot(e.clientX - ring.cx, e.clientY - ring.cy) > ring.R + 6 || !e.target.closest('.cring')) closeRing();
    return;
  }
  if (e.button !== 0 || !(e.ctrlKey || e.metaKey)) return;
  const el = e.target.closest?.('.card');
  if (!el || e.target.closest('.more, .export-handle, .sel, .suggest-badge')) return;
  const card = findCard(el.dataset.id);
  if (!ringEligible(card)) return;
  // 暂时关掉这张卡片的原生拖拽（拖到桌面导出），否则浏览器会抢走后续的指针事件
  if (el.draggable) { el.draggable = false; el.dataset.ringDrag = '1'; }
  ringPending = { card, el, x: e.clientX, y: e.clientY, id: e.pointerId };
}, true);
function restoreDrag() { $$('[data-ring-drag]').forEach((x) => { x.draggable = true; delete x.dataset.ringDrag; }); }
document.addEventListener('pointermove', (e) => {
  if (ringPending && e.pointerId === ringPending.id && Math.hypot(e.clientX - ringPending.x, e.clientY - ringPending.y) > 8) {
    const p = ringPending; ringPending = null;
    openRing(p.card, p.x, p.y);
  }
  if (!ring) return;
  ring.lastX = e.clientX; ring.lastY = e.clientY;
  moveGhost(e.clientX, e.clientY);
  const i = ringIndexAt(e.clientX, e.clientY);
  if (i !== ring.hover) setRingHover(i);
}, true);
document.addEventListener('pointerup', (e) => {
  ringPending = null; restoreDrag();
  if (!ring || ring.sticky) return;
  ringFired = true; // 吞掉这次松手产生的 click（否则会切换多选）
  setTimeout(() => { ringFired = false; }, 0);
  const i = ringIndexAt(e.clientX, e.clientY);
  i >= 0 ? ringChoose(i) : closeRing();
}, true);
document.addEventListener('pointercancel', () => { ringPending = null; restoreDrag(); if (ring && !ring.sticky) closeRing(); }, true);
document.addEventListener('click', (e) => { if (ringFired) { e.stopPropagation(); e.preventDefault(); ringFired = false; } }, true);
document.addEventListener('dragstart', (e) => { if (ringPending || ring) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
document.addEventListener('contextmenu', (e) => { if (ringPending || ring) { e.preventDefault(); e.stopPropagation(); } }, true);
window.addEventListener('wheel', (e) => {
  if (!ring) return;
  e.preventDefault(); e.stopPropagation();
  if (Math.abs(e.deltaY) + Math.abs(e.deltaX) < 4 || Date.now() - (ring.wheelAt || 0) < 280) return;
  ring.wheelAt = Date.now();
  flipRing();
}, { passive: false, capture: true });
document.addEventListener('keydown', (e) => {
  if (!ring) return;
  const n = ringItems().length;
  if (e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); flipRing(); }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeRing(); }
  else if (ring.sticky && (e.key === 'ArrowRight' || e.key === 'ArrowDown')) { e.preventDefault(); setRingHover((ring.hover + 1) % n); }
  else if (ring.sticky && (e.key === 'ArrowLeft' || e.key === 'ArrowUp')) { e.preventDefault(); setRingHover((ring.hover - 1 + n) % n); }
  else if (ring.sticky && e.key === 'Enter' && ring.hover >= 0) { e.preventDefault(); ringChoose(ring.hover); }
}, true);
document.addEventListener('click', (e) => {
  const f = e.target.closest?.('.cring [data-face]');
  if (f && ring) { e.preventDefault(); flipRing(f.dataset.face); }
});
document.addEventListener('input', (e) => {
  if (!ring || !e.target.matches('.cr-size input')) return;
  ls.set('ringScale', +e.target.value / 100);
  e.target.nextElementSibling.textContent = `${e.target.value}%`;
  layoutRing(); renderRing();
});
window.addEventListener('blur', () => { ringPending = null; restoreDrag(); if (ring && !ring.sticky) closeRing(); });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// 长按的目标：若按在已选中的卡片上 → 全部已选；否则 → 它的关联组
function pressTargets(id) {
  if (state.selected.has(id) && state.selected.size > 1) return [...state.selected].filter((x) => isActive(findCard(x) || {}));
  return relatedIds(id);
}
function highlightIds(ids, cls) {
  const set = ids.length ? new Set(ids) : null;
  $$('.card[data-id]').forEach((el) => {
    const on = Boolean(set && set.has(el.dataset.id));
    if (el.classList.contains(cls) !== on) el.classList.toggle(cls, on);
  });
}
// 多个名称的公共部分作为默认项目名
function commonTitle(cards) {
  const named = cards.find((c) => c.projectName);
  if (named) return named.projectName;
  const titles = cards.map(baseTitle);
  let p = titles[0] || '';
  for (const t of titles) while (p && !t.startsWith(p)) p = p.slice(0, -1);
  // 去掉截在半个词上的尾巴：「数学课件 第」→「数学课件」
  p = p.replace(new RegExp(`(${SEP}|第|[\\d０-９])+$`), '');
  if (p.length >= 2) return p;
  // 选「被其他名称包含最多次」的那个，例如「2027物理招生册」⊂「2027物理招生册 内页」
  const score = (t) => titles.filter((o) => o.includes(t)).length;
  const top = [...new Set(titles)].sort((a, b) => score(b) - score(a) || b.length - a.length)[0];
  if (top && score(top) > 1) return top;
  // 否则用所有名称共有的最长片段，例如「英语作文范文」+「作文范文合集」→「作文范文」
  let common = titles[0] || '';
  for (const t of titles.slice(1)) common = longestCommon(common, t);
  common = common.replace(new RegExp(`^${SEP}+|${SEP}+$`, 'g'), '');
  return common.length >= 3 ? common : (top || '项目');
}
function longestCommon(a, b) {
  let best = '', prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) if (a[i - 1] === b[j - 1]) { cur[j] = prev[j - 1] + 1; if (cur[j] > best.length) best = a.slice(i - cur[j], i); }
    prev = cur;
  }
  return best;
}
// 组内名称不统一时的项目名：已命名的项目 → 用项目名；名称都相同 → 用它；否则返回 null（需要询问）
function groupTitle(cards) {
  const named = cards.find((c) => c.projectName);
  if (named) return named.projectName;
  const names = new Set(cards.map((c) => baseTitle(c)));
  return names.size === 1 ? [...names][0] : null;
}
async function completeProject(id) {
  const card = findCard(id);
  if (!card || !isActive(card)) return;
  buildGroups();
  if (state.selected.has(id) && state.selected.size > 1) return completeCards([...state.selected]);
  return completeCards(relatedIds(id));
}
async function completeCards(ids, title) {
  buildGroups();
  const cards = ids.map(findCard).filter((c) => c && isActive(c));
  if (!cards.length) return;
  if (!title) {
    title = groupTitle(cards)
      || await prompt({ title: `把 ${cards.length} 个文件一起完成，打包成一个项目`, value: commonTitle(cards), placeholder: '项目名称', ok: '打包完成' });
    if (!title) return;
  }
  clearSelection();
  let folder = rootFolders().find((f) => f.title === title && !f.stored); // 已移进云仓库的不再并入
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

// ---------- 多选 ----------
let selectionAnchor = null;
function syncSelectionUI() {
  document.body.classList.toggle('selecting', state.selected.size > 0);
  $$('.card[data-id]').forEach((el) => {
    const on = state.selected.has(el.dataset.id);
    el.classList.toggle('selected', on);
    el.querySelector('.sel')?.setAttribute('aria-pressed', String(on));
  });
  renderSelBar();
}
function toggleSelect(id, rangeList) {
  if (!findCard(id)) return;
  if (rangeList && state.selected.has(selectionAnchor)) {
    const ids = $$('.card[data-id]:not(.dim)', rangeList).map((el) => el.dataset.id);
    const start = ids.indexOf(selectionAnchor), end = ids.indexOf(id);
    if (start >= 0 && end >= 0) {
      ids.slice(Math.min(start, end), Math.max(start, end) + 1).forEach((cardId) => state.selected.add(cardId));
      return syncSelectionUI();
    }
  }
  if (state.selected.has(id)) {
    state.selected.delete(id);
    if (selectionAnchor === id) selectionAnchor = null;
  } else {
    state.selected.add(id);
    selectionAnchor = id;
  }
  syncSelectionUI();
}
function clearSelection() {
  selectionAnchor = null;
  if (!state.selected.size) return;
  state.selected.clear();
  syncSelectionUI();
}
function renderSelBar() {
  let bar = $('#selBar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'selBar'; bar.className = 'sel-bar'; bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', '多选操作');
    document.body.appendChild(bar);
  }
  const ids = [...state.selected].filter(findCard);
  if (!ids.length) { bar.classList.remove('show'); return; }
  const active = ids.filter((id) => isActive(findCard(id)));
  const canvasSel = isCanvas(state.view) ? selectedCanvasCards() : [];
  bar.innerHTML = `<span class="sel-count">已选 <b>${ids.length}</b> 个</span>
    <button class="sel-btn" data-action="sel-clear" title="取消勾选（Esc）">取消勾选</button>
    <button class="sel-btn primary" data-action="sel-done" ${active.length ? '' : 'disabled'}>${CHECK_SVG}<span>一起完成并打包</span></button>
    <button class="sel-btn" data-action="sel-rename" title="快速批量重命名已选文件（F2）"><svg viewBox="0 0 24 24"><path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17v3z"/><path d="m13.5 6.5 3 3"/></svg><span>快速重命名</span></button>
    ${canvasSel.length >= 2 ? `<button class="sel-btn" data-action="sel-align" aria-haspopup="menu" title="对齐与分布选中的画布卡片"><svg viewBox="0 0 24 24"><path d="M4 4v16M8 7h12v4H8zM8 14h8v4H8z"/></svg><span>自动对齐…</span></button>` : ''}
    <button class="sel-btn" data-action="sel-link" ${active.length > 1 ? '' : 'disabled'} title="以后长按其中任意一个都会整组打包">${LINK_SVG}<span>关联为一个项目</span></button>
    <button class="sel-btn" data-action="sel-prio" aria-haspopup="menu" title="设置优先级（也可按 1 / 2 / 3，0 清除）"><span class="prio" style="--pc:#e03131">急</span><span>优先级</span></button>
    <button class="sel-btn" data-action="sel-move" aria-haspopup="menu"><svg viewBox="0 0 24 24"><path d="M5 12h14m-5-5 5 5-5 5"/></svg><span>移到…</span></button>
    <button class="sel-btn danger" data-action="sel-trash"><svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13"/></svg><span>删除</span></button>`;
  bar.classList.add('show');
}
async function moveMany(ids, areaId) {
  const cards = ids.map(findCard).filter(Boolean);
  if (!cards.length) return;
  if (area(areaId)?.kind === 'folder') { clearSelection(); return archiveCards(cards, areaId); }
  const canvas = isCanvas(areaId);
  const start = canvas ? (state.view === areaId ? viewCenter() : { x: 0, y: 0 }) : null;
  let order = canvas ? topOrder(areaId) : orderAt(areaId, cardsIn(areaId, false).length);
  cards.forEach((c, i) => {
    if (c.columnId !== areaId) c.enteredAt = Date.now();
    if (c.columnId === TRASH) delete c.trashedAt;
    c.columnId = areaId; c.order = order; order += canvas ? 1 : 1024; c.updatedAt = Date.now();
    if (canvas) { c.x = start.x + (i % 4) * (CARD_W + 30); c.y = start.y + Math.floor(i / 4) * 140; }
  });
  await db.putMany('cards', cards);
  clearSelection();
  await changed();
  toast(`已把 ${cards.length} 个移到「${areaName(areaId)}」`);
}
async function trashMany(ids) {
  const cards = ids.map(findCard).filter((c) => c && c.columnId !== TRASH);
  if (!cards.length) return;
  if (!(await confirmStoreDelete(cards))) return;
  await Promise.all(cards.map((c) => animateOut(c.id)));
  const now = Date.now();
  cards.forEach((c) => { c.prevColumnId = c.columnId; c.columnId = TRASH; c.trashedAt = now; c.updatedAt = now; });
  await db.putMany('cards', cards);
  clearSelection();
  await changed();
  toast(`已把 ${cards.length} 个移到回收站`, { action: '撤销', onAction: async () => {
    cards.forEach((c) => { c.columnId = area(c.prevColumnId) ? c.prevColumnId : defaultTarget(); delete c.trashedAt; });
    await db.putMany('cards', cards); await changed();
  } });
}
// 关联核心：把一组卡片（连同各自已关联的文件）绑成一个命名项目，可撤销
async function linkCards(ids, name, { quiet = false } = {}) {
  const all = [...new Set(ids.flatMap((id) => relatedIds(id)))].map(findCard).filter((c) => c && isActive(c));
  if (all.length < 2 || !name) return [];
  const before = all.map((c) => ({ c, projectId: c.projectId, projectName: c.projectName, noAuto: c.noAuto }));
  const pid = all.find((c) => c.projectId)?.projectId || uid();
  all.forEach((c) => { c.projectId = pid; c.projectName = name; c.noAuto = false; c.updatedAt = Date.now(); });
  await db.putMany('cards', all);
  await changed();
  highlightIds(all.map((c) => c.id), 'related');
  setTimeout(() => highlightIds([], 'related'), 1600);
  if (!quiet) toast(`已关联为项目「${name}」（${all.length} 个文件），长按任意一个即可整组打包`, {
    action: '撤销', onAction: async () => {
      before.forEach((b) => Object.assign(b.c, { projectId: b.projectId, projectName: b.projectName, noAuto: b.noAuto }));
      await db.putMany('cards', all); await changed();
    },
  });
  return all;
}
async function linkSelected() {
  const ids = [...state.selected].filter((id) => isActive(findCard(id) || {}));
  if (ids.length < 2) return;
  const all = [...new Set(ids.flatMap((id) => relatedIds(id)))].map(findCard).filter(Boolean);
  const name = await prompt({ title: `把 ${all.length} 个文件关联为一个项目`, value: commonTitle(all), placeholder: '项目名称，例如：2027 物理招生册', ok: '关联' });
  if (!name) return;
  clearSelection();
  await linkCards(ids, name);
}
// 卡片上的「+N 建议」：一键接受
async function acceptSuggestion(id) {
  const sg = suggestionFor(id);
  if (!sg) return;
  await linkCards(sg.ids, commonTitle(sg.ids.map(findCard).filter(Boolean)));
}
function dismissSuggestion(sg) {
  let added = 0;
  for (let i = 0; i < sg.ids.length && added < 250; i++) {
    for (let j = i + 1; j < sg.ids.length && added < 250; j++) {
      dismissed.add(pairKey(sg.ids[i], sg.ids[j]));
      added++;
    }
  }
  ls.set('dismissed', [...dismissed].slice(-3000));
}
async function unlinkGroup(ids) {
  const cards = ids.map(findCard).filter(Boolean);
  cards.forEach((c) => { c.noAuto = true; delete c.projectId; delete c.projectName; });
  await db.putMany('cards', cards);
  await changed();
}

// ---------- 「智能关联」面板 ----------
const SPARK_SVG = `<svg viewBox="0 0 24 24"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/></svg>`;
function renderAssocChip() {
  const chip = $('#assocChip');
  if (!chip) return;
  const n = state.suggestions?.length || 0;
  const tip = n ? `智能关联：发现 ${n} 条可能的项目关联，点击查看` : '智能关联：自动关联设置与已识别的项目';
  chip.innerHTML = `${SPARK_SVG}${n ? `<b>${n}</b>` : ''}`;
  chip.classList.toggle('has', n > 0);
  chip.classList.add('icon-chip');
  chip.title = tip;
  chip.dataset.tip = tip;
  chip.setAttribute('aria-label', tip);
}
function assocPanelHTML() {
  buildGroups();
  const cur = ls.get('assoc', 'normal');
  const projects = [...new Set([...state.groups.values()])].filter((ids) => ids.length > 1);
  const chip = (id) => { const c = findCard(id); const t = typeOf(c); return `<label class="fchip"><input type="checkbox" data-id="${id}" checked><span class="dot" style="--c:${c.kind === 'note' ? '#f0b429' : t.c}"></span>${esc(c.name || '便签')}</label>`; };
  return `<h3>${SPARK_SVG}智能关联</h3>
    <p class="assoc-desc">按文件名相似度（去掉「预览 / 终稿 / v2 / 日期」等后缀后比较）、是否同一批拖入、加入时间远近，自动判断哪些文件属于同一项目。分数高的自动关联，分数中等的放在下面等你确认。</p>
    <div class="seg" role="radiogroup" aria-label="关联灵敏度">${Object.entries(SENS).map(([k, v]) => `<button type="button" role="radio" data-sens="${k}" aria-checked="${k === cur}">${v.label}<small>${Math.round(v.auto * 100)}% 自动</small></button>`).join('')}</div>
    <div class="assoc-sec"><h4>建议关联 <b>${state.suggestions.length}</b></h4>
    ${state.suggestions.length ? state.suggestions.map((s, i) => `<div class="sugg" data-i="${i}">
        <div class="sugg-top"><input class="sugg-name" value="${esc(commonTitle(s.ids.map(findCard)))}" aria-label="项目名称"><span class="conf">相似度 ${Math.round(s.score * 100)}%</span></div>
        <div class="fchips">${s.ids.map(chip).join('')}</div>
        <div class="sugg-act"><button type="button" class="btn" data-sugg="ignore" data-i="${i}">忽略</button><button type="button" class="btn primary" data-sugg="link" data-i="${i}">关联</button></div>
      </div>`).join('') : '<div class="assoc-empty">暂时没有待确认的建议</div>'}</div>
    <div class="assoc-sec"><h4>已识别的项目 <b>${projects.length}</b></h4>
    ${projects.length ? projects.map((ids) => { const cs = ids.map(findCard); return `<div class="proj"><div><b>${esc(commonTitle(cs))}</b><span>${cs.map((c) => esc(c.name || '便签')).join('、')}</span></div><button type="button" class="btn ghost" data-unlink="${ids.join(',')}">拆开</button></div>`; }).join('') : '<div class="assoc-empty">还没有识别出项目</div>'}</div>
    <div class="modal-actions">${state.suggestions.length ? '<button type="button" class="btn primary" data-sugg="all">全部关联</button>' : ''}<button type="button" class="btn" data-sugg="close">关闭</button></div>`;
}
function openAssocPanel() {
  const m = $('#modal'), f = $('#modalInner');
  m.classList.add('wide');
  const paint = () => { f.innerHTML = assocPanelHTML(); };
  paint();
  f.onsubmit = (e) => e.preventDefault();
  const close = () => { m.classList.remove('wide'); f.onclick = null; if (m.open) m.close(); };
  m.oncancel = close; m.onclose = () => m.classList.remove('wide');
  f.onclick = async (e) => {
    const sensBtn = e.target.closest('[data-sens]');
    if (sensBtn) { ls.set('assoc', sensBtn.dataset.sens); render(); return paint(); }
    const un = e.target.closest('[data-unlink]');
    if (un) { await unlinkGroup(un.dataset.unlink.split(',')); return paint(); }
    const b = e.target.closest('[data-sugg]');
    if (!b) return;
    const act = b.dataset.sugg;
    if (act === 'close') return close();
    const pick = (i) => {
      const el = f.querySelector(`.sugg[data-i="${i}"]`);
      return { ids: [...el.querySelectorAll('input[type=checkbox]:checked')].map((x) => x.dataset.id), name: el.querySelector('.sugg-name').value.trim() };
    };
    if (act === 'ignore') { dismissSuggestion(state.suggestions[+b.dataset.i]); render(); return paint(); }
    if (act === 'link') { const p = pick(b.dataset.i); if (p.ids.length > 1) await linkCards(p.ids, p.name || '项目'); return paint(); }
    if (act === 'all') {
      const all = state.suggestions.map((_, i) => pick(i)).filter((p) => p.ids.length > 1);
      for (const p of all) await linkCards(p.ids, p.name || '项目', { quiet: true });
      toast(`已关联 ${all.length} 个项目`);
      return paint();
    }
  };
  m.showModal();
}
function moveMenu(anchor) {
  const ids = [...state.selected];
  const items = [];
  const add = (list, label) => { if (!list.length) return; items.push({ label }); list.forEach((a) => items.push({ text: a.title, run: () => moveMany(ids, a.id) })); };
  add(columns(), '看板');
  add(canvases(), '画布');
  add(zones(), '功能区');
  if (folders().length) { items.push({ label: '已完成项目' }); folders().forEach((f) => items.push({ text: folderPath(f), run: () => moveMany(ids, f.id) })); }
  openMenu(anchor, items);
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
  if (card && findCard(card.dataset.id)?.kind === 'file') urlFor(card.dataset.id).catch(() => {}); // 预先准备，以便拖到桌面
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
  if ($('#modal').open && $('#upDropzone')) return;
  if (isFileDrag(e)) { fileDepth++; document.body.classList.add('file-over'); }
  if (state.dragId && e.target.closest?.('.drafts-toggle')) document.body.classList.add('drafts-open');
});
document.addEventListener('dragleave', (e) => {
  if ($('#modal').open && $('#upDropzone')) return;
  if (isFileDrag(e) && --fileDepth <= 0) { fileDepth = 0; document.body.classList.remove('file-over'); clearDropUI(); }
});
document.addEventListener('dragover', (e) => {
  if ($('#modal').open && $('#upDropzone')) return;
  const fileDrag = isFileDrag(e);
  if (!fileDrag && !state.dragId) return;
  e.preventDefault(); // 防止浏览器直接打开文件
  clearDropUI();
  e.dataTransfer.dropEffect = fileDrag ? 'copy' : 'move';
  const tab = e.target.closest?.('[data-drop]');
  if (tab && !(fileDrag && tab.dataset.drop === TRASH)) { tab.classList.add('drop-active'); return; }
  if (e.target.closest?.('#viewport')) { $('#viewport').classList.add('drop-active'); return; }
  const list = e.target.closest?.('.list');
  if (!list || (fileDrag && list.dataset.col === TRASH)) {
    if (fileDrag && e.target.closest?.('#archiveView')) { $('#archiveView').classList.add('drop-active'); return; }
    if (!fileDrag) e.dataTransfer.dropEffect = 'none';
    return;
  }
  list.classList.add('drop-active');
  indicator = document.createElement('div');
  indicator.className = 'drop-indicator';
  list.insertBefore(indicator, dropBefore(list, e.clientY));
});
document.addEventListener('drop', async (e) => {
  if ($('#modal').open && $('#upDropzone')) return;
  const fileDrag = isFileDrag(e);
  if (!fileDrag && !state.dragId) return;
  e.preventDefault();
  const dtSnap = fileDrag ? captureDataTransferSync(e.dataTransfer) : null;
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
    const scanToast = dtSnap.entries.some((en) => en.isDirectory)
      ? toast('正在高速扫描文件夹…', { sticky: true })
      : null;
    const raw = await scanTransferPayload(dtSnap, ({ dirs, files }) => {
      scanToast?.set(`正在扫描：${dirs} 个文件夹、${files} 个文件…`);
    });
    scanToast?.close();
    const plan = upTree.buildUploadPlan(raw.files, raw.dirs);
    if (!plan.files.length && !plan.dirPaths.length) return;
    if (plan.hasDirs) {
      if (target && area(target)?.kind === 'folder') {
        return executeUploadPlan(plan, { mode: 'folder-tree', targetAreaId: target, openOnFinish: true });
      }
      if (!target && openFolder()) {
        return executeUploadPlan(plan, { mode: 'folder-tree', targetAreaId: openFolder(), openOnFinish: true });
      }
      if (state.view === ARCHIVE && (!target || target === PICK)) {
        const cat = (state.archCat && state.archCat !== 'all' && state.archCat !== '__none') ? state.archCat : undefined;
        return executeUploadPlan(plan, { mode: 'folder-tree', targetAreaId: null, category: cat, openOnFinish: true });
      }
      return openUploadModal({ initialRaw: raw, preferDest: 'archive-root' });
    }
    const flatFiles = plan.files.map((x) => x.file);
    if (target === PICK) {
      target = await pickFolder();
      if (!target) return;
    }
    if (target === CANVAS_PICK) {
      if (!flatFiles.length) return;
      target = await pickCanvas();
      if (!target) return;
    }
    if (!target && state.view === ARCHIVE && !openFolder()) {
      return openUploadModal({ initialRaw: raw, preferDest: 'archive-root' });
    }
    if (target === TRASH) target = defaultTarget();
    return addFiles(flatFiles, target, list ? realIndex(target, before) : null, pos);
  }
  // 拖动的是已选中的卡片 → 所有已选一起移动
  const group = state.selected.has(dragId) && state.selected.size > 1 ? [...state.selected] : null;
  if (target === PICK) {
    const fid = await pickFolder();
    if (!fid) return;
    if (group) { clearSelection(); return archiveCards(group.map(findCard).filter(Boolean), fid); }
    return archiveCards([findCard(dragId)].filter(Boolean), fid);
  }
  if (target === CANVAS_PICK) {
    target = await pickCanvas(group ? undefined : findCard(dragId)?.columnId);
    if (!target) return;
  }
  if (group && target && target !== TRASH) return moveMany(group, target);
  if (group && target === TRASH) return trashMany(group);
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
    if (viewTab.dataset.view === WORKS && state.view === WORKS) { state.work = null; ls.set('work', null); }
    if (viewTab.dataset.view === STORE && state.view === STORE) { state.shelf = null; ls.set('shelf', null); if (openFolder()) { state.folder = null; ls.set('folder', null); } }
    const next = viewTab.dataset.view;
    setView(next);
    render();
    if (next === CANVASES) $('#canvasDirectoryTitle').focus();
    else if (isCanvas(next)) $('#canvasTitle').focus();
    return;
  }
  const wgo = e.target.closest('[data-wgoto]');
  if (wgo) { state.work = null; ls.set('work', null); if (wgo.dataset.wcat) { state.workCat = wgo.dataset.wcat; ls.set('workCat', state.workCat); } return render(); }
  const wcatEl = e.target.closest('[data-wcat]');
  if (wcatEl && !btn) { state.workCat = wcatEl.dataset.wcat; ls.set('workCat', state.workCat); return render(); }
  const workEl = e.target.closest('[data-work]');
  if (workEl && !btn && !e.target.closest('a[href]')) {
    state.work = workEl.dataset.work; ls.set('work', state.work); state.logFilter = 'all'; state.logLimit = 40;
    $('#worksView').scrollTop = 0;
    return render();
  }
  const gotoEl = e.target.closest('[data-goto]');
  if (gotoEl) { state.folder = gotoEl.dataset.goto || null; ls.set('folder', state.folder); return render(); }
  const catEl = e.target.closest('[data-cat]');
  if (catEl && !btn) { state.archCat = catEl.dataset.cat; ls.set('archCat', state.archCat); return render(); }
  const folderEl = e.target.closest('[data-folder]');
  if (folderEl && !btn) { state.folder = folderEl.dataset.folder; ls.set('folder', state.folder); return render(); }
  const shelfEl = e.target.closest('[data-shelf]');
  if (shelfEl && !btn) { state.shelf = shelfEl.dataset.shelf; ls.set('shelf', state.shelf); return render(); }
  const zoneTab = e.target.closest('[data-zone]');
  if (zoneTab) { state.zone = zoneTab.dataset.zone; ls.set('zone', state.zone); return renderZones(), loadThumbs(); }
  const cardEl = e.target.closest('.card');
  if (cardEl && e.target.closest('.inline-rn-wrap')) return;
  const colEl = e.target.closest('.column');
  const col = colEl && area(colEl.dataset.colId);
  // Shift 点击卡片或勾选按钮时，范围以当前列表中的卡片顺序为准。
  const rangeList = e.shiftKey ? cardEl?.closest('.list, #world') : null;
  if (cardEl && !btn && (e.ctrlKey || e.metaKey || e.shiftKey || state.selected.size)) return toggleSelect(cardEl.dataset.id, rangeList);
  if (!btn) {
    if (cardEl) {
      if (cardEl.classList.contains('on-canvas')) {
        pickCanvasCard(cardEl.dataset.id);
        cardEl.focus({ preventScroll: true });
        return;
      }
      preview(cardEl.dataset.id);
    }
    return;
  }
  switch (btn.dataset.action) {
    case 'quick-rename': return startInlineRename(cardEl?.dataset.id || btn.closest('.card')?.dataset.id);
    case 'batch-rename-folder': {
      const fid = openFolder();
      return fid && openBatchRename(cardsIn(fid, false), area(fid)?.title);
    }
    case 'sel-rename': return openBatchRename([...state.selected].map(findCard).filter(Boolean), '已选文件');
    case 'card-preview': return preview(btn.dataset.id || cardEl?.dataset.id);
    case 'pdf-prev': {
      const c = findCard(btn.dataset.id || cardEl?.dataset.id);
      if (c) setCanvasPdfPage(c, (c.pdfPage || 1) - 1);
      return;
    }
    case 'pdf-next': {
      const c = findCard(btn.dataset.id || cardEl?.dataset.id);
      if (c) setCanvasPdfPage(c, (c.pdfPage || 1) + 1);
      return;
    }
    case 'pdf-jump': {
      const c = findCard(btn.dataset.id || cardEl?.dataset.id);
      if (!c) return;
      const doc = await getCanvasPdfDoc(c.id).catch(() => null);
      const tot = c.info?.pages || doc?.numPages || 1;
      const v = await prompt({ title: `跳转到页码（共 ${tot} 页）`, value: String(c.pdfPage || 1), placeholder: `1 - ${tot}`, ok: '跳转' });
      if (v) setCanvasPdfPage(c, Number(v));
      return;
    }
    case 'accept-suggest': return acceptSuggestion(btn.dataset.id);
    case 'load-more-cards': return appendMoreCards(btn.dataset.area, btn);
    case 'assoc-panel': return openAssocPanel();
    case 'select': return toggleSelect(cardEl.dataset.id, rangeList);
    case 'sel-done': return completeCards([...state.selected]);
    case 'sel-align': return menuAnchor === btn ? closeMenu() : openMenu(btn, [
      { label: '画布对齐与分布' },
      ...Object.entries(ALIGN_OPS).map(([k, text]) => ({ text, run: () => alignCanvasCards(k) })),
    ]);
    case 'auto-align': return autoAlignCanvas();
    case 'sel-link': return linkSelected();
    case 'sel-move': return menuAnchor === btn ? closeMenu() : moveMenu(btn);
    case 'sel-prio': return menuAnchor === btn ? closeMenu() : openMenu(btn, [
      { label: '优先级' },
      ...[1, 2, 3].map((lv) => ({ text: PRIO[lv].label, tag: PRIO[lv], run: () => setPrio([...state.selected], lv) })),
      { text: '清除优先级', run: () => setPrio([...state.selected], 0) },
    ]);
    case 'cat-add': return addCategory();
    case 'sel-trash': return trashMany([...state.selected]);
    case 'sel-clear': return clearSelection();
    case 'card-menu': return menuAnchor === btn ? closeMenu() : cardMenu(btn, findCard(cardEl.dataset.id));
    case 'col-menu': return menuAnchor === btn ? closeMenu() : areaMenu(btn, col);
    case 'zone-menu': return menuAnchor === btn ? closeMenu() : areaMenu(btn, area(state.zone));
    case 'canvas-menu': return menuAnchor === btn ? closeMenu() : areaMenu(btn, area(btn.dataset.id || state.view));
    case 'rename-area': return renameArea(col);
    case 'add-col': return addArea('column');
    case 'add-zone': return addArea('zone');
    case 'add-canvas': return addArea('canvas');
    case 'add-folder': return addArea('folder');
    case 'add-subfolder': return addSubfolder(openFolder());
    case 'folder-back': state.folder = parentOf(area(state.folder))?.id || null; ls.set('folder', state.folder); return render();
    case 'folder-zip': return zipFolder(area(openFolder()));
    case 'folder-menu': return menuAnchor === btn ? closeMenu() : areaMenu(btn, area(btn.dataset.id || openFolder()));
    case 'work-new': return editWork(null);
    case 'work-import': return importFromGitHub();
    case 'work-sync-all': return syncMany(works());
    case 'work-sync': return syncMany([area(openWork())]);
    case 'work-edit': return editWork(area(openWork()));
    case 'work-back': state.work = null; ls.set('work', null); return render();
    case 'work-menu': return menuAnchor === btn ? closeMenu() : workMenu(btn, area(btn.dataset.id || openWork()));
    case 'work-preview': return previewSite(area(btn.dataset.id));
    case 'wcat-add': return addWorkCat();
    case 'log-filter': state.logFilter = btn.dataset.f; state.logLimit = 40; return render();
    case 'log-more': state.logLimit += 60; return render();
    case 'log-menu': return menuAnchor === btn ? closeMenu() : logMenu(btn, area(openWork()), btn.dataset.id);
    case 'sp-device': {
      const sp = btn.closest('.site-prev');
      state.device = btn.dataset.d; ls.set('device', state.device);
      sp.dataset.device = state.device;
      $$('[data-action="sp-device"]', sp).forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
      return fitPreview();
    }
    case 'sp-reload': {
      const sp = btn.closest('.site-prev'), f = $('iframe', sp);
      sp.classList.remove('loaded'); f.src = sp.dataset.url;
      return;
    }
    case 'sp-full': {
      const sp = btn.closest('.site-prev');
      document.body.classList.toggle('sp-full-open', sp.classList.toggle('full'));
      fitPreview();
      return requestAnimationFrame(fitPreview);
    }
    case 'add-note-col': return newNote(col.id);
    case 'new-note': return newNote();
    case 'add-files': return openUploadModal();
    case 'backup': return doBackup();
    case 'restore': return $('#restoreInput').click();
    case 'storage-info': await ensureAccess(); return storageInfo();
    case 'download': return download(btn.dataset.id);
    case 'close-viewer': return closeViewer();
    case 'zoom-in': return zoomAt(1.25, null, null, true);
    case 'zoom-out': return zoomAt(1 / 1.25, null, null, true);
    case 'zoom-reset': return zoomAt(1 / cam().z, null, null, true);
    case 'convert': return runConvert(btn);
    case 'zoom-fit': return zoomFit();
    case 'tidy': return tidyCanvas();
    case 'area-share': return startShare(area(btn.dataset.id));
    case 'shelf-back': state.shelf = null; ls.set('shelf', null); return render();
    case 'add-shelf': return addArea('shelf');
    case 'shelf-menu': { const s = area(btn.dataset.id || openShelf()); return s ? (menuAnchor === btn ? closeMenu() : areaMenu(btn, s)) : undefined; }
    case 'shelf-zip': { const s = area(btn.dataset.id); return s ? zipFolder(s) : undefined; }
    case 'shortcuts': return showShortcuts();
    case 'canvas-bg': return menuAnchor === btn ? closeMenu() : canvasBgMenu(btn);
    case 'templates': return pickTemplate();
    case 'toggle-theme': return toggleTheme(btn);
    case 'collapse-drafts': return setDraftsCollapsed(true)?.focus({ preventScroll: true });
    case 'expand-drafts': return setDraftsCollapsed(false)?.focus({ preventScroll: true });
    case 'toggle-drafts-rail': return setDraftsCollapsed(!draftsCollapsed());
    case 'canvas-max': return toggleCanvasMax();
    case 'collab-panel': return toggleCollabPopover();
    case 'comments-panel': return toggleCommentsPopover();
    case 'toggle-drafts': {
      const open = document.body.classList.toggle('drafts-open');
      $('.drafts-toggle').setAttribute('aria-expanded', String(open));
      return;
    }
    case 'clear-zone': {
      const z = area(state.zone);
      if (z) return clearAreaToTrash(z);
      return;
    }
    case 'empty-trash': {
      const list = cardsIn(TRASH, false);
      if (!list.length) return;
      if (!(await confirmBox({ title: '清空回收站？', body: `${list.length} 张卡片将被永久删除，无法恢复。建议先备份。`, ok: '永久删除', danger: true }))) return;
      await purgeMany(list.map((c) => c.id));
      toast(`已永久删除 ${list.length} 张卡片`);
      return changed();
    }
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('.site-prev.full')) { $('.site-prev.full').classList.remove('full'); document.body.classList.remove('sp-full-open'); fitPreview(); return; }
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.target.matches?.('#logForm textarea')) { e.preventDefault(); e.target.form.requestSubmit(); return; }
  if (e.key === 'Escape') {
    if ($('#menu').hidden && !$('#modal').open && !$('#viewer').open) clearSelection();
    closeMenu(); document.body.classList.remove('drafts-open');
  }
  const cardEl = e.target.closest?.('.card');
  if (cardEl && e.target === cardEl) {
    const card = findCard(cardEl.dataset.id);
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); preview(card.id); }
    if (e.key === 'Delete' && card.columnId !== TRASH) trashCard(card.id);
    // 1 / 2 / 3 设优先级，0 清除；多选时作用于全部已选
    if (/^[0-3]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const ids = state.selected.has(card.id) && state.selected.size > 1 ? [...state.selected] : [card.id];
      setPrio(ids, +e.key);
    }
    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); cardMenu($('.more', cardEl), card); }
    // 画布上用方向键微调位置；PDF 卡片用 PageUp / PageDown 或 [ / ] 翻页
    if (cardEl.classList.contains('on-canvas') && (e.key === 'PageUp' || e.key === 'PageDown' || e.key === '[' || e.key === ']')) {
      if (pv.family(card) === 'pdf') {
        e.preventDefault();
        const delta = (e.key === 'PageUp' || e.key === '[') ? -1 : 1;
        setCanvasPdfPage(card, (card.pdfPage || 1) + delta);
      }
    }
    if (cardEl.classList.contains('on-canvas') && e.key.startsWith('Arrow')) {
      e.preventDefault();
      const s = e.shiftKey ? 40 : 10;
      card.x = (card.x || 0) + (e.key === 'ArrowLeft' ? -s : e.key === 'ArrowRight' ? s : 0);
      card.y = (card.y || 0) + (e.key === 'ArrowUp' ? -s : e.key === 'ArrowDown' ? s : 0);
      cardEl.style.left = `${card.x}px`; cardEl.style.top = `${card.y}px`;
      drawLinks();
      sendCollabCardLive([card], '正在微调位置');
      clearTimeout(cardEl._t); cardEl._t = setTimeout(() => saveCard(card), 300);
    }
  }
  if (e.target.matches?.('[data-folder], [data-work], [data-shelf]') && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); e.target.click(); }
  if (e.key === 'F2' && !isTypingTarget(e.target) && !$('#modal').open && !$('#viewer').open) {
    if (state.selected.size > 1) { e.preventDefault(); return openBatchRename([...state.selected].map(findCard).filter(Boolean), '已选文件'); }
    if (state.selected.size === 1) { e.preventDefault(); return startInlineRename([...state.selected][0]); }
    if (isCanvas(state.view) && state.pickedCard) { e.preventDefault(); return startInlineRename(state.pickedCard); }
    if (cardEl && findCard(cardEl.dataset.id)?.columnId !== TRASH) { e.preventDefault(); return startInlineRename(cardEl.dataset.id); }
    const fid = openFolder();
    if (fid && cardsIn(fid, false).length) { e.preventDefault(); return openBatchRename(cardsIn(fid, false), area(fid)?.title); }
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#search').focus(); }
  if ((e.ctrlKey || e.metaKey) && (e.key === '\\' || e.code === 'Backslash') && matchMedia('(min-width: 1001px)').matches) { e.preventDefault(); setDraftsCollapsed(!draftsCollapsed()); }
});
// ---------- 白天 / 黑夜模式 ----------
const darkMQ = matchMedia('(prefers-color-scheme: dark)');
const themePref = () => ls.get('theme', 'auto');
const isDark = () => themePref() === 'dark' || (themePref() === 'auto' && darkMQ.matches);
function applyTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  ls.set('theme', t);
  const bg = isDark() ? '#16171a' : '#f6f5f2';
  $$('meta[name="theme-color"]').forEach((m) => { m.content = t === 'auto' ? (m.media.includes('dark') ? '#16171a' : '#f6f5f2') : bg; });
  const btn = $('#themeBtn');
  if (btn) btn.setAttribute('aria-label', isDark() ? '切换到白天模式' : '切换到黑夜模式');
}
// 从按钮位置以圆形扩散切换（浏览器支持 View Transitions 时）
function switchTheme(t, origin) {
  if (!document.startViewTransition || reduceMotion.matches) return applyTheme(t);
  const r = origin?.getBoundingClientRect();
  const x = r ? r.left + r.width / 2 : innerWidth - 40, y = r ? r.top + r.height / 2 : 30;
  const rad = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  const vt = document.startViewTransition(() => applyTheme(t));
  vt.ready.then(() => document.documentElement.animate(
    { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${rad}px at ${x}px ${y}px)`] },
    { duration: 560, easing: 'cubic-bezier(.4,0,.2,1)', pseudoElement: '::view-transition-new(root)' },
  )).catch(() => {});
}
function toggleTheme(btn) {
  const next = isDark() ? 'light' : 'dark';
  switchTheme(next, btn);
  toast(next === 'dark' ? '已切换到黑夜模式（右键按钮可改为跟随系统）' : '已切换到白天模式（右键按钮可改为跟随系统）');
}
$('#themeBtn')?.addEventListener('contextmenu', (e) => {
  e.preventDefault(); e.stopPropagation();
  const cur = themePref();
  openMenu(e.currentTarget, [
    { label: '外观' },
    { text: `${cur === 'light' ? '✓ ' : ''}白天模式`, run: () => switchTheme('light', $('#themeBtn')) },
    { text: `${cur === 'dark' ? '✓ ' : ''}黑夜模式`, run: () => switchTheme('dark', $('#themeBtn')) },
    { text: `${cur === 'auto' ? '✓ ' : ''}跟随系统`, run: () => switchTheme('auto', $('#themeBtn')) },
  ]);
});
darkMQ.addEventListener?.('change', () => { if (themePref() === 'auto') applyTheme('auto'); });
applyTheme(themePref());

document.addEventListener('contextmenu', (e) => {
  const cardEl = e.target.closest('.card');
  if (!cardEl) return;
  e.preventDefault();
  cardMenu($('.more', cardEl), findCard(cardEl.dataset.id));
});
document.addEventListener('paste', async (e) => {
  // 输入框、对话框、正在编辑的便签 / 形状文字：交给它们自己处理，别变成新卡片
  if (e.target.closest?.('input, textarea, dialog') || e.target.isContentEditable || e.target.parentElement?.isContentEditable) return;
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); return addFiles(files.map((f) => f.name ? f : new File([f], `粘贴的图片-${Date.now()}.png`, { type: f.type }))); }
  const text = e.clipboardData?.getData('text/plain');
  if (text?.trim()) {
    e.preventDefault();
    const areaId = state.view === CANVASES ? await pickCanvas() : defaultTarget();
    if (!areaId) return;
    const now = Date.now();
    const card = { id: uid(), kind: 'note', name: text.trim().split('\n')[0].slice(0, 40), text, columnId: areaId,
      order: isCanvas(areaId) ? topOrder(areaId) : orderAt(areaId, cardsIn(areaId, false).length), createdAt: now, updatedAt: now, enteredAt: now };
    if (isCanvas(areaId)) Object.assign(card, state.view === areaId ? viewCenter() : { x: 0, y: 0 });
    db.put('cards', card).then(() => { state.cards.push(card); state.fresh.add(card.id); toast('已粘贴为便签'); changed(); });
  }
});
let searchTimer;
$('#search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.query = e.target.value.trim(); state.listLimits.clear(); render(); }, 120);
});
let scrollExpandRaf = 0;
document.addEventListener('scroll', (e) => {
  const scroller = e.target;
  if (!scroller?.querySelector) return;
  if (!scroller.matches('.list, #archiveView, #worksView')) return;
  if (scrollExpandRaf) return;
  scrollExpandRaf = requestAnimationFrame(() => {
    scrollExpandRaf = 0;
    const btn = scroller.querySelector('.load-more-cards');
    if (!btn || !btn.isConnected) return;
    const sr = scroller.getBoundingClientRect();
    const br = btn.getBoundingClientRect();
    if (br.top <= sr.bottom + 320) appendMoreCards(btn.dataset.area, btn);
  });
}, { passive: true, capture: true });
$('#fileInput').addEventListener('change', (e) => {
  const raw = upTree.extractFromFileList([...e.target.files]);
  e.target.value = '';
  if (!raw.files.length) return;
  if ($('#modal').open && activeUploadModal) return activeUploadModal.addRaw(raw);
  return handleDirectInputUpload(raw);
});
$('#dirInput').addEventListener('change', (e) => {
  const raw = upTree.extractFromFileList([...e.target.files]);
  e.target.value = '';
  if (!raw.files.length) return;
  if ($('#modal').open && activeUploadModal) return activeUploadModal.addRaw(raw);
  return handleDirectInputUpload(raw);
});
$('#restoreInput').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) doRestore(f); });
window.addEventListener('resize', closeMenu);
$('#board').addEventListener('scroll', closeMenu, { passive: true });

channel && (channel.onmessage = async () => {
  if (bd || cardDrag || editingShape) return;
  await load(); render(); refreshStatus();
});

// ---------- 画布多人实时协作（方案一：免服务器 P2P WebRTC + 同机极速双通道） ----------
let collabSession = null;
let followPeerId = null;
let collabSyncTimer = 0;
let collabCursorTimer = 0;
let collabShapeLiveTimer = 0;
let collabCardLiveTimer = 0;
let lastCollabCursor = { x: 0, y: 0, act: '' };
const deferredCollabPkts = [];
const canvasKnownShapes = new Map();   // canvasId -> Map(shapeId -> json)
const canvasKnownLinks = new Map();    // canvasId -> Map(linkId -> json)
const canvasKnownComments = new Map(); // canvasId -> Map(commentId -> json)
const canvasKnownCards = new Map();    // canvasId -> Set(cardId)
const cardSyncProgress = new Map();  // cardId -> 0..100
const orphanCollabBlobs = new Map(); // `${cardId}:${kind}` -> Blob（防元数据先于或晚于文件到达导致的丢包）
let collabTaskChain = Promise.resolve();
const enqueueCollabTask = (fn) => {
  collabTaskChain = collabTaskChain.then(fn, fn);
  return collabTaskChain;
};
const TAB_PEER_ID = uid();           // 每个页面实例唯一 ID（即使克隆标签页也绝不冲突）
let tabCollabProfile = null;

function collabInitial(name) {
  const s = String(name || '').trim();
  if (!s) return '协';
  if (/^[\x00-\x7f]+$/.test(s)) {
    const ws = s.split(/[\s\-_.]+/).filter(Boolean);
    return (ws.length > 1 ? ws[0][0] + ws[1][0] : s.slice(0, 2)).toUpperCase();
  }
  return [...s.replace(/\s/g, '')][0] || '协';
}

function getCollabProfile() {
  if (tabCollabProfile) return tabCollabProfile;
  const saved = ls.get('collabProfile', null);
  const colorIdx = Math.floor(Math.random() * collab.COLLAB_COLORS.length);
  tabCollabProfile = {
    id: TAB_PEER_ID,
    name: saved?.name || `设计师 ${Math.floor(100 + Math.random() * 900)}`,
    color: saved?.color || collab.COLLAB_COLORS[colorIdx].hex,
  };
  if (!saved) ls.set('collabProfile', { name: tabCollabProfile.name, color: tabCollabProfile.color });
  return tabCollabProfile;
}

function saveCollabProfile(patch) {
  const cur = getCollabProfile();
  tabCollabProfile = { ...cur, ...patch, id: TAB_PEER_ID };
  ls.set('collabProfile', { name: tabCollabProfile.name, color: tabCollabProfile.color });
  if (collabSession) collabSession.updateSelf({ name: tabCollabProfile.name, color: tabCollabProfile.color });
  renderCollabUI();
  if (!$('#collabPopover').hidden) renderCollabPopover();
  return tabCollabProfile;
}

function recordCanvasBaseline(a) {
  if (!a || a.kind !== 'canvas') return;
  const now = Date.now();
  const sMap = new Map(), lMap = new Map(), cMap = new Map();
  for (const s of a.shapes || []) {
    if (!s._u) s._u = now;
    sMap.set(s.id, JSON.stringify({ ...s, _u: undefined, _t: undefined }));
  }
  for (const l of a.links || []) {
    if (!l._u) l._u = now;
    lMap.set(l.id, JSON.stringify({ ...l, _u: undefined }));
  }
  for (const cm of a.comments || []) {
    if (!cm._u) cm._u = cm.createdAt || now;
    cMap.set(cm.id, JSON.stringify({ ...cm, _u: undefined }));
  }
  canvasKnownShapes.set(a.id, sMap);
  canvasKnownLinks.set(a.id, lMap);
  canvasKnownComments.set(a.id, cMap);
  canvasKnownCards.set(a.id, new Set(cardsIn(a.id, false).map((c) => c.id)));
}

function stampCanvasMutations(a) {
  if (!a || a.kind !== 'canvas') return;
  const now = Date.now();
  a._u = now;
  const prevS = canvasKnownShapes.get(a.id) || new Map();
  const prevL = canvasKnownLinks.get(a.id) || new Map();
  const prevC = canvasKnownComments.get(a.id) || new Map();
  const nextS = new Map(), nextL = new Map(), nextC = new Map();
  const deletedIds = [];

  for (const s of a.shapes || []) {
    const raw = JSON.stringify({ ...s, _u: undefined, _t: undefined });
    if (!prevS.has(s.id) || prevS.get(s.id) !== raw) s._u = now;
    else if (!s._u) s._u = now;
    nextS.set(s.id, raw);
  }
  for (const oldId of prevS.keys()) if (!nextS.has(oldId)) deletedIds.push(oldId);

  for (const l of a.links || []) {
    const raw = JSON.stringify({ ...l, _u: undefined });
    if (!prevL.has(l.id) || prevL.get(l.id) !== raw) l._u = now;
    else if (!l._u) l._u = now;
    nextL.set(l.id, raw);
  }
  for (const oldId of prevL.keys()) if (!nextL.has(oldId)) deletedIds.push(oldId);

  for (const cm of a.comments || []) {
    const raw = JSON.stringify({ ...cm, _u: undefined });
    if (!prevC.has(cm.id) || prevC.get(cm.id) !== raw) cm._u = now;
    else if (!cm._u) cm._u = cm.createdAt || now;
    nextC.set(cm.id, raw);
  }
  for (const oldId of prevC.keys()) if (!nextC.has(oldId)) deletedIds.push(oldId);

  canvasKnownShapes.set(a.id, nextS);
  canvasKnownLinks.set(a.id, nextL);
  canvasKnownComments.set(a.id, nextC);
  if (deletedIds.length && collabSession?.canvasId === a.id) {
    collabSession.recordTombstones(deletedIds, now);
  }
}

function detectRemovedCanvasCards(canvasId) {
  const prevSet = canvasKnownCards.get(canvasId) || new Set();
  const curCards = cardsIn(canvasId, false);
  const nextSet = new Set(curCards.map((c) => c.id));
  const removed = [];
  for (const oldId of prevSet) if (!nextSet.has(oldId)) removed.push(oldId);
  canvasKnownCards.set(canvasId, nextSet);
  if (removed.length && collabSession?.canvasId === canvasId) {
    collabSession.recordTombstones(removed, Date.now());
  }
  return curCards;
}

function buildCanvasSnapshot(canvasId = collabSession?.canvasId) {
  const a = area(canvasId);
  if (!a || a.kind !== 'canvas') return null;
  stampCanvasMutations(a);
  const cards = detectRemovedCanvasCards(canvasId).map((c) => collab.clonePlain(c));
  return {
    canvasId: a.id,
    title: a.title,
    _u: a._u || Date.now(),
    shapes: collab.clonePlain(a.shapes || []),
    links: collab.clonePlain(a.links || []),
    comments: collab.clonePlain(a.comments || []),
    cards,
  };
}

function scheduleCollabSync() {
  if (!collabSession || collabSession.joining || isCollabSuppressed()) return;
  clearTimeout(collabSyncTimer);
  collabSyncTimer = setTimeout(() => {
    if (!collabSession || collabSession.joining || isCollabSuppressed()) return;
    const snap = buildCanvasSnapshot(collabSession.canvasId);
    if (!snap) return;
    collabSession.send('board-sync', {
      snapshot: snap,
      tombstones: collabSession.tombstones,
    });
  }, 30);
}

function sendCollabCursor(wx, wy, act = '') {
  if (!collabSession || collabSession.joining || !isCanvas(state.view) || state.view !== collabSession.canvasId) return;
  if (typeof wx === 'number') lastCollabCursor.x = wx;
  if (typeof wy === 'number') lastCollabCursor.y = wy;
  if (act !== undefined) lastCollabCursor.act = act;
  if (collabCursorTimer) return;
  collabCursorTimer = setTimeout(() => {
    collabCursorTimer = 0;
    if (!collabSession || collabSession.joining) return;
    const picked = [...selIds(), ...state.selected, ...(state.pickedCard ? [state.pickedCard] : [])];
    const r = $('#viewport')?.getBoundingClientRect();
    const c = cam();
    const viewCenterW = r?.width ? toWorld(r.left + r.width / 2, r.top + r.height / 2) : { x: 0, y: 0 };
    collabSession.send('cursor', {
      x: lastCollabCursor.x,
      y: lastCollabCursor.y,
      tool: state.tool,
      selIds: [...new Set(picked)],
      editingId: editingShape || null,
      action: editingShape ? '正在输入…' : (bd?.moved || cardDrag?.moved ? '正在调整…' : lastCollabCursor.act || ''),
      cam: { cx: Math.round(viewCenterW.x), cy: Math.round(viewCenterW.y), z: Number(c.z.toFixed(3)) },
    });
  }, 42);
}

let pendingLiveShapes = null;
function sendCollabShapeLive(shapes, act = '') {
  if (!collabSession || collabSession.joining || isCollabSuppressed()) return;
  const now = Date.now();
  pendingLiveShapes = shapes.map((s) => {
    s._u = now;
    return collab.clonePlain(s);
  });
  sendCollabCursor(undefined, undefined, act);
  if (collabShapeLiveTimer) return;
  collabShapeLiveTimer = setTimeout(() => {
    collabShapeLiveTimer = 0;
    if (!collabSession || collabSession.joining || !pendingLiveShapes) return;
    const list = pendingLiveShapes;
    pendingLiveShapes = null;
    collabSession.send('shape-live', { canvasId: collabSession.canvasId, shapes: list });
  }, 40);
}

let pendingLiveCards = null;
function sendCollabCardLive(cards, act = '') {
  if (!collabSession || collabSession.joining || isCollabSuppressed()) return;
  const now = Date.now();
  pendingLiveCards = cards.map((c) => ({
    id: c.id,
    x: Math.round(c.x || 0),
    y: Math.round(c.y || 0),
    w: c.w,
    order: c.order,
    pdfPage: c.pdfPage,
    updatedAt: now,
  }));
  sendCollabCursor(undefined, undefined, act);
  if (collabCardLiveTimer) return;
  collabCardLiveTimer = setTimeout(() => {
    collabCardLiveTimer = 0;
    if (!collabSession || collabSession.joining || !pendingLiveCards) return;
    const list = pendingLiveCards;
    pendingLiveCards = null;
    collabSession.send('card-live', { canvasId: collabSession.canvasId, cards: list });
  }, 40);
}

function isLocalBusyOnShape(id) {
  if (editingShape === id) return true;
  if (bd?.moved) {
    if (bd.s?.id === id) return true;
    if (bd.items?.some((it) => it.s.id === id)) return true;
  }
  if (cardDrag?.moved && cardDrag.shapeItems?.some((sit) => sit.s.id === id)) return true;
  return false;
}

function isLocalBusyOnCard(id) {
  if (cardDrag?.moved) {
    if (cardDrag.card?.id === id) return true;
    if (cardDrag.items?.some((it) => it.card.id === id)) return true;
  }
  if (bd?.moved && bd.cardItems?.some((cit) => cit.card.id === id)) return true;
  return false;
}

function applyRemoteShapeLive(pkt) {
  if (!collabSession || pkt.canvasId !== collabSession.canvasId) return;
  const b = area(collabSession.canvasId);
  if (!b || b.kind !== 'canvas') return;
  b.shapes ||= [];
  let needFullRender = false;
  for (const rs of pkt.shapes || []) {
    if (!rs?.id || isLocalBusyOnShape(rs.id)) continue;
    const cur = b.shapes.find((s) => s.id === rs.id);
    if (!cur) {
      b.shapes.push(collab.clonePlain(rs));
      needFullRender = true;
      continue;
    }
    Object.assign(cur, collab.clonePlain(rs));
    if (state.view === b.id) {
      const el = shEl(cur.id);
      if (el) {
        const col = shColor(cur);
        Object.assign(el.style, {
          left: `${Math.round(cur.x)}px`,
          top: `${Math.round(cur.y)}px`,
          width: `${Math.round(cur.w)}px`,
          height: `${Math.round(cur.h)}px`,
          zIndex: Number.isFinite(cur.z) ? cur.z : 1,
          textAlign: cur.al || 'center',
        });
        el.style.setProperty('--fs', `${cur.fs || 16}px`);
        el.style.setProperty('--sb', col ? col.bg : 'transparent');
        el.style.setProperty('--sd', col ? col.bd : 'var(--text-3)');
        el.style.setProperty('--tc', col ? '#1f2023' : 'var(--text)');
        const tx = el.querySelector('.sh-tx');
        if (tx && tx.textContent !== (cur.text || '')) tx.textContent = cur.text || '';
        if (cur.text) fitSticky(cur, el);
      } else needFullRender = true;
    }
  }
  if (state.view === b.id) {
    if (needFullRender && !bd?.moved && !cardDrag?.moved && !editingShape) renderCanvas();
    else { drawLinks(); decorateBoard(); renderCollabOverlay(); }
  }
}

function applyRemoteCardLive(pkt) {
  if (!collabSession || pkt.canvasId !== collabSession.canvasId) return;
  for (const rc of pkt.cards || []) {
    if (!rc?.id || isLocalBusyOnCard(rc.id)) continue;
    const c = findCard(rc.id);
    if (!c) continue;
    if (typeof rc.x === 'number') c.x = rc.x;
    if (typeof rc.y === 'number') c.y = rc.y;
    if (typeof rc.w === 'number') c.w = rc.w;
    if (typeof rc.order === 'number') c.order = rc.order;
    c.updatedAt = Math.max(c.updatedAt || 0, rc.updatedAt || Date.now());
    const pageChanged = rc.pdfPage && rc.pdfPage !== c.pdfPage;
    if (pageChanged) c.pdfPage = rc.pdfPage;
    if (state.view === collabSession.canvasId) {
      const el = $(`#world .card[data-id="${CSS.escape(c.id)}"]`);
      if (el) {
        el.style.left = `${Math.round(c.x || 0)}px`;
        el.style.top = `${Math.round(c.y || 0)}px`;
        if (c.w) el.style.width = `${canvasCardW(c)}px`;
        if (c.order) el.style.zIndex = Math.max(1, Math.round(c.order));
        if (pageChanged) {
          const img = el.querySelector('img[data-canvas-pdf]');
          if (img) {
            img.dataset.page = String(c.pdfPage);
            updatePdfNavDOM(el, c.pdfPage, c.info?.pages || 0);
            ensureCanvasPdf(img);
          }
        }
      }
    }
  }
  if (state.view === collabSession.canvasId) {
    drawLinks();
    renderCollabOverlay();
  }
}

async function applyRemoteSnapshot(pkt, isWelcome = false) {
  const snap = pkt?.snapshot;
  if (!collabSession || !snap) return;
  if (bd?.moved || cardDrag?.moved) {
    deferredCollabPkts.push({ pkt, isWelcome });
    return;
  }
  suppressCollabDepth++;
  try {
    if (pkt.tombstones) {
      collabSession.tombstones = collab.mergeTombstones(collabSession.tombstones, pkt.tombstones);
    }
    const targetId = snap.canvasId || collabSession.canvasId;
    // 房主或已完成同步的协作者，绝不被新访客本地默认画布或无关画布的快照覆盖/切走视角
    if (!collabSession.joining && targetId !== collabSession.canvasId) {
      return;
    }
    const wasJoining = collabSession.joining;
    let cv = area(targetId);
    let createdNewCanvas = false;
    const wasEmpty = !cv || (!(cv.shapes?.length) && !cardsIn(cv.id, false).length);

    if (!cv) {
      cv = {
        id: targetId,
        kind: 'canvas',
        title: snap.title || '协作画布',
        order: canvases().length * 1024,
        shapes: [],
        links: [],
        comments: [],
        _u: 0,
      };
      state.areas.push(cv);
      createdNewCanvas = true;
    }
    collabSession.markSynced(cv.id);

    const prevCommentMap = new Map(
      (cv.comments || []).map((cm) => [cm.id, { resolved: !!cm.resolved, replies: new Set((cm.replies || []).map((r) => r.id)) }]),
    );

    // 若本地正处于某个便签/形状的文字编辑状态，保留该形状正在编辑的本地副本
    const activeEditObj = editingShape ? shapeById(editingShape) : null;
    const activeEditCopy = activeEditObj ? { ...activeEditObj } : null;

    const mergedBoard = collab.mergeBoardState(cv, snap, collabSession.tombstones);
    cv.title = mergedBoard.title;
    cv._u = mergedBoard._u;
    cv.shapes = mergedBoard.shapes;
    cv.links = mergedBoard.links;
    cv.comments = mergedBoard.comments;

    // 清理被同伴删除评论的未读状态或打开浮窗
    const liveCmIds = new Set(cv.comments.map((cm) => cm.id));
    for (const id of [...unreadCommentIds]) {
      if (state.view === cv.id && !liveCmIds.has(id)) unreadCommentIds.delete(id);
    }
    if (state.view === cv.id && openCommentId && openCommentId !== 'draft' && !liveCmIds.has(openCommentId)) {
      openCommentId = null;
    }

    if (!isWelcome && !wasJoining) {
      const myId = getCollabProfile().id;
      for (const cm of cv.comments) {
        const prev = prevCommentMap.get(cm.id);
        if (!prev) {
          if (cm.authorId !== myId) {
            handleRemoteCommentNotify({
              canvasId: cv.id,
              canvasTitle: cv.title,
              eventKey: `add:${cm.id}:${cm.id}`,
              action: 'add',
              commentId: cm.id,
              authorId: cm.authorId,
              authorName: cm.authorName,
              authorColor: cm.authorColor,
              text: cm.text,
              ts: cm.createdAt,
            });
          }
        } else {
          for (const r of cm.replies || []) {
            if (!prev.replies.has(r.id) && r.authorId !== myId) {
              handleRemoteCommentNotify({
                canvasId: cv.id,
                canvasTitle: cv.title,
                eventKey: `reply:${cm.id}:${r.id}`,
                action: 'reply',
                commentId: cm.id,
                authorId: r.authorId,
                authorName: r.authorName,
                authorColor: r.authorColor,
                text: r.text,
                ts: r.createdAt,
              });
            }
          }
        }
      }
    }

    if (activeEditCopy) {
      const idx = cv.shapes.findIndex((s) => s.id === activeEditCopy.id);
      if (idx >= 0) cv.shapes[idx] = { ...cv.shapes[idx], text: activeEditCopy.text, h: activeEditCopy.h };
      else cv.shapes.push(activeEditCopy);
    }

    await db.put('columns', cv);

    const cardMerge = collab.mergeCanvasCards(state.cards, snap.cards || [], cv.id, collabSession.tombstones);
    state.cards = cardMerge.cards;
    const toSave = [...cardMerge.added, ...cardMerge.updated];
    if (toSave.length) await db.putMany('cards', toSave);
    for (const rId of cardMerge.removedIds) {
      await db.del('cards', rId).catch(() => {});
    }

    recordCanvasBaseline(cv);

    // 检查是否有远端新增的文件卡片缺少本地二进制 Blob，优先消费预到达的缓冲分片，否则请求 P2P 分片传输
    for (const c of cardsIn(cv.id, false)) {
      if (c.kind === 'file') {
        const orphanMain = orphanCollabBlobs.get(`${c.id}:main`);
        if (orphanMain) {
          orphanCollabBlobs.delete(`${c.id}:main`);
          await db.addFile(c, orphanMain).catch(() => {});
          cleanupCanvasPdf(c.id);
        }
        const hasMain = orphanMain ? true : await db.getBlob(c.id).catch(() => null);
        if (!hasMain) {
          cardSyncProgress.set(c.id, 1);
          collabSession.requestBlob(c.id, 'main');
        }
        const orphanThumb = orphanCollabBlobs.get(`${c.id}:thumb`);
        if (orphanThumb) {
          orphanCollabBlobs.delete(`${c.id}:thumb`);
          await db.putThumb(c.id, orphanThumb).catch(() => {});
          c.thumb = 'ok';
          await db.put('cards', c).catch(() => {});
        } else if (c.thumb === 'ok') {
          const hasThumb = await db.getThumb(c.id).catch(() => null);
          if (!hasThumb) collabSession.requestBlob(c.id, 'thumb');
        }
      }
    }

    const switchedView = (wasJoining || createdNewCanvas || isWelcome) && state.view !== cv.id;
    if (switchedView) {
      setView(cv.id);
    }

    if (switchedView) {
      render();
      loadThumbs();
      if (isWelcome && (cv.shapes.length || cardsIn(cv.id, false).length)) {
        setTimeout(() => zoomFit(), 80);
      }
    } else if (state.view === cv.id) {
      $('#canvasTitle').textContent = cv.title;
      $('#canvasTitle').title = cv.title;
      renderCanvas();
      loadThumbs();
      if (isWelcome && wasEmpty && (cv.shapes.length || cardsIn(cv.id, false).length)) {
        setTimeout(() => zoomFit(), 80);
      }
    } else {
      render();
    }
    renderViews();
    renderCollabUI();
    renderCommentCenterUI();
    if (!$('#commentsPopover').hidden) renderCommentsPopover();
  } finally {
    suppressCollabDepth = Math.max(0, suppressCollabDepth - 1);
  }
}

async function flushDeferredCollab() {
  if (!deferredCollabPkts.length || bd?.moved || cardDrag?.moved) return;
  const list = deferredCollabPkts.splice(0, deferredCollabPkts.length);
  for (const item of list) {
    await enqueueCollabTask(() => applyRemoteSnapshot(item.pkt, item.isWelcome));
  }
}

async function handleCollabBlobProgress(res) {
  if (!res || !res.cardId) return;
  const card = findCard(res.cardId);
  if (!res.done) {
    if (res.kind === 'main') {
      cardSyncProgress.set(res.cardId, res.progress);
      updateCardSyncPill(res.cardId, res.progress);
    }
    return;
  }
  const blob = new Blob([res.bytes], { type: res.mime || card?.type || 'application/octet-stream' });
  if (res.kind === 'thumb') {
    await db.putThumb(res.cardId, blob);
    const oldT = state.urls.get(`thumb:${res.cardId}`);
    if (oldT) { URL.revokeObjectURL(oldT); state.urls.delete(`thumb:${res.cardId}`); }
    if (card) {
      card.thumb = 'ok';
      await db.put('cards', card);
      refreshCard(card);
    } else {
      if (orphanCollabBlobs.size > 50) orphanCollabBlobs.delete(orphanCollabBlobs.keys().next().value);
      orphanCollabBlobs.set(`${res.cardId}:thumb`, blob);
    }
    return;
  }
  cardSyncProgress.delete(res.cardId);
  updateCardSyncPill(res.cardId, null);
  if (!card) {
    if (orphanCollabBlobs.size > 50) orphanCollabBlobs.delete(orphanCollabBlobs.keys().next().value);
    orphanCollabBlobs.set(`${res.cardId}:main`, blob);
    return;
  }
  suppressCollabDepth++;
  try {
    await db.addFile(card, blob);
    const oldU = state.urls.get(card.id);
    if (oldU) { URL.revokeObjectURL(oldU); state.urls.delete(card.id); }
    cleanupCanvasPdf(card.id);
    if (!card.thumb) queueThumbs();
    refreshCard(card);
    loadCanvasMedia();
  } finally {
    suppressCollabDepth = Math.max(0, suppressCollabDepth - 1);
  }
}

function updateCardSyncPill(cardId, progress) {
  const el = $(`#world .card[data-id="${CSS.escape(cardId)}"]`);
  if (!el) return;
  let pill = el.querySelector('.card-sync-pill');
  if (progress == null) {
    pill?.remove();
    return;
  }
  if (!pill) {
    pill = document.createElement('span');
    pill.className = 'card-sync-pill';
    el.appendChild(pill);
  }
  pill.textContent = `同步文件中 ${progress}%…`;
}

function renderCollabOverlay() {
  const layer = $('#collabLayer');
  if (!layer) return;
  if (!collabSession || state.view !== collabSession.canvasId) {
    layer.innerHTML = '';
    return;
  }
  const peers = collabSession.getPeers();
  const now = Date.now();
  let html = '';

  for (const p of peers) {
    const color = p.color || '#2563eb';
    // 1. 远端选区 / 正在编辑高亮框
    const targets = new Set([...(p.selIds || []), ...(p.editingId ? [p.editingId] : [])]);
    for (const tid of targets) {
      const bx = boxOf({ id: tid });
      if (!bx) continue;
      const isEdit = p.editingId === tid;
      html += `<div class="remote-sel-box" style="left:${bx.x - 3}px;top:${bx.y - 3}px;width:${bx.w + 6}px;height:${bx.h + 6}px;--c:${esc(color)}">
        <span class="remote-sel-tag">${esc(p.name)}${isEdit ? ' · 正在编辑' : ''}</span>
      </div>`;
    }
    // 2. 远端实时光标
    if (typeof p.x === 'number' && typeof p.y === 'number') {
      const idle = now - (p.lastSeen || 0) > 7000;
      html += `<div class="remote-cursor${idle ? ' idle' : ''}" data-peer="${esc(p.id)}" style="--cx:${Math.round(p.x)}px;--cy:${Math.round(p.y)}px;--c:${esc(color)}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.2 3.2l15.6 7.4-6.8 2.1-3.1 6.7z"/></svg>
        <div class="rc-tag"><span>${esc(p.name)}</span>${p.action ? `<span class="rc-act">${esc(p.action)}</span>` : ''}</div>
      </div>`;
    }
  }
  layer.innerHTML = html;
  for (const [cid, prog] of cardSyncProgress) updateCardSyncPill(cid, prog);
}

function renderCollabUI() {
  const btn = $('#collabBtn'), txt = $('#collabBtnText'), avs = $('#collabAvatars'), fbar = $('#collabFollowBar');
  if (!btn || !txt || !avs) return;
  const active = collabSession && isCanvas(state.view) && state.view === collabSession.canvasId;
  if (!active) {
    btn.classList.remove('live');
    txt.innerHTML = '多人协作';
    avs.innerHTML = '';
    if (fbar) fbar.hidden = true;
    return;
  }
  const st = collabSession.getStatus();
  const peers = st.peers;
  btn.classList.add('live');
  txt.textContent = `协作中 · ${st.totalOnline}人`;

  const selfInit = collabInitial(st.self.name || '我');
  const avList = [
    `<button type="button" class="collab-av is-self" style="--c:${esc(st.self.color)}" title="${esc(st.self.name)}（我 · ${st.self.isHost ? '房主' : '协作者'}）" aria-label="${esc(st.self.name)}（我）">${esc(selfInit)}<span class="av-dot"></span></button>`,
    ...peers.slice(0, 4).map((p) => `<button type="button" class="collab-av${followPeerId === p.id ? ' is-following' : ''}" data-collab-locate="${esc(p.id)}" style="--c:${esc(p.color)}" title="${esc(p.name)}${p.action ? ` · ${esc(p.action)}` : ''}（点击定位视角 · 双击跟随）" aria-label="定位到 ${esc(p.name)}">${esc(collabInitial(p.name))}<span class="av-dot"></span></button>`),
  ];
  if (peers.length > 4) {
    avList.push(`<button type="button" class="collab-av" data-action="collab-panel" style="--c:var(--surface-3);color:var(--text)" title="还有 ${peers.length - 4} 位协作者">+${peers.length - 4}</button>`);
  }
  avs.innerHTML = avList.join('');

  if (fbar) {
    const fp = followPeerId && peers.find((p) => p.id === followPeerId);
    if (!fp) {
      followPeerId = null;
      fbar.hidden = true;
    } else {
      fbar.hidden = false;
      fbar.style.setProperty('--c', fp.color);
      fbar.innerHTML = `<span class="follow-dot"></span><span>正在跟随 <b>${esc(fp.name)}</b> 的视角</span><button type="button" data-collab-unfollow="1">退出跟随</button>`;
    }
  }
}

function buildCollabPeersListHTML(st) {
  const modeLabel = st.rtcStatus === 'connected' ? 'WebRTC 跨网直连 + 同机极速已就绪' : '同机多窗口极速直连（正在连接公网信令…）';
  return [
    `<li class="cp-peer">
      <span class="cp-peer-av" style="--c:${esc(st.self.color)}">${esc(collabInitial(st.self.name))}</span>
      <div class="cp-peer-info">
        <span class="cp-peer-name">${esc(st.self.name)} <span class="cp-peer-role">我 · ${st.self.isHost ? '房主' : '协作者'}</span></span>
        <span class="cp-peer-act">${esc(modeLabel)}</span>
      </div>
    </li>`,
    ...st.peers.map((p) => `<li class="cp-peer">
      <span class="cp-peer-av" style="--c:${esc(p.color)}">${esc(collabInitial(p.name))}</span>
      <div class="cp-peer-info">
        <span class="cp-peer-name">${esc(p.name)} <span class="cp-peer-role">${p.isHost ? '房主' : '协作者'}</span></span>
        <span class="cp-peer-act">${esc(p.action || '在线浏览中')}</span>
      </div>
      <div class="cp-peer-btns">
        <button type="button" class="cp-mini-btn" data-collab-locate="${esc(p.id)}" title="将画布视角定位到对方光标或选中对象">定位</button>
        <button type="button" class="cp-mini-btn${followPeerId === p.id ? ' on' : ''}" data-collab-follow="${esc(p.id)}" title="实时跟随对方画布视角">${followPeerId === p.id ? '跟随中' : '跟随'}</button>
      </div>
    </li>`),
  ].join('');
}

function renderCollabPopover() {
  const pop = $('#collabPopover');
  if (!pop || pop.hidden) return;
  const prof = getCollabProfile();
  const active = collabSession && isCanvas(state.view) && state.view === collabSession.canvasId;
  const st = active ? collabSession.getStatus() : null;

  // 若用户正在输入框内打字，仅局部更新状态与成员列表，不重建输入框 DOM（防止焦点丢失）
  const focusedInput = pop.contains(document.activeElement) && document.activeElement.matches?.('#cpNameInput');
  if (focusedInput && Boolean(pop.querySelector('.cp-room-box')) === Boolean(active)) {
    const av = $('#cpMyAv', pop);
    if (av) { av.style.setProperty('--c', prof.color); av.textContent = collabInitial(prof.name); }
    $$('.cp-swatch', pop).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.collabColor === prof.color)));
    if (active && st) {
      const badge = $('.cp-badge', pop);
      if (badge) badge.textContent = `● 在线 ${st.totalOnline} 人`;
      const peerCountLbl = $('.cp-peers-count', pop);
      if (peerCountLbl) peerCountLbl.textContent = `在线成员（${st.totalOnline}）`;
      const peersUl = $('.cp-peers', pop);
      if (peersUl) peersUl.innerHTML = buildCollabPeersListHTML(st);
    }
    return;
  }

  const swatchesHTML = `<div class="cp-color-row">
    <span class="cp-color-lbl">光标配色</span>
    <div class="cp-swatches" role="radiogroup" aria-label="光标与头像颜色">
      ${collab.COLLAB_COLORS.map((c) => `<button type="button" class="cp-swatch" data-collab-color="${c.hex}" style="--c:${c.hex}" aria-pressed="${prof.color === c.hex}" title="${c.name}" aria-label="${c.name}"></button>`).join('')}
    </div>
  </div>`;

  const profileSec = `<div class="cp-sec">
    <div class="cp-label"><span>我的协作身份</span></div>
    <div class="cp-profile-row">
      <div class="cp-my-av" id="cpMyAv" style="--c:${esc(prof.color)}">${esc(collabInitial(prof.name))}</div>
      <input type="text" class="cp-name-input" id="cpNameInput" value="${esc(prof.name)}" maxlength="20" placeholder="输入你的昵称…" aria-label="我的协作昵称">
    </div>
    ${swatchesHTML}
  </div>`;

  if (!active) {
    pop.innerHTML = `<div class="cp-head">
        <h3>多人实时协作</h3>
        <span class="cp-badge idle">未开启</span>
      </div>
      ${profileSec}
      <div class="cp-sec">
        <p class="cp-room-sub">无需房间号或配置服务器：点击下方按钮开启后，直接复制当前网址发给同伴，对方打开网页即可看到你的画布并实时一起编辑。</p>
        <button type="button" class="btn primary cp-start-btn" data-collab-act="start">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>
          <span>开启多人协作并复制网址</span>
        </button>
      </div>`;
    return;
  }

  const peersHTML = buildCollabPeersListHTML(st);

  pop.innerHTML = `<div class="cp-head">
      <h3>多人实时协作</h3>
      <span class="cp-badge">● 在线 ${st.totalOnline} 人</span>
    </div>
    <div class="cp-room-box">
      <p class="cp-room-sub">协作已开启 · 直接复制浏览器网址或点击下方按钮分享给同伴，对方打开网页即可实时同步当前画布内容与光标。</p>
      <div class="cp-room-actions">
        <button type="button" class="btn primary" data-collab-act="copy-link">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>
          <span>复制协作网址</span>
        </button>
      </div>
    </div>
    ${profileSec}
    <div class="cp-sec">
      <div class="cp-label"><span class="cp-peers-count">在线成员（${st.totalOnline}）</span><span>点击定位或跟随视角</span></div>
      <ul class="cp-peers">${peersHTML}</ul>
    </div>
    <div class="cp-foot">
      <button type="button" class="btn danger-ghost" data-collab-act="leave">结束多人协作</button>
    </div>`;
}

function toggleCollabPopover(force) {
  const pop = $('#collabPopover'), btn = $('#collabBtn');
  if (!pop || !btn) return;
  const open = typeof force === 'boolean' ? force : pop.hidden;
  if (open) toggleCommentsPopover(false);
  pop.hidden = !open;
  btn.setAttribute('aria-expanded', String(open));
  if (open) renderCollabPopover();
}

function setRoomUrlParam(roomId) {
  try {
    const u = new URL(location.href);
    if (roomId) u.searchParams.set('room', roomId);
    else u.searchParams.delete('room');
    history.replaceState(null, '', u.pathname + (u.searchParams.toString() ? `?${u.searchParams}` : '') + u.hash);
  } catch {}
}

function getInviteUrl(roomId) {
  try {
    const u = new URL(location.href);
    u.searchParams.set('room', roomId);
    return u.href;
  } catch {
    return `${location.origin}${location.pathname}?room=${roomId}`;
  }
}

async function copyTextWithToast(text, msg) {
  try {
    await navigator.clipboard.writeText(text);
    toast(msg);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    toast(msg);
  }
}

async function startCollabRoom(customRoomId = '', { autoCopy = true, quiet = false, isJoining = false } = {}) {
  let cvId = isCanvas(state.view) ? state.view : canvases()[0]?.id;
  if (!cvId) {
    const a = { id: uid(), kind: 'canvas', title: '协作画布', order: 0, shapes: [], links: [] };
    await saveArea(a);
    state.areas.push(a);
    cvId = a.id;
  }
  if (state.view !== cvId) {
    setView(cvId);
    render();
  }
  const roomId = collab.normalizeRoomId(customRoomId) || collab.generateRoomId();
  if (collabSession) {
    collabSession.stop();
    collabSession = null;
  }
  followPeerId = null;
  recordCanvasBaseline(area(cvId));
  const prof = getCollabProfile();
  if (!isJoining) {
    try { sessionStorage.setItem('wb:collabHostRoom', roomId); } catch {}
  }

  collabSession = new collab.CollabSession({
    roomId,
    canvasId: cvId,
    joining: isJoining,
    user: prof,
    getSnapshot: () => (collabSession?.joining ? null : buildCanvasSnapshot(collabSession?.canvasId || cvId)),
    getBlobById: async (cardId, kind) => (kind === 'thumb' ? db.getThumb(cardId) : db.getBlob(cardId)),
    onEvent: (type, detail) => {
      if (type === 'status' || type === 'peers') {
        renderCollabUI();
        if (!$('#collabPopover').hidden) renderCollabPopover();
        renderCollabOverlay();
      } else if (type === 'cursor') {
        renderCollabOverlay();
        if (followPeerId && detail.peer?.id === followPeerId) {
          followPeerViewport(detail.peer);
        }
        if (!$('#collabPopover').hidden) {
          const actEl = $(`#collabPopover [data-collab-locate="${CSS.escape(detail.peer?.id || '')}"]`)?.closest('.cp-peer')?.querySelector('.cp-peer-act');
          if (actEl) actEl.textContent = detail.peer.action || '在线浏览中';
        }
      } else if (type === 'welcome') {
        enqueueCollabTask(() => applyRemoteSnapshot(detail, true));
      } else if (type === 'board-sync' || type === 'cards-sync') {
        enqueueCollabTask(() => applyRemoteSnapshot(detail, false));
      } else if (type === 'shape-live') {
        applyRemoteShapeLive(detail);
      } else if (type === 'card-live') {
        applyRemoteCardLive(detail);
      } else if (type === 'comment-notify') {
        enqueueCollabTask(() => handleRemoteCommentNotify(detail));
      } else if (type === 'blob-progress') {
        if (detail?.done) enqueueCollabTask(() => handleCollabBlobProgress(detail));
        else handleCollabBlobProgress(detail);
      }
    },
  });

  await collabSession.start();
  setRoomUrlParam(collabSession.roomId);
  renderCollabUI();
  if (!$('#collabPopover').hidden) renderCollabPopover();
  renderCollabOverlay();

  if (autoCopy) {
    await copyTextWithToast(getInviteUrl(collabSession.roomId), '已开启多人协作并复制网址，发给同伴打开即可一起编辑');
  } else if (!quiet) {
    toast('已加入多人实时协作');
  }
}

function leaveCollabRoom() {
  if (!collabSession) return;
  try { sessionStorage.removeItem('wb:collabHostRoom'); } catch {}
  collabSession.stop();
  collabSession = null;
  followPeerId = null;
  cardSyncProgress.clear();
  orphanCollabBlobs.clear();
  deferredCollabPkts.length = 0;
  setRoomUrlParam('');
  renderCollabUI();
  renderCollabPopover();
  renderCollabOverlay();
  renderCommentCenterUI();
  if (state.view === CANVASES) renderCanvasDirectory();
  toast('已结束多人协作');
}

function locateCollabPeer(peerId) {
  if (!collabSession) return;
  const p = collabSession.getPeers().find((x) => x.id === peerId);
  if (!p) return;
  const targetId = p.editingId || p.selIds?.[0];
  if (targetId) {
    const bx = boxOf({ id: targetId });
    if (bx) {
      zoomToBox({ x: bx.x - 80, y: bx.y - 80, w: Math.max(240, bx.w + 160), h: Math.max(180, bx.h + 160) }, 1.25);
      return;
    }
  }
  if (typeof p.x === 'number' && typeof p.y === 'number') {
    const r = $('#viewport').getBoundingClientRect();
    const z = Math.max(0.6, Math.min(1.2, cam().z));
    tweenCam({ z, x: r.width / 2 - p.x * z, y: r.height / 2 - p.y * z });
  } else if (p.cam) {
    const r = $('#viewport').getBoundingClientRect();
    const z = p.cam.z || 1;
    tweenCam({ z, x: r.width / 2 - p.cam.cx * z, y: r.height / 2 - p.cam.cy * z });
  }
}

function followPeerViewport(p) {
  if (!p || pan || bd?.moved || cardDrag?.moved) return;
  const r = $('#viewport')?.getBoundingClientRect();
  if (!r?.width) return;
  if (p.cam && typeof p.cam.cx === 'number') {
    const z = p.cam.z || cam().z;
    tweenCam({ z, x: r.width / 2 - p.cam.cx * z, y: r.height / 2 - p.cam.cy * z });
  } else if (typeof p.x === 'number' && typeof p.y === 'number') {
    const z = cam().z;
    tweenCam({ z, x: r.width / 2 - p.x * z, y: r.height / 2 - p.y * z });
  }
}

function toggleFollowPeer(peerId) {
  if (followPeerId === peerId) {
    followPeerId = null;
  } else {
    followPeerId = peerId;
    locateCollabPeer(peerId);
  }
  renderCollabUI();
  if (!$('#collabPopover').hidden) renderCollabPopover();
}

// 协作面板与头像交互事件
$('#canvasWorkspace').addEventListener('click', async (e) => {
  const unfollow = e.target.closest('[data-collab-unfollow]');
  if (unfollow) {
    followPeerId = null;
    renderCollabUI();
    if (!$('#collabPopover').hidden) renderCollabPopover();
    return;
  }
  const loc = e.target.closest('[data-collab-locate]');
  if (loc) {
    locateCollabPeer(loc.dataset.collabLocate);
    return;
  }
  const fol = e.target.closest('[data-collab-follow]');
  if (fol) {
    toggleFollowPeer(fol.dataset.collabFollow);
    return;
  }
  const sw = e.target.closest('[data-collab-color]');
  if (sw) {
    saveCollabProfile({ color: sw.dataset.collabColor });
    return;
  }
  const actBtn = e.target.closest('[data-collab-act]');
  if (!actBtn) return;
  const act = actBtn.dataset.collabAct;
  if (act === 'start') {
    await startCollabRoom('', { autoCopy: true, isJoining: false });
  } else if (act === 'copy-link' && collabSession) {
    await copyTextWithToast(getInviteUrl(collabSession.roomId), '✓ 协作网址已复制，发给同伴打开即可进入画布');
  } else if (act === 'leave') {
    leaveCollabRoom();
  }
});

$('#canvasWorkspace').addEventListener('dblclick', (e) => {
  const av = e.target.closest('.collab-av[data-collab-locate]');
  if (av) {
    e.stopPropagation();
    toggleFollowPeer(av.dataset.collabLocate);
  }
});

$('#collabPopover').addEventListener('input', (e) => {
  if (e.target.id === 'cpNameInput') {
    const name = e.target.value.trim() || getCollabProfile().name;
    const cur = getCollabProfile();
    tabCollabProfile = { ...cur, name, id: TAB_PEER_ID };
    ls.set('collabProfile', { name: tabCollabProfile.name, color: tabCollabProfile.color });
    const av = $('#cpMyAv');
    if (av) av.textContent = collabInitial(name);
    if (collabSession) collabSession.updateSelf({ name });
    renderCollabUI();
  }
});

window.addEventListener('pagehide', () => collabSession?.stop());

$('#collabPopover').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.stopPropagation();
    toggleCollabPopover(false);
  }
});

document.addEventListener('pointerdown', (e) => {
  const pop = $('#collabPopover');
  if (pop && !pop.hidden && !e.target.closest('#collabPopover, #collabBtn, .collab-av[data-action="collab-panel"]')) {
    toggleCollabPopover(false);
  }
  const cmPop = $('#commentsPopover');
  if (cmPop && !cmPop.hidden && !e.target.closest('#commentsPopover, #commentCenterBtn')) {
    toggleCommentsPopover(false);
  }
  const thPop = $('#commentThreadPop');
  if (thPop && !thPop.hidden && e.button === 0 && !e.target.closest('#commentThreadPop, .comment-pin, #commentCenterBtn, #commentsPopover')) {
    if (!(e.target.closest('#viewport') && state.tool === 'comment')) {
      closeCommentPop();
    }
  }
  // 用户主动中键平移或滚轮时自动退出视角跟随，避免抢镜头
  if (followPeerId && e.target.closest('#viewport') && (e.button === 1 || spaceDown)) {
    followPeerId = null;
    renderCollabUI();
  }
});

vp.addEventListener('wheel', () => {
  if (followPeerId) {
    followPeerId = null;
    renderCollabUI();
  }
}, { passive: true });

// ---------- 画布备注评论与协作者实时提醒 ----------
let openCommentId = null; // 'draft' | comment.id
let draftComment = null;
let commentsFilter = 'open'; // 'open' | 'resolved' | 'all'
const unreadCommentIds = new Set();
const notifiedCommentEvents = new Set();
let commentAudioCtx = null;

function commentById(id, canvasId = state.view) {
  return (boardOf(canvasId)?.comments || []).find((cm) => cm.id === id) || null;
}

function unreadCommentCountAll() {
  if (!unreadCommentIds.size) return 0;
  let n = 0;
  for (const cv of canvases()) {
    for (const cm of cv.comments || []) {
      if (unreadCommentIds.has(cm.id)) n++;
    }
  }
  return n;
}

function unreadCommentCountIn(canvasId = state.view) {
  if (!unreadCommentIds.size) return 0;
  let n = 0;
  for (const cm of boardOf(canvasId)?.comments || []) {
    if (unreadCommentIds.has(cm.id)) n++;
  }
  return n;
}

function commentPos(cm) {
  if (!cm) return { x: 0, y: 0 };
  if (cm.targetId) {
    const bx = boxOf({ id: cm.targetId });
    if (bx) {
      const x = Math.round(bx.x + (cm.dx ?? 0));
      const y = Math.round(bx.y + (cm.dy ?? 0));
      cm.x = x;
      cm.y = y;
      return { x, y };
    }
  }
  return { x: Math.round(cm.x || 0), y: Math.round(cm.y || 0) };
}

function targetLabelOf(targetId) {
  if (!targetId) return '';
  const sh = shapeById(targetId);
  if (sh) {
    const label = sh.text?.trim() ? `「${sh.text.trim().slice(0, 14)}」` : '';
    return `📌 ${SHAPE_NAMES[sh.t] || '形状'}${label}`;
  }
  const cd = findCard(targetId);
  if (cd) return `📌 卡片「${(cd.name || '便签').slice(0, 14)}」`;
  return '';
}

function playCommentPing() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!commentAudioCtx) commentAudioCtx = new AC();
    if (commentAudioCtx.state === 'suspended') {
      commentAudioCtx.resume().catch(() => {});
    }
    if (commentAudioCtx.state !== 'running') return;
    const now = commentAudioCtx.currentTime;
    const note = (freq, start, dur) => {
      const osc = commentAudioCtx.createOscillator();
      const gain = commentAudioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + start);
      gain.gain.setValueAtTime(0.0001, now + start);
      gain.gain.linearRampToValueAtTime(0.045, now + start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + start + dur);
      osc.connect(gain);
      gain.connect(commentAudioCtx.destination);
      osc.start(now + start);
      osc.stop(now + start + dur + 0.02);
    };
    note(880, 0, 0.14);
    note(1174.66, 0.09, 0.18);
  } catch {}
}

function commentPinHTML(cm, isDraft = false) {
  const pos = commentPos(cm);
  const init = isDraft ? '+' : (cm.resolved ? '✓' : collabInitial(cm.authorName || '我'));
  const isUnread = !isDraft && unreadCommentIds.has(cm.id);
  const isActive = isDraft ? openCommentId === 'draft' : openCommentId === cm.id;
  const replyCnt = !isDraft ? (cm.replies || []).length : 0;
  const preview = isDraft ? '' : `<div class="pin-preview"><b>${esc(cm.authorName || '成员')}</b><span>${esc(cm.text || '')}</span></div>`;
  const cls = `comment-pin${isDraft ? ' is-draft' : ''}${cm.resolved ? ' is-resolved' : ''}${isUnread ? ' is-unread' : ''}${isActive ? ' is-active' : ''}`;
  const aria = isDraft ? '正在添加新备注' : `${cm.authorName || '成员'} 的备注：${cm.text || ''}`;
  return `<button type="button" class="${cls}" data-cid="${isDraft ? 'draft' : esc(cm.id)}" style="--cx:${pos.x}px;--cy:${pos.y}px;--c:${esc(cm.authorColor || '#2563eb')}" aria-label="${esc(aria)}">
    <span class="pin-init">${esc(init)}</span>
    ${replyCnt ? `<span class="pin-cnt">${replyCnt}</span>` : ''}
    ${preview}
  </button>`;
}

function renderCommentsLayer() {
  const layer = $('#commentLayer');
  if (!layer) return;
  const b = boardOf();
  if (!b) {
    layer.innerHTML = '';
    return;
  }
  const items = (b.comments || []).map((cm) => commentPinHTML(cm, false));
  if (openCommentId === 'draft' && draftComment) {
    items.push(commentPinHTML(draftComment, true));
  }
  layer.innerHTML = items.join('');
}

function syncCommentPinPositions() {
  const layer = $('#commentLayer');
  if (!layer) return;
  const b = boardOf();
  if (!b) return;
  for (const cm of b.comments || []) {
    if (bd?.mode === 'comment-drag' && bd.cm?.id === cm.id) continue;
    const pos = commentPos(cm);
    const el = layer.querySelector(`.comment-pin[data-cid="${CSS.escape(cm.id)}"]`);
    if (el) {
      el.style.setProperty('--cx', `${pos.x}px`);
      el.style.setProperty('--cy', `${pos.y}px`);
    }
  }
  if (openCommentId) positionCommentPop();
}

function positionCommentPop() {
  const pop = $('#commentThreadPop');
  if (!pop || pop.hidden || !openCommentId) return;
  let pos = null;
  if (openCommentId === 'draft' && draftComment) {
    pos = commentPos(draftComment);
  } else {
    const cm = commentById(openCommentId);
    if (!cm) { pop.hidden = true; return; }
    pos = (bd?.mode === 'comment-drag' && bd.cm?.id === cm.id && bd.cur) ? bd.cur : commentPos(cm);
  }
  const vr = $('#viewport')?.getBoundingClientRect();
  const cv = $('#canvasView')?.getBoundingClientRect();
  if (!vr || !cv || !cv.width) return;
  const c = cam();
  const tipX = vr.left - cv.left + c.x + pos.x * c.z;
  const tipY = vr.top - cv.top + c.y + pos.y * c.z;
  const pw = pop.offsetWidth || 328;
  const ph = pop.offsetHeight || 220;
  const minLeft = cv.width > 500 ? 64 : 12;
  const maxRight = cv.width - 12;

  let left, top;
  if (tipX + 44 + pw <= maxRight) {
    left = tipX + 44;
    top = tipY - 46;
  } else if (tipX - pw - 14 >= minLeft) {
    left = tipX - pw - 14;
    top = tipY - 46;
  } else {
    left = Math.max(minLeft, Math.min(maxRight - pw, tipX - pw / 2));
    const roomBelow = cv.height - (tipY + 14) - 14;
    const roomAbove = (tipY - 46) - 14;
    top = roomBelow >= ph || roomBelow >= roomAbove ? tipY + 14 : tipY - ph - 46;
  }
  const minTop = left < 360 ? 58 : 14;
  top = Math.max(minTop, Math.min(cv.height - ph - 14, top));
  pop.style.left = `${Math.round(left)}px`;
  pop.style.top = `${Math.round(top)}px`;
}

function closeCommentPop() {
  const hadDraft = openCommentId === 'draft';
  openCommentId = null;
  draftComment = null;
  const pop = $('#commentThreadPop');
  if (pop) {
    pop.hidden = true;
    pop.removeAttribute('data-cid');
  }
  if (hadDraft) renderCommentsLayer();
  else $$('#commentLayer .comment-pin.is-active').forEach((el) => el.classList.remove('is-active'));
}

function openCommentDraftAt(wx, wy, targetId = null) {
  const prof = getCollabProfile();
  const bx = targetId ? boxOf({ id: targetId }) : null;
  draftComment = {
    id: 'draft',
    x: Math.round(wx),
    y: Math.round(wy),
    ...(targetId && bx ? { targetId, dx: Math.round(wx - bx.x), dy: Math.round(wy - bx.y) } : {}),
    authorId: prof.id,
    authorName: prof.name,
    authorColor: prof.color,
  };
  openCommentId = 'draft';
  toggleCommentsPopover(false);
  toggleCollabPopover(false);
  renderCommentsLayer();
  renderCommentThreadPop();
  setTimeout(() => $('#commentThreadPop textarea')?.focus(), 20);
}

function openCommentDraftOnTarget(targetId) {
  const bx = boxOf({ id: targetId });
  if (!bx) return;
  openCommentDraftAt(bx.x + Math.max(20, bx.w - 18), bx.y + 18, targetId);
}

function openCommentThread(cid) {
  const cm = commentById(cid);
  if (!cm) return;
  draftComment = null;
  openCommentId = cm.id;
  if (unreadCommentIds.delete(cm.id)) {
    renderCommentCenterUI();
    renderViews();
    if (!$('#commentsPopover').hidden) renderCommentsPopover();
  }
  renderCommentsLayer();
  renderCommentThreadPop();
  setTimeout(() => $('#commentThreadPop textarea')?.focus({ preventScroll: true }), 20);
}

function buildRepliesHTML(cm) {
  if (!cm?.replies?.length) return '';
  return cm.replies.map((r) => `<div class="ct-reply" data-rid="${esc(r.id)}">
    <span class="ct-reply-av" style="--c:${esc(r.authorColor || '#2563eb')}">${esc(collabInitial(r.authorName))}</span>
    <div class="ct-reply-body">
      <div class="ct-reply-top"><b>${esc(r.authorName || '协作者')}</b><time>${esc(ago(r.createdAt || Date.now()))}</time></div>
      <div class="ct-reply-text">${esc(r.text || '')}</div>
    </div>
  </div>`).join('');
}

function renderCommentThreadPop() {
  const pop = $('#commentThreadPop');
  if (!pop) return;
  if (!openCommentId || !isCanvas(state.view)) {
    pop.hidden = true;
    return;
  }

  const typingInPop = !pop.hidden && pop.contains(document.activeElement) && document.activeElement.tagName === 'TEXTAREA';

  if (openCommentId === 'draft') {
    if (!draftComment) { pop.hidden = true; return; }
    if (typingInPop && pop.dataset.cid === 'draft') {
      positionCommentPop();
      return;
    }
    const prof = getCollabProfile();
    const tLabel = targetLabelOf(draftComment.targetId);
    pop.dataset.cid = 'draft';
    pop.innerHTML = `<div class="ct-head">
        <span class="ct-av" style="--c:${esc(prof.color)}">${esc(collabInitial(prof.name))}</span>
        <div class="ct-author-info"><b>${esc(prof.name)}</b><time>新备注</time></div>
        <button type="button" class="icon-btn ct-icon-btn" data-cm-act="close" aria-label="关闭"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
      </div>
      ${tLabel ? `<div class="ct-target">${esc(tLabel)}</div>` : ''}
      <form class="ct-compose" data-cm-form="draft">
        <textarea name="text" placeholder="写下备注内容…（发送后会即时提醒其他在线协作者）" maxlength="600"></textarea>
        <div class="ct-actions">
          <span class="ct-hint">Enter 发送 · Shift+Enter 换行</span>
          <button type="button" class="btn ghost" data-cm-act="close">取消</button>
          <button type="submit" class="btn primary">发送备注</button>
        </div>
      </form>`;
    pop.hidden = false;
    positionCommentPop();
    return;
  }

  const cm = commentById(openCommentId);
  if (!cm) {
    pop.hidden = true;
    openCommentId = null;
    return;
  }

  // 若用户正在输入框内回复，仅原地刷新状态与回复列表，避免打断输入与丢失焦点
  if (typingInPop && pop.dataset.cid === cm.id) {
    const resBtn = pop.querySelector('[data-cm-act="resolve"]');
    if (resBtn) {
      resBtn.className = `ct-resolve-btn${cm.resolved ? ' done' : ''}`;
      resBtn.textContent = cm.resolved ? '✓ 已解决' : '✓ 标记解决';
    }
    let repliesEl = pop.querySelector('.ct-replies');
    if (cm.replies?.length) {
      if (!repliesEl) {
        repliesEl = document.createElement('div');
        repliesEl.className = 'ct-replies';
        pop.querySelector('.ct-main-body')?.after(repliesEl);
      }
      const prevLen = repliesEl.children.length;
      repliesEl.innerHTML = buildRepliesHTML(cm);
      if (cm.replies.length > prevLen) repliesEl.scrollTop = repliesEl.scrollHeight;
    } else if (repliesEl) {
      repliesEl.remove();
    }
    positionCommentPop();
    return;
  }

  const tLabel = targetLabelOf(cm.targetId);
  pop.dataset.cid = cm.id;
  pop.innerHTML = `<div class="ct-head">
      <span class="ct-av" style="--c:${esc(cm.authorColor || '#2563eb')}">${esc(collabInitial(cm.authorName))}</span>
      <div class="ct-author-info"><b>${esc(cm.authorName || '协作者')}</b><time>${esc(fmtDate(cm.createdAt || Date.now()))}</time></div>
      <button type="button" class="ct-resolve-btn${cm.resolved ? ' done' : ''}" data-cm-act="resolve" title="${cm.resolved ? '重新打开此备注' : '标记为已解决'}">${cm.resolved ? '✓ 已解决' : '✓ 标记解决'}</button>
      <button type="button" class="icon-btn ct-icon-btn danger" data-cm-act="delete" aria-label="删除备注" title="删除此备注"><svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-7 0 1 12a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1l1-12"/></svg></button>
      <button type="button" class="icon-btn ct-icon-btn" data-cm-act="close" aria-label="关闭"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
    </div>
    ${tLabel ? `<div class="ct-target">${esc(tLabel)}</div>` : ''}
    <div class="ct-main-body">${esc(cm.text || '')}</div>
    ${cm.replies?.length ? `<div class="ct-replies">${buildRepliesHTML(cm)}</div>` : ''}
    <form class="ct-compose" data-cm-form="reply">
      <textarea name="text" placeholder="添加回复…" maxlength="600"></textarea>
      <div class="ct-actions">
        <span class="ct-hint">Enter 发送</span>
        <button type="submit" class="btn primary">回复</button>
      </div>
    </form>`;
  pop.hidden = false;
  const repliesEl = pop.querySelector('.ct-replies');
  if (repliesEl) repliesEl.scrollTop = repliesEl.scrollHeight;
  positionCommentPop();
}

function renderCommentCenterUI() {
  const btn = $('#commentCenterBtn');
  const cntPill = $('#commentCountPill');
  const unreadBadge = $('#commentUnreadBadge');
  if (!btn || !cntPill || !unreadBadge) return;
  const b = boardOf();
  if (!b) {
    cntPill.hidden = true;
    unreadBadge.hidden = true;
    btn.classList.remove('has-unread');
    return;
  }
  const openCnt = (b.comments || []).filter((cm) => !cm.resolved).length;
  const unreadCnt = unreadCommentCountIn(b.id);
  cntPill.textContent = String(openCnt);
  cntPill.hidden = openCnt === 0 || unreadCnt > 0;
  unreadBadge.textContent = unreadCnt > 99 ? '99+' : String(unreadCnt);
  unreadBadge.hidden = unreadCnt === 0;
  btn.classList.toggle('has-unread', unreadCnt > 0);
}

function toggleCommentsPopover(force) {
  const pop = $('#commentsPopover'), btn = $('#commentCenterBtn');
  if (!pop || !btn) return;
  const open = typeof force === 'boolean' ? force : pop.hidden;
  if (open) toggleCollabPopover(false);
  pop.hidden = !open;
  btn.setAttribute('aria-expanded', String(open));
  if (open) {
    const ws = $('#canvasWorkspace');
    if (ws && !document.body.classList.contains('canvas-maximized') && innerWidth > 720) {
      const wr = ws.getBoundingClientRect(), br = btn.getBoundingClientRect();
      const left = Math.max(16, Math.min(br.left - wr.left, wr.width - 384));
      pop.style.left = `${Math.round(left)}px`;
    } else {
      pop.style.left = '';
    }
    renderCommentsPopover();
  }
}

function renderCommentsPopover() {
  const pop = $('#commentsPopover');
  if (!pop || pop.hidden) return;
  const b = boardOf();
  const all = [...(b?.comments || [])].sort((a, b) => (b._u || b.createdAt || 0) - (a._u || a.createdAt || 0));
  const openList = all.filter((c) => !c.resolved);
  const resList = all.filter((c) => c.resolved);
  const unreadHere = unreadCommentCountIn(b?.id);
  const list = commentsFilter === 'open' ? openList : commentsFilter === 'resolved' ? resList : all;

  const listHTML = list.length
    ? list.map((cm) => {
      const isUnread = unreadCommentIds.has(cm.id);
      const tLabel = targetLabelOf(cm.targetId);
      const replyCnt = (cm.replies || []).length;
      const lastReply = replyCnt ? cm.replies[replyCnt - 1] : null;
      return `<button type="button" class="cmp-item${isUnread ? ' is-unread' : ''}${cm.resolved ? ' is-resolved' : ''}" data-cm-jump="${esc(cm.id)}">
        <span class="cmp-item-av" style="--c:${esc(cm.authorColor || '#2563eb')}">${esc(collabInitial(cm.authorName))}</span>
        <span class="cmp-item-body">
          <span class="cmp-item-top"><b>${esc(cm.authorName || '协作者')}</b><time>${esc(ago(cm._u || cm.createdAt || Date.now()))}</time></span>
          <span class="cmp-item-text">${esc(cm.text || '')}</span>
          <span class="cmp-item-meta">
            ${cm.resolved ? '<span class="cmp-tag resolved">✓ 已解决</span>' : ''}
            ${tLabel ? `<span class="cmp-tag">${esc(tLabel)}</span>` : ''}
            ${replyCnt ? `<span>${replyCnt} 条回复${lastReply ? ` · ${esc(lastReply.authorName)}` : ''}</span>` : '<span>点击定位并回复</span>'}
          </span>
        </span>
        ${isUnread ? '<span class="cmp-unread-dot" aria-label="未读"></span>' : ''}
      </button>`;
    }).join('')
    : `<div class="cmp-empty">${commentsFilter === 'resolved' ? '暂无已解决的备注' : '当前画布还没有备注。<br>点击右侧「+ 添加备注」或按 <kbd>C</kbd> 键即可随时批注并提醒团队成员。'}</div>`;

  pop.innerHTML = `<div class="cmp-head">
      <h3>画布备注${all.length ? ` (${all.length})` : ''}</h3>
      ${unreadHere ? '<button type="button" class="cmp-mark-read" data-cmp-act="mark-all-read">全部已读</button>' : ''}
      <button type="button" class="btn primary cmp-add-btn" data-cmp-act="add-tool">+ 添加备注</button>
    </div>
    <div class="cmp-filters" role="group" aria-label="筛选备注状态">
      <button type="button" class="cmp-filter" data-cmp-filter="open" aria-pressed="${commentsFilter === 'open'}">待处理<b>${openList.length}</b></button>
      <button type="button" class="cmp-filter" data-cmp-filter="resolved" aria-pressed="${commentsFilter === 'resolved'}">已解决<b>${resList.length}</b></button>
      <button type="button" class="cmp-filter" data-cmp-filter="all" aria-pressed="${commentsFilter === 'all'}">全部<b>${all.length}</b></button>
    </div>
    <div class="cmp-list">${listHTML}</div>`;
}

function notifyCollabComment(action, cm, itemId, text, ts) {
  if (!collabSession || collabSession.joining || isCollabSuppressed()) return;
  const prof = getCollabProfile();
  collabSession.send('comment-notify', {
    canvasId: collabSession.canvasId,
    canvasTitle: area(collabSession.canvasId)?.title || '协作画布',
    eventKey: `${action}:${cm.id}:${itemId}`,
    action,
    commentId: cm.id,
    comment: collab.clonePlain(cm),
    authorId: prof.id,
    authorName: prof.name,
    authorColor: prof.color,
    text: String(text || '').slice(0, 140),
    ts: ts || Date.now(),
  });
}

async function handleRemoteCommentNotify(pkt) {
  if (!pkt?.commentId) return;
  const myId = getCollabProfile().id;
  if (pkt.authorId === myId) return;

  const key = pkt.eventKey || `${pkt.action}:${pkt.commentId}:${pkt.ts || ''}`;
  if (notifiedCommentEvents.has(key)) return;
  notifiedCommentEvents.add(key);
  if (notifiedCommentEvents.size > 500) {
    notifiedCommentEvents.delete(notifiedCommentEvents.values().next().value);
  }

  // 若 comment-notify 先于 board-sync 到达，立即将评论合并进本地画布，消除点击「查看」的竞态窗口
  const cv = pkt.canvasId ? area(pkt.canvasId) : null;
  if (cv && cv.kind === 'canvas' && pkt.comment) {
    suppressCollabDepth++;
    try {
      cv.comments = collab.mergeComments(cv.comments || [], [pkt.comment], collabSession?.tombstones || {});
      await db.put('columns', cv).catch(() => {});
      recordCanvasBaseline(cv);
      if (state.view === cv.id) {
        $('#canvasEmpty').hidden = cardsIn(cv.id, false).length > 0 || (cv.shapes?.length || 0) > 0 || (cv.comments?.length || 0) > 0;
        renderCommentsLayer();
        renderCommentThreadPop();
      }
    } finally {
      suppressCollabDepth = Math.max(0, suppressCollabDepth - 1);
    }
  }

  const viewingThread = isCanvas(state.view) && state.view === pkt.canvasId && openCommentId === pkt.commentId;
  if ((pkt.action === 'add' || pkt.action === 'reply') && !viewingThread) {
    unreadCommentIds.add(pkt.commentId);
  }

  renderCommentCenterUI();
  renderCommentsLayer();
  renderViews();
  if (!$('#commentsPopover').hidden) renderCommentsPopover();

  playCommentPing();
  const rawSnip = String(pkt.text || '').replace(/\s+/g, ' ').trim();
  const snip = rawSnip.length > 26 ? `${rawSnip.slice(0, 26)}…` : rawSnip;
  const who = pkt.authorName || '同伴';
  const msg = pkt.action === 'reply'
    ? `💬 ${who} 回复了备注${snip ? `：「${snip}」` : ''}`
    : pkt.action === 'resolve'
      ? `✓ ${who} 已解决备注${snip ? `：「${snip}」` : ''}`
      : `💬 ${who} 添加了备注${snip ? `：「${snip}」` : ''}`;

  toast(msg, {
    commentAlert: true,
    color: pkt.authorColor || '#2563eb',
    duration: 8000,
    action: '查看',
    onAction: () => focusComment(pkt.commentId, pkt.canvasId),
  });
}

function focusComment(cid, canvasId) {
  toggleCommentsPopover(false);
  if (canvasId && state.view !== canvasId && area(canvasId)?.kind === 'canvas') {
    setView(canvasId);
    render();
  }
  const cm = commentById(cid, canvasId || state.view);
  if (!cm) {
    toast('该备注已被删除');
    return;
  }
  const pos = commentPos(cm);
  const r = $('#viewport')?.getBoundingClientRect();
  if (r?.width) {
    const z = Math.max(0.75, Math.min(1.35, cam().z));
    tweenCam({ z, x: r.width / 2 - pos.x * z, y: r.height / 2 - pos.y * z });
  }
  openCommentThread(cm.id);
}

async function submitDraftComment(rawText) {
  const text = String(rawText || '').trim();
  if (!text || !draftComment) return;
  const b = boardOf();
  if (!b) return;
  record();
  const prof = getCollabProfile();
  const now = Date.now();
  const pos = commentPos(draftComment);
  const cm = {
    id: uid(),
    x: pos.x,
    y: pos.y,
    ...(draftComment.targetId ? { targetId: draftComment.targetId, dx: Math.round(draftComment.dx || 0), dy: Math.round(draftComment.dy || 0) } : {}),
    authorId: prof.id,
    authorName: prof.name,
    authorColor: prof.color,
    text,
    createdAt: now,
    resolved: false,
    replies: [],
    _u: now,
  };
  b.comments ||= [];
  b.comments.push(cm);
  draftComment = null;
  openCommentId = cm.id;
  afterCreateTool();
  await saveBoard();
  notifyCollabComment('add', cm, cm.id, text, now);
}

async function submitCommentReply(cid, rawText) {
  const text = String(rawText || '').trim();
  const cm = commentById(cid);
  if (!text || !cm) return;
  record();
  const prof = getCollabProfile();
  const now = Date.now();
  const reply = {
    id: uid(),
    authorId: prof.id,
    authorName: prof.name,
    authorColor: prof.color,
    text,
    createdAt: now,
    _u: now,
  };
  cm.replies ||= [];
  cm.replies.push(reply);
  if (cm.resolved) {
    cm.resolved = false;
    delete cm.resolvedBy;
    delete cm.resolvedAt;
  }
  cm._u = now;
  await saveBoard();
  notifyCollabComment('reply', cm, reply.id, text, now);
}

async function toggleResolveComment(cid) {
  const cm = commentById(cid);
  if (!cm) return;
  record();
  const prof = getCollabProfile();
  const now = Date.now();
  cm.resolved = !cm.resolved;
  if (cm.resolved) {
    cm.resolvedBy = prof.name;
    cm.resolvedAt = now;
  } else {
    delete cm.resolvedBy;
    delete cm.resolvedAt;
  }
  cm._u = now;
  unreadCommentIds.delete(cm.id);
  await saveBoard();
  if (cm.resolved) notifyCollabComment('resolve', cm, `res:${now}`, cm.text, now);
}

async function deleteCommentThread(cid) {
  const b = boardOf();
  const cm = b && commentById(cid);
  if (!b || !cm) return;
  record();
  const delIds = [cm.id, ...(cm.replies || []).map((r) => r.id)];
  b.comments = (b.comments || []).filter((x) => x.id !== cm.id);
  if (collabSession?.canvasId === b.id) collabSession.recordTombstones(delIds, Date.now());
  unreadCommentIds.delete(cm.id);
  if (openCommentId === cm.id) openCommentId = null;
  await saveBoard();
  toast('已删除备注', { action: '撤销', onAction: () => undoBoard() });
}

$('#commentThreadPop').addEventListener('click', (e) => {
  const actBtn = e.target.closest('[data-cm-act]');
  if (!actBtn) return;
  const act = actBtn.dataset.cmAct;
  if (act === 'close') closeCommentPop();
  else if (act === 'resolve' && openCommentId && openCommentId !== 'draft') toggleResolveComment(openCommentId);
  else if (act === 'delete' && openCommentId && openCommentId !== 'draft') deleteCommentThread(openCommentId);
});

$('#commentThreadPop').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target.closest('[data-cm-form]');
  if (!form) return;
  const ta = form.querySelector('textarea[name="text"]');
  const val = ta?.value || '';
  if (!val.trim()) { ta?.focus(); return; }
  if (form.dataset.cmForm === 'draft') {
    await submitDraftComment(val);
  } else if (openCommentId && openCommentId !== 'draft') {
    ta.value = '';
    await submitCommentReply(openCommentId, val);
  }
});

$('#commentThreadPop').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.stopPropagation();
    closeCommentPop();
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.target.matches('textarea')) {
    e.preventDefault();
    e.target.closest('form')?.requestSubmit();
  }
});

$('#commentsPopover').addEventListener('click', (e) => {
  const act = e.target.closest('[data-cmp-act]')?.dataset.cmpAct;
  if (act === 'mark-all-read') {
    for (const cm of boardOf()?.comments || []) unreadCommentIds.delete(cm.id);
    renderCommentCenterUI();
    renderCommentsLayer();
    renderViews();
    renderCommentsPopover();
    return;
  }
  if (act === 'add-tool') {
    toggleCommentsPopover(false);
    setTool('comment');
    return;
  }
  const f = e.target.closest('[data-cmp-filter]')?.dataset.cmpFilter;
  if (f) {
    commentsFilter = f;
    renderCommentsPopover();
    return;
  }
  const jumpId = e.target.closest('[data-cm-jump]')?.dataset.cmJump;
  if (jumpId) {
    focusComment(jumpId, state.view);
  }
});

$('#commentsPopover').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.stopPropagation();
    toggleCommentsPopover(false);
  }
});

async function initCollabFromUrl() {
  const room = collab.normalizeRoomId(new URLSearchParams(location.search).get('room') || '');
  if (!room) return;
  let wasHost = false;
  try { wasHost = sessionStorage.getItem('wb:collabHostRoom') === room; } catch {}
  await startCollabRoom(room, { autoCopy: false, quiet: false, isJoining: !wasHost });
}

// ---------- 快速重命名：卡片原地连改（Tab 跳下一张） + 分栏批量重命名工作台 ----------
const RENAME_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17v3z"/><path d="m13.5 6.5 3 3"/></svg>`;

function findVisibleCardEl(cardId) {
  return $$(`.card[data-id="${CSS.escape(cardId)}"]`).find((el) => el.offsetParent !== null)
    || $(`.card[data-id="${CSS.escape(cardId)}"]`);
}

function startInlineRename(cardId) {
  const card = cardId && findCard(cardId);
  if (!card || card.columnId === TRASH) return;
  const cardEl = findVisibleCardEl(card.id);
  const nameEl = cardEl?.querySelector('.name');
  if (!cardEl || !nameEl) return openBatchRename([card]);
  if (cardEl.querySelector('.inline-rn-wrap')) {
    cardEl.querySelector('.inline-rn-input')?.focus();
    return;
  }

  const { stem, ext } = rn.splitCardName(card.name, card.kind === 'note');
  const prevDrag = cardEl.getAttribute('draggable');
  cardEl.setAttribute('draggable', 'false');
  cardEl.classList.add('is-renaming');

  const wrap = document.createElement('span');
  wrap.className = 'inline-rn-wrap';
  wrap.innerHTML = `<input type="text" class="inline-rn-input" value="${esc(stem)}" maxlength="120" aria-label="输入新文件名">${ext ? `<span class="inline-rn-ext" title="保留扩展名">${esc(ext)}</span>` : ''}`;
  nameEl.replaceChildren(wrap);

  const input = wrap.querySelector('.inline-rn-input');
  let finished = false;

  const findNextCardId = (dir) => {
    const container = cardEl.closest('.list, #world') || document;
    const cards = $$('.card[data-id]', container).filter((el) => el.offsetParent !== null);
    const idx = cards.indexOf(cardEl);
    if (idx < 0) return null;
    const next = cards[idx + dir];
    return next ? next.dataset.id : null;
  };

  const cleanupDom = () => {
    if (prevDrag != null) cardEl.setAttribute('draggable', prevDrag);
    cardEl.classList.remove('is-renaming');
  };

  const done = async (mode, stepDir = 0) => {
    if (finished) return;
    finished = true;
    input.removeEventListener('blur', onBlur);
    input.removeEventListener('keydown', onKey);
    const nextId = stepDir ? findNextCardId(stepDir) : null;
    const nextName = mode === 'cancel' ? card.name : rn.joinCardName(input.value, ext, card.name);
    const prevName = card.name;
    const modified = nextName !== prevName;

    if (modified) {
      card.name = nextName;
      await db.put('cards', Object.assign(card, { updatedAt: Date.now() }));
      await db.setMeta('lastChange', Date.now());
      if (!collabSession) channel?.postMessage('changed');
      else scheduleCollabSync();
    }

    cleanupDom();
    refreshCard(card);

    if (nextId) {
      const nextEl = findVisibleCardEl(nextId);
      nextEl?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      startInlineRename(nextId);
      return;
    }

    if (modified) {
      render();
      refreshStatus();
      toast(`已重命名为「${card.name}」`, {
        action: '撤销',
        onAction: async () => { card.name = prevName; await saveCard(card); await changed(); },
      });
    }
  };

  const onBlur = () => done('commit', 0);
  const onKey = (e) => {
    if (e.isComposing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      done('cancel', 0);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      done('commit', 0);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      done('commit', e.shiftKey ? -1 : 1);
    }
  };

  input.addEventListener('blur', onBlur);
  input.addEventListener('keydown', onKey);
  cardEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  input.focus({ preventScroll: true });
  input.select();
}

async function openBatchRename(cards, contextTitle = '') {
  const list = (cards || []).filter((c) => c && c.columnId !== TRASH);
  if (!list.length) return toast('这里还没有可重命名的文件');

  const items = list.map((card) => {
    const { stem, ext } = rn.splitCardName(card.name, card.kind === 'note');
    return {
      card,
      origName: card.name,
      origStem: stem,
      ext,
      stem,
      dirty: false,
    };
  });

  const modal = $('#modal');
  modal.classList.add('wide', 'batch-rename-modal');
  modal.setAttribute('aria-labelledby', 'brTitle');

  let activeIdx = 0;
  let ruleMode = 'seq'; // 'seq' | 'rep'
  let previewToken = 0;
  let settled = false;
  const ac = new AbortController();

  const baseDefault = contextTitle && contextTitle !== '已选文件' ? contextTitle : '';
  const rowsHTML = items.map((it, i) => {
    const t = it.card.kind === 'note' ? { c: '#f0b429', label: '便签' } : typeOf(it.card);
    const thumbUrlCached = it.card.thumb === 'ok' ? state.urls.get(`thumb:${it.card.id}`) : null;
    const thumbHTML = thumbUrlCached
      ? `<img src="${thumbUrlCached}" alt="" class="br-row-thumb">`
      : `<span class="br-row-ico" style="--c:${t.c}">${esc(it.card.kind === 'note' ? '便签' : (it.ext.slice(1, 5) || t.label))}</span>`;
    return `<div class="br-row${i === 0 ? ' active' : ''}" data-br-row="${i}">
      <span class="br-idx">${i + 1}</span>
      <span class="br-mini">${thumbHTML}</span>
      <div class="br-field">
        <input type="text" class="br-row-input" data-idx="${i}" value="${esc(it.stem)}" maxlength="120" aria-label="第 ${i + 1} 个文件名"${i === 0 ? ' autofocus' : ''}>
        ${it.ext ? `<span class="br-ext">${esc(it.ext)}</span>` : ''}
      </div>
      <button type="button" class="icon-btn br-row-reset" data-br-reset="${i}" tabindex="-1" title="还原为原名" aria-label="还原第 ${i + 1} 项" hidden><svg viewBox="0 0 24 24"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg></button>
    </div>`;
  }).join('');

  const p = dialog(`<h3 id="brTitle" tabindex="-1">${RENAME_SVG}快速重命名 · 共 ${items.length} 个${contextTitle ? `<small class="br-ctx">「${esc(contextTitle)}」</small>` : ''}</h3>
    <div class="br-layout">
      <aside class="br-preview" aria-label="当前文件预览">
        <div class="br-preview-stage" id="brStage"></div>
        <div class="br-preview-info">
          <div class="br-preview-nav">
            <button type="button" class="icon-btn" id="brPrevBtn" title="上一个文件 (↑)" aria-label="上一个"><svg viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg></button>
            <span id="brPosLabel">1 / ${items.length}</span>
            <button type="button" class="icon-btn" id="brNextBtn" title="下一个文件 (↓ / Enter)" aria-label="下一个"><svg viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg></button>
          </div>
          <div class="br-orig-name" id="brOrigName"></div>
          <div class="br-meta" id="brMeta"></div>
        </div>
      </aside>
      <section class="br-main">
        <div class="br-rules" id="brRules">
          <div class="br-rule-tabs" role="tablist">
            <button type="button" role="tab" class="br-rtab" data-br-tab="seq" aria-selected="true">按序号批量命名</button>
            <button type="button" role="tab" class="br-rtab" data-br-tab="rep" aria-selected="false">查找替换 / 加前后缀</button>
            <button type="button" class="btn ghost br-reset-all" id="brResetAll">全部还原</button>
          </div>
          <div class="br-rule-pane" data-br-pane="seq">
            <div class="br-rule-grid">
              <div class="br-base-wrap">
                <input type="text" id="brSeqBase" value="" placeholder="${esc(baseDefault || '统一前缀，例如：宣传海报')}" aria-label="统一前缀">
                ${baseDefault ? `<button type="button" class="br-fill-chip" id="brFillBase" title="填入「${esc(baseDefault)}」">用「${esc(baseDefault.slice(0, 10))}」</button>` : ''}
              </div>
              <select id="brSeqSep" aria-label="分隔符" title="分隔符">
                <option value="_">分隔：_</option>
                <option value="-">分隔：-</option>
                <option value=" ">分隔：空格</option>
                <option value="">无分隔</option>
              </select>
              <select id="brSeqStyle" aria-label="序号格式" title="序号格式">
                <option value="01">序号：01, 02…</option>
                <option value="001">序号：001, 002…</option>
                <option value="1">序号：1, 2…</option>
                <option value="(1)">序号：(1), (2)…</option>
              </select>
              <label class="br-num-start" title="起始数字"><span>起始</span><input type="number" id="brSeqStart" min="0" value="1"></label>
              <button type="button" class="btn primary br-apply-btn" id="brApplySeq">应用序号</button>
            </div>
            <label class="br-check"><input type="checkbox" id="brKeepOrig"><span>保留各自原名，只在末尾加序号</span></label>
          </div>
          <div class="br-rule-pane" data-br-pane="rep" hidden>
            <div class="br-rule-grid rep">
              <input type="text" id="brRepFind" placeholder="查找文字（如 download）" aria-label="查找文字">
              <input type="text" id="brRepWith" placeholder="替换为（留空则删除）" aria-label="替换为">
              <input type="text" id="brRepPre" placeholder="加前缀" aria-label="加前缀">
              <input type="text" id="brRepSuf" placeholder="加后缀" aria-label="加后缀">
              <button type="button" class="btn primary br-apply-btn" id="brApplyRep">应用替换</button>
            </div>
          </div>
        </div>
        <div class="br-list" id="brList">${rowsHTML}</div>
      </section>
    </div>
    <div class="modal-actions br-foot">
      <button type="button" class="btn primary" id="brSaveBtn">保存重命名</button>
      <button type="button" class="btn" data-br-cancel="1">取消</button>
      <span class="br-hint">Enter / ↓ 下一张并预览 · ↑ 上一张 · Ctrl+Enter 保存</span>
    </div>`,
  () => items.map((it) => ({
    card: it.card,
    oldName: it.origName,
    newName: rn.joinCardName(it.stem, it.ext, it.origName),
  })).filter((x) => x.newName !== x.oldName));

  const root = $('#modalInner');
  const inputs = $$('.br-row-input', root);
  const rows = $$('.br-row', root);
  const saveBtn = $('#brSaveBtn', root);
  const stage = $('#brStage', root);
  const origEl = $('#brOrigName', root);
  const metaEl = $('#brMeta', root);
  const posEl = $('#brPosLabel', root);
  const prevBtn = $('#brPrevBtn', root);
  const nextBtn = $('#brNextBtn', root);

  const updateChangedCount = () => {
    let changedN = 0;
    items.forEach((it, i) => {
      const nextName = rn.joinCardName(it.stem, it.ext, it.origName);
      it.dirty = nextName !== it.origName;
      if (it.dirty) changedN++;
      rows[i]?.classList.toggle('is-dirty', it.dirty);
      const rbtn = rows[i]?.querySelector('.br-row-reset');
      if (rbtn) rbtn.hidden = !it.dirty;
    });
    saveBtn.textContent = changedN ? `保存重命名（${changedN} 项）` : '保存重命名';
    saveBtn.disabled = changedN === 0;
  };

  const showPreview = async (idx) => {
    activeIdx = Math.max(0, Math.min(items.length - 1, idx));
    rows.forEach((r, i) => r.classList.toggle('active', i === activeIdx));
    rows[activeIdx]?.scrollIntoView({ block: 'nearest' });
    const it = items[activeIdx];
    const card = it.card;
    const token = ++previewToken;

    posEl.textContent = `${activeIdx + 1} / ${items.length}`;
    prevBtn.disabled = activeIdx === 0;
    nextBtn.disabled = activeIdx === items.length - 1;
    origEl.textContent = `原名：${it.origName}`;
    origEl.title = it.origName;

    if (card.kind === 'note') {
      metaEl.textContent = `便签 · ${fmtDate(card.updatedAt || card.createdAt)}`;
      stage.innerHTML = `<div class="br-prev-note"><b>${esc(card.name || '便签')}</b><p>${esc(card.text || '（空便签）')}</p></div>`;
      return;
    }

    const t = typeOf(card);
    metaEl.textContent = metaText(card, t);
    const fam = pv.family(card);
    const fallbackIco = `<div class="br-prev-file"><div class="type-icon" style="--c:${t.c}">${esc(it.ext.slice(1, 5) || t.label)}</div><span>${esc(card.name)}</span></div>`;

    if (fam === 'image') {
      stage.innerHTML = '<div class="spinner" aria-label="加载预览"></div>';
      try {
        const u = await urlFor(card.id);
        if (settled || token !== previewToken) return;
        stage.innerHTML = u ? `<img src="${u}" alt="${esc(card.name)}" class="br-prev-img">` : fallbackIco;
      } catch {
        if (!settled && token === previewToken) stage.innerHTML = fallbackIco;
      }
      return;
    }

    if (card.thumb === 'ok') {
      stage.innerHTML = '<div class="spinner" aria-label="加载预览"></div>';
      try {
        const u = await thumbUrl(card.id);
        if (settled || token !== previewToken) return;
        stage.innerHTML = u ? `<img src="${u}" alt="${esc(card.name)}" class="br-prev-img">` : fallbackIco;
      } catch {
        if (!settled && token === previewToken) stage.innerHTML = fallbackIco;
      }
      return;
    }

    stage.innerHTML = fallbackIco;
  };

  const focusRow = (idx) => {
    const target = inputs[Math.max(0, Math.min(inputs.length - 1, idx))];
    if (!target) return;
    target.focus();
    target.select();
  };

  // 加载列表中尚未缓存的小缩略图
  for (let i = 0; i < items.length; i++) {
    const card = items[i].card;
    if (card.thumb === 'ok' && !state.urls.get(`thumb:${card.id}`)) {
      thumbUrl(card.id).then((u) => {
        if (settled || !u) return;
        const mini = rows[i]?.querySelector('.br-mini');
        if (mini) mini.innerHTML = `<img src="${u}" alt="" class="br-row-thumb">`;
      }).catch(() => {});
    }
  }

  root.addEventListener('input', (e) => {
    if (!e.target.matches('.br-row-input')) return;
    const idx = Number(e.target.dataset.idx);
    if (!Number.isInteger(idx) || !items[idx]) return;
    items[idx].stem = e.target.value;
    updateChangedCount();
  }, { signal: ac.signal });

  root.addEventListener('focusin', (e) => {
    const inp = e.target.closest('.br-row-input');
    if (inp) {
      const idx = Number(inp.dataset.idx);
      if (Number.isInteger(idx) && idx !== activeIdx) showPreview(idx);
    }
  }, { signal: ac.signal });

  root.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-br-tab]');
    if (tab) {
      ruleMode = tab.dataset.brTab;
      $$('[data-br-tab]', root).forEach((b) => b.setAttribute('aria-selected', String(b === tab)));
      $$('[data-br-pane]', root).forEach((pane) => { pane.hidden = pane.dataset.brPane !== ruleMode; });
      return;
    }
    if (e.target.closest('#brFillBase')) {
      const baseInp = $('#brSeqBase', root);
      if (baseInp && baseDefault) {
        baseInp.value = baseDefault;
        $('#brKeepOrig', root).checked = false;
        $('#brApplySeq', root)?.click();
      }
      return;
    }
    if (e.target.closest('#brApplySeq')) {
      const base = $('#brSeqBase', root)?.value || '';
      const sep = $('#brSeqSep', root)?.value ?? '_';
      const numStyle = $('#brSeqStyle', root)?.value || '01';
      const start = $('#brSeqStart', root)?.value ?? 1;
      const keepOrig = Boolean($('#brKeepOrig', root)?.checked);
      const nextStems = rn.applySequenceRule(items, { base, sep, numStyle, start, keepOrig });
      nextStems.forEach((st, i) => {
        items[i].stem = st;
        if (inputs[i]) inputs[i].value = st;
      });
      updateChangedCount();
      return;
    }
    if (e.target.closest('#brApplyRep')) {
      const find = $('#brRepFind', root)?.value || '';
      const replace = $('#brRepWith', root)?.value || '';
      const prefix = $('#brRepPre', root)?.value || '';
      const suffix = $('#brRepSuf', root)?.value || '';
      const nextStems = rn.applyReplaceRule(items.map((it) => it.stem), { find, replace, prefix, suffix });
      nextStems.forEach((st, i) => {
        items[i].stem = st;
        if (inputs[i]) inputs[i].value = st;
      });
      updateChangedCount();
      return;
    }
    if (e.target.closest('#brResetAll')) {
      items.forEach((it, i) => {
        it.stem = it.origStem;
        if (inputs[i]) inputs[i].value = it.origStem;
      });
      updateChangedCount();
      return;
    }
    const rbtn = e.target.closest('[data-br-reset]');
    if (rbtn) {
      const idx = Number(rbtn.dataset.brReset);
      if (items[idx]) {
        items[idx].stem = items[idx].origStem;
        if (inputs[idx]) inputs[idx].value = items[idx].origStem;
        updateChangedCount();
        focusRow(idx);
      }
      return;
    }
    if (e.target.closest('#brSaveBtn')) {
      triggerSave();
      return;
    }
    if (e.target.closest('[data-br-cancel]')) return modal.close();
    if (e.target.closest('#brPrevBtn')) return focusRow(activeIdx - 1);
    if (e.target.closest('#brNextBtn')) return focusRow(activeIdx + 1);
    const row = e.target.closest('[data-br-row]');
    if (row && !e.target.closest('button, input')) focusRow(Number(row.dataset.brRow));
  }, { signal: ac.signal });

  // Capture-phase submit guard ensures Enter inside row/rule inputs navigates instead of implicitly submitting
  let allowSubmit = false;
  const triggerSave = () => {
    if (saveBtn.disabled || settled) return;
    allowSubmit = true;
    try {
      root.requestSubmit();
    } finally {
      allowSubmit = false;
    }
  };
  modal.addEventListener('submit', (e) => {
    if (!allowSubmit) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, { signal: ac.signal, capture: true });

  root.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      triggerSave();
      return;
    }
    const inp = e.target.closest('.br-row-input');
    if (inp) {
      const idx = Number(inp.dataset.idx);
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        if (idx < inputs.length - 1) focusRow(idx + 1);
        else if (!saveBtn.disabled) requestAnimationFrame(() => saveBtn.focus());
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        focusRow(idx + 1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        focusRow(idx - 1);
      }
      return;
    }
    if (e.key === 'Enter' && e.target.closest('#brSeqBase, #brSeqStart')) {
      e.preventDefault();
      e.stopPropagation();
      $('#brApplySeq', root)?.click();
    } else if (e.key === 'Enter' && e.target.closest('#brRepFind, #brRepWith, #brRepPre, #brRepSuf')) {
      e.preventDefault();
      e.stopPropagation();
      $('#brApplyRep', root)?.click();
    }
  }, { signal: ac.signal, capture: true });

  updateChangedCount();
  await showPreview(0);

  let changes = null;
  try {
    changes = await p;
  } finally {
    settled = true;
    ac.abort();
    modal.classList.remove('wide', 'batch-rename-modal');
    modal.removeAttribute('aria-labelledby');
  }

  if (!changes?.length) return;
  const now = Date.now();
  changes.forEach(({ card, newName }) => {
    card.name = newName;
    card.updatedAt = now;
  });
  await db.putMany('cards', changes.map((x) => x.card));
  await changed();
  toast(`已重命名 ${changes.length} 个文件`, {
    action: '撤销',
    onAction: async () => {
      changes.forEach(({ card, oldName }) => {
        card.name = oldName;
        card.updatedAt = Date.now();
      });
      await db.putMany('cards', changes.map((x) => x.card));
      await changed();
    },
  });
}

// ---------- 启动 ----------
(async function init() {
  initShareFromUrl(); // 别人发来的分享链接：先显示下载页（不依赖本地数据库）
  try {
    await db.open();
    await load();
    await ensureDefaults();
    render();
    refreshStatus();
    if (state.cards.length) requestPersist();
    addReposFromLink();
    await initCollabFromUrl();
    await sweepExpired();
    setInterval(sweepExpired, 3600e3);
  } catch (e) {
    console.error(e);
    $('#board').innerHTML = `<div class="empty" style="margin:40px auto;max-width:420px">无法打开本地数据库：${esc(e.message || e)}<br>请确认没有使用无痕模式，或刷新重试。</div>`;
  }
})();
