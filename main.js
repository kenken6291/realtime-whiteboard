// ===================================================
// リアルタイム・ホワイトボード - フロントエンド
// PC/スマホ対応、拡大縮小・パン、テキスト入力対応版
// ===================================================

const CONFIG = {
  // ★ここにGASのWebアプリURL(.../exec)を貼り付けてください
  GAS_URL: 'https://script.google.com/macros/s/XXXXXXXXXXXXXXXXXXXXXXXX/exec',
  SYNC_INTERVAL_MS: 700
};

// ワールド座標(共有される絵の実サイズ)。全員がこの座標系を共有する。
const WORLD_W = 3000;
const WORLD_H = 2000;
const DPR = Math.min(window.devicePixelRatio || 1, 2);
const MIN_SCALE = 0.15;
const MAX_SCALE = 5;

// ===== 状態管理 =====
const state = {
  roomId: '',
  clientId: 'c_' + Math.random().toString(36).slice(2) + Date.now().toString(36),
  sinceSeq: 0,
  pendingEvents: [],
  syncing: false,
  syncTimer: null,

  tool: 'pen',          // 'pen' | 'eraser' | 'text' | 'pan'
  color: '#1a1a1a',
  width: 4,

  isDrawing: false,
  currentStrokeId: null,
  currentPoints: [],     // ワールド座標(未送信ポイント)
  lastWorldPoint: null,

  remoteLastPoint: {}    // strokeId -> {x, y} 他人のストロークの続きを描くため
};

// 画面表示の拡大縮小・パン状態(ワールド座標→画面座標への変換)
const view = { scale: 1, offsetX: 0, offsetY: 0 };

// 複数ポインタ(ピンチ操作)管理
const activePointers = new Map(); // pointerId -> {x, y}
const gesture = { mode: null, startDist: 0, startScale: 1, startMid: null, startOffset: null };
const panState = { active: false, lastX: 0, lastY: 0 };
const tapState = { startX: 0, startY: 0, moved: false };

// ===== DOM取得 =====
const joinScreen = document.getElementById('joinScreen');
const boardScreen = document.getElementById('boardScreen');
const roomInput = document.getElementById('roomInput');
const joinBtn = document.getElementById('joinBtn');
const roomNameLabel = document.getElementById('roomNameLabel');
const copyLinkBtn = document.getElementById('copyLinkBtn');

const canvasWrap = document.getElementById('canvasWrap');
const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d');

const colorPicker = document.getElementById('colorPicker');
const widthPicker = document.getElementById('widthPicker');
const widthValue = document.getElementById('widthValue');
const widthLabel = document.getElementById('widthLabel');
const penBtn = document.getElementById('penBtn');
const eraserBtn = document.getElementById('eraserBtn');
const textBtn = document.getElementById('textBtn');
const panBtn = document.getElementById('panBtn');
const clearBtn = document.getElementById('clearBtn');
const zoomInBtn = document.getElementById('zoomInBtn');
const zoomOutBtn = document.getElementById('zoomOutBtn');
const fitBtn = document.getElementById('fitBtn');
const fullscreenBtn = document.getElementById('fullscreenBtn');
const zoomLevel = document.getElementById('zoomLevel');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');

// ===================================================
// 初期化 / ルーム参加
// ===================================================

function init() {
  const params = new URLSearchParams(location.search);
  const roomFromUrl = params.get('room');
  if (roomFromUrl) roomInput.value = roomFromUrl;

  joinBtn.addEventListener('click', joinRoom);
  roomInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') joinRoom();
  });
}

function joinRoom() {
  const roomId = roomInput.value.trim();
  if (!roomId) {
    alert('ルームIDを入力してください');
    return;
  }
  state.roomId = roomId;

  joinScreen.classList.add('hidden');
  boardScreen.classList.remove('hidden');
  roomNameLabel.textContent = roomId;

  setupCanvas();
  setupToolbar();
  setupCopyLink();
  setupZoomPan();

  syncWithServer(true);
  state.syncTimer = setInterval(function () { syncWithServer(false); }, CONFIG.SYNC_INTERVAL_MS);
}

// ===================================================
// キャンバスのセットアップ(固定ワールドサイズのビットマップ)
// ===================================================

