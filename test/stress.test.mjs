import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import {
  MAX_AUTO_GROUP,
  MAX_SUGGEST_CLUSTER,
  buildAssocGroups,
  computeAssocSignature,
} from '../assoc.js';
import { computeCanvasPreviewLayout } from '../canvas-preview.js';
import { buildStoreZip } from '../zip.js';

function makeHeavyDataset(n, sameBatch = true) {
  const cards = [];
  const batch = sameBatch ? 'batch-1400' : null;
  const now = Date.now();
  for (let i = 0; i < n; i++) {
    const year = 1995 + (i % 30);
    cards.push({
      id: `spec-${i}`,
      kind: 'file',
      name: `[Specialist] ${year} Heffernan Education Paper_${i}.pdf`,
      columnId: 'col1',
      order: i * 1024,
      createdAt: now + (i % 50),
      ...(batch ? { batchId: batch } : {}),
    });
  }
  return cards;
}

test('assoc.js handles 1,500 mixed academic PDFs + download duplicates without freezing or mega-clustering', () => {
  const cards = makeHeavyDataset(1360, true);
  for (let i = 0; i < 100; i++) {
    cards.push({
      id: `dl-${i}`,
      kind: 'file',
      name: `download (${i + 1}).jpg`,
      columnId: 'col1',
      order: 2000000 + i * 1024,
      createdAt: Date.now(),
      batchId: 'batch-dl',
    });
  }
  cards.push(
    { id: 'proj-1', kind: 'file', name: '2027物理宣传册-封面.png', columnId: 'col1', order: 1, createdAt: Date.now() },
    { id: 'proj-2', kind: 'file', name: '2027物理宣传册-终稿.pdf', columnId: 'col1', order: 2, createdAt: Date.now() },
    { id: 'proj-3', kind: 'file', name: '2027物理宣传册-修改版.psd', columnId: 'col1', order: 3, createdAt: Date.now() },
  );

  const t0 = performance.now();
  const res = buildAssocGroups(cards, { sensKey: 'normal' });
  const elapsed = performance.now() - t0;

  assert.ok(elapsed < 120, `Expected < 120ms for 1,463 cards, took ${elapsed.toFixed(1)}ms`);

  // Legitimate project cards are grouped cleanly together
  const projGroup = res.groups.get('proj-1');
  assert.ok(projGroup && projGroup.includes('proj-2') && projGroup.includes('proj-3'));

  // Zero mega-clusters in groups or suggestions
  for (const ids of res.groups.values()) {
    assert.ok(ids.length <= MAX_AUTO_GROUP, `Auto group exceeded cap: ${ids.length}`);
  }
  for (const sg of res.suggestions) {
    assert.ok(sg.ids.length <= MAX_SUGGEST_CLUSTER, `Suggestion cluster exceeded cap: ${sg.ids.length}`);
  }
});

test('stress benchmark: 5,000 cards assoc, 400-shape canvas preview, and 300-entry streaming ZIP run smoothly', async () => {
  const cards = makeHeavyDataset(5000, true);
  const t0 = performance.now();
  const sig = computeAssocSignature(cards, 'normal', 0);
  const res = buildAssocGroups(cards, { sensKey: 'normal' });
  const assocMs = performance.now() - t0;

  const tSig = performance.now();
  const sig2 = computeAssocSignature(cards, 'normal', 0);
  const sigMs = performance.now() - tSig;

  assert.equal(sig, sig2);
  assert.ok(sigMs < 15, `Signature check took ${sigMs.toFixed(2)}ms`);
  assert.ok(assocMs < 350, `Expected < 350ms on 5,000 cards, took ${assocMs.toFixed(1)}ms`);
  assert.ok(res.groups.size === 5000);

  // Canvas preview layout benchmark on oversized board (200 cards + 400 shapes + 300 links)
  const cvCards = Array.from({ length: 200 }, (_, i) => ({
    id: `cc-${i}`,
    kind: 'file',
    name: `img_${i}.png`,
    mime: 'image/png',
    x: (i % 20) * 400,
    y: Math.floor(i / 20) * 320,
    order: i,
  }));
  const shapes = Array.from({ length: 400 }, (_, i) => ({
    id: `sh-${i}`,
    t: 'rect',
    x: (i % 20) * 420,
    y: Math.floor(i / 20) * 260,
    w: 180,
    h: 110,
    z: i,
  }));
  const links = Array.from({ length: 300 }, (_, i) => ({
    id: `lk-${i}`,
    from: { id: `sh-${i}` },
    to: { id: `sh-${(i + 1) % 400}` },
    end: 'arrow',
  }));
  const tCpv = performance.now();
  const layout = computeCanvasPreviewLayout(cvCards, shapes, links);
  const cpvMs = performance.now() - tCpv;
  assert.equal(layout.empty, false);
  assert.ok(cpvMs < 80, `Canvas preview layout took ${cpvMs.toFixed(1)}ms`);

  // 300-file streaming ZIP benchmark
  const zipEntries = Array.from({ length: 300 }, (_, i) => ({
    name: `folder/file_${i}.txt`,
    data: `content-payload-${i}`,
  }));
  const tZip = performance.now();
  const zipBlob = await buildStoreZip(zipEntries);
  const zipMs = performance.now() - tZip;
  assert.ok(zipBlob.size > 0);
  assert.ok(zipMs < 200, `300-entry STORE ZIP took ${zipMs.toFixed(1)}ms`);
});
