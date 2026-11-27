// 免服务器 P2P 多人实时画布协作引擎（WebRTC PeerJS + BroadcastChannel 双通道自适应）
// 包含：房间号解析、LWW + 墓碑（Tombstone）无冲突合并、大文件（超高清图片/PDF）48KB 分片传输、实时光标与选区同步。

export const COLLAB_COLORS = [
  { name: '晴空蓝', hex: '#2563eb' },
  { name: '珊瑚粉', hex: '#e11d48' },
  { name: '翡翠绿', hex: '#059669' },
  { name: '琥珀橙', hex: '#d97706' },
  { name: '鸢尾紫', hex: '#7c3aed' },
  { name: '青碧色', hex: '#0891b2' },
  { name: '朱砂红', hex: '#dc2626' },
  { name: '靛青色', hex: '#4f46e5' },
];

const ROOM_CHARS = '23456789abcdefghjkmnpqrstuvwxyz';
export const CHUNK_SIZE = 48 * 1024; // 48KB 原始二进制分片（WebRTC DataChannel 安全水位）

export function uid() {
  return (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
}

export function generateRoomId(len = 6) {
  let out = '';
  const arr = new Uint8Array(len);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(arr);
  else for (let i = 0; i < len; i++) arr[i] = Math.floor(Math.random() * 256);
  for (let i = 0; i < len; i++) out += ROOM_CHARS[arr[i] % ROOM_CHARS.length];
  return out;
}

export function normalizeRoomId(input) {
  if (!input) return '';
  let s = String(input).trim();
  if (!s) return '';
  if (s.includes('room=')) {
    try {
      const qIdx = s.indexOf('?');
      const queryPart = (qIdx >= 0 ? s.slice(qIdx) : s).split('#')[0];
      const params = new URLSearchParams(queryPart);
      const r = params.get('room');
      if (r) s = r.trim();
    } catch {}
  }
  s = s.replace(/^[#\s]+/, '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
  return s.length >= 3 && s.length <= 32 ? s : '';
}

export function formatInviteMessage(url, { hostName = '', canvasTitle = '' } = {}) {
  const who = String(hostName || '').trim() || '同伴';
  const title = String(canvasTitle || '').trim();
  const board = title && title !== '画布' ? `画布「${title}」` : '画布';
  return `${who} 邀请你一起在方寸协作创作${board}，打开浏览器进入：${url}`;
}

export function clonePlain(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  return JSON.parse(JSON.stringify(obj, (k, v) => (k === '_t' ? undefined : v)));
}

export function mergeTombstones(a = {}, b = {}) {
  const out = { ...a };
  for (const [id, ts] of Object.entries(b || {})) {
    const n = Number(ts) || 0;
    if (n > (out[id] || 0)) out[id] = n;
  }
  return out;
}

/**
 * 合并画布评论/备注列表（支持并发回复无冲突合并 + 解决状态 LWW + 墓碑删除保护）
 */
export function mergeComments(localComments = [], remoteComments = [], tombstones = {}) {
  const mergeReplies = (localReplies = [], remoteReplies = []) => {
    const rMap = new Map();
    for (const r of localReplies || []) {
      if (!r?.id) continue;
      const ru = Number(r._u || r.createdAt || 1);
      if ((tombstones[r.id] || 0) >= ru) continue;
      rMap.set(r.id, clonePlain({ ...r, _u: ru }));
    }
    for (const r of remoteReplies || []) {
      if (!r?.id) continue;
      const ru = Number(r._u || r.createdAt || 1);
      if ((tombstones[r.id] || 0) >= ru) {
        const cur = rMap.get(r.id);
        if (cur && (tombstones[r.id] || 0) >= (cur._u || 1)) rMap.delete(r.id);
        continue;
      }
      const cur = rMap.get(r.id);
      if (!cur || ru >= (cur._u || 1)) {
        rMap.set(r.id, clonePlain({ ...r, _u: ru }));
      }
    }
    return [...rMap.values()].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0) || String(a.id).localeCompare(String(b.id)));
  };

  const map = new Map();
  for (const cm of localComments || []) {
    if (!cm?.id) continue;
    const u = Number(cm._u || cm.createdAt || 1);
    if ((tombstones[cm.id] || 0) >= u) continue;
    const replies = mergeReplies(cm.replies, []);
    const maxRU = replies.reduce((m, r) => Math.max(m, Number(r._u || r.createdAt || 0)), 0);
    map.set(cm.id, clonePlain({ ...cm, replies, _u: Math.max(u, maxRU) }));
  }

  for (const cm of remoteComments || []) {
    if (!cm?.id) continue;
    const u = Number(cm._u || cm.createdAt || 1);
    if ((tombstones[cm.id] || 0) >= u) {
      const cur = map.get(cm.id);
      if (cur && (tombstones[cm.id] || 0) >= (cur._u || 1)) map.delete(cm.id);
      continue;
    }
    const cur = map.get(cm.id);
    if (!cur) {
      const replies = mergeReplies([], cm.replies);
      const maxRU = replies.reduce((m, r) => Math.max(m, Number(r._u || r.createdAt || 0)), 0);
      map.set(cm.id, clonePlain({ ...cm, replies, _u: Math.max(u, maxRU) }));
    } else {
      const curU = Number(cur._u || cur.createdAt || 1);
      const base = u >= curU ? clonePlain(cm) : clonePlain(cur);
      const replies = mergeReplies(cur.replies, cm.replies);
      const maxRU = replies.reduce((m, r) => Math.max(m, Number(r._u || r.createdAt || 0)), 0);
      base.replies = replies;
      base._u = Math.max(curU, u, maxRU);
      map.set(cm.id, base);
    }
  }

  return [...map.values()].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0) || String(a.id).localeCompare(String(b.id)));
}

