// 測試用視窗：多行文字框、單行框、搜尋框、密碼框，給 AX 小幫手與端對端測試用。
// 用法：osascript -l JavaScript test-window.js [--activate]  （結束就 kill 這個 osascript）
ObjC.import('Cocoa');

function field(cls, frame, placeholder) {
  const f = cls.alloc.initWithFrame(frame);
  f.setPlaceholderString(placeholder);
  return f;
}

// Cmd+V、Cmd+A 是靠「編輯」選單的快捷鍵觸發的：沒有選單，貼上的按鍵不會有反應（真的 app 都有）
function editMenu(app) {
  const main = $.NSMenu.alloc.init;
  const appItem = $.NSMenuItem.alloc.init;
  appItem.setSubmenu($.NSMenu.alloc.init);
  main.addItem(appItem);
  const editItem = $.NSMenuItem.alloc.init;
  const edit = $.NSMenu.alloc.initWithTitle('編輯');
  edit.addItemWithTitleActionKeyEquivalent('貼上', 'paste:', 'v');
  edit.addItemWithTitleActionKeyEquivalent('全選', 'selectAll:', 'a');
  editItem.setSubmenu(edit);
  main.addItem(editItem);
  app.setMainMenu(main);
}

function run(argv) {
  const app = $.NSApplication.sharedApplication;
  app.setActivationPolicy(0); // 一般 app，才能到最前面收鍵盤
  editMenu(app);
  const win = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer($.NSMakeRect(200, 200, 560, 420), 1 | 2, 2, false);
  win.setTitle('JarvisVoice 測試視窗');
  const view = win.contentView;
  const search = field($.NSSearchField, $.NSMakeRect(20, 365, 520, 26), '搜尋');
  const single = field($.NSTextField, $.NSMakeRect(20, 330, 520, 26), '主旨');
  const secret = field($.NSSecureTextField, $.NSMakeRect(20, 290, 520, 26), '密碼');
  const scroll = $.NSScrollView.alloc.initWithFrame($.NSMakeRect(20, 20, 520, 250));
  const text = $.NSTextView.alloc.initWithFrame($.NSMakeRect(0, 0, 520, 250));
  text.setRichText(false);
  text.setAutomaticQuoteSubstitutionEnabled(false);
  text.setAutomaticTextReplacementEnabled(false);
  text.setAutomaticSpellingCorrectionEnabled(false);
  text.setString($(argv.includes('--empty') ? '' : '今天的待辦：'));
  text.setAccessibilityLabel('訊息');
  scroll.setDocumentView(text);
  scroll.setHasVerticalScroller(true);
  const note = $.NSTextField.labelWithString($('畫面文字：我們在討論 JarvisVoice'));
  note.setFrame($.NSMakeRect(20, 395, 520, 20));
  for (const v of [search, single, secret, scroll, note]) view.addSubview(v);
  win.makeKeyAndOrderFront($());
  win.makeFirstResponder(argv.includes('--focus-none') ? $() : text);
  // --blur-on <檔案>：那個檔案一出現就把焦點從文字框拿掉（測「開口時在框裡、要貼的時候焦點跑掉」）
  const blurAt = argv.indexOf('--blur-on');
  if (blurAt >= 0) {
    const path = argv[blurAt + 1];
    ObjC.registerSubclass({
      name: 'JarvisTestBlur',
      methods: {
        'tick:': {
          types: ['void', ['id']],
          implementation(timer) {
            if (!$.NSFileManager.defaultManager.fileExistsAtPath($(path))) return;
            win.makeFirstResponder($());
            timer.invalidate;
          },
        },
      },
    });
    $.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(0.1, $.JarvisTestBlur.alloc.init, 'tick:', $(), true);
  }
  if (argv.includes('--activate')) app.activateIgnoringOtherApps(true);
  app.finishLaunching;
  app.run;
}
