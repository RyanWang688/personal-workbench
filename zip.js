// Zero-copy streaming PKZIP (STORE) builder: processes Blobs in 4 MB slices
// so exporting large videos or thousands of files uses minimal peak memory.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

const encoder = new TextEncoder();

export function crc32Update(crc, u8) {
  let c = crc >>> 0;
  for (let i = 0; i < u8.length; i++) {
    c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  }
  return c >>> 0;
}

function dosDateTime(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date || Date.now());
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() >> 1) & 31);
  const dosDate = (((Math.max(1980, d.getFullYear()) - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { time, date: dosDate };
}

/**
 * Compute IEEE 802.3 CRC-32 and byte length for a Blob, Uint8Array, or string
 * while keeping the original Blob reference untouched (zero-copy).
 */
export async function crc32Blob(data, { chunkSize = 4 * 1024 * 1024, onBytes } = {}) {
  if (data == null) return { crc: 0, size: 0, blob: new Uint8Array(0) };

  if (typeof data === 'string') {
    const u8 = encoder.encode(data);
    const crc = (crc32Update(0xffffffff, u8) ^ 0xffffffff) >>> 0;
    if (u8.byteLength) onBytes?.(u8.byteLength);
    return { crc, size: u8.byteLength, blob: u8 };
  }

  if (data instanceof Uint8Array || data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
    const u8 = data instanceof Uint8Array
      ? data
      : new Uint8Array(data.buffer || data, data.byteOffset || 0, data.byteLength);
    const crc = (crc32Update(0xffffffff, u8) ^ 0xffffffff) >>> 0;
    if (u8.byteLength) onBytes?.(u8.byteLength);
    return { crc, size: u8.byteLength, blob: u8 };
  }

  if (typeof data.slice === 'function') {
    const size = Number(data.size) || 0;
    let crc = 0xffffffff;
    for (let off = 0; off < size; off += chunkSize) {
      const end = Math.min(size, off + chunkSize);
      const buf = await data.slice(off, end).arrayBuffer();
      const u8 = new Uint8Array(buf);
      crc = crc32Update(crc, u8);
      if (u8.byteLength) onBytes?.(u8.byteLength);
    }
    return { crc: (crc ^ 0xffffffff) >>> 0, size, blob: data };
  }

  throw new TypeError('Unsupported ZIP entry data type');
}

/**
 * Build a standard STORE (uncompressed) PKZIP Blob from `{ name, data?, getData? }`
 * entries with bounded CRC hashing concurrency and original Blob retention.
 */
export async function buildStoreZip(entries = [], { concurrency = 4, onProgress } = {}) {
  const list = entries || [];
  const total = list.length;
  const now = dosDateTime();
  const results = new Array(total);

  let bytesTotal = 0;
  for (const e of list) {
    if (Number.isFinite(e?.size)) bytesTotal += e.size;
    else if (Number.isFinite(e?.data?.size)) bytesTotal += e.data.size;
    else if (typeof e?.data === 'string') bytesTotal += encoder.encode(e.data).byteLength;
    else if (e?.data instanceof Uint8Array) bytesTotal += e.data.byteLength;
  }

  let nextIdx = 0;
  let done = 0;
  let bytesDone = 0;
  const workers = Math.min(total, Math.max(1, concurrency));

  const runWorker = async () => {
    while (nextIdx < total) {
      const i = nextIdx++;
      const entry = list[i];
      const raw = entry.getData ? await entry.getData() : entry.data;
      const known = Number.isFinite(entry?.size) || Number.isFinite(entry?.data?.size)
        || typeof entry?.data === 'string' || entry?.data instanceof Uint8Array;
      if (!known && raw) {
        if (typeof raw === 'string') bytesTotal += encoder.encode(raw).byteLength;
        else if (Number.isFinite(raw.size)) bytesTotal += raw.size;
        else if (Number.isFinite(raw.byteLength)) bytesTotal += raw.byteLength;
      }
      const hashed = await crc32Blob(raw, {
        onBytes: (n) => {
          bytesDone += n;
          onProgress?.({ done, total, bytesDone, bytesTotal: Math.max(bytesDone, bytesTotal) });
        },
      });
      results[i] = {
        nameBytes: encoder.encode(String(entry.name || `file-${i + 1}`)),
        crc: hashed.crc >>> 0,
        size: hashed.size >>> 0,
        blob: hashed.blob,
      };
      done++;
      onProgress?.({ done, total, bytesDone, bytesTotal: Math.max(bytesDone, bytesTotal) });
    }
  };

  await Promise.all(Array.from({ length: workers }, () => runWorker()));

  const parts = [];
  const cdParts = [];
  let offset = 0;
  let cdSize = 0;

  for (const r of results) {
    const nl = r.nameBytes.byteLength;
    const lh = new Uint8Array(30 + nl);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // UTF-8 filename flag
    lv.setUint16(8, 0, true); // STORE compression method
    lv.setUint16(10, now.time, true);
    lv.setUint16(12, now.date, true);
    lv.setUint32(14, r.crc, true);
    lv.setUint32(18, r.size, true);
    lv.setUint32(22, r.size, true);
    lv.setUint16(26, nl, true);
    lv.setUint16(28, 0, true);
    lh.set(r.nameBytes, 30);
    parts.push(lh);
    if (r.size > 0) parts.push(r.blob);

    const cd = new Uint8Array(46 + nl);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, now.time, true);
    cv.setUint16(14, now.date, true);
    cv.setUint32(16, r.crc, true);
    cv.setUint32(20, r.size, true);
    cv.setUint32(24, r.size, true);
    cv.setUint16(28, nl, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    cd.set(r.nameBytes, 46);
    cdParts.push(cd);

    offset += lh.byteLength + r.size;
    cdSize += cd.byteLength;
  }

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, results.length, true);
  ev.setUint16(10, results.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  return new Blob([...parts, ...cdParts, eocd], { type: 'application/zip' });
}
