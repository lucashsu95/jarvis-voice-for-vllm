#!/usr/bin/env node
// 語音輸入的常駐程式（由選單列小程式「JarvisVoice」帶起來）：自動收音，講完就寫進目前游標所在的輸入框——
// 在哪個 app、哪個欄位，字就進哪裡；只貼不送出。開會、通話的 app 在最前面或按了暫停時關麥克風。
// 整台電腦同時只跑一個（鎖檔）。
//
// 三層：
//   1. 語音輸入：停頓 0.85 秒切一句，轉寫完就貼（AI 整理關著時）。
//   2. AI 整理（ai.enabled）：停頓超過 ai.segmentPauseMs 算一段講完，讀游標前後與 app、視窗、網址，
//      整段交給 AI（OpenAI／DeepSeek／Claude）整理再貼；選取了字又講指令就改寫選取的字。原稿留著可以換回。
//   3. 自動找輸入框（autoFocus）：游標不在輸入框時，挑視窗裡最像要寫字的輸入框，對焦後寫進去。
//
// 速度（speed，cubelv_docs/計劃/2026-10-19_JarvisVoice語音加速規劃.md）：能先做的先做，猜錯就丟掉重來，結果跟原本一樣。
//   - 開口時就先讀上下文（游標前後、畫面，截圖認字的 app 要 1 秒）、先把轉寫與 AI 的連線接好。
//   - 停 0.4 秒就先把這句送去轉寫；到 0.85 秒確定講完就用這份，中間又開口就作廢。
//   - 字一回來就開始 AI 整理（游標不在輸入框時同時挑好要寫的框）；整理好時已經停了 1.2 秒就直接貼，
//     又開口就作廢、等整段講完一起整理。
//   - 轉寫、AI 整理每次同時送兩份，誰先回用誰。
//   - 游標旁的小框（app/ui.js）：講話中即時顯示聽到的字（本機 SenseVoice 預覽）、整理中、已貼上、指令、出錯。
//   每次貼上 log 記一行「速度：講完到貼上 X 秒（字回來、整理好、貼上各花多少）」（只記 log，小框不顯示秒數）。
//
// 轉寫引擎看設定檔（bin/config.mjs）：local 本機 SenseVoice、openai 自己的 key（預設 gpt-transcribe 一般轉寫，
// 也可以選 gpt-live-transcribe 即時）、cubelv（用 CubeLV 登入，扣點數，bin/cubelv.mjs）、parallelsandbox。設定檔改了會自動換。
// 狀態寫在 status.json 給狀態列讀；有 paused 檔就暫停；有 revert-request 檔就把上一段換回原稿。
// stdout 每行一個 JSON（state、settings、hud、bubble、pasted、skipped）。
// 選項：--app 由選單列小程式帶起（log 寫進 listen.log，小程式不在了就結束）。
// 測試選項：--file <音檔> 用音檔代替麥克風、讀完收尾結束；--dry-paste 只印不貼；--always 不看前景 app；
// --pid <pid> 配 --file：只寫進這個 app（端到端測試的測試視窗），讀它的上下文、它到最前面才貼，不會貼到別的 app。

import { execFile, spawn } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAx } from './ax.mjs';
import { runCommand } from './commander.mjs';
import { TurnSplitter, BATCH_BYTES, SAMPLE_RATE, findFfmpeg } from './common.mjs';
import { STATE_DIR, aiAvailable, aiKey, appAllowed, configMtime, cubelvAccount, isLiveModel, loadConfig, styleFor } from './config.mjs';
import { DEFAULT_MODELS, PROVIDER_NAMES, editSegment } from './editor.mjs';
import { DEFAULT_URLS } from '../core/providers.mjs';
import { createBatchEngine } from './engines/batch.mjs';
import { createLocalEngine, createPreviewer } from './engines/local.mjs';
import { VOICEPRINT_MODEL, createVoiceprintFilter } from './voiceprint.mjs';
import { createRealtimeEngine, cubelvConnector, openaiConnector, parallelSandboxConnector } from './engines/realtime.mjs';
import { appendHistory } from './history.mjs';
import { createDecider, intentQuestion } from './decide.mjs';
import { createLearner } from './learn.mjs';
import { createVocabAuto } from './vocab-auto.mjs';
import { finishText, isSpeech, withSpacing } from './text.mjs';
// 一段話講完之後怎麼處理、幾句合成一段、小框的階段：都在核心（CubeLV、平行沙盒同一份），這裡只接 Mac 的接頭
import { judgeInField, judgeUtterance, pickTarget, planOutput } from '../core/flow.mjs';
import { createSegmenter, heardText } from '../core/segment.mjs';
import { bubbleContent, stepText } from '../core/bubble.mjs';

const LOCK = join(STATE_DIR, 'listener.lock');
const PAUSED = join(STATE_DIR, 'paused');
const REVERT = join(STATE_DIR, 'revert-request');
const VOICEPRINT_FILE = join(STATE_DIR, 'voiceprint.json');
const VOICEPRINT_RESET = join(STATE_DIR, 'voiceprint-reset'); // 選單「重錄我的聲紋」
const STATUS = join(STATE_DIR, 'status.json');
const LAST = join(STATE_DIR, 'last.txt');
const LOG = join(STATE_DIR, 'listen.log');
const POLL_MS = 500;
const SEGMENT_CHECK_MS = 100;
const HOLD_MS = 60_000; // 寫的時候前景是不收音的 app（例如開會），最多等一分鐘回來再寫
const MAX_SEGMENT_CHARS = 1500; // 一直講不停太長就先整理這一段
const MAC_PEAK_OVER_NOISE = 9; // 還沒開口時尖峰到底噪的 9 倍就算有人聲（10/19 實測：風扇聲裡沒人講話最大約 7.5 倍，正常講話 10 倍以上）

const argv = process.argv.slice(2);
const fileIndex = argv.indexOf('--file');
const inputFile = fileIndex >= 0 ? argv[fileIndex + 1] : null;
const dryPaste = argv.includes('--dry-paste');
const always = argv.includes('--always') || !!inputFile;
const pidIndex = argv.indexOf('--pid');
const targetPid = inputFile && pidIndex >= 0 ? Number(argv[pidIndex + 1]) : 0;
const appMode = argv.includes('--app');
const parentPid = process.ppid;

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const log = (...parts) => {
  const line = `[listen] ${parts.join(' ')}\n`;
  if (!appMode) { process.stderr.write(line); return; }
  try { appendFileSync(LOG, `${new Date().toISOString()} ${line}`); } catch { /* 寫不進就算了 */ }
};
const exec = (cmd, args, timeout = 3000) => new Promise((resolve) => {
  execFile(cmd, args, { timeout }, (err, stdout) => resolve(err ? '' : stdout));
});

// ---- 鎖：同時只跑一個 ----

const isAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
};

function takeLock() {
  mkdirSync(STATE_DIR, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(LOCK, 'wx');
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const pid = Number(readFileSync(LOCK, 'utf8').trim());
      if (pid && pid !== process.pid && isAlive(pid)) return false;
      try { unlinkSync(LOCK); } catch { /* 別人剛清掉 */ }
    }
  }
  return false;
}

function releaseLock() {
  try { if (readFileSync(LOCK, 'utf8').trim() === String(process.pid)) unlinkSync(LOCK); } catch { /* 已經不在 */ }
}

// ---- 即時狀態（選單列小程式顯示：說話中、已貼上、沒有輸入框）----

let stopping = false;
let hudMode = '';

