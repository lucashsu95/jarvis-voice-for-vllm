// JarvisVoice 核心：操作代理。講「打開台積電的走勢圖」「把這則筆記移到旅遊」，直接在 App 裡一步步做到。
// 每一步：看畫面（接頭給整頁的結構，能操作的東西前面有編號）→ 問 AI 下一步用哪個工具 → 做 → 等畫面穩定 → 再看，
// 做到 AI 說畫面就是目標、或 AI 說做不到為止。
// 沒有寫死的做法：先搜尋還是先捲動、走側欄還是直接開頁面，都由 AI 看畫面決定；能用哪些工具由接頭宣告（screen.tools）。
// 只擋一件事：會送出、刪除、付款、下單、發布的按鈕不自己按，做到按之前就停，交給使用者。
// 迴圈自己只在這些時候停：按了停止、做了 maxSteps 步、同一個畫面同一步做了三次、在兩步之間來回（A、B、A、B）、
// AI 連兩次回不出看得懂的下一步。

// screen 是 App 的畫面接頭：
//   screen.tools：[{ name, args, about }]，這個 App 能用的工具（標準的見 AGENT_TOOLS，App 可以加自己的，例如直接打開某一頁）
//   screen.snapshot() → { text, labels }：text 是給 AI 看的整頁結構；labels 是編號 → 給人看的名字（小框寫做到哪一步用）
//   screen.run({ tool, args }) → { ok, note }：做這一步；note 是做完的情形（例如「捲到底了」），寫進做過的步驟給 AI 看
//   screen.settle()：等畫面穩定（沒給就等 SETTLE_MS）

export const MAX_AGENT_STEPS = 15;
const SETTLE_MS = 600;

// 標準工具：接頭照自己做得到的挑（Playwright 那一套操作）；args 寫給 AI 看
export const AGENT_TOOLS = {
  click: { args: 'ref', about: '點一下 ref' },
  long_press: { args: 'ref', about: '按住 ref 不放（叫出長按選單）' },
  fill: { args: 'ref, text', about: '在輸入框 ref 填入 text（換掉原本的字）' },
  press_key: { args: 'key（Enter、Escape、Tab、Backspace、ArrowDown…）, ref（可省略：游標所在的地方）', about: '按一個鍵' },
  scroll: { args: 'direction（up、down、left、right）, ref（可捲動的區域，省略＝整頁）, amount（捲幾個畫面，預設 1）', about: '捲動' },
  swipe: { args: 'direction（left、right、up、down）, ref（在哪個東西上滑，省略＝畫面中間）', about: '手指滑過去（輪播、側滑選單、返回手勢）' },
  back: { args: '', about: '回上一頁' },
  select: { args: 'ref, option（選項的文字）', about: '在下拉選單 ref 選 option' },
  wait: { args: 'ms（最多 3000）', about: '等畫面載入' },
};

/** 接頭用：照名字取標準工具，[{ name, args, about }] */
export function standardTools(names) {
  return names.filter((name) => AGENT_TOOLS[name]).map((name) => ({ name, ...AGENT_TOOLS[name] }));
}

const END_TOOLS = [
  { name: 'done', args: 'summary（一句話：現在畫面是什麼）', about: '畫面已經是使用者要的結果' },
  { name: 'fail', args: 'reason（一句話：為什麼做不到）', about: '試過了，確定做不到' },
];

const SYSTEM = '你在替使用者操作 App。每次只做一步：看 <screen>（現在的畫面；能操作的東西前面有 [編號]，'
  + '畫面外、收起來的也列出來了，可以直接用）、<goal>（使用者要的結果；<said> 是他講的原話）、<done>（已經做過的步驟和結果），'
  + '從 <tools> 挑一個工具、填好參數。每一步先對照 <done>：上一步做完，現在的畫面是不是已經是使用者要的結果，是就用 done，不要再多做。'
  + '畫面上真的看得到使用者要的東西才用 done（畫面寫著不支援、找不到、出錯都不算，換別的做法再試）；'
  + '試過幾種做法都不行才用 fail。'
  + '會送出、刪除、付款、下單、發布的按鈕不要按：做到按之前就用 done，在 summary 說明留給使用者自己按。'
  + '只輸出 JSON：{"tool": "<工具名>", "args": {<參數>}, "why": "<一句話：為什麼做這一步>"}';

const CALL_SCHEMA = {
  type: 'object',
  properties: { tool: { type: 'string' }, args: { type: 'object' }, why: { type: 'string' } },
  required: ['tool', 'args', 'why'],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function agentPrompt({ goal, said = '', context = {}, screen, tools, done }) {
  const toolLines = tools.map((t) => `- ${t.name}(${t.args})：${t.about}`).join('\n');
  const doneLines = done.length ? done.map((d, i) => `${i + 1}. ${d}`).join('\n') : '（還沒做）';
  return [
    `<app>${context.app ?? ''}</app>`,
    `<goal>${goal}</goal>`,
    said && said !== goal ? `<said>${said}</said>` : '',
    `<screen>\n${screen}\n</screen>`,
    `<tools>\n${toolLines}\n</tools>`,
    `<done>\n${doneLines}\n</done>`,
  ].filter(Boolean).join('\n');
}

// 字裡第一個完整的 JSON 物件（模型偶爾一次回兩個動作、或前後多說話）
function firstObject(text) {
  const start = text.indexOf('{');
  if (start < 0) return '';
  let depth = 0;
  let quoted = false;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '\\') i += 1;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '{') depth += 1;
    else if (c === '}' && (depth -= 1) === 0) return text.slice(start, i + 1);
  }
  return '';
}

