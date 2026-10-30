// Mac 小程式的操作代理畫面接頭：讀最前面那個 app 的輔助使用樹（AX 小幫手的 tree），轉成核心的節點（core/agentScreen.mjs），
// 照 AI 挑的工具動手。畫面怎麼寫給 AI 看、編號、太長怎麼裁、小框寫什麼都在核心，CubeLV（lib/voice/domAgent.ts）同一份。
// 讀不到樹的 app（例如 LINE 的對話清單只有沒有名字的列）用截圖認字補：沒有名字的東西拿它範圍裡認出來的字當名字，
// 其他認出來的字列成「畫面上的字」，點下去是點那個位置。
// Mac 自己的工具：右鍵選單、選單列、切換 app、打開網址（沒有觸控，沒有長按、滑動；沒有共通的「上一頁」，用按鍵）。

import { execFile } from 'node:child_process';
import { createAgentScreen, missingRef } from '../core/agentScreen.mjs';
import { standardTools } from '../core/agent.mjs';
import { readingOrder } from '../core/ocr.mjs';

const ROLE_NAMES = {
  AXButton: '按鈕', AXLink: '連結', AXTextField: '輸入框', AXSearchField: '輸入框', AXTextArea: '多行輸入框', AXComboBox: '下拉輸入框',
  AXPopUpButton: '下拉選單', AXMenuButton: '選單按鈕', AXCheckBox: '勾選框', AXRadioButton: '選項', AXRow: '清單項目', AXCell: '格子',
  AXMenuItem: '選單項目', AXSlider: '滑桿', AXDisclosureTriangle: '展開鈕', AXIncrementor: '增減鈕', AXStaticText: '字',
};
const GROUP_NAMES = {
  AXSheet: '對話框', AXPopover: '對話框', AXDrawer: '側欄', AXToolbar: '工具列', AXTabGroup: '分頁列',
  AXOutline: '清單', AXTable: '清單', AXList: '清單', AXBrowser: '清單', AXMenu: '選單',
};
const GROUP_SUBROLE_NAMES = {
  AXDialog: '對話框', AXSystemDialog: '對話框', AXFloatingWindow: '對話框', AXApplicationDialog: '對話框', AXApplicationAlertDialog: '對話框',
  AXLandmarkNavigation: '側欄／導覽', AXLandmarkMain: '主畫面',
};
const FIELDS = ['AXTextField', 'AXSearchField', 'AXTextArea', 'AXComboBox'];
const SETTLE_MS = 500;
const OPEN_SETTLE_MS = 1200; // 切換 app、打開網址之後等視窗出來
const TARGET_MS = 500; // 要碰的東西先亮多久才動手
const TARGET_TOOLS = ['click', 'right_click', 'fill', 'select', 'press_key'];

// 會刪東西、收不回來的事不自己做（使用者 10/30 指示：破壞性操作盡量不要做）。核心只擋「最後按下去那一下」，
// 這裡在 Mac 端多擋三處：一開始的目標（listen.mjs）、按名字是這類的按鈕與選單項目、刪除的組合鍵。
// 一般的鍵（Esc、Enter、Backspace、cmd+l…）照常可以按
const DESTRUCTIVE = /解除安裝|移除安裝|卸載|刪除|刪掉|移到垃圾桶|丟到垃圾桶|丟進垃圾桶|清空|清除|抹除|格式化|登出|關機|重新開機|重開機|uninstall|delete|move to trash|empty trash|erase|format disk|log ?out|sign ?out|shut ?down|restart/i;
const FIELD_CLEAR = /(?:清空|清除)[^，。,;；]{0,12}?(?:搜尋|搜索|輸入|欄|框|文字)/g;
const FIELD_CLEAR_AFTER = /(?:搜尋|搜索|輸入)[^，。,;；]{0,8}?(?:清空|清除)/g;
const KEY_MODS = /^(cmd|command|⌘|ctrl|control|opt|option|alt|shift)$/;

/** 目標或原話是不是刪東西這類的事：是就回那個詞（小框寫給人看），不是回空字串 */
export function destructiveText(text) {
  // 清空搜尋欄、清除輸入框裡的字：只是清掉框裡的字，先拿掉再看（「清空搜尋欄然後刪除檔案」的刪除照擋）
  const rest = String(text ?? '').replace(FIELD_CLEAR, '').replace(FIELD_CLEAR_AFTER, '');
  return rest.match(DESTRUCTIVE)?.[0] ?? '';
}

/** 刪除的組合鍵：有 cmd 又按 Backspace／Delete（Finder 的移到垃圾桶、清空垃圾桶、很多 app 的刪除）；單按 Backspace 是刪字，可以 */
export function destructiveKey(key) {
  const parts = String(key ?? '').toLowerCase().split('+').map((p) => p.trim());
  const mods = parts.filter((p) => KEY_MODS.test(p));
  const main = parts.filter((p) => !KEY_MODS.test(p));
  return mods.some((m) => ['cmd', 'command', '⌘'].includes(m)) && main.some((m) => ['backspace', 'delete', 'forwarddelete'].includes(m));
}