/**
 * 合并画布白板状态（形状 shapes、连线 links、评论备注 comments、标题 title）
 * 采用 LWW（Last-Write-Wins，基于 _u 时间戳）+ 删除墓碑（tombstones），防止已删除对象“复活”。
 */
export function mergeBoardState(localBoard, remoteBoard, tombstones = {}) {
  const tombs = mergeTombstones(localBoard?.tombstones, mergeTombstones(remoteBoard?.tombstones, tombstones));
  const mergeItems = (localList = [], remoteList = []) => {
    const map = new Map();
    for (const item of localList) {
      if (!item?.id) continue;
      const u = Number(item._u || item.updatedAt || 1);
      if ((tombs[item.id] || 0) >= u) continue;
      map.set(item.id, clonePlain({ ...item, _u: u }));
    }
    for (const item of remoteList) {
      if (!item?.id) continue;
      const u = Number(item._u || item.updatedAt || 1);
      if ((tombs[item.id] || 0) >= u) {
        const cur = map.get(item.id);
        if (cur && (tombs[item.id] || 0) >= (cur._u || 1)) map.delete(item.id);
        continue;
      }
      const cur = map.get(item.id);
      if (!cur || u >= (cur._u || 1)) {
        map.set(item.id, clonePlain({ ...item, _u: u }));
      }
    }
    return [...map.values()];
  };

  const shapes = mergeItems(localBoard?.shapes, remoteBoard?.shapes);
  const rawLinks = mergeItems(localBoard?.links, remoteBoard?.links);
  // 过滤掉指向已被墓碑删除对象的悬空连线
  const links = rawLinks.filter((l) => {
    const fId = l?.from?.id, tId = l?.to?.id;
    if (fId && (tombs[fId] || 0) >= (l._u || 1)) return false;
    if (tId && (tombs[tId] || 0) >= (l._u || 1)) return false;
    return true;
  });
  const comments = mergeComments(localBoard?.comments, remoteBoard?.comments, tombs);

  const localU = Number(localBoard?._u || 0);
  const remoteU = Number(remoteBoard?._u || 0);
  const title = remoteU >= localU && remoteBoard?.title ? remoteBoard.title : (localBoard?.title || remoteBoard?.title || '画布');

  return {
    title,
    _u: Math.max(localU, remoteU, Date.now()),
    shapes,
    links,
    comments,
    tombstones: tombs,
  };
}

