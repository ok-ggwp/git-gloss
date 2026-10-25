// Internal entry, run by the ary server as a child process (see jobs.ts): builds
// one page so that the server's event loop never waits for git. argv[2] is the
// checked query as JSON. stdout is one JSON line (the status, or an error
// message) and then the page's bytes. An unexpected failure is left to node:
// stack on stderr, exit code 1.
import { GlossError } from '../git.ts'
import { buildDesk, type DeskQuery } from './desk.ts'

const query = JSON.parse(process.argv[2]) as DeskQuery
let head: object
let body = ''
try {
  const r = buildDesk(query)
  head = { status: r.status, type: r.type, headers: r.headers }
  body = r.body
} catch (err) {
  if (!(err instanceof GlossError)) throw err
  head = { status: 422, error: err.message }
}
// No process.exit: let the pipe drain, a large page is written in pieces.
process.stdout.write(JSON.stringify(head) + '\n')
process.stdout.write(body)
