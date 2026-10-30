// JarvisVoice 核心：「自己的 key」直接打各家模型與 TypeSafe Jev（用 fetch，Node 18+ 和瀏覽器都能跑）。
// CubeLV、平行沙盒不用這個，改接自己的後端（扣點數、平台吸收）。

import { hedge } from './hedge.mjs';

export const PROVIDERS = ['openai', 'deepseek', 'claude', 'openai-compatible', 'cubelv'];
export const DEFAULT_MODELS = { openai: 'gpt-6-luna', deepseek: 'deepseek-flash', claude: 'claude-haiku-5-5', 'openai-compatible': '' };
export const PROVIDER_NAMES = { openai: 'OpenAI', deepseek: 'DeepSeek', claude: 'Claude', 'openai-compatible': 'OpenAI 相容（vLLM）' };
export const DEFAULT_URLS = {
  openai: 'https://api.openai.com/v1/chat/completions',
  deepseek: 'https://api.deepseek.com/chat/completions',
  claude: 'https://api.anthropic.com/v1/messages',
  jev: 'https://api.typesafe.ai/v1/systemone',
};

// gpt-5 以後是推理模型：關掉推理才快
function reasoningOff(model) {
  if (/^gpt-5(-|$)/.test(model)) return { reasoning_effort: 'minimal' };
  if (/^(gpt-5\.|gpt-6|o\d)/.test(model)) return { reasoning_effort: 'none' };
  return {};
}

const errorMessage = (name, status, detail) => `${name} AI 編輯失敗（HTTP ${status}）：${detail.match(/"message":\s*"([^"]+)"/)?.[1] ?? detail.slice(0, 160)}`;

// OpenAI 與 DeepSeek 都是 chat completions 格式
// schema 給 null 就只要求是 JSON（欄位靠提示）
async function callChat({ provider, apiKey, model, system, user, signal, schema = null, url, extraBody = {}, onMeta }) {
  const openai = provider === 'openai';
  const compat = provider === 'openai-compatible';
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      ...(openai
        ? {
          response_format: schema ? { type: 'json_schema', json_schema: { name: 'result', strict: true, schema } } : { type: 'json_object' },
          ...reasoningOff(model),
        }
        // vLLM 這類 OpenAI 相容：不用 strict json_schema（很多版本不支援），回傳靠 parseResult 抓 JSON；
        // 預設上限防思考模式失控，extraBody 放最後可蓋掉（含換 response_format）
        : compat
          ? { response_format: { type: 'json_object' }, max_tokens: 2048, ...extraBody }
          // DeepSeek 預設會先推理，關掉才快；JSON 模式只保證是 JSON，欄位靠提示
          : { response_format: { type: 'json_object' }, thinking: { type: 'disabled' }, max_tokens: 2048 }),
    }),
    signal,
  });
  if (!res.ok) throw new Error(errorMessage(PROVIDER_NAMES[provider], res.status, await res.text().catch(() => '')));
  const body = await res.json();
  onMeta?.({ status: res.status, usage: body.usage ?? null });
  return body.choices?.[0]?.message?.content ?? '';
}

async function callClaude({ apiKey, model, system, user, signal, url, onMeta }) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      thinking: { type: 'disabled' }, // Haiku 5.5 預設會先想，關掉才快
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: user }],
    }),
    signal,
  });
  if (!res.ok) throw new Error(errorMessage('Claude', res.status, await res.text().catch(() => '')));
  const body = await res.json();
  onMeta?.({ status: res.status, usage: body.usage ?? null });
  return body.content?.find((part) => part.type === 'text')?.text ?? '';
}


async function askJev({ apiKey, model = 'jev-latest', state, questions, timeoutMs = 4000, url }) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, state, questions }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Jev 決策失敗（HTTP ${res.status}）：${detail.slice(0, 160)}`);
  }
  return (await res.json()).answers ?? {};
}

// 自己的 key 的服務：{ complete, jev }。provider 是 openai／deepseek／claude；沒有 jevKey 就沒有 jev（決策改問 complete）
// hedge：complete 同時送幾份、誰先回用誰（core/hedge.mjs），預設 1 份
export function ownKeyService({ provider = 'openai', model = '', apiKey = '', jevKey = '', jevModel = 'jev-latest', timeoutMs = 6000, urls = {}, extraBody = {}, hedge: copies = 1 } = {}) {
  if (!PROVIDERS.includes(provider)) throw new Error(`ai.provider 只能是 ${PROVIDERS.join('、')}`);
  const u = { ...DEFAULT_URLS, ...urls };
  if (provider === 'openai-compatible' && !u['openai-compatible']) {
    throw new Error('openai-compatible 要在設定檔 ai.baseUrls["openai-compatible"] 寫 chat/completions 的完整網址');
  }
  const chosen = model || DEFAULT_MODELS[provider];
  const once = async ({ system, user, schema = null, timeoutMs: t = timeoutMs, signal: cancel, onMeta }) => {
    const signal = cancel ? AbortSignal.any([cancel, AbortSignal.timeout(t)]) : AbortSignal.timeout(t);
    if (provider === 'claude') return callClaude({ apiKey, model: chosen, system, user, signal, url: u.claude, onMeta });
    return callChat({ provider, apiKey, model: chosen, system, user, schema, signal, url: u[provider], extraBody, onMeta });
  };
  return {
    model: chosen,
    complete: apiKey ? hedge(once, copies) : null,
    jev: jevKey ? ({ state, questions }) => askJev({ apiKey: jevKey, model: jevModel, state, questions, url: u.jev }) : null,
  };
}
