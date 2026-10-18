// 常駐的「輔助使用」小幫手（JXA）：listen.mjs 開一個一直留著，stdin／stdout 一行一個 JSON。
// 讀上下文（app、視窗、網址、輸入框、游標前後、選取）、貼上、選回剛貼的字換掉、找視窗裡的輸入框、對焦。
// 不用每句都重開 osascript，每次省 100–200 ms。
//
// 請求 { id, op, ... } → 回覆 { id, ... } 或 { id, error }：
//   check   { ask }                   → { trusted }
//   context { pid, chars, screen }    → { app, window, url, screen, frame, field: { editable, known, role, subrole, secure, label, before, selected, after, handle, caret } }
//                                       screen：要幾個字的「視窗裡看得到的字」（不含輸入框），0 就不讀
//                                       frame：視窗、caret：游標（拿不到就是輸入框）在螢幕上的位置 { x, y, w, h }（左上角原點），給游標旁的小框用
//   paste   { pid, text, dry }        → { result: ok | no-accessibility | not-text-field:<角色> | not-front | dry:<字>, handle }
//                                       按完 Cmd+V 就回覆，等 app 讀剪貼簿、還原剪貼簿（0.35 秒）在回覆之後才做
//   replace { pid, old, text }        → { result: ok | mismatch | no-field | not-front }：游標前面正好是 old 就選起來換成 text（空字串＝刪掉）
//   按鍵（Cmd+V、Delete）只在 pid 確實是最前面的 app 時才送，不然回 not-front
//   targets { pid }                   → { window: {x,y,w,h,title}, candidates: [{ handle, role, subrole, label, x, y, w, h, focused, enabled }] }
//   focus   { handle }                → { ok }
//   read    { handle }                → { value }
//   elements { pid, limit }           → { window, elements: [{ handle, role, subrole, label, x, y, w, h, focused }] }：畫面上可以操作的東西
//   act     { pid, handle, action, text, x, y } → { result: ok | gone | not-front | not-focused:<焦點角色> | failed }：press 點、fill 填字、
//                                       enter 按 Enter（焦點在剛填 text 的框才按；焦點在框的建議清單裡先按 Esc 收起來）、
//                                       clickAt 在 (x, y) 點一下滑鼠（截圖認出來的字沒有元件可以按，用這個）
//   ocr     { pid, ask }              → { permission, items: [{ text, x, y, w, h }] }：截最前面那個視窗（只在記憶體裡）認字；
//                                       順序與接成文字由 bin/ax.mjs 用核心（core/ocr.mjs）處理
// 讀不到畫面的 app（例如 LINE：只有視窗按鈕和輸入框，畫面上的字讀不到）：context 的 screen、elements 會自動改用截圖認字補上
ObjC.import('Cocoa');
ObjC.import('ApplicationServices');
ObjC.import('CoreGraphics');
ObjC.import('Vision');
// Vision 認字設定（visionItems）跟 vision-ocr.js 共用一份：vision.js 放在同一個資料夾
eval(ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(
  `${ObjC.unwrap($.NSProcessInfo.processInfo.arguments).map((a) => ObjC.unwrap(a)).find((a) => a.endsWith('ax-agent.js')).replace(/ax-agent\.js$/, '')}vision.js`,
  $.NSUTF8StringEncoding, null)));

// AXUIElementRef 在執行期是 CF 物件，全部當 id 傳：JXA 對 AX 的 out 參數型別對不上，自己綁簽名
ObjC.bindFunction('AXUIElementCreateApplication', ['id', ['int']]);
ObjC.bindFunction('AXUIElementCopyAttributeValue', ['int', ['id', 'id', 'void **']]);
ObjC.bindFunction('AXUIElementSetAttributeValue', ['int', ['id', 'id', 'id']]);
ObjC.bindFunction('AXUIElementCopyParameterizedAttributeValue', ['int', ['id', 'id', 'id', 'void **']]);
ObjC.bindFunction('AXValueCreate', ['id', ['int', 'void *']]);
ObjC.bindFunction('AXUIElementPerformAction', ['int', ['id', 'id']]);
ObjC.bindFunction('CGWindowListCopyWindowInfo', ['id', ['int', 'int']]);
ObjC.bindFunction('CGPreflightScreenCaptureAccess', ['bool', []]);
ObjC.bindFunction('CGRequestScreenCaptureAccess', ['bool', []]);
ObjC.bindFunction('CFEqual', ['bool', ['id', 'id']]);

