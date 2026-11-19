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

export async function getBlob(id) {
  const rec = await tx(['blobs'], 'readonly', (t) => wrap(t.objectStore('blobs').get(id)));
  return rec ? rec.data : null;
}

/** 原子写入卡片 + 文件内容，并回读校验大小，确保真正落盘。 */
export async function addFile(card, blob) {
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

export const deleteCard = (id) => tx(['cards', 'blobs'], 'readwrite', (t) => {
  t.objectStore('cards').delete(id);
  t.objectStore('blobs').delete(id);
});

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
  let offset = 0;
  for (const c of cards) {
    if (c.kind !== 'file') continue;
    const b = await getBlob(c.id);
    if (!b) continue;
    files.push({ id: c.id, offset, size: b.size, type: b.type });
    parts.push(b);
    offset += b.size;
  }
  const manifest = { app: 'personal-workbench', version: 1, exportedAt: Date.now(), columns, cards, files };
  const json = new TextEncoder().encode(JSON.stringify(manifest));
  const head = new Uint8Array(8);
  head.set(new TextEncoder().encode(MAGIC), 0);
  new DataView(head.buffer).setUint32(4, json.byteLength, true);
  return { blob: new Blob([head, json, ...parts], { type: 'application/octet-stream' }), count: cards.length, fileCount: files.length };
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
