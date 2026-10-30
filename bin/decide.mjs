// Mac 小程式的第三層決策：題目、門檻、決策器在核心（core/decide.mjs），這裡接「自己的 key」的 Jev 和 AI。

import { createDecider as coreCreateDecider } from '../core/decide.mjs';
import { service } from './editor.mjs';

export * from '../core/decide.mjs';

// settings()：{ jevKey, jevModel, ai }（ai 是 { provider, model, apiKey, timeoutMs, cubelvUrl }，AI 整理能用時才給；
// 沒有 Jev 時、或 Jev 拿不準時用。用 CubeLV 登入時沒有 apiKey，complete 打 CubeLV 後端）
export function createDecider(settings) {
  return coreCreateDecider(() => {
    const s = settings();
    let svc;
    try {
      svc = service({ ...(s.ai ?? {}), jevKey: s.jevKey, jevModel: s.jevModel });
    } catch {
      return { jev: null, complete: null }; // 設定有問題（例：compat 沒 baseUrl）＝沒有決策器，照規則跑，不能把整段話丟掉
    }
    return { jev: svc.jev, complete: s.ai && (s.ai.apiKey || s.ai.provider === 'cubelv') ? svc.complete : null };
  });
}
