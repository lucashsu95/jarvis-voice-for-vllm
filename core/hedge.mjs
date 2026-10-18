// JarvisVoice 核心：同一個請求同時送幾份，誰先成功用誰，其他的取消。
// 雲端模型偶爾會有一次特別慢（轉寫 0.5 秒的請求拖到 1 秒以上）：同時送兩份，兩份都慢的機會小很多。
// call 是 (args) => Promise，要吃 args.signal（取消用）；全部失敗才丟錯（丟第一份的錯）。copies 1 以下就是原本的 call。
export function hedge(call, copies = 2) {
  if (!(copies > 1)) return call;
  return (args = {}) => {
    const controllers = Array.from({ length: copies }, () => new AbortController());
    const signalFor = (c) => (args.signal ? AbortSignal.any([args.signal, c.signal]) : c.signal);
    return Promise.any(controllers.map((c, i) => call({ ...args, signal: signalFor(c) }).then((value) => ({ value, i })))).then(
      ({ value, i }) => {
        controllers.forEach((c, j) => { if (j !== i) c.abort(); });
        return value;
      },
      (err) => { throw err?.errors?.[0] ?? err; },
    );
  };
}