/**
 * 合并指定画布上的卡片（便签卡片与文件卡片：高清图片、PDF 等）
 */
export function mergeCanvasCards(localCards = [], remoteCards = [], canvasId, tombstones = {}) {
  const byId = new Map(localCards.map((c) => [c.id, c]));
  const added = [];
  const updated = [];
  const removedIds = [];

  for (const rc of remoteCards || []) {
    if (!rc?.id) continue;
    const u = Number(rc.updatedAt || rc._u || 1);
    const deadAt = Number(tombstones[rc.id] || 0);
    const cur = byId.get(rc.id);

    if (deadAt >= u || rc.columnId !== canvasId || rc.trashedAt) {
      if (cur && cur.columnId === canvasId && (cur.updatedAt || 0) <= Math.max(u, deadAt)) {
        removedIds.push(rc.id);
      }
      continue;
    }

    if (!cur) {
      const clean = clonePlain({ ...rc, columnId: canvasId, updatedAt: u });
      byId.set(clean.id, clean);
      added.push(clean);
    } else if (u >= Number(cur.updatedAt || 0)) {
      const next = {
        ...cur,
        ...clonePlain(rc),
        columnId: canvasId,
        updatedAt: u,
        // 保留本地已就绪的缩略图状态，避免重新触发不必要的骨架闪烁
        thumb: cur.thumb === 'ok' ? 'ok' : rc.thumb,
      };
      byId.set(next.id, next);
      updated.push(next);
    }
  }

  for (const c of byId.values()) {
    if (c.columnId === canvasId) {
      const deadAt = Number(tombstones[c.id] || 0);
      if (deadAt && deadAt >= Number(c.updatedAt || 1) && !removedIds.includes(c.id)) {
        removedIds.push(c.id);
      }
    }
  }

  const removedSet = new Set(removedIds);
  const cards = [...byId.values()].filter((c) => !(c.columnId === canvasId && removedSet.has(c.id)));
  return { cards, added, updated, removedIds };
}

// ---------- 二进制文件（高清图片 / PDF）48KB 分片与重组 ----------
export function uint8ToBase64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (typeof Buffer !== 'undefined') return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString('base64');
  let bin = '';
  const step = 0x8000;
  for (let i = 0; i < u8.length; i += step) {
    bin += String.fromCharCode.apply(null, u8.subarray(i, i + step));
  }
  return btoa(bin);
}

