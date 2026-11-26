// 画布贴纸目录与几何工具（零 DOM 依赖，便于单元测试与协同渲染）

export const STICKER_CATS = [
  { id: 'status', label: '状态印章' },
  { id: 'emoji', label: '表情贴纸' },
];

export const STICKERS = [
  // 状态印章
  { id: 'done', cat: 'status', kind: 'badge', label: '已完成', icon: '✓', bg: '#16a34a', fg: '#ffffff', w: 116, h: 44, rot: -5 },
  { id: 'approved', cat: 'status', kind: 'seal', label: '已通过', icon: '✓', bg: '#059669', fg: '#ffffff', w: 92, h: 92, rot: -8 },
  { id: 'wip', cat: 'status', kind: 'badge', label: '进行中', icon: '◔', bg: '#2563eb', fg: '#ffffff', w: 116, h: 44, rot: -3 },
  { id: 'todo', cat: 'status', kind: 'badge', label: '待处理', icon: '○', bg: '#d97706', fg: '#ffffff', w: 116, h: 44, rot: 3 },
  { id: 'urgent', cat: 'status', kind: 'badge', label: '加急', icon: '⚡', bg: '#e11d48', fg: '#ffffff', w: 102, h: 44, rot: -6 },
  { id: 'review', cat: 'status', kind: 'badge', label: '待确认', icon: '?', bg: '#7c3aed', fg: '#ffffff', w: 116, h: 44, rot: 4 },
  { id: 'blocked', cat: 'status', kind: 'badge', label: '卡住了', icon: '✕', bg: '#dc2626', fg: '#ffffff', w: 116, h: 44, rot: -4 },
  { id: 'star-tag', cat: 'status', kind: 'badge', label: '重点', icon: '★', bg: '#eab308', fg: '#1f2023', w: 102, h: 44, rot: 5 },
  { id: 'fixed', cat: 'status', kind: 'badge', label: '已修复', icon: '✓', bg: '#0d9488', fg: '#ffffff', w: 116, h: 44, rot: -4 },
  { id: 'new', cat: 'status', kind: 'badge', label: 'NEW', icon: '✦', bg: '#f2643b', fg: '#ffffff', w: 96, h: 42, rot: 8 },
  // 表情贴纸
  { id: 'e-check', cat: 'emoji', kind: 'emoji', emoji: '✅', label: '完成', w: 76, h: 76, rot: -4 },
  { id: 'e-thumbs', cat: 'emoji', kind: 'emoji', emoji: '👍', label: '赞同', w: 76, h: 76, rot: 5 },
  { id: 'e-fire', cat: 'emoji', kind: 'emoji', emoji: '🔥', label: '火热', w: 76, h: 76, rot: -3 },
  { id: 'e-party', cat: 'emoji', kind: 'emoji', emoji: '🎉', label: '庆祝', w: 76, h: 76, rot: 6 },
  { id: 'e-star', cat: 'emoji', kind: 'emoji', emoji: '⭐', label: '亮点', w: 76, h: 76, rot: -5 },
  { id: 'e-heart', cat: 'emoji', kind: 'emoji', emoji: '❤️', label: '喜欢', w: 76, h: 76, rot: 4 },
  { id: 'e-rocket', cat: 'emoji', kind: 'emoji', emoji: '🚀', label: '上线', w: 76, h: 76, rot: -4 },
  { id: 'e-idea', cat: 'emoji', kind: 'emoji', emoji: '💡', label: '灵感', w: 76, h: 76, rot: 3 },
  { id: 'e-eyes', cat: 'emoji', kind: 'emoji', emoji: '👀', label: '关注', w: 76, h: 76, rot: 0 },
  { id: 'e-question', cat: 'emoji', kind: 'emoji', emoji: '❓', label: '疑问', w: 76, h: 76, rot: 6 },
  { id: 'e-warn', cat: 'emoji', kind: 'emoji', emoji: '⚠️', label: '注意', w: 76, h: 76, rot: -3 },
  { id: 'e-bug', cat: 'emoji', kind: 'emoji', emoji: '🐛', label: 'Bug', w: 76, h: 76, rot: 4 },
  { id: 'e-pin', cat: 'emoji', kind: 'emoji', emoji: '📌', label: '置顶', w: 76, h: 76, rot: -8 },
  { id: 'e-clap', cat: 'emoji', kind: 'emoji', emoji: '👏', label: '鼓掌', w: 76, h: 76, rot: 4 },
  { id: 'e-smile', cat: 'emoji', kind: 'emoji', emoji: '😄', label: '开心', w: 76, h: 76, rot: -3 },
  { id: 'e-thinking', cat: 'emoji', kind: 'emoji', emoji: '🤔', label: '思考', w: 76, h: 76, rot: 3 },
];

const BY_ID = new Map(STICKERS.map((s) => [s.id, s]));

export function stickerById(id) {
  return BY_ID.get(id) || STICKERS[0];
}

export function stickersInCat(cat) {
  return STICKERS.filter((s) => s.cat === cat);
}

export function clampStickerRot(deg) {
  const n = Number(deg);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-45, Math.min(45, Math.round(n)));
}

export function createStickerShape(skId, cx, cy, { id, z = 1, text } = {}) {
  const p = stickerById(skId);
  return {
    id,
    t: 'sticker',
    sk: p.id,
    x: Math.round(cx - p.w / 2),
    y: Math.round(cy - p.h / 2),
    w: p.w,
    h: p.h,
    rot: p.rot,
    text: p.kind === 'emoji' ? '' : (text ?? p.label),
    fill: 'none',
    fs: 16,
    al: 'center',
    z,
  };
}
