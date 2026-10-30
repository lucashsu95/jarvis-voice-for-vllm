// Mac 小程式的 AI 整理：規則和解析在核心（core/editor.mjs），這裡接「自己的 key」（core/providers.mjs），
// 或用 CubeLV 登入時的 CubeLV 後端（bin/cubelv.mjs，扣 CubeLV 點數）。
// 測試可以用環境變數把各家的網址換成本機假伺服器。

import { editSegment as coreEditSegment, parseResult, SCHEMA } from '../core/editor.mjs';
import { DEFAULT_MODELS as CORE_MODELS, PROVIDERS as CORE_PROVIDERS, PROVIDER_NAMES as CORE_NAMES, ownKeyService } from '../core/providers.mjs';
import { loadConfig } from './config.mjs';
import { aiLog } from './ai-log.mjs';
import { cubelvSession } from './cubelv.mjs';

export { MODES, SCHEMA, buildPrompt, parseResult } from '../core/editor.mjs';
export const PROVIDERS = [...CORE_PROVIDERS, 'cubelv'];
export const DEFAULT_MODELS = { ...CORE_MODELS, cubelv: 'auto' };
export const PROVIDER_NAMES = { ...CORE_NAMES, cubelv: 'CubeLV' };

const envUrls = () => Object.fromEntries(Object.entries({
  openai: process.env.VOICE_DICTATION_OPENAI_CHAT_URL,
  deepseek: process.env.VOICE_DICTATION_DEEPSEEK_URL,
  claude: process.env.VOICE_DICTATION_ANTHROPIC_URL,
  jev: process.env.VOICE_DICTATION_JEV_URL,
}).filter(([, v]) => v));

// AI 的服務：{ model, complete, jev }。provider 是 cubelv 時 complete 打 CubeLV 後端（cubelvUrl），不雙發（每一份都扣點數）；
// Jev 照樣用自己的 key（有的話）。baseUrl／extraBody 是 openai-compatible（vLLM）用
export function service({ provider = 'openai', model, apiKey, timeoutMs, jevKey, jevModel, baseUrl, extraBody, hedge, cubelvUrl } = {}) {
  let svc;
  if (provider === 'cubelv') {
    const own = ownKeyService({ jevKey, jevModel, urls: envUrls() });
    const cubelv = cubelvSession(cubelvUrl);
    svc = {
      model: 'CubeLV',
      complete: ({ system, user, timeoutMs: t = timeoutMs, signal }) => cubelv.complete({ system, user, signal, timeoutMs: t }),
      jev: own.jev,
    };
  } else {
    const urls = { ...envUrls(), ...(baseUrl ? { [provider]: baseUrl } : {}) };
    svc = ownKeyService({ provider, model, apiKey, timeoutMs, jevKey, jevModel, urls, extraBody, hedge });
    if (!svc.complete) return svc;
  }
  // 每次打 AI 都記一筆（bin/ai-log.mjs）：prompt、原樣回傳、耗時、token 用量。
  // kind 分三種：edit（整理）、terms（學詞）、other（決策等）；parsed 只有 edit 才有意義
  const kindOf = (req) => (req.schema === SCHEMA ? 'edit' : req.schema?.properties?.terms ? 'terms' : 'other');
  // gateway 若注入了自己的 system prompt（例：BIRC LiteLLM，實測約 435 tokens），我們送的 system 會被蓋掉：
  // ai.inlineSystem 開時把規則併進 user 訊息（model 對 user 裡的指令遵循正常，probe 驗證過）。
  const inlineSystem = !!loadConfig().config.ai.inlineSystem;
  const complete = svc.complete;
  svc.complete = async (req) => {
    const r = inlineSystem && req.system ? { ...req, system: '', user: `${req.system}\n\n${req.user ?? ''}` } : req;
    const started = Date.now();
    let meta = {};
    let raw = '';
    let error = null;
    try {
      raw = await complete({ ...r, onMeta: (m) => { meta = m; } });
      return raw;
    } catch (err) {
      error = err.message;
      throw err;
    } finally {
      const kind = kindOf(r);
      aiLog({ type: 'ai-call', kind, provider, model: svc.model, ms: Date.now() - started, system: r.system ?? '', user: r.user ?? '',
        raw, ...(kind === 'edit' ? { parsed: parseResult(raw, { commands: true }) } : {}),
        usage: meta.usage ?? null, status: meta.status ?? null, error });
    }
  };
  return svc;
}

function check(provider, apiKey, what) {
  if (!PROVIDERS.includes(provider)) throw new Error(`ai.provider 只能是 ${PROVIDERS.join('、')}`);
  if (!apiKey && provider !== 'cubelv') throw new Error(`${what}沒有 ${PROVIDER_NAMES[provider]} API key`);
}

// 通用：照 system／user 問一次，回模型吐的字（要 JSON 的話自己 parse）
export async function ask({ provider = 'openai', model, apiKey, timeoutMs = 6000, system, user, schema = null, baseUrl, extraBody, hedge, cubelvUrl }) {
  check(provider, apiKey, 'AI ');
  return service({ provider, model, apiKey, timeoutMs, baseUrl, extraBody, hedge, cubelvUrl }).complete({ system, user, schema });
}

// 回傳 { mode, text, ms, model }；失敗丟錯，呼叫端改貼原稿。hedge：同時送幾份、誰先回用誰；signal：取消（提早整理作廢時）
export async function editSegment({ provider = 'openai', model, apiKey, timeoutMs = 6000, baseUrl, extraBody, hedge = 1, signal, cubelvUrl, ...input }) {
  check(provider, apiKey, 'AI 編輯');
  const svc = service({ provider, model, apiKey, timeoutMs, baseUrl, extraBody, hedge, cubelvUrl });
  const complete = signal ? (args) => svc.complete({ ...args, signal }) : svc.complete;
  return { ...(await coreEditSegment({ complete, ...input })), model: svc.model };
}
