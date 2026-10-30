// 游標在搜尋框、講「查詢／搜尋／幫我找 XXX」：不只是把字貼上去，直接填 XXX（換掉框裡原本的字）再按 Enter 搜下去。
// 只認明確的搜尋動詞；單一個「查」「找」不算（「查理是誰」「找不到」會誤判）

const SEARCH_FIELD = /搜尋|搜索|查詢|search/i;
const SEARCH_VERB = /^\s*(?:請|幫我|我要|我想|麻煩)?\s*(?:查詢|查一下|幫我查|搜尋一下|搜尋|搜索|搜一下|找一下|幫我找|search for|search|look up)\s*[:：,，]?\s*/i;

/** 游標所在的框是不是搜尋框（context 的 field：role、subrole、label） */
export function isSearchField(field) {
  if (!field?.editable) return false;
  return field.role === 'AXSearchField' || field.subrole === 'AXSearchField' || SEARCH_FIELD.test(field.label ?? '');
}

/** 要搜的字：開頭是搜尋動詞就拿掉動詞、句尾標點、外面的引號；不是搜尋就回空字串 */
export function searchQuery(text) {
  const s = String(text ?? '');
  const verb = s.match(SEARCH_VERB);
  if (!verb) return '';
  return s.slice(verb[0].length).replace(/[。．.!！?？、，,\s]+$/u, '').replace(/^[「『"']|[」』"']$/gu, '').trim().slice(0, 100);
}
