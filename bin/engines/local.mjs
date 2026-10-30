// 本機轉寫：sherpa-onnx 跑 SenseVoice-Small（普通話、英文、粵語、日文、韓文），聲音不離開這台電腦、不花錢。
// 每句（listen.mjs 切好的）整句丟進去辨識，一句一句照順序出字。
// 送辨識前先過一道 Silero VAD：沒有人聲的句子（鍵盤聲、通知聲這類）當雜音不送——
// SenseVoice 對雜音會幻覺出「The.」「I.」這種單字，直接貼進輸入框。模型沒下載就不擋（照舊）。

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { STATE_DIR } from '../config.mjs';

const require = createRequire(import.meta.url);

const VAD_MODEL = join(STATE_DIR, 'models', 'silero_vad.onnx');
const VAD_WINDOW = 512; // Silero 固定窗大小（16kHz 樣本數，32 ms）
// 人聲窗佔比低於這個就判整句沒人聲。實錄：鍵盤聲 0.00、最短的真句（三字）0.35，中間留夠空間
const NO_SPEECH_RATIO = 0.05;

export function createLocalEngine({ model, language = 'auto', threads = 2, onFinal, onError, log }) {
  const modelFile = join(model, 'model.int8.onnx');
  const tokens = join(model, 'tokens.txt');
  let sherpa = null;
  let recognizer = null;
  let resampler = null;
  let vad = null;
  let failed = '';
  try {
    if (!existsSync(modelFile) || !existsSync(tokens)) throw new Error(`找不到本機模型：${model}（重跑 install.sh 會下載）`);
    sherpa = require('sherpa-onnx-node');
    recognizer = new sherpa.OfflineRecognizer({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        senseVoice: { model: modelFile, language, useInverseTextNormalization: 1 },
        tokens,
        numThreads: threads,
        provider: 'cpu',
        debug: 0,
      },
    });
  } catch (err) {
    failed = err.message;
    log(failed);
    onError(failed);
  }

  if (recognizer) {
    try {
      if (!existsSync(VAD_MODEL)) log(`沒有人聲偵測模型：${VAD_MODEL}（重跑 install.sh 會下載），先不過濾非人聲的聲音`);
      else vad = new sherpa.Vad({
        sileroVad: { model: VAD_MODEL, threshold: 0.5, minSilenceDuration: 0.5, minSpeechDuration: 0.25, windowSize: VAD_WINDOW },
        sampleRate: 16000,
        numThreads: 1,
      });
    } catch (err) {
      log(`人聲偵測模型載入失敗，先不過濾非人聲的聲音：${err.message}`);
      vad = null;
    }
  }

  let chunks = [];
  let bytes = 0;
  const queue = []; // 每句的 Float32Array（16kHz）
  let decoding = false;

  // 第一次辨識要暖機兩三秒，先拿半秒靜音跑一次，第一句話才不會慢
  let warming = recognizer
    ? (async () => {
      try {
        const stream = recognizer.createStream();
        stream.acceptWaveform({ samples: new Float32Array(8000), sampleRate: 16000 });
        await recognizer.decodeAsync(stream);
      } catch { /* 暖機失敗就等第一句再說 */ }
    })()
    : Promise.resolve();

  const to16k = (buffer) => {
    const i16 = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2);
    const f32 = Float32Array.from(i16, (v) => v / 32768);
    resampler ??= new sherpa.LinearResampler(24000, 16000);
    resampler.reset(); // 每句各自一段，不接上一句的尾巴
    return resampler.flush(f32);
  };

  // VAD 判定為人聲的窗佔比（16kHz 的 float）；沒有 VAD 回 1（不擋）
  const speechRatio = (f16) => {
    if (!vad) return 1;
    vad.reset();
    let speech = 0;
    let total = 0;
    for (let i = 0; i + VAD_WINDOW <= f16.length; i += VAD_WINDOW) {
      vad.acceptWaveform(f16.slice(i, i + VAD_WINDOW));
      total += 1;
      if (vad.isDetected()) speech += 1;
    }
    return total ? speech / total : 0;
  };

  async function drain() {
    if (decoding) return;
    decoding = true;
    try {
      await warming;
      warming = Promise.resolve();
      while (queue.length) {
        const samples = queue.shift();
        const started = Date.now();
        const stream = recognizer.createStream();
        stream.acceptWaveform({ samples, sampleRate: 16000 });
        await recognizer.decodeAsync(stream);
        const { text } = recognizer.getResult(stream);
        log(`本機辨識 ${(samples.length / 16000).toFixed(1)} 秒音訊用 ${Date.now() - started} ms`);
        onFinal(text ?? '');
      }
    } catch (err) {
      log('本機辨識失敗，這句沒寫：', err.message);
      onError(`本機辨識失敗：${err.message}`);
    } finally {
      decoding = false;
    }
  }

  return {
    append(buffer) { chunks.push(buffer); bytes += buffer.length; },
    commit() {
      const whole = Buffer.concat(chunks, bytes);
      chunks = [];
      bytes = 0;
      if (!recognizer) {
        log(`本機模型沒載入，這句沒寫${failed ? `：${failed}` : ''}`);
        if (failed) onError(failed);
        return;
      }
      if (whole.length < 3200) { // 不到 0.07 秒，當雜音
        log(`這句只有 ${(whole.length / 48000).toFixed(2)} 秒，當雜音沒送辨識`);
        return;
      }
      const f16 = to16k(whole);
      const ratio = speechRatio(f16);
      if (ratio < NO_SPEECH_RATIO) {
        log(`這句 ${(whole.length / 48000).toFixed(1)} 秒沒有人聲（VAD 人聲窗 ${ratio.toFixed(2)}），當雜音沒送辨識`);
        return;
      }
      queue.push(f16);
      void drain();
    },
    flush() {},
    busy: () => queue.length > 0 || decoding,
    housekeeping() {},
    skip() { chunks = []; bytes = 0; }, // 這句不要（聲紋不像使用者）
    close() { chunks = []; bytes = 0; queue.length = 0; },
  };
}

