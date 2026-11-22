// 文件智能预览：缩略图生成、富预览、格式转换。第三方库全部按需从 cdnjs 懒加载。
const CDN = 'https://cdnjs.cloudflare.com/ajax/libs/';
const LIBS = {
  pdf: { src: `${CDN}pdf.js/3.11.174/pdf.min.js`, global: 'pdfjsLib', init: (l) => { l.GlobalWorkerOptions.workerSrc = `${CDN}pdf.js/3.11.174/pdf.worker.min.js`; } },
  pdfLib: { src: `${CDN}pdf-lib/1.17.1/pdf-lib.min.js`, global: 'PDFLib' },
  turndown: { src: 'https://cdn.jsdelivr.net/npm/turndown@7.2.0/dist/turndown.js', global: 'TurndownService' },
  zip: { src: `${CDN}jszip/3.10.1/jszip.min.js`, global: 'JSZip' },
  mammoth: { src: `${CDN}mammoth/1.6.0/mammoth.browser.min.js`, global: 'mammoth' },
  xlsx: { src: `${CDN}xlsx/0.18.5/xlsx.full.min.js`, global: 'XLSX' },
  jspdf: { src: `${CDN}jspdf/2.5.1/jspdf.umd.min.js`, global: 'jspdf' },
  marked: { src: `${CDN}marked/4.3.0/marked.min.js`, global: 'marked' },
  purify: { src: `${CDN}dompurify/3.0.6/purify.min.js`, global: 'DOMPurify' },
};
const loading = {};
export function lib(name) {
  const L = LIBS[name];
  if (window[L.global]) return Promise.resolve(window[L.global]);
  return loading[name] || (loading[name] = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = L.src; s.async = true; s.crossOrigin = 'anonymous';
    s.onload = () => { const g = window[L.global]; L.init?.(g); resolve(g); };
    s.onerror = () => { delete loading[name]; reject(new Error('组件加载失败，请检查网络')); };
    document.head.appendChild(s);
  }));
}
const sanitize = async (html) => (await lib('purify')).sanitize(html, { FORBID_TAGS: ['style', 'form', 'input'], FORBID_ATTR: ['style'] });

// ---------- 类型 ----------
export const extOf = (name) => (/\.([a-z0-9]+)$/i.exec(name || '') || [, ''])[1].toLowerCase();
const baseName = (name) => (name || '文件').replace(/\.[^.]+$/, '');
const TEXT_EXT = /^(txt|log|ini|cfg|conf|json|xml|yml|yaml|toml|js|mjs|ts|jsx|tsx|py|java|c|cpp|h|cs|go|rs|rb|php|html|htm|css|scss|sh|ps1|bat|sql|swift|kt|vue|svelte|tex|srt|vtt)$/;
export function family(card) {
  const e = extOf(card.name), t = card.type || '';
  if (/^(heic|heif)$/.test(e)) return 'other';
  if (t.startsWith('image/') || /^(png|jpe?g|gif|webp|svg|bmp|avif|ico)$/.test(e)) return 'image';
  if (t.startsWith('video/') || /^(mp4|mov|webm|mkv|m4v|avi)$/.test(e)) return 'video';
  if (t.startsWith('audio/') || /^(mp3|wav|m4a|flac|ogg|oga|aac|opus)$/.test(e)) return 'audio';
  if (e === 'pdf' || t === 'application/pdf' || e === 'ai') return 'pdf';
  if (/^(afpub|afdesign|afphoto)$/.test(e)) return 'affinity';
  if (e === 'docx') return 'docx';
  if (/^(xlsx|xlsm|xls|ods|csv|tsv)$/.test(e)) return 'sheet';
  if (/^(md|markdown)$/.test(e)) return 'md';
  if (/^(pptx|odp|odt|key|pages|numbers|sketch|xd|epub)$/.test(e)) return 'zipdoc';
  if (t.startsWith('text/') || TEXT_EXT.test(e)) return 'text';
  return 'other';
}
// 可能生成缩略图的类型（生成期间显示骨架屏）
export const likelyThumb = (card) => !['other'].includes(family(card));

