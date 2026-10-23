import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { GlossError, gitTry } from './git.ts'
import { globToRegExp } from './glob.ts'

// Settings for the computed signals, in three layers (later wins for scalars,
// repo config extends the lists of the one before):
//   1. DEFAULTS below: only conventions true almost everywhere, no language,
//      framework or build tool beyond well-known file names.
//   2. `.gloss/config.json`, committed in the repo that uses git-gloss.
//   3. `git config gloss.attention.<key>`, for the scalars.
// A path or pattern class in the repo config is a list that is added to the
// default list, or `{ "extends": false, "globs": [...] }` (`"regexes"` for a
// pattern class) to replace the default list instead.

export const CONFIG_FILE = '.gloss/config.json'

export class ConfigError extends GlossError {}

// Classes whose paths decide a hunk's floor, and the ones that only mark it.
export const PATH_CLASSES = ['sensitive', 'shared', 'contract', 'generated', 'test', 'docs', 'lockfile', 'manifest'] as const
export type PathClass = (typeof PATH_CLASSES)[number]
// Impact a pattern hit raises a hunk to.
export const PATTERN_CLASSES = ['sensitive', 'contract', 'shared'] as const
export type PatternClass = (typeof PATTERN_CLASSES)[number]

export type Pattern = { name: string; source: string; flags: string; re: RegExp }

export type Config = {
  attention: { largeChangeFiles: number }
  paths: Record<PathClass, string[]>
  patterns: Record<PatternClass, Pattern[]>
}

type RawPattern = string | { regex: string; name?: string; flags?: string }

export const DEFAULTS: {
  attention: Config['attention']
  paths: Record<PathClass, string[]>
  patterns: Record<PatternClass, RawPattern[]>
} = {
  attention: { largeChangeFiles: 50 },
  paths: {
    sensitive: ['**/auth/**', '**/*crypto*', '**/*secret*', '**/*password*', '**/permissions/**', '**/migrations/**'],
    shared: [],
    contract: [
      '**/package.json', '**/package-lock.json', '**/pnpm-lock.yaml', '**/yarn.lock',
      '**/Cargo.toml', '**/Cargo.lock', '**/go.mod', '**/go.sum',
      '**/pyproject.toml', '**/poetry.lock', '**/requirements*.txt',
      '.github/workflows/**', '.gitlab-ci.yml', 'azure-pipelines*.yml', 'Jenkinsfile',
      '**/Dockerfile', '**/*.proto', '**/openapi*.{yml,yaml,json}',
    ],
    generated: ['**/*.lock', '**/*-lock.*', '**/*.snap', '**/__snapshots__/**'],
    test: ['**/*.{spec,test}.*', '**/test/**', '**/tests/**', '**/__tests__/**'],
    docs: ['**/*.md', '**/docs/**'],
    // Dependency files: always at least `contract`; changes to them are listed
    // as dependency changes, and package-lock.json and pnpm-lock.yaml are
    // parsed for version bumps.
    lockfile: ['**/package-lock.json', '**/pnpm-lock.yaml', '**/yarn.lock', '**/Cargo.lock', '**/go.sum', '**/poetry.lock', '**/*.lock'],
    manifest: ['**/package.json', '**/Cargo.toml', '**/go.mod', '**/pyproject.toml', '**/requirements*.txt'],
  },
  patterns: {
    sensitive: [
      { regex: '\\b(password|secret|private[_-]?key|api[_-]?key)\\b', name: 'secret or credential' },
      { regex: '\\b(encrypt|decrypt)\\b', name: 'encryption' },
      { regex: '\\b(DROP|TRUNCATE|ALTER)\\s+TABLE\\b', name: 'schema change' },
    ],
    contract: [],
    shared: [],
  },
}

const Glob = z.string().min(1).superRefine((g, ctx) => {
  try { globToRegExp(g) } catch (e) { ctx.addIssue({ code: 'custom', message: `invalid glob "${g}": ${(e as Error).message}` }) }
})
const Globs = z.union([
  z.array(Glob),
  z.object({ extends: z.boolean().optional(), globs: z.array(Glob) }).strict(),
])

// One place for how a pattern entry reads: the source, its flags (case-insensitive
// unless it sets some) and the name shown for its hits.
function normalise(p: RawPattern): { source: string; flags: string; name: string } {
  if (typeof p === 'string') return { source: p, flags: 'i', name: p }
  // g and y make a RegExp remember where it last matched, which would skip hits
  // on the next line; each line is tested on its own, so they are dropped.
  return { source: p.regex, flags: (p.flags ?? 'i').replace(/[gy]/g, ''), name: p.name ?? p.regex }
}

