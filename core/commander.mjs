// JarvisVoice 核心：第三層的指令模式：講「進到台積電的個股頁」「打開設定」「搜尋鴻海」「幫我傳給 BU 說你好」，直接操作最前面的 app。
// 每一步：列出畫面上可以操作的東西（讀不到畫面的 app 用截圖認出來的字補上）→ 決策器（Jev）挑
// 「點、填字、按 Enter、寫訊息、完成、做不到」和對象 → 做 → 等畫面更新。
// 寫訊息前先確認現在打開的是和對的人的對話，不是就停、不寫。寫完就結束，不送出。
// 決策：能讀到畫面的 app 用 Jev（快）；截圖認出來的畫面、Jev 沒把握、做了畫面沒變，這一步改問 AI。
// 做到決策器說完成或做不到為止；信心太低（動作 < 0.3、對象 < 0.25）、同一步做了畫面沒變、做了 maxSteps 步、按「暫停收音」就停。
// 換到了目標講的那一頁（goalReached）就算完成，不再問決策器（模型看到新頁上還有同名的按鈕，常會一直點下去）。

import { describeElement, recipientQuestion, stepQuestions } from './decide.mjs';

// screen 是看畫面、動手的接頭（Mac 小程式接輔助使用與截圖認字；App 內接自己的畫面）：
//   screen.elements({ limit, ocr }) → { window, elements: [{ handle, role, subrole, label, value, x, y, w, h, focused, ocr }], source }
//   screen.act({ handle, action: 'press' | 'fill' | 'enter' | 'clickAt', text, x, y }) → { result: 'ok' | ... }

const SETTLE_MS = 700;
const ACTION_MIN = 0.3;
const TARGET_MIN = 0.25;
const RECIPIENT_MIN = 0.6; // 寫訊息前，確定是和對的人的對話
const ESCALATE_BELOW = 0.5; // Jev 對下一步沒把握，這一步改問 AI
export const MAX_COMMAND_STEPS = 12; // 畫面一直在變時靠這個停

/**
 * 已經到了：做過至少一步、換到了另一頁，而且新頁的標題（拆成幾個詞）都在目標裡。
 * 例：目標「打開行事曆」、換到「行事曆」；目標「打開台積電（2330）的個股頁」、換到「台積電 2330」。
 */
