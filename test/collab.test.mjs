import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateRoomId,
  normalizeRoomId,
  mergeBoardState,
  mergeCanvasCards,
  chunkArrayBuffer,
  BlobAssembler,
  CollabSession,
} from '../collab.js';

test('generateRoomId and normalizeRoomId handle codes, hashes, and invite URLs', () => {
  const code = generateRoomId();
  assert.equal(code.length, 6);
  assert.equal(normalizeRoomId(code), code);
  assert.equal(normalizeRoomId(`  #${code.toUpperCase()} `), code);
  assert.equal(normalizeRoomId(`https://ryanwang688.github.io/personal-workbench/?room=${code}#canvas`), code);
  assert.equal(normalizeRoomId('?foo=1&room=team-room_01'), 'team-room_01');
  assert.equal(normalizeRoomId('ab'), '');
});

test('mergeBoardState merges concurrent shapes, resolves LWW conflicts, and enforces deletion tombstones', () => {
  const local = {
    title: '架构草图',
    _u: 100,
    shapes: [
      { id: 's1', t: 'sticky', x: 10, y: 20, w: 200, h: 200, text: '旧文案', _u: 100 },
      { id: 's2', t: 'rect', x: 300, y: 40, w: 180, h: 120, text: '将被删除', _u: 100 },
    ],
    links: [
      { id: 'l1', from: { id: 's1' }, to: { id: 's2' }, end: 'arrow', _u: 100 },
    ],
  };

  const remote = {
    title: '架构草图 v2',
    _u: 200,
    shapes: [
      { id: 's1', t: 'sticky', x: 80, y: 120, w: 200, h: 200, text: '同伴更新后的文案', _u: 180 },
      { id: 's2', t: 'rect', x: 300, y: 40, w: 180, h: 120, text: '旧快照里的 s2', _u: 100 },
      { id: 's3', t: 'ellipse', x: 500, y: 200, w: 160, h: 160, text: '新增节点', _u: 190 },
    ],
    links: [
      { id: 'l1', from: { id: 's1' }, to: { id: 's2' }, end: 'arrow', _u: 100 },
      { id: 'l2', from: { id: 's1' }, to: { id: 's3' }, end: 'arrow', _u: 195 },
    ],
  };

  // s2 在 t=150 时已被删除
  const merged = mergeBoardState(local, remote, { s2: 150 });
  assert.equal(merged.title, '架构草图 v2');
  assert.deepEqual(merged.shapes.map((s) => s.id), ['s1', 's3']);
  assert.equal(merged.shapes.find((s) => s.id === 's1').text, '同伴更新后的文案');
  assert.equal(merged.shapes.find((s) => s.id === 's1').x, 80);
  // 指向已删除形状 s2 的悬空连线 l1 自动被清理，有效连线 l2 保留
  assert.deepEqual(merged.links.map((l) => l.id), ['l2']);
});

test('mergeCanvasCards merges high-res image & PDF cards, preserves local thumb state, and honors tombstones', () => {
  const canvasId = 'cv-main';
  const localCards = [
    { id: 'c1', kind: 'file', name: 'poster.png', columnId: canvasId, x: 100, y: 100, w: 360, thumb: 'ok', updatedAt: 100 },
    { id: 'c2', kind: 'file', name: 'manual.pdf', columnId: canvasId, x: 500, y: 100, w: 420, pdfPage: 1, updatedAt: 100 },
    { id: 'c3', kind: 'note', name: '看板卡片', columnId: 'col-inbox', order: 0, updatedAt: 90 },
  ];
  const remoteCards = [
    { id: 'c1', kind: 'file', name: 'poster.png', columnId: canvasId, x: 240, y: 180, w: 480, updatedAt: 220 },
    { id: 'c2', kind: 'file', name: 'manual.pdf', columnId: canvasId, x: 500, y: 100, w: 420, pdfPage: 4, updatedAt: 110 },
    { id: 'c4', kind: 'file', name: 'new-spec.pdf', columnId: canvasId, x: 900, y: 100, w: 360, pdfPage: 2, updatedAt: 250 },
  ];

  // c2 在 t=200 被移出画布或删除
  const res = mergeCanvasCards(localCards, remoteCards, canvasId, { c2: 200 });
  assert.deepEqual(res.added.map((c) => c.id), ['c4']);
  assert.deepEqual(res.updated.map((c) => c.id), ['c1']);
  assert.deepEqual(res.removedIds, ['c2']);

  const c1 = res.cards.find((c) => c.id === 'c1');
  assert.equal(c1.x, 240);
  assert.equal(c1.w, 480);
  assert.equal(c1.thumb, 'ok'); // 保留本地已生成的缩略图标记
  assert.ok(res.cards.find((c) => c.id === 'c3')); // 其他列卡片不受影响
  assert.ok(!res.cards.find((c) => c.id === 'c2'));
});

