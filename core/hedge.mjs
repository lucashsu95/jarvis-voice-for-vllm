// JarvisVoice 核心：同一個請求同時送幾份，誰先成功用誰，其他的取消。
// 雲端模型偶爾會有一次特別慢（轉寫 0.5 秒的請求拖到 1 秒以上）：同時送兩份，兩份都慢的機會小很多。
// call 是 (args) => Promise，要吃 args.signal（取消用）；全部失敗才丟錯（丟第一份的錯）。copies 1 以下就是原本的 call。
export function hedge(call, copies = 2) {
  if (!(copies > 1)) return call;
  return (args = {}) => {
    const controllers = Array.from({ length: copies }, () => new AbortController());
    const signalFor = (c) => (args.signal ? eitherSignal(args.signal, c.signal) : c.signal);
    return Promise.any(controllers.map((c, i) => call({ ...args, signal: signalFor(c) }).then((value) => ({ value, i })))).then(
      ({ value, i }) => {
        controllers.forEach((c, j) => { if (j !== i) c.abort(); });
        return value;
      },
      (err) => { throw err?.errors?.[0] ?? err; },
    );
  };
}

// 兩個 signal 任一個取消就取消。AbortSignal.any 在 iOS 17.4 以前的 WebView 沒有（CubeLV、平行沙盒的手機殼支援到 iOS 15），沒有就自己接
function eitherSignal(a, b) {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([a, b]);
  const controller = new AbortController();
  for (const s of [a, b]) {
    if (s.aborted) { controller.abort(s.reason); break; }
    s.addEventListener('abort', () => controller.abort(s.reason), { once: true });
  }
  return controller.signal;
}
