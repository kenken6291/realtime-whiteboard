// ===================================================
// リアルタイム・ホワイトボード - フロントエンド
// ===================================================

const CONFIG = {
  // ★ここにGASのWebアプリURL(.../exec)を貼り付けてください
  GAS_URL: 'https://script.google.com/macros/s/AKfycbx8g35-OaXFTJdLUAXhSEC574isNK66RAjrTFdw7TCMzi3bnEliecnSJHiILY0QBIOFyQ/exec',
  SYNC_INTERVAL_MS: 700
};

// ===== 状態管理 =====
const state = {
  roomId: '',
  clientId: 'c_' + Math.random().toString(36).slice(2) + Date.now().toString(36),
  sinceSeq: 0,
  pendingEvents: [],   // まだサーバーに送っていない自分の描画イベント
  syncing: false,
  syncTimer: null,

  tool: 'pen',          // 'pen' | 'eraser'
  color: '#1a1a1a',
  width: 4,

  isDrawing: false,
  currentStrokeId: null,
  currentPoints: [],     // 現在描画中の未送信ポイント

  remoteLastPoint: {}    // strokeId -> {x, y} 他人のストロークの続きを描くため
};

// ===== DOM取得 =====
const joinScreen = document.getElementById('joinScreen');
const boardScreen = document.getElementById('boardScreen');
const roomInput = document.getElementById('roomInput');
const joinBtn = document.getElementById('joinBtn');
const roomNameLabel = document.getElementById('roomNameLabel');
const copyLinkBtn = document.getElementById('copyLinkBtn');

const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d');

const colorPicker = document.getElementById('colorPicker');
const widthPicker = document.getElementById('widthPicker');
const widthValue = document.getElementById('widthValue');
const penBtn = document.getElementById('penBtn');
const eraserBtn = document.getElementById('eraserBtn');
const clearBtn = document.getElementById('clearBtn');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');

// ===================================================
// 初期化 / ルーム参加
// ===================================================

function init() {
  // URLパラメータに ?room=xxx があれば自動入力
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

  // 初回同期(since=0)で現在の板の状態を取得
  syncWithServer(true);
  state.syncTimer = setInterval(function () { syncWithServer(false); }, CONFIG.SYNC_INTERVAL_MS);
}

// ===================================================
// キャンバスのセットアップ
// ===================================================

function setupCanvas() {
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
}

function resizeCanvas() {
  // リサイズ時に描画内容が消えないよう、一旦画像として退避してから復元
  const prev = canvas.width > 0 ? canvas.toDataURL() : null;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * devicePixelRatio;
  canvas.height = rect.height * devicePixelRatio;
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  fillWhiteBackground();
  if (prev) {
    const img = new Image();
    img.onload = function () { ctx.drawImage(img, 0, 0, rect.width, rect.height); };
    img.src = prev;
  }
}

function fillWhiteBackground() {
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.restore();
}

function getCanvasPoint(e) {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

// ===================================================
// 描画イベント(ローカル操作)
// ===================================================

function onPointerDown(e) {
  state.isDrawing = true;
  state.currentStrokeId = state.clientId + '_' + Date.now();
  const p = getCanvasPoint(e);
  state.currentPoints = [p];
  // 1点だけの状態(タップのみ)にも対応するため、即座に小さい点を描く
  drawSegment(p, p, state.tool, state.color, state.width);
}

function onPointerMove(e) {
  if (!state.isDrawing) return;
  const p = getCanvasPoint(e);
  const last = state.currentPoints[state.currentPoints.length - 1];
  drawSegment(last, p, state.tool, state.color, state.width);
  state.currentPoints.push(p);
}

function onPointerUp() {
  if (!state.isDrawing) return;
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
}

// 実際にCanvasに線を引く共通関数
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
// サーバー同期 (ショートポーリング)
// ===================================================

function syncWithServer(isInitial) {
  if (state.syncing) return; // 前回のリクエストが終わるまで多重送信しない
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
      // 失敗したイベントは次回また送れるよう戻しておく
      state.pendingEvents = eventsToSend.concat(state.pendingEvents);
    })
    .finally(function () {
      state.syncing = false;
    });
}

// 他クライアントからのイベントをCanvasに反映
function applyRemoteEvents(events) {
  events.forEach(function (ev) {
    if (ev.clientId === state.clientId) return; // 自分が送ったものは既に描画済み

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
}

function selectTool(tool) {
  state.tool = tool;
  penBtn.classList.toggle('active', tool === 'pen');
  eraserBtn.classList.toggle('active', tool === 'eraser');
  canvas.style.cursor = tool === 'eraser' ? 'cell' : 'crosshair';
}

function setupCopyLink() {
  copyLinkBtn.addEventListener('click', function () {
    const url = location.origin + location.pathname + '?room=' + encodeURIComponent(state.roomId);
    navigator.clipboard.writeText(url).then(function () {
      copyLinkBtn.textContent = '✅ コピーしました';
      setTimeout(function () { copyLinkBtn.textContent = '🔗 リンクコピー'; }, 1500);
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