test('chunkArrayBuffer and BlobAssembler transfer multi-chunk binary files out of order with byte accuracy', () => {
  // 构造 130KB 的模拟高清图片/PDF 二进制数据（跨越 3 个 48KB 分片）
  const raw = new Uint8Array(130 * 1024);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 73 + 19) & 0xff;

  const chunks = chunkArrayBuffer(raw.buffer, {
    cardId: 'card-hd-1',
    kind: 'main',
    mime: 'application/pdf',
  });
  assert.equal(chunks.length, 3);

  const assembler = new BlobAssembler();
  // 乱序到达：先发第 2 片，再发第 0 片，重复发第 0 片，最后发第 1 片
  const r1 = assembler.receive(chunks[2]);
  assert.equal(r1.done, false);
  assert.equal(r1.progress, 33);

  const r2 = assembler.receive(chunks[0]);
  assert.equal(r2.done, false);
  assert.equal(r2.progress, 67);

  const rDup = assembler.receive(chunks[0]);
  assert.equal(rDup.done, false);
  assert.equal(rDup.progress, 67);

  const r3 = assembler.receive(chunks[1]);
  assert.equal(r3.done, true);
  assert.equal(r3.progress, 100);
  assert.equal(r3.mime, 'application/pdf');
  assert.equal(r3.size, raw.byteLength);
  assert.deepEqual(r3.bytes, raw);
});