const Regex = z.union([
  z.string().min(1),
  z.object({ regex: z.string().min(1), name: z.string().optional(), flags: z.string().optional() }).strict(),
]).superRefine((p, ctx) => {
  const { source, flags } = normalise(p)
  try { new RegExp(source, flags) } catch (e) { ctx.addIssue({ code: 'custom', message: `invalid regular expression ${JSON.stringify(source)}: ${(e as Error).message}` }) }
})
const Regexes = z.union([
  z.array(Regex),
  z.object({ extends: z.boolean().optional(), regexes: z.array(Regex) }).strict(),
])

const shape = <T extends z.ZodType>(keys: readonly string[], v: T) => z.object(Object.fromEntries(keys.map((k) => [k, v.optional()]))).strict()

export const RepoConfig = z.object({
  attention: z.object({
    largeChangeFiles: z.number().int().min(1).optional(),
  }).strict().optional(),
  paths: shape(PATH_CLASSES, Globs).optional(),
  patterns: shape(PATTERN_CLASSES, Regexes).optional(),
}).strict()

const compile = (p: RawPattern): Pattern => {
  const n = normalise(p)
  return { ...n, re: new RegExp(n.source, n.flags) }
}

function describe(file: string, err: z.ZodError): string {
  const lines = err.issues.map((i) => {
    const where = i.path.length ? i.path.map(String).join('.') : '(top level)'
    // Name the unknown key rather than "Unrecognized key".
    const extra = i.code === 'unrecognized_keys' ? ` ${(i as { keys: string[] }).keys.map((k) => `"${k}"`).join(', ')}` : ''
    return `  ${where}: ${i.message}${extra}`
  })
  return `${file} is not a valid git-gloss config:\n${lines.join('\n')}`
}

// Merge a repo config over the defaults. Pure, so tests can call it directly.
export function mergeConfig(raw: z.infer<typeof RepoConfig> | undefined): Config {
  const list = <T,>(base: T[], over: T[] | { extends?: boolean } & Record<string, unknown> | undefined, key: string): T[] => {
    if (!over) return base
    if (Array.isArray(over)) return [...base, ...over]
    const items = over[key] as T[]
    return over.extends === false ? items : [...base, ...items]
  }
  const paths = {} as Record<PathClass, string[]>
  for (const k of PATH_CLASSES) paths[k] = list(DEFAULTS.paths[k], raw?.paths?.[k], 'globs')
  const patterns = {} as Record<PatternClass, Pattern[]>
  for (const k of PATTERN_CLASSES) patterns[k] = list<RawPattern>(DEFAULTS.patterns[k], raw?.patterns?.[k], 'regexes').map(compile)
  return { attention: { ...DEFAULTS.attention, ...raw?.attention }, paths, patterns }
}

// `git config gloss.attention.<key>` as a positive integer; throws naming the key.
function gitInt(key: string): number | undefined {
  const v = gitTry(['config', '--get', `gloss.attention.${key}`])?.trim()
  if (v === undefined || v === '') return undefined
  if (!/^[1-9]\d*$/.test(v)) throw new ConfigError(`git config gloss.attention.${key} must be a positive integer, got "${v}"`)
  return Number(v)
}

// Per working directory, so a command over many commits resolves the repo once.
const cache = new Map<string, Config>()
export const resetConfigCache = () => cache.clear()

// The effective config for the repository the process runs in. Throws
// ConfigError (with the file and key) for a malformed repo config or git
// setting. Memoised per working directory.
export function loadConfig(): Config {
  const hit = cache.get(process.cwd())
  if (hit) return hit
  const root = gitTry(['rev-parse', '--show-toplevel'])?.trim() ?? ''
  let raw: z.infer<typeof RepoConfig> | undefined
  const file = root ? join(root, CONFIG_FILE) : ''
  if (file && existsSync(file)) {
    let json: unknown
    try {
      json = JSON.parse(readFileSync(file, 'utf8'))
    } catch (err) {
      throw new ConfigError(`${CONFIG_FILE} is not valid JSON: ${(err as Error).message}`)
    }
    const parsed = RepoConfig.safeParse(json)
    if (!parsed.success) throw new ConfigError(describe(CONFIG_FILE, parsed.error))
    raw = parsed.data
  }
  const config = mergeConfig(raw)
  const files = gitInt('largeChangeFiles')
  if (files !== undefined) config.attention.largeChangeFiles = files
  cache.set(process.cwd(), config)
  return config
}
