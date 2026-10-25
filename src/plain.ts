// Text from a note is shown in a terminal: no escape sequences or other
// control characters get through. Newlines and tabs stay when `multiline`.
export function plain(text: string, multiline = false): string {
  return text
    // OSC (ended by BEL or ESC \) and CSI sequences, then any lone ESC and control characters (newline and tab kept when multiline).
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]?/g, '')
    // Also the invisible format characters that reorder or hide text: LRM, RLM, ALM (U+200E, U+200F, U+061C), zero-width space (U+200B), word joiner and invisible operators (U+2060-U+2064), BOM (U+FEFF), the Mongolian vowel separator (U+180E) and tag characters (U+E0000-U+E007F). U+200C (ZWNJ) and U+200D (ZWJ) are kept: stripping them would mangle valid text (Persian words, emoji sequences), and they reorder or hide nothing. The soft hyphen (U+00AD) is kept too: it hides no text. The html page does not use plain().
    .replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069\u200b\u200e\u200f\u061c\u180e\u2060-\u2064\ufeff\u{e0000}-\u{e007f}]/gu, (c) => (multiline && (c === '\n' || c === '\t') ? c : ' '))
}
