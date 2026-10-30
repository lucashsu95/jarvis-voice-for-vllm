// 「JarvisVoice」選單列的介面與常駐程式管理。由 app/main.js（包進 .app 的外殼）啟動時讀進來執行，
// 所以改這個檔不用重包 app，麥克風與輔助使用權限也不用重給；改完從選單「結束」再打開 app 就生效。
// 帶起常駐程式 bin/listen.mjs（它掛了 3 秒後自己重開），狀態全顯示在選單列的圖示上。
// 圖示平常是「JarvisVoice」標誌：單循環箭頭包住三條聲波（自動＋聲音）；有事時整個換成大圖（看「選單列圖示」那段）。
// 固定寬度、不加字（加字會讓旁邊的圖示跳來跳去），顏色交給系統（範本圖，跟其他選單列圖示同色）。
// 選單可以切 AI 整理（關／OpenAI／DeepSeek／Claude）、自動找輸入框、語音指令，改的是設定檔，常駐程式會自己換；
// 「換回原文」把上一段 AI 整理過的字換回轉寫原稿。
// BUILD（{ node, repo, state }）由外殼放在全域。
const LISTEN = `${BUILD.repo}/bin/listen.mjs`;
// BUILD.node 是打包那一刻的 node 路徑；mise／brew 之後更新 node，路徑就失效、常駐程式開不起來。
// 重包 app 會換簽名、麥克風與輔助使用權限要重給，所以這裡在 runtime 依序找實際存在的 node。
function resolveNode() {
  const home = ObjC.unwrap($.NSHomeDirectory());
  const candidates = [BUILD.node, `${home}/.local/share/mise/shims/node`];
  const installs = `${home}/.local/share/mise/installs/node`;
  const list = ObjC.unwrap(fm().directoryContentsAtPath(installs)) || [];
  const vers = list.filter((v) => /^\d+\.\d+\.\d+$/.test(v))
    .sort((a, b) => {
      const p = a.split('.').map(Number), q = b.split('.').map(Number);
      for (let i = 0; i < 3; i++) if (p[i] !== q[i]) return p[i] - q[i];
      return 0;
    });
  if (vers.length) candidates.push(`${installs}/${vers[vers.length - 1]}/bin/node`);
  candidates.push('/opt/homebrew/bin/node', '/usr/local/bin/node');
  for (const c of candidates) if (c && fm().fileExistsAtPath(c)) return c;
  return null;
}
// 系統語言是中文就顯示中文，其他都用英文（VOICE_DICTATION_LANG 可以指定，測試用）
const LANG = ObjC.unwrap($.NSProcessInfo.processInfo.environment.objectForKey('VOICE_DICTATION_LANG'))
  || ObjC.unwrap($.NSLocale.preferredLanguages.firstObject) || '';
const ZH = /^zh/i.test(LANG);
const t = (zh, en) => (ZH ? zh : en);
const ENGINE_NAMES = { local: t('本機', 'on-device'), openai: 'OpenAI', parallelsandbox: t('平行沙盒', 'ParallelSandbox') };
const GUIDE_URL = 'https://github.com/urusaqqrun/jarvis-voice#readme';
const AI_NAMES = { openai: 'OpenAI', deepseek: 'DeepSeek', claude: 'Claude', 'openai-compatible': t('vLLM（OpenAI 相容）', 'vLLM (OpenAI-compatible)') };
// ObjC selector 不能吃連字號，openai-compatible 要用專門的 selector
const AI_ACTIONS = { openai: 'aiOpenai:', deepseek: 'aiDeepseek:', claude: 'aiClaude:', 'openai-compatible': 'aiVllm:' };

