// JarvisVoice 核心：雲端即時轉寫（OpenAI Realtime 的 transcription 協定）。Mac 小程式、CubeLV、平行沙盒共用這一份。
//   - 連到哪裡由呼叫端的 connect() 決定：OpenAI 直連（自己的 key）、平行沙盒 control 的 /v1/transcription、CubeLV 後端的 /ws/transcription。
//   - 送音：24 kHz PCM16 的 input_audio_buffer.append；斷句在本機（turns.mjs），每講完一句 commit 一次。
//   - 連線前的聲音先排著，連上再補送，按下就能講；每次連線都重新叫 connect()（語音 token 一分鐘就過期）。
//   - 連線斷了或 OpenAI 回錯（手機換網路、連線滿 10 分鐘被關掉）：重開連線，把還沒拿到逐字稿的聲音與斷句照原順序重送；
//     連續失敗 maxReconnects 次才放棄（onError 一次），不讓一次失誤把整段錄音判死。
//   - 每句逐字稿照講的順序排，帶這句講話的起訖時間（onItem）。
// 只用 WebSocket、setTimeout、btoa、crypto.randomUUID：瀏覽器和 Node 都有，不用 node: 模組。

import { TurnSplitter } from './turns.mjs';
import { joinPolished } from './dictation.mjs';

export const MAX_RECONNECTS = 4;
const OPEN_TIMEOUT_MS = 10_000;
// Mac 小程式整天開著：安靜這麼久（而且不在收音的 app）就先關連線，下次開口再連
const IDLE_CLOSE_MS = 60_000;
// control 一條連線最多 10 分鐘：快到時趁空檔先換新的
const MAX_SOCKET_AGE_MS = 9 * 60_000;