// 即時預覽：雲端轉寫時，講話中用本機 SenseVoice 認目前這句（一句 0.15 秒左右），只拿來在游標旁的小框顯示、不貼。
// 載不起來（沒下載模型）就沒有預覽，不算錯。recognize(pcm24k) → 認出來的字（簡體，呼叫端轉正體）
const PREVIEW_MAX_SECONDS = 15; // 很長的一句只認最後 15 秒，免得越講越慢
export function createPreviewer({ model, threads = 2, log = () => {} }) {
  let recognizer = null;
  let sherpa = null;
  try {
    const modelFile = join(model, 'model.int8.onnx');
    const tokens = join(model, 'tokens.txt');
    if (!existsSync(modelFile) || !existsSync(tokens)) {
      log(`沒有本機模型（${model}），講話中不顯示即時預覽`);
      return null;
    }
    sherpa = require('sherpa-onnx-node');
    recognizer = new sherpa.OfflineRecognizer({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: { senseVoice: { model: modelFile, language: 'auto', useInverseTextNormalization: 1 }, tokens, numThreads: threads, provider: 'cpu', debug: 0 },
    });
  } catch (err) {
    log(`即時預覽的本機模型載不起來，不顯示預覽：${err.message}`);
    return null;
  }
  const resampler = new sherpa.LinearResampler(24000, 16000);
  return {
    async recognize(pcm) {
      const keep = PREVIEW_MAX_SECONDS * 48000;
      const tail = pcm.length > keep ? pcm.subarray(pcm.length - keep) : pcm;
      const i16 = new Int16Array(tail.buffer, tail.byteOffset, Math.floor(tail.length / 2));
      resampler.reset();
      const samples = resampler.flush(Float32Array.from(i16, (v) => v / 32768));
      const stream = recognizer.createStream();
      stream.acceptWaveform({ samples, sampleRate: 16000 });
      await recognizer.decodeAsync(stream);
      return recognizer.getResult(stream).text ?? '';
    },
  };
}
