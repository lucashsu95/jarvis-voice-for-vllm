// 核心的即時轉寫（core/transcription.mjs）與斷句（core/turns.mjs）：Mac 小程式、CubeLV、平行沙盒共用的那一份。
// 用假的 WebSocket，不連網路。

import assert from 'node:assert/strict';
import { test, beforeEach, afterEach } from 'node:test';

const core = await import('../core/index.mjs');

class FakeSocket {
  static all = [];
  readyState = 0;
  sent = [];
  onopen = null;
  onmessage = null;
  onclose = null;
  onerror = null;
  constructor(url, init) { this.url = url; this.init = init; FakeSocket.all.push(this); }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  emit(event) { this.onmessage?.({ data: JSON.stringify(event) }); }
  drop() { this.readyState = 3; this.onclose?.({ code: 1006, reason: '' }); }
  audioBytes() { return this.sent.filter((e) => e.type === 'input_audio_buffer.append').reduce((sum, e) => sum + Buffer.from(e.audio, 'base64').length, 0); }
  commits() { return this.sent.filter((e) => e.type === 'input_audio_buffer.commit').length; }
}

const realWebSocket = globalThis.WebSocket;
beforeEach(() => { FakeSocket.all = []; globalThis.WebSocket = FakeSocket; });
afterEach(() => { globalThis.WebSocket = realWebSocket; });

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
// 一批 100 ms 的聲音（2400 個樣本），level 0 是沒講話
const batch = (level) => new Int16Array(2400).fill(Math.round(level * 32767));

function startSpeech(connect = async () => 'wss://transcribe', extra = {}) {
  const items = new Map();
  const activity = [];
  const errors = [];
  let sample = 0;
  const origin = Date.now();
  const session = core.createSpeechTranscription({
    connect,
    recordingStartedAt: origin,
    retryBaseMs: 10,
    onItem: (item) => items.set(item.id, item),
    onActivity: (next) => activity.push(next),
    onError: (error) => errors.push(error),
    ...extra,
  });
  // 照真實時間送：第 n 批在 origin + (n+1)×100 ms 收完；offsetMs 是收音停過的時間
  let offsetMs = 0;
  const speak = (batches, level = 0.08) => {
    for (let n = 0; n < batches; n += 1) {
      session.push(batch(level), { startSample: sample, at: origin + offsetMs + (sample + 2400) / 24 });
      sample += 2400;
    }
  };
  const stall = (ms) => { offsetMs += ms; };
  return { session, items, activity, errors, speak, stall };
}

test('斷句：0:05 與 0:25 兩段話切成兩句，時間照講的時候', () => {
  const d = new core.AudioTurnDetector();
  const turns = [];
  for (let n = 0; n < 300; n += 1) {
    const ms = n * 100;
    const speaking = (ms >= 5000 && ms < 6000) || (ms >= 25000 && ms < 26500);
    const turn = d.push(batch(speaking ? 0.08 : 0.002), ms);
    if (turn) turns.push(turn);
  }
  assert.deepEqual(turns, [{ startMs: 5000, endMs: 6000 }, { startMs: 25000, endMs: 26500 }]);
});

test('斷句：手機麥克風底噪很高時，門檻跟著底噪走，第一句的時間不會變成 0:00', () => {
  // iPhone 實錄：安靜時麥克風增益拉高，底噪 RMS 0.011～0.035 一直壓在固定門檻上，偶爾敲到螢幕；48 秒才開口。
  const d = new core.AudioTurnDetector();
  const turns = [];
  for (let n = 0; n < 700; n += 1) {
    const ms = n * 100;
    let level = [0.012, 0.014, 0.013, 0.018, 0.012, 0.022, 0.013][n % 7];
    if (n % 97 === 50) level = 0.1;
    if (ms >= 48000 && ms < 58000) level = n % 5 === 2 ? 0.03 : 0.12;
    else if (ms >= 58000) level = 0.002;
    const turn = d.push(batch(level), ms);
    if (turn) turns.push(turn);
  }
  assert.deepEqual(turns.filter((t) => t.startMs >= 1000), [{ startMs: 48000, endMs: 58000 }]);
});

