// 文件名拆分、防重后缀拼接与批量重命名规则引擎

/**
 * 将文件名拆分为基础名（stem）与扩展名（ext）。
 * 便签卡片不拆分扩展名；隐藏点文件（如 .gitignore）保留完整名称为 stem。
 */
export function splitCardName(name, isNote = false) {
  const s = String(name ?? '');
  if (isNote) return { stem: s, ext: '' };
  const m = /^(.*?)(\.[a-z0-9]{1,8})$/i.exec(s);
  if (m && m[1]) return { stem: m[1], ext: m[2] };
  return { stem: s, ext: '' };
}

/**
 * 清理用户输入的基础名并安全拼回扩展名；
 * 若用户自己也输入了相同的扩展名（如 "poster.jpg"），自动去重，避免变成 "poster.jpg.jpg"。
 */
export function joinCardName(rawStem, ext = '', fallbackName = '') {
  let clean = String(rawStem ?? '').replace(/[\x00-\x1f]/g, '').trim();
  if (!clean) return fallbackName;
  if (ext) {
    const eLow = ext.toLowerCase();
    if (clean.toLowerCase().endsWith(eLow) && clean.length >= ext.length) {
      clean = clean.slice(0, clean.length - ext.length).trim();
    }
  }
  if (!clean) return fallbackName;
  return `${clean}${ext}`;
}

/**
 * 按指定样式格式化序号。
 */
export function formatSeqNumber(num, style = '01') {
  const n = Math.max(0, Math.floor(Number(num) || 0));
  switch (style) {
    case '001':
      return String(n).padStart(3, '0');
    case '1':
      return String(n);
    case '(1)':
      return `(${n})`;
    case '01':
    default:
      return String(n).padStart(2, '0');
  }
}

/**
 * 批量序号重命名规则。
 * @param {Array<{origStem: string, ext?: string}>} items
 * @param {{base?: string, sep?: string, numStyle?: string, start?: number, keepOrig?: boolean}} opts
 * @returns {string[]} 每个条目对应的新基础名（不含扩展名）
 */
export function applySequenceRule(items = [], {
  base = '',
  sep = '_',
  numStyle = '01',
  start = 1,
  keepOrig = false,
} = {}) {
  const startNum = Number.isFinite(Number(start)) ? Math.max(0, Math.floor(Number(start))) : 1;
  const trimmedBase = String(base ?? '').trim();
  const useSep = String(sep ?? '');
  return (items || []).map((item, idx) => {
    const prefix = keepOrig ? String(item?.origStem ?? '').trim() : trimmedBase;
    const seq = formatSeqNumber(startNum + idx, numStyle);
    if (!prefix) return seq;
    const connector = numStyle === '(1)' && useSep === '_' ? ' ' : useSep;
    return `${prefix}${connector}${seq}`;
  });
}

/**
 * 批量查找替换与前后缀规则。
 * @param {string[]} stems 当前各行基础名
 * @param {{find?: string, replace?: string, prefix?: string, suffix?: string}} opts
 * @returns {string[]}
 */
export function applyReplaceRule(stems = [], {
  find = '',
  replace = '',
  prefix = '',
  suffix = '',
} = {}) {
  const needle = String(find ?? '');
  const rep = String(replace ?? '');
  const pre = String(prefix ?? '');
  const suf = String(suffix ?? '');
  return (stems || []).map((raw) => {
    let cur = String(raw ?? '');
    if (needle) cur = cur.split(needle).join(rep);
    return `${pre}${cur}${suf}`.trim();
  });
}
