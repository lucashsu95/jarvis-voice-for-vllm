// JarvisVoice 核心：操作代理的畫面接頭共用的那一半。App 只負責讀畫面、動手；畫面寫成什麼樣子給 AI 看（縮排、[e編號]、
// 狀態、畫面外、太長怎麼裁）、ref 對到哪個東西、小框寫什麼都在這裡。CubeLV（lib/voice/domAgent.ts 讀網頁）和
// Mac 小程式（bin/agent-screen.mjs 讀輔助使用）同一份，兩邊的 AI 看到的畫面長得一樣。
//
// createAgentScreen({ tools, read, act, header, extra, settle, maxRefs, maxChars, maxTextLines }) → runAgent 要的 screen
//   read() → [節點]：照畫面由上往下、一層層列出來：
//     { depth, kind: 'group', role, name }                              縮排的一層（對話框、側欄／導覽、分頁列、選單、主畫面…）
//     { depth, kind: 'heading', name }                                   標題
//     { depth, kind: 'text', name }                                      畫面上看得到的字
//     { depth, kind: 'scroll', name, states, off, target }               可捲動區（有編號，可以捲）；states：上面還有、下面還有…
//     { depth, kind: 'control', role, name, value, states, off, target } 能操作的東西（有編號）；role 是給人看的角色（按鈕、分頁…），
//                                                                        states：選中、勾了、展開、不能按、游標在這…
//     off：true＝畫面外；字串＝App 自己的說法（例如「側欄收起來」）。太多編號時先丟畫面外的
//     target：App 自己認得的東西（DOM 元素、輔助使用的代號），做動作時原樣交回 act
//   act(call, target) → { ok, note }：做這一步。target 是 args.ref 對到的東西（沒給 ref 是 null）；ref 對不到，核心先回「找不到」
//   header() → 字串或字串陣列：結構樹最前面的字（現在在哪、頁面標題、整頁能不能捲）
//   extra：{ tools, run(call) → 結果或 null（null＝不是它的工具，照標準工具做）, describe(call) → 字串或 null }：App 自己的工具
//   settle()：等畫面穩定（沒給就由 runAgent 等固定的時間）

const MAX_REFS = 250;
const MAX_CHARS = 16000;
const MAX_TEXT_LINES = 120;

const squash = (text, max = 80) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

const DIRECTIONS = { up: '往上', down: '往下', left: '往左', right: '往右' };

const KEY_NAMES = { enter: 'Enter', return: 'Enter', esc: 'Escape', escape: 'Escape', tab: 'Tab', backspace: 'Backspace', delete: 'Delete', space: ' ' };
/** press_key 的鍵名統一寫法（esc → Escape、enter → Enter；組合鍵與其他照原樣） */
export const keyName = (key) => KEY_NAMES[String(key ?? '').trim().toLowerCase()] ?? (String(key ?? '').trim() || 'Enter');

/** ref 對不到東西時給 AI 的說明（App 的 act 發現東西已經不在畫面上也用這個） */
export const missingRef = (ref) => ({ ok: false, note: ref ? `找不到 ${ref}，畫面可能換了` : '要給 ref' });

const offText = (off) => (off === true ? '畫面外' : off || '');

// 一個節點 → { text, label }：text 是結構樹的一行（不含縮排、編號），label 是小框與 log 用的名字
function lineOf(node) {
  const name = squash(node.name);
  switch (node.kind) {
    case 'group': return { text: `${node.role ?? ''}${name ? `「${name}」` : ''}` };
    case 'heading': return { text: `標題「${name}」` };
    case 'text': return { text: `「${name}」` };
    case 'scroll': {
      const label = `可捲動區${name ? `「${name}」` : ''}`;
      const off = offText(node.off);
      return { text: `${label}（${(node.states ?? []).join('、') || '可以捲'}${off ? `，${off}` : ''}）`, label };
    }
    default: {
      const label = `${node.role ?? '按鈕'}「${name || '沒有名字'}」`;
      const value = squash(node.value, 60);
      const extra = [...(node.states ?? []), offText(node.off)].filter(Boolean);
      return { text: `${label}${value ? `，裡面是「${value}」` : ''}${extra.length ? `（${extra.join('，')}）` : ''}`, label };
    }
  }
}

