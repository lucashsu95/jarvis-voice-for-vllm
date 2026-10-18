// AX 小幫手對真的視窗：開 tests/fixtures/test-window.js（不搶前景），讀上下文、找輸入框、對焦、列元件。
// 不送任何按鍵：測試視窗不在最前面，貼上要回 not-front，填字改成直接設值。跑測試的程式沒有「輔助使用」權限就跳過。

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createAx } from '../bin/ax.mjs';
import { runCommand } from '../bin/commander.mjs';
import { createDecider } from '../bin/decide.mjs';
import { readingOrder } from '../core/ocr.mjs';
import { bringToFront, sendToBack, startBundle } from './fixtures/front.mjs';

const ax = createAx();
after(() => ax.close());

const trusted = process.platform === 'darwin' && (await ax.call('check', { ask: false }).catch(() => ({}))).trusted;

test('AX 小幫手：讀上下文、找輸入框、對焦、列元件；不在前景不貼', { skip: !trusted && '沒有輔助使用權限', timeout: 30_000 }, async () => {
  const win = spawn('/usr/bin/osascript', ['-l', 'JavaScript', join(import.meta.dirname, 'fixtures', 'test-window.js')], { stdio: 'ignore' });
  try {
    const pid = win.pid;
    let ctx;
    for (let i = 0; i < 40; i += 1) {
      ctx = await ax.call('context', { pid, chars: 400 }).catch(() => null);
      if (ctx?.field?.editable) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.equal(ctx.window, 'JarvisVoice 測試視窗');
    assert.ok(await sendToBack(pid), '測試視窗要在背景');
    assert.deepEqual([ctx.field.role, ctx.field.label, ctx.field.before, ctx.field.after], ['AXTextArea', '訊息', '今天的待辦：', '']);
    const withScreen = await ax.call('context', { pid, screen: 1500 });
    assert.match(withScreen.screen, /畫面文字：我們在討論 JarvisVoice/);
    assert.doesNotMatch(withScreen.screen, /今天的待辦/); // 輸入框裡的字不算

    const found = await ax.call('targets', { pid });
    const byLabel = Object.fromEntries(found.candidates.map((c) => [c.label, c]));
    assert.equal(byLabel['搜尋'].subrole, 'AXSearchField');
    assert.equal(byLabel['密碼'].subrole, 'AXSecureTextField');
    assert.equal(byLabel['訊息'].focused, true);

    assert.equal((await ax.call('focus', { handle: byLabel['主旨'].handle })).ok, true);
    const moved = await ax.call('context', { pid });
    assert.equal(moved.field.label, '主旨');

    await ax.call('focus', { handle: byLabel['密碼'].handle });
    const secret = await ax.call('context', { pid });
    assert.equal(secret.field.secure, true);

    assert.equal((await ax.call('read', { handle: byLabel['訊息'].handle })).value, '今天的待辦：');
    const { elements } = await ax.call('elements', { pid });
    assert.deepEqual(elements.map((e) => e.label), ['搜尋', '主旨', '密碼', '訊息']);

    await ax.call('focus', { handle: byLabel['訊息'].handle });
    assert.equal((await ax.call('paste', { pid, text: '不該貼出去' })).result, 'not-front');
    assert.equal((await ax.call('replace', { pid, old: '不在這裡', text: '' })).result, 'mismatch');
    // 不在前景時填字是直接設值，不送按鍵
    assert.equal((await ax.call('act', { pid, handle: byLabel['主旨'].handle, action: 'fill', text: '週會改期' })).result, 'ok');
    assert.equal((await ax.call('read', { handle: byLabel['主旨'].handle })).value, '週會改期');
  } finally {
    win.kill();
  }
});

test('讀不到畫面時截圖認字：認出視窗上的字和位置（要螢幕錄影權限）', { skip: !trusted && '沒有輔助使用權限', timeout: 30_000 }, async () => {
  const win = await openStockWindow();
  try {
    // 視窗剛開可能還沒畫完：最多試 5 次
    let seen;
    let labels = [];
    for (let i = 0; i < 5; i += 1) {
      seen = await ax.call('ocr', { pid: win.pid, ask: false }, 15000);
      if (!seen.permission) return; // 跑測試的程式沒有螢幕錄影權限就略過
      labels = seen.items.map((x) => x.text);
      if (labels.some((t) => t.includes('設定'))) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    assert.ok(labels.some((t) => t.includes('設定')), labels.join('|'));
    // 順序由核心排（由上往下、由左往右），跟平行沙盒同一套
    assert.deepEqual(seen.items.map((x) => x.text), readingOrder(seen.items).map((x) => x.text));
    const both = await ax.call('elements', { pid: win.pid, ocr: 'always' }, 15000);
    assert.equal(both.source, 'ocr');
    assert.ok(both.elements.some((e) => e.ocr && e.label.includes('自選股')), '視窗標題是讀不到的元件，要列進來');
    assert.ok(!both.elements.some((e) => e.ocr && e.label === '設定'), '按鈕上的字已經有元件了，不重複列');
  } finally {
    win.kill();
  }
});

async function openStockWindow() {
  const win = spawn('/usr/bin/osascript', ['-l', 'JavaScript', join(import.meta.dirname, 'fixtures', 'stock-window.js')], { stdio: 'ignore' });
  for (let i = 0; i < 40; i += 1) {
    const r = await ax.call('elements', { pid: win.pid }).catch(() => null);
    if (r?.elements?.length) break;
    await new Promise((res) => setTimeout(res, 150));
  }
  assert.ok(await sendToBack(win.pid), '看盤測試視窗要在背景');
  return win;
}

const title = async (pid) => (await ax.call('elements', { pid })).window.title;

test('指令模式對真的視窗（背景、不送按鍵）：填字 → 確認 → 點結果', { skip: !trusted && '沒有輔助使用權限', timeout: 30_000 }, async () => {
  const win = await openStockWindow();
  try {
    const plan = [['fill', '搜尋股票'], ['enter', ''], ['click', '台積電 2330'], ['done', '']];
    let options = '';
    const decider = {
      engine: () => '劇本',
      async decide(state, questions) {
        options += Object.values(questions.target.criteria).join('|');
        const [action, label] = plan[state.done_steps.length];
        const hit = Object.entries(questions.target.criteria).find(([, d]) => label && d.includes(`「${label}」`));
        return { action: { choice: action, confidence: 0.9 }, target: { choice: hit?.[0] ?? 'e0', confidence: hit ? 0.9 : 0.1 } };
      },
    };
    const result = await runCommand({
      ax, decider, log: () => {}, frontApp: async () => ({ pid: win.pid }), openApp: async () => true,
      goal: '打開台積電（2330）的個股頁', text: '台積電', context: { app: '看盤' },
    });
    assert.equal(result.ok, true, result.reason);
    assert.equal(await title(win.pid), '台積電 2330 個股');
    assert.ok(options.includes('刪除自選'), '畫面上的按鈕都要給決策器看');
  } finally {
    win.kill();
  }
});

// 有 TYPESAFE_API_KEY 才跑：真的 Jev 決定每一步
test('指令模式 + 真的 Jev', { skip: (!trusted && '沒有輔助使用權限') || (!process.env.TYPESAFE_API_KEY && '沒有 TYPESAFE_API_KEY'), timeout: 60_000 }, async () => {
  const win = await openStockWindow();
  try {
    const decider = createDecider(() => ({ jevKey: process.env.TYPESAFE_API_KEY, jevModel: 'jev-latest' }));
    const base = { ax, decider, log: () => {}, frontApp: async () => ({ pid: win.pid }), openApp: async () => true, context: { app: '看盤' } };
    assert.equal((await runCommand({ ...base, goal: '打開台積電（2330）的個股頁', text: '台積電' })).ok, true);
    assert.equal(await title(win.pid), '台積電 2330 個股');
    assert.equal((await runCommand({ ...base, goal: '打開設定頁', text: '' })).ok, true);
    assert.equal(await title(win.pid), '設定');
  } finally {
    win.kill();
  }
});

// 會搶前景約 2 秒，要 VOICE_DICTATION_FOCUS_TESTS=1 才跑：測試視窗到最前面時真的貼得進去、換得回來
test('貼上與換回原文（測試視窗在最前面）', {
  skip: (!trusted && '沒有輔助使用權限') || (!process.env.VOICE_DICTATION_FOCUS_TESTS && '會搶前景，要 VOICE_DICTATION_FOCUS_TESTS=1'),
  timeout: 30_000,
}, async () => {
  const win = spawn('/usr/bin/osascript', ['-l', 'JavaScript', join(import.meta.dirname, 'fixtures', 'test-window.js'), '--empty'], { stdio: 'ignore' });
  try {
    const pid = win.pid;
    for (let i = 0; i < 40; i += 1) {
      const ctx = await ax.call('context', { pid }).catch(() => null);
      if (ctx?.field?.editable) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(await bringToFront(pid), '測試視窗要到最前面');
    const pasted = await ax.call('paste', { pid, text: '我們明天四點開會。' });
    assert.equal(pasted.result, 'ok');
    await new Promise((r) => setTimeout(r, 300));
    const { handle } = (await ax.call('context', { pid })).field;
    assert.equal((await ax.call('read', { handle })).value, '我們明天四點開會。');
    assert.equal((await ax.call('replace', { pid, old: '我們明天四點開會。', text: '嗯我們明天三點不對四點開會。' })).result, 'ok');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await ax.call('read', { handle })).value, '嗯我們明天三點不對四點開會。');
    assert.equal((await ax.call('replace', { pid, old: '嗯我們明天三點不對四點開會。', text: '' })).result, 'ok');
    await new Promise((r) => setTimeout(r, 200));
    assert.equal((await ax.call('read', { handle })).value, '');
    // 游標不在剛填的那個框：不按 Enter（游標在訊息框按 Enter 會送出）
    const { candidates } = await ax.call('targets', { pid });
    const subject = candidates.find((c) => c.label === '主旨');
    assert.match((await ax.call('act', { pid, handle: subject.handle, action: 'enter' })).result, /^not-focused/);
    // 焦點在多行的訊息框：就算裡面的字跟要搜尋的字一樣也不按
    assert.match((await ax.call('act', { pid, handle: subject.handle, action: 'enter', text: '' })).result, /^not-focused/);
  } finally {
    win.kill();
    if (startBundle) execFileSync('/usr/bin/open', ['-b', startBundle]);
  }
});
