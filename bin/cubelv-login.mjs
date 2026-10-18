#!/usr/bin/env node
// 選單「用 CubeLV 登入…」「登出 CubeLV」做的事（app/ui.js 帶起來，做完就結束）。終端機也可以直接跑：
//   node ~/jarvis-voice/bin/cubelv-login.mjs           登入：打開瀏覽器到 CubeLV 按允許（--use engine／ai：只切轉寫或只切 AI 整理）
//   node ~/jarvis-voice/bin/cubelv-login.mjs logout    登出：撤銷這條連線、清掉 token，轉寫與 AI 整理換回登入前的設定
// 登入成功就把轉寫與 AI 整理切到 CubeLV（按「用 CubeLV 登入」就是要用 CubeLV），原本的設定記在設定檔的 cubelv.previous，
// 登出時換回來；之後也可以從選單各自換回本機辨識或自己的 key。常駐程式看到設定檔與登入狀態改了會自己換。
// stdout 每行一個 JSON：{ type: 'cubelv', state: 'open'（請打開這個網址）| 'waiting' | 'done' | 'logged_out' | 'error', ... }。

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_PATH, STATE_DIR, loadConfig } from './config.mjs';
import { CubeLVError, login, logout } from './cubelv.mjs';

const emit = (event) => process.stdout.write(`${JSON.stringify({ type: 'cubelv', ...event })}\n`);
const zh = /^zh/i.test(process.env.VOICE_DICTATION_LANG || process.env.LANG || '');
const t = (zhText, enText) => (zh ? zhText : enText);

// 改設定檔：讀進來、改、寫回去（壞掉的設定檔不蓋掉）
export function updateConfigFile(change, path = CONFIG_PATH) {
  let config = {};
  if (existsSync(path)) config = JSON.parse(readFileSync(path, 'utf8'));
  change(config);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, `${JSON.stringify(config, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
}

// 登入成功：轉寫與 AI 整理（use 是 engine／ai 時只切那一個）切到 CubeLV，原本的（不是 CubeLV 的）記在 cubelv.previous
export function useCubeLV(config, use = 'all') {
  const before = config.cubelv?.previous ?? {};
  const previous = { ai: { ...before.ai } };
  if (config.engine !== 'cubelv') previous.engine = config.engine;
  else if (before.engine) previous.engine = before.engine;
  if (config.ai?.provider !== 'cubelv') {
    previous.ai = {};
    if (config.ai?.provider) previous.ai.provider = config.ai.provider;
    if (typeof config.ai?.enabled === 'boolean') previous.ai.enabled = config.ai.enabled;
  }
  config.cubelv = { ...config.cubelv, previous };
  if (use !== 'ai') config.engine = 'cubelv';
  if (use !== 'engine') config.ai = { ...config.ai, enabled: true, provider: 'cubelv' };
  return config;
}

// 登出：還在用 CubeLV 的換回登入前的設定（沒記到就回預設：本機辨識、AI 整理挑有 key 的那家）
export function stopUsingCubeLV(config) {
  const previous = config.cubelv?.previous ?? {};
  if (config.engine === 'cubelv') {
    if (previous.engine && previous.engine !== 'cubelv') config.engine = previous.engine;
    else delete config.engine;
  }
  if (config.ai?.provider === 'cubelv') {
    if (previous.ai?.provider && previous.ai.provider !== 'cubelv') config.ai.provider = previous.ai.provider;
    else delete config.ai.provider;
    if (typeof previous.ai?.enabled === 'boolean') config.ai.enabled = previous.ai.enabled;
    else delete config.ai.enabled;
    if (!Object.keys(config.ai).length) delete config.ai;
  }
  if (config.cubelv) {
    delete config.cubelv.previous;
    if (!Object.keys(config.cubelv).length) delete config.cubelv;
  }
  return config;
}

// macOS 用預設瀏覽器打開；其他系統（或 VOICE_DICTATION_OPEN_URL=print）印出網址請人自己開
function openUrl(url) {
  if (process.platform !== 'darwin' || process.env.VOICE_DICTATION_OPEN_URL === 'print') {
    emit({ state: 'open', url, message: t('用瀏覽器打開這個網址登入 CubeLV', 'Open this URL in a browser to sign in to CubeLV') });
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/open', [url], { timeout: 10_000 }, (err) => (err ? reject(new Error(t(`打不開瀏覽器：${err.message}`, `Couldn't open the browser: ${err.message}`))) : resolve()));
  });
}

async function main() {
  const { config } = loadConfig();
  const apiUrl = config.cubelv.apiUrl;
  if (process.argv[2] === 'logout') {
    await logout({ apiUrl, stateDir: STATE_DIR });
    updateConfigFile(stopUsingCubeLV);
    emit({ state: 'logged_out', message: t('已登出 CubeLV，轉寫與 AI 整理換回原本的設定', 'Signed out of CubeLV; transcription and AI cleanup are back to your previous setup') });
    return;
  }
  const controller = new AbortController();
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => controller.abort());
  const { email, quotaExceeded } = await login({
    apiUrl, stateDir: STATE_DIR, openUrl, signal: controller.signal,
    onWaiting: () => emit({ state: 'waiting', message: t('瀏覽器打開了：在 CubeLV 按「允許」', 'Your browser is open: choose Allow in CubeLV') }),
  });
  const flag = process.argv.indexOf('--use');
  const use = ['engine', 'ai'].includes(process.argv[flag + 1]) && flag > 0 ? process.argv[flag + 1] : 'all';
  updateConfigFile((c) => useCubeLV(c, use));
  emit({
    state: 'done', email, quotaExceeded,
    message: quotaExceeded
      ? t('已登入 CubeLV，但點數用完了：到 CubeLV 加值後就能用', 'Signed in to CubeLV, but you are out of credits: top up in CubeLV to use it')
      : t('已登入 CubeLV：轉寫與 AI 整理改用 CubeLV 點數', 'Signed in to CubeLV: transcription and AI cleanup now use your CubeLV credits'),
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((err) => {
    emit({ state: 'error', code: err instanceof CubeLVError ? err.code : 'failed', message: err.message });
    process.exitCode = 1;
  });
}