test('斷句：安靜的地方尖峰夠高也算人聲（短促的子音）；截圖分界不帶走不到門檻的尾巴', () => {
  const d = new core.AudioTurnDetector();
  const spiky = () => { const s = new Int16Array(2400); s[1200] = 0.3 * 32767; return s; }; // RMS 0.006，尖峰 0.3
  d.push(spiky(), 0);
  d.push(spiky(), 100);
  assert.equal(d.speaking, true);
  assert.deepEqual(d.finish(), { startMs: 0, endMs: 200 });
  d.push(new Int16Array(1200).fill(2600), 1000);
  assert.equal(d.finish(), null);
  d.push(batch(0.08), 1050);
  d.push(batch(0.08), 1150);
  assert.deepEqual(d.finish(), { startMs: 1050, endMs: 1250 });
});

test('TurnSplitter：開口前 0.4 秒一起送，沒講話的聲音不送', () => {
  const s = new core.TurnSplitter();
  for (let n = 0; n < 6; n += 1) assert.equal(s.push(batch(0), n * 100).audio.length, 0);
  assert.equal(s.push(batch(0.08), 600).audio.length, 0); // 還不到 180 ms，先留著
  const started = s.push(batch(0.08), 700);
  assert.equal(s.speaking, true);
  assert.equal(started.audio.length, 5); // 4 批預錄（含剛才那批）＋這批
  assert.equal(s.push(batch(0.08), 800).audio.length, 1);
  let turn = null;
  for (let n = 0; n < 9 && !turn; n += 1) turn = s.push(batch(0), 900 + n * 100).turn;
  assert.deepEqual(turn, { startMs: 600, endMs: 900 });
});

test('TurnSplitter 暫定斷句：停 0.4 秒先報一次 tentative，又開口報 resumed，停滿 0.85 秒照常切句', () => {
  const s = new core.TurnSplitter();
  for (let n = 0; n < 3; n += 1) s.push(batch(0.08), n * 100);
  assert.equal(s.speaking, true);
  const events = [];
  const feed = (level, count, at) => {
    for (let n = 0; n < count; n += 1) {
      const r = s.push(batch(level), at + n * 100);
      if (r.tentative) events.push(`tentative@${at + n * 100}`);
      if (r.resumed) events.push(`resumed@${at + n * 100}`);
      if (r.turn) events.push(`turn@${at + n * 100}`);
    }
  };
  feed(0, 5, 300); // 停 0.5 秒：第 4 批（400 ms）報 tentative
  feed(0.08, 2, 800); // 又開口
  feed(0, 9, 1000); // 停滿 0.85 秒切句，中間 400 ms 再報一次
  assert.deepEqual(events, ['tentative@600', 'resumed@800', 'tentative@1300', 'turn@1800']);
  // tentativeMs 0：不報
  const off = new core.TurnSplitter({ tentativeMs: 0 });
  for (let n = 0; n < 3; n += 1) off.push(batch(0.08), n * 100);
  for (let n = 0; n < 9; n += 1) assert.equal(off.push(batch(0), 300 + n * 100).tentative, false);
});

test('斷句：有聲音但還不到 180 ms 時是 starting（還不知道是開口還是雜音）', () => {
  const d = new core.AudioTurnDetector();
  d.push(new Int16Array(2400), 0);
  assert.equal(d.starting, false);
  d.push(batch(0.08), 100);
  assert.equal(d.starting, true);
  d.push(batch(0.08), 200);
  assert.equal(d.speaking, true);
  assert.equal(d.starting, false);
});

test('雙發：誰先成功用誰、其他的取消；一份失敗用另一份；全部失敗丟第一份的錯', async () => {
  const aborted = [];
  const call = (plan) => ({ signal, n }) => new Promise((resolve, reject) => {
    const [ms, value, fail] = plan[n];
    const timer = setTimeout(() => (fail ? reject(new Error(value)) : resolve(value)), ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); aborted.push(n); reject(new Error('aborted')); });
  });
  let n = 0;
  const wrap = (fn) => (args) => fn({ ...args, n: n++ });
  assert.equal(await core.hedge(wrap(call([[200, '慢'], [10, '快']])), 2)({}), '快');
  assert.deepEqual(aborted, [0]);
  n = 0;
  assert.equal(await core.hedge(wrap(call([[5, 'boom', true], [30, '另一份']])), 2)({}), '另一份');
  n = 0;
  await assert.rejects(core.hedge(wrap(call([[5, '第一份壞了', true], [10, '第二份也壞了', true]])), 2)({}), /第一份壞了/);
  const plain = async () => 'x';
  assert.equal(core.hedge(plain, 1), plain);
});