// ---------- 工具 ----------
const MAXW = 480;
const toBlob = (c, type = 'image/webp', q = 0.86) => new Promise((r) => c.toBlob(r, type, q));
function canvas(w, h) { const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; }
async function decodeImage(blob) {
  try { return await createImageBitmap(blob); } catch {}
  const url = URL.createObjectURL(blob);
  try { const img = new Image(); img.src = url; await img.decode(); return img; } finally { setTimeout(() => URL.revokeObjectURL(url), 2000); }
}
function scaled(src, w, h, maxW = MAXW, maxH = 720, bg) {
  const s = Math.min(1, maxW / w, maxH / h);
  const c = canvas(w * s, h * s), x = c.getContext('2d');
  if (bg) { x.fillStyle = bg; x.fillRect(0, 0, c.width, c.height); }
  x.drawImage(src, 0, 0, c.width, c.height);
  return c;
}
function findBytes(u8, pat, from = 0) {
  for (let i = u8.indexOf(pat[0], from); i !== -1 && i <= u8.length - pat.length; i = u8.indexOf(pat[0], i + 1)) {
    let ok = true;
    for (let j = 1; j < pat.length; j++) if (u8[i + j] !== pat[j]) { ok = false; break; }
    if (ok) return i;
  }
  return -1;
}
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IEND = [0x49, 0x45, 0x4e, 0x44];
function pngAt(u8, i) {
  const e = findBytes(u8, IEND, i);
  return e === -1 ? null : new Blob([u8.slice(i, e + 8)], { type: 'image/png' });
}
// 内嵌图片提取：Affinity 的 Thmb 缩略图，或其他二进制文件里的 PNG / JPEG 预览
async function embeddedImage(blob, fam) {
  const u8 = new Uint8Array(await blob.slice(0, Math.min(blob.size, 64 * 1024 * 1024)).arrayBuffer());
  if (fam === 'affinity') {
    let t = -1, k;
    while ((k = findBytes(u8, [0x54, 0x68, 0x6d, 0x62], t + 1)) !== -1) t = k; // 最后一个 "Thmb"
    const p = t !== -1 ? findBytes(u8, PNG_SIG, t) : -1;
    if (p !== -1) return pngAt(u8, p);
  }
  const cands = [];
  for (let i = findBytes(u8, PNG_SIG); i !== -1 && cands.length < 6; i = findBytes(u8, PNG_SIG, i + 8)) cands.push(['png', i]);
  for (let i = findBytes(u8, [0xff, 0xd8, 0xff]); i !== -1 && cands.length < 12; i = findBytes(u8, [0xff, 0xd8, 0xff], i + 3)) cands.push(['jpg', i]);
  for (const [kind, i] of cands) {
    let b;
    if (kind === 'png') b = pngAt(u8, i);
    else { const e = findBytes(u8, [0xff, 0xd9], i + 3); if (e !== -1) b = new Blob([u8.slice(i, e + 2)], { type: 'image/jpeg' }); }
    if (!b) continue;
    try { const im = await decodeImage(b); if ((im.width || 0) >= 96) return b; } catch {}
  }
  return null;
}
async function zipThumb(blob) {
  const JSZip = await lib('zip');
  const z = await JSZip.loadAsync(blob);
  const names = Object.keys(z.files);
  const pick = names.find((n) => /(^|\/)(thumbnail|preview)\.(png|jpe?g)$/i.test(n)) || names.find((n) => /quicklook\/.*\.(png|jpe?g)$/i.test(n));
  if (!pick) return null;
  return new Blob([await z.file(pick).async('arraybuffer')], { type: /png$/i.test(pick) ? 'image/png' : 'image/jpeg' });
}
export async function pdfDoc(blob) {
  const pdfjs = await lib('pdf');
  return pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), isEvalSupported: false }).promise;
}
export async function renderPdfPage(doc, n, width, maxHeight = Infinity) {
  const page = await doc.getPage(n);
  const v1 = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: Math.min(width / v1.width, maxHeight / v1.height) });
  const c = canvas(vp.width, vp.height), x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: x, viewport: vp }).promise;
  return c;
}
const once = (el, ev, ms = 10000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('超时')), ms);
  el.addEventListener(ev, () => { clearTimeout(t); res(); }, { once: true });
  el.addEventListener('error', () => { clearTimeout(t); rej(new Error('无法解码')); }, { once: true });
});
async function videoFrame(blob, maxW = MAXW) {
  const url = URL.createObjectURL(blob);
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
  try {
    await once(v, 'loadeddata');
    const at = Math.min(1, (v.duration || 0) / 3);
    if (at > 0) { v.currentTime = at; await once(v, 'seeked'); }
    return { c: scaled(v, v.videoWidth, v.videoHeight, maxW, maxW * 2), duration: v.duration, w: v.videoWidth, h: v.videoHeight };
  } finally { v.removeAttribute('src'); v.load(); URL.revokeObjectURL(url); }
}
async function decodeAudio(blob) {
  const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ac = new Ctx(1, 1, 44100);
  return ac.decodeAudioData(await blob.arrayBuffer());
}
function waveform(buf) {
  const c = canvas(MAXW, 120), x = c.getContext('2d');
  const data = buf.getChannelData(0), bars = 72, step = Math.floor(data.length / bars) || 1;
  const bw = c.width / bars;
  x.fillStyle = '#d6336c';
  for (let i = 0; i < bars; i++) {
    let peak = 0;
    for (let j = i * step; j < (i + 1) * step && j < data.length; j += 16) peak = Math.max(peak, Math.abs(data[j]));
    const h = Math.max(4, peak * (c.height - 16));
    x.globalAlpha = 0.55 + peak * 0.45;
    const r = Math.min(3, bw / 3);
    x.beginPath(); x.roundRect ? x.roundRect(i * bw + bw * 0.2, (c.height - h) / 2, bw * 0.6, h, r) : x.rect(i * bw + bw * 0.2, (c.height - h) / 2, bw * 0.6, h); x.fill();
  }
  return c;
}
// 文字「纸张」缩略图
function textPage(text, { mono = false } = {}) {
  const W = MAXW, H = 340, pad = 24, lh = mono ? 19 : 22;
  const c = canvas(W, H), x = c.getContext('2d');
  x.fillStyle = '#ffffff'; x.fillRect(0, 0, W, H);
  x.fillStyle = '#2b2d31';
  x.font = mono ? '13px ui-monospace, Consolas, monospace' : '15px system-ui, "PingFang SC", "Microsoft YaHei", sans-serif';
  let y = pad + 12;
  for (const raw of String(text).replace(/\r/g, '').split('\n')) {
    let line = '';
    const flush = () => { x.fillText(line, pad, y); y += lh; line = ''; };
    for (const ch of raw.replace(/\t/g, '  ')) {
      if (x.measureText(line + ch).width > W - pad * 2) { flush(); if (y > H - 10) return c; }
      line += ch;
    }
    flush();
    if (y > H - 10) break;
  }
  return c;
}
function gridPage(rows) {
  const W = MAXW, H = 300, cols = Math.min(6, Math.max(1, ...rows.map((r) => r.length))), rh = 24, cw = W / cols;
  const c = canvas(W, H), x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, W, H);
  x.font = '12px system-ui, "PingFang SC", "Microsoft YaHei", sans-serif';
  rows.slice(0, Math.floor(H / rh)).forEach((r, i) => {
    if (i === 0) { x.fillStyle = '#e9f5ec'; x.fillRect(0, 0, W, rh); }
    x.fillStyle = i === 0 ? '#1e6b33' : '#2b2d31';
    for (let j = 0; j < cols; j++) {
      let s = String(r[j] ?? '');
      while (s && x.measureText(s).width > cw - 10) s = s.slice(0, -1);
      x.fillText(s, j * cw + 6, i * rh + 16);
    }
    x.strokeStyle = '#e3e5e8'; x.beginPath(); x.moveTo(0, (i + 1) * rh + 0.5); x.lineTo(W, (i + 1) * rh + 0.5); x.stroke();
  });
  for (let j = 1; j < cols; j++) { x.beginPath(); x.moveTo(j * cw + 0.5, 0); x.lineTo(j * cw + 0.5, H); x.stroke(); }
  return c;
}
async function readSheet(blob) {
  const XLSX = await lib('xlsx');
  const e = extOf(blob.name || '');
  if (e === 'csv' || e === 'tsv') return XLSX.read(await blob.text(), { type: 'string', FS: e === 'tsv' ? '\t' : ',' });
  return XLSX.read(new Uint8Array(await blob.arrayBuffer()), { type: 'array' });
}

