// 自己 debug 用（設定 debug.saveAudio，預設關）：存音檔到 <狀態資料夾>/audio/，對照 listen.log 查哪一關丟了字。
//   - 每一句：turn-<時間>-<流水號>-<結果>-<秒數>s.wav，就是拿去比聲紋、送去轉寫的那段（含開口前 0.4 秒）；
//     結果是聲紋的判定（mine 你、short 短句、other 擋掉、enrolling 錄樣本中），沒開聲紋是 pass。log 那一行會寫檔名。
//   - 麥克風：mic-<開始時間>.wav，每分鐘一個，沒被當成講話（沒切成句子）的聲音也查得到。
// 句子留最近 400 個、麥克風留最近 30 個（約 30 分鐘），舊的刪掉。

import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from './config.mjs';
import { wavFromPcm16 } from './engines/batch.mjs';

export const AUDIO_DIR = join(STATE_DIR, 'audio');
const KEEP_TURNS = 400;
const KEEP_MIC = 30;
const MIC_BYTES = 24000 * 2 * 60;

const stamp = (at) => at.toISOString().replace(/[:.]/g, '-');

// enabled()：每次看設定（設定檔改了不用重開）
export function createAudioDebug({ enabled, log }) {
  let mic = [];
  let micBytes = 0;
  let micStarted = null;
  let turns = 0; // 檔名加流水號：同一毫秒切出兩句也不會蓋掉

  function write(name, pcm, prefix, keep) {
    try {
      mkdirSync(AUDIO_DIR, { recursive: true });
      writeFileSync(join(AUDIO_DIR, name), wavFromPcm16(pcm));
      const files = readdirSync(AUDIO_DIR).filter((f) => f.startsWith(prefix)).sort();
      for (const f of files.slice(0, Math.max(0, files.length - keep))) unlinkSync(join(AUDIO_DIR, f));
      return name;
    } catch (err) {
      log(`存音檔失敗：${err.message}`);
      return '';
    }
  }

  function flush() {
    if (!micBytes) return;
    write(`mic-${stamp(micStarted)}.wav`, Buffer.concat(mic, micBytes), 'mic-', KEEP_MIC);
    mic = [];
    micBytes = 0;
    micStarted = null;
  }

  return {
    // 一句的聲音（PCM16 Buffer 陣列）；回傳檔名，沒開或存不了是空字串
    turn(chunks, { verdict, sec }) {
      if (!enabled()) return '';
      turns += 1;
      return write(`turn-${stamp(new Date())}-${String(turns).padStart(5, '0')}-${verdict}-${sec.toFixed(1)}s.wav`, Buffer.concat(chunks), 'turn-', KEEP_TURNS);
    },
    // 麥克風收到的每一批（100 ms）；滿一分鐘存一個檔
    mic(chunk) {
      if (!enabled()) {
        mic = [];
        micBytes = 0;
        micStarted = null;
        return;
      }
      micStarted ??= new Date();
      mic.push(chunk);
      micBytes += chunk.length;
      if (micBytes >= MIC_BYTES) flush();
    },
    // 關麥克風、結束時把不滿一分鐘的也存下來
    flush,
  };
}
