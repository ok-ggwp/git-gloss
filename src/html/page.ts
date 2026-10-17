import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { PageData } from './data.ts'

const asset = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8')

// JSON inside a <script> element: escape "<" so no string in the data, such as
// "</script>", can end the element early.
export function embedJson(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c')
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

export function renderPage(data: PageData): string {
  // The page only runs our own inline script. If escaping ever failed, an
  // injected script would lack the nonce and the CSP would block it.
  const nonce = randomBytes(16).toString('base64')
  const csp = `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>${data.range ? `gloss ${escapeHtml(data.range)} (${data.commits.length} commits)` : `gloss ${escapeHtml(data.commits[0].sha.slice(0, 7))}: ${escapeHtml(data.commits[0].subject)}`}</title>
<style nonce="${nonce}">
${asset('./style.css')}
</style>
</head>
<body>
<div id="app"><noscript>This page needs JavaScript to render the gloss.</noscript></div>
<script type="application/json" id="gloss-data">${embedJson(data)}</script>
<script nonce="${nonce}">
${asset('./client.js')}
</script>
</body>
</html>
`
}
