import { GlossError } from './git.ts'
import * as add from './commands/add.ts'
import * as adopt from './commands/adopt.ts'
import * as ary from './commands/ary.ts'
import * as carry from './commands/carry.ts'
import * as html from './commands/html.ts'
import * as hunks from './commands/hunks.ts'
import * as init from './commands/init.ts'
import * as review from './commands/review.ts'
import * as lint from './commands/lint.ts'
import * as reviews from './commands/reviews.ts'
import * as schema from './commands/schema.ts'
import * as show from './commands/show.ts'
import * as signals from './commands/signals.ts'
import * as sync from './commands/sync.ts'
import * as versions from './commands/versions.ts'
import * as why from './commands/why.ts'

const COMMANDS: Record<string, { usage: string; run: (argv: string[]) => number }> = {
  init, hunks, signals, lint, add, adopt, carry, show, html, ary, why, review, reviews, sync, versions, schema,
}

function help(): string {
  return 'usage: git gloss <command> [options]\n\n' +
    Object.values(COMMANDS)
      .map((c) => {
        const [synopsis, desc] = c.usage.split(/ {3}/)
        return `  ${synopsis}\n      ${desc}`
      })
      .join('\n')
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv
  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') {
    console.log(help())
    return 0
  }
  const command = COMMANDS[cmd]
  if (!command) {
    console.error(`unknown command "${cmd}"\n\n${help()}`)
    return 2
  }
  try {
    return command.run(rest)
  } catch (err) {
    if (err instanceof GlossError || (err as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) {
      console.error(`error: ${(err as Error).message}`)
      return 1
    }
    throw err
  }
}