let statusItem = null;
let statusLine = null;
let toggleItem = null;
let controller = null;
let task = null;
let quitting = false;
let buffer = '';
let view = { state: 'starting', message: '', engine: '' };
let hearing = false; // 常駐程式說聽到人聲
let working = false; // 常駐程式說有句子在轉寫、整理或等著寫（辨識中）
let level = 0; // 說話中的音量 0–1（常駐程式每 0.1 秒送一次）
let levelAt = 0;
let animTimer = null; // 說話中、辨識中時每 0.1 秒換一張圖
let flash = null; // { kind: 'pasted' | 'nofield', until }：短暫顯示的結果
// 常駐程式報上來的設定（settings 事件）
let settings = { ai: { enabled: false, provider: 'deepseek', ready: false }, autoFocus: false, commands: false, decider: '' };
let aiMenuItem = null;
let aiOffItem = null;
const aiItems = {};
let autoFocusItem = null;
let commandsItem = null;

const statePath = (name) => `${BUILD.state}/${name}`;
const fm = () => $.NSFileManager.defaultManager;

function label() {
  const name = ENGINE_NAMES[view.engine] ? t(`（${ENGINE_NAMES[view.engine]}）`, ` (${ENGINE_NAMES[view.engine]})`) : '';
  switch (view.state) {
    case 'listening': return settings.ai.enabled && settings.ai.ready
      ? t(`聽著${name}：講完一段，${AI_NAMES[settings.ai.provider]} 整理後寫進輸入框`, `Listening${name}: each passage is cleaned up by ${AI_NAMES[settings.ai.provider]} and typed in`)
      : t(`聽著${name}：講完一句就貼進游標所在的輸入框`, `Listening${name}: each sentence is pasted where your cursor is`);
    case 'standby': return t(`待命${name}：最前面的 app 不收音`, `Standing by${name}: the frontmost app is excluded`);
    case 'paused': return t(`已暫停${name}`, `Paused${name}`);
    case 'error': return t(`出錯：${view.message}`, `Error: ${view.message}`);
    case 'already-running': return t('已經有另一個 JarvisVoice 在跑，等它結束後接手', 'Another JarvisVoice is running; taking over when it exits');
    case 'off': return t('常駐程式沒在跑，重新啟動中…', 'The background process stopped; restarting…');
    default: return t('啟動中…', 'Starting…');
  }
}

// ── 選單列圖示：20×18 點的格子（左下角原點），黑色加透明度畫，系統再依選單列換成白或黑 ──
// 平常（收音中）是 JarvisVoice 標誌：循環箭頭包住三條聲波。有事時整個換成 16 點高的大圖，一眼看得出狀況：
//   說話中＝五條聲波跟著音量動、辨識中＝標誌的循環箭頭在轉（停下到貼上：轉寫＋AI 整理）、已貼上＝打勾、
//   沒貼上＝叉叉（游標不在輸入框）、出錯＝三角形驚嘆號、待命＝標誌變淡（最前面的 app 不收音）、暫停＝標誌加一條斜線。
// 設計稿：https://claude.ai/artifact/4JHjaYSLyB8ptFdb52vYDQ
const ICON_W = 20;
const ICON_H = 18;
const QUIET = [3, 5, 8, 5, 3]; // 五條聲波最矮的樣子：說話中至少這麼高
const BAR_X = [2, 6, 10, 14, 18];
const BAR_WEIGHT = [0.62, 0.86, 1, 0.86, 0.62];

function iconPath(points) {
  const p = $.NSBezierPath.bezierPath;
  points.forEach(([x, y], i) => (i ? p.lineToPoint($.NSMakePoint(x, y)) : p.moveToPoint($.NSMakePoint(x, y))));
  return p;
}

function iconRect(x, y, w, h, alpha = 1) {
  $.NSColor.colorWithWhiteAlpha(0, alpha).set;
  const r = Math.min(w, h) / 2;
  $.NSBezierPath.bezierPathWithRoundedRectXRadiusYRadius($.NSMakeRect(x, y, w, h), r, r).fill;
}

function iconStroke(points, width = 1.5) {
  $.NSColor.blackColor.set;
  const p = iconPath(points);
  p.setLineWidth(width);
  p.setLineCapStyle(1); // 圓頭
  p.setLineJoinStyle(1);
  p.stroke;
}

