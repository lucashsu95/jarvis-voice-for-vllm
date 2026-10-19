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

export const VOICEPRINT_THRESHOLD = 0.3;
export const VOICEPRINT_MIN_SECONDS = 1.5; // 比這短的句子用 VOICEPRINT_SHORT_THRESHOLD
export const VOICEPRINT_SHORT_THRESHOLD = 0.4;
// 錄樣本要收到這麼多秒的講話：實測 3 秒自己被擋 19%、5～10 秒約 1 成、10 秒以上沒有再變好
export const ENROLL_SECONDS = 10;
const ENROLL_MIN_TURN = 1; // 錄樣本只收 1 秒以上的句子
const ENROLL_CLUSTER = 0.45; // 錄樣本時，跟大多數句子像到這個程度才算同一個人（混進來的別人剔除）
const ADAPT_MIN = 0.5; // 很確定是自己（而且 2 秒以上）的句子加進「最近的聲音」，聲音隨環境、時間變也跟得上
const ADAPT_SECONDS = 2;
const ADAPT_KEEP = 10;

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
      if (score >= ADAPT_MIN && sec >= ADAPT_SECONDS) {
        recent = [...recent, Array.from(v)].slice(-ADAPT_KEEP);
        refresh();
      }
      return { pass: true, verdict: 'mine', score };
    },
    reset() {
      enrolled = [];
      recent = [];
      pending = [];
      ref = null;
    },
    state: () => ({ enrolled, recent, pending }),
  };
}
