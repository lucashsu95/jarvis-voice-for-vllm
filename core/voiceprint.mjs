// JarvisVoice 核心：聲紋過濾——只轉寫使用者自己的聲音（咖啡店裡別人講話、影片的聲音不轉寫、不貼）。
// 聲紋（speaker embedding）由呼叫端算（Mac 用 sherpa-onnx 的 CAM++ 中文模型），這裡只放比對規則：錄樣本、判斷、越用越準。
//
// 10/19 實測（CAM++ zh-cn、使用者自己的錄音 208 段、別人 234 段）：
//   - 同一支麥克風：自己對樣本 5%～95% 是 0.26～0.78，別人最高 0.27；門檻 0.3 時別人 0%、自己被擋 7.6%。
//   - 不到 1.5 秒的短句用門檻 0.4。跟樣本不同場次的錄音量，自己的短句分數偏低（0.5～1.2 秒的片段，門檻 0.1 時
//     自己被擋 7～11%、別人擋下約 8 成）；但同一個地方錄樣本、同一個地方用（10/19 在咖啡店實測），自己的短句
//     「你好，你好，你好」0.75、「哎呀，累」0.77，別人的「發言」0.24、雜音 0.20～0.31，0.1 會讓別人的短句通過。
//     換到差很多的環境時自己很短的回答可能被擋（小框會寫「別人在講話」附上那句的字），多了就重錄聲紋。
//   - 換了麥克風，自己只剩 0.2～0.4：樣本要用同一支麥克風錄（Mac 用平常收音的那支，第一次開就從講話裡錄）。
//   - 旁邊有人講話（別人音量是自己的 1/3～1/2）：門檻 0.3 自己被擋 9～16%。
//
// 手機不裝模型（CubeLV、平行沙盒）：聲紋由轉寫的後端算（同一個 CAM++ 模型），規則照樣在這裡、跑在前端——
// 前端把 gate()（參考聲紋＋門檻）交給後端，後端每句照 passesGate 擋；每句的聲紋送回前端，由 createRemoteVoiceprint 記樣本、越用越準。
// 計劃：CubeLV cubelv_docs/計劃/2026-10-19_只聽我的聲音_後端聲紋.md
//
// 長句門檻依個人調（10/19 驗證：Mac 使用者 237 句、AISHELL 251 位沒見過的陌生人、sr-data；
// CubeLV cubelv_docs 計劃/2026-10-19_聲紋門檻依個人自動調.md）：
//   - 不能用「錄樣本時彼此的分數」：樣本是同一場錄的，彼此很像（平均 0.75），換場次本人會掉很多，照它調門檻本人被擋 6% → 25～65%。
//   - 改看兩件事，取高的、夾在 [0.3, 0.5]：
//     一、最像你的陌生人有多像（比對群 252 人，voiceprint-cohort.mjs）＋0.05——你的聲音跟某些人很像，門檻就高一點；
//     二、越用越準：很確定是你的句子（2 秒以上、0.5 以上）滿 10 句後，最近 50 句分數的第 10 百分位 − 0.2——
//        你平常都很高分，門檻就跟著往上，聲音像你的旁人（雷軍對劉德華 0.30～0.46）就擋得住。
//   - 照錄音先後模擬：本人被擋 6.2%（固定 0.3 是 5.2%），陌生人通過 0.01% → 0%，用一陣子後門檻 0.36～0.49。
//   - 短句門檻不跟著升（維持 0.4），免得本人的短回答被擋更多。

import { COHORT_DATA, COHORT_DIM, COHORT_SCALES } from './voiceprint-cohort.mjs';

