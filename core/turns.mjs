// JarvisVoice 核心：本機斷句。Mac 小程式、CubeLV、平行沙盒都用這一份。
// 每批 24 kHz PCM16 樣本（100 ms）送進來，判斷有沒有人聲，停頓 850 ms 就切一句。
// 轉寫伺服器不斷句（gpt-live-transcribe 不支援 server VAD，gpt-transcribe 的關掉）：本機切好一句 commit 一次，每句才有自己的起訖時間。
//
// 門檻跟著最近 3 秒的底噪走：手機麥克風安靜時會把增益拉高，底噪常常就在固定門檻上下（使用者實錄 RMS 0.011～0.035），
// 一開錄就被當成在講話、整段不斷句，真的開口時那句被標成 0:00。開始一句要比底噪大 3 倍，講話中要比底噪大 2 倍才不算停。
// 底噪＝這段時間第 10 百分位的音量；剛開錄還沒累積 1 秒時當作沒有底噪，只用固定門檻。
// 尖峰也算：短促的子音 RMS 不高、尖峰高，尖峰到門檻的 5 倍（沒有底噪時是 0.055）就算有人聲。
// peakOverNoise（選項）：還沒開口時的尖峰門檻改成「底噪的這麼多倍」（不低於 0.055）。預設照上面（底噪 × 3 × 5＝15 倍）；
// Mac 的內建麥克風在風扇聲裡底噪約 0.009，15 倍是 0.14，比人正常講話的尖峰（0.10～0.18）還高，整句聽不到，Mac 用 9 倍
// （同時量到沒人講話時的尖峰最大約底噪的 7.5 倍）。

const NOISE_WINDOW = 30;
const NOISE_WARMUP = 10;
const NOISE_RISE_IN_TURN = 1.2;
const MIN_LEVEL = 0.011;
const PEAK_OVER_LEVEL = 5;
const START_OVER_NOISE = 3;
const CONTINUE_OVER_NOISE = 2;
const START_MS = 180;
const END_SILENCE_MS = 850;
const FINISH_MIN_MS = 100;

export class AudioTurnDetector {
  constructor({ peakOverNoise = 0 } = {}) {
    this.peakOverNoise = peakOverNoise;
  }

  candidateStart = null;
  voicedMs = 0;
  silenceMs = 0;
  activeStart = null;
  lastVoiceEnd = 0;
  lastVoiced = false; // 最近一批有沒有人聲（算「停了多久」用）
  shortBlips = 0; // 有聲音但不到 180 ms、沒算成一句的次數（給呼叫端記 log，自己歸零）
  missLevel = 0; // 沒在講話時、沒算成人聲的那幾批裡最大的音量與尖峰（診斷門檻是不是太高，給呼叫端記 log，自己歸零）
  missPeak = 0;
  recentLevels = [];

  get speaking() { return this.activeStart !== null; }
  // 有聲音了但還不到 180 ms，還不知道是開口還是雜音
  get starting() { return this.activeStart === null && this.candidateStart !== null; }
  // 正在講的這句從哪裡開始；沒在講是 null
  get currentStartMs() { return this.activeStart; }

  // 現在的底噪和開口門檻（RMS 與尖峰），給呼叫端記 log
  thresholds() {
    const noise = this.noiseLevel();
    const level = Math.max(MIN_LEVEL, noise * START_OVER_NOISE);
    return { noise, level, peak: this.startPeak(noise, level) };
  }

  // 還沒開口時，尖峰要多高才算有人聲
  startPeak(noise, level) {
    return this.peakOverNoise ? Math.max(MIN_LEVEL * PEAK_OVER_LEVEL, noise * this.peakOverNoise) : level * PEAK_OVER_LEVEL;
  }

  push(samples, startMs) {
    if (!samples.length) return null;
    const durationMs = samples.length / 24;
    let sum = 0;
    let peak = 0;
    for (const sample of samples) {
      const value = Math.abs(sample) / 32768;
      sum += value * value;
      if (value > peak) peak = value;
    }
    const level = Math.sqrt(sum / samples.length);
    const noise = this.noiseLevel();
    const threshold = Math.max(MIN_LEVEL, noise * (this.activeStart === null ? START_OVER_NOISE : CONTINUE_OVER_NOISE));
    const peakThreshold = this.activeStart === null ? this.startPeak(noise, threshold) : threshold * PEAK_OVER_LEVEL;
    const voiced = level >= threshold || peak >= peakThreshold;
    this.lastVoiced = voiced;
    // 講話中有人聲的那幾批不把底噪往上拉（最多記成底噪的 1.2 倍）：一直講、中間沒什麼停頓時，3 秒裡大多是自己的聲音，
    // 照原本算底噪會被自己的聲音拉高到 2 倍以上（Mac 10/25 實錄 0.012 → 0.0205），門檻跟著漲，小聲一點的話整段收不到、被切成碎片。
    // 講話中沒聲音的空檔、沒在講話時照原本記，環境變吵還是跟得上；講話中環境真的變吵，底噪也會每 3 秒最多漲 1.2 倍慢慢跟上
    this.recentLevels.push(this.activeStart !== null && voiced && noise > 0 ? Math.min(level, noise * NOISE_RISE_IN_TURN) : level);
    if (this.recentLevels.length > NOISE_WINDOW) this.recentLevels.shift();
    if (!voiced && this.activeStart === null) {
      if (level > this.missLevel) this.missLevel = level;
      if (peak > this.missPeak) this.missPeak = peak;
    }
    if (voiced) {
      if (this.candidateStart === null) this.candidateStart = startMs;
      this.voicedMs += durationMs;
      this.silenceMs = 0;
      this.lastVoiceEnd = startMs + durationMs;
      if (this.activeStart === null && this.voicedMs >= START_MS) this.activeStart = this.candidateStart;
      return null;
    }
    if (this.activeStart === null) {
      if (this.voicedMs > 0) this.shortBlips += 1;
      this.candidateStart = null;
      this.voicedMs = 0;
      return null;
    }
    this.silenceMs += durationMs;
    if (this.silenceMs < END_SILENCE_MS) return null;
    return this.takeTurn();
  }

