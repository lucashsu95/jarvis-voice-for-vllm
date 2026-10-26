// 核心（core/）的測試：不能用 Node 專用的東西（要在 CubeLV、平行沙盒的瀏覽器裡跑）；接頭傳假的進去也要能動。

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as core from '../core/index.mjs';

const coreDir = join(import.meta.dirname, '..', 'core');

test('核心不用 Node 專用的東西：沒有 node: 模組、process、require、檔案', () => {
  for (const name of readdirSync(coreDir).filter((f) => f.endsWith('.mjs'))) {
    const src = readFileSync(join(coreDir, name), 'utf8');
    assert.doesNotMatch(src, /from ['"]node:|import\(['"]node:|\bprocess\.|\brequire\(|readFileSync|writeFileSync/, `${name} 用了 Node 專用的東西`);
    for (const [, spec] of src.matchAll(/from ['"]([^'"]+)['"]/g)) assert.match(spec, /^\.\//, `${name} 只能匯入核心裡的檔案：${spec}`);
  }
});

test('核心的 AI 整理：模型由外面傳 complete 進來', async () => {
  const seen = [];
  const complete = async (req) => { seen.push(req); return '{"mode":"insert","text":"我們明天四點開會。","goal":"","app":"","message":""}'; };
  const r = await core.editSegment({ complete, transcript: '嗯明天三點不對四點開會', context: { app: 'Slack', screen: '…' } });
  assert.equal(r.text, '我們明天四點開會。');
  assert.equal(seen[0].schema, core.SCHEMA);
  assert.match(seen[0].user, /<screen>…<\/screen>/);
  await assert.rejects(core.editSegment({ complete: async () => 'not json', transcript: 'x' }), /格式不對/);
});

test('只有語氣詞才算沒有要寫的字；模型把真的話整理成空的，照原稿寫', async () => {
  for (const t of ['嗯。', '呃，嗯', '啊啊', 'um', 'Uh, umm.', 'hmm…', '', '。']) assert.equal(core.onlyFiller(t), true, t);
  for (const t of ['哈囉，哈囉，哈囉。', 'Hello, hello.', '測試', '好。', '嗯，好。', 'value.', '他媽的', 'umbrella']) assert.equal(core.onlyFiller(t), false, t);
  const empty = async () => '{"mode":"insert","text":"","goal":"","app":"","message":""}';
  const kept = await core.editSegment({ complete: empty, transcript: '哈囉，哈囉，哈囉。' });
  assert.equal(kept.text, '哈囉，哈囉，哈囉。');
  assert.equal(kept.keptRaw, true);
  const filler = await core.editSegment({ complete: empty, transcript: '嗯。' });
  assert.equal(filler.text, '');
  assert.equal(filler.keptRaw, undefined);
});

test('整理規則：只刪贅字和結巴，髒話、刻意重複、招呼和一兩個字的回答照留；只有語氣詞才給空字串', () => {
  const { system } = core.buildPrompt({ transcript: 'x' });
  assert.match(system, /髒話、粗話（例如「幹」「他媽的」「靠」「fuck」）照原樣留著/);
  assert.match(system, /刻意重複的話（例如「哈囉，哈囉，哈囉」「測試，測試」「好好好」）照原樣留著/);
  assert.match(system, /只有整段都是語氣詞（例如「嗯」「呃，嗯」「um」），沒有任何別的字，text 才給空字串/);
  assert.doesNotMatch(system, /聽不出意思的片段/);
});

test('截圖認字：照閱讀順序排（上緣差不到半個字高算同一行）、同一行空白接、行跟行換行、太長留最後面', () => {
  const items = [
    { text: '送出', x: 300, y: 402, w: 40, h: 20 },
    { text: '箱子目標', x: 10, y: 100, w: 80, h: 20 },
    { text: '名稱', x: 10, y: 400, w: 40, h: 20 },
    { text: '  ', x: 0, y: 0, w: 1, h: 1 },
    { text: 'AStockTeam', x: 100, y: 104, w: 90, h: 20 },
  ];
  assert.deepEqual(core.readingOrder(items).map((i) => i.text), ['箱子目標', 'AStockTeam', '名稱', '送出']);
  assert.equal(core.ocrText(items), '箱子目標 AStockTeam\n名稱 送出');
  assert.equal(core.ocrText(items, { maxChars: 7 }), 'm\n名稱 送出');
  // 0–1 的座標（iPhone Vision、Android ML Kit 換算後）也一樣
  const norm = [{ text: '下', x: 0.1, y: 0.5, w: 0.1, h: 0.02 }, { text: '上', x: 0.5, y: 0.1, w: 0.1, h: 0.02 }];
  assert.equal(core.ocrText(norm), '上\n下');
});

test('畫面上下文合併：每段都留著，太長從最長那段前面砍到總長以內', () => {
  assert.equal(core.joinScreen(['箱子目標：上架', '', null, '畫面：送出']), '箱子目標：上架\n畫面：送出');
  const joined = core.joinScreen(['目標'.repeat(10), '畫'.repeat(100)], { maxChars: 50 });
  assert.equal(joined.length, 50);
  assert.ok(joined.startsWith('目標'.repeat(10)));
  assert.ok(joined.endsWith('畫'.repeat(29)));
  assert.equal(core.joinScreen(['a'.repeat(30), 'b'.repeat(30)], { maxChars: 21 }), `${'a'.repeat(10)}\n${'b'.repeat(10)}`);
});

test('斷句：有聲音但不到 180 ms 的不算一句，記下次數給 log 用', () => {
  const d = new core.AudioTurnDetector();
  const loud = new Int16Array(2400).fill(8000);
  const quiet = new Int16Array(2400);
  d.push(loud, 0);
  d.push(quiet, 100);
  assert.equal(d.shortBlips, 1);
  assert.equal(d.speaking, false);
  d.push(loud, 200);
  d.push(loud, 300);
  assert.equal(d.speaking, true);
  assert.equal(d.shortBlips, 1);
});

test('核心的決策器：有 Jev 用 Jev；Jev 拿不準時改問 AI；都沒有就說做不了', async () => {
  const jev = async () => ({ intent: { choice: 'command', confidence: 0.9 } });
  const complete = async () => '{"answers":{"intent":{"choice":"dictation","confidence":0.8},"bad":{"choice":"zzz"}}}';
  const both = core.createDecider(() => ({ jev, complete }));
  assert.equal(both.engine(), 'Jev');
  assert.equal((await both.decide({}, { intent: core.intentQuestion() })).intent.choice, 'command');
  assert.equal(both.canEscalate(), true);
  assert.equal((await both.escalate({}, { intent: core.intentQuestion() })).intent.choice, 'dictation');
  const onlyAi = core.createDecider(() => ({ complete }));
  assert.equal(onlyAi.engine(), 'AI');
  assert.equal(onlyAi.canEscalate(), false);
  await assert.rejects(core.createDecider(() => ({})).decide({}, { intent: core.intentQuestion() }), /做不了決策/);
});

test('核心的操作代理：App 只給讀畫面、動手，結構樹與每一步都在核心', async () => {
  let step = 0;
  const acts = [];
  const screen = core.createAgentScreen({
    tools: core.standardTools(['click']),
    read: () => [{ depth: 0, kind: 'control', role: '按鈕', name: step ? '通知' : '設定', target: step ? 2 : 1 }],
    act: (call, target) => { acts.push(target); step += 1; return { ok: true }; },
    settle: async () => {},
  });
  const replies = [{ tool: 'click', args: { ref: 'e1' }, why: '進設定' }, { tool: 'done', args: { summary: '設定' }, why: '到了' }];
  const r = await core.runAgent({ screen, complete: async () => JSON.stringify(replies.shift()), goal: '打開設定' });
  assert.equal(r.ok, true);
  assert.deepEqual(acts, [1]);
});

test('核心的詞彙自動更新：存放接頭傳記憶體版也能用', () => {
  let vocab = 'CubeLV\n';
  let state = null;
  const store = { loadState: () => state, saveState: (s) => { state = JSON.parse(JSON.stringify(s)); }, readVocab: () => vocab, writeVocab: (t) => { vocab = t; } };
  const v = core.createVocabAuto({ store, settings: () => ({ complete: null }) });
  assert.equal(v.promote('JarvisVoice', 'edit'), true);
  assert.match(vocab, new RegExp(`${core.AUTO_HEADER.replace(/[()（）]/g, '.')}\\nJarvisVoice\\n$`));
  assert.ok(state.terms.JarvisVoice);
});

test('同步腳本：複製核心並在每個檔案寫上來源 commit；核心已經拿掉的同步檔一起刪，別人的檔案不動', async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, readFileSync: read, readdirSync: list, writeFileSync: write } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dest = mkdtempSync(join(tmpdir(), 'jarvis-core-'));
  write(join(dest, 'commander.mjs'), '// 從 jarvis-voice core@abc1234 同步（舊的）\nexport {};\n');
  write(join(dest, 'mine.mjs'), 'export const mine = 1;\n');
  try {
    execFileSync(join(import.meta.dirname, '..', 'scripts', 'sync-core.sh'), [dest], { stdio: 'pipe' });
  } catch (err) {
    // core/ 還有沒 commit 的改動時腳本會拒絕：開發中略過
    if (String(err.stderr).includes('還沒 commit')) return;
    throw err;
  }
  const sha = read(join(dest, 'CORE_COMMIT'), 'utf8').trim();
  assert.ok(list(dest).includes('index.mjs'));
  assert.ok(!list(dest).includes('commander.mjs'), '核心已經沒有的同步檔要刪');
  assert.ok(list(dest).includes('mine.mjs'), '不是同步過去的檔案不動');
  assert.match(read(join(dest, 'editor.mjs'), 'utf8'), new RegExp(`^// 從 jarvis-voice core@${sha} 同步`));
  const synced = await import(join(dest, 'index.mjs'));
  assert.equal(typeof synced.editSegment, 'function');
});

test('聲紋：先錄 10 秒樣本（混進來的別人剔除）；之後像的放行、不像的擋；短句另外用短句的門檻；很確定的句子加進最近的聲音', () => {
  // 假的聲紋：使用者在 x 軸附近，別人在 y 軸附近（8 維，加一點雜訊）
  let seed = 7;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
  const voice = (axis) => core.normalize(Array.from({ length: 8 }, (_, i) => (i === axis ? 1 : 0) + rand() * 0.2));
  const vp = core.createVoiceprint();
  assert.equal(vp.enrolled(), false);
  assert.equal('needSeconds' in vp, false, '聲紋在背景學：核心不給還要講幾秒');
  // 錄樣本：收滿 10 秒（自己 3 句、中間混一句別人）
  assert.equal(vp.judge(voice(0), 3).verdict, 'enrolling');
  assert.equal(vp.judge(voice(1), 3).verdict, 'enrolling');
  assert.equal(vp.judge(voice(0), 3).verdict, 'enrolling');
  const done = vp.judge(voice(0), 3);
  assert.equal(done.verdict, 'enrolled');
  assert.equal(done.kept, 3, '別人那句不算進樣本');
  const mine = vp.judge(voice(0), 3);
  assert.equal(mine.pass, true);
  assert.equal(mine.verdict, 'mine');
  const other = vp.judge(voice(1), 3);
  assert.equal(other.pass, false);
  assert.ok(other.score < core.VOICEPRINT_THRESHOLD);
  // 短句：像的放行，不像的擋（短句的門檻）
  assert.equal(vp.judge(voice(0), 1).verdict, 'short');
  const shortOther = vp.judge(voice(1), 1);
  assert.equal(shortOther.pass, false);
  assert.ok(shortOther.score < core.VOICEPRINT_SHORT_THRESHOLD);
  // 講到一半停頓時只看不記
  const before = JSON.stringify(vp.state());
  assert.equal(vp.judge(voice(0), 3, { dryRun: true }).verdict, 'mine');
  assert.equal(JSON.stringify(vp.state()), before);
  assert.ok(vp.state().recent.length >= 1, '很確定的句子加進最近的聲音');
  // 存檔再讀回來一樣能判斷
  const again = core.createVoiceprint({ state: JSON.parse(JSON.stringify(vp.state())) });
  assert.equal(again.enrolled(), true);
  assert.equal(again.judge(voice(1), 3).pass, false);
  vp.reset();
  assert.equal(vp.enrolled(), false);
});
