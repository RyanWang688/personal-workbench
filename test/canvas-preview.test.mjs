import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PREVIEW_W,
  PREVIEW_H,
  estimateCardHeight,
  computeCanvasPreviewLayout,
} from '../canvas-preview.js';

test('computeCanvasPreviewLayout handles empty canvas cleanly', () => {
  const layout = computeCanvasPreviewLayout([], [], []);
  assert.equal(layout.empty, true);
  assert.equal(layout.width, PREVIEW_W);
  assert.equal(layout.height, PREVIEW_H);
  assert.deepEqual(layout.cards, []);
  assert.deepEqual(layout.shapes, []);
  assert.deepEqual(layout.links, []);
});

test('computeCanvasPreviewLayout caps scale and centers a single small sticky note', () => {
  const sticky = { id: 's1', t: 'sticky', x: 500, y: 400, w: 200, h: 200, fill: 0, text: 'Idea' };
  const layout = computeCanvasPreviewLayout([], [sticky], []);
  assert.equal(layout.empty, false);
  assert.ok(layout.scale <= 0.45);
  assert.equal(layout.shapes.length, 1);
  const s = layout.shapes[0];
  // Centered horizontally & vertically around PREVIEW_W / 2 and PREVIEW_H / 2
  const cx = s.x + s.w / 2;
  const cy = s.y + s.h / 2;
  assert.ok(Math.abs(cx - PREVIEW_W / 2) < 0.01);
  assert.ok(Math.abs(cy - PREVIEW_H / 2) < 0.01);
});

test('computeCanvasPreviewLayout fits negative coordinates, sorts frames first, and projects cards inside bounds', () => {
  const shapes = [
    { id: 's1', t: 'rect', x: -300, y: -200, w: 200, h: 120, fill: 4, z: 2, frame: false },
    { id: 'f1', t: 'round', x: -360, y: -260, w: 900, h: 600, fill: 6, z: 5, frame: true },
  ];
  const cards = [
    { id: 'c2', kind: 'file', name: 'poster.png', mime: 'image/png', info: { w: 1600, h: 900 }, x: 180, y: 100, order: 20 },
    { id: 'c1', kind: 'note', name: 'Todo', x: -100, y: 50, order: 10 },
  ];
  const layout = computeCanvasPreviewLayout(cards, shapes, []);
  assert.equal(layout.empty, false);
  // Frame sorts before non-frame even though z was higher
  assert.equal(layout.shapes[0].id, 'f1');
  assert.equal(layout.shapes[1].id, 's1');
  // Cards sorted by order
  assert.equal(layout.cards[0].id, 'c1');
  assert.equal(layout.cards[1].id, 'c2');
  assert.equal(estimateCardHeight(cards[1], 232), 132);
  assert.ok(estimateCardHeight(cards[0], 360) > 200);

  for (const item of [...layout.shapes, ...layout.cards]) {
    assert.ok(item.x >= 0 && item.x + item.w <= PREVIEW_W + 0.01);
    assert.ok(item.y >= 0 && item.y + item.h <= PREVIEW_H + 0.01);
  }
  for (const c of layout.cards) {
    assert.ok(c.leftPct >= 0 && c.leftPct <= 100);
    assert.ok(c.topPct >= 0 && c.topPct <= 100);
    assert.ok(c.widthPct > 0 && c.widthPct <= 100);
    assert.ok(c.heightPct > 0 && c.heightPct <= 100);
  }
});

test('computeCanvasPreviewLayout builds straight and curved link paths with arrowheads', () => {
  const shapes = [
    { id: 's1', t: 'rect', x: 0, y: 0, w: 200, h: 120, fill: 4 },
    { id: 's2', t: 'diamond', x: 420, y: 120, w: 180, h: 140, fill: 3 },
  ];
  const cards = [
    { id: 'c1', kind: 'note', name: 'Brief', x: 0, y: 260, order: 1 },
  ];
  const links = [
    { id: 'l1', from: { id: 's1' }, to: { id: 's2' }, curve: false, end: 'arrow', color: '#3b82f6' },
    { id: 'l2', from: { id: 's2' }, to: { id: 'c1' }, curve: true, end: 'both', dash: true },
  ];
  const layout = computeCanvasPreviewLayout(cards, shapes, links);
  assert.equal(layout.links.length, 2);
  assert.match(layout.links[0].d, /^M[\d.]+ [\d.]+L[\d.]+ [\d.]+$/);
  assert.equal(layout.links[0].heads.length, 1);
  assert.equal(layout.links[0].color, '#3b82f6');
  assert.match(layout.links[1].d, /^M[\d.]+ [\d.]+C/);
  assert.equal(layout.links[1].dash, true);
  assert.equal(layout.links[1].heads.length, 2);
});