test('即時轉寫：連線斷在一句話中間，重連後把還沒轉的聲音補送，舊連線的半句收掉不重複', async () => {
  let urls = 0;
  const { session, items, errors, speak } = startSpeech(async () => `wss://transcribe/${++urls}`);
  await tick();
  const first = FakeSocket.all[0];
  first.open();
  speak(5);
  await tick(300);
  const sentBeforeDrop = first.audioBytes();
  assert.ok(sentBeforeDrop > 0);
  first.emit({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'old', delta: '這裡的' });
  first.drop();
  await tick(40);
  const second = FakeSocket.all[1];
  assert.equal(second.url, 'wss://transcribe/2');
  second.open();
  assert.equal(second.audioBytes(), sentBeforeDrop);
  assert.deepEqual({ text: items.get('old').text, final: items.get('old').final }, { text: '', final: true });

  const boundary = session.checkpoint();
  await tick();
  assert.equal(second.commits(), 1);
  second.emit({ type: 'input_audio_buffer.committed', item_id: 'new' });
  second.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'new', transcript: '這裡的標題太長了' });
  assert.ok(await boundary > 0);
  assert.equal(items.get('new').text, '這裡的標題太長了');
  assert.deepEqual(errors, []);
  session.close();
});

test('即時轉寫：送出 commit 後連線斷了、字沒回來，重連時那句再送一次', async () => {
  const { session, items, errors, speak } = startSpeech();
  await tick();
  FakeSocket.all[0].open();
  speak(5);
  const boundary = session.checkpoint();
  await tick();
  assert.equal(FakeSocket.all[0].commits(), 1);
  FakeSocket.all[0].drop();
  await tick(40);
  const second = FakeSocket.all[1];
  second.open();
  assert.equal(second.commits(), 1);
  second.emit({ type: 'input_audio_buffer.committed', item_id: 'again' });
  second.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'again', transcript: '確認按鈕的位置不對' });
  assert.ok(await boundary > 0);
  assert.equal(items.get('again').text, '確認按鈕的位置不對');
  assert.deepEqual(errors, []);
  session.close();
});

test('即時轉寫：空的 commit、一句轉不出來，都照常往下轉', async () => {
  const { session, errors, speak } = startSpeech();
  await tick();
  const socket = FakeSocket.all[0];
  socket.open();
  speak(5);
  const first = session.checkpoint();
  await tick();
  socket.emit({ type: 'error', error: { code: 'input_audio_buffer_commit_empty', message: 'buffer too small' } });
  assert.ok(await first > 0);
  speak(5);
  const second = session.checkpoint();
  await tick();
  socket.emit({ type: 'input_audio_buffer.committed', item_id: 'bad' });
  socket.emit({ type: 'conversation.item.input_audio_transcription.failed', item_id: 'bad', error: { message: 'could not transcribe' } });
  assert.ok(await second > 0);
  assert.equal(FakeSocket.all.length, 1);
  assert.deepEqual(errors, []);
  session.close();
});

test('即時轉寫：收音停過 20 秒，之後那句的時間照真的講的時候，不會被算早', async () => {
  const { session, items, speak, stall } = startSpeech();
  await tick();
  const socket = FakeSocket.all[0];
  socket.open();
  speak(3, 0);
  stall(20_000);
  speak(5);
  const boundary = session.checkpoint();
  await tick();
  socket.emit({ type: 'input_audio_buffer.committed', item_id: 'late' });
  socket.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'late', transcript: '這個按鈕按了沒反應' });
  assert.ok(await boundary > 20_000);
  assert.ok(items.get('late').startMs >= 19_800);
  session.close();
});

