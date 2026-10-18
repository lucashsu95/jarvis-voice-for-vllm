# JarvisVoice：自動語音輸入與操作

[English](README.md) ｜ 繁體中文

<img src="design/icon-big.png" width="96" alt="JarvisVoice 的選單列圖示：循環箭頭包住三條聲波">

網站：[jarvis-voice.com](https://jarvis-voice.com)

macOS 選單列小程式。開著就自動收音，你講的話直接寫進正在用的 app：Claude、ChatGPT、瀏覽器、LINE、備忘錄都可以。只寫不送出，要送自己按 Enter。

分三層，預設都開，每一層都是在前一層上面多做一點；從選單可以關掉第二、三層：

| 層 | 什麼時候寫 | 寫什麼 | 寫到哪 |
|---|---|---|---|
| 1. 語音輸入 | 講完一句（停約 0.85 秒） | 轉寫出來的原話 | 游標所在的輸入框；游標不在輸入框就不寫 |
| 2. AI 整理（像 [Typeless](https://www.typeless.com)） | 講完一段（停約 2 秒） | AI 整理過的字：去贅字、改口只留結果、條列、依 app 調語氣、照你的專有名詞。AI 會參考游標前後的字、畫面上看得到的字、app、視窗、網址，可以選 OpenAI、DeepSeek、Claude | 同第 1 層 |
| 3. 自動找輸入框、語音指令 | 同第 2 層 | 同第 2 層 | 游標不在輸入框時，改成挑出視窗裡該寫的輸入框寫進去。講的是「進到台積電的個股頁」這類指令，就不寫字，直接操作最前面的 app。由 [Jev](https://typesafe.ai) 決定（沒有 Jev 就改問 AI） |

架構與實測數字見 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 兩個步驟

**第一步：裝好、打開小程式**

需要 macOS、Node.js 22 以上、ffmpeg（`brew install node ffmpeg`）。

```bash
git clone https://github.com/urusaqqrun/jarvis-voice.git ~/jarvis-voice
cd ~/jarvis-voice
./install.sh openai   # 用 OpenAI 轉寫（最準）；不想花錢就用 ./install.sh local
```

裝完選單列會出現「JarvisVoice」的圖示（循環箭頭包住三條聲波）。第一次用要給兩個權限，都只要一次：

1. **麥克風**：跳出「JarvisVoice 想要取用麥克風」時按允許。
2. **輔助使用**（貼上要用）：第一次講話時會跳出詢問，到「系統設定 → 隱私權與安全性 → 輔助使用」打開「JarvisVoice」。
3. **螢幕錄影**（選用，讀不到畫面的 app 例如 LINE 才用得到）：第一次需要時會跳出詢問，到「系統設定 → 隱私權與安全性 → 螢幕錄影」打開「JarvisVoice」。

用 `openai` 要給 OpenAI 的 key：第二步請 AI 幫你放（key 由你自己在終端機貼，AI 不經手），或自己在 `~/.voice-dictation/config.json` 的 `openai` 裡加 `"apiKeyFile": "放 key 的檔案"`。

**第二步：請你的 AI 幫你設定**

每個人常講的產品名、英文縮寫、公司內部用語都不一樣，這些詞最容易被聽錯；AI 整理、自動找輸入框、語音指令也要選 AI、放 key 才能開。打開能在你電腦上讀檔、跑指令的 AI（Claude Code、Codex 這類；ChatGPT 網頁版做不到），把這句話貼給它（不想用 AI 的話，照下面「設定檔」一節自己改也可以）：

> 請照 ~/jarvis-voice/AI_SETUP.md 幫我設定 JarvisVoice：填專有名詞並跑測試，也問我要不要開 AI 整理、自動找輸入框、語音指令，要的話幫我設定好並檢查。

AI 會：
- 從你打過的字裡找出常講的詞，寫進 `~/.voice-dictation/vocabulary.txt`，跑測試比較加詞彙前後的準度。實測 4 句中英夾雜的開發用語：不加詞彙整句全對 1/4，加了 4/4（「平行沙河」變回「平行沙盒」、「香芹卡」變回「鑲嵌卡」）。
- 跟你說明 AI 整理會送出什麼、要多少錢，問你要用 OpenAI、DeepSeek 還是 Claude；請你自己把 key 貼進一個只有你讀得到的檔案；把開關寫進設定檔；跑 `node ~/jarvis-voice/bin/ai-check.mjs` 確認 AI 和決策器都通。

## 平常怎麼用

- **選單列圖示**：平常是 JarvisVoice 標誌（循環箭頭包住三條聲波，自動＋聲音），有事時整個換成大圖，一眼看得出狀況。固定寬度、跟其他選單列圖示同色：
  - 標誌：收音中。
  - 五條聲波，跟著你的音量動：聽到你講話。
  - 循環箭頭在轉：辨識中（你停下後到字貼上：轉寫＋AI 整理）。
  - 打勾：剛貼好。
  - 叉叉：沒寫進去（游標不在輸入框，也沒找到該寫的輸入框），或語音指令沒做完。
  - 標誌變淡：待命（最前面的 app 不收音）。
  - 標誌加一條斜線（像禁止標誌）：暫停，沒在聽。
  - 三角形驚嘆號：出錯，點開選單看原因。
- **游標旁的小框**：講話中就在游標下面即時顯示聽到的字；講完顯示「整理中」，貼上後顯示「已貼上」再淡出。語音指令會顯示做到哪一步，沒貼上、出錯也會寫原因。小框不會搶走游標，滑鼠點得穿過去。
- **游標不在輸入框時**（例如在看網頁本身、在 Finder 選檔案）：沒開「自動找輸入框」就不寫，圖示會短暫變成叉叉，可以點選單的「複製上一句」把那段拿回來；開了就挑視窗裡該寫的輸入框寫進去。
- **開會時不收音**：Zoom、Teams、FaceTime、Webex 在最前面時不收音。旁邊有人講話、在放影片，就按選單的「暫停收音」。
- **選單**：暫停／繼續、複製上一句、換回原文、AI 整理（關／OpenAI／DeepSeek／Claude）、自動找輸入框、語音指令、編輯專有名詞、編輯設定檔、說明、結束。

## AI 整理（第二層）

預設就開（有 AI 的 key 才會動，沒有就只跑第一層）。選單「AI 整理」可以換家，選「關」就回到一句一句貼。開著時：

- **一段一段整理**：停超過 1.8 秒算一段講完，停下後約 3 秒出字。
- **整理內容**：
  - 去掉「嗯、那個、然後然後」。
  - 「三點，不對，四點」只留四點。
  - 講「第一、第二」排成條列；講「換行」就換行。
  - 補標點、台灣正體，英文照英文寫，不翻譯。
  - 專有名詞照詞彙檔的寫法。
- **看畫面**：視窗裡看得到的字（例如正在聊的對話，不含輸入框）最後約 1,500 字一起給 AI。畫面在討論 JarvisVoice，你講的卻被聽成 JavaScript，就會改回 JarvisVoice；真的在講程式的 JavaScript 不會被改。
- **看游標前後**：接在半句話後面就接下去，後面還有字就不加句號。
- **依 app 調語氣**：聊天口語、email 正式、給 AI 的指令精準、文件精簡。可以用 `ai.styles` 改。
- **改選取的字**：選起來講「改正式一點」「縮短」「翻成英文」。
- **用講的修正**：講「刪掉剛剛那句」「換回原文」，或點選單「換回原文」，把上一段換回轉寫原稿。
- **詞彙表自動更新**：從畫面上和你自己的改字，挑新的專有名詞加進詞彙檔最後的「自動學到」區。
  - 不是看到就加：畫面上的詞要在 3 次不同的時候（相隔 10 分鐘以上）都看到，或你真的講到了，才加；你貼上後自己改掉的字直接加。
  - 有上限：整張詞彙表最多 250 個、自動學到的最多 80 個，滿了先拿掉最少用到、最久沒用到的自動詞。你自己寫的詞不會被動。
- **歷史**：存在 `~/.voice-dictation/history.jsonl`，只在你的電腦。
- **送給 AI 的內容**：游標前後各 400 字、選取的字、視窗裡看得到的字（最後約 1,500 字）、app、視窗標題、網址。

| 選項 | 預設模型 | 速度（實測中位數） | 費用 |
|---|---|---|---|
| DeepSeek | `deepseek-flash` | 0.75 秒 | 每段約 0.00004 美元（平日台灣 9–12、14–18 點加倍） |
| Claude | `claude-haiku-5-5` | 0.85 秒 | 每段約 0.00004 美元 |
| OpenAI | `gpt-6-luna` | 1.1 秒 | 每段約 0.00003 美元 |

一天口述 1 小時，AI 整理一個月不到 1 美元。

## 自動找輸入框、語音指令（第三層）

- **自動找輸入框**：游標不在輸入框時，由決策器從視窗裡所有輸入框（搜尋框、網址列也算）挑一個，對焦後寫進去。
- **語音指令**（要先開 AI 整理）：講「進到台積電的個股頁」「打開設定」「搜尋鴻海」「切到某某 session」，直接操作最前面的 app：
  - 每一步列出畫面上的按鈕、連結、輸入框，由決策器挑要點哪個、填哪裡、按 Enter。
  - 做到決策器說完成或做不到為止；決策器信心太低就停下來。按「暫停收音」也會停。
  - 游標在輸入框裡時（例如 Claude 的輸入框），Jev 會看畫面上有什麼來判斷：很確定是要操作畫面，或講到畫面上某個東西的名字，就當指令；像「你切到另一個分支再跑測試」這種要打給 AI 的話照樣打字。分不清的短句，開頭講「指令，……」一定當指令。
- **傳訊息給某人**：講「幫我傳給 BU 說你好」「跟媽媽說我晚點到」，照固定步驟走：在搜尋框填名字 → 點搜尋框下面第一個含這個名字的結果 → 看對話標題確認是這個人 → 把訊息寫進訊息框，**不送出**。第一個結果不是這個人就停，不會去試別的、也不會寫進錯的對話。
- **讀不到畫面的 app**（例如 LINE：輔助使用只讀得到搜尋框和訊息框）：自動截最前面那個視窗、用 macOS 內建的文字辨識讀出畫面上的字和位置（在你的電腦上做，圖片不存檔、不送出去），當成 AI 的上下文和可以點的選項。要多給一個「螢幕錄影」權限；讀得到畫面的 app 不會截圖。
- **決策器**：
  - 有 Jev key（`jev`）就用 Jev，一次約 0.2 秒。
  - 截圖認出來的畫面、Jev 沒把握、或做了一步畫面沒變，那一步改問 AI 整理那家（約 1 秒）；同一步做了畫面還是沒變就停。
  - 沒有 Jev 就都問 AI。

## 轉寫引擎

| 引擎 | 準度 | 費用 | 聲音送去哪 |
|---|---|---|---|
| `openai`（`gpt-transcribe`，預設） | 最準，吃專有名詞 | 每分鐘 0.0045 美元；一天講 1 小時、一個月約 7.4 美元 | OpenAI |
| `openai`（`gpt-live-transcribe`） | 稍差 | 每分鐘 0.017 美元 | OpenAI |
| `local`（SenseVoice-Small） | 中文不錯，英文較弱，不吃專有名詞 | 免費 | 不離開你的電腦 |
| `parallelsandbox` | 同 `gpt-live-transcribe` | 依平行沙盒的方案 | 平行沙盒，再轉給 OpenAI |

只有判定是人聲的片段才會送去轉寫，安靜時什麼都不送。費用已經算進每句前後多帶的約 1.25 秒。換引擎就跑 `./install.sh <引擎>`，或直接改設定檔，存檔後幾秒內就會套用。

## 設定檔

位置在 `~/.voice-dictation/config.json`，沒寫的欄位照預設：

```json
{
  "engine": "openai",
  "output": "traditional",
  "replacements": { "部屬": "部署" },
  "openai": {
    "apiKeyFile": "~/secrets/openai.env",
    "model": "gpt-transcribe",
    "languages": ["zh-tw", "en"],
    "prompt": "台灣工程師用中文夾英文口述，內容是軟體開發與產品營運。"
  }
}
```

| 欄位 | 說明 |
|---|---|
| `engine` | `openai`、`local`、`parallelsandbox` |
| `apps` | 只在這些 app 收音（bundle id），預設 `["*"]` 全部 |
| `excludeApps` | 這些 app 在最前面時不收音，預設是開會、通話用的 app |
| `output` | `traditional`（台灣正體）、`simplified`、`original` |
| `replacements` | 轉出來的字固定替換，給測試後仍然固定錯的寫法用 |
| `openai.model` | `gpt-transcribe`（預設，整句送出）或 `gpt-live-transcribe`（即時） |
| `openai.apiKey`／`openai.apiKeyFile` | key 本身，或放 key 的檔案（整個檔案就是 key，或含 `OPENAI_API_KEY=` 的 .env）；都沒有就讀環境變數 `OPENAI_API_KEY` |
| `openai.languages` | 預期的語言，例如 `["zh-tw", "en"]` |
| `openai.prompt` | 一兩句話描述場合，不要塞詞彙清單 |
| `openai.vocabularyFile` | 專有名詞檔，預設 `~/.voice-dictation/vocabulary.txt`，一行一個詞 |
| `local.language` | `auto` 或 `zh`、`en`、`yue`、`ja`、`ko` |
| `ai.enabled`／`ai.provider` | AI 整理開關（預設開）；`deepseek`、`openai`、`claude`，沒寫就用已經有 key 的那家。選單可以直接切 |
| `ai.keys`／`ai.keyFiles`／`ai.keyCommands` | 各家的 key、放 key 的檔案、或拿 key 的指令（例如 `aws ssm get-parameter ...`，key 不落地）。都沒有就讀環境變數 `DEEPSEEK_API_KEY`、`ANTHROPIC_API_KEY`；OpenAI 沿用 `openai` 的 key |
| `ai.models` | 換模型，例如 `{ "openai": "gpt-4.1-mini" }` |
| `ai.segmentPauseMs` | 停多久算一段講完，預設 1800（提早整理關掉時才要等滿） |
| `speed.earlyTranscribeMs` | 停多久就先把這句送去轉寫，預設 400（又開口就作廢）；0 是不提早 |
| `speed.pasteAfterMs` | 字一回來就先整理，整理好時已經停了這麼久就直接貼，預設 1200；0 是照 `ai.segmentPauseMs` 等滿 |
| `speed.hedge` | 轉寫、AI 整理每次同時送幾份、誰先回用誰，預設 2（費用跟著乘） |
| `speed.bubble`／`speed.preview` | 游標旁的小框、講話中即時預覽（用本機 SenseVoice，只顯示不貼），預設都開 |
| `ai.styles` | 各 app（bundle id）或網站（網域）的語氣，例如 `{ "com.tinyspeck.slackmacgap": "口語、簡短" }` |
| `ai.screenChars` | 視窗裡看得到的字給 AI 幾個字，預設 1500 |
| `ai.history`／`ai.learn` | 本機歷史、從你的改字學詞，預設都開 |
| `ai.autoVocabulary` | 詞彙表自動更新：`{ "enabled": true, "max": 250, "maxAuto": 80, "minSightings": 3 }` |
| `autoFocus` | 游標不在輸入框時自動找輸入框（預設開） |
| `commands` | 語音指令（預設開） |
| `jev.apiKey`／`jev.apiKeyFile`／`jev.apiKeyCommand` | TypeSafe 的 key（環境變數 `TYPESAFE_API_KEY` 也可以） |

## 疑難排解

- **選單列沒有圖示**：打開 `~/Applications/JarvisVoice.app`。macOS 26 可以到「系統設定 → 選單列」確認它被允許顯示。
- **圖示是驚嘆號**：點開選單看第一行寫的原因。
- **AI 整理沒作用、選單寫「（沒有 key）」**：跑 `node ~/jarvis-voice/bin/ai-check.mjs`，它會說缺什麼。
- **字沒貼進去**：先確認游標在輸入框裡，再確認「輔助使用」裡有打開「JarvisVoice」。
- **看詳細記錄**：`~/.voice-dictation/listen.log`。
- **重新安裝或更新**：`git pull && ./install.sh`。外殼 `app/main.js` 或打包設定沒變就不會重包，權限不用重給；有變的話系統會再問一次麥克風，輔助使用要到設定裡把「JarvisVoice」關掉再打開。

## 怎麼運作

- `app/main.js`：選單列小程式的外殼，用 macOS 內建的 `osacompile` 包成 `JarvisVoice.app`，不用 Xcode。麥克風與輔助使用權限都算在它頭上。
- `app/ui.js`：選單列的介面，以及帶起常駐程式的邏輯。外殼啟動時才讀進來，所以改它不用重包 app、權限也不用重給；改完從選單「結束」再打開就生效。
- `bin/listen.mjs`：常駐程式。它看哪個 app 在最前面，用 ffmpeg 收音、在本機切句，交給轉寫引擎；AI 整理開著就分段交給 AI，再寫進輸入框或執行指令。
- `bin/engines/`：`batch.mjs`（OpenAI 一般轉寫）、`realtime.mjs`（即時轉寫，OpenAI 或平行沙盒）、`local.mjs`（sherpa-onnx 跑 SenseVoice）。
- `bin/ax-agent.js`：常駐的「輔助使用」小幫手（JXA）。讀上下文、找輸入框、對焦、貼上（暫存剪貼簿 → Cmd+V → 還原，只送給最前面的 app）、選回剛貼的字、列出畫面上的按鈕並操作。
- `core/`：共用核心，Mac 小程式、CubeLV、平行沙盒共用一份（見 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)）。`scripts/sync-core.sh` 同步到別的專案。
- `bin/editor.mjs`：AI 整理。`bin/ai-check.mjs`：檢查 AI 整理和決策器設定好了沒。`bin/decide.mjs`：第三層的決策（Jev）。`bin/commander.mjs`：語音指令。`bin/targeter.mjs`：挑輸入框的規則。`bin/learn.mjs`：從你的改字學詞。`bin/vocab-auto.mjs`：詞彙表自動更新與上限。
- `bin/vocab-test.mjs`：專有名詞測試（見 [AI_SETUP.md](AI_SETUP.md)）。
- `site/`：網站 jarvis-voice.com，push 到 main 後由 GitHub Actions 發到 GitHub Pages。

## 開發

```bash
npm install
npm test                                  # 不送按鍵、不搶前景
VOICE_DICTATION_FOCUS_TESTS=1 npm test    # 再加跑「測試視窗在最前面時真的貼得進去、換得回來」（會搶前景約 2 秒）
TYPESAFE_API_KEY=... npm test             # 再加跑真的 Jev 操作測試用看盤視窗
VOICE_DICTATION_REAL_AI=1 npm test        # 再加跑三家真模型的 AI 整理（招呼、一個字、髒話照留；贅字、改口照樣整理），用設定檔的 key
VOICE_DICTATION_E2E=1 npm test            # 再加跑真的講話：say 念句子 → 轉寫 → AI 整理 → 貼進測試視窗，讀視窗裡的字比對（會打雲端、搶前景；每句等鍵盤滑鼠停 3 秒才開始）
```

## 解除安裝

```bash
./uninstall.sh
```

設定、詞彙、模型會留在 `~/.voice-dictation`，不要了就自己刪掉。

## 授權

程式碼採 MIT 授權。本機模型由 `install.sh` 從 [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) 下載，沒有放在這個 repo 裡；模型授權見 [FunASR 的模型授權條款](https://github.com/modelscope/FunASR?tab=readme-ov-file#license)。
