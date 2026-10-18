// 第二、三層的零件測試：AI 整理（三家）、設定、找輸入框、Jev 決策、指令模式、自動學詞、整條管線（音檔 → 轉寫 → 整理）。
// 雲端服務都用本機假伺服器。node --test tests/*.spec.mjs

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const stateDir = mkdtempSync(join(tmpdir(), 'voice-dictation-ai-test-'));
process.env.VOICE_DICTATION_STATE_DIR = stateDir;

const { buildPrompt, parseResult, editSegment } = await import('../bin/editor.mjs');
const { loadConfig, aiKey, styleFor } = await import('../bin/config.mjs');
const { rankTargets } = await import('../bin/targeter.mjs');
const { createDecider, fieldQuestions, stepQuestions } = await import('../bin/decide.mjs');
const { runCommand } = await import('../bin/commander.mjs');
const { extractEdited, replacedChunks } = await import('../bin/learn.mjs');
const { createVocabAuto, splitVocabulary, plausibleTerm, AUTO_HEADER } = await import('../bin/vocab-auto.mjs');
const { wavFromPcm16 } = await import('../bin/engines/batch.mjs');

// 假伺服器：handler(請求 JSON, 第幾次, headers) → { status, body }
async function fakeJson(handler) {
  const calls = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const isJson = (req.headers['content-type'] ?? '').includes('json');
    const call = { headers: req.headers, url: req.url, body: isJson ? JSON.parse(raw.toString()) : null, raw };
    calls.push(call);
    const { status = 200, body } = await handler(call, calls.length);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { calls, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

const chatReply = (obj) => ({ body: { choices: [{ message: { content: JSON.stringify(obj) } }] } });

test('AI 整理的提示：上下文都放進去、游標欄位一定有；開指令模式才有 command 規則', () => {
  const { system, user } = buildPrompt({
    transcript: '嗯明天四點',
    context: { app: 'Slack', bundle: 'com.tinyspeck.slackmacgap', window: 'Jason', url: '', field: { label: '訊息', role: 'AXTextArea', before: '好，', after: '', selected: '' } },
    style: '口語', vocabulary: ['CubeLV', '平行沙盒'],
  });
  assert.match(system, /<vocabulary>\nCubeLV\n平行沙盒\n<\/vocabulary>/);
  assert.doesNotMatch(system, /- command：/);
  assert.match(user, /<app>Slack（com.tinyspeck.slackmacgap）（只是使用者正在打字的地方/);
  assert.match(user, /<field>訊息，AXTextArea<\/field>/);
  assert.match(user, /<before>好，<\/before>/);
  assert.match(user, /<style>口語<\/style>/);
  assert.match(user, /<transcript>嗯明天四點<\/transcript>$/);
  assert.doesNotMatch(user, /<after>/);
  const empty = buildPrompt({ transcript: '打開設定', commands: true });
  assert.match(empty.system, /- command：/);
  assert.match(empty.user, /<field><\/field>/);
});

test('AI 回的 JSON：格式不對、改寫選取卻給空字、沒開指令模式卻回 command，都當沒回；insert 空字＝只有語氣詞不用寫', () => {
  assert.deepEqual(parseResult('{"mode":"insert","text":"好"}'), { mode: 'insert', text: '好' });
  assert.deepEqual(parseResult('前言 {"mode":"delete_last","text":"x"} 後記'), { mode: 'delete_last', text: '' });
  assert.deepEqual(parseResult('{"mode":"insert","text":""}'), { mode: 'insert', text: '' });
  assert.equal(parseResult('{"mode":"replace_selection","text":" "}'), null);
  assert.equal(parseResult('{"mode":"answer","text":"2"}'), null);
  assert.equal(parseResult('不是 JSON'), null);
  const command = '{"mode":"command","text":"台積電","goal":"打開台積電個股頁","app":""}';
  assert.equal(parseResult(command), null);
  assert.deepEqual(parseResult(command, { commands: true }), { mode: 'command', text: '台積電', goal: '打開台積電個股頁', app: '', message: '' });
  assert.equal(parseResult('{"mode":"command","text":"","goal":" ","app":""}', { commands: true }), null);
});

test('三家 AI：OpenAI 用 json_schema 並關推理、DeepSeek 關 thinking 用 json_object、Claude 關 thinking', async () => {
  const server = await fakeJson((call) => {
    if (call.url.includes('messages')) return { body: { content: [{ type: 'text', text: '{"mode":"insert","text":"Claude 版"}' }] } };
    return chatReply({ mode: 'insert', text: call.body.model.startsWith('deepseek') ? 'DeepSeek 版' : 'OpenAI 版', goal: '', app: '' });
  });
  process.env.VOICE_DICTATION_OPENAI_CHAT_URL = `${server.url}/openai`;
  process.env.VOICE_DICTATION_DEEPSEEK_URL = `${server.url}/deepseek`;
  process.env.VOICE_DICTATION_ANTHROPIC_URL = `${server.url}/messages`;
  try {
    const input = { transcript: '嗯好', context: {}, vocabulary: [] };
    const openai = await editSegment({ provider: 'openai', apiKey: 'sk-o', ...input });
    const deepseek = await editSegment({ provider: 'deepseek', apiKey: 'sk-d', ...input });
    const claude = await editSegment({ provider: 'claude', apiKey: 'sk-c', ...input });
    assert.deepEqual([openai.text, deepseek.text, claude.text], ['OpenAI 版', 'DeepSeek 版', 'Claude 版']);
    const [o, d, c] = server.calls;
    assert.equal(o.headers.authorization, 'Bearer sk-o');
    assert.equal(o.body.model, 'gpt-6-luna');
    assert.equal(o.body.reasoning_effort, 'none');
    assert.equal(o.body.response_format.type, 'json_schema');
    assert.equal(d.headers.authorization, 'Bearer sk-d');
    assert.equal(d.body.model, 'deepseek-flash');
    assert.deepEqual(d.body.thinking, { type: 'disabled' });
    assert.equal(d.body.response_format.type, 'json_object');
    assert.equal(c.headers['x-api-key'], 'sk-c');
    assert.equal(c.body.model, 'claude-haiku-5-5');
    assert.deepEqual(c.body.thinking, { type: 'disabled' });
    await assert.rejects(editSegment({ provider: 'deepseek', apiKey: '', ...input }), /沒有 DeepSeek API key/);
  } finally {
    server.close();
  }
});

test('設定：AI 各家的 key 從 keys／keyFiles／keyCommands／環境變數拿，OpenAI 沿用轉寫的 key；語氣網域優先', () => {
  writeFileSync(join(stateDir, 'ds.env'), 'export DEEPSEEK_API_KEY=sk-ds\n');
  writeFileSync(join(stateDir, 'jev.txt'), 'ts-key\n');
  writeFileSync(join(stateDir, 'config.json'), JSON.stringify({
    engine: 'openai', openai: { apiKey: 'sk-openai' },
    ai: { enabled: true, keyFiles: { deepseek: join(stateDir, 'ds.env') }, keys: { claude: 'sk-claude' }, styles: { 'com.example': '自訂' } },
    jev: { apiKeyFile: join(stateDir, 'jev.txt') },
  }));
  const { config, error } = loadConfig();
  assert.equal(error, '');
  assert.equal(config.ai.provider, 'deepseek');
  assert.equal(aiKey(config), 'sk-ds');
  assert.equal(aiKey(config, 'claude'), 'sk-claude');
  assert.equal(aiKey(config, 'openai'), 'sk-openai');
  assert.equal(config.jev.apiKey, 'ts-key');
  assert.equal(config.ai.enabled, true); // 三層預設都開
  assert.equal(config.autoFocus, true);
  assert.equal(config.commands, true);
  assert.match(styleFor(config, 'com.google.Chrome', 'https://mail.google.com/mail/u/0'), /email/);
  assert.match(styleFor(config, 'com.tinyspeck.slackmacgap', ''), /聊天/);
  assert.equal(styleFor(config, 'com.example', ''), '自訂');
  assert.equal(styleFor(config, 'com.unknown', 'not a url'), '');
  writeFileSync(join(stateDir, 'config.json'), JSON.stringify({
    ai: { keyCommands: { claude: 'echo sk-from-command' } }, jev: { apiKeyCommand: 'printf ts-cmd' },
  }));
  const viaCommand = loadConfig().config;
  assert.equal(aiKey(viaCommand, 'claude'), 'sk-from-command');
  assert.equal(viaCommand.jev.apiKey, 'ts-cmd');
  writeFileSync(join(stateDir, 'config.json'), JSON.stringify({ engine: 'openai', openai: { apiKey: 'sk-only-openai' } }));
  const onlyOpenai = loadConfig().config;
  assert.equal(onlyOpenai.ai.provider, 'openai'); // 沒指定就用已經有 key 的那家
  writeFileSync(join(stateDir, 'config.json'), JSON.stringify({ ai: { provider: 'gemini' } }));
  assert.match(loadConfig().error, /ai.provider 只能是/);
});

const testWindow = { x: 200, y: 330, w: 560, h: 452, title: '測試' };
const field = (label, role, y, extra = {}) => ({ handle: y, role, subrole: '', label, x: 219, y, w: 522, h: role === 'AXTextArea' ? 250 : 28, enabled: true, ...extra });

test('找輸入框（沒有決策器時的規則）：所有輸入框都能選；上次寫的優先；只有一個就用；一定挑一個', () => {
  const search = field('搜尋', 'AXTextField', 385, { subrole: 'AXSearchField' });
  const subject = field('主旨', 'AXTextField', 425);
  const secret = field('密碼', 'AXTextField', 465, { subrole: 'AXSecureTextField' });
  const body = field('訊息', 'AXTextArea', 512);
  const all = [search, subject, secret, body];
  const ranked = rankTargets({ candidates: all, window: testWindow });
  assert.equal(ranked.choice.label, '訊息');
  assert.equal(ranked.list.length, 4); // 搜尋框、密碼框也在候選裡，交給決策器挑
  const again = rankTargets({ candidates: all, window: testWindow, remembered: { role: 'AXTextField', label: '主旨' } });
  assert.equal(again.choice.label, '主旨');
  assert.equal(again.sure, true);
  assert.equal(rankTargets({ candidates: [search], window: testWindow }).choice.label, '搜尋');
  const twins = rankTargets({ candidates: [field('A', 'AXTextField', 400), field('B', 'AXTextField', 410)], window: testWindow });
  assert.ok(twins.choice, '分不出高下也要挑一個');
  assert.equal(rankTargets({ candidates: [], window: testWindow }).choice, null);
  assert.equal(rankTargets({ candidates: [{ ...body, enabled: false }, { ...subject, w: 0 }] }).choice, null); // 停用的、看不到的寫不進去
});

test('決策器：有 Jev key 打 /v1/systemone；沒有就把同樣的問題交給 AI，答案不在選項裡的丟掉', async () => {
  const server = await fakeJson((call) => {
    if (call.url.includes('systemone')) {
      return { body: { model: 'jev-1.13.0', answers: { target: { type: 'choice', choice: 'e1', confidence: 0.8, probabilities: { e0: 0.2, e1: 0.8 } } } } };
    }
    return chatReply({ answers: { target: { choice: 'e9', confidence: 0.9 }, extra: { noul: 0.7 } } });
  });
  process.env.VOICE_DICTATION_JEV_URL = `${server.url}/v1/systemone`;
  process.env.VOICE_DICTATION_OPENAI_CHAT_URL = `${server.url}/openai`;
  try {
    const questions = fieldQuestions([field('主旨', 'AXTextField', 425), field('訊息', 'AXTextArea', 512)], testWindow);
    assert.deepEqual(Object.keys(questions.target.criteria), ['e0', 'e1']);
    assert.match(questions.target.criteria.e1, /多行輸入框「訊息」（下中）/);
    const jev = createDecider(() => ({ jevKey: 'ts-1', jevModel: 'jev-latest', ai: { provider: 'openai', apiKey: 'sk' } }));
    assert.equal(jev.engine(), 'Jev');
    const a = await jev.decide({ transcript: '改到四點' }, questions);
    assert.equal(a.target.choice, 'e1');
    const sent = server.calls[0];
    assert.equal(sent.headers.authorization, 'Bearer ts-1');
    assert.equal(sent.body.model, 'jev-latest');
    assert.equal(sent.body.questions.target.type, 'choice');
    assert.deepEqual(Object.keys(sent.body.questions), ['target']);
    assert.deepEqual(sent.body.state, { transcript: '改到四點' });
    const llm = createDecider(() => ({ jevKey: '', ai: { provider: 'openai', apiKey: 'sk' } }));
    assert.equal(llm.engine(), 'AI');
    const b = await llm.decide({ transcript: '改到四點' }, questions);
    assert.equal(b.target, undefined); // e9 不在選項裡
    await assert.rejects(createDecider(() => ({ jevKey: '', ai: null })).decide({}, questions), /做不了決策/);
  } finally {
    server.close();
  }
});

// 假的 AX 小幫手：記下做過的動作，畫面照步驟換
function fakeAx(screens) {
  const acts = [];
  let step = 0;
  return {
    acts,
    async call(op, args) {
      // 每做一步畫面就變（標題帶步數），不會被「做了畫面沒變就停」擋下
      if (op === 'elements') { const sc = screens[Math.min(step, screens.length - 1)]; return { ...sc, window: { ...sc.window, title: `${sc.window?.title ?? ''}#${step}` } }; }
      if (op === 'act') { acts.push(args); step += 1; return { result: 'ok' }; }
      throw new Error(op);
    },
  };
}

const el = (handle, role, label, y = 100) => ({ handle, role, subrole: '', label, x: 10, y, w: 100, h: 20, focused: false });

test('指令模式：搜尋框填字 → Enter → 點結果 → 完成；畫面上的東西全部都是選項', async () => {
  const win = { x: 0, y: 0, w: 1000, h: 800, title: '自選股' };
  const screens = [
    { window: win, elements: [el(1, 'AXButton', '刪除自選'), el(2, 'AXTextField', '搜尋股票', 20), el(3, 'AXLink', '大盤')] },
    { window: win, elements: [el(2, 'AXTextField', '搜尋股票', 20)] },
    { window: { ...win, title: '搜尋結果' }, elements: [el(4, 'AXLink', '台積電 2330'), el(5, 'AXLink', '台積電 ADR')] },
    { window: { ...win, title: '台積電 2330' }, elements: [el(6, 'AXLink', '技術分析')] },
  ];
  const ax = fakeAx(screens);
  const plan = [
    { action: 'fill', target: '搜尋股票' },
    { action: 'enter' },
    { action: 'click', target: '台積電 2330' },
    { action: 'done' },
  ];
  const seenOptions = [];
  const decider = {
    engine: () => 'Jev',
    async decide(state, questions) {
      seenOptions.push(Object.values(questions.target.criteria).join('|'));
      const next = plan[state.done_steps.length];
      const entry = Object.entries(questions.target.criteria).find(([, d]) => next.target && d.includes(next.target));
      return {
        action: { choice: next.action, confidence: 0.9 },
        target: entry ? { choice: entry[0], confidence: 0.8 } : { choice: 'e0', confidence: 0.1 },
      };
    },
  };
  const logs = [];
  const result = await runCommand({
    ax, decider, log: (m) => logs.push(m), frontApp: async () => ({ pid: 42, bundle: 'x' }), openApp: async () => true,
    goal: '打開台積電（2330）的個股頁', text: '台積電', context: { app: 'AStock' },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(ax.acts.map((a) => [a.action, a.handle, a.text ?? '']), [['fill', 2, '台積電'], ['enter', 2, '台積電'], ['press', 4, '']]);
  assert.equal(result.steps.length, 3);
  assert.ok(seenOptions[0].includes('刪除自選'), '畫面上的按鈕都要給決策器看');
});

test('指令模式：信心太低（動作 < 0.3、對象 < 0.25）就停、按了暫停就停、要切 app 找不到就說', async () => {
  const ax = fakeAx([{ window: { title: 'x' }, elements: [el(1, 'AXButton', '設定')] }]);
  const unsure = { engine: () => 'Jev', decide: async () => ({ action: { choice: 'click', confidence: 0.2 }, target: { choice: 'e0', confidence: 0.9 } }) };
  const base = { ax, log: () => {}, frontApp: async () => ({ pid: 1 }), goal: '打開設定', context: { app: 'Slack' } };
  const r = await runCommand({ ...base, decider: unsure, openApp: async () => true });
  assert.equal(r.ok, false);
  assert.match(r.reason, /不確定下一步/);
  assert.equal(ax.acts.length, 0);
  const vague = { engine: () => 'Jev', decide: async () => ({ action: { choice: 'click', confidence: 0.35 }, target: { choice: 'e0', confidence: 0.2 } }) };
  assert.match((await runCommand({ ...base, decider: vague, openApp: async () => true })).reason, /不確定要點哪一個/);
  const sure = { engine: () => 'Jev', decide: async () => ({ action: { choice: 'click', confidence: 0.35 }, target: { choice: 'e0', confidence: 0.3 } }) };
  const paused = await runCommand({ ...base, decider: sure, openApp: async () => true, stopped: () => ax.acts.length >= 2 });
  assert.match(paused.reason, /按了暫停/);
  assert.equal(ax.acts.length, 2); // 門檻以上照做，按暫停才停
  const missing = await runCommand({ ...base, decider: unsure, openApp: async () => false, app: '不存在的 App' });
  assert.match(missing.reason, /找不到 app/);
});

test('自動學詞：找出使用者改過的那段、只算換掉的字', () => {
  assert.equal(extractEdited('好，幫我把平行沙盒開起來。謝謝', '好，', '謝謝'), '幫我把平行沙盒開起來。');
  assert.equal(extractEdited('全部換掉了', '好，', ''), null);
  assert.deepEqual(replacedChunks('幫我把平行沙和開起來', '幫我把平行沙盒開起來'), [{ from: '和', to: '盒' }]);
  assert.deepEqual(replacedChunks('部署到 cube LV', '部署到 CubeLV'), [{ from: 'c', to: 'C' }]); // 刪掉的空白不算
  assert.deepEqual(replacedChunks('好', '好啊我晚點看'), []); // 只是多打字
});

function vocabFixture(manual, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'voice-dictation-vocab-'));
  const file = join(dir, 'vocabulary.txt');
  writeFileSync(file, manual);
  const logs = [];
  const vocab = createVocabAuto({
    log: (m) => logs.push(m), storeFile: join(dir, 'vocabulary-auto.json'),
    settings: () => ({ vocabularyFile: file, ai: null, ...opts }),
  });
  return { file, vocab, logs, read: () => readFileSync(file, 'utf8') };
}

test('詞彙表自動更新：加在最後的自動區、你自己寫的不動、已經有的不重複、網址路徑不收', () => {
  const { vocab, read } = vocabFixture('# 產品\nCubeLV\n平行沙盒  # 中文名\n');
  assert.equal(vocab.promote('JarvisVoice', 'edit'), true);
  assert.equal(vocab.promote('jarvisvoice', 'screen'), false);
  assert.equal(vocab.promote('cubelv', 'edit'), false); // 你自己寫過
  assert.equal(vocab.promote('https://jarvis-voice.com', 'edit'), false);
  assert.equal(vocab.promote('~/jarvis-voice/bin', 'edit'), false);
  assert.equal(read(), `# 產品\nCubeLV\n平行沙盒  # 中文名\n\n${AUTO_HEADER}\nJarvisVoice\n`);
  assert.deepEqual(splitVocabulary(read()), { manualText: '# 產品\nCubeLV\n平行沙盒  # 中文名', manual: ['CubeLV', '平行沙盒'], auto: ['JarvisVoice'] });
  assert.equal(plausibleTerm('Route 53'), true);
  assert.equal(plausibleTerm('2330'), false);
});

test('詞彙表自動更新：畫面上的詞要 3 次不同時候（相隔 10 分鐘）都看到才加；講到了就直接加', () => {
  const { vocab, read } = vocabFixture('CubeLV\n');
  const t0 = Date.parse('2026-10-18T10:00:00Z');
  vocab.observe(['DeepSeek', 'TypeSafe'], t0);
  vocab.observe(['DeepSeek'], t0 + 60_000); // 同一次（不到 10 分鐘）不算
  vocab.observe(['DeepSeek'], t0 + 11 * 60_000);
  assert.doesNotMatch(read(), /DeepSeek/);
  vocab.observe(['DeepSeek'], t0 + 22 * 60_000);
  assert.match(read(), /DeepSeek/);
  vocab.promoteHeard('我們用 TypeSafe 的 Jev 做決策', t0 + 23 * 60_000);
  assert.match(read(), /TypeSafe/);
});

test('詞彙表自動更新：有上限，滿了先拿掉最少用到、最久沒用的自動詞；你自己寫的滿了就不加', () => {
  const now = Date.parse('2026-10-18T10:00:00Z');
  const day = 86_400_000;
  const { vocab, read, logs } = vocabFixture('A1\nB1\n', { max: 10, maxAuto: 2 });
  vocab.promote('OldScreen', 'screen', now - 20 * day);
  vocab.promote('UsedOne', 'screen', now - 20 * day);
  vocab.noteHits('今天又講到 UsedOne', now - day);
  assert.equal(vocab.promote('NewWord', 'heard', now), true);
  assert.doesNotMatch(read(), /OldScreen/); // 最少用到、最久沒用的被拿掉
  assert.match(read(), /UsedOne/);
  assert.match(read(), /NewWord/);
  assert.equal(vocab.promote('Weak', 'screen', now), false); // 新的分數不夠高就不換
  assert.ok(logs.some((l) => l.includes('不夠優先')));
  const full = vocabFixture('A\nB\nC\n', { max: 3 });
  assert.equal(full.vocab.promote('Extra', 'edit', now), false);
  assert.ok(full.logs.some((l) => l.includes('詞彙表滿了')));
});

test('詞彙表自動更新：寫完一段後從畫面挑詞（兩分鐘最多一次、畫面沒變不挑）', async () => {
  const server = await fakeJson(() => chatReply({ terms: ['JarvisVoice', 'https://x.com', 'DeepSeek'] }));
  process.env.VOICE_DICTATION_OPENAI_CHAT_URL = `${server.url}/chat`;
  try {
    const { vocab, read } = vocabFixture('CubeLV\n', { ai: { provider: 'openai', apiKey: 'sk' } });
    const t0 = Date.parse('2026-10-18T10:00:00Z');
    await vocab.afterSegment({ screen: '我們在討論 JarvisVoice 和 DeepSeek', text: '這樣用 JarvisVoice 一個月多少錢' }, t0);
    assert.equal(server.calls.length, 1);
    assert.match(read(), /JarvisVoice/); // 剛挑出來、這段又講到 → 直接加
    assert.doesNotMatch(read(), /DeepSeek/); // 只在畫面上，還是候選
    await vocab.afterSegment({ screen: '畫面換了', text: '' }, t0 + 30_000);
    assert.equal(server.calls.length, 1); // 不到兩分鐘不挑
    await vocab.afterSegment({ screen: '畫面換了', text: '' }, t0 + 3 * 60_000);
    assert.equal(server.calls.length, 2);
    await vocab.afterSegment({ screen: '畫面換了', text: '' }, t0 + 6 * 60_000);
    assert.equal(server.calls.length, 2); // 畫面沒變不挑
  } finally {
    server.close();
  }
});

test('AI 整理的提示帶上畫面上的字', () => {
  const { user, system } = buildPrompt({ transcript: '我這樣用 JavaScript 一個月多少錢', context: { screen: '…JarvisVoice 一個月約 US$9…' } });
  assert.match(user, /<screen>…JarvisVoice 一個月約 US\$9…<\/screen>/);
  assert.match(system, /<screen> 是使用者畫面上現在看得到的字/);
});

// 測試音檔：嗶一聲 1 秒、停 1 秒、再嗶 1 秒、停 2.5 秒（兩句、同一段）
function toneWav(path) {
  const rate = 24000;
  const parts = [[1, true], [1, false], [1, true], [2.5, false]];
  const pcm = Buffer.concat(parts.map(([sec, on]) => {
    const b = Buffer.alloc(Math.round(rate * sec) * 2);
    if (on) for (let i = 0; i < b.length / 2; i += 1) b.writeInt16LE(Math.round(Math.sin((i / rate) * 2 * Math.PI * 440) * 9000), i * 2);
    return b;
  }));
  writeFileSync(path, wavFromPcm16(pcm, rate));
}

async function runListener(dir, config, env) {
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  const wav = join(dir, 'tone.wav');
  toneWav(wav);
  const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'bin', 'listen.mjs'), '--file', wav, '--dry-paste'], {
    env: { ...process.env, VOICE_DICTATION_STATE_DIR: dir, ...env },
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', () => {});
  await new Promise((r) => child.on('close', r));
  return out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const transcribeServer = () => fakeJson((call, n) => ({ body: { text: n === 1 ? '嗯第一句。' : '第二句。' } }));

test('整條管線：AI 整理開著時，兩句合成一段，貼 AI 整理後的字；中間停頓時提早整理的那次作廢；講完 1.2 秒就貼', { timeout: 30_000 }, async () => {
  const stt = await transcribeServer();
  const chat = await fakeJson(() => chatReply({ mode: 'insert', text: '第一句，第二句。', goal: '', app: '' }));
  try {
    const dir = mkdtempSync(join(tmpdir(), 'voice-dictation-pipe-'));
    const events = await runListener(dir, {
      engine: 'openai', openai: { apiKey: 'sk-test' }, ai: { enabled: true, provider: 'openai', segmentPauseMs: 1500 }, speed: { hedge: 1 },
    }, { VOICE_DICTATION_OPENAI_HTTP_URL: `${stt.url}/v1/audio/transcriptions`, VOICE_DICTATION_OPENAI_CHAT_URL: `${chat.url}/chat` });
    const pasted = events.filter((e) => e.type === 'pasted');
    assert.equal(stt.calls.length, 2); // 停 0.4 秒先送的那份就是這句的結果，不重送
    assert.equal(chat.calls.length, 2); // 第一句一回來就先整理，第二句開口就作廢
    assert.match(chat.calls[0].body.messages[1].content, /<transcript>嗯第一句。<\/transcript>/);
    assert.match(chat.calls[1].body.messages[1].content, /<transcript>嗯第一句。第二句。<\/transcript>/);
    assert.deepEqual(pasted.map((e) => [e.text, e.raw]), [['第一句，第二句。', '嗯第一句。第二句。']]);
    assert.equal(readFileSync(join(dir, 'last.txt'), 'utf8'), '第一句，第二句。');
    assert.equal(pasted[0].timing.earlyTranscribe, true);
    assert.equal(pasted[0].timing.earlyPolish, true);
    assert.ok(pasted[0].latencyMs >= 1200 && pasted[0].latencyMs < 1500, `停 1.2 秒就貼，不等 segmentPauseMs：${pasted[0].latencyMs} ms`);
  } finally {
    stt.close();
    chat.close();
  }
});

test('整條管線：提早轉寫、提早整理都關掉時照原本，停滿 segmentPauseMs 才整理、只問一次 AI', { timeout: 30_000 }, async () => {
  const stt = await transcribeServer();
  const chat = await fakeJson(() => chatReply({ mode: 'insert', text: '第一句，第二句。', goal: '', app: '' }));
  try {
    const events = await runListener(mkdtempSync(join(tmpdir(), 'voice-dictation-pipe-')), {
      engine: 'openai', openai: { apiKey: 'sk-test' }, ai: { enabled: true, provider: 'openai', segmentPauseMs: 1500 },
      speed: { hedge: 1, earlyTranscribeMs: 0, pasteAfterMs: 0 },
    }, { VOICE_DICTATION_OPENAI_HTTP_URL: `${stt.url}/v1/audio/transcriptions`, VOICE_DICTATION_OPENAI_CHAT_URL: `${chat.url}/chat` });
    const pasted = events.filter((e) => e.type === 'pasted');
    assert.equal(stt.calls.length, 2);
    assert.equal(chat.calls.length, 1);
    assert.deepEqual(pasted.map((e) => e.text), ['第一句，第二句。']);
    assert.equal(pasted[0].timing.earlyTranscribe, false);
    assert.equal(pasted[0].timing.earlyPolish, false);
    assert.ok(pasted[0].latencyMs >= 1500, `停滿 1.5 秒才整理：${pasted[0].latencyMs} ms`);
  } finally {
    stt.close();
    chat.close();
  }
});

test('整條管線：AI 失敗改貼原稿；AI 整理關著時一句一句貼', { timeout: 40_000 }, async () => {
  const chat = await fakeJson(() => ({ status: 500, body: { error: { message: 'boom' } } }));
  const run = async (config) => {
    const stt = await transcribeServer();
    try {
      return await runListener(mkdtempSync(join(tmpdir(), 'voice-dictation-pipe-')), config, {
        VOICE_DICTATION_OPENAI_HTTP_URL: `${stt.url}/v1/audio/transcriptions`, VOICE_DICTATION_OPENAI_CHAT_URL: `${chat.url}/chat`,
      });
    } finally {
      stt.close();
    }
  };
  try {
    const failed = await run({ engine: 'openai', openai: { apiKey: 'sk-test' }, ai: { enabled: true, provider: 'openai', segmentPauseMs: 1500 }, speed: { hedge: 1 } });
    assert.deepEqual(failed.filter((e) => e.type === 'pasted').map((e) => e.text), ['嗯第一句。第二句。']);
    const off = await run({ engine: 'openai', openai: { apiKey: 'sk-test' }, ai: { enabled: false }, speed: { hedge: 1 } });
    assert.deepEqual(off.filter((e) => e.type === 'pasted').map((e) => e.text), ['嗯第一句。', '第二句。']);
    assert.equal(chat.calls.length, 2);
  } finally {
    chat.close();
  }
});

test('選單列：說話中每 0.1 秒送音量；停下後辨識中（working）一直到寫完才結束（idle）', { timeout: 30_000 }, async () => {
  const stt = await transcribeServer();
  const chat = await fakeJson(() => chatReply({ mode: 'insert', text: '第一句，第二句。', goal: '', app: '' }));
  try {
    const events = await runListener(mkdtempSync(join(tmpdir(), 'voice-dictation-pipe-')), {
      engine: 'openai', openai: { apiKey: 'sk-test' }, ai: { enabled: true, provider: 'openai', segmentPauseMs: 1500 },
    }, { VOICE_DICTATION_OPENAI_HTTP_URL: `${stt.url}/v1/audio/transcriptions`, VOICE_DICTATION_OPENAI_CHAT_URL: `${chat.url}/chat`, VOICE_DICTATION_HUD: '1' });
    const hud = events.filter((e) => e.type === 'hud').map((e) => e.line);
    const levels = hud.filter((l) => l.startsWith('level:')).map((l) => Number(l.slice(6)));
    assert.ok(levels.length >= 10, `說話中要一直送音量：${levels.length} 次`);
    assert.ok(levels.every((v) => v >= 0 && v <= 1));
    assert.ok(Math.max(...levels) > 0.8, `嗶聲時音量偏高：${Math.max(...levels)}`);
    assert.ok(levels.some((v) => v < 0.2), '嗶聲後還沒切句的停頓，音量掉下來（聲波降回最矮）');
    const working = hud.indexOf('working');
    const idle = hud.lastIndexOf('idle');
    assert.ok(working > hud.indexOf('hearing'), '先聽到才進辨識中');
    assert.ok(idle > working, `辨識中要結束：${hud.filter((l) => !l.startsWith('level:')).join(' → ')}`);
    const pastedAt = events.findIndex((e) => e.type === 'pasted');
    assert.ok(pastedAt >= 0 && events.findIndex((e) => e.type === 'hud' && e.line === 'idle' && events.indexOf(e) > pastedAt) > pastedAt, '寫完才結束辨識中');
  } finally {
    stt.close();
    chat.close();
  }
});

test('整條管線：開了指令模式，AI 說是指令就走指令（測試模式只回報不操作）', { timeout: 30_000 }, async () => {
  const stt = await transcribeServer();
  const chat = await fakeJson(() => chatReply({ mode: 'command', text: '台積電', goal: '打開台積電（2330）的個股頁', app: '' }));
  try {
    const events = await runListener(mkdtempSync(join(tmpdir(), 'voice-dictation-pipe-')), {
      engine: 'openai', openai: { apiKey: 'sk-test' }, ai: { enabled: true, provider: 'openai', segmentPauseMs: 1500 }, commands: true,
    }, { VOICE_DICTATION_OPENAI_HTTP_URL: `${stt.url}/v1/audio/transcriptions`, VOICE_DICTATION_OPENAI_CHAT_URL: `${chat.url}/chat` });
    assert.deepEqual(events.filter((e) => e.type === 'command').map((e) => [e.goal, e.text]), [['打開台積電（2330）的個股頁', '台積電']]);
    assert.equal(events.filter((e) => e.type === 'pasted').length, 0);
    assert.match(chat.calls[0].body.messages[0].content, /- command：/);
  } finally {
    stt.close();
    chat.close();
  }
});

test('傳訊息給某人：填名字 → 點搜尋框下第一個含名字的結果 → 確認對話對象才寫 → 不送出；不對就停、不試下一個', async () => {
  const win = { x: 0, y: 0, w: 1000, h: 800, title: 'LINE' };
  const field = (value) => ({ handle: 2, role: 'AXTextField', subrole: '', label: '', value, x: 40, y: 50, w: 260, h: 30, focused: true });
  const box = { handle: 3, role: 'AXTextArea', subrole: '', label: '', value: '', x: 340, y: 700, w: 600, h: 70, focused: false };
  const ocr = (label, y) => ({ handle: 0, role: 'OCRText', subrole: '', label, value: '', x: 60, y, w: 80, h: 20, focused: false, ocr: true });
  const header = (label) => ({ ...ocr(label, 20), x: 400 });
  const run = async (answers) => {
    let screen = 0;
    const screens = [
      { window: win, elements: [field(''), box, header('微波烤箱廢物食堂')] },
      { window: win, elements: [field('BU'), box, header('微波烤箱廢物食堂'), ocr('bubu', 180), ocr('Bubu科技有限公司', 300)] },
      { window: win, elements: [field('BU'), box, header('bubu'), ocr('bubu', 180), ocr('Bubu科技有限公司', 300)] },
    ];
    const acts = [];
    const ax = {
      async call(op, args) {
        if (op === 'elements') return screens[Math.min(screen, screens.length - 1)];
        if (op === 'act') { acts.push(args); screen += 1; return { result: 'ok' }; }
        throw new Error(op);
      },
    };
    let checks = 0;
    const decider = { engine: () => 'Jev', canEscalate: () => false, async decide() { checks += 1; return { right: { noul: answers[Math.min(checks - 1, answers.length - 1)] } }; } };
    const result = await runCommand({
      ax, decider, log: () => {}, frontApp: async () => ({ pid: 9 }), openApp: async () => true,
      goal: '打開和 BU 的對話，在訊息框寫好訊息（不送出）', text: 'BU', message: '你好', context: { app: 'LINE' },
    });
    return { result, acts };
  };
  // 一開始是群組（不對）→ 填名字 → 點第一個結果 bubu → 確認是 bubu → 寫
  const ok = await run([0.1, 0.1, 0.9]);
  assert.equal(ok.result.ok, true, ok.result.reason);
  assert.deepEqual(ok.acts.map((a) => [a.action, a.text ?? '', a.y ?? '']), [['fill', 'BU', ''], ['clickAt', '', 190], ['fill', '你好', '']]);
  assert.match(ok.result.steps.at(-1), /寫了「你好」（沒送出）/);
  // 點了第一個結果還是不對：停，不寫、不去點 Bubu科技有限公司
  const wrong = await run([0.1, 0.1, 0.2, 0.2, 0.2, 0.2]);
  assert.equal(wrong.result.ok, false);
  assert.match(wrong.result.reason, /第一個打開的不是和「BU」的對話，沒寫/);
  assert.ok(!wrong.acts.some((a) => a.text === '你好'), '對象不對就不能寫');
  assert.equal(wrong.acts.filter((a) => a.action === 'clickAt').length, 1, '只點第一個結果');
});

test('AI 拆出傳訊息的對象和內容', () => {
  const r = parseResult('{"mode":"command","text":"BU","goal":"打開和 BU 的對話","app":"LINE","message":"你好"}', { commands: true });
  assert.deepEqual(r, { mode: 'command', text: 'BU', goal: '打開和 BU 的對話', app: 'LINE', message: '你好' });
  const { system } = buildPrompt({ transcript: '幫我傳給 BU 說你好', commands: true });
  assert.match(system, /\(c\) 叫電腦幫忙傳訊息給某個人/);
});

test('指令模式的一步：選項是畫面上的元件，帶位置和角色', () => {
  const q = stepQuestions([el(1, 'AXLink', '台積電 2330', 700)], { x: 0, y: 0, w: 1000, h: 800 });
  assert.deepEqual(Object.keys(q.action.criteria), ['click', 'fill', 'enter', 'write', 'done', 'stuck']);
  assert.equal(q.target.criteria.e0, '連結「台積電 2330」（下左）');
});

test('設定檢查 ai-check：照設定檔實際打 AI 和決策器；沒有 key 說缺什麼、結束碼 1', { timeout: 20_000 }, async () => {
  const server = await fakeJson((call) => {
    if (call.body?.messages?.[0]?.content?.includes('決策器')) return chatReply({ answers: { intent: { choice: 'command', confidence: 0.9 } } });
    return chatReply({ mode: 'insert', text: '我們明天四點開會，記得帶筆電。', goal: '', app: '' });
  });
  const run = async (config) => {
    const dir = mkdtempSync(join(tmpdir(), 'voice-dictation-check-'));
    writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
    const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'bin', 'ai-check.mjs')], {
      env: { ...process.env, VOICE_DICTATION_STATE_DIR: dir, VOICE_DICTATION_OPENAI_CHAT_URL: `${server.url}/chat`, OPENAI_API_KEY: '', DEEPSEEK_API_KEY: '', TYPESAFE_API_KEY: '' },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    const code = await new Promise((r) => child.on('close', r));
    return { out, code };
  };
  try {
    const good = await run({ engine: 'openai', openai: { apiKey: 'sk-test' }, ai: { enabled: true, provider: 'openai' }, autoFocus: true, commands: true });
    assert.equal(good.code, 0, good.out);
    assert.match(good.out, /整理測試（\d+ ms）：.*→「我們明天四點開會，記得帶筆電。」/);
    assert.match(good.out, /第三層決策（AI，\d+ ms）：「進到台積電的個股頁」判成 指令/);
    assert.doesNotMatch(good.out, /sk-test/);
    const missing = await run({ ai: { enabled: true, provider: 'deepseek' } });
    assert.equal(missing.code, 1);
    assert.match(missing.out, /沒有 DeepSeek 的 key/);
  } finally {
    server.close();
  }
});

test('游標在輸入框時算不算指令：Jev 很確定，或滿確定而且講到畫面上的東西', async () => {
  const { inFieldVerdict } = await import('../bin/decide.mjs');
  const items = [el(1, 'AXButton', 'PM C'), el(2, 'AXButton', 'New session')];
  const answer = (p, choice, confidence = 0.9) => ({ intent: { probabilities: { command: p } }, target: { choice, confidence } });
  assert.equal(inFieldVerdict(answer(0.92, 'none'), items).isCommand, true); // 「打開設定」：很確定
  const named = inFieldVerdict(answer(0.8, 'e0'), items);
  assert.equal(named.isCommand, true); // 「回到 PM C」
  assert.equal(named.named.label, 'PM C');
  assert.equal(inFieldVerdict(answer(0.82, 'none'), items).isCommand, false); // 「你切到另一個分支再跑一次測試」
  assert.equal(inFieldVerdict(answer(0.63, 'e1'), items).isCommand, false);
  assert.equal(inFieldVerdict(answer(0.8, 'e0', 0.3), items).isCommand, false); // 講到哪個不確定
});
