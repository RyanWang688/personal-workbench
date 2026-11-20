// IndexedDB 数据层：卡片元数据与文件内容分库存放，写入后回读校验。
const DB_NAME = 'personal-workbench';
const DB_VERSION = 1;
let dbPromise = null;

export function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('当前浏览器不支持 IndexedDB'));
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('columns')) d.createObjectStore('columns', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('cards')) d.createObjectStore('cards', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('blobs')) d.createObjectStore('blobs', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => {
      const d = req.result;
      d.onversionchange = () => { d.close(); location.reload(); };
      resolve(d);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('数据库被其他标签页占用，请关闭其他标签页后刷新'));
  });
  return dbPromise;
}

const wrap = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

async function tx(stores, mode, fn) {
  const d = await open();
  return new Promise((resolve, reject) => {
    const t = d.transaction(stores, mode);
    let out;
    try { out = fn(t); } catch (e) { try { t.abort(); } catch {} return reject(e); }
    t.oncomplete = () => Promise.resolve(out).then(resolve, reject);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('事务已中止'));
  });
}

export const getAll = (store) => tx([store], 'readonly', (t) => wrap(t.objectStore(store).getAll()));
export const put = (store, value) => tx([store], 'readwrite', (t) => { t.objectStore(store).put(value); });
export const putMany = (store, values) => tx([store], 'readwrite', (t) => { const s = t.objectStore(store); values.forEach((v) => s.put(v)); });
export const del = (store, key) => tx([store], 'readwrite', (t) => { t.objectStore(store).delete(key); });

const getRec = (id) => tx(['blobs'], 'readonly', (t) => wrap(t.objectStore('blobs').get(id)));

// ---------- 扩容：把文件存到电脑上的文件夹（File System Access API，Chrome / Edge） ----------
// blobs 表里，存在文件夹的文件记录为 { id, ext: '<文件名>', type, size }，内容在「所选文件夹/工作台文件/」里。
export const FOLDER_SUB = '工作台文件';
export const folderSupported = () => typeof window.showDirectoryPicker === 'function';
let dirCache;
export async function getDir() {
  if (dirCache === undefined) dirCache = await getMeta('dirHandle', null);
  return dirCache;
}
export async function setDir(handle) { dirCache = handle; await setMeta('dirHandle', handle); }
export async function clearDir() { dirCache = null; await del('meta', 'dirHandle'); await setMeta('storageMode', 'idb'); }
export const storageMode = async () => ((await getMeta('storageMode', 'idb')) === 'folder' && (await getDir()) ? 'folder' : 'idb');
/** 文件夹访问权限：'granted' | 'prompt' | 'denied' | 'none'；request=true 时会弹出浏览器授权（需在用户点击中调用） */
export async function dirPermission(request = false) {
  const d = await getDir();
  if (!d) return 'none';
  if (!d.queryPermission) return 'granted';
  let p = await d.queryPermission({ mode: 'readwrite' });
  if (p !== 'granted' && request) p = await d.requestPermission({ mode: 'readwrite' }).catch(() => 'denied');
  return p;
}
const permError = () => Object.assign(new Error('需要授权访问存储文件夹'), { code: 'NEED_PERMISSION' });
async function filesDir() {
  const d = await getDir();
  if (!d) throw new Error('未设置存储文件夹');
  if ((await dirPermission()) !== 'granted') throw permError();
  return d.getDirectoryHandle(FOLDER_SUB, { create: true });
}
const safeName = (n) => (n || '文件').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 120);
async function writeExternal(id, name, blob) {
  const fd = await filesDir();
  const fname = `${id.slice(0, 8)}__${safeName(name)}`;
  const fh = await fd.getFileHandle(fname, { create: true });
  const w = await fh.createWritable();
  try { await w.write(blob); await w.close(); } catch (e) { await w.abort?.().catch(() => {}); throw e; }
  const check = await fh.getFile();
  if (check.size !== blob.size) { await fd.removeEntry(fname).catch(() => {}); throw new Error('写入文件夹后校验失败'); }
  return fname;
}
async function readExternal(fname, type) {
  const fd = await filesDir();
  try {
    const f = await (await fd.getFileHandle(fname)).getFile();
    return type && f.type !== type ? new File([f], f.name, { type }) : f;
  } catch (e) {
    if (e.code === 'NEED_PERMISSION') throw e;
    throw new Error(`存储文件夹里找不到「${fname.replace(/^[^_]+__/, '')}」，可能被移动或删除了`);
  }
}
async function removeExternal(fname) { try { await (await filesDir()).removeEntry(fname); } catch {} }