export function goalReached(goal, title, startTitle, doneSteps) {
  if (doneSteps < 1 || !title || title === startTitle) return false;
  const words = title.split(/[\s|｜\-–—:：·・/()（）]+/).filter((w) => w.length >= 2 || /\d/.test(w));
  return words.length > 0 && words.every((w) => goal.includes(w));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 訊息框：最下面的多行輸入框；沒有就最下面、裡面不是搜尋字的輸入框
export function messageBox(list, searchText = '') {
  const fields = list.filter((e) => ['AXTextArea', 'AXTextField', 'AXComboBox'].includes(e.role) && e.subrole !== 'AXSearchField'
    && e.subrole !== 'AXSecureTextField' && (e.value ?? '') !== searchText);
  const bottom = (a, b) => (b.y + b.h) - (a.y + a.h);
  return fields.filter((e) => e.role === 'AXTextArea').sort(bottom)[0] ?? fields.sort(bottom)[0] ?? null;
}

// 傳訊息給某人：照固定的步驟走，不讓決策器在畫面上亂點（像 LINE 這種只能截圖認字的 app，亂點會點到頭像、進到編輯）
//   1. 已經是和這個人的對話 → 寫進訊息框，結束（不送出）
//   2. 搜尋框裡還不是這個名字 → 填名字
//   3. 搜尋框下面第一個含這個名字的結果 → 點，等畫面換好再確認；不是對的人就停（不試下一個，免得打開別的群組、寫錯對話）
async function sendMessage({ screen, decider, log, text, message, context, stopped }) {
  const done = [];
  const tried = new Set();
  let clicked = 0; // 點了搜尋結果之後，還可以再確認幾次
  const canAsk = !!decider.canEscalate?.();
  const name = text.toLowerCase();
  for (let round = 0; round < 8; round += 1) {
    if (stopped()) return { ok: false, reason: '按了暫停，停下來', steps: done };
    const snap = await screen.elements({ limit: 150, ocr: 'auto' });
    const list = snap.elements ?? [];
    const state = { goal: `打開和「${text}」的對話`, app: context.app ?? '', window: snap.window?.title ?? '', screen: list.map((e, i) => `e${i} ${describeElement(e, snap.window)}`) };
    const box = messageBox(list, text);
    if (box) {
      const ask = canAsk && snap.source === 'ocr' ? decider.escalate : decider.decide;
      const sure = (await ask(state, { right: recipientQuestion(text) })).right?.noul ?? 0;
      log(`傳訊息：現在是不是和「${text}」的對話：${sure.toFixed(2)}`);
      if (sure < RECIPIENT_MIN && clicked) {
        // 剛點完：對話可能還在換，等一下再確認，最多 3 次
        clicked -= 1;
        if (clicked === 0) return { ok: false, reason: `搜尋結果第一個打開的不是和「${text}」的對話，沒寫`, steps: done };
        await sleep(SETTLE_MS);
        continue;
      }
      if (sure >= RECIPIENT_MIN) {
        const r = await screen.act({ handle: box.handle, action: 'fill', text: message });
        if (r.result !== 'ok') return { ok: false, reason: `寫訊息沒成功（${r.result}）`, steps: done };
        done.push(`在${describeElement(box, snap.window)}寫了「${message}」（沒送出）`);
        return { ok: true, steps: done };
      }
    }
    const search = list.find((e) => ['AXTextField', 'AXSearchField', 'AXComboBox'].includes(e.role) || e.subrole === 'AXSearchField');
    if (!search) return { ok: false, reason: '畫面上找不到搜尋框', steps: done };
    if ((search.value ?? '').toLowerCase() !== name) {
      const r = await screen.act({ handle: search.handle, action: 'fill', text });
      if (r.result !== 'ok') return { ok: false, reason: `搜尋框填字沒成功（${r.result}）`, steps: done };
      done.push(`在搜尋框填了「${text}」`);
      await sleep(SETTLE_MS);
      continue;
    }
    // 搜尋框下面、同一欄（左右差不多）裡，第一個含這個名字、還沒點過的結果
    const below = list.filter((e) => e !== search && e.y > search.y + search.h && Math.abs((e.x + e.w / 2) - (search.x + search.w / 2)) < search.w
      && (e.label ?? '').toLowerCase().includes(name) && !tried.has(`${Math.round(e.x)},${Math.round(e.y)}`))
      .sort((a, b) => a.y - b.y);
    const pick = below[0];
    if (!pick || tried.size >= 1) return { ok: false, reason: `搜尋結果裡找不到對的「${text}」，沒寫`, steps: done };
    tried.add(`${Math.round(pick.x)},${Math.round(pick.y)}`);
    clicked = 3;
    const r = pick.ocr
      ? await screen.act({ action: 'clickAt', x: pick.x + pick.w / 2, y: pick.y + pick.h / 2 })
      : await screen.act({ handle: pick.handle, action: 'press' });
    if (r.result !== 'ok') return { ok: false, reason: `點不下去（${r.result}）`, steps: done };
    done.push(`點了搜尋結果「${pick.label}」`);
    log(`傳訊息：點了搜尋結果「${pick.label}」`);
    await sleep(SETTLE_MS);
  }
  return { ok: false, reason: '試了幾次都沒打開對的對話，沒寫', steps: done };
}

// { goal, text：要搜尋的字（傳訊息時是對方的名字）, message：要寫的訊息, app：要先切過去的 app }；
// switchApp(name) 把那個 app 叫到前面（回傳有沒有成功；screen 之後就看那個 app）；stopped() 為 true 就停（按了暫停）；
// onStep({ n, action, target })：每一步決定好時通知（小框寫做到哪一步，見 bubble.mjs 的 stepText）
export async function runCommand({ screen, decider, log = () => {}, switchApp = async () => false, goal, text = '', message = '', app = '', context = {}, stopped = () => false, onStep = () => {}, maxSteps = MAX_COMMAND_STEPS }) {
  if (app && !(context.app ?? '').toLowerCase().includes(app.toLowerCase())) {
    log(`指令：先切到 ${app}`);
    if (!(await switchApp(app))) return { ok: false, reason: `找不到 app「${app}」` };
    await sleep(SETTLE_MS);
  }
  if (message && text) return sendMessage({ screen, decider, log, text, message, context, stopped });
  const done = [];
  let filled = 0; // 剛填字的輸入框，按 Enter 用
  let last = null; // 上一步：{ screen：畫面摘要, act：做了什麼 }
  let stuck = 0; // 做了之後畫面沒變的次數
  let startTitle = null;
  for (let step = 0; ; step += 1) {
    if (stopped()) return { ok: false, reason: '按了暫停，停下來', steps: done };
    if (step >= maxSteps) return { ok: false, reason: `做了 ${maxSteps} 步還沒完成，停下來`, steps: done };
    const snap = await screen.elements({ limit: 150, ocr: 'auto' });
    startTitle ??= snap.window?.title ?? '';
    if (goalReached(goal, snap.window?.title ?? '', startTitle, done.length)) {
      log(`指令：已經換到「${snap.window.title}」，算完成`);
      return { ok: true, steps: done };
    }
    const list = snap.elements ?? [];
    const screenKey = `${snap.window?.title ?? ''}|${list.map((e) => `${e.label}:${e.value ?? ''}`).join('|')}`;
    const noChange = !!last && last.screen === screenKey;
    stuck = noChange ? stuck + 1 : 0;
    if (stuck >= 2) return { ok: false, reason: '做了畫面都沒變，停下來', steps: done };
    const state = {
      goal,
      text,
      message,
      app: context.app ?? '',
      window: snap.window?.title ?? '',
      done_steps: done,
      screen: list.map((e, i) => `e${i} ${describeElement(e, snap.window)}`),
    };
    const canAsk = !!decider.canEscalate?.();
    const started = Date.now();
    const questions = stepQuestions(list, snap.window);
    // 截圖認出來的畫面（字多又有錯字）Jev 挑不準，直接問 AI；Jev 沒把握、或上一步做了畫面沒變，也改問 AI
    let engine = decider.engine();
    let answers;
    if (canAsk && (snap.source === 'ocr' || noChange)) {
      answers = await decider.escalate(state, questions);
      engine = 'AI';
    } else {
      answers = await decider.decide(state, questions);
      if (canAsk && (answers.action?.confidence ?? 0) < ESCALATE_BELOW) {
        answers = await decider.escalate(state, questions);
        engine = `${engine}→AI`;
      }
    }
    const action = answers.action ?? {};
    const target = answers.target ?? {};
    const el = list[Number(String(target.choice ?? '').slice(1))];
    log(`指令第 ${step + 1} 步（${engine}，${Date.now() - started} ms）：${action.choice}（${(action.confidence ?? 0).toFixed(2)}）${el ? ` → ${describeElement(el, snap.window)}（${(target.confidence ?? 0).toFixed(2)}）` : ''}`);
    onStep({ n: step + 1, action: action.choice, target: el ? describeElement(el, snap.window) : '' });
    if (noChange && last.act === `${action.choice}:${target.choice}`) return { ok: false, reason: '同一步做了畫面沒變，停下來', steps: done };
    last = { screen: screenKey, act: `${action.choice}:${target.choice}` };
    if (action.choice === 'done') return { ok: true, steps: done };
    if (action.choice === 'stuck') return { ok: false, reason: '決策器說這個畫面做不到', steps: done };
    if ((action.confidence ?? 0) < ACTION_MIN) return { ok: false, reason: '不確定下一步，停下來', steps: done };
    if (action.choice === 'write') {
      if (!message) return { ok: false, reason: '要寫訊息，但指令裡沒有訊息內容', steps: done };
      if (!el || (target.confidence ?? 0) < TARGET_MIN) return { ok: false, reason: '不確定訊息框是哪一個，停下來', steps: done };
      if (text) {
        // 寫之前確認現在打開的是和對的人的對話（截圖認出來的畫面問 AI 比較準）
        const check = canAsk && snap.source === 'ocr'
          ? await decider.escalate(state, { right: recipientQuestion(text) })
          : await decider.decide(state, { right: recipientQuestion(text) });
        const sure = check.right?.noul ?? 0;
        log(`寫訊息前確認對話對象是「${text}」：${sure.toFixed(2)}`);
        if (sure < RECIPIENT_MIN) return { ok: false, reason: `現在打開的不像是和「${text}」的對話，沒寫`, steps: done };
      }
      const r = await screen.act({ handle: el.handle, action: 'fill', text: message });
      if (r.result !== 'ok') return { ok: false, reason: `寫訊息沒成功（${r.result}）`, steps: done };
      done.push(`在${describeElement(el, snap.window)}寫了「${message}」（沒送出）`);
      return { ok: true, steps: done };
    }
    if (action.choice === 'enter') {
      // text：剛填的字，畫面接頭用來認「焦點還在填字的那個框」（框重畫成新元件也認得出來）
      const r = await screen.act({ handle: filled, action: 'enter', text });
      if (r.result !== 'ok') return { ok: false, reason: `按 Enter 沒成功（${r.result}）`, steps: done };
      done.push('按了 Enter');
    } else {
      if (!el || (target.confidence ?? 0) < TARGET_MIN) return { ok: false, reason: '不確定要點哪一個，停下來', steps: done };
      if (action.choice === 'fill') {
        if (!text) return { ok: false, reason: '要填字，但指令裡沒有要填的字', steps: done };
        const r = await screen.act({ handle: el.handle, action: 'fill', text });
        if (r.result !== 'ok') return { ok: false, reason: `填字沒成功（${r.result}）`, steps: done };
        filled = el.handle;
        done.push(`在${describeElement(el, snap.window)}填了「${text}」`);
      } else {
        // 截圖認出來的字沒有元件可以按，就在它的正中間點一下滑鼠
        const r = el.ocr
          ? await screen.act({ action: 'clickAt', x: el.x + el.w / 2, y: el.y + el.h / 2 })
          : await screen.act({ handle: el.handle, action: 'press' });
        if (r.result !== 'ok') return { ok: false, reason: `點不下去（${r.result}）`, steps: done };
        done.push(`點了${describeElement(el, snap.window)}`);
      }
    }
    await sleep(SETTLE_MS);
  }
}
