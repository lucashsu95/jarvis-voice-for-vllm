// JarvisVoice 核心：聲紋過濾——只轉寫使用者自己的聲音（咖啡店裡別人講話、影片的聲音不轉寫、不貼）。
// 聲紋（speaker embedding）由呼叫端算（Mac 用 sherpa-onnx 的 CAM++ 中文模型），這裡只放比對規則：錄樣本、判斷、越用越準。
//
// 10/19 實測（CAM++ zh-cn、使用者自己的錄音 208 段、別人 234 段）：
//   - 同一支麥克風：自己對樣本 5%～95% 是 0.26～0.78，別人最高 0.27。
//   - 同一個地方錄樣本、同一個地方用（咖啡店）：自己的短句「你好，你好，你好」0.75、「哎呀，累」0.77，別人的「發言」0.24、雜音 0.20～0.31。
//   - 換了麥克風，自己只剩 0.2～0.4：樣本要用同一支麥克風錄（Mac 用平常收音的那支，第一次開就從講話裡錄；CubeLV 每支麥克風各一份）。
//   - 旁邊有人講話（別人音量是自己的 1/3～1/2）：門檻 0.3 自己被擋 9～16%。
//
// 手機不裝模型（CubeLV、平行沙盒）：聲紋由轉寫的後端算（同一個 CAM++ 模型），規則照樣在這裡、跑在前端——
// 前端把 gate()（參考聲紋＋門檻）交給後端，後端每句照 passesGate 擋；每句的聲紋送回前端，由 createRemoteVoiceprint 記樣本、越用越準。
// 計劃：CubeLV cubelv_docs/計劃/2026-10-19_只聽我的聲音_後端聲紋.md
//
// 門檻（10/19 驗證，CubeLV cubelv_docs 計劃/2026-10-19_聲紋門檻依個人自動調.md）：user 要「本人被擋 1% 以下，陌生人可以多放一點」。
//   照錄音先後模擬錄好樣本後每天用（Mac 使用者 10 段錄音、有內容的 198 句；AISHELL 251 位沒見過的陌生人；中間穿插旁人講話）：
//   - 長句 0.2：本人被擋 0.4%，陌生人通過 0.1%。0.25 就開始擋到本人真的講的話（1.4%），0.3 是 2.8%。
//   - 短句 0.05（把本人的句子切成 1 秒當短句）：本人被擋 0.7%，陌生人的 1 秒片段通過 3.8%；0.1 是 1.6%／1.0%，原本的 0.4 是 22%。
//   - 代價：聲音很像你的人會過（雷軍當本人時劉德華全過）；咖啡店裡別人很短的話、雜音（0.20～0.31）也會過。
//   - 「依個人往上調門檻」（最像你的陌生人、你平常的分數）會讓本人被擋升到 6% 以上，跟這個目標相反，不做。
//   - 本人分數最低的那些「句子」多半不是本人在講話：語助詞與雜音（「嗯」「H.」）、影片或旁人（0.00～0.11）、跟店員對話夾著店員的聲音。

export const VOICEPRINT_THRESHOLD = 0.2;
export const VOICEPRINT_MIN_SECONDS = 1.5; // 比這短的句子用 VOICEPRINT_SHORT_THRESHOLD
export const VOICEPRINT_SHORT_THRESHOLD = 0.05;
// 錄樣本要收到這麼多秒的講話：實測 3 秒自己被擋 19%、5～10 秒約 1 成、10 秒以上沒有再變好
export const ENROLL_SECONDS = 10;
const ENROLL_MIN_TURN = 1; // 錄樣本只收 1 秒以上的句子
const ENROLL_CLUSTER = 0.45; // 錄樣本時，跟大多數句子像到這個程度才算同一個人（混進來的別人剔除）
const ADAPT_MIN = 0.5; // 很確定是自己（而且 2 秒以上）的句子加進「最近的聲音」，聲音隨環境、時間變也跟得上
const ADAPT_SECONDS = 2;
const ADAPT_KEEP = 10;
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

// state：{ enrolled: [聲紋], recent: [聲紋], pending: [{ v, sec }] }（存檔用，聲紋是一般陣列）
export function createVoiceprint({ state = {}, threshold = VOICEPRINT_THRESHOLD, minSeconds = VOICEPRINT_MIN_SECONDS, shortThreshold = VOICEPRINT_SHORT_THRESHOLD } = {}) {
  let enrolled = state.enrolled ?? [];
  let recent = state.recent ?? [];
  let pending = state.pending ?? [];
  let ref = null;
  const refresh = () => {
    ref = meanVector([...enrolled.map((v) => ({ v, sec: 2 })), ...recent.map((v) => ({ v, sec: 1 }))]);
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
        return { pass: score >= threshold, verdict: score >= threshold ? 'mine' : 'other', score };
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
      if (score < threshold) return { pass: false, verdict: 'other', score };
      // 越用越準：很確定是自己的句子（2 秒以上、0.5 以上）加進「最近的聲音」。只收 0.5 以上：漏網的旁人（多在 0.2～0.46）不會混進來。
      if (score >= ADAPT_MIN && sec >= ADAPT_SECONDS) {
        recent = [...recent, Array.from(v)].slice(-ADAPT_KEEP);
        refresh();
      }
      return { pass: true, verdict: 'mine', score };
    },
    // 長句門檻
    threshold: () => threshold,
    // 給後端的擋法：參考聲紋（樣本＋最近的聲音的平均）與門檻；還在錄樣本是 null。參考聲紋變了才會換成新的陣列
    gate: () => (enrolled.length ? { reference: ref, threshold, shortThreshold, minSeconds } : null),
    reset() {
      enrolled = [];
      recent = [];
      pending = [];
      ref = null;
    },
    state: () => ({ enrolled, recent, pending }),
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
        enrolled: s.enrolled.map(round), recent: s.recent.map(round), pending: s.pending.map((x) => ({ v: round(x.v), sec: x.sec })),
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
        const r = vp.judge(normalize(event.embedding), event.seconds ?? 0);
        const after = vp.gate();
        // 擋法變了：剛錄好、最近的聲音更新（參考聲紋換新）
        const changed = after?.reference !== before?.reference;
        if (!wasEnrolled || changed) save();
        onChange({ enrolled: vp.enrolled(), needSeconds: vp.needSeconds(), pass, verdict: pass ? r.verdict : 'other', score: event.score ?? r.score });
        return changed;
      },
    },
  };
}
