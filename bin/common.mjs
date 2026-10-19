// Mac 小程式收音的共用部分：取樣率、ffmpeg 位置；斷句在核心。

import { existsSync } from 'node:fs';

export const SAMPLE_RATE = 24000;
export const BATCH_SAMPLES = 2400; // 100 ms 一批，跟 app 的 AudioWorklet 一樣
export const BATCH_BYTES = BATCH_SAMPLES * 2;

export function findFfmpeg() {
  for (const p of [process.env.FFMPEG_PATH, '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']) {
    if (p && existsSync(p)) return p;
  }
  return 'ffmpeg';
}

// 本機斷句在核心（core/turns.mjs），跟平行沙盒 app 同一套。
// lsappinfo 的輸出欄位名在 macOS 27 改過（"CFBundleIdentifier"= → bundleID=），兩種都認
export function parseFrontAppInfo(info) {
  return {
    bundle: info.match(/"CFBundleIdentifier"="([^"]*)"/)?.[1] ?? info.match(/\bbundleID\s*=\s*"([^"]*)"/)?.[1] ?? '',
    pid: Number(info.match(/"pid"=(\d+)/)?.[1] ?? info.match(/\bpid\s*[=:]\s*(\d+)/i)?.[1] ?? 0),
  };
}

export { AudioTurnDetector, TurnSplitter } from '../core/turns.mjs';