// 之後畫的東西改成挖空（透明），畫完 fn 再換回來
function clearing(fn) {
  const ctx = $.NSGraphicsContext.currentContext;
  ctx.setCompositingOperation(0); // NSCompositingOperationClear
  fn();
  ctx.setCompositingOperation(2); // NSCompositingOperationSourceOver
}

// 整組先畫在一張不透明的小圖上，再用 alpha 貼上來：箭頭跟圓線重疊的地方才不會比較深
function withAlpha(alpha, fn) {
  if (alpha >= 1) { fn(); return; }
  const layer = $.NSImage.alloc.initWithSize($.NSMakeSize(ICON_W, ICON_H));
  layer.lockFocus;
  fn();
  layer.unlockFocus;
  layer.drawInRectFromRectOperationFraction($.NSMakeRect(0, 0, ICON_W, ICON_H), $.NSZeroRect, 2, alpha);
}

// JarvisVoice 標誌：圓心 (10, 9)、半徑 7.5，缺口在右上。箭頭底邊中點在 50°、尖端落在圓上 84°，
// 圓線從 54°（藏在箭頭裡）順時針畫到 102°，跟箭頭尖端留一段空隙。spin 是整圈轉的角度（逆時針，跟箭頭同方向）
function drawBrand({ bars = true, spin = 0 } = {}) {
  const R = 7.5;
  const cx = 10;
  const cy = 9;
  $.NSGraphicsContext.saveGraphicsState;
  if (spin) {
    const turn = $.NSAffineTransform.transform;
    turn.translateXByYBy(cx, cy);
    turn.rotateByDegrees(spin);
    turn.translateXByYBy(-cx, -cy);
    turn.concat;
  }
  $.NSColor.blackColor.set;
  const at = (deg) => [cx + R * Math.cos((deg * Math.PI) / 180), cy + R * Math.sin((deg * Math.PI) / 180)];
  const ring = $.NSBezierPath.bezierPath;
  ring.appendBezierPathWithArcWithCenterRadiusStartAngleEndAngleClockwise($.NSMakePoint(cx, cy), R, 54, 102, true);
  ring.setLineWidth(1.8);
  ring.stroke;
  const [bx, by] = at(50);
  const [tx, ty] = at(84);
  const len = Math.hypot(tx - bx, ty - by);
  const [nx, ny] = [(ty - by) / len, -(tx - bx) / len]; // 跟箭頭方向垂直
  const half = 2.7;
  const tip = iconPath([[tx, ty], [bx + nx * half, by + ny * half], [bx - nx * half, by - ny * half]]);
  tip.closePath;
  tip.fill;
  $.NSGraphicsContext.restoreGraphicsState;
  if (bars) [[-2.7, 3.6], [0, 7], [2.7, 4.4]].forEach(([dx, h]) => iconRect(cx + dx - 0.9, cy - h / 2, 1.8, h));
}

// 說話中：五條聲波，高度由 animFrame 照音量算好
function drawBars(heights) {
  BAR_X.forEach((x, i) => iconRect(x - 1.1, ICON_H / 2 - heights[i] / 2, 2.2, heights[i]));
}

function drawWarning() {
  $.NSColor.blackColor.set;
  const tri = iconPath([[10, 16.4], [18.25, 1.9], [1.75, 1.9]]);
  tri.closePath;
  tri.setLineWidth(1.6);
  tri.setLineJoinStyle(1);
  tri.fill;
  tri.stroke;
  clearing(() => {
    iconRect(9.05, 6.4, 1.9, 5.2);
    $.NSBezierPath.bezierPathWithOvalInRect($.NSMakeRect(10 - 1.15, 4.35 - 1.15, 2.3, 2.3)).fill;
  });
}