test('即時轉寫：講話中是 hearing，句子送出還沒回字是 recognizing，都拿到是 idle', async () => {
  const { session, activity, speak } = startSpeech();
  await tick();
  const socket = FakeSocket.all[0];
  socket.open();
  speak(1, 0);
  assert.deepEqual(activity, []);
  speak(3);
  assert.deepEqual(activity, ['hearing']);
  speak(9, 0); // 停頓 0.9 秒斷句：送出這句，在等字
  assert.equal(socket.commits(), 1);
  assert.deepEqual(activity, ['hearing', 'recognizing']);
  speak(3); // 上一句還在辨識時又開口：先顯示收到聲音
  assert.equal(activity.at(-1), 'hearing');
  socket.emit({ type: 'input_audio_buffer.committed', item_id: 'one' });
  socket.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'one', transcript: '第一句' });
  assert.equal(activity.at(-1), 'hearing');
  const done = session.finish();
  await tick();
  assert.equal(activity.at(-1), 'recognizing');
  socket.emit({ type: 'input_audio_buffer.committed', item_id: 'two' });
  socket.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'two', transcript: '第二句' });
  // 中文句子接起來不多空格
  assert.equal(await done, '第一句第二句');
  assert.equal(activity.at(-1), 'idle');
});

test('即時轉寫：句子接起來時中文直接接，英文與中文交界空一格', async () => {
  const transcripts = [];
  const { session, speak } = startSpeech(async () => 'wss://transcribe', { onTranscript: (t) => transcripts.push(t) });
  await tick();
  const socket = FakeSocket.all[0];
  socket.open();
  for (const [id, text] of [['a', '帶筆電。'], ['b', '這個問題是 deploy'], ['c', '之後才出現的']]) {
    speak(5);
    const boundary = session.checkpoint();
    await tick();
    socket.emit({ type: 'input_audio_buffer.committed', item_id: id });
    socket.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: id, transcript: text });
    await boundary;
  }
  assert.equal(transcripts.at(-1), '帶筆電。這個問題是 deploy 之後才出現的');
  session.close();
});

test('即時轉寫：連不上就重試，連續失敗才放棄，而且只報一次', async () => {
  let calls = 0;
  const { errors, session } = startSpeech(async () => { calls += 1; throw new Error('offline'); });
  await tick(10 + 20 + 40 + 80 + 100);
  assert.equal(calls, 1 + core.MAX_RECONNECTS);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, 'offline');
  session.close();
});

test('即時轉寫：key 錯這種重試也沒用的錯，直接放棄', async () => {
  let calls = 0;
  const { errors, session } = startSpeech(async () => { calls += 1; throw core.permanentError('沒有 key'); });
  await tick(50);
  assert.equal(calls, 1);
  assert.equal(errors[0].message, '沒有 key');
  session.close();
});

test('即時轉寫（Mac 小程式）：有聲音才連線；帶 header 與 session 設定；一句一句交出字；安靜夠久先關、再開口再連', async () => {
  const finals = [];
  const t = core.createTranscriber({
    connect: async () => ({ url: 'wss://openai', headers: { Authorization: 'Bearer sk-test' }, sessionUpdate: { type: 'session.update' } }),
    lazy: true,
    onFinal: (text) => finals.push(text),
  });
  await tick();
  assert.equal(FakeSocket.all.length, 0);
  t.append(new Uint8Array(4800));
  t.commit({ startMs: 0, endMs: 100 });
  await tick();
  const socket = FakeSocket.all[0];
  assert.deepEqual(socket.init, { headers: { Authorization: 'Bearer sk-test' } });
  socket.open();
  assert.equal(socket.sent[0].type, 'session.update');
  assert.equal(socket.audioBytes(), 4800);
  assert.equal(socket.commits(), 1);
  assert.equal(t.busy(), true);
  socket.emit({ type: 'input_audio_buffer.committed', item_id: 'a' });
  socket.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'a', transcript: '你好，世界' });
  assert.deepEqual(finals, ['你好，世界']);
  assert.equal(t.busy(), false);
  t.idle({ active: true, quietForMs: 120_000 });
  assert.equal(socket.readyState, 1); // 還在收音的 app：不關
  t.idle({ active: false, quietForMs: 120_000 });
  assert.equal(socket.readyState, 3);
  t.append(new Uint8Array(4800));
  t.flush();
  await tick();
  assert.equal(FakeSocket.all.length, 2);
  t.close();
});