export async function getBlob(id) {
  const rec = await getRec(id);
  if (!rec) return null;
  if (rec.ext) return readExternal(rec.ext, rec.type);
  return rec.data;
}
export async function isExternal(id) { return !!(await getRec(id))?.ext; }

/** 写入卡片 + 文件内容并回读校验大小，确保真正落盘。文件夹模式下文件写到电脑文件夹，否则写进浏览器数据库。 */
export async function addFile(card, blob) {
  if ((await storageMode()) === 'folder' && (await dirPermission()) === 'granted') {
    const fname = await writeExternal(card.id, card.name, blob);
    await tx(['cards', 'blobs'], 'readwrite', (t) => {
      t.objectStore('blobs').put({ id: card.id, ext: fname, type: blob.type, size: blob.size });
      t.objectStore('cards').put(card);
    });
    return;
  }
  await tx(['cards', 'blobs'], 'readwrite', (t) => {
    t.objectStore('blobs').put({ id: card.id, data: blob, type: blob.type, size: blob.size });
    t.objectStore('cards').put(card);
  });
  const check = await getBlob(card.id);
  if (!check || check.size !== blob.size) {
    await deleteCard(card.id).catch(() => {});
    throw new Error(`「${card.name}」写入校验失败`);
  }
}

export async function deleteCard(id) {
  const rec = await getRec(id).catch(() => null);
  await tx(['cards', 'blobs'], 'readwrite', (t) => {
    t.objectStore('cards').delete(id);
    t.objectStore('blobs').delete(id);
    t.objectStore('blobs').delete(`thumb:${id}`);
  });
  if (rec?.ext) await removeExternal(rec.ext);
}

/** 统计文件分布：浏览器内 / 文件夹内 */
export async function storageStats() {
  const recs = await getAll('blobs');
  const s = { idbCount: 0, idbBytes: 0, extCount: 0, extBytes: 0 };
  for (const r of recs) {
    if (String(r.id).startsWith('thumb:')) continue;
    if (r.ext) { s.extCount++; s.extBytes += r.size || 0; } else { s.idbCount++; s.idbBytes += r.size || r.data?.size || 0; }
  }
  return s;
}
/** 把浏览器里的文件逐个迁移到文件夹：写入并核对大小后，才从浏览器删除 */
export async function migrateToFolder(onProgress) {
  const cards = new Map((await getAll('cards')).map((c) => [c.id, c]));
  const keys = (await tx(['blobs'], 'readonly', (t) => wrap(t.objectStore('blobs').getAllKeys()))).filter((k) => !String(k).startsWith('thumb:'));
  let done = 0, moved = 0, bytes = 0;
  for (const id of keys) {
    const rec = await getRec(id);
    if (rec && !rec.ext && rec.data) {
      const fname = await writeExternal(id, cards.get(id)?.name || id, rec.data);
      await put('blobs', { id, ext: fname, type: rec.type || rec.data.type, size: rec.data.size });
      moved++; bytes += rec.data.size;
    }
    onProgress?.(++done, keys.length);
  }
  return { moved, bytes };
}
/** 反向：把文件夹里的文件搬回浏览器（停止使用文件夹时） */
export async function migrateToBrowser(onProgress) {
  const keys = (await tx(['blobs'], 'readonly', (t) => wrap(t.objectStore('blobs').getAllKeys()))).filter((k) => !String(k).startsWith('thumb:'));
  let done = 0, moved = 0;
  for (const id of keys) {
    const rec = await getRec(id);
    if (rec?.ext) {
      const f = await readExternal(rec.ext, rec.type);
      const data = new Blob([await f.arrayBuffer()], { type: rec.type || f.type });
      await put('blobs', { id, data, type: data.type, size: data.size });
      const check = await getRec(id);
      if (!check?.data || check.data.size !== f.size) throw new Error('搬回浏览器后校验失败，已停止，文件夹里的原文件保留');
      await removeExternal(rec.ext);
      moved++;
    }
    onProgress?.(++done, keys.length);
  }
  return { moved };
}
// 缩略图与原文件分开存（id 前缀 thumb:），不进备份，可随时重新生成
export const putThumb = (id, blob) => put('blobs', { id: `thumb:${id}`, data: blob, type: blob.type, size: blob.size });
export const getThumb = (id) => getBlob(`thumb:${id}`);