function setupCanvas() {
  // ビットマップ解像度(DPRぶん高精細に)
  canvas.width = WORLD_W * DPR;
  canvas.height = WORLD_H * DPR;
  // CSS上の表示サイズは必ずワールド座標(3000x2000)と一致させる。
  // これを指定しないと、DPRが1より大きい端末(スマホ等)で
  // canvasの実表示サイズがビットマップ解像度と同じ大きさになってしまい、
  // タップ位置とワールド座標の変換(screenToWorld)がズレる原因になる。
  canvas.style.width = WORLD_W + 'px';
  canvas.style.height = WORLD_H + 'px';
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  fillWhiteBackground();

  fitToScreen();
  window.addEventListener('resize', fitToScreen);

  canvasWrap.addEventListener('pointerdown', onPointerDown);
  canvasWrap.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
}

function fillWhiteBackground() {
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, WORLD_W, WORLD_H);
  ctx.restore();
}

// ===================================================
// 表示変換(拡大縮小・パン)
// ===================================================

function applyTransform() {
  canvas.style.transform = 'translate(' + view.offsetX + 'px,' + view.offsetY + 'px) scale(' + view.scale + ')';
  zoomLevel.textContent = Math.round(view.scale * 100) + '%';
}

function fitToScreen() {
  const rect = canvasWrap.getBoundingClientRect();
  const scale = Math.min(rect.width / WORLD_W, rect.height / WORLD_H) * 0.95;
  view.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale));
  view.offsetX = (rect.width - WORLD_W * view.scale) / 2;
  view.offsetY = (rect.height - WORLD_H * view.scale) / 2;
  applyTransform();
}

function zoomAt(screenX, screenY, factor) {
  const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, view.scale * factor));
  const worldX = (screenX - view.offsetX) / view.scale;
  const worldY = (screenY - view.offsetY) / view.scale;
  view.scale = newScale;
  view.offsetX = screenX - worldX * newScale;
  view.offsetY = screenY - worldY * newScale;
  applyTransform();
}

function screenToWorld(screenX, screenY) {
  return {
    x: (screenX - view.offsetX) / view.scale,
    y: (screenY - view.offsetY) / view.scale
  };
}

function getWrapPoint(e) {
  const rect = canvasWrap.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function setupZoomPan() {
  zoomInBtn.addEventListener('click', function () {
    const rect = canvasWrap.getBoundingClientRect();
    zoomAt(rect.width / 2, rect.height / 2, 1.25);
  });
  zoomOutBtn.addEventListener('click', function () {
    const rect = canvasWrap.getBoundingClientRect();
    zoomAt(rect.width / 2, rect.height / 2, 0.8);
  });
  fitBtn.addEventListener('click', fitToScreen);

  canvasWrap.addEventListener('wheel', function (e) {
    e.preventDefault();
    const p = getWrapPoint(e);
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    zoomAt(p.x, p.y, factor);
  }, { passive: false });

  if (document.fullscreenEnabled) {
    fullscreenBtn.addEventListener('click', function () {
      if (!document.fullscreenElement) {
        boardScreen.requestFullscreen().catch(function () {});
      } else {
        document.exitFullscreen().catch(function () {});
      }
    });
  } else {
    fullscreenBtn.classList.add('hidden');
  }
}

// ===================================================
// ポインタ操作(描画 / パン / ピンチズーム / テキスト配置)
// ===================================================

function onPointerDown(e) {
  canvasWrap.setPointerCapture && canvasWrap.setPointerCapture(e.pointerId);
  const p = getWrapPoint(e);
  activePointers.set(e.pointerId, p);

  if (activePointers.size === 2) {
    // ピンチ操作開始(描画中だったストロークは打ち切って送信)
    if (state.isDrawing) finishStroke();
    panState.active = false;
    const pts = Array.from(activePointers.values());
    gesture.mode = 'pinch';
    gesture.startDist = distance(pts[0], pts[1]);
    gesture.startScale = view.scale;
    gesture.startMid = midpoint(pts[0], pts[1]);
    gesture.startOffset = { x: view.offsetX, y: view.offsetY };
    gesture.startWorldMid = screenToWorld(gesture.startMid.x, gesture.startMid.y);
    return;
  }

  if (activePointers.size !== 1) return; // 3本指以降は無視

  if (state.tool === 'pan') {
    panState.active = true;
    panState.lastX = p.x;
    panState.lastY = p.y;
    canvasWrap.classList.add('panning');
    return;
  }

  if (state.tool === 'text') {
    tapState.startX = p.x;
    tapState.startY = p.y;
    tapState.moved = false;
    return;
  }

  // ペン / 消しゴム
  state.isDrawing = true;
  state.currentStrokeId = state.clientId + '_' + Date.now();
  const w = screenToWorld(p.x, p.y);
  state.currentPoints = [w];
  state.lastWorldPoint = w;
  drawSegment(w, w, state.tool, state.color, state.width);
}

function onPointerMove(e) {
  if (!activePointers.has(e.pointerId)) return;
  const p = getWrapPoint(e);
  activePointers.set(e.pointerId, p);

  if (gesture.mode === 'pinch' && activePointers.size === 2) {
    const pts = Array.from(activePointers.values());
    const dist = distance(pts[0], pts[1]);
    const mid = midpoint(pts[0], pts[1]);
    const scaleFactor = dist / (gesture.startDist || 1);
    const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, gesture.startScale * scaleFactor));
    view.scale = newScale;
    view.offsetX = mid.x - gesture.startWorldMid.x * newScale;
    view.offsetY = mid.y - gesture.startWorldMid.y * newScale;
    applyTransform();
    return;
  }

  if (panState.active && activePointers.size === 1) {
    const dx = p.x - panState.lastX;
    const dy = p.y - panState.lastY;
    view.offsetX += dx;
    view.offsetY += dy;
    panState.lastX = p.x;
    panState.lastY = p.y;
    applyTransform();
    return;
  }

  if (state.tool === 'text' && activePointers.size === 1) {
    if (Math.abs(p.x - tapState.startX) > 6 || Math.abs(p.y - tapState.startY) > 6) {
      tapState.moved = true;
    }
    return;
  }

  if (state.isDrawing && activePointers.size === 1) {
    const w = screenToWorld(p.x, p.y);
    drawSegment(state.lastWorldPoint, w, state.tool, state.color, state.width);
    state.currentPoints.push(w);
    state.lastWorldPoint = w;
  }
}

