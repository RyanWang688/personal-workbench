import assert from 'node:assert/strict';
import test from 'node:test';
import { convert, conversionsFor, pdfSplitParts } from '../preview.js';

test('PDF files offer the new actions even without a thumbnail', () => {
  const options = conversionsFor({ name: 'document.pdf' }, false).map(({ id }) => id);
  for (const id of ['pdf-jpg', 'pdf-md', 'pdf-compress', 'pdf-split']) assert.ok(options.includes(id));
});

test('PDF split exports nonempty groups in part order and keeps pages in source order', () => {
  const assignments = new Map([[8, 3], [4, 1], [5, 3], [2, 1]]);
  assert.deepEqual(pdfSplitParts(assignments, 8), [
    { part: 1, pages: [2, 4] },
    { part: 3, pages: [5, 8] },
  ]);
  assert.deepEqual(pdfSplitParts(new Map(), 8), []);
  assert.throws(() => pdfSplitParts(new Map([[9, 1]]), 8), /页码/);
  assert.throws(() => pdfSplitParts(new Map([[2, 0]]), 8), /部分/);
});

test('PDF to Markdown keeps page order and reports pages without extractable text', async () => {
  const previousWindow = globalThis.window;
  let destroyed = 0;
  let pages = ['First page', 'Second page'];
  globalThis.window = {
    pdfjsLib: {
      getDocument: () => ({
        promise: Promise.resolve({
          numPages: pages.length,
          getPage: async (n) => ({
            getTextContent: async () => ({ items: [{ str: pages[n - 1], hasEOL: true }] }),
          }),
          destroy: () => { destroyed++; },
        }),
      }),
    },
  };
  try {
    const card = { name: 'document.pdf' };
    const input = new Blob(['PDF fixture']);
    const [markdown] = await convert(card, input, 'pdf-md');
    assert.equal(markdown.name, 'document.md');
    assert.equal(await markdown.text(), '## 第 1 页\n\nFirst page\n\n## 第 2 页\n\nSecond page');
    pages = [' ', ''];
    await assert.rejects(convert(card, input, 'pdf-md'), /OCR/);
    assert.equal(destroyed, 2);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});