const TEXT_ROLES = ['AXTextField', 'AXTextArea', 'AXComboBox', 'AXSearchField'];
const K_CFRANGE = 4; // kAXValueCFRangeType

// ---- 讀寫屬性 ----

function attr(el, name) {
  if (!el) return null;
  const ref = Ref();
  return $.AXUIElementCopyAttributeValue(el, $(name), ref) === 0 ? ObjC.castRefToObject(ref[0]) : null;
}

function text(el, name) {
  const v = attr(el, name);
  if (!v) return '';
  const u = ObjC.unwrap(v);
  return typeof u === 'string' ? u : '';
}

function flag(el, name) {
  const v = attr(el, name);
  return v ? ObjC.unwrap(v) === true || ObjC.unwrap(v) === 1 : null;
}

// AXValue 沒辦法直接拆，從 description 讀數字
const describe = (v) => (v ? ObjC.unwrap(v.description) : '');

function rangeOf(el) {
  const m = describe(attr(el, 'AXSelectedTextRange')).match(/location:(-?\d+) length:(\d+)/);
  return m ? { location: Number(m[1]), length: Number(m[2]) } : null;
}

function frameOf(el) {
  const p = describe(attr(el, 'AXPosition')).match(/x:(-?[\d.]+) y:(-?[\d.]+)/);
  const s = describe(attr(el, 'AXSize')).match(/w:([\d.]+) h:([\d.]+)/);
  return p && s ? { x: Number(p[1]), y: Number(p[2]), w: Number(s[1]), h: Number(s[2]) } : null;
}

function rectOf(v) {
  const m = describe(v).match(/x:(-?[\d.]+) y:(-?[\d.]+) w:([\d.]+) h:([\d.]+)/);
  return m ? { x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]) } : null;
}

// 游標在螢幕上的位置：選取範圍的外框（沒選取就是游標那一條）；有些 app 給 0×0 或原點，改用整個輸入框
function caretOf(el) {
  const range = rangeOf(el);
  if (range) {
    const ref = Ref();
    if ($.AXUIElementCopyParameterizedAttributeValue(el, $('AXBoundsForRange'), rangeValue(range.location, range.length), ref) === 0) {
      const r = rectOf(ObjC.castRefToObject(ref[0]));
      if (r && r.h > 0 && (r.x || r.y)) return r;
    }
  }
  return frameOf(el);
}

// CFRange 是兩個 64-bit 整數，拼成 16 bytes 再包成 AXValue
function rangeValue(location, length) {
  const bytes = [];
  for (let n of [location, length]) for (let i = 0; i < 8; i += 1) { bytes.push(n & 0xff); n = Math.floor(n / 256); }
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let b64 = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    b64 += A[(n >> 18) & 63] + A[(n >> 12) & 63] + (i + 1 < bytes.length ? A[(n >> 6) & 63] : '=') + (i + 2 < bytes.length ? A[n & 63] : '=');
  }
  const data = $.NSData.alloc.initWithBase64EncodedStringOptions($(b64), 0);
  return $.AXValueCreate(K_CFRANGE, data.bytes);
}

function setRange(el, location, length) {
  return $.AXUIElementSetAttributeValue(el, $('AXSelectedTextRange'), rangeValue(location, length)) === 0;
}

function stringForRange(el, location, length) {
  const ref = Ref();
  if ($.AXUIElementCopyParameterizedAttributeValue(el, $('AXStringForRange'), rangeValue(location, length), ref) !== 0) return null;
  const u = ObjC.unwrap(ObjC.castRefToObject(ref[0]));
  return typeof u === 'string' ? u : null;
}

// ---- 元件代號：回給 node 的是數字，之後可以拿來對焦、讀回 ----

const handles = new Map();
let nextHandle = 1;
function keep(el) {
  const id = nextHandle;
  nextHandle += 1;
  handles.set(id, el);
  if (handles.size > 300) handles.delete(handles.keys().next().value);
  return id;
}

function appElement(pid) {
  const app = $.AXUIElementCreateApplication(pid);
  // Chromium、Electron 要先打開輔助樹才讀得到網頁裡的欄位；其他 app 會忽略
  $.AXUIElementSetAttributeValue(app, $('AXManualAccessibility'), $.NSNumber.numberWithBool(true));
  return app;
}

function labelOf(el) {
  const title = attr(el, 'AXTitleUIElement');
  return text(el, 'AXDescription') || text(el, 'AXPlaceholderValue') || text(el, 'AXTitle')
    || (title ? text(title, 'AXValue') : '') || text(el, 'AXHelp');
}

