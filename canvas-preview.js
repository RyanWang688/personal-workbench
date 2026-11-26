export const PREVIEW_W = 320;
export const PREVIEW_H = 200;
export const MAX_SHAPES = 120;
export const MAX_LINKS = 120;
export const MAX_CARDS = 40;

const IMG_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|avif|heic|ico)$/i;
const PDF_EXT_RE = /\.pdf$/i;

const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function looksVisualFile(card) {
  if (!card || card.kind !== 'file') return false;
  if (card.thumb === 'ok') return true;
  const mime = String(card.mime || '').toLowerCase();
  if (mime.startsWith('image/') || mime === 'application/pdf') return true;
  const name = String(card.name || '');
  return IMG_EXT_RE.test(name) || PDF_EXT_RE.test(name);
}

/**
 * Estimate a card's rendered height in canvas world pixels so preview thumbnails
 * keep realistic proportions before full DOM layout happens.
 */
export function estimateCardHeight(card, w = 232) {
  const width = Math.max(120, num(w, 232));
  if (card?.kind === 'note') return 132;
  const iw = num(card?.info?.w, 0);
  const ih = num(card?.info?.h, 0);
  if (iw > 0 && ih > 0) {
    return clamp(Math.round(width * (ih / iw)), 90, 480);
  }
  if (looksVisualFile(card)) {
    return Math.round(width * 0.72);
  }
  return 84;
}

const centerOf = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

function edgePoint(b, tx, ty, gap = 2.5) {
  const c = centerOf(b);
  const dx = tx - c.x;
  const dy = ty - c.y;
  if (b.t === 'pt' || (!dx && !dy)) return c;
  const hw = b.w / 2 + gap;
  const hh = b.h / 2 + gap;
  let k;
  if (b.t === 'ellipse') {
    k = 1 / Math.sqrt((dx * dx) / (hw * hw) + (dy * dy) / (hh * hh));
  } else if (b.t === 'diamond') {
    k = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
  } else {
    k = Math.min(hw / Math.abs(dx || 1e-9), hh / Math.abs(dy || 1e-9));
  }
  return { x: c.x + dx * k, y: c.y + dy * k };
}

function arrowHead(tip, from, size = 5) {
  const a = Math.atan2(tip.y - from.y, tip.x - from.x);
  const w = 0.42;
  const p = (ang) => `${(tip.x - size * Math.cos(ang)).toFixed(2)} ${(tip.y - size * Math.sin(ang)).toFixed(2)}`;
  return `M${tip.x.toFixed(2)} ${tip.y.toFixed(2)}L${p(a - w)}L${p(a + w)}Z`;
}

function defaultCardWidth(c) {
  if (c?.w) return Math.max(120, Math.round(num(c.w, 232)));
  if (c?.kind === 'file') {
    if (looksVisualFile(c)) return 360;
    if (c.thumb === 'ok') return 260;
  }
  return 232;
}

/**
 * Project canvas cards, whiteboard shapes, and connector links into a bounded
 * miniature viewport so directory cards can preview board contents accurately.
 */