export function base64FromBytes(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

// 連線設定不對（沒有 key、key 錯）重試也沒用：connect() 丟這種錯就直接放棄
export function permanentError(message) {
  const error = new Error(message);
  error.permanent = true;
  return error;
}

// createTranscriber —— 一條轉寫連線（斷了會自己接回來）。
//   connect()：回傳 WebSocket 網址，或 { url, headers?, sessionUpdate? }（sessionUpdate 是開線後第一個送出的設定）。
//   append(bytes)：一段聲音；commit({ startMs, endMs })：一句講完了，回傳這句的序號。
//   onItem({ id, startMs, endMs, text, final })：每句的字有變就通知（重連時舊連線上沒定案的句子會收成空的、final）。
//   onTranscript(全部的字)、onFinal(這句的字, item)：一句定案（Mac 小程式一句一句貼）。
//   onPending()：等字的句子數變了（畫面顯示「辨識中」用）。onError(error)：放棄了（finish 中就由 finish 丟出去）。
//   discard(序號)：這句作廢（停一下先送、之後又開口，整句會重送）：它的字不算進全文，也不用等它回來。
//   startHint()：commit 前就先出字時，這句從哪裡開始；elapsed()：現在是錄音開始後幾 ms（沒有起點的字用）。
//   lazy：有東西要送才連線（Mac 小程式）；不給就馬上連（按下錄音的輸入框）。
export function createTranscriber({
  connect,
  onItem,
  onTranscript,
  onFinal,
  onPending,
  onError,
  log = () => {},
  describe = () => '',
  startHint = () => null,
  elapsed = () => 0,
  lazy = false,
  maxReconnects = MAX_RECONNECTS,
  retryBaseMs = 500,
  openTimeoutMs = OPEN_TIMEOUT_MS,
}) {
  const parts = new Map(); // item id → { draft, final, startMs, endMs }
  const order = [];
  const outgoing = []; // 還沒送的：{ kind: 'audio', bytes } | { kind: 'commit', turn }
  const sent = []; // 已經送給這條連線、還沒拿到逐字稿的聲音與斷句；連線斷了就照原順序重送
  const commitsWaitingForIds = [];
  const waitingForFinal = new Set();
  const pendingTurns = new Set();
  const itemTurns = new Map();
  const checkpoints = new Set();
  const dropped = new Set(); // 作廢的句子序號
  const sequenceItems = new Map(); // 句子序號 → item id（作廢時找得到已經回來的字）
  let pendingChunks = [];
  let pendingBytes = 0;
  let turnSequence = 0;
  let ws = null;
  let wsOpen = false;
  let connecting = false;
  let connectedAt = 0;
  let reconnects = 0;
  let reconnectTimer;
  let closedByClient = false;
  let fatalError = null;
  let finishRequested = false;
  let finishResolve = null;
  let finishReject = null;
  let openWaiters = [];
  const socketState = () => `ws=${ws?.readyState ?? 'none'}`;
  const note = (message) => {
    const extra = describe();
    log(`[transcription] ${message} ${socketState()}${extra ? ` ${extra}` : ''}`);
  };

  // 句子照講的順序接起來：中文接中文直接接，英文、數字與中文交界才空一格（跟整理後寫回輸入框同一套，joinPolished）
  const transcript = () => order
    .map((id) => { const part = parts.get(id); return part?.dropped ? '' : part?.final ?? part?.draft ?? ''; })
    .filter((text) => text.trim())
    .reduce((joined, text) => joinPolished(joined, text), '');

  const ensurePart = (id) => {
    let part = parts.get(id);
    if (!part) {
      part = { draft: '', final: null, startMs: commitsWaitingForIds[0]?.startMs ?? startHint() ?? elapsed() };
      parts.set(id, part);
      order.push(id);
    }
    return part;
  };
  const publishItem = (id) => {
    const part = ensurePart(id);
    if (part.dropped) onItem?.({ id, startMs: part.startMs ?? elapsed(), endMs: part.endMs, text: '', final: true });
    else onItem?.({ id, startMs: part.startMs ?? elapsed(), endMs: part.endMs, text: part.final ?? part.draft, final: part.final !== null });
  };
  const publish = () => onTranscript?.(transcript());

  // received：這句的字拿到了（作廢的句子不算：前面的句子可能還在等，聲音要留著補送）
  const settleTurn = (sequence, received = true) => {
    pendingTurns.delete(sequence);
    // 這一句的逐字稿拿到了，它和之前送出的聲音不用再留著補送
    const confirmed = received ? sent.findIndex((op) => op.kind === 'commit' && op.turn.sequence === sequence) : -1;
    if (confirmed >= 0) sent.splice(0, confirmed + 1);
    for (const checkpoint of checkpoints) {
      if (![...pendingTurns].some((pending) => pending <= checkpoint.target)) {
        checkpoints.delete(checkpoint);
        checkpoint.resolve();
      }
    }
    onPending?.();
  };

  const maybeResolveFinish = () => {
    if (!finishRequested || !finishResolve || pendingBytes || outgoing.length || commitsWaitingForIds.length || waitingForFinal.size) return;
    const resolve = finishResolve;
    finishResolve = null;
    finishReject = null;
    resolve(transcript().trim());
  };

  const fail = (error) => {
    if (fatalError) return;
    note(error.message);
    fatalError = error;
    if (reconnectTimer !== undefined) { clearTimeout(reconnectTimer); reconnectTimer = undefined; }
    for (const checkpoint of checkpoints) checkpoint.reject(error);
    checkpoints.clear();
    const waiters = openWaiters;
    openWaiters = [];
    waiters.forEach((waiter) => waiter.reject(error));
    const reject = finishReject;
    finishResolve = null;
    finishReject = null;
    if (reject) reject(error);
    else onError?.(error);
    onPending?.();
  };

  const stageAudio = () => {
    if (!pendingBytes) return;
    const merged = new Uint8Array(pendingBytes);
    let offset = 0;
    for (const chunk of pendingChunks) { merged.set(chunk, offset); offset += chunk.length; }
    pendingChunks = [];
    pendingBytes = 0;
    outgoing.push({ kind: 'audio', bytes: merged });
  };

  const flush = () => {
    stageAudio();
    if (!ws || !wsOpen || ws.readyState !== 1) {
      if (lazy && outgoing.length && !ws && !connecting && reconnectTimer === undefined && !fatalError && !closedByClient) open();
      return;
    }
    for (const op of outgoing.splice(0)) {
      if (op.kind === 'audio') {
        ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: base64FromBytes(op.bytes) }));
      } else {
        commitsWaitingForIds.push(op.turn);
        ws.send(JSON.stringify({ type: 'input_audio_buffer.commit', event_id: `commit_${crypto.randomUUID()}` }));
      }
      sent.push(op);
    }
    maybeResolveFinish();
  };

  const finalize = (id, text) => {
    const part = ensurePart(id);
    part.final = text;
    part.endMs ??= elapsed();
    publishItem(id);
    publish();
    waitingForFinal.delete(id);
    const sequence = itemTurns.get(id);
    if (sequence !== undefined) { settleTurn(sequence); itemTurns.delete(id); }
  };

  const onMessage = (raw) => {
    let event;
    try { event = JSON.parse(typeof raw === 'string' ? raw : String(raw)); } catch { return; }
    if (event.type === 'input_audio_buffer.committed') {
      const turn = commitsWaitingForIds.shift();
      if (event.item_id && turn) {
        const part = ensurePart(event.item_id);
        part.startMs = turn.startMs;
        part.endMs = turn.endMs;
        sequenceItems.set(turn.sequence, event.item_id);
        if (dropped.has(turn.sequence)) part.dropped = true;
        else itemTurns.set(event.item_id, turn.sequence);
        if (part.final === null && !part.dropped) waitingForFinal.add(event.item_id);
        else settleTurn(turn.sequence, !part.dropped);
        publishItem(event.item_id);
      }
      maybeResolveFinish();
      return;
    }
    if (event.type === 'conversation.item.input_audio_transcription.delta' && event.item_id) {
      ensurePart(event.item_id).draft += event.delta ?? '';
      publishItem(event.item_id);
      publish();
      return;
    }
    if (event.type === 'conversation.item.input_audio_transcription.completed' && event.item_id) {
      reconnects = 0;
      const text = event.transcript ?? parts.get(event.item_id)?.draft ?? '';
      finalize(event.item_id, text);
      if (!parts.get(event.item_id).dropped) onFinal?.(text, { id: event.item_id, startMs: parts.get(event.item_id).startMs, endMs: parts.get(event.item_id).endMs });
      maybeResolveFinish();
      return;
    }
    const reason = `${event.error?.code ?? ''} ${event.error?.message || 'Realtime transcription failed.'}`.trim();
    if (event.type === 'conversation.item.input_audio_transcription.failed' && event.item_id) {
      // 只有這一句轉不出來：這句當成沒有字，後面照常轉
      note(`item failed ${reason}`);
      finalize(event.item_id, '');
      maybeResolveFinish();
      return;
    }
    if (event.type === 'error') {
      // 斷句時這條連線裡沒有聲音：沒有東西可轉，這次斷句就算完成
      if (event.error?.code === 'input_audio_buffer_commit_empty') {
        const turn = commitsWaitingForIds.shift();
        if (turn) settleTurn(turn.sequence);
        maybeResolveFinish();
        return;
      }
      reconnect(new Error(reason));
    }
  };

  const detach = (socket) => {
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    try { socket.close(); } catch { /* 已經關了 */ }
  };

  function open() {
    reconnectTimer = undefined;
    connecting = true;
    Promise.resolve().then(() => connect()).then((target) => {
      connecting = false;
      if (closedByClient || fatalError) return;
      const { url, headers, sessionUpdate } = typeof target === 'string' ? { url: target } : target;
      const socket = headers ? new WebSocket(url, { headers }) : new WebSocket(url);
      ws = socket;
      socket.onopen = () => {
        if (ws !== socket) return;
        if (sessionUpdate) socket.send(JSON.stringify(sessionUpdate));
        wsOpen = true;
        connectedAt = Date.now();
        flush();
        const waiters = openWaiters;
        openWaiters = [];
        waiters.forEach((waiter) => waiter.resolve());
      };
      socket.onmessage = (message) => { if (ws === socket) onMessage(message.data); };
      socket.onclose = (event) => {
        if (ws === socket && !closedByClient) reconnect(new Error(`Realtime transcription connection closed (${event.code}${event.reason ? ` ${event.reason}` : ''}).`));
      };
      socket.onerror = () => {
        if (ws === socket && !closedByClient) reconnect(new Error('Realtime transcription connection failed.'));
      };
    }, (error) => {
      connecting = false;
      if (closedByClient) return;
      if (error?.permanent) fail(error);
      else reconnect(error instanceof Error ? error : new Error(String(error)));
    });
  }

  // 換一條新連線：舊連線上還沒轉完的句子不會再有結果，連同之後的聲音照順序重送到新連線
  function reconnect(error) {
    if (closedByClient || fatalError || reconnectTimer !== undefined) return;
    if (reconnects >= maxReconnects) { fail(error); return; }
    reconnects += 1;
    note(`reconnect ${reconnects}: ${error.message}`);
    const old = ws;
    ws = null;
    wsOpen = false;
    connectedAt = 0;
    detach(old);
    // 舊連線上還沒定案的句子（講到一半就先出的字、斷了句還在等的字）都收掉，重送後由新連線的句子取代，不然會重複
    for (const [id, part] of parts) {
      if (part.final !== null) continue;
      part.draft = '';
      part.final = '';
      publishItem(id);
      itemTurns.delete(id);
    }
    waitingForFinal.clear();
    commitsWaitingForIds.length = 0;
    outgoing.unshift(...sent.splice(0));
    // 沒有要重送的東西、又是有聲音才連的：等下次開口再連
    if (lazy && !outgoing.length && !pendingBytes) { reconnects = 0; return; }
    reconnectTimer = setTimeout(open, retryBaseMs * 2 ** (reconnects - 1));
  }

  const waitForOpen = () => new Promise((resolve, reject) => {
    if (fatalError) return reject(fatalError);
    if (wsOpen) return resolve();
    if (lazy && !ws && !connecting && reconnectTimer === undefined) open();
    const timer = setTimeout(() => reject(new Error('Realtime transcription connection timed out.')), openTimeoutMs);
    openWaiters.push({
      resolve: () => { clearTimeout(timer); resolve(); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
  });

  const nothingPending = () => !pendingBytes && !outgoing.length && !pendingTurns.size && !commitsWaitingForIds.length && !waitingForFinal.size;

  if (!lazy) open();

  return {
    append(bytes) {
      if (!bytes?.length || closedByClient) return;
      pendingChunks.push(bytes);
      pendingBytes += bytes.length;
    },
    commit(turn) {
      stageAudio();
      const sequence = ++turnSequence;
      pendingTurns.add(sequence);
      outgoing.push({ kind: 'commit', turn: { ...turn, sequence } });
      flush();
      onPending?.();
      return sequence;
    },
    flush,
    // 這句作廢：字不算進全文、不用等它；還沒送出的 commit 照送（聲音已經在連線的緩衝裡），回來的字丟掉
    discard(sequence) {
      if (!sequence || dropped.has(sequence)) return;
      dropped.add(sequence);
      const id = sequenceItems.get(sequence);
      if (id !== undefined) {
        const part = parts.get(id);
        if (part) part.dropped = true;
        itemTurns.delete(id);
        waitingForFinal.delete(id);
        publishItem(id);
        publish();
      }
      if (pendingTurns.has(sequence)) settleTurn(sequence, false);
      maybeResolveFinish();
    },
    // 送出去、還在等字的句子數
    pending: () => pendingTurns.size,
    lastSequence: () => turnSequence,
    busy: () => !nothingPending() || connecting,
    get failed() { return fatalError; },
    transcript,
    waitForOpen,
    // 等到序號 ≤ target 的句子都拿到字
    async waitFor(target = turnSequence) {
      if (fatalError) throw fatalError;
      await waitForOpen();
      flush();
      if (fatalError) throw fatalError;
      if (![...pendingTurns].some((pending) => pending <= target)) return;
      await new Promise((resolve, reject) => { checkpoints.add({ target, resolve, reject }); });
    },
    // 不會再有新的聲音：等所有句子的字都拿到，回傳全部的字
    async finish() {
      if (fatalError) throw fatalError;
      if (finishRequested) throw new Error('Realtime transcription is already finishing.');
      finishRequested = true;
      stageAudio();
      if (!outgoing.some((op) => op.kind === 'commit') && !commitsWaitingForIds.length && !waitingForFinal.size) return transcript().trim();
      flush();
      if (!outgoing.length && !commitsWaitingForIds.length && !waitingForFinal.size) return transcript().trim();
      await waitForOpen();
      flush();
      return new Promise((resolve, reject) => {
        finishResolve = resolve;
        finishReject = reject;
        maybeResolveFinish();
      });
    },
    // 整天開著的用（Mac 小程式）：沒在講、沒在等字時，安靜夠久或連線快到上限就先關，下次有聲音再連
    idle({ active = true, quietForMs = 0, speaking = false } = {}) {
      if (!ws || speaking || !nothingPending()) return;
      if ((!active && quietForMs > IDLE_CLOSE_MS) || (connectedAt && Date.now() - connectedAt > MAX_SOCKET_AGE_MS)) {
        const old = ws;
        ws = null;
        wsOpen = false;
        connectedAt = 0;
        sent.length = 0;
        detach(old);
      }
    },
    close() {
      closedByClient = true;
      if (reconnectTimer !== undefined) { clearTimeout(reconnectTimer); reconnectTimer = undefined; }
      for (const checkpoint of checkpoints) checkpoint.reject(new Error('Realtime transcription closed.'));
      checkpoints.clear();
      const old = ws;
      ws = null;
      wsOpen = false;
      detach(old);
      onPending?.();
    },
  };
}

// 聲音不是一開就一直在跑：AudioContext 晚開、被 iOS 中斷（另一段錄音還在收尾）、麥克風暫時沒聲音時，
// 樣本數會落後真實時間，之後每一句都被算早，第一句變成 0:00。落後超過這麼多就把時鐘拉回真實時間。
export const AUDIO_GAP_MS = 300;

// createSpeechTranscription —— 一段錄音的轉寫：收音那一頭每 100 ms 送一批樣本進來（push），這裡斷句、送音、等字。
// 平行沙盒（輸入框聽寫、驗收錄影的逐句字幕）、CubeLV（輸入框聽寫）都用這個；收音（瀏覽器的 AudioWorklet）在各 app。
//   push(samples, { startSample, at })：samples 是 Int16Array；startSample 是收音那一頭的第幾個樣本，at 是這批收完的時間（Date.now()）。
//   cut()：講到一半的那句先送出去（收音被中斷、截圖分界）。
//   checkpoint(wait)：到目前為止的聲音都切成句子送出，wait 就等字都拿到；回傳到哪一 ms 為止。
//   finish()：停止收音，等所有字拿到，回傳全部的字。
//   onActivity('idle' | 'hearing' | 'recognizing')：hearing＝正在講話；recognizing＝講完的句子送出了、還在等字。
//   earlyTranscribe（預設關）：講話中停了 earlyTranscribeMs（400）就先 commit 這句，不等 850 ms 斷句，按停止時字常常已經回來。
//     之後的聲音先留著：沒再開口就丟掉（這句就是先送的那份）；又開口時——
//     'split'：先送的那段算一句，接下來是新的一句（句子被切成兩段，不多花錢）；
//     'resend'：先送的那份作廢，這句從頭整段重送（字跟不提早一樣，重送的秒數會再計費一次）。
export function createSpeechTranscription({ recordingStartedAt, onActivity, earlyTranscribe = false, earlyTranscribeMs = 400, ...options }) {
  const origin = recordingStartedAt ?? Date.now();
  // 一批聲音的時間＝clockOffsetMs＋第幾個樣本；聲音停過一段就往後挪（AUDIO_GAP_MS）
  let clockOffsetMs = Math.max(0, Date.now() - origin);
  let capturedUntilMs = clockOffsetMs;
  let samplesSeen = 0;
  let capturing = true;
  let ended = false;
  let closed = false;
  const splitter = new TurnSplitter({ tentativeMs: earlyTranscribe ? earlyTranscribeMs : 0 });
  let turnAudio = []; // 這句到目前為止的聲音（resend 重送用）
  let pieceStartMs = null; // split：又開口後新的一段從哪裡開始
  let early = null; // 先 commit 了、還沒切句也還沒又開口：{ sequence, held（之後留著沒送的聲音） }
  let activity = 'idle';
  const elapsed = () => Math.max(0, Date.now() - origin);
  const updateActivity = () => {
    const next = closed || transcriber.failed ? 'idle'
      : capturing && splitter.speaking ? 'hearing' : transcriber.pending() ? 'recognizing' : 'idle';
    if (next === activity) return;
    activity = next;
    onActivity?.(next);
  };
  const transcriber = createTranscriber({
    ...options,
    elapsed,
    startHint: () => splitter.currentStartMs,
    onPending: () => updateActivity(),
  });
  const flushTimer = setInterval(() => transcriber.flush(), 250);
  const send = ({ audio, turn, tentative, resumed }, startMs) => {
    if (earlyTranscribe === 'resend') turnAudio.push(...audio);
    if (early) early.held.push(...audio);
    else for (const bytes of audio) transcriber.append(bytes);
    if (tentative) {
      early = { sequence: transcriber.commit({ startMs: pieceStartMs ?? splitter.currentStartMs, endMs: splitter.detector.lastVoiceEnd }), held: [] };
    } else if (resumed && early) {
      if (earlyTranscribe === 'resend') {
        transcriber.discard(early.sequence);
        let bytes = 0;
        for (const chunk of turnAudio) { transcriber.append(chunk); bytes += chunk.length; }
        options.log?.(`[transcription] early commit discarded, resent ${(bytes / 48000).toFixed(1)}s`);
      } else {
        for (const bytes of early.held) transcriber.append(bytes);
        pieceStartMs = startMs;
      }
      early = null;
    }
    if (turn) {
      // 先送的那份就是這句（後面只有靜音），不用再 commit
      if (!early) transcriber.commit(pieceStartMs === null ? turn : { ...turn, startMs: pieceStartMs });
      early = null;
      turnAudio = [];
      pieceStartMs = null;
    }
  };
  const cut = () => {
    send(splitter.finish());
    updateActivity();
  };

  return {
    push(samples, { startSample, at = Date.now() } = {}) {
      if (!capturing || !samples?.length) return;
      const durationMs = samples.length / 24;
      const sampleMs = (startSample ?? samplesSeen) / 24;
      samplesSeen = (startSample ?? samplesSeen) + samples.length;
      const actualStartMs = at - origin - durationMs;
      if (actualStartMs - (clockOffsetMs + sampleMs) > AUDIO_GAP_MS) clockOffsetMs = actualStartMs - sampleMs;
      const startMs = clockOffsetMs + sampleMs;
      capturedUntilMs = startMs + durationMs;
      send(splitter.push(samples, startMs), startMs);
      updateActivity();
    },
    cut,
    get speaking() { return splitter.speaking; },
    get capturedUntilMs() { return capturedUntilMs; },
    get failed() { return transcriber.failed; },
    async checkpoint(wait = true) {
      if (transcriber.failed) throw transcriber.failed;
      if (ended || closed) throw new Error('Realtime transcription is ending.');
      cut();
      const boundary = capturedUntilMs;
      if (!wait) return boundary;
      await transcriber.waitFor(transcriber.lastSequence());
      return boundary;
    },
    async finish() {
      if (transcriber.failed) throw transcriber.failed;
      if (ended) throw new Error('Realtime transcription is already finishing.');
      ended = true;
      cut();
      capturing = false;
      updateActivity();
      try {
        return await transcriber.finish();
      } finally {
        clearInterval(flushTimer);
        updateActivity();
      }
    },
    // 收音停了（不再 push），句子照樣轉完
    stopCapture() {
      capturing = false;
      updateActivity();
    },
    close() {
      closed = true;
      capturing = false;
      clearInterval(flushTimer);
      transcriber.close();
      updateActivity();
    },
  };
}