// 交給選單列小程式（--app 時從 stdout 送出）；hearing、listening、hide、error:<訊息>、pasted、nofield、
// level:<0–1>（說話中的音量，每 0.1 秒）、working／idle（辨識中開始、結束）
function hudWrite(line) {
  if (appMode || process.env.VOICE_DICTATION_HUD) emit({ type: 'hud', line }); // VOICE_DICTATION_HUD：測試看選單列收到什麼
}

function hudShow(mode) {
  if (mode === hudMode) return;
  hudMode = mode;
  hudWrite(mode);
  if (mode === 'hide') bubble('hide');
  else if (mode.startsWith('error:')) bubble('error', { text: mode.slice(6) });
}

// 游標旁的小框（app/ui.js 畫）。有哪些階段、標題和內文寫什麼、停多久都在核心（core/bubble.mjs，CubeLV 的頂端 toast 同一份），
// 這裡照系統語言算好交給 ui.js：{ state, title, body, tone, loud, busy, result, holdMs, at }。
// at：游標（拿不到就是視窗）在螢幕上的位置 { x, y, w, h, kind: caret | window }（左上角原點），小框放在它下面；null 就放畫面下方中間
const LANG = process.env.VOICE_DICTATION_LANG || process.env.LANG || '';
const ZH = /^zh/i.test(LANG);
let bubbleKey = '';
let lastAnchor = null;
const bubbleOn = () => config.speed.bubble && (appMode || !!process.env.VOICE_DICTATION_HUD);
function bubble(state, { text = '', detail = '', speaker = '', enrollSeconds = 0 } = {}) {
  if (!bubbleOn()) return;
  const key = `${state}|${text}|${detail}|${speaker}|${enrollSeconds}|${JSON.stringify(lastAnchor)}`;
  if (key === bubbleKey) return;
  bubbleKey = key;
  const content = state === 'hide' ? null : bubbleContent({ state, text, detail, speaker, enrollSeconds }, ZH ? 'zh' : 'en');
  emit({ type: 'bubble', state, ...(content ?? {}), at: lastAnchor });
}

// 讀到上下文就記下游標在哪，小框跟著放
function noteAnchor(ctx) {
  if (!ctx) return;
  if (ctx.field?.editable && ctx.field.caret) lastAnchor = { ...ctx.field.caret, kind: 'caret' };
  else if (ctx.frame) lastAnchor = { ...ctx.frame, kind: 'window' };
}

// ---- 設定與引擎 ----

let { config, error: configError } = loadConfig();
let configStamp = configMtime(config);
let engine = null;

// AI 整理開著而且有 key（或用 CubeLV 登入了）才走第二層
const aiReady = () => config.ai.enabled && aiAvailable(config);
const aiSettings = () => ({
  provider: config.ai.provider,
  model: config.ai.models[config.ai.provider] || '',
  apiKey: aiKey(config),
  timeoutMs: config.ai.timeoutMs,
  cubelvUrl: config.cubelv.apiUrl,
});

function announceSettings() {
  const provider = config.ai.provider;
  const model = config.ai.models[provider] || DEFAULT_MODELS[provider];
  const deciderName = config.jev.apiKey ? 'Jev' : aiReady() ? PROVIDER_NAMES[provider] : '';
  const account = cubelvAccount(config);
  emit({
    type: 'settings',
    engine: config.engine,
    ai: { enabled: config.ai.enabled, provider, ready: aiReady() },
    autoFocus: config.autoFocus,
    commands: config.commands,
    decider: deciderName,
    cubelv: { loggedIn: !!account, email: account?.email ?? '' },
    voiceprint: { enabled: !!config.voiceprint.enabled, ready: !!voiceprint, enrolled: !!voiceprint?.enrolled() },
    // 各家有沒有 key（哪裡設的都算）：選單選了沒有 key 的那家，直接開「設定自己的 key…」的對話框
    keys: { openai: !!aiKey(config, 'openai'), deepseek: !!aiKey(config, 'deepseek'), claude: !!aiKey(config, 'claude'), jev: !!config.jev.apiKey },
  });
  const missing = provider === 'cubelv' ? '，但還沒用 CubeLV 登入，先不整理' : '，但沒有 key，先不整理';
  log(`AI 整理：${config.ai.enabled ? `${PROVIDER_NAMES[provider]}（${model}）${aiReady() ? '' : missing}` : '關'}；`
    + `自動找輸入框：${config.autoFocus ? '開' : '關'}；指令模式：${config.commands ? (aiReady() ? '開' : '開，但要先開 AI 整理') : '關'}；`
    + `第三層決策：${deciderName || '沒有（照規則）'}`);
  // 沒有 key 不算錯：只跑第一層，選單會寫「（沒有 key）」
}

let previewer = null;
let previewModel = '';

function startEngine() {
  engine?.close();
  const callbacks = {
    log,
    onError: (message) => setError(message),
    // info：引擎交回 commit 時給的 meta（turn、voiceEndAt）加上 ms、early（整句引擎才有）
    onFinal: (raw, info = {}) => {
      finishedPreview(info.turn);
      const heard = { ...info, heardAt: Date.now() };
      const text = finishText(raw, {
        output: config.output,
        replacements: config.replacements,
        alreadyTraditional: config.engine === 'parallelsandbox' || config.engine === 'cubelv',
      });
      if (!isSpeech(text)) {
        log(`轉寫結果：${text ? `「${text}」只有標點` : '（空的）'}，這句沒有字，不寫`);
        showHeard();
        segmenter.check();
        return;
      }
      log(`轉寫結果：${text}`);
      if (aiReady()) {
        segmenter.add(text, heard);
        showHeard();
        segmenter.check(); // 字一回來就看能不能提早整理，不等下一輪
      } else enqueueOutput({ kind: 'text', text, heard });
    },
  };
  if (config.engine === 'local') engine = createLocalEngine({ ...config.local, ...callbacks });
  else if (config.engine === 'openai' && isLiveModel(config.openai.model)) engine = createRealtimeEngine({ connector: openaiConnector(config.openai), ...callbacks });
  else if (config.engine === 'openai') engine = createBatchEngine({ ...config.openai, hedge: config.speed.hedge, ...callbacks });
  else if (config.engine === 'cubelv') engine = createRealtimeEngine({ connector: cubelvConnector({ ...config.cubelv, language: cubelvLanguage() }), ...callbacks });
  else engine = createRealtimeEngine({ connector: parallelSandboxConnector(config.parallelsandbox), ...callbacks });
  // 講話中的即時預覽：雲端轉寫才需要（本機轉寫本來就快），有小框才看得到
  const wantPreview = config.speed.preview && bubbleOn() && config.engine !== 'local';
  if (!wantPreview) { previewer = null; previewModel = ''; }
  else if (previewModel !== config.local.model) {
    previewModel = config.local.model;
    previewer = createPreviewer({ model: config.local.model, log });
  }
  log(`轉寫引擎：${config.engine}${config.engine === 'openai' ? `（${config.openai.model}，詞彙 ${config.openai.keywords.length} 個）` : ''}`);
  startVoiceprint();
  if (configError) setError(configError);
  announceSettings();
}

