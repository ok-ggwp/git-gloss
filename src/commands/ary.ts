import { parseArgs } from 'node:util'
import { createAry } from '../ary/server.ts'
import { GlossError, git } from '../git.ts'
import { openInBrowser } from './html.ts'

export const usage = 'ary [--port <n>] [--no-open]   browse glosses of branches, commits and uncommitted work in a local web page'

// Starts a read-only server on this machine and keeps running until stopped.
// The browser page lists branches and commits and shows each selection with
// the same view as `git gloss html`.
export function run(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: { port: { type: 'string' }, 'no-open': { type: 'boolean' } },
  })
  // Number('') and Number(' ') are 0, which would quietly mean "any port".
  const port = values.port === undefined ? 0 : /^\d+$/.test(values.port) ? Number(values.port) : NaN
  if (!Number.isInteger(port) || port > 65535) throw new GlossError(`not a port: ${values.port}`)
  git(['rev-parse', '--git-dir']) // fail early outside a repository

  let boundPort = port
  const server = createAry(() => boundPort)
  server.on('error', (err: NodeJS.ErrnoException) => {
    console.error(`error: ${err.code === 'EADDRINUSE' ? `port ${port} is in use` : err.message}`)
    process.exitCode = 1
  })
  // Loopback only: the view includes the code of your commits.
  server.listen(port, '127.0.0.1', () => {
    boundPort = (server.address() as { port: number }).port
    const url = `http://127.0.0.1:${boundPort}/`
    console.log(url)
    console.error('serving glosses read-only; press Ctrl-C to stop')
    if (!values['no-open']) openInBrowser(url)
  })
  return 0
}
