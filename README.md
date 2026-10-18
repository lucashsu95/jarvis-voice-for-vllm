# JarvisVoice: hands-free voice typing and app control

English ｜ [繁體中文](README.zh-TW.md)

<img src="design/icon-big.png" width="96" alt="JarvisVoice menu bar icon: a circular arrow around three sound bars">

Website: [jarvis-voice.com](https://jarvis-voice.com)

A macOS menu bar app. While it's running it listens on its own, and what you say goes straight into the app you're using: Claude, ChatGPT, your browser, LINE, Notes, anything. It only types, it never sends; press Enter yourself when you're ready.

It works in three layers. All three are on by default, each one builds on the one before, and you can turn layers 2 and 3 off from the menu:

| Layer | When it writes | What it writes | Where it writes |
|---|---|---|---|
| 1. Voice typing | After each sentence (a pause of about 0.85 s) | The raw transcript | The text field your cursor is in; if the cursor isn't in a text field, nothing is written |
| 2. AI cleanup (like [Typeless](https://www.typeless.com)) | After each passage (a pause of about 2 s) | Text cleaned up by AI: filler words removed, self-corrections resolved, lists formatted, tone matched to the app, your own terms spelled right. The AI looks at the text around the cursor, the text visible on screen, the app, the window and the URL. Choose OpenAI, DeepSeek or Claude | Same as layer 1 |
| 3. Auto-focus and voice commands | Same as layer 2 | Same as layer 2 | If the cursor isn't in a text field, it picks the right field in the window and writes there. If what you said is a command such as "open the TSMC stock page", it doesn't type anything; it operates the frontmost app for you. Decisions are made by [Jev](https://typesafe.ai) (or by your AI if you don't have Jev) |

Architecture and measured numbers (in Chinese): [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Two steps

**Step 1: install and open the app**

You need macOS, Node.js 22 or later, and ffmpeg (`brew install node ffmpeg`).

```bash
git clone https://github.com/urusaqqrun/jarvis-voice.git ~/jarvis-voice
cd ~/jarvis-voice
./install.sh openai   # OpenAI transcription (most accurate); use ./install.sh local to pay nothing
```

The JarvisVoice icon (a circular arrow around three sound bars) appears in the menu bar. The first time, macOS asks for two permissions, once each:

1. **Microphone**: allow it when "JarvisVoice would like to access the microphone" appears.
2. **Accessibility** (needed to paste): you're asked the first time you speak. Turn on "JarvisVoice" in System Settings → Privacy & Security → Accessibility.
3. **Screen Recording** (optional, only for apps it can't read, such as LINE): you're asked the first time it's needed. Turn on "JarvisVoice" in System Settings → Privacy & Security → Screen Recording.

The `openai` engine needs an OpenAI key. Let your AI set it up in step 2 (you paste the key yourself in Terminal; the AI never sees it), or add `"apiKeyFile": "<file with your key>"` under `openai` in `~/.voice-dictation/config.json`.

**Step 2: ask your AI to set it up**

Everyone has their own product names, acronyms and in-house jargon, and those are the words speech recognition gets wrong most. AI cleanup, auto-focus and voice commands also need an AI provider and a key. Open an AI that can read files and run commands on your Mac (Claude Code, Codex and the like; ChatGPT on the web can't) and paste this (or edit the config file yourself, see "Config file" below):

> Please follow ~/jarvis-voice/AI_SETUP.md to set up JarvisVoice for me: fill in my vocabulary and run the tests, and ask me whether I want AI cleanup, auto-focus and voice commands; if I do, set them up and check that they work.

The AI will:
- Find the terms you use most in what you've typed before, write them to `~/.voice-dictation/vocabulary.txt`, and run a test comparing accuracy with and without them. In our test of 4 mixed Chinese–English developer sentences, 1/4 came out fully correct without the vocabulary and 4/4 with it.
- Explain what AI cleanup sends and what it costs, ask whether you want OpenAI, DeepSeek or Claude, have you paste your key into a file only you can read, write the switches to your config, and run `node ~/jarvis-voice/bin/ai-check.mjs` to confirm the AI and the decision maker both work.

## Everyday use

- **Menu bar icon**: normally the JarvisVoice mark (a circular arrow around three sound bars: automatic + voice); when something happens the whole icon switches to a large symbol, so you can tell what's going on at a glance. It keeps a fixed width and the same color as your other menu bar icons:
  - The mark: listening.
  - Five bars moving with your voice: hearing you speak.
  - The circular arrow spinning: transcribing (from when you stop until the text is pasted: transcription plus AI cleanup).
  - Check mark: just pasted.
  - Cross: nothing was written (the cursor wasn't in a text field and no field was found), or a voice command didn't finish.
  - Faded mark: standing by (the frontmost app is excluded).
  - The mark with a slash through it (like a "no" sign): paused, not listening.
  - Triangle with an exclamation mark: something went wrong; open the menu to see why.
- **Bubble next to the cursor**: while you talk it shows what it hears, right under the cursor; when you stop it says it's cleaning up, then "Pasted · 1.7 s" and fades out. Voice commands show each step; if nothing was pasted or something failed, it says why. The bubble never takes focus, and clicks go straight through it.
- **When the cursor isn't in a text field** (you're reading a web page, selecting files in Finder): with auto-focus off, nothing is written, the icon briefly shows a cross, and "Copy last sentence" in the menu gets the text back; with auto-focus on, it picks the right field in the window and writes there.
- **Meetings**: it doesn't listen while Zoom, Teams, FaceTime or Webex is frontmost. If people are talking nearby or a video is playing, choose "Pause listening" in the menu.
- **Menu**: pause/resume, copy last sentence, revert to the raw transcript, AI cleanup (off / OpenAI / DeepSeek / Claude), auto-focus, voice commands, edit vocabulary, edit config, help, quit.

## AI cleanup (layer 2)

On by default (it only runs when you have an AI key; without one you get layer 1). Switch providers under "AI cleanup" in the menu, or choose "Off" to go back to sentence-by-sentence pasting. While it's on:

- **Passage by passage**: a pause longer than 1.8 s ends a passage; text appears about 3 s after you stop.
- **What it cleans up**:
  - Removes filler ("um", "uh", "like", "you know", and their Chinese equivalents).
  - "Three o'clock, no, four" keeps only four.
  - "First … second …" becomes a list; saying "new line" inserts a line break.
  - Adds punctuation, keeps your language (English stays English, nothing is translated), writes Chinese in Taiwan Traditional characters.
  - Spells your terms the way your vocabulary file does.
- **Reads the screen**: the last ~1,500 characters visible in the window (for example the conversation you're in, not including the text field) go to the AI. If the screen is about JarvisVoice and you were heard as saying "JavaScript", it fixes it to JarvisVoice; when you really are talking about JavaScript code, it leaves it alone.
- **Reads around the cursor**: if you're continuing half a sentence it carries on from there; if there's text after the cursor it won't add a period.
- **Matches the app's tone**: casual for chat, polished for email, precise for prompts to AI, concise for documents. Customize with `ai.styles`.
- **Rewrites a selection**: select text and say "make it more formal", "shorten it", "translate to English".
- **Fix by voice**: say "delete that" or "revert to original", or choose "Revert to original" in the menu, to swap the last passage back to the raw transcript.
- **Vocabulary keeps itself up to date**: new terms from your screen and from your own corrections go into the "auto-learned" section at the end of the vocabulary file.
  - Not everything it sees: a term on screen has to show up on 3 separate occasions (at least 10 minutes apart), or you have to actually say it, before it's added. Words you correct yourself after pasting are added right away.
  - There's a cap: at most 250 terms in total and 80 auto-learned ones. When it's full, the least used, longest unused auto-learned term goes first. Terms you wrote yourself are never touched.
- **History**: kept in `~/.voice-dictation/history.jsonl`, only on your Mac.
- **What's sent to the AI**: 400 characters on each side of the cursor, the selected text, the last ~1,500 characters visible in the window, the app, the window title and the URL.

| Provider | Default model | Speed (measured median) | Cost |
|---|---|---|---|
| DeepSeek | `deepseek-flash` | 0.75 s | About US$0.00004 per passage (doubled during DeepSeek's peak hours) |
| Claude | `claude-haiku-5-5` | 0.85 s | About US$0.00004 per passage |
| OpenAI | `gpt-6-luna` | 1.1 s | About US$0.00003 per passage |

Dictating an hour a day, AI cleanup costs less than US$1 a month.

## Auto-focus and voice commands (layer 3)

- **Auto-focus**: when the cursor isn't in a text field, the decision maker picks one of the fields in the window (search boxes and the address bar included), focuses it and writes there.
- **Voice commands** (needs AI cleanup): say "open the TSMC stock page", "open settings", "search for Foxconn" or "switch to the such-and-such session", and it operates the frontmost app:
  - At each step it lists the buttons, links and text fields on screen, and the decision maker picks what to click, where to type, or whether to press Enter.
  - It keeps going until the decision maker says it's done or can't be done; it stops if the decision maker's confidence is too low. "Pause listening" also stops it.
  - When the cursor is in a text field (for example Claude's prompt box), Jev looks at what's on screen to decide: if it's clearly an instruction to operate the screen, or it names something on screen, it's treated as a command; something like "switch to another branch and run the tests again", meant for the AI, is typed as usual. For short, ambiguous phrases, start with "command, …" and it's always treated as a command.
- **Message someone**: say "tell BU hello" or "tell Mom I'll be late" and it follows fixed steps: type the name into the search box → click the first result below it that contains the name → check the conversation title to confirm it's that person → write the message into the message box, **without sending**. If the first result isn't that person, it stops; it never tries other results or writes into the wrong conversation.
- **Apps it can't read** (LINE, for example: Accessibility only exposes the search box and the message box): it captures the frontmost window and reads the text and positions with macOS's built-in text recognition (on your Mac; the image is never saved or sent), and uses them as context for the AI and as things it can click. This needs one more permission, Screen Recording; apps it can read are never captured.
- **Decision maker**:
  - With a Jev key (`jev`), Jev decides, about 0.2 s per decision.
  - On screens read from a screenshot, when Jev isn't sure, or when a step didn't change the screen, that step goes to your AI provider instead (about 1 s); if the same step still doesn't change anything, it stops.
  - Without Jev, your AI provider decides everything.

## Transcription engines

| Engine | Accuracy | Cost | Where your audio goes |
|---|---|---|---|
| `openai` (`gpt-transcribe`, default) | Most accurate, uses your vocabulary | US$0.0045 a minute; an hour a day is about US$7.4 a month | OpenAI |
| `openai` (`gpt-live-transcribe`) | Slightly worse | US$0.017 a minute | OpenAI |
| `local` (SenseVoice-Small) | Good Chinese, weaker English, ignores vocabulary | Free | Never leaves your Mac |
| `parallelsandbox` | Same as `gpt-live-transcribe` | Depends on your ParallelSandbox plan | ParallelSandbox, then OpenAI |

Only segments recognized as speech are sent; nothing is sent while it's quiet. Costs include the ~1.25 s of padding around each sentence. To switch engines run `./install.sh <engine>`, or edit the config file; changes apply within a few seconds of saving.

## Config file

`~/.voice-dictation/config.json`; anything you leave out uses the default:

```json
{
  "engine": "openai",
  "output": "traditional",
  "replacements": { "部屬": "部署" },
  "openai": {
    "apiKeyFile": "~/secrets/openai.env",
    "model": "gpt-transcribe",
    "languages": ["zh-tw", "en"],
    "prompt": "A Taiwanese engineer dictating in Chinese mixed with English about software development and operations."
  }
}
```

| Field | Meaning |
|---|---|
| `engine` | `openai`, `local`, `parallelsandbox` |
| `apps` | Only listen in these apps (bundle ids); default `["*"]`, all apps |
| `excludeApps` | Don't listen while these apps are frontmost; defaults to meeting and calling apps |
| `output` | `traditional` (Taiwan Traditional Chinese), `simplified`, `original` |
| `replacements` | Fixed replacements for spellings that are still wrong after testing |
| `openai.model` | `gpt-transcribe` (default, whole sentence at once) or `gpt-live-transcribe` (real-time) |
| `openai.apiKey` / `openai.apiKeyFile` | The key itself, or a file containing it (just the key, or a .env with `OPENAI_API_KEY=`); otherwise the `OPENAI_API_KEY` environment variable |
| `openai.languages` | Expected languages, e.g. `["zh-tw", "en"]` |
| `openai.prompt` | A sentence or two describing the setting; don't put your vocabulary here |
| `openai.vocabularyFile` | Vocabulary file, default `~/.voice-dictation/vocabulary.txt`, one term per line |
| `local.language` | `auto`, or `zh`, `en`, `yue`, `ja`, `ko` |
| `ai.enabled` / `ai.provider` | AI cleanup on/off (default on); `deepseek`, `openai`, `claude`. If unset, whichever provider you already have a key for. Also switchable from the menu |
| `ai.keys` / `ai.keyFiles` / `ai.keyCommands` | Each provider's key, a file with the key, or a command that prints it (e.g. `aws ssm get-parameter ...`, so the key never touches disk). Otherwise the `DEEPSEEK_API_KEY` / `ANTHROPIC_API_KEY` environment variables; OpenAI reuses the `openai` key |
| `ai.models` | Use a different model, e.g. `{ "openai": "gpt-4.1-mini" }` |
| `ai.segmentPauseMs` | How long a pause ends a passage, default 1800 (only waited out in full when early cleanup is off) |
| `speed.earlyTranscribeMs` | Send the sentence for transcription after this much silence, default 400 (discarded if you keep talking); 0 turns it off |
| `speed.pasteAfterMs` | Start cleanup as soon as the text is back, and paste if you've been quiet this long when it's ready, default 1200; 0 waits for `ai.segmentPauseMs` |
| `speed.hedge` | How many copies of each transcription and cleanup request to send at once, using whichever answers first, default 2 (cost scales with it) |
| `speed.bubble` / `speed.preview` | The bubble next to the cursor, and the live preview while you talk (on-device SenseVoice, shown but never pasted); both on by default |
| `ai.styles` | Tone per app (bundle id) or website (domain), e.g. `{ "com.tinyspeck.slackmacgap": "casual and short" }` |
| `ai.screenChars` | How many characters of on-screen text go to the AI, default 1500 |
| `ai.history` / `ai.learn` | Local history, learning from your corrections; both on by default |
| `ai.autoVocabulary` | Automatic vocabulary updates: `{ "enabled": true, "max": 250, "maxAuto": 80, "minSightings": 3 }` |
| `autoFocus` | Find a text field when the cursor isn't in one (default on) |
| `commands` | Voice commands (default on) |
| `jev.apiKey` / `jev.apiKeyFile` / `jev.apiKeyCommand` | Your TypeSafe key (or the `TYPESAFE_API_KEY` environment variable) |

## Troubleshooting

- **No menu bar icon**: open `~/Applications/JarvisVoice.app`. On macOS 26, check System Settings → Menu Bar to make sure it's allowed.
- **Exclamation mark icon**: open the menu; the first line says why.
- **AI cleanup does nothing, or the menu says "(no key)"**: run `node ~/jarvis-voice/bin/ai-check.mjs`; it tells you what's missing.
- **Nothing gets pasted**: make sure the cursor is in a text field, then make sure "JarvisVoice" is turned on under Accessibility.
- **Detailed log**: `~/.voice-dictation/listen.log`.
- **Reinstall or update**: `git pull && ./install.sh`. If the app shell (`app/main.js`) and packaging haven't changed, it isn't rebuilt and you keep your permissions; if they have, macOS asks for the microphone again, and you need to turn "JarvisVoice" off and on again under Accessibility.

## How it works

- `app/main.js`: the menu bar app shell, packaged into `JarvisVoice.app` with macOS's built-in `osacompile` (no Xcode). Microphone and Accessibility permissions belong to it.
- `app/ui.js`: the menu bar UI and the code that starts the background process. The shell loads it at launch, so changing it doesn't require rebuilding the app or re-granting permissions; quit from the menu and reopen to apply.
- `bin/listen.mjs`: the background process. It watches which app is frontmost, records with ffmpeg, splits sentences locally and hands them to the transcription engine; with AI cleanup on, it groups them into passages for the AI, then writes into the text field or runs the command.
- `bin/engines/`: `batch.mjs` (OpenAI transcription), `realtime.mjs` (real-time transcription via OpenAI or ParallelSandbox), `local.mjs` (SenseVoice via sherpa-onnx).
- `bin/ax-agent.js`: the long-running Accessibility helper (JXA). Reads context and on-screen text, finds and focuses text fields, pastes (save clipboard → Cmd+V → restore, only to the frontmost app), selects what it just pasted to replace it, and lists and operates on-screen controls.
- `core/`: the shared core, one copy used by this app, CubeLV and ParallelSandbox (see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)); `scripts/sync-core.sh` copies it into other projects.
- `bin/editor.mjs`: AI cleanup. `bin/ai-check.mjs`: checks that AI cleanup and the decision maker are set up. `bin/decide.mjs`: layer 3 decisions (Jev). `bin/commander.mjs`: voice commands. `bin/targeter.mjs`: rules for picking a text field. `bin/learn.mjs`: learning from your corrections. `bin/vocab-auto.mjs`: automatic vocabulary updates and the cap.
- `bin/vocab-test.mjs`: vocabulary test (see [AI_SETUP.md](AI_SETUP.md)).
- `site/`: the jarvis-voice.com website, published to GitHub Pages by GitHub Actions on every push to main.

## Development

```bash
npm install
npm test                                  # never sends keystrokes or takes focus
VOICE_DICTATION_FOCUS_TESTS=1 npm test    # also checks real pasting and reverting with the test window frontmost (takes focus for ~2 s)
TYPESAFE_API_KEY=... npm test             # also lets the real Jev drive the stock-app test window
VOICE_DICTATION_REAL_AI=1 npm test        # also runs AI cleanup against all three real providers (greetings, one-word replies and swearing kept; filler and self-corrections still cleaned), using the keys in your config
VOICE_DICTATION_E2E=1 npm test            # also runs real speech end to end: say speaks sentences -> transcription -> AI cleanup -> pasted into the test window, then reads the window back (calls the cloud, takes focus; waits for 3 s of no keyboard or mouse before each sentence)
```

## Uninstall

```bash
./uninstall.sh
```

Your config, vocabulary and models stay in `~/.voice-dictation`; delete it yourself if you don't need them.

## License

The code is MIT licensed. The local model is downloaded by `install.sh` from [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) and isn't part of this repo; see the [FunASR model license](https://github.com/modelscope/FunASR?tab=readme-ov-file#license).