// CubeLV 轉寫的辨識語言：設定檔 openai.languages 有寫就照它，沒寫看介面語言（中文是 zh-Hant＝繁中夾英文），其他讓模型自己判斷
function cubelvLanguage() {
  const langs = config.openai.languages.map((l) => String(l).toLowerCase());
  if (langs.some((l) => l.startsWith('zh'))) return 'zh-Hant';
  if (langs.length === 1 && langs[0].startsWith('ja')) return 'ja';
  if (langs.length === 1 && langs[0].startsWith('en')) return 'en';
  return !langs.length && /^zh/i.test(process.env.VOICE_DICTATION_LANG || process.env.LANG || '') ? 'zh-Hant' : '';
}

function reloadConfigIfChanged() {
  const stamp = configMtime(config);
  if (stamp === configStamp) return;
  if (engine?.busy()) return; // 有句子還在轉寫，等轉完再換（換引擎會丟掉轉到一半的）
  configStamp = stamp;
  ({ config, error: configError } = loadConfig());
  configStamp = configMtime(config);
  startEngine();
}

// ---- 狀態 ----

let state = '';
let stateMessage = '';
let frontActive = false; // 目標 app 在最前面且沒暫停
let lastError = null; // { message, at }：錯誤在狀態列留 15 秒
function setError(message) {
  lastError = { message, at: Date.now() };
  setState('error', message);
}
function setState(next, message = '') {
  if (next === state && message === stateMessage) return;
  state = next;
  stateMessage = message;
  emit({ type: 'state', state, message, engine: config.engine });
  if (state === 'listening') hudShow(detector.speaking ? 'hearing' : 'listening');
  else if (state === 'error' && frontActive) hudShow(`error:${message}`);
  else hudShow('hide');
  try {
    const tmp = `${STATUS}.${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ state, message, engine: config.engine, pid: process.pid, at: Date.now() }));
    renameSync(tmp, STATUS);
  } catch { /* 狀態列看不到而已 */ }
}

async function frontApp() {
  const asn = (await exec('/usr/bin/lsappinfo', ['front'])).trim();
  if (!asn) return { bundle: '', pid: 0 };
  const info = await exec('/usr/bin/lsappinfo', ['info', '-only', 'bundleid', '-only', 'pid', asn]);
  return {
    bundle: info.match(/"CFBundleIdentifier"="([^"]*)"/)?.[1] ?? '',
    pid: Number(info.match(/"pid"=(\d+)/)?.[1] ?? 0),
  };
}

// 這個 app 在最前面時要不要收音（VOICE_DICTATION_APPS 給測試用：只認這些）
const allowed = (bundle) => (process.env.VOICE_DICTATION_APPS
  ? process.env.VOICE_DICTATION_APPS.split(',').includes(bundle)
  : appAllowed(config, bundle));

// ---- 收音與切句 ----

let ffmpeg = null;
let captureRetryAt = 0;
// 斷句與開口前 0.4 秒的預錄都在核心（core/turns.mjs 的 TurnSplitter，跟 CubeLV、平行沙盒同一份）
let splitter = new TurnSplitter();
let detector = splitter.detector;
let pendingChunks = [];
let pendingBytes = 0;
let carry = Buffer.alloc(0);
let sentSamples = 0;
let lastSpeechAt = 0;
let lastVoiceAt = 0; // 最後一次真的聽到人聲（算一段講完了沒）
let turnPeak = 0; // 這一句的最大音量（記 log 用）
let batchRms = 0; // 最近一批（0.1 秒）的音量，說話中送給選單列畫聲波
// 音量換成 0–1 給選單列：-50 dB 以下是 0、-10 dB 以上是 1
const levelOf = (rms) => Math.min(1, Math.max(0, (20 * Math.log10(Math.max(rms, 1e-6)) + 50) / 40));

// 講話中的音訊邊講邊交給引擎（雲端引擎會先送出去），講完一句再 commit
const stageAudio = () => {
  if (!pendingBytes) return;
  engine.append(Buffer.concat(pendingChunks, pendingBytes));
  pendingChunks = [];
  pendingBytes = 0;
};

// meta 跟著這句走到 onFinal：turn（第幾句，對即時預覽用）、voiceEndAt（最後一次聽到人聲，算「講完到貼上」）
const queueTurn = () => {
  stageAudio();
  engine.commit({ turn: currentTurn, voiceEndAt: lastVoiceAt });
};
const takeAudio = (audio) => {
  for (const b of audio) { pendingChunks.push(b); pendingBytes += b.length; }
};

// 診斷：每 15 秒記一次這段時間的最大音量，看麥克風到底有沒有收到聲音（全 0＝沒權限或被別的程式占住）、
// 有沒有爆音、有幾次太短的聲音沒算成一句
let levelPeak = 0;
let reopenCapture = false;
let levelSince = Date.now();
function trackLevel(samples) {
  let peak = 0;
  let sum = 0;
  for (const v of samples) { const a = Math.abs(v) / 32768; if (a > peak) peak = a; sum += a * a; }
  batchRms = Math.sqrt(sum / samples.length);
  if (peak > levelPeak) levelPeak = peak;
  if (Date.now() - levelSince < 15_000) return peak;
  const notes = [];
  if (levelPeak === 0) notes.push('完全沒聲音，多半是剛給麥克風權限前就開了，重開麥克風');
  if (levelPeak >= 0.99) notes.push('有爆音（音量到頂），轉寫可能會錯');
  if (detector.shortBlips) notes.push(`${detector.shortBlips} 次聲音不到 0.18 秒，當雜音沒算成一句`);
  // 門檻跟著底噪走：記下現在的底噪、開口門檻，和沒算成人聲的聲音最大到多少（講話沒被聽到時看差多少）
  const th = detector.thresholds();
  const gate = `底噪 ${th.noise.toFixed(4)}、開口門檻 RMS ${th.level.toFixed(3)} 或尖峰 ${th.peak.toFixed(3)}；沒算成人聲的最大 RMS ${detector.missLevel.toFixed(3)}、尖峰 ${detector.missPeak.toFixed(3)}`;
  log(`麥克風 15 秒內最大音量 ${levelPeak.toFixed(3)}（${gate}）${notes.length ? `：${notes.join('；')}` : ''}`);
  detector.missLevel = 0;
  detector.missPeak = 0;
  // 權限詢問還沒按允許時開的麥克風，允許之後也一直收到 0：重開一次就好
  if (levelPeak === 0) reopenCapture = true;
  detector.shortBlips = 0;
  levelPeak = 0;
  levelSince = Date.now();
  return peak;
}

function takeBatch(chunk) {
  const samples = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.length / 2);
  const peak = trackLevel(samples);
  const startMs = sentSamples / 24;
  sentSamples += samples.length;
  const wasSpeaking = detector.speaking;
  const { audio, turn, tentative, resumed } = splitter.push(samples, startMs);
  takeAudio(audio);
  if (detector.speaking) lastSpeechAt = Date.now();
  if ((detector.speaking || turn) && detector.lastVoiced) lastVoiceAt = Date.now();
  if (detector.speaking || turn) turnPeak = Math.max(turnPeak, peak);
  if (!wasSpeaking && detector.speaking) speechStarted();
  if (wasSpeaking || detector.speaking) for (const b of audio) { turnAudio.push(b); turnAudioBytes += b.length; }
  if (detector.speaking !== wasSpeaking && state === 'listening') hudShow(detector.speaking ? 'hearing' : 'listening');
  if (detector.speaking && state === 'listening') {
    hudWrite(`level:${levelOf(batchRms).toFixed(2)}`);
    warmUp();
    schedulePreview();
  }
  // 停了 0.4 秒：先比聲紋（不像使用者就不送），再把到這裡的聲音送去轉寫；又開口就作廢
  if (tentative && engine.speculate) {
    turnVerdict = voiceprint ? voiceprint.check(Buffer.concat(turnAudio, turnAudioBytes), (detector.lastVoiceEnd - detector.currentStartMs) / 1000, { dryRun: true }) : null;
    if (!turnVerdict || turnVerdict.pass) { stageAudio(); engine.speculate(); }
  }
  if (resumed) {
    turnVerdict = null;
    if (engine.discard?.()) log('停 0.4 秒先送的轉寫作廢：又開口了');
  }
  if (turn) {
    const sec = (turn.endMs - turn.startMs) / 1000;
    // 停 0.4 秒時已經算過這句的聲紋（之後沒再開口，聲音一樣）：直接記，不再算一次
    const verdict = judgeTurn(sec, turnVerdict?.v);
    turnVerdict = null;
    const loud = `最大音量 ${turnPeak.toFixed(3)}${turnPeak >= 0.99 ? '，爆音' : ''}`;
    turnPeak = 0;
    if (verdict.pass) {
      log(`切出一句 ${sec.toFixed(1)} 秒（${loud}），送去轉寫`);
      queueTurn();
    } else {
      stageAudio();
      engine.skip?.();
      // 小框寫「別人在講話，這句不轉寫」，附上本機預覽聽到的字（看得到擋了什麼）
      const heard = previews.get(currentTurn) ?? '';
      finishedPreview(currentTurn);
      bubble('ignored', { text: heard });
    }
    turnAudio = [];
    turnAudioBytes = 0;
  }
}

// ---- 只聽使用者的聲音（聲紋，bin/voiceprint.mjs、core/voiceprint.mjs）----

let voiceprint = null;
let voiceprintKey = '';
let turnVerdict = null; // 這句在停 0.4 秒時先比的聲紋（只看不記；切句時用同一個聲紋記，不再算一次）

function startVoiceprint() {
  const { enabled, threshold, minSeconds, shortThreshold } = config.voiceprint;
  const key = enabled ? `${threshold}:${minSeconds}:${shortThreshold}` : '';
  if (key === voiceprintKey) return;
  voiceprintKey = key;
  voiceprint = enabled ? createVoiceprintFilter({
    model: join(STATE_DIR, 'models', 'speaker', VOICEPRINT_MODEL), file: VOICEPRINT_FILE, threshold, minSeconds, shortThreshold, log,
  }) : null;
  lastSpeaker = '';
  if (voiceprint) log(voiceprint.enrolled() ? '只聽你的聲音：開（聲紋已錄好）' : '只聽你的聲音：開，先從你接下來講的話錄聲紋樣本（約 10 秒，照常轉寫）');
}

// 小框的小標籤寫是誰講的：最後一句比過聲紋的結果（mine 你說的、short 短句、enrolling 正在錄你的聲紋）
let lastSpeaker = '';

// 這句是不是使用者講的：還在錄樣本、太短、像使用者都放行；不像就不轉寫。v：停 0.4 秒時算好的聲紋
function judgeTurn(sec, v = null) {
  if (!voiceprint) return { pass: true };
  const r = v ? voiceprint.commit(v, sec) : voiceprint.check(Buffer.concat(turnAudio, turnAudioBytes), sec);
  if (r.verdict === 'enrolling') log(`錄聲紋樣本：還要約 ${Math.ceil(voiceprint.needSeconds())} 秒`);
  else if (r.verdict === 'enrolled') {
    log(`聲紋樣本錄好了（留下 ${r.kept} 句）：之後不像你的聲音不轉寫`);
    announceSettings();
  } else if (r.verdict === 'other') log(`聲紋不像你（相似度 ${r.score.toFixed(2)}，${sec.toFixed(1)} 秒，${r.ms} ms）：這句不轉寫`);
  else if (r.score !== null) log(`聲紋：${r.verdict === 'short' ? '短句，是你' : '是你'}（相似度 ${r.score.toFixed(2)}，${r.ms} ms）`);
  if (r.pass) lastSpeaker = r.verdict === 'enrolled' ? 'mine' : r.verdict;
  return r;
}

// 開口了：先讀上下文、接好連線；講到一半的提早整理作廢（等整段講完一起整理）
function speechStarted() {
  currentTurn += 1;
  turnAudio = [];
  turnAudioBytes = 0;
  previewedBytes = 0;
  segmenter.drop('又開口了');
  turnVerdict = null;
  void prefetchContext();
  warmUp();
  showHeard();
}

// ---- 講話中的即時預覽（游標旁的小框）：本機 SenseVoice 每多 0.5 秒聲音認一次目前這句，只顯示、不貼 ----

const PREVIEW_STEP_BYTES = 24000; // 0.5 秒（24 kHz、16-bit）
let currentTurn = 0; // 第幾句（開口一次加一）
let turnAudio = []; // 這句到目前的聲音
let turnAudioBytes = 0;
let previewedBytes = 0;
let previewBusy = false;
let finalTurn = 0; // 雲端轉寫已經回來的最後一句；比它舊的預覽不再顯示
const previews = new Map(); // 第幾句 → 預覽的字（雲端的字回來就拿掉）

function schedulePreview() {
  if (!previewer || previewBusy || turnAudioBytes - previewedBytes < PREVIEW_STEP_BYTES) return;
  previewBusy = true;
  previewedBytes = turnAudioBytes;
  const turnNo = currentTurn;
  previewer.recognize(Buffer.concat(turnAudio, turnAudioBytes)).then((raw) => {
    const text = finishText(raw, { output: config.output, replacements: config.replacements });
    if (turnNo <= finalTurn || !isSpeech(text)) return;
    previews.set(turnNo, text);
    showHeard();
  }, (err) => log(`即時預覽失敗：${err.message}`)).finally(() => { previewBusy = false; });
}

// 雲端的字回來了：這句（和更早的）預覽拿掉，換成雲端的字
function finishedPreview(turnNo) {
  const upTo = turnNo ?? (detector.speaking ? currentTurn - 1 : currentTurn);
  finalTurn = Math.max(finalTurn, upTo);
  for (const k of previews.keys()) if (k <= upTo) previews.delete(k);
}

// 小框顯示目前聽到的：這段已經轉好的字＋還在講（或還在轉）的那句的預覽（核心 heardText）
function showHeard() {
  if (state !== 'listening') return;
  const text = heardText(segmenter.parts(), [...previews.values()]);
  const early = segmenter.working();
  if (early && !detector.speaking) bubble('working', { text: early });
  else if (detector.speaking || text) {
    // 還在錄聲紋樣本：小框多一行說還要講多久；講話中還不知道是誰，講完比過聲紋才標「你說的」
    const enrollSeconds = voiceprint && !voiceprint.enrolled() ? voiceprint.needSeconds() : 0;
    const speaker = !voiceprint || detector.speaking ? '' : !voiceprint.enrolled() ? 'enrolling' : lastSpeaker;
    bubble('hearing', { text: text.length > 120 ? `…${text.slice(-120)}` : text, enrollSeconds, speaker });
  }
  else if (!outputQueue.length && !outputBusy) bubble('hide');
}

// 停麥克風時把講到一半的那句送出去
function finishTurn() {
  if (carry.length >= 2) takeBatch(Buffer.from(carry.subarray(0, carry.length - (carry.length % 2))));
  carry = Buffer.alloc(0);
  const { audio, turn } = splitter.finish();
  if (turn) {
    log(`麥克風停了，講到一半的那句（${((turn.endMs - turn.startMs) / 1000).toFixed(1)} 秒）送去轉寫`);
    takeAudio(audio);
    queueTurn();
  }
  turnAudio = [];
  turnAudioBytes = 0;
  turnPeak = 0;
  pendingChunks = [];
  pendingBytes = 0;
}

let captureEnded = null;
// 麥克風卡住：ffmpeg 還活著但不再送聲音（電腦睡醒、麥克風裝置換了之後會這樣，10/19 卡了 4 小時才發現）。
// 開著麥克風卻 3 秒都沒有聲音進來（安靜也會一直送 0），就重開
const CAPTURE_STALL_MS = 3000;
let lastAudioAt = 0;
function startCapture() {
  log('開麥克風');
  levelPeak = 0;
  levelSince = Date.now();
  // 尖峰門檻用底噪的 9 倍（core/turns.mjs 的 peakOverNoise）：風扇聲裡正常講話才聽得到
  splitter = new TurnSplitter({ tentativeMs: config.engine === 'openai' ? config.speed.earlyTranscribeMs : 0, peakOverNoise: MAC_PEAK_OVER_NOISE });
  detector = splitter.detector;
  carry = Buffer.alloc(0);
  const input = inputFile ? ['-re', '-i', inputFile] : ['-f', 'avfoundation', '-i', ':default'];
  const child = spawn(findFfmpeg(), [
    '-hide_banner', '-loglevel', 'error', '-nostdin', ...input,
    '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', 'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  ffmpeg = child;
  let errText = '';
  let gotAudio = false;
  child.stderr.on('data', (d) => { errText = (errText + d.toString()).slice(-400); });
  lastAudioAt = Date.now() + 5000; // 剛開的麥克風要一兩秒才有聲音：多等 5 秒
  child.stdout.on('data', (data) => {
    if (ffmpeg !== child) return;
    gotAudio = true;
    lastAudioAt = Date.now();
    carry = carry.length ? Buffer.concat([carry, data]) : data;
    while (carry.length >= BATCH_BYTES) {
      takeBatch(Buffer.from(carry.subarray(0, BATCH_BYTES)));
      carry = carry.subarray(BATCH_BYTES);
    }
  });
  captureEnded = new Promise((resolve) => child.on('close', resolve));
  child.on('close', (code) => {
    if (ffmpeg !== child) return;
    ffmpeg = null;
    finishTurn();
    if (inputFile) return;
    const detail = errText.trim().split('\n').at(-1) || `ffmpeg 結束（${code}）`;
    setError(gotAudio ? `麥克風中斷：${detail}` : `麥克風開不起來：${detail}`);
    captureRetryAt = Date.now() + 10_000;
  });
  child.on('error', (err) => {
    if (ffmpeg !== child) return;
    ffmpeg = null;
    setError(`ffmpeg 開不起來：${err.message}（brew install ffmpeg）`);
    captureRetryAt = Date.now() + 30_000;
  });
}

function stopCapture() {
  const child = ffmpeg;
  ffmpeg = null;
  try { child?.kill('SIGKILL'); } catch { /* 已經結束 */ }
  finishTurn();
}

// ---- 第二層：一段話（幾句）講完才整理（規則在核心 core/segment.mjs，CubeLV 的一直聽同一份）----
// 每句都轉完、而且停了 ai.segmentPauseMs 才算一段講完；提早整理（speed.pasteAfterMs）：每句都轉完、沒在講話就先整理這段，
// 整理好時已經停了 pasteAfterMs 就算講完、直接貼；又開口或又多一句就作廢，等整段講完一起整理（跟原本一樣）

const segmenter = createSegmenter({
  pauseMs: () => config.ai.segmentPauseMs,
  pasteAfterMs: () => config.speed.pasteAfterMs,
  maxChars: MAX_SEGMENT_CHARS,
  state: () => ({ speaking: detector.speaking, starting: detector.starting, busy: !!engine?.busy() || pendingBytes > 0, lastVoiceAt }),
  prepare: (raw, signal) => frontNow().then((front) => prepare(raw, front, signal)),
  onWorking: (raw) => bubble('working', { text: raw }),
  onSegment: ({ raw, heard, prepared, earlyPolish }) => enqueueOutput({ kind: 'segment', raw, heard, prepared, earlyPolish }),
  log,
});

// 辨識中（選單列的循環箭頭在轉）：有句子在轉寫、一段還在等整理、或整理好還沒寫進去
let working = false;
function updateWorking() {
  const now = !!(engine?.busy() || segmenter.has() || outputQueue.length || outputBusy);
  if (now === working) return;
  working = now;
  hudWrite(now ? 'working' : 'idle');
}

// ---- 寫進輸入框 ----

const ax = createAx({ log });
const outputQueue = [];
let outputBusy = false;
let askedAccessibility = false;
let lastInserted = null; // { pid, text：實際貼上的字, raw：原稿, ai：是不是 AI 整理過 }
const rememberedTargets = new Map(); // `${pid}:${視窗標題}` → 上次寫進去的輸入框
const vocab = createVocabAuto({
  log,
  settings: () => ({ ...config.ai.autoVocabulary, vocabularyFile: config.openai.vocabularyFile, ai: aiReady() ? aiSettings() : null }),
});
const learner = createLearner({
  ax,
  log,
  settings: () => ({ enabled: aiReady() && config.ai.learn, ai: aiSettings(), vocabularyFile: config.openai.vocabularyFile }),
  promote: (term, source) => vocab.promote(term, source),
});

const writeLast = (text) => { try { writeFileSync(LAST, text); } catch { /* 選單「複製上一句」拿不到而已 */ } };

function enqueueOutput(item) {
  outputQueue.push({ ...item, at: Date.now() });
  if (item.kind === 'text') writeLast(item.text);
  void drainOutput();
}

async function axCall(op, args, timeoutMs) {
  try {
    return await ax.call(op, args, timeoutMs);
  } catch (err) {
    log(`AX 小幫手 ${op} 失敗：${err.message}`);
    return null;
  }
}

const decider = createDecider(() => ({ jevKey: config.jev.apiKey, jevModel: config.jev.model, ai: aiReady() ? aiSettings() : null }));
const commandsOn = () => config.commands && aiReady();

// 第三層（輸入）：游標不在輸入框，挑視窗裡要寫的輸入框（規則在核心 core/flow.mjs 的 pickTarget：上次寫的那個或只有一個就直接用，
// 其他交給決策器挑，沒有決策器就照規則排第一的）。只挑不對焦（跟 AI 整理同時做），確定要打字才 focusField
async function pickField(pid, transcript, ctx) {
  const found = await axCall('targets', { pid });
  if (!found) return null;
  const remembered = rememberedTargets.get(`${pid}:${found.window?.title ?? ''}`);
  return pickTarget({ candidates: found.candidates, window: found.window, remembered, transcript, decider, context: { app: ctx?.app ?? '' }, log });
}

async function focusField({ choice, reason }) {
  await axCall('focus', { handle: choice.handle });
  log(`游標不在輸入框，自動對焦到「${choice.label || choice.role}」（${reason}）`);
}

// 截圖認字要「螢幕錄影」權限：沒有就提醒一次（小幫手第一次會跳系統詢問）
let warnedCapture = false;
function noteCapturePermission(source) {
  if (source !== 'no-permission' || warnedCapture) return;
  warnedCapture = true;
  log('這個 app 讀不到畫面，要截圖認字，但 JarvisVoice 還沒有「螢幕錄影」權限');
  setError('讀不到畫面的 app（例如 LINE）要截圖認字：系統設定 → 隱私權與安全性 → 螢幕錄影，打開「JarvisVoice」');
}

// AI 整理開著時連畫面上看得到的字一起讀（給 AI 判斷在討論什麼、專有名詞怎麼寫）；讀不到畫面的 app 會用截圖認字。
// screen: false 只讀游標與輸入框（對焦後重讀、開口時先拿游標位置給小框）
async function readContext(front, { screen = true } = {}) {
  if (dryPaste || !front.pid) return null;
  const ctx = await axCall('context', { pid: front.pid, chars: config.ai.contextChars, screen: screen && aiReady() ? config.ai.screenChars : 0 }, 15000);
  noteCapturePermission(ctx?.screenSource);
  noteAnchor(ctx);
  return ctx;
}

// 最前面的 app：tick 每 0.5 秒查一次，夠新就直接用（貼上時小幫手會再確認是不是在最前面）
let lastFront = null;
async function frontNow() {
  if (targetPid) return { bundle: '', pid: targetPid };
  if (always) return { bundle: '', pid: 0 };
  if (lastFront && Date.now() - lastFront.at < 700) return lastFront;
  return frontApp();
}

// 開口時就先讀上下文（截圖認字的 app 要 1 秒），講完直接用；先讀一次不含畫面的（很快，小框才知道游標在哪）。
// 貼上後游標前後的字變了就丟掉，下次開口再讀
let ctxCache = null; // { pid, at, done, promise }
async function prefetchContext() {
  if (dryPaste || (!aiReady() && !bubbleOn())) return;
  const front = await frontNow();
  if (!front.pid) return;
  if (ctxCache?.pid === front.pid && !ctxCache.done && Date.now() - ctxCache.at < 15_000) return; // 上一次還在讀
  const entry = { pid: front.pid, at: Date.now(), done: false };
  ctxCache = entry;
  const quick = aiReady() && config.ai.screenChars && bubbleOn() ? readContext(front, { screen: false }) : null;
  entry.promise = (async () => {
    await quick;
    return readContext(front);
  })().finally(() => { entry.done = true; });
}

function contextFor(front) {
  if (ctxCache?.pid === front.pid && Date.now() - ctxCache.at < 60_000) return ctxCache.promise;
  return readContext(front);
}

// 講話中先把要用到的連線接好（每個網址 3 秒最多一次，雙發要幾條就接幾條）：HEAD 一下，連線留在連線池，
// 講完的請求不用重新握手（實測冷的多 0.05～0.12 秒）。只在選單列小程式裡做（測試的假伺服器不用）
const warmedAt = new Map();
function warmUp() {
  if (!config.speed.warm || !(appMode || process.env.VOICE_DICTATION_WARM)) return;
  const urls = [];
  if (config.engine === 'openai' && !isLiveModel(config.openai.model)) urls.push(process.env.VOICE_DICTATION_OPENAI_HTTP_URL || 'https://api.openai.com/v1/audio/transcriptions');
  if (aiReady() && config.ai.provider !== 'cubelv') urls.push(DEFAULT_URLS[config.ai.provider]);
  // CubeLV：轉寫與 AI 整理都在同一個網域，暖一條就好（/health 由 router 直接回，不碰後端）
  if (config.engine === 'cubelv' || (aiReady() && config.ai.provider === 'cubelv')) urls.push(`${config.cubelv.apiUrl}/health`);
  if (commandsOn() && config.jev.apiKey) urls.push(DEFAULT_URLS.jev);
  const now = Date.now();
  for (const url of urls) {
    if (now - (warmedAt.get(url) ?? 0) < 3000) continue;
    warmedAt.set(url, now);
    for (let i = 0; i < Math.max(1, config.speed.hedge); i += 1) {
      fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(3000) }).then((r) => r.arrayBuffer()).catch(() => {});
    }
  }
}

// 整理前的準備（可以提早做，不貼、不動畫面）：上下文（開口時就先讀了）、AI 整理，游標不在輸入框時同時挑好要寫的框。
// signal：提早整理作廢時取消 AI 請求
async function prepare(raw, front, signal) {
  const ctx = await contextFor(front);
  const inField = !ctx?.field.known || ctx.field.editable;
  const out = { front, ctx, inField, result: null, pick: null, aiDoneAt: 0 };
  // 不在輸入框、也沒開自動找或指令：不用送 AI
  if (!inField && !config.autoFocus && !commandsOn()) return out;
  if (!inField && config.autoFocus) {
    out.pick = pickField(front.pid, raw, ctx).catch((err) => { log(`挑輸入框失敗：${err.message}`); return null; });
  }
  out.result = await aiEdit(raw, front, ctx, signal);
  out.aiDoneAt = Date.now();
  return out;
}

// 講完到貼上的時間：講完（最後一次聽到人聲）→ 字回來 → 整理好 → 貼上
function speedNote(item, prep, pasteStartAt, pastedAt) {
  const end = item.heard?.voiceEndAt;
  if (!end) return null;
  const s = (ms) => (ms / 1000).toFixed(2);
  const parts = {
    total: pastedAt - end,
    heard: item.heard.heardAt - end,
    transcribeMs: item.heard.ms ?? null,
    earlyTranscribe: !!item.heard.early,
    aiDone: prep?.aiDoneAt ? prep.aiDoneAt - end : null,
    aiMs: prep?.result?.ms ?? null,
    earlyPolish: !!item.earlyPolish,
    paste: pastedAt - pasteStartAt,
  };
  const bits = [`字回來 ${s(parts.heard)}${parts.earlyTranscribe ? '（停 0.4 秒就先送）' : ''}`];
  if (parts.aiDone !== null) bits.push(`整理好 ${s(parts.aiDone)}（AI ${s(parts.aiMs ?? 0)}${parts.earlyPolish ? '，字一回來就整理' : ''}）`);
  bits.push(`貼上 ${s(parts.paste)}`);
  return { parts, line: `速度：講完到貼上 ${s(parts.total)} 秒（${bits.join('、')}）` };
}

// AI 整理＋是不是指令：規則在核心（core/flow.mjs 的 judgeUtterance，CubeLV 同一份），這裡接 Mac 的 AI、Jev 與輔助使用。
// 有 Jev 才另外問決策器：游標在輸入框時看畫面判斷是不是要操作（judgeInField），不在輸入框時問是指令的機率；沒有 Jev 就照 AI 整理的判斷。
// 對照：cubelv_docs/分析/2026-10-18_JarvisVoice_Jev必要性.md
async function aiEdit(raw, front, ctx, signal) {
  if (!aiReady()) return null;
  const inField = !!ctx?.field.editable;
  const jevOn = commandsOn() && config.jev.apiKey && front.pid;
  // 讀不到畫面的 app（例如 LINE）會用截圖認出來的字補上
  const screen = { elements: (opts) => axCall('elements', { pid: front.pid, ...opts }, 15000) };
  const judge = jevOn && inField
    ? judgeInField({ raw, screen, decider, field: ctx.field, context: { app: ctx.app ?? '', window: ctx.window ?? '' } })
      .then((v) => { noteCapturePermission(v.source); return v; }, (err) => { log(`Jev 判斷指令失敗：${err.message}`); return null; })
    : null;
  // 游標不在輸入框：同時問 Jev 是不是指令（不多花時間），只在 AI 說是打字時才用得到
  const intent = jevOn && !inField
    ? decider.decide({ transcript: raw, app: ctx?.app ?? '', window: ctx?.window ?? '', field: '' }, { intent: intentQuestion() })
      .then((a) => a.intent?.probabilities?.command ?? 0, (err) => { log(`Jev 判斷指令失敗：${err.message}`); return null; })
    : null;
  const edit = (transcript) => editSegment({
    ...aiSettings(),
    transcript,
    context: { app: ctx?.app, bundle: front.bundle, window: ctx?.window, url: ctx?.url, field: ctx?.field, screen: ctx?.screen },
    style: styleFor(config, front.bundle, ctx?.url),
    vocabulary: config.openai.keywords,
    commands: commandsOn(),
    hedge: config.speed.hedge,
    signal,
  });
  return judgeUtterance({ raw, inField, edit, judge, intent, aborted: () => !!signal?.aborted, log });
}

const openApp = (name) => new Promise((resolve) => {
  execFile('/usr/bin/open', ['-a', name], { timeout: 5000 }, (err) => resolve(!err));
});

// 第三層（指令）：直接操作 app
async function runVoiceCommand(result, raw, front, ctx) {
  log(`指令：${result.goal}${result.text ? `（要搜尋「${result.text}」）` : ''}${result.message ? `（要寫「${result.message}」，不送出）` : ''}${result.app ? `，先切到 ${result.app}` : ''}`);
  if (dryPaste) {
    emit({ type: 'command', goal: result.goal, text: result.text, app: result.app, dry: true });
    return '';
  }
  bubble('command', { text: result.goal });
  let outcome;
  try {
    outcome = await runCommand({
      ax, decider, log, frontApp, openApp, goal: result.goal, text: result.text, message: result.message, app: result.app, context: { app: ctx?.app ?? '' },
      stopped: () => existsSync(PAUSED),
      // 小框跟著顯示做到哪一步（核心 stepText：「第 1 步：點 按鈕「Gmail」」）
      onStep: (step) => bubble('command', { text: result.goal, detail: stepText(step, ZH ? 'zh' : 'en') }),
    });
  } catch (err) {
    outcome = { ok: false, reason: err.message, steps: [] };
  }
  ctxCache = null;
  log(outcome.ok ? `指令完成：${outcome.steps.join(' → ') || '畫面本來就是'}` : `指令沒完成：${outcome.reason}`);
  hudWrite(outcome.ok ? 'pasted' : 'nofield');
  bubble(outcome.ok ? 'done' : 'failed', { text: result.goal, detail: outcome.ok ? '' : outcome.reason });
  writeLast(raw);
  emit({ type: 'command', goal: result.goal, ok: outcome.ok, steps: outcome.steps ?? [], reason: outcome.reason ?? '' });
  if (config.ai.history) {
    appendHistory({ app: ctx?.app ?? '', bundle: front.bundle, raw, mode: 'command', goal: result.goal, ok: outcome.ok, steps: outcome.steps ?? [] });
  }
  return '';
}

// 把游標前剛貼的那段換掉（換回原稿、或刪掉）
async function replaceLast(front, replacement, label) {
  if (!lastInserted || lastInserted.pid !== front.pid) {
    log(`${label}：這個 app 裡沒有剛寫進去的字`);
    return;
  }
  const r = await axCall('replace', { pid: front.pid, old: lastInserted.text, text: replacement });
  if (r?.result === 'ok') {
    log(`${label}：完成`);
    lastInserted = replacement ? { ...lastInserted, text: replacement, ai: false } : null;
    hudWrite('pasted');
    return;
  }
  writeLast(lastInserted.raw);
  hudWrite('nofield');
  log(`${label}：游標前面已經不是剛貼的字（${r?.result ?? '小幫手沒回'}），沒動；原稿放在「複製上一句」`);
}

const NOFIELD_HINT = ZH ? '點選單列的 JarvisVoice →「複製上一句」可以拿回來' : 'Get it back from JarvisVoice in the menu bar → "Copy last sentence"';

function skipNoField(raw, role) {
  writeLast(raw);
  log('游標不在輸入框，這段沒寫：', raw, `（${role}）`);
  hudWrite('nofield');
  bubble('nofield', { detail: NOFIELD_HINT });
  emit({ type: 'skipped', text: raw, reason: `not-text-field:${role}` });
  return '';
}

// 回傳 'retry' 表示現在寫不進去（沒權限、前景換了），放回佇列等一下
async function deliver(item, front) {
  if (item.kind === 'revert') {
    if (lastInserted?.ai) await replaceLast(front, withSpacing(lastInserted.raw), '換回原文');
    else log('換回原文：上一段沒有經過 AI 整理');
    return '';
  }
  const raw = item.kind === 'segment' ? item.raw : item.text;
  // 一段：提早整理好的（或上次整理好、只是當時寫不進去的）直接用，不再問一次 AI
  if (item.kind === 'segment' && !item.prepared) {
    bubble('working', { text: raw });
    item.prepared = prepare(raw, front);
  }
  const prep = item.kind === 'segment' ? await item.prepared : null;
  let ctx;
  let inField;
  let pick = null;
  if (prep && prep.front.pid === front.pid) ({ ctx, inField, pick } = prep);
  else {
    // 一句一句貼（AI 關著），或整理時跟現在最前面的不是同一個 app：照現在的 app 讀
    ctx = await contextFor(front);
    inField = !ctx?.field.known || ctx.field.editable;
  }
  // 不在輸入框、也沒開自動找或指令：不用送 AI
  if (!inField && !config.autoFocus && !commandsOn()) return skipNoField(raw, ctx.field.role);
  // 整理完要做什麼：規則在核心（core/flow.mjs 的 planOutput），整理失敗照原稿寫
  const plan = planOutput({ raw, result: prep?.result ?? null });
  if (plan.failed) {
    log(`AI 整理失敗，改貼原稿：${plan.failed}`);
    lastError = { message: plan.failed, at: Date.now() };
  }
  if (plan.kind === 'command') return runVoiceCommand(plan.result, raw, front, ctx);
  if (plan.kind === 'delete_last') { await replaceLast(front, '', '刪掉剛剛那段'); return ''; }
  if (plan.kind === 'revert_last') {
    if (lastInserted?.ai) await replaceLast(front, withSpacing(lastInserted.raw), '換回原文');
    return '';
  }
  if (plan.kind === 'filler') {
    writeLast(raw);
    bubble('hide');
    log('整段只有語氣詞，不寫：', raw);
    return '';
  }
  const result = plan.result ?? null;
  if (!inField) {
    const chosen = config.autoFocus ? await (pick ?? pickField(front.pid, plan.text, ctx)) : null;
    if (!chosen) return skipNoField(raw, ctx.field.role);
    await focusField(chosen);
    ctx = await readContext(front, { screen: false });
  }
  const text = withSpacing(plan.text);
  writeLast(plan.text);
  if (dryPaste) {
    const speed = speedNote(item, prep, Date.now(), Date.now());
    if (speed) log(speed.line);
    emit({ type: 'pasted', text, raw, mode: plan.mode, dry: true, ...(speed ? { latencyMs: speed.parts.total, timing: speed.parts } : {}) });
    return '';
  }
  const pasteStartAt = Date.now();
  const pasted = await axCall('paste', { pid: front.pid, text, ask: !askedAccessibility }, 6000);
  const pastedAt = Date.now();
  if (pasted?.result === 'no-accessibility') {
    if (!askedAccessibility) log('貼不進去：「JarvisVoice」還沒有輔助使用權限，開了就會補貼：', text);
    askedAccessibility = true;
    setError('沒有「輔助使用」權限，字貼不進去：系統設定 → 隱私權與安全性 → 輔助使用，打開「JarvisVoice」');
    return 'retry';
  }
  if (pasted?.result === 'not-front') {
    if (!item.notFront) log('要寫的時候最前面換了 app，等它回到最前面再寫');
    item.notFront = true;
    return 'retry';
  }
  if (pasted?.result?.startsWith('not-text-field')) {
    log('游標不在輸入框，這段沒寫：', text, `（${pasted.result.slice(15)}）`);
    hudWrite('nofield');
    bubble('nofield');
    emit({ type: 'skipped', text, reason: pasted.result });
    return '';
  }
  if (pasted?.result !== 'ok') {
    log('貼上沒成功：', pasted?.result ?? '（小幫手沒回應）');
    return '';
  }
  hudWrite('pasted');
  ctxCache = null; // 游標前後的字變了，下次開口重讀
  const speed = speedNote(item, prep, pasteStartAt, pastedAt);
  log(`已貼上：${text}`);
  if (speed) log(speed.line);
  bubble('pasted');
  emit({ type: 'pasted', text, raw, mode: result?.mode ?? 'insert', ...(speed ? { latencyMs: speed.parts.total, timing: speed.parts } : {}) });
  lastInserted = { pid: front.pid, text, raw, ai: !!result && result.text !== raw };
  if (ctx?.field.editable) rememberedTargets.set(`${front.pid}:${ctx.window}`, { role: ctx.field.role, label: ctx.field.label });
  if (config.ai.history) {
    appendHistory({
      app: ctx?.app ?? '', bundle: front.bundle, raw, text: result ? result.text : raw, mode: result?.mode ?? 'insert',
      ai: result ? `${config.ai.provider}/${result.model}` : '', ms: result?.ms ?? 0, ...(speed ? { latencyMs: speed.parts.total } : {}),
    });
  }
  // 詞彙表自動更新：記下用到的自動詞，不太頻繁地從畫面挑新的專有名詞
  if (aiReady()) void vocab.afterSegment({ screen: ctx?.screen ?? '', text: result ? result.text : raw });
  // AI 整理後貼的，盯一下使用者有沒有自己改專有名詞
  if (result?.mode === 'insert' && pasted.handle && ctx?.field && !ctx.field.selected) {
    learner.watch({ handle: pasted.handle, inserted: text, before: ctx.field.before ?? '', after: ctx.field.after ?? '' });
  }
  return '';
}

async function drainOutput() {
  if (outputBusy) return;
  outputBusy = true;
  try {
    while (outputQueue.length) {
      const item = outputQueue[0];
      if (Date.now() - item.at > HOLD_MS) {
        outputQueue.shift();
        log('一分鐘內都寫不進去（前景是不收音的 app，或沒有輔助使用權限），丟掉一段：', item.text ?? item.raw ?? '');
        continue;
      }
      const front = targetPid ? { bundle: '', pid: targetPid } : always ? { bundle: '', pid: 0 } : await frontApp();
      if (!always && !allowed(front.bundle)) break;
      outputQueue.shift();
      let outcome = '';
      try {
        outcome = await deliver(item, front);
      } catch (err) {
        log(`寫入出錯：${err?.stack || err}`);
      }
      if (outcome === 'retry') { outputQueue.unshift(item); break; }
    }
  } finally {
    outputBusy = false;
  }
}

// ---- 主迴圈 ----

function shutdown(code) {
  if (stopping) return;
  stopping = true;
  stopCapture();
  engine?.close();
  ax.close();
  releaseLock();
  setState('off');
  process.stdout.write('', () => process.exit(code));
}

async function tick() {
  if (stopping) return;
  reloadConfigIfChanged();
  const paused = existsSync(PAUSED);
  if (appMode && process.ppid !== parentPid) { shutdown(0); return; } // 選單列小程式不在了
  const front = always ? { bundle: 'test', pid: 0 } : await frontApp();
  if (!always) lastFront = { ...front, at: Date.now() };
  const active = !paused && (always || allowed(front.bundle));
  frontActive = active;

  if (reopenCapture && ffmpeg && !inputFile) { reopenCapture = false; stopCapture(); }
  if (ffmpeg && !inputFile && Date.now() - lastAudioAt > CAPTURE_STALL_MS) {
    log(`麥克風 ${((Date.now() - lastAudioAt) / 1000).toFixed(1)} 秒沒有聲音進來（ffmpeg 卡住，多半是電腦睡醒或換了麥克風），重開麥克風`);
    stopCapture();
  }
  if (active && !ffmpeg && !inputFile && Date.now() >= captureRetryAt) startCapture();
  if (!active && ffmpeg && !inputFile) stopCapture();
  if (!active && segmenter.has()) segmenter.force(); // 暫停或切到不收音的 app：講到一半的那段先整理

  if (existsSync(VOICEPRINT_RESET)) {
    try { unlinkSync(VOICEPRINT_RESET); } catch { /* 已經處理 */ }
    if (voiceprint) {
      voiceprint.reset();
      log('重錄聲紋：從你接下來講的話錄樣本（約 10 秒，照常轉寫）');
      lastSpeaker = '';
      announceSettings();
    }
  }

  if (existsSync(REVERT)) {
    try { unlinkSync(REVERT); } catch { /* 已經處理 */ }
    enqueueOutput({ kind: 'revert' });
  }

  stageAudio();
  engine.flush();
  engine.housekeeping({ active, quietForMs: Date.now() - lastSpeechAt, speaking: detector.speaking });
  void drainOutput();
  void learner.tick();

  if (paused) setState('paused');
  else if (!active) setState('standby');
  else if (lastError && Date.now() - lastError.at < 15_000) setState('error', lastError.message);
  else if (ffmpeg) setState('listening');
}

async function main() {
  if (!takeLock()) {
    emit({ type: 'state', state: 'already-running' });
    process.exit(3);
  }
  if (appMode) {
    try { if (statSync(LOG).size > 1_000_000) writeFileSync(LOG, ''); } catch { /* 還沒有 log */ }
    // 沒權限就在啟動時跳系統詢問，「JarvisVoice」才會出現在輔助使用清單裡
    const access = await axCall('check', { ask: true });
    if (!access?.trusted) askedAccessibility = true;
    log(`輔助使用權限：${access?.trusted ? '有' : '沒有（字貼不進去：系統設定 → 隱私權與安全性 → 輔助使用，打開「JarvisVoice」）'}`);
  }
  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGINT', () => shutdown(0));
  process.on('exit', releaseLock);
  setState('standby');
  startEngine();
  setInterval(() => { segmenter.check(); updateWorking(); }, SEGMENT_CHECK_MS);

  if (inputFile) {
    startCapture();
    setState('listening');
    const timer = setInterval(() => { stageAudio(); engine.flush(); }, 250);
    await captureEnded;
    finishTurn();
    // 等所有句子轉完、整理完、貼完
    const until = Date.now() + 30_000;
    while (Date.now() < until && (engine.busy() || segmenter.has() || outputQueue.length || outputBusy)) {
      engine.flush();
      if (!engine.busy()) segmenter.force();
      void drainOutput(); // 寫不進去（不在最前面）的那段，等一下再試
      await new Promise((r) => setTimeout(r, 200));
    }
    clearInterval(timer);
    shutdown(0);
    return;
  }

  for (;;) {
    await tick();
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((err) => {
  log(err?.stack || String(err));
  setError(err?.message || String(err));
  releaseLock();
  process.exit(1);
});