test('CollabSession syncs welcome snapshot, live cursors, live shapes, PDF pages, and binary blobs across 3 peers', async () => {
  // 内存广播总线，模拟多窗口/多客户端 P2P 通道
  const buses = new Map();
  const makeTransport = (chName, onMsg) => {
    let subs = buses.get(chName);
    if (!subs) buses.set(chName, (subs = new Set()));
    const fn = (pkt) => queueMicrotask(() => onMsg(structuredClone(pkt)));
    subs.add(fn);
    return {
      postMessage(pkt) {
        for (const s of subs) if (s !== fn) s(pkt);
      },
      close() {
        subs.delete(fn);
      },
    };
  };

  const hostState = {
    canvasId: 'canvas-1',
    title: '产品共创白板',
    _u: 100,
    shapes: [{ id: 'sh-1', t: 'sticky', x: 120, y: 160, w: 200, h: 200, text: '初始便签', _u: 100 }],
    links: [],
    cards: [{ id: 'file-1', kind: 'file', name: 'spec.pdf', type: 'application/pdf', size: 8192, columnId: 'canvas-1', x: 400, y: 160, w: 360, pdfPage: 1, updatedAt: 100 }],
  };
  const samplePdfBytes = new Uint8Array(8192);
  for (let i = 0; i < samplePdfBytes.length; i++) samplePdfBytes[i] = i & 0xff;

  let guestBWelcome = null;
  let guestCShapeLive = null;
  let hostReceivedCursor = null;
  let guestBReceivedBlob = null;

  const host = new CollabSession({
    roomId: 'team99',
    canvasId: 'canvas-1',
    user: { id: 'u-host', name: 'Alice', color: '#2563eb' },
    enableWebRTC: false,
    transportFactory: makeTransport,
    getSnapshot: () => hostState,
    getBlobById: async (id) => (id === 'file-1' ? new Blob([samplePdfBytes], { type: 'application/pdf' }) : null),
    onEvent: (type, detail) => {
      if (type === 'cursor') hostReceivedCursor = detail;
    },
  });

  const guestB = new CollabSession({
    roomId: 'team99',
    canvasId: 'canvas-1',
    user: { id: 'u-guest-b', name: 'Bob', color: '#e11d48' },
    enableWebRTC: false,
    transportFactory: makeTransport,
    getSnapshot: () => null,
    onEvent: (type, detail) => {
      if (type === 'welcome') guestBWelcome = detail.snapshot;
      if (type === 'blob-progress' && detail.done) guestBReceivedBlob = detail;
    },
  });

  const guestC = new CollabSession({
    roomId: 'team99',
    canvasId: 'canvas-1',
    user: { id: 'u-guest-c', name: 'Carol', color: '#059669' },
    enableWebRTC: false,
    transportFactory: makeTransport,
    getSnapshot: () => null,
    onEvent: (type, detail) => {
      if (type === 'shape-live') guestCShapeLive = detail;
    },
  });

  await host.start();
  await guestB.start();
  await guestC.start();
  await new Promise((r) => setTimeout(r, 30));

  // 1. 验证三方互相发现且 Guest B 收到初始画布快照
  assert.equal(host.getStatus().totalOnline, 3);
  assert.ok(guestBWelcome);
  assert.equal(guestBWelcome.title, '产品共创白板');
  assert.equal(guestBWelcome.shapes[0].text, '初始便签');

  // 2. 验证 Bob 发送实时光标与实时便签拖拽，Alice 和 Carol 毫秒级收到
  guestB.send('cursor', { x: 320, y: 480, tool: 'select', selIds: ['sh-1'], action: '正在输入…' });
  guestB.send('shape-live', { canvasId: 'canvas-1', shapes: [{ id: 'sh-1', x: 260, y: 300, text: 'Bob 实时修改' }] });
  await new Promise((r) => setTimeout(r, 20));

  assert.ok(hostReceivedCursor);
  assert.equal(hostReceivedCursor.peer.name, 'Bob');
  assert.equal(hostReceivedCursor.peer.x, 320);
  assert.equal(hostReceivedCursor.peer.action, '正在输入…');

  assert.ok(guestCShapeLive);
  assert.equal(guestCShapeLive.shapes[0].text, 'Bob 实时修改');

  // 3. 验证 Guest B 请求画布上的 PDF 原文件并通过分片完整接收
  guestB.requestBlob('file-1', 'main');
  await new Promise((r) => setTimeout(r, 40));
  assert.ok(guestBReceivedBlob);
  assert.equal(guestBReceivedBlob.cardId, 'file-1');
  assert.deepEqual(guestBReceivedBlob.bytes, samplePdfBytes);

  // 4. 验证成员离开后在线列表立即更新
  guestC.stop();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(host.getStatus().totalOnline, 2);

  host.stop();
  guestB.stop();
});