  // 收音停了、截圖分界：講到一半的那句（有聲音 100 ms 以上）也切出來
  finish() {
    if (this.activeStart === null && this.candidateStart !== null && this.voicedMs >= FINISH_MIN_MS) {
      this.activeStart = this.candidateStart;
    }
    if (this.activeStart !== null) return this.takeTurn();
    // 不到門檻的尾巴也丟掉，下一句才不會沿用上一段的開始時間
    if (this.voicedMs > 0) this.shortBlips += 1;
    this.candidateStart = null;
    this.voicedMs = 0;
    this.silenceMs = 0;
    this.lastVoiceEnd = 0;
    return null;
  }

  noiseLevel() {
    if (this.recentLevels.length < NOISE_WARMUP) return 0;
    const sorted = [...this.recentLevels].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 10)];
  }

  takeTurn() {
    const turn = { startMs: this.activeStart, endMs: this.lastVoiceEnd };
    this.candidateStart = null;
    this.voicedMs = 0;
    this.silenceMs = 0;
    this.activeStart = null;
    this.lastVoiceEnd = 0;
    return turn;
  }
}

// 斷句加上該送出去的聲音：開口前的 0.4 秒（4 批）先留著，判定開口時一起送，句子開頭的子音才不會被切掉；
// 講話中每批照送，停頓夠久切一句。沒在講話的聲音不送。
// push／finish 回傳 { audio, turn, tentative, resumed }：audio 是這次要送出去的聲音（PCM16 的位元組，0～5 批），
// turn 是切出來的那句（沒有是 null）。
// 暫定斷句：講話中停了 tentativeMs（預設 400 ms）先報一次 tentative，呼叫端可以先把到這裡的聲音送去轉寫；
// 還沒切句又有人聲就報 resumed（先送的那份作廢），沒有就等 850 ms 照常切句，先送的那份就是這句的結果（中間只有靜音）。
// 存起來的是傳進來那批樣本本身，呼叫端每批要給新的陣列，不能重複用同一塊。
export class TurnSplitter {
  constructor({ preRollBatches = 4, tentativeMs = 400, peakOverNoise = 0 } = {}) {
    this.detector = new AudioTurnDetector({ peakOverNoise });
    this.preRoll = [];
    this.preRollBatches = preRollBatches;
    this.tentativeMs = tentativeMs;
    this.tentativeOpen = false; // 報過 tentative、還沒切句也還沒又開口
  }

  get speaking() { return this.detector.speaking; }
  get currentStartMs() { return this.detector.currentStartMs; }

  push(samples, startMs) {
    const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
    const wasSpeaking = this.detector.speaking;
    const turn = this.detector.push(samples, startMs);
    let audio = [];
    if (wasSpeaking) {
      audio = [bytes];
    } else if (this.detector.speaking) {
      audio = [...this.preRoll, bytes];
      this.preRoll = [];
    } else {
      this.preRoll.push(bytes);
      if (this.preRoll.length > this.preRollBatches) this.preRoll.shift();
    }
    let tentative = false;
    let resumed = false;
    if (turn) this.tentativeOpen = false;
    else if (this.detector.speaking && this.tentativeMs > 0) {
      if (this.tentativeOpen && this.detector.lastVoiced) {
        this.tentativeOpen = false;
        resumed = true;
      } else if (!this.tentativeOpen && this.detector.silenceMs >= this.tentativeMs) {
        this.tentativeOpen = true;
        tentative = true;
      }
    }
    return { audio, turn, tentative, resumed };
  }

  finish() {
    const turn = this.detector.finish();
    const audio = turn ? this.preRoll : [];
    this.preRoll = [];
    this.tentativeOpen = false;
    return { audio, turn, tentative: false, resumed: false };
  }
}
