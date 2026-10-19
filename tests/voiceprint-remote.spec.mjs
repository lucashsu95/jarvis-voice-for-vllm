// 手機不裝模型的聲紋過濾（CubeLV、平行沙盒）：後端算聲紋、照前端給的擋法擋；前端核心記樣本、越用越準。
// 協定在 core/transcription.mjs（voiceprint 選項），規則在 core/voiceprint.mjs（gate、passesGate、createRemoteVoiceprint）。
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
  of(type) { return this.sent.filter((e) => e.type === type); }
}

const realWebSocket = globalThis.WebSocket;
beforeEach(() => { FakeSocket.all = []; globalThis.WebSocket = FakeSocket; });
afterEach(() => { globalThis.WebSocket = realWebSocket; });

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const batch = (level) => new Int16Array(2400).fill(Math.round(level * 32767));

// 假的聲紋：使用者在 x 軸附近，別人在 y 軸附近（8 維，加一點雜訊）
function voices(seed = 11) {
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
  return (axis) => core.normalize(Array.from({ length: 8 }, (_, i) => (i === axis ? 1 : 0) + rand() * 0.2));
}

const GATE = { reference: [1, 0], threshold: 0.3, shortThreshold: 0.1, minSeconds: 1.5 };

function startSpeech(voiceprint) {
  const errors = [];
  let sample = 0;
  const origin = Date.now();
  const session = core.createSpeechTranscription({
    connect: async () => 'wss://transcribe',
    recordingStartedAt: origin,
    retryBaseMs: 10,
    onError: (error) => errors.push(error),
    voiceprint,
  });
  // 先安靜 1 秒（底噪），講 seconds 秒，再停 1 秒（停 0.85 秒就切句、commit）
  const say = (seconds) => {
    const speech = seconds * 10;
    for (let n = 0; n < speech + 20; n += 1) {
      const talking = n >= 10 && n < 10 + speech;
      session.push(batch(talking ? 0.08 : 0.002), { startSample: sample, at: origin + (sample + 2400) / 24 });
      sample += 2400;
    }
  };
  return { session, errors, say };
}

test('後端算聲紋：開線先送擋法再送聲音；每句 commit 前附這句幾秒；擋掉的句子不等字，放行的照常出字', async () => {
  const turns = [];
  const voiceprint = { config: () => GATE, onTurn: (event) => { turns.push(event); return false; } };
  const { session, errors, say } = startSpeech(voiceprint);
  await tick();
  const socket = FakeSocket.all[0];
  socket.open();
  assert.equal(socket.sent[0].type, 'voiceprint.config', '擋法要在聲音之前');
  assert.deepEqual(socket.sent[0].reference, [1, 0]);
  assert.equal(socket.sent[0].short_threshold, 0.1);
  assert.match(socket.sent[0].event_id, /^voiceprint_/);
  socket.emit({ type: 'voiceprint.ready', model: core.REMOTE_VOICEPRINT_MODEL });

  // 第一句（別人）：後端擋掉
  say(2);
  await tick(300);
  const [info] = socket.of('voiceprint.turn_info');
  const [commit] = socket.of('input_audio_buffer.commit');
  assert.equal(info.commit_event_id, commit.event_id);
  assert.ok(Math.abs(info.seconds - 2) < 0.15, `這句講了約 2 秒（${info.seconds}）`);
  socket.emit({ type: 'voiceprint.turn', commit_event_id: commit.event_id, pass: false, score: 0.05, seconds: 2, embedding: [0, 1] });

  // 第二句（自己）：放行，照常 committed、出字
  say(2);
  await tick(300);
  const second = socket.of('input_audio_buffer.commit')[1];
  socket.emit({ type: 'voiceprint.turn', commit_event_id: second.event_id, pass: true, score: 0.8, seconds: 2, embedding: [1, 0] });
  socket.emit({ type: 'input_audio_buffer.committed', item_id: 'mine' });
  socket.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'mine', transcript: '這是我講的' });

  assert.equal(await session.finish(), '這是我講的');
  assert.deepEqual(turns.map((t) => t.pass), [false, true]);
  assert.equal(FakeSocket.all.length, 1);
  assert.deepEqual(errors, []);
  session.close();
});