// 目前焦點的輸入框：{ known, editable, el, root, role, subrole, secure }。讀不到（app 不支援輔助功能）就當不知道
function focusedField(app) {
  const el = attr(app, 'AXFocusedUIElement');
  if (!el) return { known: false };
  const role = text(el, 'AXRole');
  const subrole = text(el, 'AXSubrole');
  const secure = subrole === 'AXSecureTextField' || role === 'AXSecureTextField';
  if (TEXT_ROLES.includes(role) || secure) return { known: true, editable: true, el, root: el, role, subrole, secure };
  // 網頁裡的 contenteditable 編輯器：Chromium／WebKit 會掛可編輯的祖先，值和游標要從祖先讀
  const ancestor = attr(el, 'AXEditableAncestor');
  if (ancestor) return { known: true, editable: true, el, root: ancestor, role, subrole, secure: false };
  return { known: true, editable: false, el, role, subrole };
}

function webAreaOf(el) {
  let cur = el;
  for (let i = 0; cur && i < 80; i += 1) {
    if (text(cur, 'AXRole') === 'AXWebArea') return cur;
    cur = attr(cur, 'AXParent');
  }
  return null;
}

// 廣度優先走 AX 樹：webAreas 收網頁區塊（不往裡走），fields 收原生輸入框
function walk(root, limit) {
  const webAreas = [];
  const fields = [];
  const queue = [root];
  let seen = 0;
  while (queue.length && seen < limit) {
    const el = queue.shift();
    seen += 1;
    const role = text(el, 'AXRole');
    if (role === 'AXWebArea') { webAreas.push(el); continue; }
    if (TEXT_ROLES.includes(role)) { fields.push(el); continue; }
    const kids = attr(el, 'AXChildren');
    if (kids) for (let i = 0; i < kids.count; i += 1) queue.push(kids.objectAtIndex(i));
  }
  return { webAreas, fields };
}

function urlOf(web) {
  const v = attr(web, 'AXURL');
  if (!v) return '';
  try { return ObjC.unwrap(v.absoluteString) || ''; } catch (err) { return ''; }
}

// 視窗裡看得到的字（不含輸入框裡的），照畫面由上往下，取最後 chars 個字：給 AI 判斷在討論什麼、專有名詞怎麼寫
function screenText(win, chars) {
  const parts = [];
  const push = (value) => {
    const t = (value || '').replace(/\s+/g, ' ').trim();
    if (t && parts[parts.length - 1] !== t) parts.push(t);
  };
  const { webAreas } = walk(win, 600);
  const params = $.NSDictionary.dictionaryWithObjectsForKeys(
    $([$('AXStaticTextSearchKey'), $.NSNumber.numberWithInt(600), $('AXDirectionNext'), $.NSNumber.numberWithBool(false), $.NSNumber.numberWithBool(true)]),
    $(['AXSearchKey', 'AXResultsLimit', 'AXDirection', 'AXImmediateDescendantsOnly', 'AXVisibleOnly']),
  );
  for (const web of webAreas) {
    const ref = Ref();
    if ($.AXUIElementCopyParameterizedAttributeValue(web, $('AXUIElementsForSearchPredicate'), params, ref) !== 0) continue;
    const list = ObjC.castRefToObject(ref[0]);
    for (let i = 0; i < list.count; i += 1) {
      const el = list.objectAtIndex(i);
      if (attr(el, 'AXEditableAncestor')) continue; // 輸入框裡的字不算
      push(text(el, 'AXValue') || text(el, 'AXTitle') || text(el, 'AXDescription'));
    }
  }
  if (!webAreas.length) {
    // 原生 app：走 AX 樹收靜態文字
    const queue = [win];
    let seen = 0;
    while (queue.length && seen < 2000) {
      const el = queue.shift();
      seen += 1;
      const role = text(el, 'AXRole');
      if (TEXT_ROLES.includes(role)) continue;
      if (role === 'AXStaticText') { push(text(el, 'AXValue')); continue; }
      const kids = attr(el, 'AXChildren');
      if (kids) for (let i = 0; i < kids.count; i += 1) queue.push(kids.objectAtIndex(i));
    }
  }
  const all = parts.join(' ');
  return all.length > chars ? all.slice(all.length - chars) : all;
}

// ---- 讀不到畫面時：截圖認字 ----

const TINY = (e) => e.w < 20 && e.h < 20; // 視窗左上角的關閉、縮放這類小按鈕

