// Text from a note is shown in a terminal: no escape sequences or other
// control characters get through. Newlines and tabs stay when `multiline`.
export function plain(text: string, multiline = false): string {
  return text
    // OSC (ended by BEL or ESC \) and CSI sequences, then any lone ESC and control characters (newline and tab kept when multiline).
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]?/g, '')
    .replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, (c) => (multiline && (c === '\n' || c === '\t') ? c : ' '))
}