test('後端算聲紋：斷線重連時，擋掉的句子不重送、還在等字的照常補送；同一句的聲紋只記一次；擋法重送一次', async () => {
  let onTurnCalls = 0;
  const voiceprint = { config: () => GATE, onTurn: () => { onTurnCalls += 1; return false; } };
  const { session, errors, say } = startSpeech(voiceprint);
  await tick();
  const first = FakeSocket.all[0];
  first.open();
  first.emit({ type: 'voiceprint.ready', model: core.REMOTE_VOICEPRINT_MODEL });
  say(2); // A：自己，放行但字還沒回來
  await tick(300);
  say(2); // B：別人，擋掉
  await tick(300);
  const [a, b] = first.of('input_audio_buffer.commit');
  first.emit({ type: 'voiceprint.turn', commit_event_id: a.event_id, pass: true, score: 0.7, seconds: 2, embedding: [1, 0] });
  first.emit({ type: 'voiceprint.turn', commit_event_id: b.event_id, pass: false, score: 0.0, seconds: 2, embedding: [0, 1] });
  first.drop();
  await tick(40);
  const second = FakeSocket.all[1];
  second.open();
  assert.equal(second.sent[0].type, 'voiceprint.config');
  const resent = second.of('input_audio_buffer.commit');
  assert.deepEqual(resent.map((c) => c.event_id), [a.event_id], '只補送 A，同一個 event_id');
  second.emit({ type: 'voiceprint.turn', commit_event_id: a.event_id, pass: true, score: 0.7, seconds: 2, embedding: [1, 0] });
  second.emit({ type: 'input_audio_buffer.committed', item_id: 'a' });
  second.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'a', transcript: '第一句' });
  assert.equal(await session.finish(), '第一句');
  assert.equal(onTurnCalls, 2, 'A 重送後再回一次，不再記');
  assert.deepEqual(errors, []);
  session.close();
});

test('後端算聲紋：舊後端把設定轉給 OpenAI、回錯（event_id 是 voiceprint_ 開頭）：不重連、之後不送，照常轉寫', async () => {
  let unsupported = 0;
  const voiceprint = { config: () => GATE, onTurn: () => false, onUnsupported: () => { unsupported += 1; } };
  const { session, errors, say } = startSpeech(voiceprint);
  await tick();
  const socket = FakeSocket.all[0];
  socket.open();
  // 實際 OpenAI 回的（10/19 箱子接 dev 舊版 ai_prompt 量到的）
  const oldServerError = { type: 'error', error: { type: 'invalid_request_error', code: 'invalid_value', message: "Invalid value: 'voiceprint.config'. Supported values are: 'session.update', ...", param: 'type', event_id: socket.sent[0].event_id } };
  socket.emit(oldServerError);
  socket.emit(oldServerError);
  assert.equal(unsupported, 1, '畫面只收一次通知');
  say(2);
  await tick(300);
  assert.equal(socket.of('voiceprint.turn_info').length, 0, '知道不支援後就不送');
  socket.emit({ type: 'input_audio_buffer.committed', item_id: 'x' });
  socket.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'x', transcript: '照常轉寫' });
  assert.equal(await session.finish(), '照常轉寫');
  assert.equal(FakeSocket.all.length, 1, '沒有重連');
  assert.deepEqual(errors, []);
  session.close();
});

test('後端認得但模型沒載起來（available=false）：當成不支援，之後不送聲紋事件', async () => {
  let unsupported = 0;
  const voiceprint = { config: () => GATE, onTurn: () => false, onUnsupported: () => { unsupported += 1; } };
  const { session, say } = startSpeech(voiceprint);
  await tick();
  const socket = FakeSocket.all[0];
  socket.open();
  socket.emit({ type: 'voiceprint.ready', model: core.REMOTE_VOICEPRINT_MODEL, available: false });
  say(2);
  await tick(300);
  assert.equal(unsupported, 1);
  assert.equal(socket.of('voiceprint.turn_info').length, 0);
  session.close();
});

test('擋法：還在錄樣本是 null；錄好後 passesGate 跟 judge 放不放行一樣（短句用短句的門檻）', () => {
  const voice = voices();
  const vp = core.createVoiceprint();
  assert.equal(vp.gate(), null);
  assert.equal(core.passesGate(null, 0, 3), true, '還在錄樣本：放行');
  for (let i = 0; i < 4; i += 1) vp.judge(voice(0), 3);
  const gate = vp.gate();
  assert.ok(gate.reference.length === 8);
  for (const [axis, sec] of [[0, 3], [1, 3], [0, 1], [1, 1], [2, 0.8]]) {
    const v = voice(axis);
    const score = core.cosine(v, gate.reference);
    assert.equal(core.passesGate(gate, score, sec), vp.judge(v, sec, { dryRun: true }).pass, `axis ${axis} ${sec}s`);
  }
  assert.equal(core.passesGate(gate, null, 3), true, '算不出聲紋：放行');
});

