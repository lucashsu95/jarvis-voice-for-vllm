// Mac 小程式的 AI 整理：規則和解析在核心（core/editor.mjs），這裡接「自己的 key」（core/providers.mjs）。
// 測試可以用環境變數把各家的網址換成本機假伺服器。

import { editSegment as coreEditSegment } from '../core/editor.mjs';
import { PROVIDERS, PROVIDER_NAMES, ownKeyService } from '../core/providers.mjs';

export { MODES, SCHEMA, buildPrompt, parseResult } from '../core/editor.mjs';
export { PROVIDERS, DEFAULT_MODELS, PROVIDER_NAMES } from '../core/providers.mjs';

const envUrls = () => Object.fromEntries(Object.entries({
  openai: process.env.VOICE_DICTATION_OPENAI_CHAT_URL,
  deepseek: process.env.VOICE_DICTATION_DEEPSEEK_URL,
  claude: process.env.VOICE_DICTATION_ANTHROPIC_URL,
  jev: process.env.VOICE_DICTATION_JEV_URL,
}).filter(([, v]) => v));

// 自己的 key 的服務：{ model, complete, jev }
export function service({ provider = 'openai', model, apiKey, timeoutMs, jevKey, jevModel, hedge } = {}) {
  return ownKeyService({ provider, model, apiKey, timeoutMs, jevKey, jevModel, hedge, urls: envUrls() });
}

function check(provider, apiKey, what) {
  if (!PROVIDERS.includes(provider)) throw new Error(`ai.provider 只能是 ${PROVIDERS.join('、')}`);
  if (!apiKey) throw new Error(`${what}沒有 ${PROVIDER_NAMES[provider]} API key`);
}

// 通用：照 system／user 問一次，回模型吐的字（要 JSON 的話自己 parse）
export async function ask({ provider = 'openai', model, apiKey, timeoutMs = 6000, system, user, schema = null }) {
  check(provider, apiKey, 'AI ');
  return service({ provider, model, apiKey, timeoutMs }).complete({ system, user, schema });
}

// 回傳 { mode, text, ms, model }；失敗丟錯，呼叫端改貼原稿。hedge：同時送幾份、誰先回用誰；signal：取消（提早整理作廢時）
export async function editSegment({ provider = 'openai', model, apiKey, timeoutMs = 6000, hedge = 1, signal, ...input }) {
  check(provider, apiKey, 'AI 編輯');
  const svc = service({ provider, model, apiKey, timeoutMs, hedge });
  const complete = signal ? (args) => svc.complete({ ...args, signal }) : svc.complete;
  return { ...(await coreEditSegment({ complete, ...input })), model: svc.model };
}