export const VOICEPRINT_THRESHOLD = 0.3; // 長句門檻的下限（依個人調不會比這寬）
export const VOICEPRINT_THRESHOLD_CAP = 0.5; // 長句門檻的上限
export const VOICEPRINT_MIN_SECONDS = 1.5; // 比這短的句子用 VOICEPRINT_SHORT_THRESHOLD
export const VOICEPRINT_SHORT_THRESHOLD = 0.4;
// 錄樣本要收到這麼多秒的講話：實測 3 秒自己被擋 19%、5～10 秒約 1 成、10 秒以上沒有再變好
export const ENROLL_SECONDS = 10;
const ENROLL_MIN_TURN = 1; // 錄樣本只收 1 秒以上的句子
const ENROLL_CLUSTER = 0.45; // 錄樣本時，跟大多數句子像到這個程度才算同一個人（混進來的別人剔除）
const ADAPT_MIN = 0.5; // 很確定是自己（而且 2 秒以上）的句子加進「最近的聲音」，聲音隨環境、時間變也跟得上
const ADAPT_SECONDS = 2;
const ADAPT_KEEP = 10;
const COHORT_MARGIN = 0.05; // 門檻至少比最像你的陌生人高這麼多
const USAGE_MIN = 10; // 很確定是你的句子記滿這麼多句之後，門檻才跟著你平常的分數走
const USAGE_KEEP = 50; // 只看最近這麼多句
const USAGE_PERCENTILE = 0.1;
const USAGE_DELTA = 0.2; // 門檻＝最近分數的第 10 百分位減這麼多
// 後端算聲紋用的模型（sherpa-onnx 3dspeaker_speech_campplus_sv_zh-cn_16k-common）：存檔記著，換了模型就重錄
export const REMOTE_VOICEPRINT_MODEL = 'campplus-zh-cn-16k-common';

export function normalize(v) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return Array.from(v, (x) => x / n);
}

export function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += a[i] * b[i];
  return s;
}

// 幾個聲紋的平均（照秒數加權），再正規化
export function meanVector(items) {
  if (!items.length) return null;
  const m = new Array(items[0].v.length).fill(0);
  for (const { v, sec = 1 } of items) v.forEach((x, i) => { m[i] += x * sec; });
  return normalize(m);
}

// 錄樣本收到的幾句裡，挑彼此最像的那群：先找跟其他句子平均最像的那句，再留下跟它那群夠像的
export function pickEnrollment(items) {
  if (items.length < 2) return items;
  let best = items[0];
  let bestScore = -Infinity;
  for (const a of items) {
    const score = items.reduce((s, b) => s + (a === b ? 0 : cosine(a.v, b.v) * b.sec), 0);
    if (score > bestScore) { bestScore = score; best = a; }
  }
  const near = items.filter((x) => x === best || cosine(x.v, best.v) >= ENROLL_CLUSTER);
  const center = meanVector(near);
  return items.filter((x) => cosine(x.v, center) >= ENROLL_CLUSTER);
}

// 後端照這條擋（CubeLV ai_prompt、平行沙盒 control 各寫一份同樣的判斷）：沒有擋法（還在錄樣本）、算不出聲紋都放行；
// 短句用短句的門檻。跟 judge() 的放不放行一樣。
export function passesGate(gate, score, sec) {
  if (!gate || score === null || score === undefined) return true;
  return score >= (sec < gate.minSeconds ? gate.shortThreshold : gate.threshold);
}

// 比對群（252 位陌生人的平均聲紋）：第一次用到才解開
let cohortCache = null;
export function defaultCohort() {
  if (cohortCache) return cohortCache;
  const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const data = new Int8Array(bytes(COHORT_DATA).buffer);
  const scales = new Float32Array(bytes(COHORT_SCALES).buffer);
  cohortCache = Array.from(scales, (scale, i) => normalize(Array.from(data.subarray(i * COHORT_DIM, (i + 1) * COHORT_DIM), (q) => (q / 127) * scale)));
  return cohortCache;
}

// 這個人的長句門檻：最像他的陌生人＋0.05、最近放行的句子分數的第 10 百分位 − 0.2（滿 10 句才算），取高的，夾在 [floor, cap]。
// 比對群跟參考聲紋維度不同（換了模型、測試用的假聲紋）就不看比對群。
export function personalThreshold({ reference, scores = [], cohort = defaultCohort(), floor = VOICEPRINT_THRESHOLD, cap = VOICEPRINT_THRESHOLD_CAP }) {
  let th = floor;
  if (reference && cohort.length && cohort[0].length === reference.length) {
    let nearest = -1;
    for (const c of cohort) nearest = Math.max(nearest, cosine(reference, c));
    th = Math.max(th, nearest + COHORT_MARGIN);
  }
  if (scores.length >= USAGE_MIN) {
    const recent = scores.slice(-USAGE_KEEP).sort((a, b) => a - b);
    th = Math.max(th, recent[Math.floor(USAGE_PERCENTILE * (recent.length - 1))] - USAGE_DELTA);
  }
  return Math.min(Math.max(cap, floor), th);
}

