// 核心的操作代理（core/agent.mjs）：每一步看畫面、AI 挑工具、做、再看。畫面接頭與 AI 都傳假的進去。

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as core from '../core/index.mjs';

// 假畫面：page 換了，snapshot 就換；run 記下做了什麼
function fakeScreen(pages, start) {
  let page = start;
  const runs = [];
  return {
    runs,
    page: () => page,
    tools: [...core.standardTools(['click', 'scroll', 'back']), { name: 'open_page', args: 'page, params', about: '直接打開插件的頁面' }],
    snapshot: async () => ({ text: pages[page].text, labels: pages[page].labels }),
    run: async (call) => {
      runs.push(call);
      const next = pages[page].on?.(call);
      if (next) page = next;
      return { ok: true, ...(next ? {} : { note: '畫面沒變' }) };
    },
    settle: async () => {},
  };
}

// 假 AI：照順序回，並記下每次看到的 user
function fakeAi(replies) {
  const seen = [];
  return {
    seen,
    complete: async ({ user }) => {
      seen.push(user);
      const r = replies.shift();
      return typeof r === 'string' ? r : JSON.stringify(r);
    },
  };
}

test('操作代理：照 AI 挑的工具一步步做，AI 說 done 就完成；小框收到每一步，做過的步驟交給下一步', async () => {
  const screen = fakeScreen({
    team: { text: '位置：台股投資部門\n[e1] 按鈕「搜尋」', labels: { e1: '按鈕「搜尋」' }, on: (c) => (c.tool === 'open_page' ? 'stock' : null) },
    stock: { text: '位置：台積電 2330\n[e1] 分頁「看盤」（選中）\n[e2] 分頁「走勢」', labels: { e1: '分頁「看盤」', e2: '分頁「走勢」' }, on: (c) => (c.args.ref === 'e2' ? 'trend' : null) },
    trend: { text: '位置：台積電 2330\n[e1] 分頁「看盤」\n[e2] 分頁「走勢」（選中）\n標題「當日走勢」', labels: {} },
  }, 'team');
  const ai = fakeAi([
    { tool: 'open_page', args: { page: 'stock', params: { market: 'TWSE', symbol: '2330', name: '台積電' } }, why: '個股頁有走勢' },
    { tool: 'click', args: { ref: 'e2' }, why: '切到走勢' },
    { tool: 'done', args: { summary: '台積電的走勢' }, why: '到了' },
  ]);
  const steps = [];
  const r = await core.runAgent({ screen, complete: ai.complete, goal: '打開台積電的走勢圖', said: '幫我打開台積電的走勢圖', context: { app: 'CubeLV' }, onStep: (s) => steps.push(s) });
  assert.equal(r.ok, true);
  assert.equal(r.summary, '台積電的走勢');
  assert.equal(screen.page(), 'trend');
  assert.deepEqual(steps.map((s) => [s.n, s.action]), [[1, 'open_page'], [2, 'click']]);
  assert.equal(steps[1].target, '分頁「走勢」');
  // 沒有編號的工具（打開頁面）照參數寫；接頭給 describe 就用它的（給人看的名字）
  assert.match(steps[0].target, /page=stock/);
  const named = fakeScreen({ only: { text: '[e1] 按鈕「x」' } }, 'only');
  named.describe = (call) => (call.tool === 'open_page' ? '「台積電」' : null);
  const shown = [];
  await core.runAgent({ screen: named, complete: fakeAi([{ tool: 'open_page', args: { page: 'stock', params: {} }, why: '' }, { tool: 'done', args: {}, why: '' }]).complete, goal: 'x', onStep: (s) => shown.push(s.target) });
  assert.deepEqual(shown, ['「台積電」']);
  assert.equal(r.steps.length, 2);
  // 第二步看得到第一步做了什麼、為什麼做，也看得到原話
  assert.match(ai.seen[1], /<done>\n1\. open_page .*（為了：個股頁有走勢） → 做了/);
  assert.match(ai.seen[0], /<said>幫我打開台積電的走勢圖<\/said>/);
  assert.match(ai.seen[0], /- scroll\(direction/);
  assert.match(ai.seen[0], /- done\(summary/);
});

test('操作代理：AI 說 fail 就停並帶原因；工具不在清單裡連兩次就停；同一個畫面同一步做三次就停；做滿 maxSteps 停', async () => {
  const still = { only: { text: '[e1] 按鈕「設定」', labels: { e1: '按鈕「設定」' } } };
  const failed = await core.runAgent({ screen: fakeScreen(still, 'only'), complete: fakeAi([{ tool: 'fail', args: { reason: '沒有這個功能' }, why: '' }]).complete, goal: 'x' });
  assert.deepEqual([failed.ok, failed.reason], [false, '沒有這個功能']);

  const junk = await core.runAgent({ screen: fakeScreen(still, 'only'), complete: fakeAi(['好的我來點', { tool: 'fly', args: {}, why: '' }]).complete, goal: 'x' });
  assert.match(junk.reason, /看不懂/);

  const click = { tool: 'click', args: { ref: 'e1' }, why: '' };
  const stuck = fakeScreen(still, 'only');
  const loop = await core.runAgent({ screen: stuck, complete: fakeAi([click, click, click, click]).complete, goal: 'x' });
  assert.match(loop.reason, /同一步做了三次/);
  assert.equal(stuck.runs.length, 2);

  // 在兩步之間來回（畫面一直在變，不算同一個畫面）：A、B、A、B 就停；同一步一直做（往下捲）不算
  let flip = 0;
  const flipping = {
    tools: core.standardTools(['click']),
    snapshot: async () => ({ text: `排序 ${flip % 2 ? '最舊' : '最新'}`, labels: { e1: '按鈕「最新」', e2: '按鈕「最舊」' } }),
    run: async () => { flip += 1; return { ok: true }; },
    settle: async () => {},
  };
  const toggles = [1, 2, 1, 2].map((i) => ({ tool: 'click', args: { ref: `e${i}` }, why: '' }));
  const bounced = await core.runAgent({ screen: flipping, complete: fakeAi(toggles).complete, goal: 'x' });
  assert.match(bounced.reason, /來回/);
  assert.equal(flip, 3);

  let n = 0;
  const moving = {
    tools: core.standardTools(['click']),
    snapshot: async () => ({ text: `第 ${n} 頁 [e1] 按鈕「下一頁」` }),
    run: async () => { n += 1; return { ok: true }; },
    settle: async () => {},
  };
  const capped = await core.runAgent({ screen: moving, complete: async () => JSON.stringify(click), goal: 'x', maxSteps: 3 });
  assert.match(capped.reason, /做了 3 步/);
});

test('操作代理：按了停止就停，不再問 AI；AI 出錯回原因', async () => {
  let asked = 0;
  const screen = fakeScreen({ only: { text: '[e1] 按鈕「x」' } }, 'only');
  const r = await core.runAgent({ screen, complete: async () => { asked += 1; return '{}'; }, goal: 'x', stopped: () => true });
  assert.deepEqual([r.ok, asked], [false, 0]);
  const broken = await core.runAgent({ screen, complete: async () => { throw new Error('逾時'); }, goal: 'x' });
  assert.match(broken.reason, /AI 沒回下一步（逾時）/);
});

test('操作代理：parseCall 只收清單裡的工具；callTarget 把編號換成名字；小框認得新工具的動詞', () => {
  const names = new Set(['click', 'scroll']);
  assert.deepEqual(core.parseCall('好的：{"tool":"scroll","args":{"direction":"down"},"why":"往下找"}', names), { tool: 'scroll', args: { direction: 'down' }, why: '往下找' });
  assert.equal(core.parseCall('{"tool":"delete_all","args":{}}', names), null);
  // 一次回兩個動作：只取第一個；字串裡的括號不算
  assert.deepEqual(core.parseCall('{"tool":"click","args":{"ref":"e2"},"why":"點 {走勢}"}\n{"tool":"scroll","args":{},"why":""}', names), { tool: 'click', args: { ref: 'e2' }, why: '點 {走勢}' });
  assert.equal(core.parseCall('not json', names), null);
  assert.equal(core.callTarget({ tool: 'click', args: { ref: 'e3' } }, { e3: '按鈕「走勢」' }), '按鈕「走勢」');
  assert.equal(core.callTarget({ tool: 'scroll', args: { ref: 'e9', direction: 'down' } }, {}), 'e9 direction=down');
  assert.equal(core.stepText({ n: 3, action: 'scroll', target: '清單 direction=down' }, 'zh'), '第 3 步：捲動 清單 direction=down');
  assert.equal(core.stepText({ n: 1, action: 'open_page', target: 'page=stock' }, 'en'), 'Step 1: open page=stock');
  assert.equal(core.stepText({ n: 2, action: 'click', target: '「財務」' }, 'zh'), '第 2 步：點「財務」');
});

// 畫面接頭共用的那一半（core/agentScreen.mjs）：App 只給節點與動手，結構樹寫法與 CubeLV 現在看到的一行一行一樣
test('畫面接頭：節點寫成結構樹（層、編號、狀態、畫面外、搜尋框）；同一段字只列一次；太多編號先丟畫面外的', async () => {
  const nodes = [
    { depth: 0, kind: 'group', role: '側欄／導覽' },
    { depth: 1, kind: 'control', role: '按鈕', name: '自選報價', off: '側欄收起來', target: 'side' },
    { depth: 1, kind: 'heading', name: '台積電 2330' },
    { depth: 1, kind: 'group', role: '分頁列' },
    { depth: 2, kind: 'control', role: '分頁', name: '看盤', states: ['選中'], target: 'tab1' },
    { depth: 2, kind: 'control', role: '分頁', name: '走勢', target: 'tab2' },
    { depth: 1, kind: 'text', name: '收盤 1,045 元' },
    { depth: 1, kind: 'text', name: '收盤 1,045 元' },
    { depth: 1, kind: 'scroll', name: '新聞', states: ['下面還有'], target: 'news' },
    { depth: 2, kind: 'control', role: '按鈕', name: '更早的新聞', off: true, target: 'old' },
    { depth: 1, kind: 'control', role: '輸入框', name: '搜尋...', value: 'As', states: ['搜尋框'], target: 'search' },
    { depth: 1, kind: 'control', role: '按鈕', target: 'icon' },
  ];
  const view = core.writeTree(nodes, { header: ['現在在：側欄分頁「資料」', ''] });
  assert.deepEqual(view.text.split('\n'), [
    '現在在：側欄分頁「資料」',
    '側欄／導覽',
    '  [e1] 按鈕「自選報價」（側欄收起來）',
    '  標題「台積電 2330」',
    '  分頁列',
    '    [e2] 分頁「看盤」（選中）',
    '    [e3] 分頁「走勢」',
    '  「收盤 1,045 元」',
    '  [e4] 可捲動區「新聞」（下面還有）',
    '    [e5] 按鈕「更早的新聞」（畫面外）',
    '  [e6] 輸入框「搜尋...」，裡面是「As」（搜尋框）',
    '  [e7] 按鈕「沒有名字」',
  ]);
  assert.deepEqual(view.labels, { e1: '按鈕「自選報價」', e2: '分頁「看盤」', e3: '分頁「走勢」', e4: '可捲動區「新聞」', e5: '按鈕「更早的新聞」', e6: '輸入框「搜尋...」', e7: '按鈕「沒有名字」' });
  assert.equal(view.refs.get('e6'), 'search');
  const trimmed = core.writeTree(nodes, { maxRefs: 5 });
  assert.doesNotMatch(trimmed.text, /自選報價|更早的新聞/); // 畫面外的先丟
  assert.match(trimmed.text, /\[e4\] 輸入框「搜尋...」/);
  assert.match(core.writeTree(nodes, { maxChars: 60 }).text, /（後面還有 \d+ 行，太長沒列）$/);
});

test('畫面接頭：run 先給 App 自己的工具；ref 對不到先擋；不在清單的工具不做；小框寫畫面上的名字', async () => {
  let page = 1;
  const acts = [];
  const screen = core.createAgentScreen({
    tools: core.standardTools(['click', 'fill', 'press_key', 'scroll']),
    read: () => [{ depth: 0, kind: 'control', role: '按鈕', name: page === 1 ? '財務' : '新聞', target: `p${page}` }, { depth: 0, kind: 'control', role: '輸入框', name: '代號', target: 'field' }],
    act: (call, target) => { acts.push([call.tool, target]); page += 1; return { ok: true }; },
    header: () => '現在在：個股頁',
    extra: { tools: [{ name: 'go', args: 'ref', about: '直接去' }], run: async (call) => (call.tool === 'go' ? { ok: true, note: 'app' } : null), describe: (call) => (call.tool === 'go' ? '「市集」' : null) },
  });
  assert.deepEqual(screen.tools.map((t) => t.name), ['click', 'fill', 'press_key', 'scroll', 'go']);
  const view = await screen.snapshot();
  assert.equal(view.text.split('\n')[0], '現在在：個股頁');
  assert.deepEqual(await screen.run({ tool: 'click', args: { ref: 'e1' }, why: '' }), { ok: true });
  assert.deepEqual(acts, [['click', 'p1']]);
  assert.deepEqual(await screen.run({ tool: 'press_key', args: { key: 'esc' }, why: '' }), { ok: true });
  assert.deepEqual(acts.at(-1), ['press_key', null]);
  assert.match((await screen.run({ tool: 'click', args: { ref: 'e9' }, why: '' })).note, /找不到 e9，畫面可能換了/);
  assert.deepEqual(await screen.run({ tool: 'go', args: { ref: 'd1' }, why: '' }), { ok: true, note: 'app' });
  assert.equal((await screen.run({ tool: 'teleport', args: {}, why: '' })).ok, false);
  assert.equal(screen.targetOf('e2'), 'field');
  // 小框：畫面上的名字，不寫編號與參數
  assert.equal(screen.describe({ tool: 'click', args: { ref: 'e1' }, why: '' }), '「財務」');
  assert.equal(screen.describe({ tool: 'fill', args: { ref: 'e2', text: '2330' }, why: '' }), '「代號」：「2330」');
  assert.equal(screen.describe({ tool: 'scroll', args: { direction: 'down' }, why: '' }), '整頁（往下）');
  assert.equal(screen.describe({ tool: 'press_key', args: { key: 'esc' }, why: '' }), 'Escape');
  assert.equal(screen.describe({ tool: 'go', args: { ref: 'd1' }, why: '' }), '「市集」');
  assert.equal(core.keyName('enter'), 'Enter');
  assert.equal(core.keyName('cmd+l'), 'cmd+l');
});

test('畫面接頭接上 runAgent：AI 每一步看到核心寫的結構樹，照編號做到完成', async () => {
  let page = 'home';
  const screen = core.createAgentScreen({
    tools: core.standardTools(['click']),
    read: () => (page === 'home'
      ? [{ depth: 0, kind: 'control', role: '按鈕', name: '設定', target: 'settings' }]
      : [{ depth: 0, kind: 'heading', name: '設定' }, { depth: 0, kind: 'control', role: '按鈕', name: '通知', target: 'notify' }]),
    act: (call, target) => { if (target === 'settings') page = 'settings'; return { ok: true }; },
    settle: async () => {},
  });
  const ai = fakeAi([{ tool: 'click', args: { ref: 'e1' }, why: '進設定' }, { tool: 'done', args: { summary: '設定頁' }, why: '到了' }]);
  const steps = [];
  const r = await core.runAgent({ screen, complete: ai.complete, goal: '打開設定', onStep: (s) => steps.push(s) });
  assert.equal(r.ok, true);
  assert.match(ai.seen[0], /\[e1\] 按鈕「設定」/);
  assert.match(ai.seen[1], /標題「設定」/);
  assert.deepEqual(steps.map((s) => [s.action, s.target]), [['click', '「設定」']]);
});