export async function getMeta(key, fallback = null) {
  const rec = await tx(['meta'], 'readonly', (t) => wrap(t.objectStore('meta').get(key)));
  return rec ? rec.value : fallback;
}
export const setMeta = (key, value) => put('meta', { key, value });

// ---------- 备份文件格式 (.wbk) ----------
// [ "WBK1" 4字节 ][ 清单长度 uint32 LE ][ 清单 JSON (UTF-8) ][ 文件内容依次拼接 ]
const MAGIC = 'WBK1';

export async function exportBackup() {
  const [columns, cards] = await Promise.all([getAll('columns'), getAll('cards')]);
  const parts = [];
  const files = [];
  let offset = 0, missing = 0;
  for (const c of cards) {
    if (c.kind !== 'file') continue;
    let b;
    try { b = await getBlob(c.id); } catch (e) { if (e.code === 'NEED_PERMISSION') throw e; missing++; continue; } // 文件夹里被删的文件：跳过，不让整个备份失败
    if (!b) continue;
    files.push({ id: c.id, offset, size: b.size, type: b.type });
    parts.push(b);
    offset += b.size;
  }
  // 分类列表（含空分类）也一起备份
  const meta = { categories: await getMeta('categories', []), workCategories: await getMeta('workCategories', []) };
  const manifest = { app: 'personal-workbench', version: 1, exportedAt: Date.now(), columns, cards, files, meta };
  const json = new TextEncoder().encode(JSON.stringify(manifest));
  const head = new Uint8Array(8);
  head.set(new TextEncoder().encode(MAGIC), 0);
  new DataView(head.buffer).setUint32(4, json.byteLength, true);
  return { blob: new Blob([head, json, ...parts], { type: 'application/octet-stream' }), count: cards.length, fileCount: files.length, missing };
}

export async function readBackup(file) {
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  if (new TextDecoder().decode(head.slice(0, 4)) !== MAGIC) throw new Error('不是有效的工作台备份文件');
  const len = new DataView(head.buffer).getUint32(4, true);
  const manifest = JSON.parse(await file.slice(8, 8 + len).text());
  if (manifest.app !== 'personal-workbench') throw new Error('备份文件来源不匹配');
  return { manifest, base: 8 + len, file };
}

export async function importBackup({ manifest, base, file }, onProgress) {
  await putMany('columns', manifest.columns || []);
  for (const key of ['categories', 'workCategories']) {
    const add = manifest.meta?.[key];
    if (Array.isArray(add) && add.length) await setMeta(key, [...new Set([...(await getMeta(key, [])), ...add])]);
  }
  const fileMap = new Map((manifest.files || []).map((f) => [f.id, f]));
  let done = 0;
  for (const card of manifest.cards || []) {
    const f = fileMap.get(card.id);
    if (card.kind === 'file' && f) {
      const data = file.slice(base + f.offset, base + f.offset + f.size, f.type);
      // 读成独立 Blob，避免引用备份文件本身
      const blob = new Blob([await data.arrayBuffer()], { type: f.type });
      await addFile(card, blob);
    } else if (card.kind === 'note') {
      await put('cards', card);
    }
    onProgress && onProgress(++done, manifest.cards.length);
  }
  return done;
}
