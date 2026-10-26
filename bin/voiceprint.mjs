// Mac 小程式的聲紋過濾：sherpa-onnx 的 CAM++ 中文聲紋模型在本機算每句的聲紋，比對規則在核心（core/voiceprint.mjs）。
// 聲紋（一串數字，不是錄音）只存在本機 <狀態資料夾>/voiceprint.json；不存原始聲音、不送出去。
// 模型沒裝（install.sh 會下載）就不過濾，每句照常轉寫。

import { chmodSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createVoiceprint, normalize } from '../core/voiceprint.mjs';

const require = createRequire(import.meta.url);
export const VOICEPRINT_MODEL = 'campplus_zh.onnx';

export function createVoiceprintFilter({ model, file, threshold, minSeconds, shortThreshold, log = () => {} }) {
  let extractor = null;
  let sherpa = null;
  try {
    if (!existsSync(model)) {
      log(`沒有聲紋模型（${model}，重跑 install.sh 會下載），不過濾別人的聲音`);
      return null;
    }
    sherpa = require('sherpa-onnx-node');
    extractor = new sherpa.SpeakerEmbeddingExtractor({ model, numThreads: 1, debug: 0 });
  } catch (err) {
    log(`聲紋模型載不起來，不過濾別人的聲音：${err.message}`);
    return null;
  }
  const resampler = new sherpa.LinearResampler(24000, 16000);
  let saved = {};
  try { if (existsSync(file)) saved = JSON.parse(readFileSync(file, 'utf8')); } catch { /* 壞檔就重錄 */ }
  const vp = createVoiceprint({ state: saved.model === VOICEPRINT_MODEL ? saved : {}, threshold, minSeconds, shortThreshold });

  const save = () => {
    try {
      const tmp = `${file}.${process.pid}`;
      const round = (v) => v.map((x) => Math.round(x * 1e4) / 1e4);
      const s = vp.state();
      writeFileSync(tmp, JSON.stringify({
        model: VOICEPRINT_MODEL, at: Date.now(),
        enrolled: s.enrolled.map(round), recent: s.recent.map(round), pending: s.pending.map((x) => ({ v: round(x.v), sec: x.sec })), session: s.session,
      }));
      chmodSync(tmp, 0o600);
      renameSync(tmp, file);
    } catch (err) {
      log(`聲紋存不起來：${err.message}`);
    }
  };

  // pcm：這句的聲音（24 kHz PCM16）
  function embed(pcm) {
    const i16 = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
    resampler.reset();
    const samples = resampler.flush(Float32Array.from(i16, (x) => x / 32768));
    const stream = extractor.createStream();
    stream.acceptWaveform({ sampleRate: 16000, samples });
    stream.inputFinished();
    if (!extractor.isReady(stream)) return null;
    return normalize(extractor.compute(stream));
  }

  const record = (v, sec) => {
    const before = vp.enrolled();
    const r = vp.judge(v, sec);
    if (!before || r.verdict === 'mine') save();
    return { ...r, threshold: vp.threshold() };
  };

  return {
    enrolled: () => vp.enrolled(),
    // 這一場的長句門檻（同一場跟著你的分數往上提，核心 voiceprint.mjs）
    threshold: () => vp.threshold(),
    // 一句講完：回傳 { pass, verdict, score, ms, v }。算不出來（太短）就放行。
    // dryRun：講到一半停頓時先比一下（不記進樣本），之後同一句講完用 commit(v, sec) 記
    check(pcm, sec, { dryRun = false } = {}) {
      const started = Date.now();
      const v = embed(pcm);
      if (!v) return { pass: true, verdict: 'short', score: null, ms: Date.now() - started, v: null };
      const r = dryRun ? vp.judge(v, sec, { dryRun: true }) : record(v, sec);
      return { ...r, ms: Date.now() - started, v };
    },
    commit(v, sec) {
      return v ? { ...record(v, sec), ms: 0, v } : { pass: true, verdict: 'short', score: null, ms: 0, v: null };
    },
    reset() {
      vp.reset();
      try { unlinkSync(file); } catch { /* 本來就沒有 */ }
    },
  };
}
