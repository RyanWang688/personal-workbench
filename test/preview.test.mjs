import assert from 'node:assert/strict';
import test from 'node:test';
import { convert, conversionsFor, pdfSplitRanges } from '../preview.js';

test('PDF files offer the new actions even without a thumbnail', () => {
  const options = conversionsFor({ name: 'document.pdf' }, false).map(({ id }) => id);
  for (const id of ['pdf-jpg', 'pdf-md', 'pdf-compress', 'pdf-split']) assert.ok(options.includes(id));
});

test('PDF split groups preserve the requested order and default to single pages', () => {
  assert.deepEqual(pdfSplitRanges('7–８、１-３，5', 8), [[7, 8], [1, 3], [5, 5]]);
  assert.deepEqual(pdfSplitRanges('', 3), [[1, 1], [2, 2], [3, 3]]);
  assert.deepEqual(pdfSplitRanges('1-2, 1-2, 2', 3), [[1, 2], [2, 2]]);
  for (const invalid of ['0', '4', '3-1', '1-', 'two']) assert.throws(() => pdfSplitRanges(invalid, 3));
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