function onPointerUp(e) {
  const hadPointer = activePointers.has(e.pointerId);
  activePointers.delete(e.pointerId);

  if (gesture.mode === 'pinch' && activePointers.size < 2) {
    gesture.mode = null;
  }

  if (panState.active && activePointers.size === 0) {
    panState.active = false;
    canvasWrap.classList.remove('panning');
  }

  if (!hadPointer) return;

  if (state.tool === 'text' && !tapState.moved && activePointers.size === 0 && gesture.mode !== 'pinch') {
    placeTextAt(tapState.startX, tapState.startY);
  }

  if (state.isDrawing && activePointers.size === 0) {
    finishStroke();
  }
}

function finishStroke() {
  state.isDrawing = false;
  if (state.currentPoints.length > 0) {
    state.pendingEvents.push({
      type: 'stroke',
      strokeId: state.currentStrokeId,
      points: state.currentPoints,
      color: state.color,
      width: state.width,
      tool: state.tool
    });
  }
  state.currentStrokeId = null;
  state.currentPoints = [];
  state.lastWorldPoint = null;
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
function midpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

// 実際にCanvasに線を引く共通関数(ワールド座標で描画)
function drawSegment(from, to, tool, color, width) {
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.lineWidth = width;

  if (tool === 'eraser') {
    ctx.globalCompositeOperation = 'destination-out';
  } else {
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = color;
  }

  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  ctx.restore();
}

// ===================================================
// テキスト入力
// ===================================================

function fontSizeFromWidth(w) {
  return 12 + w * 4; // widthスライダー(1-30) → 16〜132px
}

function placeTextAt(screenX, screenY) {
  const text = window.prompt('テキストを入力してください:');
  if (!text) return;
  const w = screenToWorld(screenX, screenY);
  const fontSize = fontSizeFromWidth(state.width);

  drawText(w, text, state.color, fontSize);

  state.pendingEvents.push({
    type: 'text',
    textId: state.clientId + '_' + Date.now(),
    x: w.x,
    y: w.y,
    text: text,
    color: state.color,
    fontSize: fontSize
  });
}

function drawText(pos, text, color, fontSize) {
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = color;
  ctx.font = fontSize + 'px "Hiragino Kaku Gothic ProN", "Yu Gothic", sans-serif';
  ctx.textBaseline = 'top';
  ctx.fillText(text, pos.x, pos.y);
  ctx.restore();
}

// ===================================================
// サーバー同期 (ショートポーリング)
// ===================================================

function syncWithServer(isInitial) {
  if (state.syncing) return;
  state.syncing = true;

  const eventsToSend = state.pendingEvents;
  state.pendingEvents = [];

  const payload = {
    action: 'sync',
    room: state.roomId,
    since: state.sinceSeq,
    clientId: state.clientId,
    events: eventsToSend
  };

  postToGas(payload)
    .then(function (res) {
      if (res && typeof res.seq === 'number') {
        state.sinceSeq = res.seq;
      }
      if (res && Array.isArray(res.events)) {
        applyRemoteEvents(res.events);
      }
      setStatus(true);
    })
    .catch(function (err) {
      console.error('sync error:', err);
      setStatus(false);
      state.pendingEvents = eventsToSend.concat(state.pendingEvents);
    })
    .finally(function () {
      state.syncing = false;
    });
}

function applyRemoteEvents(events) {
  events.forEach(function (ev) {
    if (ev.clientId === state.clientId) return;

    if (ev.type === 'clear') {
      fillWhiteBackground();
      state.remoteLastPoint = {};
      return;
    }

    if (ev.type === 'stroke' && Array.isArray(ev.points) && ev.points.length > 0) {
      let prev = state.remoteLastPoint[ev.strokeId] || ev.points[0];
      ev.points.forEach(function (p) {
        drawSegment(prev, p, ev.tool, ev.color, ev.width);
        prev = p;
      });
      state.remoteLastPoint[ev.strokeId] = prev;
      return;
    }

    if (ev.type === 'text' && typeof ev.text === 'string') {
      drawText({ x: ev.x, y: ev.y }, ev.text, ev.color, ev.fontSize);
    }
  });
}

// ===================================================
// GAS通信 (text/plain POSTでプリフライトを回避)
// ===================================================

function postToGas(payload) {
  return new Promise(function (resolve, reject) {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', CONFIG.GAS_URL, true);
    xhr.setRequestHeader('Content-Type', 'text/plain;charset=utf-8');
    xhr.timeout = 10000;

    xhr.onload = function () {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const data = JSON.parse(xhr.responseText);
          if (data.error) {
            reject(new Error(data.error));
          } else {
            resolve(data);
          }
        } catch (e) {
          reject(e);
        }
      } else {
        reject(new Error('HTTP ' + xhr.status));
      }
    };
    xhr.onerror = function () { reject(new Error('network error')); };
    xhr.ontimeout = function () { reject(new Error('timeout')); };

    xhr.send(JSON.stringify(payload));
  });
}

