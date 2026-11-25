import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32Blob, buildStoreZip } from '../zip.js';

test('crc32Blob matches standard IEEE 802.3 CRC-32 across strings and chunked Blobs', async () => {
  const empty = await crc32Blob('');
  assert.equal(empty.crc, 0);
  assert.equal(empty.size, 0);

  // Standard test vector: "123456789" -> 0xcbf43926
  const vecStr = await crc32Blob('123456789');
  assert.equal(vecStr.crc, 0xcbf43926);
  assert.equal(vecStr.size, 9);

  const rawBlob = new Blob(['1234', '56789'], { type: 'text/plain' });
  const vecBlob = await crc32Blob(rawBlob, { chunkSize: 3 });
  assert.equal(vecBlob.crc, 0xcbf43926);
  assert.equal(vecBlob.size, 9);
  assert.equal(vecBlob.blob, rawBlob);
});

test('buildStoreZip packs UTF-8 names, nested paths, and lazy Blobs with valid PKZIP structure', async () => {
  const progressEvents = [];
  const entries = [
    { name: '海报/主视觉.txt', data: '你好世界-ABC' },
    { name: 'empty.bin', data: new Uint8Array(0) },
    {
      name: 'video/clip.bin',
      size: 6,
      getData: async () => new Blob([new Uint8Array([10, 20, 30, 40, 50, 60])]),
    },
  ];

  const zipBlob = await buildStoreZip(entries, {
    concurrency: 2,
    onProgress: (p) => progressEvents.push({ ...p }),
  });

  assert.equal(zipBlob.type, 'application/zip');
  assert.ok(progressEvents.length >= 3);
  const last = progressEvents[progressEvents.length - 1];
  assert.equal(last.done, 3);
  assert.equal(last.total, 3);

  const buf = new Uint8Array(await zipBlob.arrayBuffer());
  const dv = new DataView(buf.buffer);
  const td = new TextDecoder();

  // Parse local headers from start
  let off = 0;
  const parsed = [];
  for (let i = 0; i < entries.length; i++) {
    assert.equal(dv.getUint32(off, true), 0x04034b50);
    const flag = dv.getUint16(off + 6, true);
    const method = dv.getUint16(off + 8, true);
    const crc = dv.getUint32(off + 14, true);
    const compSize = dv.getUint32(off + 18, true);
    const uncompSize = dv.getUint32(off + 22, true);
    const nameLen = dv.getUint16(off + 26, true);
    assert.equal(flag, 0x0800);
    assert.equal(method, 0);
    assert.equal(compSize, uncompSize);
    const name = td.decode(buf.slice(off + 30, off + 30 + nameLen));
    const payload = buf.slice(off + 30 + nameLen, off + 30 + nameLen + uncompSize);
    parsed.push({ name, crc, payload, localOffset: off });
    off += 30 + nameLen + uncompSize;
  }

  assert.equal(parsed[0].name, '海报/主视觉.txt');
  assert.equal(td.decode(parsed[0].payload), '你好世界-ABC');
  assert.equal(parsed[1].name, 'empty.bin');
  assert.equal(parsed[1].payload.byteLength, 0);
  assert.equal(parsed[2].name, 'video/clip.bin');
  assert.deepEqual([...parsed[2].payload], [10, 20, 30, 40, 50, 60]);

  // Parse Central Directory and EOCD
  const cdStart = off;
  for (let i = 0; i < entries.length; i++) {
    assert.equal(dv.getUint32(off, true), 0x02014b50);
    const cdNameLen = dv.getUint16(off + 28, true);
    const relOff = dv.getUint32(off + 42, true);
    assert.equal(relOff, parsed[i].localOffset);
    assert.equal(dv.getUint32(off + 16, true), parsed[i].crc);
    off += 46 + cdNameLen;
  }
  const cdSize = off - cdStart;

  assert.equal(dv.getUint32(off, true), 0x06054b50);
  assert.equal(dv.getUint16(off + 8, true), 3);
  assert.equal(dv.getUint16(off + 10, true), 3);
  assert.equal(dv.getUint32(off + 12, true), cdSize);
  assert.equal(dv.getUint32(off + 16, true), cdStart);
  assert.equal(off + 22, buf.byteLength);
});
