// 文件夹分享：浏览器之间直连（WebRTC / PeerJS），不经过任何服务器存储。
// 分享者的页面开着，对方打开链接就能看到文件列表并直接下载；分享者关掉页面链接就失效。
import { loadPeerJS } from './collab.js?v=6';

const PREFIX = 'fangcun-share-v1-';
const CHUNK = 64 * 1024;          // 每个分片 64KB
const HIGH_WATER = 4 * 1024 * 1024; // 发送缓冲超过 4MB 就等一等（背压，避免把内存撑爆）
const PEER_OPTS = {
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
      { urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'], username: 'peerjs', credential: 'peerjsp' },
    ],
  },
};

export function newShareId(len = 10) {
  const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
  const r = crypto.getRandomValues(new Uint8Array(len));
  return [...r].map((x) => abc[x % abc.length]).join('');
}
export const normalizeShareId = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 32);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function drain(conn) {
  const dc = conn.dataChannel;
  while (dc && dc.readyState === 'open' && dc.bufferedAmount > HIGH_WATER) await sleep(15);
}

// ---------- 分享者 ----------
// files: [{ name, size, type }]；getFile(i) → Blob | string
export class ShareHost {
  constructor({ id, title, files, getFile, onStatus = () => {} }) {
    this.id = id; this.title = title; this.files = files; this.getFile = getFile; this.onStatus = onStatus;
    this.conns = new Set(); this.peer = null; this.closed = false;
    this.state = 'connecting'; this.sending = null; this.sentFiles = 0; this.sentBytes = 0;
  }
  status() {
    return { state: this.state, viewers: this.conns.size, sending: this.sending, sentFiles: this.sentFiles, sentBytes: this.sentBytes };
  }
  emit() { if (!this.closed) this.onStatus(this.status()); }
  async start() {
    const Peer = await loadPeerJS();
    if (!Peer) { this.state = 'error'; this.error = '加载连接组件失败，请检查网络'; this.emit(); return; }
    const peer = new Peer(PREFIX + this.id, PEER_OPTS);
    this.peer = peer;
    peer.on('open', () => { this.state = 'ready'; this.emit(); });
    peer.on('disconnected', () => { if (!this.closed && !peer.destroyed) setTimeout(() => { try { if (!this.closed) peer.reconnect(); } catch {} }, 1000); });
    peer.on('error', (err) => {
      if (this.closed) return;
      if (err?.type === 'peer-unavailable') return; // 对方断开等，不影响分享
      this.state = 'error'; this.error = err?.type === 'unavailable-id' ? '这个分享链接已被占用，请重新分享' : `连接出错：${err?.type || err?.message || err}`;
      this.emit();
    });
    peer.on('connection', (conn) => this.bind(conn));
  }
  bind(conn) {
    let queue = Promise.resolve();
    conn.on('open', () => { this.conns.add(conn); this.emit(); });
    conn.on('close', () => { this.conns.delete(conn); this.emit(); });
    conn.on('error', () => { this.conns.delete(conn); this.emit(); });
    conn.on('data', (m) => {
      if (!m || typeof m !== 'object') return;
      if (m.t === 'hello') conn.send({ t: 'manifest', title: this.title, files: this.files.map((f, i) => ({ i, name: f.name, size: f.size, type: f.type || '' })) });
      // 同一个对方的请求排队，一个一个发
      if (m.t === 'get' && Number.isInteger(m.i) && this.files[m.i]) queue = queue.then(() => this.send(conn, m.i, m.req)).catch(() => {});
    });
  }
  async send(conn, i, req) {
    const f = this.files[i];
    let data;
    try { data = await this.getFile(i); } catch { data = null; }
    if (data == null) { conn.send({ t: 'err', i, req, msg: '文件读取失败' }); return; }
    if (typeof data === 'string') data = new Blob([data], { type: 'text/plain;charset=utf-8' });
    const size = data.size;
    conn.send({ t: 'start', i, req, size, name: f.name, type: data.type || f.type || '' });
    this.sending = { name: f.name, done: 0, size }; this.emit();
    let lastEmit = 0;
    for (let off = 0; off < size; off += CHUNK) {
      if (!conn.open || this.closed) return;
      const buf = await data.slice(off, Math.min(size, off + CHUNK)).arrayBuffer();
      await drain(conn);
      conn.send({ t: 'c', i, req, d: buf });
      this.sentBytes += buf.byteLength; this.sending.done = off + buf.byteLength;
      const now = performance.now();
      if (now - lastEmit > 250) { lastEmit = now; this.emit(); }
    }
    conn.send({ t: 'end', i, req });
    this.sentFiles += 1; this.sending = null; this.emit();
  }
  stop() {
    this.closed = true;
    for (const c of this.conns) { try { c.send({ t: 'bye' }); } catch {} }
    // 先让「停止分享」消息发出去，再断开
    const conns = [...this.conns], peer = this.peer;
    setTimeout(() => { for (const c of conns) { try { c.close(); } catch {} } try { peer?.destroy(); } catch {} }, 600);
  }
}