const REFUSED = (what) => ({ ok: false, note: `「${what}」會刪東西、收不回來，不自己做：停在這裡，用 done 說明留給使用者自己按` });

export const MAC_TOOLS = [
  ...standardTools(['click', 'fill']),
  { name: 'press_key', args: 'key（Enter、Escape、Tab、Backspace、ArrowDown、PageDown…；組合鍵寫成 cmd+l、cmd+shift+t）, ref（可省略：游標所在的地方）', about: '按一個鍵或組合鍵' },
  ...standardTools(['scroll', 'select', 'wait']),
  { name: 'right_click', args: 'ref', about: '在 ref 上按右鍵（叫出右鍵選單）' },
];

export const MAC_APP_TOOLS = [
  { name: 'menu', args: 'path（選單列一層層的名字，例如 ["檔案", "新增視窗"]）', about: '選選單列裡的項目（這個 app 的指令都在選單列）' },
  { name: 'open_app', args: 'name（app 名稱，例如 LINE、Safari、系統設定）', about: '打開或切換到某個 app' },
  { name: 'open_url', args: 'url', about: '用預設瀏覽器打開網址' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function roleName(n) {
  if (n.role === 'AXCheckBox' && ['AXSwitch', 'AXToggle'].includes(n.subrole)) return '開關';
  if ((n.role === 'AXRadioButton' && n.parent === 'AXTabGroup') || n.subrole === 'AXTabButton') return '分頁';
  return ROLE_NAMES[n.role] ?? '按鈕';
}

// 順序跟 CubeLV 一樣：選中、勾了、展開／收起、不能按，搜尋框放最前面，游標在這放最後
function statesOf(n) {
  const out = [];
  if (n.selected || (n.role === 'AXRadioButton' && n.checked)) out.push('選中');
  if (n.role === 'AXCheckBox' && n.checked) out.push('勾了');
  if (n.expanded === true) out.push('展開');
  else if (n.expanded === false) out.push('收起');
  if (n.enabled === false) out.push('不能按');
  if (n.role === 'AXSearchField' || n.subrole === 'AXSearchField') out.unshift('搜尋框');
  if (n.focused) out.push('游標在這');
  return out;
}

const center = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
const within = (item, box) => {
  const c = center(item);
  return box.w > 0 && box.h > 0 && c.x >= box.x && c.x <= box.x + box.w && c.y >= box.y && c.y <= box.y + box.h;
};

const contains = (box, p) => box.w > 0 && box.h > 0 && p.x >= box.x && p.x <= box.x + box.w && p.y >= box.y && p.y <= box.y + box.h;

/** 滑鼠指著的東西：tree 裡包含 point、在畫面上、面積最小的那個能操作的東西；點不在視窗裡（指著別的 app）就沒有 */
export function pointedNode(res, point) {
  if (!point || !res.window || !contains(res.window, point)) return null;
  let best = null;
  for (const n of res.nodes ?? []) {
    if (n.kind !== 'control' || n.off || !contains(n, point)) continue;
    if (!best || n.w * n.h < best.w * best.h) best = n;
  }
  return best;
}

/** AX 小幫手 tree 的結果 → 核心的節點（截圖認出來的字補進沒有名字的東西，剩下的列成「畫面上的字」）；
 *  pointed：pointedNode 找到的那個，標「滑鼠指著」 */
export function treeNodes(res, pointed = null) {
  const shot = readingOrder(res.ocr?.items ?? []);
  const used = new Set();
  const nodes = [];
  for (const n of res.nodes ?? []) {
    const { depth } = n;
    if (n.kind === 'group') {
      nodes.push({ depth, kind: 'group', role: GROUP_SUBROLE_NAMES[n.subrole] ?? GROUP_NAMES[n.role] ?? '區塊', name: n.name });
    } else if (n.kind === 'heading' || n.kind === 'text') {
      nodes.push({ depth, kind: n.kind, name: n.name });
    } else if (n.kind === 'scroll') {
      nodes.push({ depth, kind: 'scroll', name: n.name, states: n.states ?? [], target: { handle: n.handle } });
    } else {
      // 這個東西範圍裡認出來的字：沒有名字就拿來當名字；有名字的也收掉，免得同一段字再列一次
      const box = { x: n.x, y: n.y, w: n.w, h: n.h };
      const inside = shot.filter((item, i) => !used.has(i) && !n.off && within(item, box));
      inside.forEach((item) => used.add(shot.indexOf(item)));
      // 圖示被認成一兩個字（「①」「个」）不算名字
      const seen = inside.map((item) => item.text).join(' ').trim();
      const name = n.name || (FIELDS.includes(n.role) || seen.length < 2 ? '' : seen);
      nodes.push({
        depth, kind: 'control', role: roleName(n), name, value: n.value, states: n === pointed ? [...statesOf(n), '滑鼠指著'] : statesOf(n), off: !!n.off,
        target: { handle: n.handle, field: FIELDS.includes(n.role), name, ...(n.w > 0 && n.h > 0 ? { frame: { x: n.x, y: n.y, w: n.w, h: n.h } } : {}) },
      });
    }
  }
  const rest = shot.filter((_, i) => !used.has(i));
  if (rest.length) {
    nodes.push({ depth: 0, kind: 'group', role: '截圖認出來的字（讀不到結構，點下去是點那個位置）' });
    for (const item of rest) nodes.push({ depth: 1, kind: 'control', role: '畫面上的字', name: item.text, target: { at: center(item), name: item.text } });
  }
  return nodes;
}

export function treeHeader(res, pointed = null) {
  return [
    res.app ? `App：${res.app}${res.window?.title ? `；視窗：${res.window.title}` : ''}` : '最前面沒有 app',
    res.app && !res.window ? '（這個 app 沒有打開的視窗）' : '',
    pointed ? '標「滑鼠指著」的是使用者講話時滑鼠指著的東西：他說「這個」「這裡」「點這」多半是指它' : '',
    res.menus?.length ? `選單列（用 menu 選裡面的項目）：${res.menus.join('、')}` : '',
    res.partial ? '（畫面很大，只讀了前面一部分；要的東西不在下面就捲動，或用選單列）' : '',
    res.ocr && !res.ocr.permission ? '（這個 app 讀不到畫面，要截圖認字，但 JarvisVoice 還沒有「螢幕錄影」權限）' : '',
  ].filter(Boolean);
}

const RESULT_NOTES = {
  'not-front': '這個 app 不在最前面，沒做（按鍵、點擊會落到別的 app）',
  failed: '按不下去',
  'no-scroll-area': '畫面上沒有可以捲的地方',
  disabled: '這個選單項目現在不能按',
};

// AX 小幫手回的 { result, … } → 核心要的 { ok, note }
function outcome(r, ref, extra = {}) {
  if (!r) return { ok: false, note: 'AX 小幫手沒回' };
  if (r.result === 'ok') return { ok: true, ...extra };
  if (r.result === 'gone') return missingRef(ref);
  return { ok: false, note: RESULT_NOTES[r.result] ?? r.result };
}

const pathOf = (raw) => (Array.isArray(raw) ? raw : String(raw ?? '').split(/\s*[>＞›/／]\s*/)).map((p) => String(p).trim()).filter(Boolean);

// ax：bin/ax.mjs 的 createAx()；frontApp() → { pid }（每一步看最前面的那個 app，切到別的 app 就跟著看它）；
// openApp(name) → 有沒有打開；openUrl(url) → 有沒有打開；
// pointer：使用者講話時滑鼠在螢幕上的位置 { x, y }，只標在第一次讀的畫面上（動手之後畫面變了，同一個位置就不是他指的東西）；
// onTarget(frame)：要點、填字、選、按鍵的那個東西在螢幕上的範圍（左上角原點），通知完等 TARGET_MS 才動手，讓人看得到下一步要碰哪裡
export function createMacAgentScreen({ ax, frontApp, openApp, openUrl = defaultOpenUrl, log = () => {}, maxNodes, budgetMs, pointer = null, onTarget = null }) {
  let pid = 0;
  let reads = 0;
  const call = (op, args, timeoutMs) => ax.call(op, { pid, ...args }, timeoutMs).catch((err) => { log(`AX 小幫手 ${op} 失敗：${err.message}`); return null; });

  async function read() {
    const first = reads === 0;
    reads += 1;
    pid = (await frontApp()).pid;
    if (!pid) return { nodes: [], header: ['最前面沒有 app'] };
    const res = await call('tree', { maxNodes, budgetMs }, 20000);
    if (!res) return { nodes: [], header: ['讀不到最前面這個 app 的畫面'] };
    const pointed = first ? pointedNode(res, pointer) : null;
    log(`操作代理讀畫面：${res.app}，${res.nodes.length} 個，${res.ms} ms（讀樹 ${res.treeMs} ms，走了 ${res.seen} 個）${res.partial ? '（沒讀完）' : ''}${res.ocr ? '，截圖認字' : ''}${pointed ? `，滑鼠指著「${pointed.name}」` : ''}`);
    return { nodes: treeNodes(res, pointed), header: treeHeader(res, pointed) };
  }

  let header = [];
  const screen = createAgentScreen({
    tools: MAC_TOOLS,
    async read() {
      const view = await read();
      header = view.header;
      return view.nodes;
    },
    header: () => header,

    async act(call_, target) {
      const args = call_.args ?? {};
      const ref = args.ref != null ? String(args.ref) : '';
      if (call_.tool === 'click' && destructiveText(target?.name)) return REFUSED(target.name);
      if (call_.tool === 'select' && destructiveText(args.option)) return REFUSED(String(args.option));
      if (call_.tool === 'press_key' && destructiveKey(args.key)) return REFUSED(String(args.key));
      if (onTarget && target && TARGET_TOOLS.includes(call_.tool)) {
        // 截圖認出來的字只有一個點：亮那個點附近
        const frame = target.frame ?? (target.at ? { x: target.at.x - 30, y: target.at.y - 12, w: 60, h: 24 } : null);
        if (frame) { onTarget(frame); await sleep(TARGET_MS); }
      }
      switch (call_.tool) {
        case 'click':
        case 'right_click': {
          if (!target) return missingRef(ref);
          const right = call_.tool === 'right_click';
          if (target.at) return outcome(await call('act', { action: right ? 'rightClickAt' : 'clickAt', ...target.at }), ref);
          return outcome(await call('act', { action: right ? 'showMenu' : 'press', handle: target.handle }), ref);
        }
        case 'fill':
          if (!target) return missingRef(ref);
          if (!target.field) return { ok: false, note: `${ref} 不是輸入框` };
          return outcome(await call('act', { action: 'fill', handle: target.handle, text: String(args.text ?? '') }), ref);
        case 'press_key': {
          const key = String(args.key ?? 'Enter');
          const r = await call('act', { action: 'key', key, handle: target?.handle ?? 0 });
          return r?.result === 'unknown-key' ? { ok: false, note: `不認得「${key}」這個鍵` } : outcome(r, ref);
        }
        case 'scroll': {
          const r = await call('act', { action: 'scroll', handle: target?.handle ?? 0, direction: String(args.direction ?? 'down'), amount: Number(args.amount) || 1 });
          return outcome(r, ref, { note: r?.moved ? '捲了' : '捲不動，已經到邊了' });
        }
        case 'select': {
          if (!target) return missingRef(ref);
          const option = String(args.option ?? '').trim();
          const r = await call('act', { action: 'select', handle: target.handle, option });
          if (r?.result === 'no-option') return { ok: false, note: `沒有「${option}」這個選項${r.options?.length ? `（有：${r.options.join('、')}）` : ''}` };
          return outcome(r, ref);
        }
        case 'wait':
          await sleep(Math.max(100, Math.min(3000, Number(args.ms) || 1000)));
          return { ok: true };
        default:
          return { ok: false, note: `沒有 ${call_.tool} 這個工具` };
      }
    },

    extra: {
      tools: MAC_APP_TOOLS,
      async run(call_) {
        const args = call_.args ?? {};
        if (call_.tool === 'menu') {
          const path = pathOf(args.path);
          if (!path.length) return { ok: false, note: '要給選單的名字' };
          const bad = path.find((p) => destructiveText(p));
          if (bad) return REFUSED(bad);
          const r = await call('act', { action: 'menu', path });
          if (r?.result === 'no-menu') return { ok: false, note: `選單列裡沒有「${path[r.level ?? 0] ?? path[0]}」${r.options?.length ? `（這一層有：${r.options.join('、')}）` : ''}` };
          return outcome(r, '');
        }
        if (call_.tool === 'open_app') {
          const name = String(args.name ?? '').trim();
          if (!name || !(await openApp(name))) return { ok: false, note: `打不開「${name}」` };
          await sleep(OPEN_SETTLE_MS);
          return { ok: true };
        }
        if (call_.tool === 'open_url') {
          const url = String(args.url ?? '').trim();
          if (!url || !(await openUrl(url))) return { ok: false, note: `打不開「${url}」` };
          await sleep(OPEN_SETTLE_MS);
          return { ok: true };
        }
        return null;
      },
      // 小框寫給人看的：打開「LINE」、選選單「檔案 > 新增視窗」
      describe(call_) {
        const args = call_.args ?? {};
        if (call_.tool === 'menu') return `「${pathOf(args.path).join(' > ')}」`;
        if (call_.tool === 'open_app') return `「${String(args.name ?? '')}」`;
        if (call_.tool === 'open_url') return `「${String(args.url ?? '').replace(/^https?:\/\//, '')}」`;
        return null;
      },
    },

    settle: () => sleep(SETTLE_MS),
  });
  return screen;
}

// 網址沒寫 http 就補 https://（「youtube.com」）
function defaultOpenUrl(raw) {
  const url = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  return new Promise((resolve) => {
    execFile('/usr/bin/open', [url], { timeout: 5000 }, (err) => resolve(!err));
  });
}