// 畫面上能操作的東西，扣掉輸入框和視窗小按鈕，少於 3 個就當這個 app 讀不到畫面（例如 LINE）
function looksOpaque(list) {
  return list.filter((e) => !TEXT_ROLES.includes(e.role) && !TINY(e)).length < 3;
}

// 這個 pid 最前面的一般視窗：{ id, x, y, w, h }
function windowOf(pid) {
  const list = $.CGWindowListCopyWindowInfo(1 | 16, 0); // 螢幕上看得到的、不含桌面
  for (let i = 0; list && i < list.count; i += 1) {
    const w = list.objectAtIndex(i);
    if (Number(ObjC.unwrap(w.objectForKey('kCGWindowOwnerPID'))) !== pid) continue;
    if (Number(ObjC.unwrap(w.objectForKey('kCGWindowLayer'))) !== 0) continue;
    const b = w.objectForKey('kCGWindowBounds');
    const n = (k) => Number(ObjC.unwrap(b.objectForKey(k)));
    return { id: Number(ObjC.unwrap(w.objectForKey('kCGWindowNumber'))), x: n('X'), y: n('Y'), w: n('Width'), h: n('Height') };
  }
  return null;
}

let askedCapture = false;
// 截視窗（只在記憶體裡）→ macOS 內建文字辨識 → 每段字和它在螢幕上的位置。圖片認完就丟，不存檔、不送出去
function ocr({ pid, ask = true }) {
  if (!$.CGPreflightScreenCaptureAccess()) {
    if (ask && !askedCapture) { askedCapture = true; $.CGRequestScreenCaptureAccess(); }
    return { permission: false, items: [] };
  }
  const win = windowOf(pid);
  if (!win) return { permission: true, items: [] };
  // 直接用系統橋接呼叫（自己綁簽名的話 CGRect 參數會傳錯，截成整個螢幕）：只這個視窗、不含陰影、原始解析度
  const image = $.CGWindowListCreateImage($.CGRectNull, $.kCGWindowListOptionIncludingWindow, win.id,
    $.kCGWindowImageBoundsIgnoreFraming | $.kCGWindowImageBestResolution);
  if (!image) return { permission: true, items: [] };
  // 認字設定在 vision.js（跟平行沙盒桌面版同一份）；位置從 0–1 換成螢幕座標
  const items = visionItems(image).map((i) => ({ text: i.text, x: win.x + i.x * win.w, y: win.y + i.y * win.h, w: i.w * win.w, h: i.h * win.h }));
  // 排順序、接成文字在核心（core/ocr.mjs），由 bin/ax.mjs 收到後處理
  return { permission: true, items };
}

function clickAt(x, y) {
  for (const type of [1, 2]) { // 左鍵按下、放開
    const ev = $.CGEventCreateMouseEvent($(), type, $.CGPointMake(x, y), 0);
    $.CGEventPost(0, ev);
    delay(0.05);
  }
}

// ---- 操作 ----

function context({ pid, chars = 400, screen = 0 }) {
  const app = appElement(pid);
  const running = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
  const win = attr(app, 'AXFocusedWindow');
  const out = {
    app: running && !running.isNil() ? ObjC.unwrap(running.localizedName) || '' : '',
    window: text(win, 'AXTitle'),
    url: '',
    field: { known: false, editable: false },
    frame: win ? frameOf(win) : null,
  };
  const f = focusedField(app);
  const web = f.el ? webAreaOf(f.el) : null;
  out.url = web ? urlOf(web) : win ? (walk(win, 300).webAreas.map(urlOf).find(Boolean) || '') : '';
  if (screen && win) {
    out.screen = screenText(win, screen);
    out.screenSource = 'ax';
    // 畫面上的字讀不到、能操作的東西也幾乎沒有：改用截圖認字
    if (!out.screen && looksOpaque(elements({ pid, limit: 40 }).elements)) {
      const seen = ocr({ pid });
      out.screen = '';
      out.screenOcr = seen.items; // bin/ax.mjs 用核心的 ocrText 接成字
      out.screenSource = seen.permission ? 'ocr' : 'no-permission';
    }
  }
  if (!f.known) return out;
  out.field = { known: true, editable: f.editable, role: f.role, subrole: f.subrole, secure: !!f.secure };
  if (!f.editable) return out;
  out.field.label = labelOf(f.root) || labelOf(f.el);
  out.field.handle = keep(f.root);
  out.field.caret = caretOf(f.root);
  const range = rangeOf(f.root);
  const count = Number(ObjC.unwrap(attr(f.root, 'AXNumberOfCharacters')) || 0);
  if (!range) return out;
  const { location, length } = range;
  let value = null;
  let offset = 0;
  if (count > 20000) {
    // 很長的文件只讀游標附近
    offset = Math.max(0, location - chars);
    value = stringForRange(f.root, offset, Math.min(count - offset, length + chars * 2 + (location - offset)));
  } else {
    value = text(f.root, 'AXValue');
  }
  if (typeof value !== 'string') return out;
  const at = location - offset;
  out.field.before = value.slice(Math.max(0, at - chars), at);
  out.field.selected = value.slice(at, at + length);
  out.field.after = value.slice(at + length, at + length + chars);
  return out;
}