export function computeCanvasPreviewLayout(cards = [], shapes = [], links = [], opts = {}) {
  const width = num(opts.width, PREVIEW_W);
  const height = num(opts.height, PREVIEW_H);
  const maxScale = num(opts.maxScale, 0.45);
  const padRatio = num(opts.padRatio, 0.09);
  const getCardWidth = typeof opts.getCardWidth === 'function' ? opts.getCardWidth : defaultCardWidth;

  const sortedCards = [...(cards || [])]
    .sort((a, b) => num(a?.order, 0) - num(b?.order, 0))
    .slice(0, MAX_CARDS);

  const sortedShapes = [...(shapes || [])]
    .sort((a, b) => {
      const af = a?.frame ? 0 : 1;
      const bf = b?.frame ? 0 : 1;
      if (af !== bf) return af - bf;
      return num(a?.z, 1) - num(b?.z, 1);
    })
    .slice(0, MAX_SHAPES);

  const slicedLinks = (links || []).slice(0, MAX_LINKS);

  const worldBoxes = new Map();
  const boundsPts = [];

  const shapeEntries = sortedShapes.map((s) => {
    const t = s?.t || 'rect';
    const w = Math.max(12, num(s?.w, t === 'text' ? 240 : 160));
    const h = Math.max(12, num(s?.h, t === 'text' ? 44 : 120));
    const x = num(s?.x, 0);
    const y = num(s?.y, 0);
    const box = { x, y, w, h, t };
    if (s?.id != null) worldBoxes.set(s.id, box);
    boundsPts.push({ x1: x, y1: y, x2: x + w, y2: y + h });
    return { s, box };
  });

  const cardEntries = sortedCards.map((card) => {
    const w = Math.max(120, Math.round(num(getCardWidth(card), 232)));
    const h = estimateCardHeight(card, w);
    const x = num(card?.x, 0);
    const y = num(card?.y, 0);
    const box = { x, y, w, h, t: 'card' };
    if (card?.id != null) worldBoxes.set(card.id, box);
    boundsPts.push({ x1: x, y1: y, x2: x + w, y2: y + h });
    return { card, box };
  });

  for (const l of slicedLinks) {
    for (const ref of [l?.from, l?.to]) {
      if (ref && !ref.id && Number.isFinite(Number(ref.x)) && Number.isFinite(Number(ref.y))) {
        const rx = Number(ref.x);
        const ry = Number(ref.y);
        boundsPts.push({ x1: rx, y1: ry, x2: rx, y2: ry });
      }
    }
  }

  if (!boundsPts.length) {
    return { empty: true, width, height, scale: 1, ox: 0, oy: 0, cards: [], shapes: [], links: [] };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const pt of boundsPts) {
    if (pt.x1 < minX) minX = pt.x1;
    if (pt.y1 < minY) minY = pt.y1;
    if (pt.x2 > maxX) maxX = pt.x2;
    if (pt.y2 > maxY) maxY = pt.y2;
  }

  const bw = Math.max(1, maxX - minX);
  const bh = Math.max(1, maxY - minY);
  const pad = Math.max(40, Math.max(bw, bh) * padRatio);
  const scale = Math.min(maxScale, width / (bw + pad * 2), height / (bh + pad * 2));
  const ox = (width - bw * scale) / 2;
  const oy = (height - bh * scale) / 2;

  const px = (wx) => ox + (wx - minX) * scale;
  const py = (wy) => oy + (wy - minY) * scale;

  const mappedShapes = shapeEntries.map(({ s, box }) => ({
    id: s.id,
    t: box.t,
    sk: s.sk || '',
    rot: Number.isFinite(Number(s.rot)) ? Number(s.rot) : 0,
    x: px(box.x),
    y: py(box.y),
    w: box.w * scale,
    h: box.h * scale,
    fill: s.fill,
    text: s.text || '',
    fs: num(s.fs, 16) * scale,
    al: s.al || (box.t === 'text' ? 'left' : 'center'),
    b: Boolean(s.b),
    frame: Boolean(s.frame),
    va: s.va || 'center',
  }));

  const mappedCards = cardEntries.map(({ card, box }) => {
    const x = px(box.x);
    const y = py(box.y);
    const w = box.w * scale;
    const h = box.h * scale;
    return {
      card,
      id: card.id,
      x,
      y,
      w,
      h,
      leftPct: clamp((x / width) * 100, 0, 100),
      topPct: clamp((y / height) * 100, 0, 100),
      widthPct: clamp((w / width) * 100, 0, 100),
      heightPct: clamp((h / height) * 100, 0, 100),
    };
  });

  const resolveRefBox = (ref) => {
    if (!ref) return null;
    if (ref.id) {
      const wb = worldBoxes.get(ref.id);
      if (!wb) return null;
      return { x: px(wb.x), y: py(wb.y), w: wb.w * scale, h: wb.h * scale, t: wb.t };
    }
    if (Number.isFinite(Number(ref.x)) && Number.isFinite(Number(ref.y))) {
      return { x: px(Number(ref.x)), y: py(Number(ref.y)), w: 0, h: 0, t: 'pt' };
    }
    return null;
  };

  const gap = clamp(5 * scale, 1.2, 4);
  const headSize = clamp(11 * scale, 3, 7);
  const mappedLinks = [];

  for (const l of slicedLinks) {
    const A = resolveRefBox(l?.from);
    const B = resolveRefBox(l?.to);
    if (!A || !B) continue;
    const ca = centerOf(A);
    const cb = centerOf(B);
    const p1 = edgePoint(A, cb.x, cb.y, gap);
    const p2 = edgePoint(B, ca.x, ca.y, gap);
    if (Math.hypot(p2.x - p1.x, p2.y - p1.y) < 1.5) continue;

    let d;
    let c1 = p1;
    let c2 = p2;
    if (l.curve) {
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const horiz = Math.abs(dx) >= Math.abs(dy);
      c1 = horiz ? { x: p1.x + dx / 2, y: p1.y } : { x: p1.x, y: p1.y + dy / 2 };
      c2 = horiz ? { x: p2.x - dx / 2, y: p2.y } : { x: p2.x, y: p2.y - dy / 2 };
      d = `M${p1.x.toFixed(2)} ${p1.y.toFixed(2)}C${c1.x.toFixed(2)} ${c1.y.toFixed(2)} ${c2.x.toFixed(2)} ${c2.y.toFixed(2)} ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
    } else {
      d = `M${p1.x.toFixed(2)} ${p1.y.toFixed(2)}L${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
    }

    const heads = [];
    if (l.end !== 'none') {
      heads.push(arrowHead(p2, c2.x === p2.x && c2.y === p2.y ? p1 : c2, headSize));
    }
    if (l.end === 'both') {
      heads.push(arrowHead(p1, c1.x === p1.x && c1.y === p1.y ? p2 : c1, headSize));
    }

    mappedLinks.push({
      d,
      color: l.color || null,
      dash: Boolean(l.dash),
      heads,
    });
  }

  return {
    empty: false,
    width,
    height,
    scale,
    ox,
    oy,
    cards: mappedCards,
    shapes: mappedShapes,
    links: mappedLinks,
  };
}