test('joining guest with its own empty default canvas does NOT overwrite host canvas', async () => {
  const buses = new Map();
  const makeTransport = (chName, onMsg) => {
    let subs = buses.get(chName);
    if (!subs) buses.set(chName, (subs = new Set()));
    const fn = (pkt) => queueMicrotask(() => onMsg(structuredClone(pkt)));
    subs.add(fn);
    return {
      postMessage(pkt) {
        for (const s of subs) if (s !== fn) s(pkt);
      },
      close() {
        subs.delete(fn);
      },
    };
  };

  let hostBoard = {
    canvasId: 'cv-host',
    title: '房主原有画布',
    _u: 500,
    shapes: [{ id: 's-host-1', t: 'sticky', x: 50, y: 60, w: 200, h: 200, text: '房主的重要内容', _u: 500 }],
    links: [],
    cards: [{ id: 'c-host-1', kind: 'note', name: '设计规范', columnId: 'cv-host', x: 300, y: 60, updatedAt: 500 }],
  };

  let guestBoard = {
    canvasId: 'cv-guest-default-empty',
    title: '画布',
    _u: 100,
    shapes: [],
    links: [],
    cards: [],
  };

  let hostReceivedUnexpectedWelcome = false;
  let guestReceivedHostWelcome = null;

  const host = new CollabSession({
    roomId: 'share1',
    canvasId: 'cv-host',
    joining: false,
    user: { id: 'u-host', name: '房主', color: '#2563eb' },
    enableWebRTC: false,
    transportFactory: makeTransport,
    getSnapshot: () => hostBoard,
    onEvent: (type, detail) => {
      if (type === 'welcome' || (type === 'board-sync' && detail.snapshot?.canvasId !== 'cv-host')) {
        hostReceivedUnexpectedWelcome = true;
      }
      if (type === 'board-sync' && detail.snapshot?.canvasId === 'cv-host') {
        hostBoard = detail.snapshot;
      }
    },
  });

  const guest = new CollabSession({
    roomId: 'share1',
    canvasId: 'cv-guest-default-empty',
    joining: true,
    user: { id: 'u-guest', name: '新访客', color: '#e11d48' },
    enableWebRTC: false,
    transportFactory: makeTransport,
    getSnapshot: () => (guest.joining ? null : guestBoard),
    onEvent: (type, detail) => {
      if (type === 'welcome') {
        guestReceivedHostWelcome = detail.snapshot;
        guestBoard = structuredClone(detail.snapshot);
        guest.markSynced(detail.snapshot.canvasId);
      }
    },
  });

  await host.start();
  await guest.start();
  await new Promise((r) => setTimeout(r, 40));

  // 1. 房主绝不会收到新访客的空默认画布 welcome，房主原有内容完整保留
  assert.equal(hostReceivedUnexpectedWelcome, false);
  assert.equal(host.canvasId, 'cv-host');
  assert.equal(hostBoard.shapes.length, 1);
  assert.equal(hostBoard.shapes[0].text, '房主的重要内容');

  // 2. 新访客成功收到房主画布，并将会话切换并同步至 cv-host
  assert.ok(guestReceivedHostWelcome);
  assert.equal(guestReceivedHostWelcome.canvasId, 'cv-host');
  assert.equal(guest.joining, false);
  assert.equal(guest.canvasId, 'cv-host');

  // 3. 同步完成后，新访客添加的便签可以正常同步回房主（仍在 cv-host 上）
  guestBoard.shapes.push({ id: 's-guest-2', t: 'sticky', x: 520, y: 80, w: 200, h: 200, text: '访客新想法', _u: 900 });
  guest.send('board-sync', { snapshot: guestBoard, tombstones: guest.tombstones });
  await new Promise((r) => setTimeout(r, 25));

  assert.equal(hostBoard.canvasId, 'cv-host');
  assert.equal(hostBoard.shapes.length, 2);
  assert.equal(hostBoard.shapes[1].text, '访客新想法');

  host.stop();
  guest.stop();
});

