// 文件夹层级上传解析、自然排序与增量创建规划（零 DOM 依赖，便于单元测试与复用）

export const IGNORED_NAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);

const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
export const naturalCompare = (a, b) => collator.compare(String(a ?? ''), String(b ?? ''));

export function normalizeRelPath(p) {
  return String(p || '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+|\/+$/g, '');
}

export function isIgnoredFile(name) {
  if (!name) return true;
  return IGNORED_NAMES.has(String(name).trim().toLowerCase());
}

/** 从 <input type="file"> / <input webkitdirectory> 的 FileList 提取相对路径列表 */
export function extractFromFileList(fileList) {
  const files = [];
  for (const f of fileList || []) {
    if (!f) continue;
    const rel = normalizeRelPath(f.webkitRelativePath || f.name || '');
    if (!rel) continue;
    files.push({ file: f, relPath: rel });
  }
  return { files, dirs: [] };
}

function compareDirPaths(a, b) {
  const sa = a.split('/');
  const sb = b.split('/');
  if (sa.length !== sb.length) return sa.length - sb.length;
  for (let i = 0; i < sa.length; i++) {
    const d = naturalCompare(sa[i], sb[i]);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * 基于原始文件和目录列表构建统一的上传计划：
 * - 支持 stripSingleRoot（去掉浏览器 webkitdirectory 自动包的一层总父目录）
 * - 支持 wrapperName（统一收纳到自定义外层父文件夹下）
 * - 自动补全祖先目录路径并按层级 + 自然顺序排序
 */
export function buildUploadPlan(rawFiles = [], rawDirs = [], { stripSingleRoot = false, wrapperName = '' } = {}) {
  const cleanWrapper = String(wrapperName || '').trim().replace(/[\\/]+/g, '_');
  const validFiles = [];
  const rawDirSet = new Set();
  const rawTopSet = new Set();
  let hasRootLooseFiles = false;
  let totalBytes = 0;

  for (const d of rawDirs || []) {
    const norm = normalizeRelPath(d);
    if (!norm) continue;
    const segs = norm.split('/').filter(Boolean);
    if (!segs.length) continue;
    rawTopSet.add(segs[0]);
    for (let i = 1; i <= segs.length; i++) rawDirSet.add(segs.slice(0, i).join('/'));
  }

  for (const item of rawFiles || []) {
    const file = item?.file ?? item;
    if (!file) continue;
    const rawRel = normalizeRelPath(item?.relPath || file.webkitRelativePath || file.name || '');
    if (!rawRel) continue;
    const segs = rawRel.split('/').filter(Boolean);
    if (!segs.length) continue;
    const fileName = segs[segs.length - 1];
    if (isIgnoredFile(fileName)) continue;

    const dirSegs = segs.slice(0, -1);
    if (dirSegs.length) {
      rawTopSet.add(dirSegs[0]);
      for (let i = 1; i <= dirSegs.length; i++) rawDirSet.add(dirSegs.slice(0, i).join('/'));
    } else {
      hasRootLooseFiles = true;
    }
    totalBytes += Number(file.size) || 0;
    validFiles.push({ file, fileName, dirSegs });
  }

  const rawTopDirs = [...rawTopSet].sort(naturalCompare);
  const singleRootName = (!hasRootLooseFiles && rawTopDirs.length === 1) ? rawTopDirs[0] : '';
  const hasNestedOrFilesInSingleRoot = Boolean(
    singleRootName && (
      validFiles.some((f) => f.dirSegs.length > 0) ||
      [...rawDirSet].some((d) => d.includes('/'))
    )
  );
  const canStripRoot = Boolean(singleRootName && hasNestedOrFilesInSingleRoot);
  const shouldStrip = Boolean(stripSingleRoot && canStripRoot);

  const dirSet = new Set();
  const addDirWithAncestors = (segs) => {
    for (let i = 1; i <= segs.length; i++) dirSet.add(segs.slice(0, i).join('/'));
  };

  for (const d of rawDirSet) {
    let segs = d.split('/').filter(Boolean);
    if (shouldStrip && segs[0] === singleRootName) segs = segs.slice(1);
    if (cleanWrapper) segs = [cleanWrapper, ...segs];
    if (segs.length) addDirWithAncestors(segs);
  }

  const mappedFiles = validFiles.map(({ file, fileName, dirSegs }) => {
    let segs = dirSegs;
    if (shouldStrip && segs[0] === singleRootName) segs = segs.slice(1);
    if (cleanWrapper) segs = [cleanWrapper, ...segs];
    if (segs.length) addDirWithAncestors(segs);
    const dirPath = segs.join('/');
    return {
      file,
      fileName,
      dirPath,
      relPath: dirPath ? `${dirPath}/${fileName}` : fileName,
    };
  });

  const dirPaths = [...dirSet].sort(compareDirPaths);
  const topDirs = [...new Set(dirPaths.map((p) => p.split('/')[0]))].sort(naturalCompare);

  return {
    hasDirs: dirPaths.length > 0,
    dirPaths,
    topDirs,
    files: mappedFiles,
    stats: {
      fileCount: mappedFiles.length,
      dirCount: dirPaths.length,
      topDirCount: topDirs.length,
      totalBytes,
      singleRootName,
      canStripRoot,
    },
  };
}

/**
 * 根据排序后的 dirPaths，规划需要新建与复用的文件夹对象（批量写入 columns 表）
 */
export function planFolderCreation(
  dirPaths = [],
  existingFolders = [],
  rootParentId = null,
  { baseOrder = 0, colorStart = 0, colorCount = 8, category, now = Date.now(), makeId } = {},
) {
  const genId = makeId || (() => `${now}_${Math.random().toString(36).slice(2, 10)}`);
  const existingByKey = new Map();
  for (const f of existingFolders || []) {
    if (!f || !f.id) continue;
    const key = `${f.parentId || ''}::${f.title}`;
    if (!existingByKey.has(key)) existingByKey.set(key, f);
  }

  const createdFolders = [];
  const pathToFolderId = new Map();
  const topFolderIdSet = new Set();
  let nextOrder = baseOrder;
  let createdIdx = 0;

  for (const path of dirPaths || []) {
    if (!path) continue;
    const segs = path.split('/').filter(Boolean);
    if (!segs.length) continue;
    const title = segs[segs.length - 1];
    const parentPath = segs.length > 1 ? segs.slice(0, -1).join('/') : '';
    const parentId = parentPath ? (pathToFolderId.get(parentPath) || rootParentId || null) : (rootParentId || null);
    const key = `${parentId || ''}::${title}`;

    let id = existingByKey.get(key)?.id;
    if (!id) {
      id = genId();
      const folder = {
        id,
        kind: 'folder',
        title,
        order: nextOrder,
        doneAt: now,
        color: (colorStart + createdIdx) % Math.max(1, colorCount),
      };
      if (parentId) folder.parentId = parentId;
      else if (category) folder.category = category;
      nextOrder += 1024;
      createdIdx++;
      createdFolders.push(folder);
      existingByKey.set(key, folder);
    }

    pathToFolderId.set(path, id);
    if (segs.length === 1) topFolderIdSet.add(id);
  }

  return {
    createdFolders,
    pathToFolderId,
    topFolderIds: [...topFolderIdSet],
  };
}