function snapshot(pb) {
  const saved = [];
  const items = pb.pasteboardItems;
  for (let i = 0; i < items.count; i += 1) {
    const item = items.objectAtIndex(i);
    const types = item.types;
    const entry = [];
    for (let j = 0; j < types.count; j += 1) {
      const type = types.objectAtIndex(j);
      const data = item.dataForType(type);
      if (data && !data.isNil()) entry.push([type, data]);
    }
    saved.push(entry);
  }
  return saved;
}

function restore(pb, saved) {
  pb.clearContents;
  if (!saved.length) return;
  const objects = $.NSMutableArray.array;
  for (const entry of saved) {
    const item = $.NSPasteboardItem.alloc.init;
    for (const [type, data] of entry) item.setDataForType(data, type);
    objects.addObject(item);
  }
  pb.writeObjects(objects);
}

function pressKey(code, command) {
  const source = $.CGEventSourceCreate(0); // kCGEventSourceStateCombinedSessionState
  const down = $.CGEventCreateKeyboardEvent(source, code, true);
  const up = $.CGEventCreateKeyboardEvent(source, code, false);
  const flags = command ? 0x100000 : 0; // kCGEventFlagMaskCommand
  $.CGEventSetFlags(down, flags);
  $.CGEventSetFlags(up, flags);
  $.CGEventPost(0, down); // kCGHIDEventTap
  $.CGEventPost(0, up);
}

const KEY_V = 9;
const KEY_A = 0;
const KEY_DELETE = 51;
const KEY_RETURN = 36;
const KEY_ESCAPE = 53;
const POPUP_ROLES = ['AXList', 'AXMenu', 'AXTable', 'AXOutline'];

// 要按 Enter 前，app 的焦點在哪：
//   field：在剛填字的框（或同一個框重畫出來的元件：單行輸入框，裡面就是剛填的字）
//   option：在框的建議清單裡被選起來的那一項。網頁搜尋框打完字跳出建議清單、滑鼠剛好停在清單上時，
//           Chrome 會把焦點報在那一項（aria-activedescendant），框本身的 AXFocused 是 false；這時按 Enter 會打開那一項，不是搜尋
//   other：別的地方（例如訊息框），不按
function enterTarget(pid, el, value) {
  if (flag(el, 'AXFocused') === true) return { where: 'field' };
  const f = attr(appElement(pid), 'AXFocusedUIElement');
  if (!f) return { where: 'other', role: '' };
  if ($.CFEqual(f, el)) return { where: 'field' };
  const role = text(f, 'AXRole');
  if (['AXTextField', 'AXComboBox', 'AXSearchField'].includes(role)) {
    return value && (text(f, 'AXValue') || '').includes(value) ? { where: 'field' } : { where: 'other', role };
  }
  let p = attr(f, 'AXParent');
  for (let i = 0; p && i < 8; i += 1) {
    if ($.CFEqual(p, el) || POPUP_ROLES.includes(text(p, 'AXRole'))) return { where: 'option', role };
    p = attr(p, 'AXParent');
  }
  return { where: 'other', role };
}

// 回覆送出後才做的事（貼上後等 app 讀剪貼簿、還原剪貼簿）：node 不用等這 0.35 秒，下一個請求才會等
let afterReply = null;

// 暫存剪貼簿 → 放字 → Cmd+V → （回覆之後）等 app 讀完 → 還原剪貼簿
function pasteText(value, dry) {
  const pb = $.NSPasteboard.generalPasteboard;
  const saved = snapshot(pb);
  pb.clearContents;
  pb.setStringForType($(value), $.NSPasteboardTypeString);
  let placed = '';
  if (dry) placed = ObjC.unwrap(pb.stringForType($.NSPasteboardTypeString)) || '';
  else pressKey(KEY_V, true);
  afterReply = () => { delay(0.35); restore(pb, saved); };
  return placed;
}