test('simultaneous multi-guest join does not overwrite host canvas and converges all 3 peers', async () => {
  const buses = new Map();
  const makeTransport = (chName, onMsg) => {
    let subs = buses.get(chName);
    if (!subs) buses.set(chName, (subs = new Set()));
    const fn = (pkt) => queueMicrotask(() => onMsg(structuredClone(pkt)));
    subs.add(fn);
    return {
      postMessage(pkt) {
        for (const s of subs) if (s !== fn) s(pkt);
      },
      close() {
        subs.delete(fn);
      },
    };
  };

  let hostBoard = {
    canvasId: 'cv-shared',
    title: '并发加入主画布',
    _u: 1000,
    shapes: [{ id: 's1', t: 'sticky', x: 40, y: 50, w: 200, h: 200, text: '房主核心便签', _u: 1000 }],
    links: [],
    cards: [{ id: 'c1', kind: 'note', name: '重要笔记', columnId: 'cv-shared', x: 280, y: 50, updatedAt: 1000 }],
  };
  let guest1Board = { canvasId: 'cv-empty-1', title: '画布', _u: 100, shapes: [], links: [], cards: [] };
  let guest2Board = { canvasId: 'cv-empty-2', title: '画布', _u: 100, shapes: [], links: [], cards: [] };

  const host = new CollabSession({
    roomId: 'race88',
    canvasId: 'cv-shared',
    joining: false,
    user: { id: 'u-h', name: 'Host', color: '#2563eb' },
    enableWebRTC: false,
    transportFactory: makeTransport,
    getSnapshot: () => hostBoard,
    onEvent: (type, detail) => {
      if ((type === 'board-sync' || type === 'welcome') && detail.snapshot?.canvasId === 'cv-shared') {
        hostBoard = { ...hostBoard, ...mergeBoardState(hostBoard, detail.snapshot, detail.tombstones) };
      } else if (type === 'welcome' || type === 'board-sync') {
        assert.fail(`Host received unexpected foreign canvas snapshot: ${detail.snapshot?.canvasId}`);
      }
    },
  });

  const makeGuest = (id, name, getB, setB) => {
    const s = new CollabSession({
      roomId: 'race88',
      canvasId: getB().canvasId,
      joining: true,
      user: { id, name, color: '#e11d48' },
      enableWebRTC: false,
      transportFactory: makeTransport,
      getSnapshot: () => (s.joining ? null : getB()),
      onEvent: (type, detail) => {
        if ((type === 'welcome' || type === 'board-sync') && detail.snapshot) {
          setB(structuredClone(detail.snapshot));
          s.markSynced(detail.snapshot.canvasId);
        }
      },
    });
    return s;
  };

  const g1 = makeGuest('u-g1', 'Guest1', () => guest1Board, (b) => { guest1Board = b; });
  const g2 = makeGuest('u-g2', 'Guest2', () => guest2Board, (b) => { guest2Board = b; });

  await host.start();
  await Promise.all([g1.start(), g2.start()]);
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(host.getStatus().totalOnline, 3);
  assert.equal(guest1Board.canvasId, 'cv-shared');
  assert.equal(guest2Board.canvasId, 'cv-shared');
  assert.equal(guest1Board.shapes[0].text, '房主核心便签');
  assert.equal(guest2Board.shapes[0].text, '房主核心便签');
  assert.equal(g1.joining, false);
  assert.equal(g2.joining, false);

  host.stop();
  g1.stop();
  g2.stop();
});