// ---------- 接收者 ----------
export class ShareGuest {
  constructor(id, { onStatus = () => {}, onManifest = () => {} } = {}) {
    this.id = id; this.onStatus = onStatus; this.onManifest = onManifest;
    this.pending = new Map(); this.reqN = 0; this.conn = null; this.peer = null; this.closed = false;
  }
  async connect() {
    const Peer = await loadPeerJS();
    if (!Peer) return this.onStatus({ state: 'error', msg: '加载连接组件失败，请检查网络后刷新' });
    this.onStatus({ state: 'connecting' });
    const peer = new Peer(PEER_OPTS);
    this.peer = peer;
    const giveUp = setTimeout(() => { if (!this.conn?.open) this.onStatus({ state: 'offline' }); }, 15000);
    peer.on('error', (err) => {
      if (this.closed) return;
      clearTimeout(giveUp);
      this.onStatus(err?.type === 'peer-unavailable' ? { state: 'offline' } : { state: 'error', msg: `连接出错：${err?.type || err?.message || err}` });
    });
    peer.on('open', () => {
      const conn = peer.connect(PREFIX + this.id, { reliable: true });
      this.conn = conn;
      conn.on('open', () => { clearTimeout(giveUp); this.onStatus({ state: 'connected' }); conn.send({ t: 'hello' }); });
      conn.on('close', () => { if (!this.closed && !this.stopped) { this.failAll('分享者已断开'); this.onStatus({ state: 'offline' }); } });
      conn.on('data', (m) => this.onData(m));
    });
  }
  onData(m) {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'manifest') return this.onManifest(m);
    if (m.t === 'bye') { this.stopped = true; this.failAll('分享者已停止分享'); return this.onStatus({ state: 'stopped' }); }
    const p = this.pending.get(m.req);
    if (!p) return;
    if (m.t === 'start') { p.size = m.size; p.type = m.type; p.parts = []; p.got = 0; p.onProgress?.(0, m.size); }
    else if (m.t === 'c') {
      const d = m.d instanceof ArrayBuffer ? m.d : m.d?.buffer ? m.d : new Uint8Array(m.d || []);
      p.parts.push(d); p.got += d.byteLength; p.onProgress?.(p.got, p.size);
    } else if (m.t === 'end') { this.pending.delete(m.req); p.resolve(new Blob(p.parts, { type: p.type || 'application/octet-stream' })); }
    else if (m.t === 'err') { this.pending.delete(m.req); p.reject(new Error(m.msg || '下载失败')); }
  }
  failAll(msg) { for (const p of this.pending.values()) p.reject(new Error(msg)); this.pending.clear(); }
  get(i, onProgress) {
    if (!this.conn?.open) return Promise.reject(new Error('还没有连上分享者'));
    const req = ++this.reqN;
    return new Promise((resolve, reject) => {
      this.pending.set(req, { resolve, reject, onProgress, parts: [], got: 0, size: 0 });
      this.conn.send({ t: 'get', i, req });
    });
  }
  close() { this.closed = true; try { this.conn?.close(); } catch {} try { this.peer?.destroy(); } catch {} }
}
