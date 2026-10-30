// 真模型的 AI 整理：三家（OpenAI、DeepSeek、Claude）照整理規則跑真的句子。會打雲端、花一點錢，要 VOICE_DICTATION_REAL_AI=1 才跑：
//   VOICE_DICTATION_REAL_AI=1 node --test tests/ai-real.spec.mjs
// key 照設定檔（~/.voice-dictation/config.json，或 VOICE_DICTATION_CONFIG）拿，也可以用環境變數；哪一家沒有 key 就跳過那家。

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aiKey, loadConfig } from '../bin/config.mjs';
import { editSegment } from '../bin/editor.mjs';

const enabled = !!process.env.VOICE_DICTATION_REAL_AI;
const { config } = loadConfig();
const keyFor = (provider) => (enabled ? aiKey({ ...config, ai: { ...config.ai, provider } }) : '');

// 每句跑 ROUNDS 次（模型每次回的不一定一樣），全部都要對
const ROUNDS = Number(process.env.VOICE_DICTATION_REAL_AI_ROUNDS || 2);
const KEEP = [
  ['哈囉，哈囉，哈囉。', [/哈囉[^哈]*哈囉/]],
  ['Hello, hello, hello.', [/hello[^h]*hello/i]],
  ['測試，測試，測試，測試。', [/測試[^測]*測試/]],
  ['好。', [/好/]],
  ['因為我覺得我人生中。', [/人生/]],
  ['有問題啊，我都已經在那邊講話了，他有時候他媽的都不會用好。', [/他媽的/, /不會用好/]],
  ['幹，這個又壞掉了。', [/幹/, /壞掉/]],
];
const CLEAN = [
  ['嗯我們明天三點不對四點開會。', [/四點/], [/三點/, /嗯/]],
  ['呃這個 bug 嗯就是 deploy 之後才出現的。', [/bug/, /deploy/], [/呃|嗯/]],
  ['我我我覺得這樣可以。', [/^我覺得這樣可以/], []],
];
// 指令模式、游標不在輸入框（Chrome 開著 Threads）：目標寫清楚要的結果（網站帶網址）、傳訊息拆出內容，一般的話照樣是打字
const COMMANDS = [
  ['打開 YouTube。', 'command', { goal: /youtube\.com/i }],
  ['進到台積電的個股頁。', 'command', { goal: /台積電/ }],
  ['幫我傳給 BU 說你好。', 'command', { goal: /BU/, message: /你好/ }],
  ['明天四點開會記得帶筆電。', 'insert', { text: /開會/ }],
];
const browser = { app: 'Google Chrome', bundle: 'com.google.Chrome', window: 'Threads', url: 'https://www.threads.com/', field: { known: true, editable: false } };
const context = { app: 'Claude', bundle: 'com.anthropic.claudefordesktop', window: 'Claude', field: { role: 'AXTextArea', editable: true, known: true, before: '', after: '' } };

for (const provider of ['deepseek', 'openai', 'claude']) {
  const apiKey = keyFor(provider);
  const skip = (!enabled && '會打雲端，要 VOICE_DICTATION_REAL_AI=1') || (!apiKey && `沒有 ${provider} 的 key`);
  const edit = (transcript) => editSegment({ provider, apiKey, timeoutMs: 15000, transcript, context, commands: true });

  test(`真模型 ${provider}：招呼、試麥克風、一個字、半句、髒話都照留，不會整理成空的`, { skip, timeout: 180_000 }, async () => {
    for (const [transcript, expect] of KEEP) {
      for (let i = 0; i < ROUNDS; i += 1) {
        const r = await edit(transcript);
        assert.equal(r.mode, 'insert', transcript);
        for (const re of expect) assert.match(r.text, re, `${transcript} → ${r.text}`);
      }
    }
  });

  test(`真模型 ${provider}：贅字、改口、結巴照樣整理掉；只有語氣詞的不寫`, { skip, timeout: 180_000 }, async () => {
    for (const [transcript, expect, reject] of CLEAN) {
      const r = await edit(transcript);
      for (const re of expect) assert.match(r.text, re, `${transcript} → ${r.text}`);
      for (const re of reject) assert.doesNotMatch(r.text, re, `${transcript} → ${r.text}`);
    }
    const r = await edit('呃，嗯。');
    assert.ok(!r.text.replace(/[嗯呃，。\s]/g, ''), `只有語氣詞 → ${r.text}`);
  });

  test(`真模型 ${provider}：游標不在輸入框時，指令的目標寫清楚（網站帶網址）、傳訊息拆出內容、一般的話是打字`, { skip, timeout: 240_000 }, async () => {
    for (const [transcript, mode, expect] of COMMANDS) {
      for (let i = 0; i < ROUNDS; i += 1) {
        const r = await editSegment({ provider, apiKey, timeoutMs: 15000, transcript, context: browser, commands: true });
        assert.equal(r.mode, mode, `${transcript} → ${r.mode}`);
        for (const [field, re] of Object.entries(expect)) assert.match(r[field] ?? '', re, `${transcript} → ${field}=${r[field]}`);
      }
    }
  });
}
