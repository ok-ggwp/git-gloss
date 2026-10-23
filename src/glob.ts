// A small glob matcher for repo paths (always "/"-separated, relative to the
// repo root). Supports `**` (any number of directories, including none when
// written as `**/` or `/**`), `*` (anything but "/"), `?` (one character but
// "/"), `{a,b}` alternatives (nestable) and `\` to escape. A pattern without a
// "/" matches the file name at any depth, as in .gitignore ("Jenkinsfile",
// "*.lock"). Node's path.matchesGlob is not used: it is missing before Node 22.

const SPECIAL = /[.+^$()|[\]\\]/

export class GlobError extends Error {}

function translate(glob: string): string {
  let out = ''
  let depth = 0
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '\\') {
      if (i + 1 >= glob.length) throw new GlobError('trailing backslash')
      out += glob[++i].replace(/[^a-zA-Z0-9]/, '\\$&')
      continue
    }
    if (c === '*') {
      if (glob[i + 1] === '*') {
        let j = i + 1
        while (glob[j + 1] === '*') j++
        const atStart = i === 0 || glob[i - 1] === '/'
        if (glob[j + 1] === '/' && atStart) { out += '(?:.*/)?'; i = j + 1 } // "**/": any directories, or none
        else { out += '.*'; i = j }
      } else out += '[^/]*'
      continue
    }
    if (c === '?') { out += '[^/]'; continue }
    if (c === '{') { depth++; out += '(?:'; continue }
    if (c === ',' && depth > 0) { out += '|'; continue }
    if (c === '}' && depth > 0) { depth--; out += ')'; continue }
    out += SPECIAL.test(c) ? '\\' + c : c
  }
  if (depth > 0) throw new GlobError('unclosed "{"')
  return out
}

const cache = new Map<string, RegExp>()

// The regular expression for a glob; throws GlobError if it is malformed.
export function globToRegExp(glob: string): RegExp {
  let re = cache.get(glob)
  if (!re) {
    const body = translate(glob)
    // Without a "/", match the last path component at any depth.
    re = new RegExp('^' + (glob.includes('/') ? '' : '(?:.*/)?') + body + '$')
    cache.set(glob, re)
  }
  return re
}

export const matchGlob = (glob: string, path: string): boolean => globToRegExp(glob).test(path)