/** 生成缩略图：返回 { blob, fit: 'cover'|'page'|'wave', info } 或 null */
export async function makeThumb(card, blob) {
  const fam = family(card);
  const named = new File([blob], card.name, { type: blob.type });
  switch (fam) {
    case 'image': {
      const im = await decodeImage(blob);
      return { blob: await toBlob(scaled(im, im.width, im.height)), fit: 'cover', info: { w: im.width, h: im.height } };
    }
    case 'pdf': {
      const doc = await pdfDoc(blob);
      try { return { blob: await toBlob(await renderPdfPage(doc, 1, MAXW)), fit: 'page', info: { pages: doc.numPages } }; }
      finally { doc.destroy(); }
    }
    case 'video': {
      const f = await videoFrame(blob);
      return { blob: await toBlob(f.c), fit: 'cover', info: { duration: f.duration, w: f.w, h: f.h } };
    }
    case 'audio': {
      if (blob.size > 60 * 1024 * 1024) return null;
      const buf = await decodeAudio(blob);
      return { blob: await toBlob(waveform(buf), 'image/png'), fit: 'wave', info: { duration: buf.duration } };
    }
    case 'affinity': case 'other': {
      const b = await embeddedImage(blob, fam);
      if (!b) return null;
      const im = await decodeImage(b);
      return { blob: await toBlob(scaled(im, im.width, im.height)), fit: 'page', info: fam === 'affinity' ? { embedded: true } : {} };
    }
    case 'zipdoc': case 'docx': case 'sheet': {
      const e = extOf(card.name);
      if (!['xls', 'csv', 'tsv'].includes(e)) {
        const t = await zipThumb(blob).catch(() => null);
        if (t) { const im = await decodeImage(t); return { blob: await toBlob(scaled(im, im.width, im.height, MAXW, 720, '#fff')), fit: 'page', info: { embedded: true } }; }
      }
      if (fam === 'docx') {
        const { value } = await (await lib('mammoth')).extractRawText({ arrayBuffer: await blob.arrayBuffer() });
        return { blob: await toBlob(textPage(value.trim().slice(0, 3000))), fit: 'page', info: {} };
      }
      if (fam === 'sheet') {
        const wb = await readSheet(named);
        const XLSX = await lib('xlsx');
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, blankrows: false }).slice(0, 14);
        return { blob: await toBlob(gridPage(rows)), fit: 'page', info: { sheets: wb.SheetNames.length } };
      }
      return null;
    }
    case 'md': case 'text': {
      const text = await blob.slice(0, 6000).text();
      if (!text.trim()) return null;
      return { blob: await toBlob(textPage(text, { mono: fam === 'text' })), fit: 'page', info: {} };
    }
  }
  return null;
}

