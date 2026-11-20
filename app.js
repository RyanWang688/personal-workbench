import * as db from './db.js?v=6';
import * as pv from './preview.js?v=3';

const TRASH = 'trash';
const BOARD = 'board';
const ARCHIVE = 'archive';      // 「已完成项目」页面
const PICK = 'archive-pick';    // 拖到「已完成项目」标签上 → 选择文件夹
const WORKS = 'works';          // 「作品」页面
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
  if (state.view === WORKS && area(state.work)?.kind === 'work') return state.work;
  return columns()[0]?.id || fallbackZone();
}

async function load() {
  const [areas, cards] = await Promise.all([db.getAll('columns'), db.getAll('cards')]);
  state.areas = areas;
  state.cards = cards;
  const live = new Set(cards.map((c) => c.id));
  for (const [key, url] of state.urls) if (!live.has(key.replace(/^thumb:/, ''))) { URL.revokeObjectURL(url); state.urls.delete(key); }
  if (state.view !== BOARD && state.view !== ARCHIVE && state.view !== WORKS && !isCanvas(state.view)) state.view = BOARD;
  if (state.folder && !area(state.folder)) state.folder = null;
  if (state.work && area(state.work)?.kind !== 'work') state.work = null;
  state.cats = await db.getMeta('categories', []).catch(() => []);
  state.workCats = await db.getMeta('workCategories', []).catch(() => []);
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
const isActive = (c) => c.columnId !== TRASH && !['folder', 'work'].includes(area(c.columnId)?.kind);

// ===== 名称关联算法 =====
// 每两张卡片算一个 0~1 的关联分：
//   名称分 = 相同 1.0 ｜ 包含（≥3 字）0.92、（2 字）0.7 ｜ 否则 0.45×字符二元组 Dice + 0.55×最长公共片段占比
//   情境分 = 同一批拖入 +0.15 ｜ 10 分钟内先后加入 +0.05
// 「IMG_1234 / 截图 / 微信图片 / 未命名」等通用文件名不参与名称匹配。
const GENERIC = /^(img|dsc|dcim|pxl|mvimg|vid|video|image|photo|scan|screenshot|screen ?shot|截图|屏幕截图|微信图片|未命名|untitled|新建|文档|document|file)[\s_\-]*\d*$/i;
const normTitle = (c) => baseTitle(c).toLowerCase().replace(new RegExp(SEP, 'g'), '');
const bigrams = (s) => { const set = new Set(); if (s.length < 2) { if (s) set.add(s); return set; } for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2)); return set; };
function dice(a, b) { let n = 0; for (const x of a) if (b.has(x)) n++; return a.size + b.size ? (2 * n) / (a.size + b.size) : 0; }
function lcsLen(a, b) {
  let best = 0; const prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diag = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = a[i - 1] === b[j - 1] ? diag + 1 : 0;
      if (prev[j] > best) best = prev[j];
      diag = tmp;
    }
  }
  return best;
}
function nameScore(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  if (s.length >= 2 && l.includes(s)) return s.length >= 3 ? 0.92 : 0.7;
  const k = lcsLen(a, b);
  const d = dice(bigrams(a), bigrams(b));
  return k >= 2 ? 0.45 * d + 0.55 * (k / s.length) : 0.6 * d;
}
function pairScore(A, B) {
  let name = 0;
  if (!A.generic && !B.generic) name = nameScore(A.key, B.key);
  let ctx = 0;
  if (A.c.batchId && A.c.batchId === B.c.batchId) ctx += 0.15;
  else if (Math.abs((A.c.createdAt || 0) - (B.c.createdAt || 0)) < 10 * 60e3) ctx += 0.05;
  return name > 0 ? Math.min(0.99, name + ctx) : 0;
}
// 灵敏度：自动关联阈值 / 建议阈值
const SENS = { strict: { auto: 0.95, hint: 0.62, label: '严格' }, normal: { auto: 0.8, hint: 0.5, label: '标准' }, loose: { auto: 0.66, hint: 0.4, label: '宽松' } };
const sens = () => SENS[ls.get('assoc', 'normal')] || SENS.normal;
const dismissed = new Set(ls.get('dismissed', []));
const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