// ===================================================
// ツールバー
// ===================================================

function setupToolbar() {
  colorPicker.addEventListener('input', function () {
    state.color = colorPicker.value;
  });

  widthPicker.addEventListener('input', function () {
    state.width = Number(widthPicker.value);
    widthValue.textContent = state.width;
  });

  penBtn.addEventListener('click', function () { selectTool('pen'); });
  eraserBtn.addEventListener('click', function () { selectTool('eraser'); });
  textBtn.addEventListener('click', function () { selectTool('text'); });
  panBtn.addEventListener('click', function () { selectTool('pan'); });

  clearBtn.addEventListener('click', function () {
    if (!confirm('このルームの描画内容を全員分クリアします。よろしいですか？')) return;
    fillWhiteBackground();
    state.remoteLastPoint = {};
    postToGas({
      action: 'clear',
      room: state.roomId,
      clientId: state.clientId
    }).then(function (res) {
      if (res && typeof res.seq === 'number') state.sinceSeq = res.seq;
    }).catch(function (err) {
      console.error('clear error:', err);
    });
  });

  selectTool('pen');
}

function selectTool(tool) {
  state.tool = tool;
  [penBtn, eraserBtn, textBtn, panBtn].forEach(function (btn) { btn.classList.remove('active'); });
  ({ pen: penBtn, eraser: eraserBtn, text: textBtn, pan: panBtn })[tool].classList.add('active');

  canvasWrap.classList.remove('tool-pen', 'tool-eraser', 'tool-text', 'tool-pan');
  canvasWrap.classList.add('tool-' + tool);

  widthLabel.textContent = tool === 'text' ? '文字サイズ' : '太さ';
}

function setupCopyLink() {
  copyLinkBtn.addEventListener('click', function () {
    const url = location.origin + location.pathname + '?room=' + encodeURIComponent(state.roomId);
    navigator.clipboard.writeText(url).then(function () {
      copyLinkBtn.textContent = '✅ コピー済';
      setTimeout(function () { copyLinkBtn.textContent = '🔗 リンク'; }, 1500);
    }).catch(function () {
      prompt('このURLをコピーしてください:', url);
    });
  });
}

function setStatus(online) {
  statusDot.classList.toggle('online', online);
  statusDot.classList.toggle('offline', !online);
  statusText.textContent = online ? '同期中' : '接続エラー(再試行中)';
}

// ===================================================
init();