// kind：listening、speaking、working、pasted、nofield、standby、paused、error。frame 給會動的兩種用
function drawGlyph(kind, frame = {}) {
  if (kind === 'speaking') drawBars(frame.heights ?? QUIET);
  else if (kind === 'working') drawBrand({ bars: false, spin: frame.spin ?? 0 });
  else if (kind === 'pasted') iconStroke([[3.6, 8.4], [8.2, 4], [16.6, 13.8]], 2.5);
  else if (kind === 'nofield') { iconStroke([[6.5, 12.5], [13.5, 5.5]], 2); iconStroke([[6.5, 5.5], [13.5, 12.5]], 2); }
  else if (kind === 'error') drawWarning();
  else if (kind === 'standby') withAlpha(0.35, () => drawBrand());
  else if (kind === 'paused') {
    // 標誌加一條斜線（像「禁止」標誌）：斜線兩旁先挖空，線才不會黏在標誌上
    withAlpha(0.75, () => drawBrand());
    const slash = [[2.6, 1.6], [17.4, 16.4]];
    clearing(() => { const gap = iconPath(slash); gap.setLineWidth(4.6); gap.setLineCapStyle(1); gap.stroke; });
    iconStroke(slash, 2.2);
  } else drawBrand();
}

const iconCache = {};
let iconCacheSize = 0;
function iconImage(kind, frame = null) {
  const key = frame ? `${kind}:${frame.key}` : kind;
  if (iconCache[key]) return iconCache[key];
  const image = $.NSImage.alloc.initWithSize($.NSMakeSize(ICON_W, ICON_H));
  image.lockFocus;
  drawGlyph(kind, frame ?? {});
  image.unlockFocus;
  image.setTemplate(true);
  // 說話中的聲波高度有很多種組合：快取太多就清掉重來（JXA 長時間跑會一直吃記憶體）
  if (iconCacheSize > 400) { for (const k of Object.keys(iconCache)) if (k.includes(':')) delete iconCache[k]; iconCacheSize = 0; }
  iconCache[key] = image;
  iconCacheSize += 1;
  return image;
}

// 會動的兩種狀態的這一格：說話中聲波高度跟著音量（level 0–1），每條各自晃一點看起來像在聽，高度取整數點（同樣的高度
// 共用一張圖）；辨識中每 0.1 秒轉 30°（1.2 秒一圈）
function animFrame(kind) {
  const now = Date.now();
  if (kind === 'working') {
    const step = Math.floor(now / 100) % 12;
    return { spin: step * 30, key: String(step) };
  }
  if (kind === 'speaking') {
    const fresh = now - levelAt < 400 ? level : level * Math.max(0, 1 - (now - levelAt - 400) / 600); // 沒收到音量就慢慢降下來
    const heights = BAR_X.map((_, i) => {
      const wobble = 0.6 + 0.4 * Math.sin((now / 1000) * (7 + i * 1.7) + i * 1.3);
      return Math.round(Math.max(QUIET[i], 3 + 13 * Math.min(1, fresh * BAR_WEIGHT[i] * wobble * 1.25)));
    });
    return { key: heights.join(','), heights };
  }
  return null;
}

// 選單列圖示要畫哪一種，以及滑鼠停上去的說明
function look() {
  if (flash && Date.now() < flash.until) return flash.kind === 'pasted' ? ['pasted', t('已貼上', 'Pasted')] : ['nofield', t('游標不在輸入框，沒貼', 'Not in a text field; nothing pasted')];
  if (view.state === 'listening') {
    if (hearing) return ['speaking', t('說話中', 'Hearing you')];
    if (working) return ['working', t('辨識中：轉寫與 AI 整理', 'Transcribing and cleaning up')];
    return ['listening', ''];
  }
  if (view.state === 'paused') return ['paused', ''];
  if (view.state === 'error') return ['error', ''];
  return ['standby', ''];
}

// 測試用：目前選單列圖示旁的字、選單第一行、AI 與開關的勾選狀態
function uiSnapshot() {
  if (!statusItem) return null;
  return {
    title: ObjC.unwrap(statusItem.button.title),
    line: ObjC.unwrap(statusLine.title),
    ai: ObjC.unwrap(aiMenuItem.title),
    checked: [aiOffItem, ...Object.values(aiItems), autoFocusItem, commandsItem].map((item) => item.state).join(''),
    commands: ObjC.unwrap(commandsItem.title),
  };
}

