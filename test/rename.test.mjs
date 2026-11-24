import test from 'node:test';
import assert from 'node:assert/strict';
import {
  splitCardName,
  joinCardName,
  formatSeqNumber,
  applySequenceRule,
  applyReplaceRule,
} from '../rename.js';

test('splitCardName splits extensions accurately while preserving multi-dot stems, dotfiles, and notes', () => {
  assert.deepEqual(splitCardName('download.jpg'), { stem: 'download', ext: '.jpg' });
  assert.deepEqual(splitCardName('2026.v2.poster.PNG'), { stem: '2026.v2.poster', ext: '.PNG' });
  assert.deepEqual(splitCardName('.gitignore'), { stem: '.gitignore', ext: '' });
  assert.deepEqual(splitCardName('无后缀文档'), { stem: '无后缀文档', ext: '' });
  assert.deepEqual(splitCardName('待办事项.md', true), { stem: '待办事项.md', ext: '' });
});

test('joinCardName deduplicates pasted extensions and falls back on blank input', () => {
  assert.equal(joinCardName('春季海报', '.jpg', 'download.jpg'), '春季海报.jpg');
  assert.equal(joinCardName('  春季海报.JPG  ', '.jpg', 'download.jpg'), '春季海报.jpg');
  assert.equal(joinCardName('   ', '.jpg', 'download.jpg'), 'download.jpg');
  assert.equal(joinCardName('.jpg', '.jpg', 'download.jpg'), 'download.jpg');
  assert.equal(joinCardName('个人便签\n\t', '', '默认便签'), '个人便签');
});

test('applySequenceRule numbers batch items cleanly with custom prefix, separator, and original stem mode', () => {
  const items = [
    { origStem: 'download', ext: '.jpg' },
    { origStem: 'download', ext: '.jpg' },
    { origStem: 'photo_raw', ext: '.png' },
  ];

  assert.deepEqual(
    applySequenceRule(items, { base: '作品集', sep: '_', numStyle: '01', start: 1 }),
    ['作品集_01', '作品集_02', '作品集_03'],
  );

  assert.deepEqual(
    applySequenceRule(items, { base: 'poster', sep: '-', numStyle: '001', start: 5 }),
    ['poster-005', 'poster-006', 'poster-007'],
  );

  assert.deepEqual(
    applySequenceRule(items, { keepOrig: true, numStyle: '(1)', start: 1 }),
    ['download (1)', 'download (2)', 'photo_raw (3)'],
  );

  assert.equal(formatSeqNumber(7, '01'), '07');
  assert.equal(formatSeqNumber(12, '1'), '12');
});

test('applyReplaceRule replaces substrings and adds prefixes/suffixes safely', () => {
  const stems = ['download', 'download_v2', 'hero_shot'];
  assert.deepEqual(
    applyReplaceRule(stems, { find: 'download', replace: '海报', prefix: '2026-', suffix: '_定稿' }),
    ['2026-海报_定稿', '2026-海报_v2_定稿', '2026-hero_shot_定稿'],
  );
  assert.deepEqual(
    applyReplaceRule(['  foo  '], { prefix: 'pre_', suffix: '' }),
    ['pre_  foo'],
  );
});