test('star-topology WebRTC relay forwards cursors, tombstones, and blob chunks between remote guests via Host', async () => {
  // 创建纯虚拟双工 PeerJS DataConnection（两个访客仅连接房主，不共享本地 BroadcastChannel）
  function makeMockRtcPair(hostSession, hostPeerLabel, guestSession, guestPeerLabel) {
    const hostConn = {
      peer: guestPeerLabel,
      open: true,
      handlers: {},
      on(ev, fn) { (this.handlers[ev] ||= []).push(fn); },
      send(pkt) { queueMicrotask(() => guestConn._emit('data', structuredClone(pkt))); },
      close() { this.open = false; this._emit('close'); },
      _emit(ev, arg) { (this.handlers[ev] || []).forEach((f) => f(arg)); },
    };
    const guestConn = {
      peer: hostPeerLabel,
      open: true,
      handlers: {},
      on(ev, fn) { (this.handlers[ev] ||= []).push(fn); },
      send(pkt) { queueMicrotask(() => hostConn._emit('data', structuredClone(pkt))); },
      close() { this.open = false; this._emit('close'); },
      _emit(ev, arg) { (this.handlers[ev] || []).forEach((f) => f(arg)); },
    };
    hostSession._bindRTCConn(hostConn);
    guestSession._bindRTCConn(guestConn);
  }

  let hostBoard = {
    canvasId: 'cv-rtc',
    title: 'WebRTC 星型中继画布',
    _u: 100,
    shapes: [
      { id: 'sh-del', t: 'rect', x: 10, y: 10, w: 120, h: 80, text: '待删形状', _u: 100 },
    ],
    links: [],
    cards: [{ id: 'card-pdf', kind: 'file', name: 'chart.pdf', type: 'application/pdf', size: 12000, columnId: 'cv-rtc', updatedAt: 100 }],
  };
  const guestBFile = new Uint8Array(12000);
  for (let i = 0; i < guestBFile.length; i++) guestBFile[i] = (i * 13 + 7) & 0xff;

  let guestCReceivedCursor = null;
  let guestCReceivedBoard = null;
  let guestCReceivedBlob = null;

  const isolatedNullTransport = () => ({ postMessage() {}, close() {} });

  const host = new CollabSession({
    roomId: 'star77',
    canvasId: 'cv-rtc',
    joining: false,
    user: { id: 'h-1', name: 'HostA', color: '#2563eb' },
    enableWebRTC: false,
    transportFactory: isolatedNullTransport,
    getSnapshot: () => hostBoard,
    getBlobById: async () => null,
    onEvent: (type, detail) => {
      if (type === 'board-sync' && detail.snapshot?.canvasId === 'cv-rtc') {
        hostBoard = { ...hostBoard, ...mergeBoardState(hostBoard, detail.snapshot, detail.tombstones) };
      }
    },
  });

  const guestB = new CollabSession({
    roomId: 'star77',
    canvasId: 'cv-b-tmp',
    joining: true,
    user: { id: 'g-b', name: 'RemoteB', color: '#e11d48' },
    enableWebRTC: false,
    transportFactory: isolatedNullTransport,
    getSnapshot: () => null,
    getBlobById: async (id) => (id === 'card-pdf' ? new Blob([guestBFile], { type: 'application/pdf' }) : null),
    onEvent: (type, detail) => {
      if (type === 'welcome') guestB.markSynced(detail.snapshot.canvasId);
    },
  });

  const guestC = new CollabSession({
    roomId: 'star77',
    canvasId: 'cv-c-tmp',
    joining: true,
    user: { id: 'g-c', name: 'RemoteC', color: '#059669' },
    enableWebRTC: false,
    transportFactory: isolatedNullTransport,
    getSnapshot: () => null,
    onEvent: (type, detail) => {
      if (type === 'welcome' || type === 'board-sync') {
        guestCReceivedBoard = mergeBoardState(guestCReceivedBoard || {}, detail.snapshot, detail.tombstones);
        guestC.markSynced(detail.snapshot.canvasId);
      }
      if (type === 'cursor' && detail.peer?.id === 'g-b') guestCReceivedCursor = detail.peer;
      if (type === 'blob-progress' && detail.done) guestCReceivedBlob = detail;
    },
  });

  await host.start();
  await guestB.start();
  await guestC.start();

  // 将 RemoteB 和 RemoteC 分别连接到 HostA（彼此无直连）
  makeMockRtcPair(host, 'fangcun-wb-v1-star77', guestB, 'rtc-b');
  makeMockRtcPair(host, 'fangcun-wb-v1-star77', guestC, 'rtc-c');
  await new Promise((r) => setTimeout(r, 40));

  assert.equal(guestB.joining, false);
  assert.equal(guestC.joining, false);
  assert.equal(guestCReceivedBoard.shapes.length, 1);

  // RemoteB 发送光标 -> 经 HostA 中继到 RemoteC
  guestB.send('cursor', { x: 420, y: 260, tool: 'sticky', selIds: [], action: '正在画便签' });
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(guestCReceivedCursor);
  assert.equal(guestCReceivedCursor.x, 420);
  assert.equal(guestCReceivedCursor.action, '正在画便签');

  // RemoteB 删除 sh-del 并携带墓碑同步 -> HostA 与 RemoteC 都不再存在 sh-del
  guestB.recordTombstones(['sh-del'], 500);
  guestB.send('board-sync', {
    snapshot: { canvasId: 'cv-rtc', title: hostBoard.title, _u: 500, shapes: [], links: [], cards: [] },
    tombstones: guestB.tombstones,
  });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(hostBoard.shapes.length, 0);
  assert.equal(guestCReceivedBoard.shapes.length, 0);

  // RemoteC 向拥有文件缓存的 RemoteB 请求二进制文件分片 -> 经 HostA 中继完整重组
  guestC.requestBlob('card-pdf', 'main');
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(guestCReceivedBlob);
  assert.equal(guestCReceivedBlob.cardId, 'card-pdf');
  assert.deepEqual(guestCReceivedBlob.bytes, guestBFile);

  host.stop();
  guestB.stop();
  guestC.stop();
});