// 診斷：選單列圖示實際的位置寫進 menubar.json（瀏海機型圖示太多時會被擠到瀏海後面看不到）
function dumpFrame() {
  try {
    const win = statusItem.button.window;
    const f = win.frame;
    const screen = $.NSScreen.mainScreen;
    const notch = screen.auxiliaryTopLeftArea;
    const info = {
      x: f.origin.x, y: f.origin.y, width: f.size.width, height: f.size.height,
      visible: statusItem.isVisible, onScreen: win.isVisible,
      appearance: ObjC.unwrap(statusItem.button.effectiveAppearance.name),
      screenWidth: screen.frame.size.width, notchStart: notch ? notch.size.width : null,
      notchEnd: screen.auxiliaryTopRightArea ? screen.frame.size.width - screen.auxiliaryTopRightArea.size.width : null,
    };
    $(JSON.stringify(info)).writeToFileAtomicallyEncodingError(statePath('menubar.json'), true, $.NSUTF8StringEncoding, null);
  } catch (err) { /* 拿不到就算了 */ }
}

let lastTexts = '';
function refresh() {
  if (!statusItem) return;
  const [kind, hint] = look();
  statusItem.button.setImage(iconImage(kind, animFrame(kind)));
  const moving = kind === 'speaking' || kind === 'working';
  if (moving && !animTimer) animTimer = $.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(0.1, controller, 'animate:', $(), true);
  if (!moving && animTimer) { animTimer.invalidate; animTimer = null; }
  // 動畫時每 0.1 秒會進來一次：字沒變就不重設
  const texts = `${hint}|${label()}|${view.state}`;
  if (texts === lastTexts) return;
  lastTexts = texts;
  statusItem.button.setToolTip(`JarvisVoice：${hint || label()}`);
  statusLine.setTitle(label());
  toggleItem.setTitle(view.state === 'paused' ? t('繼續收音', 'Resume listening') : t('暫停收音', 'Pause listening'));
}

function refreshSettings() {
  if (!aiMenuItem) return;
  const { ai } = settings;
  aiMenuItem.setTitle(`${t('AI 整理：', 'AI cleanup: ')}${ai.enabled ? `${AI_NAMES[ai.provider]}${ai.ready ? '' : t('（沒有 key）', ' (no key)')}` : t('關', 'Off')}`);
  aiOffItem.setState(ai.enabled ? 0 : 1);
  for (const [provider, item] of Object.entries(aiItems)) item.setState(ai.enabled && ai.provider === provider ? 1 : 0);
  autoFocusItem.setState(settings.autoFocus ? 1 : 0);
  commandsItem.setState(settings.commands ? 1 : 0);
  commandsItem.setTitle(settings.decider
    ? t(`語音指令（直接操作 app，${settings.decider} 決策）`, `Voice commands (operate apps, decided by ${settings.decider})`)
    : t('語音指令（直接操作 app）', 'Voice commands (operate apps)'));
}

// 改設定檔：讀進來、改、寫回去；常駐程式看到檔案改了會自己換設定
function updateConfig(change) {
  const path = statePath('config.json');
  let config = {};
  const text = $.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, null);
  if (text && !text.isNil()) {
    try { config = JSON.parse(ObjC.unwrap(text)); } catch (err) {
      openInTextEdit(path); // 設定檔壞了不要蓋掉，打開給人看
      return;
    }
  }
  change(config);
  $(`${JSON.stringify(config, null, 2)}\n`).writeToFileAtomicallyEncodingError(path, true, $.NSUTF8StringEncoding, null);
}

function chooseAi(provider) {
  updateConfig((config) => {
    config.ai = config.ai ?? {};
    // openai-compatible 要自己填網址和模型名（ai.baseUrls／ai.models），沒填就打開設定檔给人看
    if (provider === 'openai-compatible' && !(config.ai.baseUrls?.['openai-compatible'] && config.ai.models?.['openai-compatible'])) {
      openInTextEdit(statePath('config.json'));
      return;
    }
    config.ai.enabled = !!provider;
    if (provider) config.ai.provider = provider;
  });
}

