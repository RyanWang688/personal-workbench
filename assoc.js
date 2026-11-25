// Fast O(N * K) Smart Project Association using stop-gram inverted index blocking,
// per-card feature memoization, and bounded auto/suggestion cluster sizes.

const SEP = '[\\s_\\-–—.·]';
const SEP_TRAILING_RE = new RegExp(`${SEP}+$`);
const SEP_GLOBAL_RE = new RegExp(SEP, 'g');
const SUFFIX = new RegExp(
  `(${SEP}*(预览图?|封面|缩略图|第\\s*\\d+\\s*页|终稿|定稿|最终版?|修改版|初稿|final|copy|副本|v\\d+(\\.\\d+)*|\\(\\d+\\)|（\\d+）|\\d{8}|\\d{4}-\\d{1,2}-\\d{1,2}))+$`,
  'i',
);
const GENERIC = /^(img|dsc|dcim|pxl|mvimg|vid|video|image|photo|scan|screenshot|screen ?shot|截图|屏幕截图|微信图片|未命名|untitled|新建|文档|document|file)[\s_\-]*\d*$/i;

export const SENS = {
  strict: { auto: 0.95, hint: 0.62, label: '严格' },
  normal: { auto: 0.8, hint: 0.5, label: '标准' },
  loose: { auto: 0.66, hint: 0.4, label: '宽松' },
};

export const MAX_AUTO_GROUP = 24;
export const MAX_SUGGEST_CLUSTER = 16;
const STOP_GRAM_DF = 28;
const MAX_CANDS_PER_STEM = 16;
const LCS_MAX_LEN = 64;
const LCS_PREV = new Uint16Array(LCS_MAX_LEN + 1);
const EMPTY_SET = new Set();

export const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

export function baseTitle(c) {
  let s = (c?.name || '').replace(/\.[a-z0-9]{1,6}$/i, '').trim();
  let prev;
  do {
    prev = s;
    s = s.replace(SUFFIX, '').trim();
  } while (s !== prev && s);
  return s.replace(SEP_TRAILING_RE, '') || (c?.name || '').replace(/\.[^.]+$/, '');
}

export const normTitle = (c) => baseTitle(c).toLowerCase().replace(SEP_GLOBAL_RE, '');

function makeGrams(s) {
  const bigrams = new Set();
  if (s.length < 2) {
    if (s) bigrams.add(s);
    return { bigrams, indexGrams: bigrams };
  }
  for (let i = 0; i < s.length - 1; i++) bigrams.add(s.slice(i, i + 2));
  if (s.length < 6) return { bigrams, indexGrams: bigrams };
  const indexGrams = new Set(bigrams);
  for (let i = 0; i < s.length - 2; i++) indexGrams.add(s.slice(i, i + 3));
  return { bigrams, indexGrams };
}

function getFeature(c) {
  const rawName = c.name || '';
  const cached = c._assocCache;
  if (cached && cached.rawName === rawName) return cached;
  const key = normTitle(c);
  const generic = GENERIC.test(key) || key.length < 2;
  const { bigrams, indexGrams } = generic ? { bigrams: EMPTY_SET, indexGrams: EMPTY_SET } : makeGrams(key);
  const feat = { rawName, key, generic, bigrams, indexGrams };
  c._assocCache = feat;
  return feat;
}

function dice(a, b) {
  if (!a.size || !b.size) return 0;
  const [sm, lg] = a.size <= b.size ? [a, b] : [b, a];
  let n = 0;
  for (const x of sm) if (lg.has(x)) n++;
  return (2 * n) / (a.size + b.size);
}

function lcsLen(a, b) {
  if (a.length > LCS_MAX_LEN || b.length > LCS_MAX_LEN) return 0;
  LCS_PREV.fill(0, 0, b.length + 1);
  let best = 0;
  for (let i = 1; i <= a.length; i++) {
    const chA = a.charCodeAt(i - 1);
    let diag = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = LCS_PREV[j];
      if (chA === b.charCodeAt(j - 1)) {
        const val = diag + 1;
        LCS_PREV[j] = val;
        if (val > best) best = val;
      } else {
        LCS_PREV[j] = 0;
      }
      diag = tmp;
    }
  }
  return best;
}