test('前端記樣本：後端送回來的聲紋湊滿樣本就存檔、擋法變了要再送；換了模型就重錄；重錄會刪存檔', () => {
  const voice = voices(5);
  let saved = null;
  const changes = [];
  const store = { load: () => saved, save: (s) => { saved = s; }, clear: () => { saved = null; } };
  const remote = core.createRemoteVoiceprint({ store, onChange: (c) => changes.push(c) });
  const t = remote.transcription;
  assert.equal(t.config(), null);
  const turn = (axis, seconds = 3, pass = true) => t.onTurn({ type: 'voiceprint.turn', commit_event_id: 'c', pass, score: null, seconds, embedding: voice(axis) });
  assert.equal(turn(0), false);
  assert.ok(saved.pending.length === 1, '錄樣本中也存（下次接著錄）');
  turn(1);
  turn(0);
  assert.equal(turn(0), true, '湊滿 10 秒：擋法有了');
  assert.equal(saved.model, core.REMOTE_VOICEPRINT_MODEL);
  assert.equal(saved.enrolled.length, 3, '別人那句不算進樣本');
  assert.ok(t.config().reference.length === 8);
  assert.equal(changes.at(-1).enrolled, true);
  // 後端擋掉的句子：不記進樣本、擋法不變
  assert.equal(turn(1, 3, false), false);
  assert.equal(changes.at(-1).pass, false);
  // 存檔讀回來：一樣是錄好的
  const again = core.createRemoteVoiceprint({ store });
  assert.equal(again.enrolled(), true);
  assert.equal(again.transcription.onReady({ model: core.REMOTE_VOICEPRINT_MODEL }), false);
  assert.equal(again.transcription.onReady({ model: 'another-model' }), true, '換了模型：重錄，擋法要再送');
  assert.equal(again.enrolled(), false);
  assert.equal(saved, null);
  remote.reset();
  assert.equal(remote.enrolled(), false);
});

// 門檻（計劃 cubelv_docs 2026-10-19_聲紋門檻依個人自動調.md）：本人被擋 1% 以下優先，長句 0.2、短句 0.05，不依個人往上調
test('門檻：長句 0.2、短句 0.05——本人換了場次分數掉到 0.2 多照樣放行，跟你不像的擋掉；用多久都不會往上調', () => {
  assert.equal(core.VOICEPRINT_THRESHOLD, 0.2);
  assert.equal(core.VOICEPRINT_SHORT_THRESHOLD, 0.05);
  const voice = voices(13);
  const vp = core.createVoiceprint();
  for (let i = 0; i < 4; i += 1) vp.judge(voice(0), 3);
  assert.equal(vp.enrolled(), true);
  // 跟參考聲紋相似度剛好是 s 的聲紋
  const ref = vp.gate().reference;
  const v1 = voice(1);
  const orth = core.normalize(v1.map((x, i) => x - core.cosine(v1, ref) * ref[i]));
  const at = (s) => core.normalize(ref.map((x, i) => s * x + Math.sqrt(1 - s * s) * orth[i]));
  assert.equal(vp.judge(at(0.24), 3, { dryRun: true }).pass, true, '換場次的本人 0.24：放行');
  assert.equal(vp.judge(at(0.16), 3, { dryRun: true }).pass, false, '0.16：擋');
  assert.equal(vp.judge(at(0.08), 1, { dryRun: true }).pass, true, '短句 0.08：放行');
  assert.equal(vp.judge(at(0.02), 1, { dryRun: true }).pass, false, '短句 0.02：擋');
  // 用一陣子門檻不變；存檔沒有分數紀錄
  for (let i = 0; i < 20; i += 1) vp.judge(voice(0), 3);
  assert.equal(vp.threshold(), 0.2);
  assert.deepEqual({ threshold: vp.gate().threshold, shortThreshold: vp.gate().shortThreshold }, { threshold: 0.2, shortThreshold: 0.05 });
  assert.deepEqual(Object.keys(vp.state()).sort(), ['enrolled', 'pending', 'recent']);
});

test('前端記樣本：只有參考聲紋換新才算擋法變了，存檔不帶分數紀錄', () => {
  const voice = voices(17);
  let saved = null;
  let saves = 0;
  const store = { load: () => saved, save: (s) => { saved = s; saves += 1; }, clear: () => { saved = null; } };
  const remote = core.createRemoteVoiceprint({ store });
  const turn = (sec = 3) => remote.transcription.onTurn({ type: 'voiceprint.turn', commit_event_id: 'c', pass: true, score: null, seconds: sec, embedding: voice(0) });
  for (let i = 0; i < 4; i += 1) turn();
  assert.equal(remote.enrolled(), true);
  assert.equal(remote.transcription.config().threshold, 0.2);
  const before = saves;
  assert.equal(turn(1), false, '短句不加進最近的聲音：擋法不變、不存檔');
  assert.equal(saves, before);
  assert.equal(turn(3), true, '很確定是你的長句：參考聲紋換新');
  assert.equal(saves, before + 1);
  assert.equal('scores' in saved, false);
});