// ---------- 富预览 ----------
/** 返回 { html, mount? } 或 null（交给默认预览） */
export async function richPreview(card, blob, thumbUrl) {
  const fam = family(card);
  const named = new File([blob], card.name, { type: blob.type });
  if (fam === 'docx') {
    const { value } = await (await lib('mammoth')).convertToHtml({ arrayBuffer: await blob.arrayBuffer() });
    return { html: `<article class="paper">${await sanitize(value)}</article>` };
  }
  if (fam === 'md') {
    const html = (await lib('marked')).parse(await blob.text());
    return { html: `<article class="paper md">${await sanitize(html)}</article>` };
  }
  if (fam === 'sheet') {
    const XLSX = await lib('xlsx');
    const wb = await readSheet(named);
    const tabs = wb.SheetNames.map((n, i) => `<button class="sheet-tab" data-sheet="${i}" aria-selected="${i === 0}">${escapeHtml(n)}</button>`).join('');
    const parts = await Promise.all(wb.SheetNames.map(async (n, i) => {
      const ws = wb.Sheets[n];
      if (ws['!ref']) { const r = XLSX.utils.decode_range(ws['!ref']); r.e.r = Math.min(r.e.r, r.s.r + 499); ws['!ref'] = XLSX.utils.encode_range(r); }
      return `<div class="sheet" data-sheet="${i}" ${i ? 'hidden' : ''}>${await sanitize(XLSX.utils.sheet_to_html(ws, { header: '', footer: '' }))}</div>`;
    }));
    return {
      html: `<div class="sheet-wrap">${wb.SheetNames.length > 1 ? `<div class="sheet-tabs">${tabs}</div>` : ''}${parts.join('')}</div>`,
      mount(el) {
        el.addEventListener('click', (e) => {
          const t = e.target.closest('.sheet-tab'); if (!t) return;
          el.querySelectorAll('.sheet-tab').forEach((b) => b.setAttribute('aria-selected', String(b === t)));
          el.querySelectorAll('.sheet').forEach((s) => { s.hidden = s.dataset.sheet !== t.dataset.sheet; });
        });
      },
    };
  }
  if (thumbUrl && ['affinity', 'zipdoc', 'other'].includes(fam)) {
    const note = fam === 'affinity' ? 'Affinity 文件的内嵌预览图。完整编辑请用 Affinity 打开，或在下方转换导出 PNG。' : '文件内嵌的预览图';
    return { html: `<figure class="embed-preview"><img src="${thumbUrl}" alt=""><figcaption>${note}</figcaption></figure>` };
  }
  return null;
}
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- 格式转换 ----------
export function conversionsFor(card, hasThumb) {
  const fam = family(card), e = extOf(card.name);
  const list = [];
  if (fam === 'image') {
    if (e !== 'png') list.push({ id: 'img-png', label: 'PNG' });
    if (!/^jpe?g$/.test(e)) list.push({ id: 'img-jpg', label: 'JPG' });
    if (e !== 'webp') list.push({ id: 'img-webp', label: 'WebP' });
    list.push({ id: 'img-pdf', label: 'PDF' });
    if (e !== 'svg' && e !== 'gif') list.push({ id: 'img-small', label: '压缩 JPG' });
  }
  if (fam === 'pdf') {
    list.push({ id: 'pdf-png', label: '每页 PNG' }, { id: 'pdf-jpg', label: '每页 JPG' },
      { id: 'pdf-txt', label: '提取文字 TXT' }, { id: 'pdf-md', label: 'Markdown' });
    if (e === 'pdf' || card.type === 'application/pdf') {
      list.push({ id: 'pdf-compress', label: '压缩 PDF' }, { id: 'pdf-split', label: '拆分 PDF' });
    }
  }
  if (fam === 'docx') list.push({ id: 'docx-html', label: 'HTML 网页' }, { id: 'docx-txt', label: '纯文本 TXT' }, { id: 'docx-md', label: 'Markdown' });
  if (fam === 'text' && /^(html?|txt)$/.test(e)) list.push({ id: 'text-md', label: 'Markdown' });
  if (fam === 'sheet') {
    if (e === 'csv' || e === 'tsv') list.push({ id: 'sheet-xlsx', label: 'Excel XLSX' });
    else list.push({ id: 'sheet-csv', label: 'CSV' });
    list.push({ id: 'sheet-json', label: 'JSON' });
  }
  if (fam === 'md') list.push({ id: 'md-html', label: 'HTML 网页' });
  if (fam === 'audio') { if (e !== 'wav') list.push({ id: 'audio-wav', label: 'WAV' }); }
  if (fam === 'video') list.push({ id: 'video-png', label: '封面 PNG' }, { id: 'video-jpg', label: '封面 JPG' }, { id: 'video-wav', label: '提取音频 WAV' });
  if (hasThumb && ['affinity', 'zipdoc', 'other'].includes(fam)) {
    list.push({ id: 'thumb-png', label: fam === 'affinity' ? '预览图 PNG' : '内嵌预览 PNG' }, { id: 'thumb-jpg', label: '预览图 JPG' });
  }
  return list;
}