// 按鍵只會送到最前面的 app：送之前確認最前面的就是要寫的那個，不然 Cmd+V、Delete 會落到別的 app。
// 問 app 自己的 AXFrontmost（系統層的 AXFocusedApplication 在這裡讀不到）
function isFront(pid) {
  return flag($.AXUIElementCreateApplication(pid), 'AXFrontmost') === true;
}

function trusted(ask) {
  if ($.AXIsProcessTrusted()) return true;
  if (ask) $.AXIsProcessTrustedWithOptions($.NSDictionary.dictionaryWithObjectForKey($.NSNumber.numberWithBool(true), $('AXTrustedCheckOptionPrompt')));
  return false;
}

function paste({ pid, text: value, dry, ask }) {
  if (!dry && !trusted(ask)) return { result: 'no-accessibility' };
  const f = pid ? focusedField(appElement(pid)) : { known: false };
  if (f.known && !f.editable) return { result: `not-text-field:${f.role}` };
  if (!dry && pid && !isFront(pid)) return { result: 'not-front' };
  const placed = pasteText(value, dry);
  return { result: dry ? `dry:${placed}` : 'ok', handle: f.root ? keep(f.root) : 0 };
}

// 游標前面正好是剛貼的 old：選起來，換成 text（空字串就刪掉）。對不上就不動
function replace({ pid, old, text: value }) {
  if (!trusted(false)) return { result: 'no-accessibility' };
  const f = focusedField(appElement(pid));
  if (!f.editable) return { result: 'no-field' };
  const range = rangeOf(f.root);
  if (!range || range.length || range.location < old.length) return { result: 'mismatch' };
  const start = range.location - old.length;
  const before = stringForRange(f.root, start, old.length) ?? text(f.root, 'AXValue').slice(start, range.location);
  if (before !== old) return { result: 'mismatch' };
  if (!isFront(pid)) return { result: 'not-front' };
  if (!setRange(f.root, start, old.length) || text(f.root, 'AXSelectedText') !== old) {
    setRange(f.root, range.location, 0);
    return { result: 'mismatch' };
  }
  if (value) pasteText(value, false);
  else pressKey(KEY_DELETE, false);
  return { result: 'ok' };
}

function targets({ pid }) {
  const app = appElement(pid);
  const win = attr(app, 'AXFocusedWindow') || attr(app, 'AXMainWindow');
  if (!win) return { window: null, candidates: [] };
  const found = walk(win, 2000);
  const elements = [...found.fields];
  const params = $.NSDictionary.dictionaryWithObjectsForKeys(
    $([$('AXTextFieldSearchKey'), $.NSNumber.numberWithInt(60), $('AXDirectionNext'), $.NSNumber.numberWithBool(false)]),
    $(['AXSearchKey', 'AXResultsLimit', 'AXDirection', 'AXImmediateDescendantsOnly']),
  );
  for (const web of found.webAreas) {
    const ref = Ref();
    if ($.AXUIElementCopyParameterizedAttributeValue(web, $('AXUIElementsForSearchPredicate'), params, ref) !== 0) continue;
    const list = ObjC.castRefToObject(ref[0]);
    for (let i = 0; i < list.count; i += 1) elements.push(list.objectAtIndex(i));
  }
  const candidates = elements.map((el) => ({
    handle: keep(el),
    role: text(el, 'AXRole'),
    subrole: text(el, 'AXSubrole'),
    label: labelOf(el),
    ...(frameOf(el) ?? { x: 0, y: 0, w: 0, h: 0 }),
    focused: flag(el, 'AXFocused') === true,
    enabled: flag(el, 'AXEnabled') !== false,
  }));
  return { window: { ...(frameOf(win) ?? {}), title: text(win, 'AXTitle') }, candidates };
}

function focus({ handle }) {
  const el = handles.get(handle);
  if (!el) return { ok: false };
  $.AXUIElementSetAttributeValue(el, $('AXFocused'), $.NSNumber.numberWithBool(true));
  delay(0.05);
  return { ok: flag(el, 'AXFocused') === true };
}

function read({ handle }) {
  const el = handles.get(handle);
  if (!el) return { value: null };
  const value = attr(el, 'AXValue');
  const u = value ? ObjC.unwrap(value) : null;
  return { value: typeof u === 'string' ? u : null };
}

// ---- 指令模式：列出畫面上可以操作的東西、點、填字 ----