// state：{ enrolled: [聲紋], recent: [聲紋], pending: [{ v, sec }], scores: [最近放行的句子分數] }（存檔用，聲紋是一般陣列）
// threshold 是長句門檻的下限；實際門檻依個人調（personalThreshold），threshold() 看現在是多少。
export function createVoiceprint({ state = {}, threshold = VOICEPRINT_THRESHOLD, minSeconds = VOICEPRINT_MIN_SECONDS, shortThreshold = VOICEPRINT_SHORT_THRESHOLD, cohort } = {}) {
  let enrolled = state.enrolled ?? [];
  let recent = state.recent ?? [];
  let pending = state.pending ?? [];
  let scores = state.scores ?? [];
  let ref = null;
  let current = threshold;
  const updateThreshold = () => {
    current = ref ? personalThreshold({ reference: ref, scores, cohort: cohort ?? defaultCohort(), floor: threshold }) : threshold;
  };
  const refresh = () => {
    ref = meanVector([...enrolled.map((v) => ({ v, sec: 2 })), ...recent.map((v) => ({ v, sec: 1 }))]);
    updateThreshold();
  };
  refresh();
  const pendingSeconds = () => pending.reduce((s, x) => s + x.sec, 0);

  return {
    enrolled: () => enrolled.length > 0,
    // 還要錄幾秒樣本
    needSeconds: () => (enrolled.length ? 0 : Math.max(0, ENROLL_SECONDS - pendingSeconds())),
    // 一句講完：v 是這句的聲紋（正規化過），sec 是秒數。回傳 { pass, verdict, score }
    //   verdict：enrolling（還在錄樣本，照常轉寫）、enrolled（這句湊滿樣本）、short（短句，用短句的門檻放行）、mine、other
    // dryRun：只看不記（講到一半停頓時先比一下，不把半句算進樣本、不加進最近的聲音）
    judge(v, sec, { dryRun = false } = {}) {
      if (dryRun) {
        if (!enrolled.length) return { pass: true, verdict: 'enrolling', score: null };
        const score = cosine(v, ref);
        if (sec < minSeconds) return { pass: score >= shortThreshold, verdict: score >= shortThreshold ? 'short' : 'other', score };
        return { pass: score >= current, verdict: score >= current ? 'mine' : 'other', score };
      }
      if (!enrolled.length) {
        if (sec >= ENROLL_MIN_TURN) pending.push({ v: Array.from(v), sec });
        if (pendingSeconds() >= ENROLL_SECONDS && pending.length >= 3) {
          const picked = pickEnrollment(pending);
          if (picked.reduce((s, x) => s + x.sec, 0) >= ENROLL_SECONDS * 0.6) {
            enrolled = picked.map((x) => x.v);
            pending = [];
            refresh();
            return { pass: true, verdict: 'enrolled', score: 1, kept: picked.length };
          }
          pending = picked; // 太多句不像同一個人：只留像的那群，繼續收
        }
        return { pass: true, verdict: 'enrolling', score: null };
      }
      const score = cosine(v, ref);
      if (sec < minSeconds) return { pass: score >= shortThreshold, verdict: score >= shortThreshold ? 'short' : 'other', score };
      if (score < current) return { pass: false, verdict: 'other', score };
      // 越用越準：很確定是自己的句子（2 秒以上、0.5 以上）加進「最近的聲音」，分數也記下來讓門檻跟著走。
      // 只記 0.5 以上：漏網的旁人（0.3～0.46）不會混進來把門檻往下拉，記不記也跟現在門檻無關，門檻不會自己越墊越高。
      if (score >= ADAPT_MIN && sec >= ADAPT_SECONDS) {
        scores = [...scores, Math.round(score * 1e4) / 1e4].slice(-USAGE_KEEP);
        recent = [...recent, Array.from(v)].slice(-ADAPT_KEEP);
        refresh();
      }
      return { pass: true, verdict: 'mine', score };
    },
    // 現在的長句門檻（依個人調過）
    threshold: () => current,
    // 給後端的擋法：參考聲紋（樣本＋最近的聲音的平均）與門檻；還在錄樣本是 null。參考聲紋變了才會換成新的陣列
    gate: () => (enrolled.length ? { reference: ref, threshold: current, shortThreshold, minSeconds } : null),
    reset() {
      enrolled = [];
      recent = [];
      pending = [];
      scores = [];
      ref = null;
      current = threshold;
    },
    state: () => ({ enrolled, recent, pending, scores }),
  };
}