// 開關型的設定（autoFocus、commands）：照常駐程式目前報的狀態反過來
function toggleSetting(key) {
  updateConfig((config) => { config[key] = !settings[key]; });
}

function requestRevert() {
  fm().createFileAtPathContentsAttributes(statePath('revert-request'), $(), $());
}

function ensureFile(path, text) {
  if (!fm().fileExistsAtPath(path)) $(text).writeToFileAtomicallyEncodingError(path, true, $.NSUTF8StringEncoding, null);
}

function openInTextEdit(path) {
  $.NSWorkspace.sharedWorkspace.openFileWithApplication(path, 'TextEdit');
}

function togglePause() {
  const paused = statePath('paused');
  if (fm().fileExistsAtPath(paused)) {
    fm().removeItemAtPathError(paused, null);
    view = { ...view, state: 'starting', message: '' };
  } else {
    fm().createFileAtPathContentsAttributes(paused, $(), $());
    view = { ...view, state: 'paused', message: '' };
  }
  refresh();
}

function copyLast() {
  const text = $.NSString.stringWithContentsOfFileEncodingError(statePath('last.txt'), $.NSUTF8StringEncoding, null);
  if (!text || text.isNil()) return;
  const pb = $.NSPasteboard.generalPasteboard;
  pb.clearContents;
  pb.setStringForType(text, $.NSPasteboardTypeString);
}

function showFlash(kind, ms) {
  flash = { kind, until: Date.now() + ms };
  refresh();
  $.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(ms / 1000 + 0.05, controller, 'flashEnd:', $(), false);
}

function onLine(line) {
  let event;
  try { event = JSON.parse(line); } catch { return; }
  if (event.type === 'settings') {
    settings = { ...settings, ...event };
    refreshSettings();
    refresh();
  } else if (event.type === 'state') {
    view = { state: event.state, message: event.message || '', engine: event.engine || view.engine };
    if (view.state !== 'listening') { hearing = false; working = false; }
    refresh();
  } else if (event.type === 'hud') {
    // 常駐程式的即時狀態：hearing／listening（有沒有聽到人聲）、level:<0–1>（說話中的音量）、
    // working／idle（辨識中開始、結束）、pasted、nofield
    if (event.line.startsWith('level:')) { level = Number(event.line.slice(6)) || 0; levelAt = Date.now(); }
    else if (event.line === 'hearing') { hearing = true; refresh(); }
    else if (event.line === 'listening') { hearing = false; refresh(); }
    else if (event.line === 'working') { working = true; refresh(); }
    else if (event.line === 'idle') { working = false; refresh(); }
    else if (event.line === 'pasted') showFlash('pasted', 1200);
    else if (event.line === 'nofield') showFlash('nofield', 1800);
  }
}

function onStdout(note) {
  const data = note.userInfo.objectForKey($.NSFileHandleNotificationDataItem);
  if (!data || Number(data.length) === 0) return; // 常駐程式結束，等 ended: 處理
  buffer += ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding)) || '';
  const lines = buffer.split('\n');
  buffer = lines.pop();
  for (const line of lines) if (line.trim()) onLine(line.trim());
  note.object.readInBackgroundAndNotify;
}

function scheduleRestart(seconds) {
  if (quitting) return;
  $.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(seconds, controller, 'restart:', $(), false);
}

function onEnded() {
  const waitOther = view.state === 'already-running';
  task = null;
  hearing = false;
  working = false;
  if (quitting) return;
  if (!waitOther) view = { ...view, state: 'off', message: '' };
  refresh();
  scheduleRestart(waitOther ? 10 : 3);
}