const CONTROL_ROLES = ['AXButton', 'AXLink', 'AXTextField', 'AXTextArea', 'AXComboBox', 'AXSearchField', 'AXPopUpButton',
  'AXMenuButton', 'AXCheckBox', 'AXRadioButton', 'AXRow', 'AXCell', 'AXDisclosureTriangle', 'AXIncrementor'];
const LEAF_ROLES = ['AXButton', 'AXLink', 'AXTextField', 'AXTextArea', 'AXComboBox', 'AXSearchField', 'AXPopUpButton', 'AXMenuButton', 'AXCheckBox', 'AXRadioButton'];

// 元件上的字：標題、說明、值，沒有就拿底下第一段字（清單列、連結常這樣）
function textInside(el, depth = 0) {
  const own = text(el, 'AXTitle') || text(el, 'AXDescription') || text(el, 'AXValue');
  if (own || depth > 3) return own;
  const kids = attr(el, 'AXChildren');
  if (!kids) return '';
  const parts = [];
  for (let i = 0; i < kids.count && parts.join(' ').length < 60; i += 1) {
    const t = textInside(kids.objectAtIndex(i), depth + 1);
    if (t) parts.push(t);
  }
  return parts.join(' ');
}

function elements({ pid, limit = 150, ocr: withOcr = 'never' }) {
  const app = appElement(pid);
  const win = attr(app, 'AXFocusedWindow') || attr(app, 'AXMainWindow');
  if (!win) return { window: null, elements: [] };
  const box = frameOf(win);
  const found = [];
  const webAreas = [];
  const queue = [win];
  let seen = 0;
  while (queue.length && seen < 2500) {
    const el = queue.shift();
    seen += 1;
    const role = text(el, 'AXRole');
    if (role === 'AXWebArea') { webAreas.push(el); continue; }
    if (CONTROL_ROLES.includes(role)) found.push(el);
    if (LEAF_ROLES.includes(role) || role === 'AXRow') continue;
    const kids = attr(el, 'AXChildren');
    if (kids) for (let i = 0; i < kids.count; i += 1) queue.push(kids.objectAtIndex(i));
  }
  const params = $.NSDictionary.dictionaryWithObjectsForKeys(
    $([$(['AXLinkSearchKey', 'AXButtonSearchKey', 'AXTextFieldSearchKey']), $.NSNumber.numberWithInt(300), $('AXDirectionNext'),
      $.NSNumber.numberWithBool(false), $.NSNumber.numberWithBool(true)]),
    $(['AXSearchKey', 'AXResultsLimit', 'AXDirection', 'AXImmediateDescendantsOnly', 'AXVisibleOnly']),
  );
  for (const web of webAreas) {
    const ref = Ref();
    if ($.AXUIElementCopyParameterizedAttributeValue(web, $('AXUIElementsForSearchPredicate'), params, ref) !== 0) continue;
    const list = ObjC.castRefToObject(ref[0]);
    for (let i = 0; i < list.count; i += 1) found.push(list.objectAtIndex(i));
  }
  const out = [];
  for (const el of found) {
    const frame = frameOf(el);
    if (!frame || frame.w < 4 || frame.h < 4) continue;
    // 只留視窗裡看得到的
    if (box && (frame.x + frame.w < box.x || frame.x > box.x + box.w || frame.y + frame.h < box.y || frame.y > box.y + box.h)) continue;
    const role = text(el, 'AXRole');
    const isField = TEXT_ROLES.includes(role);
    // 輸入框：名字只看標籤、提示字，裡面已經打的字另外放（不然搜尋框打了「BU」就會被當成叫「BU」的東西）
    const label = (isField ? labelOf(el) : labelOf(el) || textInside(el)).replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!label && !isField) continue;
    const value = isField ? text(el, 'AXValue').replace(/\s+/g, ' ').trim().slice(0, 40) : '';
    out.push({ handle: keep(el), role, subrole: text(el, 'AXSubrole'), label, value, ...frame, focused: flag(el, 'AXFocused') === true });
    if (out.length >= limit) break;
  }
  // withOcr：'auto' 讀不到畫面才截圖認字，'always' 一定截（測試用）
  let source = 'ax';
  if (withOcr === 'always' || (withOcr === 'auto' && looksOpaque(out))) {
    const seen = ocr({ pid });
    source = seen.permission ? 'ocr' : 'no-permission';
    // 認出來的字落在已經讀得到的元件裡（例如搜尋框裡打的字）就不重複列，免得決策器點到框裡的字
    const inside = (item) => out.some((e) => {
      const cx = item.x + item.w / 2;
      const cy = item.y + item.h / 2;
      return cx >= e.x && cx <= e.x + e.w && cy >= e.y && cy <= e.y + e.h;
    });
    // 全部交回去：bin/ax.mjs 照核心的閱讀順序排好再取到 limit 個
    for (const item of seen.items.filter((i) => !inside(i))) {
      out.push({ handle: 0, role: 'OCRText', subrole: '', label: item.text.slice(0, 60), x: item.x, y: item.y, w: item.w, h: item.h, focused: false, ocr: true });
    }
  }
  return { window: { ...(box ?? {}), title: text(win, 'AXTitle') }, elements: out, source };
}