// createRemoteVoiceprint —— 前端用（手機不裝模型）：聲紋由轉寫的後端每句算好送回來（voiceprint.turn），這裡記樣本、越用越準、存檔。
//   store：{ load() → 存過的（沒有是 null）, save(存檔), clear() }。存哪由各 app 決定（CubeLV：裝置本機，每個帳號、每支麥克風一份）。
//   onChange({ enrolled, needSeconds, pass, verdict, score })：每句判斷完（畫面顯示還要講幾秒、略過了幾句）。
// 回傳的 transcription 交給 createSpeechTranscription／createTranscriber 的 voiceprint 選項。
export function createRemoteVoiceprint({ store, onChange = () => {}, ...opts }) {
  let saved = null;
  try { saved = store.load(); } catch { /* 讀不到就重錄 */ }
  const vp = createVoiceprint({ ...opts, state: saved?.model === REMOTE_VOICEPRINT_MODEL ? saved : {} });
  const round = (v) => v.map((x) => Math.round(x * 1e4) / 1e4);
  const save = () => {
    const s = vp.state();
    try {
      store.save({
        model: REMOTE_VOICEPRINT_MODEL, at: Date.now(),
        enrolled: s.enrolled.map(round), recent: s.recent.map(round), pending: s.pending.map((x) => ({ v: round(x.v), sec: x.sec })), scores: s.scores,
      });
    } catch { /* 存不進去：下次重錄 */ }
  };
  const clear = () => {
    vp.reset();
    try { store.clear(); } catch { /* 本來就沒有 */ }
  };
  return {
    enrolled: () => vp.enrolled(),
    needSeconds: () => vp.needSeconds(),
    // 重錄：刪掉存的聲紋，從接下來講的話重新錄（正在轉寫的話，呼叫端再叫 updateVoiceprint() 把新的擋法送給後端）
    reset: clear,
    transcription: {
      config: () => vp.gate(),
      // 後端用的模型跟存檔的不一樣：存的聲紋比不了，重錄。回傳 true＝擋法變了，核心再送一次設定
      onReady(info) {
        if (!info?.model || info.model === REMOTE_VOICEPRINT_MODEL || !vp.enrolled()) return false;
        clear();
        return true;
      },
      // 一句的結果（後端放行或擋掉都會來）：有聲紋就記進樣本／最近的聲音。回傳 true＝擋法變了（剛錄好、最近的聲音更新）
      onTurn(event) {
        const pass = event.pass !== false;
        if (!event.embedding?.length) {
          onChange({ enrolled: vp.enrolled(), needSeconds: vp.needSeconds(), pass, verdict: pass ? 'short' : 'other', score: event.score ?? null });
          return false;
        }
        const wasEnrolled = vp.enrolled();
        const before = vp.gate();
        const scoresBefore = vp.state().scores.length;
        const r = vp.judge(normalize(event.embedding), event.seconds ?? 0);
        const after = vp.gate();
        // 擋法變了：剛錄好、最近的聲音更新（參考聲紋換新）、門檻依個人調動了
        const changed = after?.reference !== before?.reference || after?.threshold !== before?.threshold;
        if (!wasEnrolled || changed || vp.state().scores.length !== scoresBefore) save();
        onChange({ enrolled: vp.enrolled(), needSeconds: vp.needSeconds(), pass, verdict: pass ? r.verdict : 'other', score: event.score ?? r.score });
        return changed;
      },
    },
  };
}