function buildGroups() {
  const live = state.cards.filter(isActive);
  const parent = new Map(live.map((c) => [c.id, c.id]));
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const union = (a, b) => { if (parent.has(a) && parent.has(b)) parent.set(find(a), find(b)); };
  const { auto, hint } = sens();
  // noAuto：用户手动「从关联中移除」的卡片，不再参与自动匹配
  const items = live.filter((c) => !c.noAuto).map((c) => { const key = normTitle(c); return { c, key, generic: GENERIC.test(key) || key.length < 2 }; });
  const hints = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const s = pairScore(items[i], items[j]);
      if (s >= auto) union(items[i].c.id, items[j].c.id);
      else if (s >= hint && !dismissed.has(pairKey(items[i].c.id, items[j].c.id))) hints.push([items[i].c.id, items[j].c.id, s]);
    }
  }
  for (const c of live) if (c.sourceId && !c.noAuto && !findCard(c.sourceId)?.noAuto) union(c.id, c.sourceId);
  // 手动关联：同一个 projectId 一定是同一项目
  const firstOfProject = new Map();
  for (const c of live) {
    if (!c.projectId) continue;
    if (firstOfProject.has(c.projectId)) union(c.id, firstOfProject.get(c.projectId));
    else firstOfProject.set(c.projectId, c.id);
  }
  const groups = new Map();
  for (const c of live) { const r = find(c.id); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(c.id); }
  state.groups = new Map();
  for (const ids of groups.values()) for (const id of ids) state.groups.set(id, ids);

  // 建议：把「中等分数」连接起来的不同组合并成一条建议
  const gp = new Map(), gfind = (x) => { while (gp.get(x) !== x) x = gp.get(x); return x; };
  const best = new Map();
  for (const [a, b, s] of hints) {
    const ra = find(a), rb = find(b);
    if (ra === rb) continue;
    if (!gp.has(ra)) gp.set(ra, ra);
    if (!gp.has(rb)) gp.set(rb, rb);
    const x = gfind(ra), y = gfind(rb);
    if (x !== y) gp.set(x, y);
    best.set(ra, Math.max(best.get(ra) || 0, s)); best.set(rb, Math.max(best.get(rb) || 0, s));
  }
  const clusters = new Map();
  for (const r of gp.keys()) { const k = gfind(r); if (!clusters.has(k)) clusters.set(k, []); clusters.get(k).push(r); }
  state.suggestions = [...clusters.values()].filter((rs) => rs.length > 1).map((rs) => ({
    ids: rs.flatMap((r) => groups.get(r)),
    score: Math.max(...rs.map((r) => best.get(r) || 0)),
  })).sort((a, b) => b.score - a.score);
  state.suggestOf = new Map();
  state.suggestions.forEach((s, i) => s.ids.forEach((id) => state.suggestOf.set(id, i)));
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
const selBtn = (c) => `<button class="sel" data-action="select" aria-pressed="${state.selected.has(c.id)}" aria-label="选择 ${esc(c.name || '便签')}" title="选择（Ctrl / Shift + 点击也可多选）">${CHECK_SVG}</button>`;

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
function cardHTML(c, onCanvas = false) {
  const attrs = onCanvas
    ? `draggable="false" style="left:${Math.round(c.x || 0)}px;top:${Math.round(c.y || 0)}px;z-index:${Math.max(1, Math.round(c.order) || 1)}"`
    : `draggable="${IS_TOUCH ? 'false' : 'true'}"`;
  const cls = `card${onCanvas ? ' on-canvas' : ''}${onCanvas && !matches(c) ? ' dim' : ''}${state.selected.has(c.id) ? ' selected' : ''}${PRIO[c.prio] ? ` prio-${c.prio}` : ''}`;
  const extra = (onCanvas ? HANDLE : '') + (c.columnId !== TRASH ? selBtn(c) : '');
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
  const onBoard = state.view === BOARD, onArchive = state.view === ARCHIVE, onWorks = state.view === WORKS;
  $('#board').hidden = !onBoard;
  $('#archiveView').hidden = !onArchive;
  $('#worksView').hidden = !onWorks;
  $('#canvasView').hidden = onBoard || onArchive || onWorks;
  if (onBoard) renderBoard(); else if (onArchive) renderArchive(); else if (onWorks) renderWorks(); else renderCanvas();
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
      // 离线 / 存储文件夹尚未授权：先停，下次再试，不把卡片标记成「无预览」
      if (/组件加载失败/.test(e.message) || e.code === 'NEED_PERMISSION') { thumbQ.length = 0; queued.clear(); break; }
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
    <button role="tab" class="view-tab works-tab" data-view="${WORKS}" aria-selected="${state.view === WORKS}" title="个人作品：网站、设计、项目，含更新日志和在线预览">
      ${WORK_SVG}作品<b>${works().length}</b></button>
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
// ---------- 子文件夹：folder.parentId 指向上级文件夹 ----------
const parentOf = (f) => (f?.parentId && area(f.parentId)?.kind === 'folder' ? area(f.parentId) : null);
const childFolders = (id) => folders().filter((f) => parentOf(f)?.id === id);
const rootFolders = () => folders().filter((f) => !parentOf(f));
function descendantIds(id) { const out = []; const walk = (x) => childFolders(x).forEach((c) => { out.push(c.id); walk(c.id); }); walk(id); return out; }
const deepCards = (id) => [id, ...descendantIds(id)].flatMap((x) => cardsIn(x, false));
const folderSize = (id) => deepCards(id).reduce((n, c) => n + (c.size || 0), 0);
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
  if (fid) {
    const f = area(fid), n = deepCards(fid).length, subs = childFolders(fid);
    const own = cardsIn(fid, false).length;
    const crumbs = [`<button class="crumb-link" data-goto="" data-folderdrop="">已完成项目</button>`,
      ...ancestors(f).map((a) => `<button class="crumb-link" data-goto="${a.id}" data-folderdrop="${a.id}">${esc(a.title)}</button>`)].join('<span>/</span>') + '<span>/</span>';
    el.innerHTML = `
      <header class="archive-head" style="--fc:${folderColor(f)}">
        <button class="icon-btn back" data-action="folder-back" aria-label="返回上一级"><svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg></button>
        <div class="ah-text">
          <div class="crumb">${crumbs}</div>
          <h2><span class="title-sw" aria-hidden="true"></span>${esc(f.title)}</h2>
          <div class="meta">${folderMeta(f)} · 归档于 ${fmtDate(f.doneAt || Date.now())}</div>
        </div>
        <button class="btn" data-action="add-subfolder"><svg viewBox="0 0 24 24"><path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><path d="M12 11v5M9.5 13.5h5"/></svg><span>新建子文件夹</span></button>
        <button class="btn" data-action="folder-zip" ${n ? '' : 'disabled'}><svg viewBox="0 0 24 24"><path d="M12 4v11m0 0-4-4m4 4 4-4"/><path d="M5 19h14"/></svg><span>打包下载</span></button>
        <button class="icon-btn" data-action="folder-menu" aria-label="文件夹设置" aria-haspopup="menu">${DOTS}</button>
      </header>
      ${subs.length ? `<section class="cat-sec"><h3 class="cat-h"><span>子文件夹</span><b>${subs.length}</b></h3><div class="folder-grid">${subs.map(folderTile).join('')}</div></section>` : ''}
      <section class="cat-sec"><h3 class="cat-h"><span>文件</span><b>${own}</b></h3>
      <div class="list folder-list" data-col="${fid}">${listHTML(fid, subs.length ? '把卡片拖到这里，或拖到上面的子文件夹里' : '把卡片或文件拖到这里归档；也可以「新建子文件夹」再细分')}</div></section>`;
    return;
  }
  const q = state.query.toLowerCase();
  // 顶层只显示根文件夹；搜索时子文件夹里的名称 / 文件命中也算
  const all = rootFolders().filter((f) => !q || [f, ...descendantIds(f.id).map(area)].some((x) => x.title.toLowerCase().includes(q) || cardsIn(x.id).length));
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
      <button class="btn primary" data-action="add-folder"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg><span>新建项目文件夹</span></button>
    </header>
    ${bar}${body}`;
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
  const prevParent = src.parentId;
  if ((prevParent || null) === (dstId || null)) return;
  await flyInto($(`.folder[data-folder="${CSS.escape(srcId)}"]`), dEl || (dstId && $(`.folder[data-folder="${CSS.escape(dstId)}"]`)));
  if (dstId) src.parentId = dstId; else delete src.parentId;
  await saveArea(src);
  await changed();
  toast(dst ? `「${src.title}」已放进「${dst.title}」` : `「${src.title}」已移到顶层`, {
    action: '撤销', onAction: async () => { if (prevParent) src.parentId = prevParent; else delete src.parentId; await saveArea(src); await changed(); },
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
  $$('.folder.merge-target').forEach((el) => { if (el !== t) el.classList.remove('merge-target', 'nest-mode'); });
  $$('.cat-chip.drop-active, .crumb-link.drop-active').forEach((el) => { if (el !== chipEl && el !== crumb) el.classList.remove('drop-active'); });
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
  $$('.folder-dragging, .merge-target, .cat-chip.drop-active, .crumb-link.drop-active').forEach((el) => el.classList.remove('folder-dragging', 'merge-target', 'nest-mode', 'drop-active'));
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
  const t = toast('正在打包…', { sticky: true });
  try {
    const JSZip = await pv.lib('zip');
    const z = new JSZip(), used = new Set();
    const clean = (s) => String(s).replace(/[\\/:*?"<>|]/g, '_');
    // 保留子文件夹结构：zip 里的路径 = 相对当前文件夹的子文件夹路径
    const rel = (folderId) => { const out = []; let x = area(folderId); while (x && x.id !== f.id) { out.unshift(clean(x.title)); x = parentOf(x); } return out.length ? `${out.join('/')}/` : ''; };
    for (const c of cards) {
      const raw = rel(c.columnId) + clean(c.kind === 'note' ? `${c.name || '便签'}.txt` : c.name);
      let name = raw, i = 2;
      while (used.has(name)) name = raw.replace(/(\.[^./]*)?$/, ` (${i++})$1`);
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
function parseRepo(s) {
  s = (s || '').trim();
  if (!s) return '';
  let m = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?]|$)/i.exec(s);
  if (m) return `${m[1]}/${m[2]}`;
  m = /^(?:https?:\/\/)?([\w-]+)\.github\.io\/?(?:[?#].*)?$/i.exec(s);
  if (m) return `${m[1]}/${m[1].toLowerCase()}.github.io`;
  m = /^(?:https?:\/\/)?([\w-]+)\.github\.io\/([\w.-]+)/i.exec(s);
  if (m) return `${m[1]}/${m[2]}`;
  m = /^([\w-]+)\/([\w.-]+)$/.exec(s);
  return m ? `${m[1]}/${m[2]}` : null;
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
      <label class="field"><span>名称</span><input type="text" name="wt" value="${esc(v.wt)}" placeholder="例如：个人主页、PTE 备考站" maxlength="80" required></label>
      <label class="field"><span>网站链接</span><input type="text" name="wu" value="${esc(v.wu)}" placeholder="https://… 填了就能直接预览" maxlength="300" inputmode="url"></label>
      <label class="field"><span>GitHub 仓库 <em>可选，用来同步更新日志；GitHub Pages 网站会自动识别</em></span><input type="text" name="wr" value="${esc(v.wr)}" placeholder="用户名/仓库名，或仓库链接" maxlength="200"></label>
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
    const repo = res.wr ? parseRepo(res.wr) : (url && parseRepo(url)) || '';
    if (repo === null) { toast('GitHub 仓库请填「用户名/仓库名」或仓库链接', { error: true }); continue; }
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
  const base = works().length;
  const list = res.names.map((n, i) => {
    const r = byName.get(n), site = siteOf(r);
    const w = { id: uid(), kind: 'work', order: 0, title: r.name, url: site, repo: r.full_name, desc: r.description || '', tags: r.topics || [],
      status: r.archived ? 'done' : site ? 'live' : 'dev', createdAt: Date.parse(r.created_at) || Date.now(), color: (base + i) % FCOLORS.length, logs: [],
      repoInfo: { stars: r.stargazers_count, lang: r.language, pushedAt: Date.parse(r.pushed_at) || 0 } };
    if (res.cat) w.category = res.cat;
    return w;
  });
  if (res.cat && !allWorkCats().includes(res.cat)) { state.workCats = [...(state.workCats || []), res.cat]; await saveWorkCats(); }
  await db.putMany('columns', list);
  state.areas.push(...list);
  await changed();
  toast(`已导入 ${list.length} 个作品，正在同步更新日志…`);
  // 导入时仓库信息已经有了，只拉提交记录（省一半 API 额度）
  let added = 0;
  for (const w of list) {
    state.syncing.add(w.id); render();
    try { added += mergeCommits(w, await gh(`/repos/${w.repo}/commits?per_page=100`)); w.syncedAt = Date.now(); delete w.syncError; }
    catch (e) { w.syncError = e.message; w.syncTry = Date.now(); if (e.code === 'RATE') { toast(e.message, { error: true }); state.syncing.clear(); await db.putMany('columns', list.filter((x) => area(x.id))); break; } }
    finally { state.syncing.delete(w.id); if (area(w.id)) await saveArea(w); await changed(); }
  }
  if (added) toast(`同步完成：${list.length} 个作品共 ${added} 条更新日志`);
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
  items.push('-', { text: '删除作品', danger: true, run: () => deleteArea(w) });
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
  const batchId = files.length > 1 ? uid() : undefined; // 同一批拖入的文件，关联算法会加分
  if (batchId && !extra.batchId) extra = { batchId, ...extra };
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
const KIND_LABEL = { column: '列', zone: '功能区', canvas: '画布', folder: '项目文件夹', work: '作品' };
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
  let target = kind === 'zone' ? zones().find((z) => z.id !== a.id)?.id : fallbackZone();
  if (target === a.id) target = zones().find((z) => z.id !== a.id)?.id;
  const kids = kind === 'folder' ? childFolders(a.id) : [];
  const parts = [];
  if (cards.length) parts.push(`里面的 ${cards.length} 张卡片会移到「${areaName(target)}」`);
  if (kids.length) parts.push(`${kids.length} 个子文件夹会移到${parentOf(a) ? `「${parentOf(a).title}」` : '顶层'}`);
  if (kind === 'work' && visibleLogs(a).length) parts.push(`${visibleLogs(a).length} 条更新日志会一起删除`);
  const ok = await confirmBox({ title: `删除${KIND_LABEL[kind]}「${a.title}」？`, body: parts.length ? `${parts.join('，')}${kind === 'work' ? (cards.length ? '，文件不会丢失。' : '。') : '，都不会丢失。'}` : `这个${KIND_LABEL[kind]}是空的。`, ok: '删除', danger: true });
  if (!ok) return;
  if (kids.length) { kids.forEach((k) => { if (a.parentId) k.parentId = a.parentId; else delete k.parentId; }); await db.putMany('columns', kids); }
  let order = orderAt(target, cardsIn(target, false).length);
  for (const c of cards) { c.columnId = target; c.order = order; c.enteredAt = Date.now(); order += 1024; }
  if (cards.length) await db.putMany('cards', cards);
  await db.del('columns', a.id);
  state.areas = state.areas.filter((x) => x !== a);
  if (state.view === a.id) setView(BOARD);
  if (state.folder === a.id) { state.folder = a.parentId && area(a.parentId) ? a.parentId : null; ls.set('folder', state.folder); }
  if (state.work === a.id) { state.work = null; ls.set('work', null); }
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
async function runConvert(btn) {
  if (!(await ensureAccess())) return;
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
  dest(works(), '放到作品');
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
  if (kind !== 'canvas' && kind !== 'folder') items.push({ text: '添加便签', run: () => newNote(a.id) });
  if (kind === 'column') items.push({ text: '整列归档到已完成项目…', run: () => archiveColumn(a) });
  if (kind === 'folder') {
    items.push({ text: '新建子文件夹…', run: () => addSubfolder(a.id) });
    items.push({ text: '打包下载 zip', run: () => zipFolder(a) });
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
  let mode = 'idb', perm = 'none', dir = null;
  try { mode = await db.storageMode(); if (mode === 'folder') { dir = await db.getDir(); perm = await db.dirPermission(); } } catch {}
  if (mode === 'folder' && perm !== 'granted') {
    chip.textContent = `存储文件夹「${dir?.name}」需要授权 · 点此授权`;
    chip.className = 'status-chip warn';
  } else if (mode === 'folder') {
    chip.textContent = `文件存在「${dir?.name}」· 容量随硬盘`;
    chip.className = 'status-chip ok';
  } else {
    chip.textContent = `已用 ${fmtSize(used)}${quota ? ` / ${fmtSize(quota)}` : ''} · ${persisted ? '持久存储' : '普通存储'}`;
    chip.className = `status-chip ${persisted && (!quota || used / quota < 0.8) ? 'ok' : 'warn'}`;
    // 浏览器空间用到八成时提醒扩容
    if (quota && used / quota > 0.8 && !refreshStatus.warned) { refreshStatus.warned = true; toast('浏览器存储快满了，可以在「存储与容量」里把文件改存到电脑文件夹来扩容', { action: '去设置', onAction: storageInfo }); }
  }
  let lastBackup = 0, lastChange = 0;
  try { [lastBackup, lastChange] = await Promise.all([db.getMeta('lastBackup', 0), db.getMeta('lastChange', 0)]); } catch { return; }
  const bc = $('#backupChip');
  const stale = state.cards.length && lastChange > lastBackup && (!lastBackup || Date.now() - lastBackup > 3 * 86400e3);
  bc.textContent = lastBackup ? `上次备份 ${ago(lastBackup)}${lastChange > lastBackup ? ' · 有新改动' : ''}` : '尚未备份';
  bc.className = `status-chip ${stale ? 'warn' : lastBackup ? 'ok' : ''}`;
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
  try {
    const { blob, count, fileCount, missing } = await db.exportBackup();
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
  if (!el || e.target.closest('.more, .export-handle, .sel, .suggest-badge')) return;
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

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// 长按的目标：若按在已选中的卡片上 → 全部已选；否则 → 它的关联组
function pressTargets(id) {
  if (state.selected.has(id) && state.selected.size > 1) return [...state.selected].filter((x) => isActive(findCard(x) || {}));
  return relatedIds(id);
}
function highlightIds(ids, cls) {
  $$(`.card.${cls}`).forEach((el) => el.classList.remove(cls));
  for (const id of ids) $$(`.card[data-id="${CSS.escape(id)}"]`).forEach((el) => el.classList.add(cls));
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
  let folder = rootFolders().find((f) => f.title === title);
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
function syncSelectionUI() {
  document.body.classList.toggle('selecting', state.selected.size > 0);
  $$('.card[data-id]').forEach((el) => {
    const on = state.selected.has(el.dataset.id);
    el.classList.toggle('selected', on);
    el.querySelector('.sel')?.setAttribute('aria-pressed', String(on));
  });
  renderSelBar();
}
function toggleSelect(id) {
  if (!findCard(id)) return;
  state.selected.has(id) ? state.selected.delete(id) : state.selected.add(id);
  syncSelectionUI();
}
function clearSelection() {
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
  bar.innerHTML = `<span class="sel-count">已选 <b>${ids.length}</b> 个</span>
    <button class="sel-btn primary" data-action="sel-done" ${active.length ? '' : 'disabled'}>${CHECK_SVG}<span>一起完成并打包</span></button>
    <button class="sel-btn" data-action="sel-link" ${active.length > 1 ? '' : 'disabled'} title="以后长按其中任意一个都会整组打包">${LINK_SVG}<span>关联为一个项目</span></button>
    <button class="sel-btn" data-action="sel-prio" aria-haspopup="menu" title="设置优先级（也可按 1 / 2 / 3，0 清除）"><span class="prio" style="--pc:#e03131">急</span><span>优先级</span></button>
    <button class="sel-btn" data-action="sel-move" aria-haspopup="menu"><svg viewBox="0 0 24 24"><path d="M5 12h14m-5-5 5 5-5 5"/></svg><span>移到…</span></button>
    <button class="sel-btn danger" data-action="sel-trash"><svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13"/></svg><span>删除</span></button>
    <button class="sel-btn icon" data-action="sel-clear" aria-label="取消选择" title="取消选择（Esc）"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>`;
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
  for (let i = 0; i < sg.ids.length; i++) for (let j = i + 1; j < sg.ids.length; j++) dismissed.add(pairKey(sg.ids[i], sg.ids[j]));
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
  chip.innerHTML = `${SPARK_SVG}智能关联${n ? `<b>${n}</b>` : ''}`;
  chip.classList.toggle('has', n > 0);
  chip.title = n ? `发现 ${n} 条可能的项目关联，点击查看` : '自动关联设置与已识别的项目';
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
  // 拖动的是已选中的卡片 → 所有已选一起移动
  const group = state.selected.has(dragId) && state.selected.size > 1 ? [...state.selected] : null;
  if (target === PICK) {
    const fid = await pickFolder();
    if (!fid) return;
    if (group) { clearSelection(); return archiveCards(group.map(findCard).filter(Boolean), fid); }
    return archiveCards([findCard(dragId)].filter(Boolean), fid);
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
    setView(viewTab.dataset.view); return render();
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
  const zoneTab = e.target.closest('[data-zone]');
  if (zoneTab) { state.zone = zoneTab.dataset.zone; ls.set('zone', state.zone); return renderZones(), loadThumbs(); }
  const cardEl = e.target.closest('.card');
  const colEl = e.target.closest('.column');
  const col = colEl && area(colEl.dataset.colId);
  // 多选：Ctrl/⌘/Shift + 点击，或已在多选状态时直接点击 → 勾选 / 取消
  if (cardEl && !btn && (e.ctrlKey || e.metaKey || e.shiftKey || state.selected.size)) { toggleSelect(cardEl.dataset.id); return; }
  if (!btn) { if (cardEl) preview(cardEl.dataset.id); return; }
  switch (btn.dataset.action) {
    case 'accept-suggest': return acceptSuggestion(btn.dataset.id);
    case 'assoc-panel': return openAssocPanel();
    case 'select': return toggleSelect(cardEl.dataset.id);
    case 'sel-done': return completeCards([...state.selected]);
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
    case 'canvas-menu': return menuAnchor === btn ? closeMenu() : areaMenu(btn, area(state.view));
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
    case 'add-files': return $('#fileInput').click();
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
    case 'toggle-theme': return toggleTheme(btn);
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
  if (e.target.matches?.('[data-folder], [data-work]') && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); e.target.click(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#search').focus(); }
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