function act({ pid, handle, action, text: value = '', x, y }) {
  if (action === 'clickAt') {
    if (!isFront(pid)) return { result: 'not-front' };
    clickAt(x, y);
    return { result: 'ok' };
  }
  const el = handles.get(handle);
  if (!el) return { result: 'gone' };
  if (action === 'press') {
    for (const name of ['AXPress', 'AXConfirm', 'AXPick']) {
      if ($.AXUIElementPerformAction(el, $(name)) === 0) return { result: 'ok' };
    }
    // 清單列這類沒有 AXPress 的：選起來
    if ($.AXUIElementSetAttributeValue(el, $('AXSelected'), $.NSNumber.numberWithBool(true)) === 0) return { result: 'ok' };
    return { result: 'failed' };
  }
  // app 在最前面：照真人的方式按鍵（網頁的輸入框最穩）；不在前面：直接設值、觸發確認，不送按鍵
  const front = isFront(pid);
  if (action === 'fill') {
    if (!front) {
      if ($.AXUIElementSetAttributeValue(el, $('AXValue'), $(value)) !== 0 || text(el, 'AXValue') !== value) return { result: 'not-front' };
      return { result: 'ok' };
    }
    $.AXUIElementSetAttributeValue(el, $('AXFocused'), $.NSNumber.numberWithBool(true));
    delay(0.1);
    pressKey(KEY_A, true); // 全選，填進去的字取代原本的
    pasteText(value, false);
    return { result: 'ok' };
  }
  if (action === 'enter') {
    if (!front) return { result: $.AXUIElementPerformAction(el, $('AXConfirm')) === 0 ? 'ok' : 'not-front' };
    // 只在游標確實在剛填字的那個框時按：游標在訊息框按 Enter 會把訊息送出去。
    // 焦點在框的建議清單裡：先按一次 Esc 收起清單（不按 Enter 去打開被選起來的那一項），框有焦點、字還在才按
    let at = enterTarget(pid, el, value);
    if (at.where === 'option') {
      pressKey(KEY_ESCAPE, false);
      delay(0.2);
      at = enterTarget(pid, el, value);
      if (at.where === 'field' && value && !(text(el, 'AXValue') || '').includes(value)) at = { where: 'other', role: 'cleared' };
    }
    if (at.where !== 'field') return { result: `not-focused${at.role ? `:${at.role}` : ''}` };
    pressKey(KEY_RETURN, false);
    return { result: 'ok' };
  }
  return { result: 'failed' };
}

const OPS = {
  check: ({ ask }) => ({ trusted: trusted(ask) }),
  context,
  paste,
  replace,
  targets,
  focus,
  read,
  elements,
  act,
  ocr: (args) => ocr(args),
};

// ---- 主迴圈：一行一個請求 ----

function reply(out, message) {
  out.writeData($(`${JSON.stringify(message)}\n`).dataUsingEncoding($.NSUTF8StringEncoding));
}

function run() {
  const input = $.NSFileHandle.fileHandleWithStandardInput;
  const out = $.NSFileHandle.fileHandleWithStandardOutput;
  let buffer = '';
  for (;;) {
    const data = input.availableData;
    if (Number(data.length) === 0) return ''; // node 關掉 stdin 就結束
    buffer += ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding)) || '';
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (!line) continue;
      let request = {};
      try {
        request = JSON.parse(line);
        const op = OPS[request.op];
        if (!op) throw new Error(`不認得的操作 ${request.op}`);
        reply(out, { id: request.id, ...op(request) });
      } catch (err) {
        reply(out, { id: request.id, error: String(err) });
      }
      if (afterReply) {
        const later = afterReply;
        afterReply = null;
        try { later(); } catch (err) { /* 剪貼簿還原不了：使用者的剪貼簿會是剛貼的字 */ }
      }
    }
  }
}