function nameScore(repA, repB) {
  const a = repA.key;
  const b = repB.key;
  if (!a || !b) return 0;
  if (a === b) return 1;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  if (s.length >= 2 && l.includes(s)) return s.length >= 3 ? 0.92 : 0.7;
  const d = dice(repA.bigrams, repB.bigrams);
  const k = lcsLen(a, b);
  return k >= 2 ? 0.45 * d + 0.55 * (k / s.length) : 0.6 * d;
}

function hashStr(h, s) {
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  }
  return h;
}

export function computeAssocSignature(liveCards, sensKey = 'normal', dismissedSize = 0) {
  let h = 2166136261;
  h = Math.imul(h ^ liveCards.length, 16777619);
  h = hashStr(h, sensKey);
  h = Math.imul(h ^ dismissedSize, 16777619);
  for (let i = 0; i < liveCards.length; i++) {
    const c = liveCards[i];
    h = hashStr(h, c.id || '');
    h = hashStr(h, c.name || '');
    if (c.projectId) h = hashStr(h, c.projectId);
    if (c.sourceId) h = hashStr(h, c.sourceId);
    if (c.batchId) h = hashStr(h, c.batchId);
    if (c.noAuto) h = Math.imul(h ^ 1, 16777619);
  }
  return `${liveCards.length}|${sensKey}|${dismissedSize}|${h >>> 0}`;
}