export function base64ToUint8(b64) {
  if (typeof Buffer !== 'undefined') {
    const buf = Buffer.from(b64, 'base64');
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function chunkArrayBuffer(buffer, { cardId, kind = 'main', mime = 'application/octet-stream', chunkSize = CHUNK_SIZE } = {}) {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const totalBytes = u8.byteLength;
  const total = Math.max(1, Math.ceil(totalBytes / chunkSize));
  const transferId = `${cardId}:${kind}:${totalBytes}`;
  const chunks = [];
  for (let i = 0; i < total; i++) {
    const slice = u8.subarray(i * chunkSize, Math.min(totalBytes, (i + 1) * chunkSize));
    chunks.push({
      type: 'blob-chunk',
      transferId,
      cardId,
      kind,
      mime,
      size: totalBytes,
      total,
      index: i,
      data: uint8ToBase64(slice),
    });
  }
  return chunks;
}

export class BlobAssembler {
  constructor() {
    this.transfers = new Map();
  }

  receive(msg) {
    if (!msg || msg.type !== 'blob-chunk' || !msg.cardId) return null;
    const key = msg.transferId || `${msg.cardId}:${msg.kind || 'main'}`;
    let t = this.transfers.get(key);
    if (!t || t.total !== msg.total) {
      t = {
        cardId: msg.cardId,
        kind: msg.kind || 'main',
        mime: msg.mime || 'application/octet-stream',
        size: msg.size || 0,
        total: msg.total || 1,
        parts: new Array(msg.total || 1).fill(null),
        received: 0,
        updatedAt: Date.now(),
      };
      this.transfers.set(key, t);
    }
    const idx = msg.index;
    if (idx < 0 || idx >= t.total) return null;
    if (!t.parts[idx]) {
      t.parts[idx] = base64ToUint8(msg.data || '');
      t.received++;
      t.updatedAt = Date.now();
    }
    const progress = Math.round((t.received / t.total) * 100);
    if (t.received < t.total) {
      return { done: false, cardId: t.cardId, kind: t.kind, progress };
    }
    this.transfers.delete(key);
    const totalLen = t.parts.reduce((n, p) => n + p.byteLength, 0);
    const merged = new Uint8Array(totalLen);
    let offset = 0;
    for (const p of t.parts) {
      merged.set(p, offset);
      offset += p.byteLength;
    }
    return {
      done: true,
      cardId: t.cardId,
      kind: t.kind,
      mime: t.mime,
      size: totalLen,
      bytes: merged,
      progress: 100,
    };
  }
}

// ---------- 按需加载 PeerJS（主 CDN + 备用 CDN 自动降级） ----------
const PEER_CDNS = [
  'https://cdnjs.cloudflare.com/ajax/libs/peerjs/1.5.4/peerjs.min.js',
  'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js',
];
let peerLibPromise = null;
export function loadPeerJS() {
  if (globalThis.Peer) return Promise.resolve(globalThis.Peer);
  if (typeof document === 'undefined') return Promise.resolve(null);
  if (peerLibPromise) return peerLibPromise;
  peerLibPromise = new Promise((resolve) => {
    let idx = 0;
    const tryNext = () => {
      if (globalThis.Peer) return resolve(globalThis.Peer);
      if (idx >= PEER_CDNS.length) { peerLibPromise = null; return resolve(null); }
      const s = document.createElement('script');
      s.src = PEER_CDNS[idx++];
      s.async = true;
      s.crossOrigin = 'anonymous';
      s.onload = () => (globalThis.Peer ? resolve(globalThis.Peer) : tryNext());
      s.onerror = () => { s.remove(); tryNext(); };
      document.head.appendChild(s);
    };
    tryNext();
  });
  return peerLibPromise;
}

// ---------- 实时协作会话管理 ----------
export class CollabSession {
  constructor({
    roomId,
    canvasId,
    joining = false,
    user = {},
    onEvent = () => {},
    getSnapshot = () => null,
    getBlobById = async () => null,
    enableWebRTC = true,
    transportFactory = null,
  }) {
    this.roomId = normalizeRoomId(roomId) || generateRoomId();
    this.canvasId = canvasId;
    this.joining = Boolean(joining);
    this.self = {
      id: user.id || uid(),
      name: (user.name || '').trim() || `协作者 ${Math.floor(100 + Math.random() * 900)}`,
      color: user.color || COLLAB_COLORS[0].hex,
      isHost: !joining,
    };
    this.onEvent = onEvent;
    this.getSnapshot = getSnapshot;
    this.getBlobById = getBlobById;
    this.enableWebRTC = enableWebRTC;
    this.transportFactory = transportFactory;

    this.peers = new Map(); // peerId -> peerInfo
    this.tombstones = {};   // itemId -> deletedAt
    this.seenMsgs = new Set();
    this.assembler = new BlobAssembler();
    this.pendingBlobReqs = new Set();
    this.rtcConns = new Map(); // peerId -> DataConnection
    this.rtcPeer = null;
    this.peerClass = null;
    this.hostPeerId = '';
    this.bc = null;
    this.closed = false;
    this.rtcStatus = 'connecting'; // 'connecting' | 'connected' | 'local-only'
    this.heartbeatTimer = 0;
    this.joinFallbackTimer = 0;
    this.connWatchdogTimer = 0;
    this.failoverTimer = 0;
  }

  async start() {
    this._initLocalTransport();
    if (this.enableWebRTC && typeof window !== 'undefined') {
      this._initWebRTC();
    } else {
      this.self.isHost = !this.joining;
      this.rtcStatus = 'local-only';
    }
    this._announceHello(true);
    this.heartbeatTimer = setInterval(() => this._tickHeartbeat(), 2600);
    this.heartbeatTimer.unref?.();
    if (this.joining) {
      // 7 秒后若仍无任何同伴在线且无直连，降级结束加入等待状态以免永远卡死在只读状态
      this.joinFallbackTimer = setTimeout(() => {
        if (this.closed || !this.joining) return;
        if (this.peers.size === 0 && this.rtcConns.size === 0) {
          this.joining = false;
          this.self.isHost = true;
          this._emit('status', this.getStatus());
        }
      }, 7000);
      this.joinFallbackTimer.unref?.();
    }
    this._emit('status', this.getStatus());
    return this;
  }

  markSynced(canvasId) {
    this.joining = false;
    clearTimeout(this.joinFallbackTimer);
    this.joinFallbackTimer = 0;
    if (canvasId) this.canvasId = canvasId;
  }

  stop() {
    if (this.closed) return;
    clearInterval(this.heartbeatTimer);
    clearTimeout(this.joinFallbackTimer);
    clearTimeout(this.connWatchdogTimer);
    clearTimeout(this.failoverTimer);
    try { this.send('bye', { peerId: this.self.id }); } catch {}
    this.closed = true;
    try { this.bc?.close?.(); } catch {}
    for (const conn of this.rtcConns.values()) {
      try { conn.close(); } catch {}
    }
    this.rtcConns.clear();
    try { this.rtcPeer?.destroy?.(); } catch {}
    this.rtcPeer = null;
    this.peers.clear();
  }

  updateSelf({ name, color }) {
    if (name && name.trim()) this.self.name = name.trim().slice(0, 24);
    if (color) this.self.color = color;
    this._announceHello(false);
    this._emit('peers', this.getPeers());
  }

  recordTombstones(ids = [], ts = Date.now()) {
    for (const id of ids) {
      if (id) this.tombstones[id] = Math.max(this.tombstones[id] || 0, ts);
    }
  }

  getPeers() {
    const now = Date.now();
    const list = [];
    for (const [id, p] of this.peers) {
      if (now - (p.lastSeen || 0) > 12000) {
        this.peers.delete(id);
        continue;
      }
      list.push(p);
    }
    return list;
  }

  getStatus() {
    return {
      roomId: this.roomId,
      canvasId: this.canvasId,
      self: { ...this.self },
      peers: this.getPeers(),
      rtcStatus: this.rtcStatus,
      totalOnline: 1 + this.getPeers().length,
    };
  }

  send(type, payload = {}) {
    if (this.closed) return null;
    const pkt = {
      msgId: uid(),
      roomId: this.roomId,
      senderId: this.self.id,
      sender: { id: this.self.id, name: this.self.name, color: this.self.color, isHost: this.self.isHost },
      ts: Date.now(),
      type,
      ...payload,
    };
    this._rememberMsg(pkt.msgId);
    this._dispatchRaw(pkt);
    return pkt;
  }

  requestBlob(cardId, kind = 'main') {
    if (!cardId) return;
    const key = `${cardId}:${kind}`;
    if (this.pendingBlobReqs.has(key)) return;
    this.pendingBlobReqs.add(key);
    this.send('blob-req', { cardId, kind });
    const timer = setTimeout(() => this.pendingBlobReqs.delete(key), 8000);
    timer.unref?.();
  }

  async sendBlob(cardId, kind = 'main') {
    const blob = await this.getBlobById(cardId, kind);
    if (!blob) return false;
    const buf = await blob.arrayBuffer();
    const chunks = chunkArrayBuffer(buf, {
      cardId,
      kind,
      mime: blob.type || 'application/octet-stream',
    });
    for (let i = 0; i < chunks.length; i++) {
      if (this.closed) return false;
      this.send('blob-chunk', chunks[i]);
      // 每 6 个分片让出微任务队列，保证实时光标与拖拽不卡顿
      if (i % 6 === 5) await new Promise((r) => setTimeout(r, 4));
    }
    return true;
  }

  _initLocalTransport() {
    const chName = `fangcun-collab-${this.roomId}`;
    if (this.transportFactory) {
      this.bc = this.transportFactory(chName, (pkt) => this._onPacket(pkt, 'local'));
    } else if (typeof BroadcastChannel !== 'undefined') {
      this.bc = new BroadcastChannel(chName);
      this.bc.onmessage = (e) => this._onPacket(e.data, 'local');
    }
  }

  async _initWebRTC() {
    const PeerClass = await loadPeerJS();
    if (!PeerClass || this.closed) {
      this.self.isHost = !this.joining;
      this.rtcStatus = 'local-only';
      this._emit('status', this.getStatus());
      return;
    }
    this.peerClass = PeerClass;
    this.hostPeerId = `fangcun-wb-v1-${this.roomId}`;
    // 新加入链接的访客优先以访客身份直连房主；房主优先注册房主信令 ID
    this._tryClaimOrJoinRTC(PeerClass, this.hostPeerId, !this.joining);
  }

  _tryClaimOrJoinRTC(PeerClass, hostPeerId, tryAsHost) {
    if (this.closed || !PeerClass) return;
    clearTimeout(this.connWatchdogTimer);
    this.connWatchdogTimer = 0;
    clearTimeout(this.failoverTimer);
    this.failoverTimer = 0;
    const peerOpts = {
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
          { urls: 'stun:stun.cloudflare.com:3478' },
          {
            urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'],
            username: 'peerjs',
            credential: 'peerjsp',
          },
        ],
        sdpSemantics: 'unified-plan',
      },
    };
    let peer;
    try {
      peer = tryAsHost ? new PeerClass(hostPeerId, peerOpts) : new PeerClass(peerOpts);
    } catch {
      this.rtcStatus = 'local-only';
      this._emit('status', this.getStatus());
      return;
    }
    this.rtcPeer = peer;

    peer.on('open', () => {
      if (this.closed || this.rtcPeer !== peer) return;
      this.self.isHost = tryAsHost;
      if (tryAsHost) this.markSynced();
      this.rtcStatus = 'connected';
      if (!tryAsHost) {
        // 保持 PeerJS 默认 BinaryPack（支持 >16KB 自动分包，大快照与 48KB 文件分片不会触发 MessageToBig）
        const conn = peer.connect(hostPeerId, { reliable: true });
        this._bindRTCConn(conn);
        // 6 秒建连看门狗：若房主信令僵尸残留或 ICE 卡住未 open，自动销毁重建并尝试接管房主 ID
        this.connWatchdogTimer = setTimeout(() => {
          if (this.closed || this.rtcPeer !== peer || conn.open || this.rtcConns.size > 0) return;
          try { conn.close(); } catch {}
          try { peer.destroy(); } catch {}
          this._tryClaimOrJoinRTC(PeerClass, hostPeerId, true);
        }, 6000);
        this.connWatchdogTimer.unref?.();
      }
      this._announceHello(true);
      this._emit('status', this.getStatus());
    });

    peer.on('disconnected', () => {
      if (this.closed || this.rtcPeer !== peer || peer.destroyed) return;
      // 保持与 0.peerjs.com 信令服务器心跳连通，以便后加入的同伴能随时找到本节点
      setTimeout(() => {
        if (!this.closed && this.rtcPeer === peer && !peer.destroyed && peer.disconnected) {
          try { peer.reconnect(); } catch {}
        }
      }, 1000).unref?.();
    });

    peer.on('connection', (conn) => {
      if (this.closed || this.rtcPeer !== peer) return;
      this._bindRTCConn(conn);
    });

    peer.on('error', (err) => {
      if (this.closed || this.rtcPeer !== peer) return;
      if (tryAsHost && (err?.type === 'unavailable-id' || /taken|unavailable/i.test(err?.message || ''))) {
        try { peer.destroy(); } catch {}
        this._tryClaimOrJoinRTC(PeerClass, hostPeerId, false);
        return;
      }
      if (!tryAsHost && err?.type === 'peer-unavailable') {
        // 原房主尚未在线：尝试接管房主信令 ID；若房主恰好先连上则会回退并保持 joining=true
        try { peer.destroy(); } catch {}
        setTimeout(() => this._tryClaimOrJoinRTC(PeerClass, hostPeerId, true), 300).unref?.();
        return;
      }
      this.rtcStatus = this.rtcConns.size ? 'connected' : 'local-only';
      this._emit('status', this.getStatus());
    });
  }

  _bindRTCConn(conn) {
    if (!conn) return;
    const onOpen = () => {
      if (this.closed) return;
      clearTimeout(this.connWatchdogTimer);
      this.connWatchdogTimer = 0;
      this.rtcConns.set(conn.peer, conn);
      this.rtcStatus = 'connected';
      this._announceHello(true);
      // 仅房主或已完成画布同步的节点可下发 welcome 快照；正在加入的新访客绝不发送自己的本地空画布覆盖房主！
      if (!this.joining) {
        const snap = this.getSnapshot();
        if (snap) {
          try {
            conn.send({
              msgId: uid(),
              roomId: this.roomId,
              senderId: this.self.id,
              sender: { ...this.self },
              ts: Date.now(),
              type: 'welcome',
              snapshot: snap,
              tombstones: this.tombstones,
            });
          } catch {}
        }
      }
      this._emit('status', this.getStatus());
    };
    if (conn.open) onOpen();
    else conn.on('open', onOpen);
    conn.on('data', (pkt) => this._onPacket(pkt, conn.peer));
    const cleanup = () => {
      const had = this.rtcConns.delete(conn.peer);
      if (had) this._emit('status', this.getStatus());
      // 若原房主断线离开，已同步的访客抖动退避后自动接管房主信令 ID，保障后续新同伴仍可进入
      if (!this.closed && !this.self.isHost && !this.joining && conn.peer === this.hostPeerId && this.peerClass && !this.failoverTimer) {
        const delay = 250 + Math.floor(Math.random() * 450);
        this.failoverTimer = setTimeout(() => {
          this.failoverTimer = 0;
          if (this.closed || this.self.isHost || this.rtcConns.size > 0) return;
          try { this.rtcPeer?.destroy(); } catch {}
          this._tryClaimOrJoinRTC(this.peerClass, this.hostPeerId, true);
        }, delay);
        this.failoverTimer.unref?.();
      }
    };
    conn.on('close', cleanup);
    conn.on('error', cleanup);
  }

  _dispatchRaw(pkt, excludeRtcPeer = null, excludeLocal = false) {
    if (!excludeLocal && this.bc) {
      try { this.bc.postMessage(pkt); } catch {}
    }
    for (const [pid, conn] of this.rtcConns) {
      if (pid === excludeRtcPeer || !conn.open) continue;
      try { conn.send(pkt); } catch {}
    }
  }

  _rememberMsg(msgId) {
    if (!msgId) return;
    this.seenMsgs.add(msgId);
    if (this.seenMsgs.size > 2000) {
      const first = this.seenMsgs.values().next().value;
      this.seenMsgs.delete(first);
    }
  }

  _announceHello(requestSync = false) {
    this.send('hello', { requestSync });
  }

  _tickHeartbeat() {
    if (this.closed) return;
    const before = this.peers.size;
    this.getPeers();
    if (this.joining) this._announceHello(true);
    else this.send('ping', {});
    if (this.peers.size !== before) {
      this._emit('peers', this.getPeers());
      this._emit('status', this.getStatus());
    }
  }

  _touchPeer(pkt) {
    if (!pkt?.senderId || pkt.senderId === this.self.id) return null;
    const prev = this.peers.get(pkt.senderId) || {};
    const next = {
      ...prev,
      id: pkt.senderId,
      name: pkt.sender?.name || prev.name || '协作者',
      color: pkt.sender?.color || prev.color || COLLAB_COLORS[1].hex,
      isHost: Boolean(pkt.sender?.isHost),
      lastSeen: Date.now(),
    };
    const isNew = !this.peers.has(pkt.senderId);
    const changedMeta = prev.name !== next.name || prev.color !== next.color || prev.isHost !== next.isHost;
    this.peers.set(pkt.senderId, next);
    if (isNew || changedMeta) {
      this._emit('peers', this.getPeers());
      this._emit('status', this.getStatus());
    }
    return { peer: next, isNew };
  }

  _onPacket(pkt, via) {
    if (this.closed || !pkt || pkt.roomId !== this.roomId) return;
    if (pkt.senderId === this.self.id) return;
    if (pkt.msgId && this.seenMsgs.has(pkt.msgId)) return;
    this._rememberMsg(pkt.msgId);

    // 房主节点承担星型中继（将某位 WebRTC 访客或本地通道的消息转发给其他远端访客）
    if (this.self.isHost && this.rtcConns.size > 0) {
      this._dispatchRaw(pkt, via === 'local' ? null : via, via === 'local');
    }

    if (pkt.tombstones) {
      this.tombstones = mergeTombstones(this.tombstones, pkt.tombstones);
    }

    if (pkt.type === 'bye') {
      if (pkt.senderId && this.peers.has(pkt.senderId)) {
        this.peers.delete(pkt.senderId);
        this._emit('peers', this.getPeers());
        this._emit('status', this.getStatus());
      }
      return;
    }

    const touched = this._touchPeer(pkt);

    switch (pkt.type) {
      case 'hello': {
        if (pkt.requestSync && !this.joining) {
          const snap = this.getSnapshot();
          if (snap) {
            this.send('welcome', { snapshot: snap, tombstones: this.tombstones });
          } else {
            this.send('ping', {});
          }
        } else if (touched?.isNew) {
          this.send('ping', {});
        }
        break;
      }
      case 'ping':
        break;
      case 'cursor': {
        const p = this.peers.get(pkt.senderId);
        if (p) {
          if (typeof pkt.x === 'number') p.x = pkt.x;
          if (typeof pkt.y === 'number') p.y = pkt.y;
          p.tool = pkt.tool || 'select';
          p.selIds = Array.isArray(pkt.selIds) ? pkt.selIds : [];
          p.editingId = pkt.editingId || null;
          p.action = pkt.action || '';
          p.cam = pkt.cam || p.cam;
        }
        this._emit('cursor', { peer: p, pkt });
        break;
      }
      case 'welcome':
      case 'board-sync':
      case 'shape-live':
      case 'cards-sync':
      case 'card-live':
      case 'comment-notify': {
        this._emit(pkt.type, pkt);
        break;
      }
      case 'blob-req': {
        if (pkt.cardId) {
          this.sendBlob(pkt.cardId, pkt.kind || 'main').catch(() => {});
        }
        break;
      }
      case 'blob-chunk': {
        const res = this.assembler.receive(pkt);
        if (res) {
          if (res.done) this.pendingBlobReqs.delete(`${res.cardId}:${res.kind}`);
          this._emit('blob-progress', res);
        }
        break;
      }
    }
  }

  _emit(type, detail) {
    try { this.onEvent(type, detail); } catch (e) { console.error('Collab event error:', e); }
  }
}
