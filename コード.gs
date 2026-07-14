/**
 * リアルタイム・ホワイトボード バックエンド (GAS)
 * CacheServiceを使ったショートポーリング方式
 */

// ===== 設定 =====
const CACHE_TTL = 21600;   // CacheServiceの最大保持時間(秒) = 6時間
const MAX_EVENTS = 400;    // 1ルームで保持する最大イベント数
const TRIM_TO = 250;       // 上限超過時に間引いた後の件数

/**
 * POSTリクエストのエントリポイント
 * body: { action: 'sync' | 'clear', room, since, events, clientId }
 */
function doPost(e) {
  let result;
  try {
    const body = JSON.parse(e.postData.contents);
    const action = body.action;

    if (action === 'sync') {
      result = handleSync(body);
    } else if (action === 'clear') {
      result = handleClear(body);
    } else {
      result = { error: 'unknown action: ' + action };
    }
  } catch (err) {
    result = { error: String(err) };
  }

  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * 動作確認用 (ブラウザで/execを直接開いた時など)
 */
function doGet(e) {
  return ContentService.createTextOutput(JSON.stringify({
    status: 'ok',
    message: 'Whiteboard GAS backend is running.'
  })).setMimeType(ContentService.MimeType.JSON);
}

// ===== ルームデータの読み書き =====

function roomKey_(roomId) {
  return 'wb_room_' + roomId;
}

function loadRoom_(roomId) {
  const cache = CacheService.getScriptCache();
  const raw = cache.get(roomKey_(roomId));
  if (!raw) {
    return { seq: 0, events: [] };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed.events) parsed.events = [];
    if (!parsed.seq) parsed.seq = 0;
    return parsed;
  } catch (err) {
    return { seq: 0, events: [] };
  }
}

function saveRoom_(roomId, state) {
  const cache = CacheService.getScriptCache();
  cache.put(roomKey_(roomId), JSON.stringify(state), CACHE_TTL);
}

// ===== アクション: sync =====
// 自分の新規イベントを送信しつつ、他人の新規イベントを受信する
function handleSync(body) {
  const roomId = String(body.room || 'default').slice(0, 64);
  const since = Number(body.since || 0);
  const incoming = Array.isArray(body.events) ? body.events : [];
  const clientId = String(body.clientId || '');

  const lock = LockService.getScriptLock();
  lock.waitLock(5000);

  let state;
  try {
    state = loadRoom_(roomId);

    incoming.forEach(function (ev) {
      state.seq += 1;
      ev.seq = state.seq;
      ev.clientId = clientId;
      state.events.push(ev);
    });

    // イベント数が上限を超えたら古いものを間引く
    if (state.events.length > MAX_EVENTS) {
      state.events = state.events.slice(state.events.length - TRIM_TO);
    }

    saveRoom_(roomId, state);
  } finally {
    lock.releaseLock();
  }

  const newEvents = state.events.filter(function (ev) {
    return ev.seq > since;
  });

  const oldestSeq = state.events.length ? state.events[0].seq : state.seq;
  const trimmed = since > 0 && since < oldestSeq - 1;

  return {
    seq: state.seq,
    events: newEvents,
    trimmed: trimmed // trueの場合、間引きにより一部イベントが欠落した可能性あり
  };
}

// ===== アクション: clear =====
// キャンバスを全消去し、ルームのイベント履歴もリセットする
function handleClear(body) {
  const roomId = String(body.room || 'default').slice(0, 64);
  const clientId = String(body.clientId || '');

  const lock = LockService.getScriptLock();
  lock.waitLock(5000);

  let state;
  try {
    state = loadRoom_(roomId);
    state.seq += 1;
    const clearEvent = { type: 'clear', seq: state.seq, clientId: clientId };
    state.events = [clearEvent];
    saveRoom_(roomId, state);
  } finally {
    lock.releaseLock();
  }

  return { seq: state.seq, events: state.events };
}