function wavBlob(buf) {
  const ch = Math.min(2, buf.numberOfChannels), rate = buf.sampleRate, len = buf.length;
  const out = new DataView(new ArrayBuffer(44 + len * ch * 2));
  const w = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); out.setUint32(4, 36 + len * ch * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, ch, true); out.setUint32(24, rate, true);
  out.setUint32(28, rate * ch * 2, true); out.setUint16(32, ch * 2, true); out.setUint16(34, 16, true); w(36, 'data'); out.setUint32(40, len * ch * 2, true);
  const chans = Array.from({ length: ch }, (_, i) => buf.getChannelData(i));
  let o = 44;
  for (let i = 0; i < len; i++) for (let c = 0; c < ch; c++) { const s = Math.max(-1, Math.min(1, chans[c][i])); out.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2; }
  return new Blob([out], { type: 'audio/wav' });
}
async function decodeAudioFull(blob) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ac = new Ctx();
  try { return await ac.decodeAudioData(await blob.arrayBuffer()); } finally { ac.close?.(); }
}
const htmlDoc = (title, body) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{max-width:760px;margin:40px auto;padding:0 20px;font:16px/1.75 system-ui,"PingFang SC","Microsoft YaHei",sans-serif;color:#222}img{max-width:100%}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:4px 8px}pre{background:#f5f5f5;padding:12px;overflow:auto}</style></head><body>${body}</body></html>`;

/** 多张图片按顺序合并成一个 PDF（每张图一页，页面尺寸跟随图片） */
export async function mergeImagesPdf(items, name, onProgress = () => {}) {
  const { jsPDF } = await lib('jspdf');
  let pdf = null;
  for (let i = 0; i < items.length; i++) {
    onProgress(`正在合并第 ${i + 1}/${items.length} 张…`);
    const im = await decodeImage(items[i].blob);
    const c = scaled(im, im.width, im.height, 3000, 3000, '#fff');
    const o = c.width > c.height ? 'l' : 'p';
    if (!pdf) pdf = new jsPDF({ orientation: o, unit: 'px', format: [c.width, c.height], hotfixes: ['px_scaling'] });
    else pdf.addPage([c.width, c.height], o);
    pdf.addImage(c.toDataURL('image/jpeg', 0.9), 'JPEG', 0, 0, c.width, c.height);
  }
  return new File([pdf.output('blob')], `${name}.pdf`, { type: 'application/pdf' });
}

const pdfFile = async (doc, name) => new File([await doc.save()], `${name}.pdf`, { type: 'application/pdf' });

export async function mergePdfs(blobs, name, onProgress = () => {}) {
  const { PDFDocument } = await lib('pdfLib');
  const out = await PDFDocument.create();
  for (const [i, blob] of blobs.entries()) {
    onProgress(`正在合并第 ${i + 1}/${blobs.length} 份…`);
    const src = await PDFDocument.load(await blob.arrayBuffer());
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((page) => out.addPage(page));
  }
  return pdfFile(out, name);
}

export function pdfSplitParts(assignments, pageCount) {
  const groups = new Map();
  for (const [page, part] of assignments) {
    if (!Number.isInteger(page) || page < 1 || page > pageCount) throw new Error('拆分页码超出范围');
    if (!Number.isInteger(part) || part < 1) throw new Error('拆分部分编号无效');
    if (!groups.has(part)) groups.set(part, []);
    groups.get(part).push(page);
  }
  return [...groups].sort(([a], [b]) => a - b).map(([part, pages]) => ({
    part, pages: pages.sort((a, b) => a - b),
  }));
}

async function splitPdf(blob, name, assignments, onProgress) {
  const { PDFDocument } = await lib('pdfLib');
  const src = await PDFDocument.load(await blob.arrayBuffer());
  const pageCount = src.getPageCount();
  if (pageCount < 2) throw new Error('PDF 只有一页，无需拆分');
  const parts = assignments ? pdfSplitParts(assignments, pageCount)
    : Array.from({ length: pageCount }, (_, index) => ({ part: index + 1, pages: [index + 1] }));
  if (!parts.length) throw new Error('请至少勾选一页');
  const files = [];
  for (const [index, { part, pages }] of parts.entries()) {
    onProgress(`正在生成第 ${index + 1}/${parts.length} 份 PDF…`);
    const out = await PDFDocument.create();
    const copies = await out.copyPages(src, pages.map((page) => page - 1));
    copies.forEach((page) => out.addPage(page));
    const label = assignments ? `第${part}部分` : `第${pages[0]}页`;
    files.push(await pdfFile(out, `${name}-${label}`));
  }
  return files;
}

async function compressPdf(blob, name, onProgress) {
  const { PDFDocument } = await lib('pdfLib');
  const src = await PDFDocument.load(await blob.arrayBuffer(), { updateMetadata: false });
  const outName = `${name}-压缩`;
  const optimized = await pdfFile(src, outName);
  if (optimized.size <= blob.size * 0.9) return optimized;

  const doc = await pdfDoc(blob);
  try {
    const out = await PDFDocument.create();
    for (let i = 1; i <= doc.numPages; i++) {
      onProgress(`正在压缩第 ${i}/${doc.numPages} 页…`);
      const { width, height } = (await doc.getPage(i)).getViewport({ scale: 1 });
      const c = await renderPdfPage(doc, i, width * Math.min(2, 2200 / Math.max(width, height)));
      const jpg = await toBlob(c, 'image/jpeg', 0.72);
      c.width = c.height = 1;
      if (!jpg) throw new Error('无法生成页面图像');
      const image = await out.embedJpg(await jpg.arrayBuffer());
      out.addPage([width, height]).drawImage(image, { x: 0, y: 0, width, height });
    }
    const compressed = await pdfFile(out, outName);
    if (optimized.size < blob.size && optimized.size <= compressed.size) return optimized;
    if (compressed.size >= blob.size) throw new Error('原 PDF 已足够小，未生成压缩副本');
    return compressed;
  } finally { await doc.destroy(); }
}

async function htmlToMarkdown(html) {
  const Turndown = await lib('turndown');
  const service = new Turndown({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  service.keep('table');
  return service.turndown(await sanitize(html));
}

/** 执行转换，返回 File[]；onProgress(文字) 可选 */
export async function convert(card, blob, id, onProgress = () => {}, { assignments } = {}) {
  if (!blob) throw new Error(`找不到「${card.name}」的文件内容`);
  const base = baseName(card.name);
  const named = new File([blob], card.name, { type: blob.type });
  const file = (parts, name, type) => new File(Array.isArray(parts) ? parts : [parts], name, { type });
  switch (id) {
    case 'img-png': case 'img-jpg': case 'img-webp': {
      const im = await decodeImage(blob);
      const jpg = id === 'img-jpg';
      const c = scaled(im, im.width, im.height, 8000, 8000, jpg ? '#fff' : null);
      const [type, ext] = jpg ? ['image/jpeg', 'jpg'] : id === 'img-png' ? ['image/png', 'png'] : ['image/webp', 'webp'];
      return [file(await toBlob(c, type, 0.92), `${base}.${ext}`, type)];
    }
    case 'img-small': {
      // 长边不超过 2048px，JPG 80% 质量；结果没变小就保留原图大小提示
      const im = await decodeImage(blob);
      const c = scaled(im, im.width, im.height, 2048, 2048, '#fff');
      const out = await toBlob(c, 'image/jpeg', 0.8);
      if (out.size >= blob.size && /^jpe?g$/.test(extOf(card.name))) throw new Error('这张图已经足够小了');
      return [file(out, `${base}-压缩.jpg`, 'image/jpeg')];
    }
    case 'img-pdf': {
      const im = await decodeImage(blob);
      const c = scaled(im, im.width, im.height, 4000, 4000, '#fff');
      const { jsPDF } = await lib('jspdf');
      const pdf = new jsPDF({ orientation: c.width > c.height ? 'l' : 'p', unit: 'px', format: [c.width, c.height], hotfixes: ['px_scaling'] });
      pdf.addImage(c.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, c.width, c.height);
      return [file(pdf.output('blob'), `${base}.pdf`, 'application/pdf')];
    }
    case 'pdf-split': return splitPdf(blob, base, assignments, onProgress);
    case 'pdf-compress': return [await compressPdf(blob, base, onProgress)];
    case 'pdf-png': case 'pdf-jpg': {
      const jpg = id === 'pdf-jpg';
      const ext = jpg ? 'jpg' : 'png', type = jpg ? 'image/jpeg' : 'image/png';
      const doc = await pdfDoc(blob);
      try {
        const n = jpg ? doc.numPages : Math.min(doc.numPages, 30), out = [];
        for (let i = 1; i <= n; i++) {
          onProgress(`正在渲染第 ${i}/${n} 页…`);
          const page = await doc.getPage(i);
          const { width, height } = page.getViewport({ scale: 1 });
          const maxSide = jpg ? Math.max(width, height) : width;
          const c = await renderPdfPage(doc, i, width * Math.min(2, 2400 / maxSide));
          const image = await toBlob(c, type, 0.92);
          c.width = c.height = 1;
          if (!image) throw new Error(`无法导出第 ${i} 页`);
          out.push(file(image, `${base}-第${i}页.${ext}`, type));
        }
        return out;
      } finally { doc.destroy(); }
    }
    case 'pdf-txt': case 'pdf-md': {
      const md = id === 'pdf-md';
      const doc = await pdfDoc(blob);
      try {
        const pages = [];
        for (let i = 1; i <= doc.numPages; i++) {
          onProgress(`正在读取第 ${i}/${doc.numPages} 页…`);
          const tc = await (await doc.getPage(i)).getTextContent();
          pages.push(tc.items.map((it) => it.str + (it.hasEOL ? '\n' : '')).join(''));
        }
        if (md) {
          if (!pages.some((text) => text.trim())) throw new Error('PDF 没有可提取的文字，扫描页需先做 OCR');
          const text = pages.map((page, i) => `## 第 ${i + 1} 页\n\n${page.trim()}`).join('\n\n');
          return [file(text, `${base}.md`, 'text/markdown;charset=utf-8')];
        }
        return [file(pages.join('\n\n'), `${base}.txt`, 'text/plain;charset=utf-8')];
      } finally { doc.destroy(); }
    }
    case 'text-md': {
      const text = await blob.text();
      return [file(/html?$/.test(extOf(card.name)) ? await htmlToMarkdown(text) : text, `${base}.md`, 'text/markdown;charset=utf-8')];
    }
    case 'docx-html': case 'docx-md': {
      const { value } = await (await lib('mammoth')).convertToHtml({ arrayBuffer: await blob.arrayBuffer() });
      if (id === 'docx-md') return [file(await htmlToMarkdown(value), `${base}.md`, 'text/markdown;charset=utf-8')];
      return [file(htmlDoc(base, await sanitize(value)), `${base}.html`, 'text/html;charset=utf-8')];
    }
    case 'docx-txt': {
      const { value } = await (await lib('mammoth')).extractRawText({ arrayBuffer: await blob.arrayBuffer() });
      return [file(value, `${base}.txt`, 'text/plain;charset=utf-8')];
    }
    case 'sheet-csv': {
      const XLSX = await lib('xlsx'), wb = await readSheet(named);
      return wb.SheetNames.map((n) => file(['﻿', XLSX.utils.sheet_to_csv(wb.Sheets[n])], wb.SheetNames.length > 1 ? `${base}-${n}.csv` : `${base}.csv`, 'text/csv;charset=utf-8'));
    }
    case 'sheet-json': {
      const XLSX = await lib('xlsx'), wb = await readSheet(named);
      const data = wb.SheetNames.length === 1 ? XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]])
        : Object.fromEntries(wb.SheetNames.map((n) => [n, XLSX.utils.sheet_to_json(wb.Sheets[n])]));
      return [file(JSON.stringify(data, null, 2), `${base}.json`, 'application/json')];
    }
    case 'sheet-xlsx': {
      const XLSX = await lib('xlsx'), wb = await readSheet(named);
      const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      return [file(out, `${base}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')];
    }
    case 'md-html': {
      const html = (await lib('marked')).parse(await blob.text());
      return [file(htmlDoc(base, await sanitize(html)), `${base}.html`, 'text/html;charset=utf-8')];
    }
    case 'audio-wav': case 'video-wav': {
      onProgress('正在解码音频…');
      return [file(wavBlob(await decodeAudioFull(blob)), `${base}.wav`, 'audio/wav')];
    }
    case 'video-png': case 'video-jpg': {
      const jpg = id === 'video-jpg';
      const ext = jpg ? 'jpg' : 'png', type = jpg ? 'image/jpeg' : 'image/png';
      const f = await videoFrame(blob, 4000);
      return [file(await toBlob(f.c, type, 0.92), `${base}-封面.${ext}`, type)];
    }
    case 'thumb-png': case 'thumb-jpg': {
      const jpg = id === 'thumb-jpg';
      const ext = jpg ? 'jpg' : 'png', type = jpg ? 'image/jpeg' : 'image/png';
      let b = family(card) === 'affinity' || family(card) === 'other' ? await embeddedImage(blob, family(card)) : await zipThumb(blob);
      if (!b) throw new Error('没有找到内嵌预览图');
      if (b.type !== type) {
        const im = await decodeImage(b);
        b = await toBlob(scaled(im, im.width, im.height, 8000, 8000, jpg ? '#fff' : null), type, 0.92);
      }
      return [file(b, `${base}-预览.${ext}`, type)];
    }
  }
  throw new Error('不支持的转换');
}