/** 節點 → 給 AI 看的結構樹：{ text, labels, refs }（refs：編號 → target） */
export function writeTree(nodes, { header = [], maxRefs = MAX_REFS, maxChars = MAX_CHARS, maxTextLines = MAX_TEXT_LINES } = {}) {
  let lines = [];
  let textLines = 0;
  for (const node of nodes) {
    const operable = node.kind === 'scroll' || node.kind === 'control';
    const { text, label } = lineOf(node);
    if (node.kind === 'text') {
      // 同一段字連著出現只列一次；字太多只列前面的
      if (lines.at(-1)?.text === text || textLines >= maxTextLines) continue;
      textLines += 1;
    }
    lines.push({ depth: node.depth ?? 0, text, ...(operable ? { target: node.target, label, off: !!node.off } : {}) });
  }
  // 編號太多：先丟畫面外的（從後面丟），還太多再從後面丟
  const refCount = () => lines.filter((l) => 'target' in l).length;
  for (let i = lines.length - 1; i >= 0 && refCount() > maxRefs; i -= 1) if ('target' in lines[i] && lines[i].off) lines.splice(i, 1);
  for (let i = lines.length - 1; i >= 0 && refCount() > maxRefs; i -= 1) if ('target' in lines[i]) lines.splice(i, 1);
  const refs = new Map();
  const labels = {};
  let n = 0;
  lines = lines.map((l) => {
    if (!('target' in l)) return `${'  '.repeat(l.depth)}${l.text}`;
    n += 1;
    const ref = `e${n}`;
    refs.set(ref, l.target);
    labels[ref] = l.label;
    return `${'  '.repeat(l.depth)}[${ref}] ${l.text}`;
  });
  let text = [...[].concat(header).filter(Boolean), ...lines].join('\n');
  if (text.length > maxChars) {
    const cut = text.lastIndexOf('\n', maxChars);
    const rest = text.slice(cut).split('\n').length - 1;
    text = `${text.slice(0, cut)}\n（後面還有 ${rest} 行，太長沒列）`;
  }
  return { text, labels, refs };
}

/** 小框寫給人看的這一步：畫面上的名字，不寫編號與參數（「「財務」」「「新聞」（往下）」「「代號」：「2330」」） */
export function describeCall(call, labels = {}) {
  const args = call.args ?? {};
  // 「按鈕「財務」」只留「財務」，太長的截掉
  const full = args.ref != null ? labels[String(args.ref)] ?? '' : '';
  const raw = full.match(/「(.*)」/)?.[1] ?? full;
  const quoted = raw === '沒有名字' ? '' : raw;
  const name = quoted ? `「${quoted.length > 24 ? `${quoted.slice(0, 24)}…` : quoted}」` : '';
  const value = (v) => `${name ? `${name}：` : ''}「${squash(v, 30)}」`;
  const direction = DIRECTIONS[String(args.direction ?? '')] ?? '';
  switch (call.tool) {
    case 'fill': return value(args.text);
    case 'select': return value(args.option);
    case 'scroll': return `${name || '整頁'}${direction ? `（${direction}）` : ''}`;
    case 'swipe': return [name, direction].filter(Boolean).join('，');
    case 'press_key': return keyName(args.key);
    case 'back':
    case 'wait': return '';
    default: return name;
  }
}

export function createAgentScreen({ tools = [], read, act, header, extra, settle, maxRefs, maxChars, maxTextLines }) {
  const own = new Set(tools.map((t) => t.name));
  let refs = new Map();
  let labels = {};
  const screen = {
    tools: [...tools, ...(extra?.tools ?? [])],

    async snapshot() {
      const nodes = await read();
      const view = writeTree(nodes, { header: header ? await header() : [], maxRefs, maxChars, maxTextLines });
      refs = view.refs;
      labels = view.labels;
      return { text: view.text, labels };
    },

    async run(call) {
      const handled = extra ? await extra.run(call) : null;
      if (handled) return handled;
      if (!own.has(call.tool)) return { ok: false, note: `沒有 ${call.tool} 這個工具` };
      const ref = call.args?.ref != null ? String(call.args.ref) : '';
      if (ref && !refs.has(ref)) return missingRef(ref);
      return act(call, ref ? refs.get(ref) : null);
    },

    describe(call) {
      return extra?.describe?.(call) ?? describeCall(call, labels);
    },

    /** 上一次 snapshot 這個編號對到的東西（測試、除錯用） */
    targetOf(ref) {
      return refs.get(ref) ?? null;
    },
  };
  if (settle) screen.settle = settle;
  return screen;
}
