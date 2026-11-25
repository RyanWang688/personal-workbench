import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeRelPath,
  isIgnoredFile,
  extractFromFileList,
  buildUploadPlan,
  planFolderCreation,
} from '../upload-tree.js';

const mockFile = (name, size = 100, webkitRelativePath = '') => ({ name, size, webkitRelativePath });

test('normalizeRelPath and isIgnoredFile handle slashes and OS junk files', () => {
  assert.equal(normalizeRelPath('/2000\\Exam 1//paper.pdf/'), '2000/Exam 1/paper.pdf');
  assert.equal(isIgnoredFile('.DS_Store'), true);
  assert.equal(isIgnoredFile('Thumbs.db'), true);
  assert.equal(isIgnoredFile('desktop.ini'), true);
  assert.equal(isIgnoredFile('exam.pdf'), false);
});

test('buildUploadPlan preserves multi-folder 2000..2014 hierarchy in natural order and keeps empty dirs', () => {
  const rawFiles = [
    { file: mockFile('.DS_Store', 12), relPath: '2010/.DS_Store' },
    { file: mockFile('paper.pdf', 500), relPath: '2010/Exam 1/paper.pdf' },
    { file: mockFile('a.pdf', 200), relPath: '2002/a.pdf' },
    { file: mockFile('b.pdf', 300), relPath: '2000/b.pdf' },
    { file: mockFile('c.pdf', 400), relPath: '2014/Sub/Deep/c.pdf' },
  ];
  const rawDirs = ['2001', '2000', '2014/Sub/EmptyLeaf'];

  const plan = buildUploadPlan(rawFiles, rawDirs);
  assert.equal(plan.hasDirs, true);
  assert.deepEqual(plan.topDirs, ['2000', '2001', '2002', '2010', '2014']);
  assert.deepEqual(plan.dirPaths, [
    '2000',
    '2001',
    '2002',
    '2010',
    '2014',
    '2010/Exam 1',
    '2014/Sub',
    '2014/Sub/Deep',
    '2014/Sub/EmptyLeaf',
  ]);
  assert.equal(plan.stats.fileCount, 4);
  assert.equal(plan.stats.totalBytes, 1400);
  assert.equal(plan.stats.canStripRoot, false);
});

test('buildUploadPlan supports stripSingleRoot when selecting parent folder via webkitdirectory', () => {
  const rawFiles = extractFromFileList([
    mockFile('a.pdf', 120, '历年真题/2000/a.pdf'),
    mockFile('b.pdf', 240, '历年真题/2001/Exam/b.pdf'),
  ]).files;

  const kept = buildUploadPlan(rawFiles, [], { stripSingleRoot: false });
  assert.equal(kept.stats.canStripRoot, true);
  assert.equal(kept.stats.singleRootName, '历年真题');
  assert.deepEqual(kept.topDirs, ['历年真题']);
  assert.deepEqual(kept.dirPaths, ['历年真题', '历年真题/2000', '历年真题/2001', '历年真题/2001/Exam']);

  const stripped = buildUploadPlan(rawFiles, [], { stripSingleRoot: true });
  assert.deepEqual(stripped.topDirs, ['2000', '2001']);
  assert.deepEqual(stripped.dirPaths, ['2000', '2001', '2001/Exam']);
  assert.equal(stripped.files[0].dirPath, '2000');
  assert.equal(stripped.files[1].dirPath, '2001/Exam');
});

test('buildUploadPlan wraps loose files or multiple folders under wrapperName', () => {
  const wrappedLoose = buildUploadPlan(
    [{ file: mockFile('f1.png', 50), relPath: 'f1.png' }],
    [],
    { wrapperName: '课程包/2026' },
  );
  assert.equal(wrappedLoose.hasDirs, true);
  assert.deepEqual(wrappedLoose.dirPaths, ['课程包_2026']);
  assert.equal(wrappedLoose.files[0].relPath, '课程包_2026/f1.png');

  const wrappedDirs = buildUploadPlan(
    [
      { file: mockFile('a.pdf', 100), relPath: '2000/a.pdf' },
      { file: mockFile('b.pdf', 100), relPath: '2001/b.pdf' },
    ],
    [],
    { wrapperName: 'Specialist真题' },
  );
  assert.deepEqual(wrappedDirs.topDirs, ['Specialist真题']);
  assert.deepEqual(wrappedDirs.dirPaths, ['Specialist真题', 'Specialist真题/2000', 'Specialist真题/2001']);
});

test('planFolderCreation reuses matching (parentId, title) folders and chains parentIds cleanly', () => {
  const existing = [
    { id: 'f_2000', kind: 'folder', title: '2000', order: 0 },
    { id: 'f_other_exam', kind: 'folder', title: 'Exam 1', parentId: 'f_2001', order: 1024 },
  ];
  let seq = 1;
  const plan = buildUploadPlan([
    { file: mockFile('a.pdf', 10), relPath: '2000/Exam 1/a.pdf' },
    { file: mockFile('b.pdf', 10), relPath: '2001/Exam 1/b.pdf' },
    { file: mockFile('c.pdf', 10), relPath: '2002/c.pdf' },
  ]);

  const res = planFolderCreation(plan.dirPaths, existing, null, {
    baseOrder: 2048,
    colorStart: 2,
    category: '真题',
    now: 999999,
    makeId: () => `new_${seq++}`,
  });

  // '2000' existed -> reused f_2000; '2001' new; '2002' new; '2000/Exam 1' new (different parentId than f_2001!); '2001/Exam 1' new because parent '2001' got id new_1 != f_2001
  assert.equal(res.pathToFolderId.get('2000'), 'f_2000');
  assert.equal(res.createdFolders.find((f) => f.title === 'Exam 1' && f.parentId === 'f_2000')?.id !== undefined, true);
  assert.equal(res.createdFolders.find((f) => f.title === '2002')?.category, '真题');
  assert.equal(res.createdFolders.find((f) => f.title === '2002')?.parentId, undefined);
  assert.deepEqual(res.topFolderIds, ['f_2000', res.pathToFolderId.get('2001'), res.pathToFolderId.get('2002')]);
});