function startListener() {
  if (quitting || task) return;
  const node = resolveNode();
  if (!node) {
    view = { ...view, state: 'error', message: t(`找不到 node（原本的 ${BUILD.node} 已不存在，mise／brew 也找不到）；裝好 node 後從選單「結束」再打開`, `No node found (baked path ${BUILD.node} is gone, none in mise/brew); install node, then quit and reopen`) };
    refresh();
    scheduleRestart(30);
    return;
  }
  try {
    const t = $.NSTask.alloc.init;
    t.setLaunchPath(node);
    t.setArguments($([LISTEN, '--app']));
    const env = $.NSMutableDictionary.dictionaryWithDictionary($.NSProcessInfo.processInfo.environment);
    env.setObjectForKey($(`${node.replace(/\/[^/]*$/, '')}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`), $('PATH'));
    env.setObjectForKey($(BUILD.state), $('VOICE_DICTATION_STATE_DIR'));
    t.setEnvironment(env);
    const pipe = $.NSPipe.pipe;
    t.setStandardOutput(pipe);
    t.setStandardError($.NSFileHandle.fileHandleWithNullDevice);
    const reader = pipe.fileHandleForReading;
    const center = $.NSNotificationCenter.defaultCenter;
    center.addObserverSelectorNameObject(controller, 'stdout:', $.NSFileHandleReadCompletionNotification, reader);
    center.addObserverSelectorNameObject(controller, 'ended:', $.NSTaskDidTerminateNotification, t);
    reader.readInBackgroundAndNotify;
    t.launch;
    task = t;
  } catch (err) {
    view = { ...view, state: 'error', message: t(`常駐程式開不起來（${BUILD.node}）：${err}`, `Can't start the background process (${BUILD.node}): ${err}`) };
    refresh();
    scheduleRestart(30);
  }
}

function quitApp() {
  quitting = true;
  if (task) task.terminate;
  $.NSApplication.sharedApplication.terminate($());
}

ObjC.registerSubclass({
  name: 'VoiceDictationController',
  methods: {
    'toggle:': { types: ['void', ['id']], implementation() { togglePause(); } },
    'copyLast:': { types: ['void', ['id']], implementation() { copyLast(); } },
    'openVocabulary:': {
      types: ['void', ['id']],
      implementation() {
        const path = statePath('vocabulary.txt');
        ensureFile(path, t('# 專有名詞：一行一個，# 後面是註解。可以請你的 AI 照 AI_SETUP.md 幫你填。\n', '# Vocabulary: one term per line; # starts a comment. Your AI can fill this in by following AI_SETUP.md.\n'));
        openInTextEdit(path);
      },
    },
    'openConfig:': {
      types: ['void', ['id']],
      implementation() {
        const path = statePath('config.json');
        ensureFile(path, '{\n  "engine": "local"\n}\n');
        openInTextEdit(path);
      },
    },
    'openGuide:': {
      types: ['void', ['id']],
      implementation() {
        const url = ZH ? 'https://github.com/urusaqqrun/jarvis-voice/blob/main/README.zh-TW.md' : GUIDE_URL;
        $.NSWorkspace.sharedWorkspace.openURL($.NSURL.URLWithString(url));
      },
    },
    'quitApp:': { types: ['void', ['id']], implementation() { quitApp(); } },
    'aiOff:': { types: ['void', ['id']], implementation() { chooseAi(''); } },
    'aiOpenai:': { types: ['void', ['id']], implementation() { chooseAi('openai'); } },
    'aiDeepseek:': { types: ['void', ['id']], implementation() { chooseAi('deepseek'); } },
    'aiClaude:': { types: ['void', ['id']], implementation() { chooseAi('claude'); } },
    'aiVllm:': { types: ['void', ['id']], implementation() { chooseAi('openai-compatible'); } },
    'toggleAutoFocus:': { types: ['void', ['id']], implementation() { toggleSetting('autoFocus'); } },
    'toggleCommands:': { types: ['void', ['id']], implementation() { toggleSetting('commands'); } },
    'revert:': { types: ['void', ['id']], implementation() { requestRevert(); } },
    'stdout:': { types: ['void', ['id']], implementation(note) { onStdout(note); } },
    'ended:': { types: ['void', ['id']], implementation() { onEnded(); } },
    'restart:': { types: ['void', ['id']], implementation() { startListener(); } },
    'dumpFrame:': { types: ['void', ['id']], implementation() { dumpFrame(); } },
    'flashEnd:': { types: ['void', ['id']], implementation() { if (flash && Date.now() >= flash.until) { flash = null; refresh(); } } },
    'animate:': { types: ['void', ['id']], implementation() { refresh(); } },
  },
});