// 模型吐的字 → { tool, args, why }；工具不在清單裡、不是 JSON 回 null
export function parseCall(raw, names) {
  let body;
  try {
    body = JSON.parse(firstObject(String(raw ?? '')));
  } catch {
    return null;
  }
  const tool = String(body?.tool ?? '').trim();
  if (!names.has(tool)) return null;
  const args = body.args && typeof body.args === 'object' && !Array.isArray(body.args) ? body.args : {};
  return { tool, args, why: String(body.why ?? '') };
}

const argText = (args) => Object.entries(args).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ');

/** 這一步給人看的對象：args 裡的編號換成名字（labels），沒有編號就列參數 */
export function callTarget(call, labels = {}) {
  const ref = call.args?.ref != null ? String(call.args.ref) : '';
  const named = ref && labels[ref] ? labels[ref] : '';
  const rest = Object.entries(call.args ?? {}).filter(([k]) => k !== 'ref');
  const extra = rest.length ? argText(Object.fromEntries(rest)) : '';
  return [named || ref, extra].filter(Boolean).join(' ');
}

// complete({ system, user, schema, timeoutMs }) → 模型吐的字；onStep({ n, action, target })：每一步決定好時通知（小框寫做到哪一步）
export async function runAgent({ screen, complete, goal, said = '', context = {}, log = () => {}, stopped = () => false, onStep = () => {},
  maxSteps = MAX_AGENT_STEPS, timeoutMs = 12000 }) {
  const tools = [...(screen.tools ?? []), ...END_TOOLS];
  const names = new Set(tools.map((t) => t.name));
  const done = []; // 做過的步驟（給 AI 看，也是結果的 steps）
  let lastKey = '';
  let repeats = 0;
  let unreadable = 0;
  const recent = []; // 做過的每一步（工具＋對象），看有沒有在幾步之間來回
  for (let n = 1; ; n += 1) {
    if (stopped()) return { ok: false, reason: '按了停止，停下來', steps: done };
    if (n > maxSteps) return { ok: false, reason: `做了 ${maxSteps} 步還沒完成，停下來`, steps: done };
    const view = await screen.snapshot();
    const started = Date.now();
    let raw;
    try {
      raw = await complete({ system: SYSTEM, user: agentPrompt({ goal, said, context, screen: view.text, tools, done }), schema: CALL_SCHEMA, timeoutMs });
    } catch (err) {
      return { ok: false, reason: `AI 沒回下一步（${err?.message ?? err}）`, steps: done };
    }
    if (stopped()) return { ok: false, reason: '按了停止，停下來', steps: done };
    const call = parseCall(raw, names);
    if (!call) {
      unreadable += 1;
      log(`指令第 ${n} 步（${Date.now() - started} ms）：AI 回的看不懂：${String(raw).slice(0, 200)}`);
      if (unreadable >= 2) return { ok: false, reason: 'AI 回的下一步看不懂，停下來', steps: done };
      done.push('（上一次回的不是工具清單裡的 JSON，這次照格式回）');
      continue;
    }
    unreadable = 0;
    const target = callTarget(call, view.labels);
    log(`指令第 ${n} 步（${Date.now() - started} ms）：${call.tool}${target ? ` → ${target}` : ''}；${call.why}`);
    if (call.tool === 'done') return { ok: true, steps: done, summary: String(call.args.summary ?? call.why ?? '') };
    if (call.tool === 'fail') return { ok: false, reason: String(call.args.reason || call.why || '做不到'), steps: done };
    const key = `${view.text}\n${call.tool}:${JSON.stringify(call.args)}`;
    repeats = key === lastKey ? repeats + 1 : 0;
    lastKey = key;
    if (repeats >= 2) return { ok: false, reason: '同一個畫面同一步做了三次，停下來', steps: done };
    // 在兩步之間來回（A、B、A、B）：畫面一直在變也停。同一步一直做（往下捲、下一頁）不算，交給 maxSteps
    recent.push(`${call.tool}:${target}`);
    const [a, b, c, d] = recent.slice(-4);
    if (d !== undefined && a === c && b === d && a !== b) return { ok: false, reason: '一直在兩步之間來回，停下來', steps: done };
    onStep({ n, action: call.tool, target });
    let result;
    try {
      result = await screen.run(call);
    } catch (err) {
      result = { ok: false, note: err?.message ?? String(err) };
    }
    // 連為什麼做這一步一起記，下一步才知道上一步是不是已經達成目標
    done.push(`${call.tool}${target ? ` ${target}` : ''}${call.why ? `（為了：${call.why.slice(0, 80)}）` : ''} → ${result?.ok ? '做了' : '沒做成'}${result?.note ? `（${result.note}）` : ''}`);
    if (screen.settle) await screen.settle(); else await sleep(SETTLE_MS);
  }
}