export function buildAssocGroups(liveCards = [], { sensKey = 'normal', dismissed = EMPTY_SET, cardById } = {}) {
  const live = liveCards;
  const lookup = cardById || new Map(live.map((c) => [c.id, c]));
  const parent = new Map();
  const groupSize = new Map();
  for (const c of live) {
    parent.set(c.id, c.id);
    groupSize.set(c.id, 1);
  }

  const find = (x) => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    while (parent.get(x) !== r) {
      const nxt = parent.get(x);
      parent.set(x, r);
      x = nxt;
    }
    return r;
  };

  const unionManual = (a, b) => {
    if (!parent.has(a) || !parent.has(b)) return;
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    const sa = groupSize.get(ra);
    const sb = groupSize.get(rb);
    if (sa >= sb) {
      parent.set(rb, ra);
      groupSize.set(ra, sa + sb);
    } else {
      parent.set(ra, rb);
      groupSize.set(rb, sa + sb);
    }
  };

  const unionAuto = (a, b) => {
    if (!parent.has(a) || !parent.has(b)) return false;
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return true;
    const sa = groupSize.get(ra);
    const sb = groupSize.get(rb);
    if (sa + sb > MAX_AUTO_GROUP) return false;
    if (sa >= sb) {
      parent.set(rb, ra);
      groupSize.set(ra, sa + sb);
    } else {
      parent.set(ra, rb);
      groupSize.set(rb, sa + sb);
    }
    return true;
  };

  const { auto, hint } = SENS[sensKey] || SENS.normal;
  const exactBuckets = new Map();

  for (const c of live) {
    if (c.noAuto) continue;
    const feat = getFeature(c);
    if (feat.generic) continue;
    let list = exactBuckets.get(feat.key);
    if (!list) exactBuckets.set(feat.key, (list = []));
    list.push({ c, feat });
  }

  const reps = [];
  for (const [key, entries] of exactBuckets) {
    if (entries.length >= 2 && entries.length <= MAX_AUTO_GROUP) {
      const firstId = entries[0].c.id;
      for (let i = 1; i < entries.length; i++) unionAuto(firstId, entries[i].c.id);
    }
    if (entries.length <= MAX_AUTO_GROUP) {
      const first = entries[0];
      reps.push({
        key,
        bigrams: first.feat.bigrams,
        indexGrams: first.feat.indexGrams,
        cards: entries.map((e) => e.c),
        repCard: first.c,
      });
    }
  }

  // Inverted index blocking on representative stems
  const postings = new Map();
  for (let i = 0; i < reps.length; i++) {
    for (const g of reps[i].indexGrams) {
      let arr = postings.get(g);
      if (!arr) postings.set(g, (arr = []));
      arr.push(i);
    }
  }

  const hints = [];
  const candCounts = new Map();

  for (let i = 0; i < reps.length; i++) {
    const repA = reps[i];
    candCounts.clear();
    for (const g of repA.indexGrams) {
      const list = postings.get(g);
      if (!list || list.length > STOP_GRAM_DF) continue;
      for (let k = 0; k < list.length; k++) {
        const j = list[k];
        if (j <= i) continue;
        candCounts.set(j, (candCounts.get(j) || 0) + 1);
      }
    }
    if (!candCounts.size) continue;

    const minHits = repA.key.length >= 4 ? 2 : 1;
    const cands = [];
    for (const [j, cnt] of candCounts) {
      if (cnt >= minHits) cands.push([j, cnt]);
    }
    if (!cands.length) continue;
    if (cands.length > MAX_CANDS_PER_STEM) {
      cands.sort((x, y) => y[1] - x[1]);
      cands.length = MAX_CANDS_PER_STEM;
    }

    for (let k = 0; k < cands.length; k++) {
      const repB = reps[cands[k][0]];
      const ns = nameScore(repA, repB);
      if (ns < 0.38) continue;

      let ctx = 0;
      const ca = repA.repCard;
      const cb = repB.repCard;
      if (ca.batchId && ca.batchId === cb.batchId) ctx = 0.15;
      else if (Math.abs((ca.createdAt || 0) - (cb.createdAt || 0)) < 10 * 60e3) ctx = 0.05;

      const s = Math.min(0.99, ns + ctx);
      if (s >= auto) {
        for (const cbItem of repB.cards) {
          if (!unionAuto(ca.id, cbItem.id)) break;
        }
      } else if (s >= hint && !dismissed.has(pairKey(ca.id, cb.id))) {
        hints.push([ca.id, cb.id, s]);
      }
    }
  }

  // Always honor explicit sourceId links and manual projectId groupings
  for (const c of live) {
    if (c.sourceId && !c.noAuto) {
      const src = lookup instanceof Map ? lookup.get(c.sourceId) : lookup(c.sourceId);
      if (src && !src.noAuto) unionManual(c.id, c.sourceId);
    }
  }
  const firstOfProject = new Map();
  for (const c of live) {
    if (!c.projectId) continue;
    if (firstOfProject.has(c.projectId)) unionManual(c.id, firstOfProject.get(c.projectId));
    else firstOfProject.set(c.projectId, c.id);
  }

  const groupBuckets = new Map();
  for (const c of live) {
    const r = find(c.id);
    let arr = groupBuckets.get(r);
    if (!arr) groupBuckets.set(r, (arr = []));
    arr.push(c.id);
  }
  const groups = new Map();
  for (const ids of groupBuckets.values()) {
    for (const id of ids) groups.set(id, ids);
  }

  // Merge medium-confidence hints into bounded suggestion clusters
  const gp = new Map();
  const gpWeight = new Map();
  const best = new Map();
  const gfind = (x) => {
    let r = x;
    while (gp.get(r) !== r) r = gp.get(r);
    while (gp.get(x) !== r) {
      const nxt = gp.get(x);
      gp.set(x, r);
      x = nxt;
    }
    return r;
  };

  for (const [a, b, s] of hints) {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) continue;
    if (!gp.has(ra)) { gp.set(ra, ra); gpWeight.set(ra, groupBuckets.get(ra)?.length || 1); }
    if (!gp.has(rb)) { gp.set(rb, rb); gpWeight.set(rb, groupBuckets.get(rb)?.length || 1); }
    const x = gfind(ra);
    const y = gfind(rb);
    if (x !== y) {
      const wx = gpWeight.get(x) || 1;
      const wy = gpWeight.get(y) || 1;
      if (wx + wy > MAX_SUGGEST_CLUSTER) continue;
      gp.set(x, y);
      gpWeight.set(y, wx + wy);
    }
    best.set(ra, Math.max(best.get(ra) || 0, s));
    best.set(rb, Math.max(best.get(rb) || 0, s));
  }

  const clusters = new Map();
  for (const r of gp.keys()) {
    const k = gfind(r);
    let arr = clusters.get(k);
    if (!arr) clusters.set(k, (arr = []));
    arr.push(r);
  }

  const suggestions = [...clusters.values()]
    .filter((rs) => rs.length > 1)
    .map((rs) => ({
      ids: rs.flatMap((r) => groupBuckets.get(r) || []),
      score: Math.max(...rs.map((r) => best.get(r) || 0)),
    }))
    .sort((a, b) => b.score - a.score);

  const suggestOf = new Map();
  suggestions.forEach((sg, i) => sg.ids.forEach((id) => suggestOf.set(id, i)));

  return { groups, suggestions, suggestOf };
}