function menuItem(title, action) {
  const item = $.NSMenuItem.alloc.initWithTitleActionKeyEquivalent(title, action, '');
  if (action) item.setTarget(controller);
  return item;
}

function startUI() {
  fm().createDirectoryAtPathWithIntermediateDirectoriesAttributesError(BUILD.state, true, $(), null);
  controller = $.VoiceDictationController.alloc.init;
  // 新的選單列圖示預設排在最左邊，瀏海機型圖示一多就被擠到瀏海後面看不到：
  // 第一次先放在離螢幕右邊 260 點的位置；之後使用者按 Cmd 拖過的位置系統會自己記住
  const positionKey = 'NSStatusItem Preferred Position VoiceDictation';
  const defaults = $.NSUserDefaults.standardUserDefaults;
  if (defaults.objectForKey(positionKey).isNil()) defaults.setDoubleForKey(260, positionKey);
  statusItem = $.NSStatusBar.systemStatusBar.statusItemWithLength(-2); // NSSquareStatusItemLength：固定寬度
  statusItem.setAutosaveName('VoiceDictation');
  const menu = $.NSMenu.alloc.init;
  menu.setAutoenablesItems(false);
  statusLine = menuItem(t('啟動中…', 'Starting…'), null);
  statusLine.setEnabled(false);
  menu.addItem(statusLine);
  menu.addItem($.NSMenuItem.separatorItem);
  toggleItem = menuItem(t('暫停收音', 'Pause listening'), 'toggle:');
  menu.addItem(toggleItem);
  menu.addItem(menuItem(t('複製上一句', 'Copy last sentence'), 'copyLast:'));
  menu.addItem(menuItem(t('換回原文（上一段 AI 整理前）', 'Revert to original (before AI cleanup)'), 'revert:'));
  menu.addItem($.NSMenuItem.separatorItem);
  aiMenuItem = menuItem(t('AI 整理：關', 'AI cleanup: Off'), null);
  const aiMenu = $.NSMenu.alloc.init;
  aiMenu.setAutoenablesItems(false);
  aiOffItem = menuItem(t('關（講完一句直接貼）', 'Off (paste each sentence as is)'), 'aiOff:');
  aiMenu.addItem(aiOffItem);
  aiMenu.addItem($.NSMenuItem.separatorItem);
  for (const [provider, name] of Object.entries(AI_NAMES)) {
    aiItems[provider] = menuItem(name, AI_ACTIONS[provider]);
    aiMenu.addItem(aiItems[provider]);
  }
  aiMenuItem.setSubmenu(aiMenu);
  menu.addItem(aiMenuItem);
  autoFocusItem = menuItem(t('自動找輸入框（游標不在輸入框時）', 'Auto-focus (when the cursor isn\'t in a text field)'), 'toggleAutoFocus:');
  menu.addItem(autoFocusItem);
  commandsItem = menuItem(t('語音指令', 'Voice commands'), 'toggleCommands:');
  menu.addItem(commandsItem);
  menu.addItem($.NSMenuItem.separatorItem);
  menu.addItem(menuItem(t('編輯專有名詞…', 'Edit vocabulary…'), 'openVocabulary:'));
  menu.addItem(menuItem(t('編輯設定檔…', 'Edit config…'), 'openConfig:'));
  menu.addItem(menuItem(t('說明', 'Help'), 'openGuide:'));
  menu.addItem($.NSMenuItem.separatorItem);
  menu.addItem(menuItem(t('結束 JarvisVoice', 'Quit JarvisVoice'), 'quitApp:'));
  statusItem.setMenu(menu);
  refreshSettings();
  refresh();
  $.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(2, controller, 'dumpFrame:', $(), false);
  startListener();
}
