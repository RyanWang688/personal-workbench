import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STICKER_CATS,
  STICKERS,
  stickerById,
  stickersInCat,
  clampStickerRot,
  createStickerShape,
} from '../stickers.js';

test('sticker catalog has unique IDs, valid categories, and positive dimensions', () => {
  const catIds = new Set(STICKER_CATS.map((c) => c.id));
  const ids = new Set();
  for (const s of STICKERS) {
    assert.ok(s.id, 'sticker must have id');
    assert.equal(ids.has(s.id), false, `duplicate sticker id: ${s.id}`);
    ids.add(s.id);
    assert.equal(catIds.has(s.cat), true, `invalid category for ${s.id}`);
    assert.ok(s.w > 0 && s.h > 0, `positive dimensions required for ${s.id}`);
    if (s.kind === 'emoji') assert.ok(s.emoji);
    else assert.ok(s.bg && s.fg && s.icon && s.label);
  }
  assert.equal(stickersInCat('status').length, 10);
  assert.equal(stickersInCat('emoji').length, 16);
});

test('stickerById resolves presets and falls back to done', () => {
  assert.equal(stickerById('done').label, '已完成');
  assert.equal(stickerById('e-fire').emoji, '🔥');
  assert.equal(stickerById('nonexistent').id, 'done');
});

test('clampStickerRot clamps tilt angles cleanly within [-45, 45]', () => {
  assert.equal(clampStickerRot(0), 0);
  assert.equal(clampStickerRot(-12.4), -12);
  assert.equal(clampStickerRot(-90), -45);
  assert.equal(clampStickerRot(120), 45);
  assert.equal(clampStickerRot(Number.NaN), 0);
});

test('createStickerShape centers around pointer coordinates and sets stamp defaults', () => {
  const done = createStickerShape('done', 300, 200, { id: 's1', z: 5 });
  assert.deepEqual(done, {
    id: 's1',
    t: 'sticker',
    sk: 'done',
    x: 300 - 116 / 2,
    y: 200 - 44 / 2,
    w: 116,
    h: 44,
    rot: -5,
    text: '已完成',
    fill: 'none',
    fs: 16,
    al: 'center',
    z: 5,
  });

  const custom = createStickerShape('wip', 100, 100, { id: 's2', text: 'V2 开发中' });
  assert.equal(custom.text, 'V2 开发中');

  const emoji = createStickerShape('e-rocket', 200, 150, { id: 's3', z: 9 });
  assert.equal(emoji.sk, 'e-rocket');
  assert.equal(emoji.x, 200 - 38);
  assert.equal(emoji.y, 150 - 38);
  assert.equal(emoji.text, '');
});
