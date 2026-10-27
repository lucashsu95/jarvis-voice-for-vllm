// JarvisVoice 核心：一直收音時，幾句合成一段才整理（Mac 小程式、CubeLV 的「一直聽」共用）。
//   每句都轉完、而且停了 pauseMs 才算一段講完。
//   提早整理（pasteAfterMs）：每句都轉完、沒在講話就先整理這段（不等 pauseMs），整理好時已經停了 pasteAfterMs 就算講完；
//   又開口或又多一句就作廢，等整段講完一起整理（結果跟不提早一樣）。
//   一直講不停太長（maxChars）就先整理這一段；force() 之後下一次 check 就交出去（暫停、切到不收音的 app、收音結束）。
// 接頭：
//   state() → { speaking：正在講, starting：有聲音了但還不知道是不是開口, busy：還有句子在轉寫, lastVoiceAt：最後一次聽到人聲 }
//   prepare(raw, signal) → Promise：提早整理（作廢時 signal 會 abort）；onWorking(raw)：開始整理了（小框「整理中」）
//   onSegment({ raw, heard, prepared, earlyPolish })：這段講完了，prepared 是提早整理的結果（沒提早就是 null）
// 數字可以給函式（設定檔改了跟著變）。

import { withSpacing } from './text.mjs';

const value = (v) => (typeof v === 'function' ? v() : v);

export const SEGMENT_PAUSE_MS = 1800;
export const PASTE_AFTER_MS = 1200;
export const MAX_SEGMENT_CHARS = 1500;

export function createSegmenter({
  pauseMs = SEGMENT_PAUSE_MS,
  pasteAfterMs = PASTE_AFTER_MS,
  maxChars = MAX_SEGMENT_CHARS,
  state,
  prepare = null,
  onWorking = () => {},
  onSegment,
  log = () => {},
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (timer) => clearTimeout(timer),
}) {
  let segment = null; // { parts, chars, heard：最後一句的資訊（給速度量測） }
  let forced = false;
  let early = null; // { raw, controller, prepared, done, timer }
  const raw = () => (segment ? segment.parts.map(withSpacing).join('').trim() : '');

  const drop = (reason) => {
    if (!early) return;
    early.controller.abort();
    if (early.timer !== null) clearTimer(early.timer);
    early = null;
    log(`提早整理作廢：${reason}`);
  };

  const finish = (text) => {
    const prepared = early && early.raw === text ? early.prepared : null;
    if (early?.timer != null) clearTimer(early.timer);
    early = null;
    const { heard } = segment;
    segment = null;
    forced = false;
    onSegment({ raw: text, heard, prepared, earlyPolish: !!prepared });
  };

  const startEarly = (text) => {
    const controller = new AbortController();
    const mine = { raw: text, controller, done: false, timer: null };
    mine.prepared = Promise.resolve().then(() => prepare(text, controller.signal)).catch((err) => {
      log(`提早整理出錯：${err?.stack || err}`);
      return null;
    });
    mine.prepared.then(() => {
      mine.done = true;
      if (early === mine) check();
    });
    early = mine;
    onWorking(text);
  };

  function check() {
    if (!segment) return;
    const s = state();
    if (s.speaking) { drop('又開口了'); return; }
    if (s.busy) { drop('又有一句在轉寫'); return; }
    const text = raw();
    if (early && early.raw !== text) drop('又多了一句');
    const quietMs = now() - s.lastVoiceAt;
    if (forced || segment.chars >= value(maxChars) || quietMs >= value(pauseMs)) { finish(text); return; }
    const pasteAfter = value(pasteAfterMs);
    if (!(pasteAfter > 0) || !prepare) return;
    if (!early) { startEarly(text); return; }
    if (!early.done || s.starting) return; // 有聲音了、還不知道是不是又開口：等一下
    if (quietMs >= pasteAfter) finish(text);
    else early.timer ??= setTimer(() => { if (early) early.timer = null; check(); }, pasteAfter - quietMs + 5);
  }

  return {
    /** 轉好的一句（heard：這句的時間資訊，交給 onSegment） */
    add(text, heard) {
      segment ??= { parts: [], chars: 0 };
      segment.parts.push(text);
      segment.chars += text.length;
      segment.heard = heard;
    },
    check,
    /** 下一次 check 不等安靜就交出去 */
    force() { forced = true; },
    /** 開口了：提早整理作廢 */
    drop,
    /** 有一段還沒交出去 */
    has: () => !!segment,
    /** 這段到目前為止轉好的句子 */
    parts: () => segment?.parts ?? [],
    /** 正在提早整理的那段原稿（沒有就是 null） */
    working: () => early?.raw ?? null,
    raw,
    /** 丟掉這段（不交出去） */
    clear() { drop('丟掉這段'); segment = null; forced = false; },
  };
}

// 小框顯示目前聽到的：這段已經轉好的字＋還在講（或還在轉）的那幾句的預覽
export function heardText(parts = [], previews = []) {
  return [...parts, ...previews].map(withSpacing).join('').trim();
}

// 講話中小框寫什麼：Mac 小程式、CubeLV 都叫這一個，不要各自寫；要不一樣就加參數。
//   heard：這一段轉好的字（過了聲紋才轉，就是確認是使用者講的）；live：再加上還在講、還在轉的那幾句預覽；
//   working：停一下先整理的原稿；speaking：正在講；speaker：聲紋標籤（mine、short；聲紋還在背景學就給空的）；
//   ignored：剛切完的這句聲紋不像使用者時給本機預覽聽到的字（沒擋就不給）；lastMine：最近比過聲紋的那句是使用者的。
//   confirmedOnly 不開（Mac 小程式、CubeLV 按著講）：一開口就跟著出字，講完才標是誰講的；別人講的說「別人在講話」。
//   confirmedOnly 開（CubeLV 一直聽，2026-10-27 使用者：一直跳「聽到」很煩，確認是我的才跳）：這段有句子轉好才出來，
//     接著講的那句，上一句是你的才帶預覽；別人講的不跳。
//   回傳 { state: 'working' | 'hearing' | 'ignored', text, speaker }，null 就不顯示「聽到」（正在顯示就收）。
export function speechBubble({ heard = '', live = '', working = '', speaking = false, speaker = '', ignored, lastMine = false, confirmedOnly = false } = {}) {
  if (ignored !== undefined && !confirmedOnly) return { state: 'ignored', text: ignored, speaker: '' };
  if (working && !speaking) return { state: 'working', text: working, speaker: '' };
  if (confirmedOnly) {
    if (!heard) return null;
    return { state: 'hearing', text: lastMine && live.length > heard.length ? live : heard, speaker };
  }
  const text = live.length >= heard.length ? live : heard;
  if (!speaking && !text) return null;
  return { state: 'hearing', text, speaker: speaking ? '' : speaker };
}
