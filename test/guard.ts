// Loaded into every test file's process (node --import). A test that hits
// --test-timeout fails, but its file's process keeps running while anything is
// still alive in it (a child process, a socket), which stalls the whole suite.
// This backstop ends the process, with a message, long after any test's own
// timeout; the exit runs the cleanups of test/tmp.ts (which kill browsers).
const LIMIT = Number(process.env.GLOSS_FILE_TIMEOUT ?? 600_000)
setTimeout(() => {
  console.error(`# test file still running after ${LIMIT} ms: a test hung; ending its process`)
  process.exit(1)
}, LIMIT).unref()
