// Renders the gloss page (the "review desk") from the embedded JSON: a rail of
// groups, or of commits for a range, and a detail pane for the selection.
// All text goes through textContent; nothing from the data is ever parsed as
// HTML. Colours reach elements as custom properties set through the CSSOM,
// which the page's CSP allows (it blocks style attributes).
(function () {
  'use strict'
  var data = JSON.parse(document.getElementById('gloss-data').textContent)
  var app = document.getElementById('app')
  var commits = data.commits
  var multi = commits.length > 1 || data.range !== null
  var IMPACTS = data.impact.map(function (i) { return i.name })
  var LEVELS = ['skim', 'look', 'careful', 'must-read']
  var FILTERS = [['all', 'All'], ['focus', 'Look first'], ['contract', 'Contract and above'], ['low', 'Local only']]

  // What is shown: a commit (index) and in it a group, the overview or the
  // unannotated changes. Plus the filters and whether diffs are open.
  var booting = true // no scrolling while the first selection is made
  var state = { ci: 0, kind: 'overview', gid: null, filter: 'all', hidden: new Set(), hot: true, stage: null, back: null }

  // ---- helpers ----
  function el(tag, cls, text) {
    var e = document.createElement(tag)
    if (cls) e.className = cls
    if (text !== undefined && text !== null) e.textContent = String(text)
    return e
  }
  function add(parent) {
    for (var i = 1; i < arguments.length; i++) if (arguments[i]) parent.appendChild(arguments[i])
    return parent
  }
  function text(s) { return document.createTextNode(s) }
  function button(cls, label, onclick) {
    var b = el('button', cls, label)
    b.type = 'button'
    if (onclick) b.addEventListener('click', onclick)
    return b
  }
  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's') }
  function sha7(c) { return c.sha.slice(0, 7) }
  // Group ids are unique within a commit, not across a range, so a range keys
  // groups by commit too: #g-<sha7>-<group>.
  function key(c, id) { return multi ? sha7(c) + '-' + id : id }
  function stats(added, removed) {
    return add(el('span', 'stats'), el('span', 'plus', '+' + added), text(' '), el('span', 'minus', '−' + removed))
  }
  function impactRank(level) { return IMPACTS.indexOf(level) + 1 }
  function levelRank(level) { return LEVELS.indexOf(level) + 1 }
  // Declared impact, else the one derived from the diff (only present where the
  // diff puts a group above the baseline), else none.
  function effImpact(g) { return g.impact || g.impact_derived || null }
  function find(list, fn) { for (var i = 0; i < list.length; i++) if (fn(list[i])) return list[i]; return null }
  function groupOf(c, id) { return find(c.groups, function (g) { return g.id === id }) }
  function orderedGroups(c) { return c.order.map(function (id) { return groupOf(c, id) }).filter(Boolean) }
  function isFocus(c, g) { return !!(c.attention && c.attention.focus && c.attention.focus.indexOf(g.id) >= 0) }

  // The level of a commit as the reader should treat it: declared, else derived.
  function levelOf(c) {
    if (!c.glossed) return { level: null, source: 'none' }
    if (c.attention) return { level: c.attention.level, source: 'declared' }
    if (c.computed) return { level: c.computed.derived.level, source: 'derived' }
    return { level: null, source: 'unrated' }
  }
  function fileCount(c) {
    var seen = Object.create(null)
    c.groups.forEach(function (g) { g.hunks.forEach(function (h) { seen[h.file] = true }) })
    c.unannotated.forEach(function (h) { seen[h.file] = true })
    return Object.keys(seen).length
  }

  // ---- read state, kept per commit in sessionStorage (this tab only) when it is available ----
  var readCache = {}
  function readSet(c) {
    if (!readCache[c.sha]) {
      var s = Object.create(null) // no prototype: a group id like "constructor" must not read as already read
      try {
        var raw = window.sessionStorage.getItem('git-gloss:read:' + c.sha)
        if (raw) JSON.parse(raw).forEach(function (id) { s[id] = true })
      } catch (e) { /* storage blocked or unreadable: marks are kept in memory for this visit only */ }
      readCache[c.sha] = s
    }
    return readCache[c.sha]
  }
  function setRead(c, id, on) {
    var s = readSet(c)
    if (on) s[id] = true; else delete s[id]
    try { window.sessionStorage.setItem('git-gloss:read:' + c.sha, JSON.stringify(Object.keys(s))) } catch (e) { /* not persisted */ }
  }
  function readCounts() {
    var read = 0, total = 0
    commits.forEach(function (c) {
      var s = readSet(c)
      c.groups.forEach(function (g) { total++; if (s[g.id]) read++ })
    })
    return { read: read, total: total }
  }

  // ---- small widgets ----
  function meter(level) {
    var m = el('span', level ? 'meter' : 'meter unrated')
    m.setAttribute('aria-hidden', 'true')
    var n = impactRank(level)
    for (var i = 1; i <= 5; i++) m.appendChild(el('i', i <= n ? 'on' : null))
    if (level) m.style.setProperty('--m', 'var(--impact-' + level + ')')
    return m
  }
  function gauge(level, small) {
    var g = el('span', small ? 'gauge small' : 'gauge')
    g.setAttribute('aria-hidden', 'true')
    for (var i = 1; i <= 4; i++) g.appendChild(el('i', i <= levelRank(level) ? 'on' : null))
    return g
  }
  function impactWord(g) {
    var level = effImpact(g)
    return level ? level + ' impact' + (g.impact ? '' : ' (derived)') : 'impact not rated'
  }
  function groupLink(c, id) {
    var a = el('a', null, id)
    a.href = '#g-' + key(c, id)
    a.addEventListener('click', function (ev) { ev.preventDefault(); selectGroup(commits.indexOf(c), id) })
    return a
  }
  function linkList(c, ids) {
    var span = el('span')
    ids.forEach(function (id, i) { if (i) span.appendChild(text(', ')); span.appendChild(groupLink(c, id)) })
    return span
  }
  function commitMeta(c) {
    return add(el('div', 'commit'), el('span', 'sha', c.sha.slice(0, 10)),
      el('span', null, c.author), el('span', null, new Date(c.date).toLocaleString()))
  }
  function statement(parent, label, body) {
    if (body) add(parent, add(el('p', 'statement'), el('span', 'label', label), text(body)))
  }
  function warnings(c, parent) {
    c.warnings.forEach(function (w) { add(parent, el('div', 'warning', '⚠ ' + w)) })
  }

  // ---- diff rendering ----
  // Each hunk folds on its own; the header row stays. Open/closed lives in
  // memory for the page's lifetime (not in storage), keyed by commit, scope
  // (group id or 'un') and the hunk's reference. The DOM is the source of truth
  // for what is open: syncFold() reads it to set the Expand/Collapse buttons.
  var hunkClosed = {}
  function setHunkOpen(wrap, open) {
    var toggle = wrap.querySelector('.htoggle')
    if (!toggle) return
    if (open) delete hunkClosed[wrap.getAttribute('data-fold')]; else hunkClosed[wrap.getAttribute('data-fold')] = true
    wrap.querySelector('.scroll').hidden = !open
    toggle.setAttribute('aria-expanded', String(open))
    toggle.firstChild.textContent = open ? '▾' : '▸'
    wrap.classList.toggle('closed', !open)
  }
  function hunkView(c, h, scope) {
    var name = h.oldFile ? h.oldFile + ' → ' + h.file : h.file
    var head = el('div', 'hunk-head')
    var wrap = el('div', 'hunk')
    var foldKey = c.sha + '|' + scope + '|' + h.ref
    wrap.setAttribute('data-fold', foldKey)
    var toggle = null
    if (h.status === 'missing') add(head, el('span', 'file', name))
    else {
      var chev = el('span', 'chev', '▾')
      chev.setAttribute('aria-hidden', 'true')
      toggle = add(button('htoggle', null), chev, el('span', 'file', name))
      toggle.setAttribute('data-fid', 'hunk:' + foldKey)
      toggle.addEventListener('click', function () { setHunkOpen(wrap, toggle.getAttribute('aria-expanded') !== 'true'); syncFold() })
    }
    add(head, toggle, el('span', 'range', h.ref), el('span', 'range', h.range), stats(h.added, h.removed))
    if (h.status === 'changed') add(head, el('span', 'stale', 'changed since glossed'))
    if (h.status === 'missing') {
      add(head, el('span', 'stale', 'no longer in this commit'))
      return add(wrap, head)
    }
    if (h.alsoIn.length) add(head, add(el('span', 'also'), text('shares lines with '), linkList(c, h.alsoIn)))
    var table = el('table', 'diff')
    h.lines.forEach(function (l) {
      var tr = el('tr', l.kind)
      if (l.kind === 'meta' || l.kind === 'gap') {
        var td = el('td', 'text', l.text)
        td.colSpan = 4
        add(tr, td)
      } else {
        add(tr,
          el('td', 'ln', l.old === null ? '' : l.old),
          el('td', 'ln', l.new === null ? '' : l.new),
          el('td', 'mark', l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '),
          el('td', 'text', l.text))
      }
      table.appendChild(tr)
    })
    add(wrap, head, add(el('div', 'scroll'), table))
    setHunkOpen(wrap, !hunkClosed[foldKey])
    return wrap
  }
  // "Expand all hunks" / "Collapse all hunks" act on the hunks of the pane; the
  // one that is already true is disabled (focus moves to the other one).
  function syncFold() {
    var expand = mainEl.querySelector('[data-fid="code:expand"]')
    var collapse = mainEl.querySelector('[data-fid="code:collapse"]')
    if (!expand) return
    var toggles = mainEl.querySelectorAll('.htoggle')
    var open = mainEl.querySelectorAll('.htoggle[aria-expanded="true"]').length
    var a = document.activeElement
    expand.disabled = open === toggles.length
    collapse.disabled = open === 0
    if (a && a.disabled && (a === expand || a === collapse)) {
      var other = a === expand ? collapse : expand
      if (!other.disabled) other.focus({ preventScroll: true })
    }
  }
  function setCode(open) {
    var wraps = mainEl.querySelectorAll('.hunk')
    for (var i = 0; i < wraps.length; i++) setHunkOpen(wraps[i], open)
    syncFold()
  }

  // ---- attention ----
  // The declared attention (or the one derived from the diff, marked as such),
  // the computed floor, the reasons and links to the groups to read first;
  // "unrated" when nothing is declared and no signals exist.
  function attentionCard(c) {
    var a = c.attention, k = c.computed
    var level = levelOf(c).level
    var box = el('section', 'att')
    box.setAttribute('aria-label', 'Attention')
    if (level) box.style.setProperty('--lv', 'var(--attention-' + level + ')')
    var lvl = add(el('div', 'lvl'), el('span', null, level ? level.toUpperCase() : 'UNRATED'), level ? gauge(level) : null)
    if (a) add(lvl, el('span', 'src', 'declared'))
    else if (k) {
      var d = el('span', 'src', 'derived')
      d.title = 'Derived from the diff, not declared in the gloss'
      add(lvl, d)
    }
    if (k) add(lvl, el('span', 'src', 'floor ' + k.floor))
    add(box, lvl)
    var reasons = a ? a.reasons : k ? k.derived.reasons : []
    if (reasons && reasons.length) {
      var ul = el('ul')
      reasons.forEach(function (r) { ul.appendChild(el('li', null, r)) })
      add(box, ul)
    }
    if (k && k.timedOut && k.timedOut.length) {
      var tl = el('ul', 'timedout')
      k.timedOut.forEach(function (r) { tl.appendChild(el('li', null, r)) })
      add(box, tl)
    }
    if (c.risks.length) {
      var rb = button('linkbtn', plural(c.risks.length, 'risk') + ' flagged', function () { selectRisks(commits.indexOf(c)) })
      add(box, add(el('p', 'look'), rb))
    }
    if (a && k && k.below) add(box, el('p', 'override mismatch', 'Declared ' + a.level + ', below the computed floor ' + k.floor + (a.override_reason ? '. Reason given: ' + a.override_reason : ' (no reason given).')))
    else if (a && a.override_reason) add(box, el('p', 'override', 'Rated below what the change suggests: ' + a.override_reason))
    return box
  }

  // ---- reviews: whether each stage reviewed the commit as it is now ----
  function reviewClass(r) {
    return r.state !== 'seen' || r.verdict === 'issues' ? 'stale' : r.verdict === 'clean' ? 'review-ok' : 'review-none'
  }
  // A stage's verdict and how current it is, short enough for a rail row.
  function reviewShort(r) {
    var v = r.verdict === 'issues' ? 'issues found' : r.verdict === 'clean' ? 'no issues' : 'reviewed'
    var f = r.state === 'seen' ? 'current' : r.state === 'code-changed' ? 'code changed since review' : 'gloss changed since review'
    return v + ' · ' + f
  }
  // How many findings of a stage are still undecided (and how far a legacy review's decisions got), for a rail row.
  function decidedShort(r) {
    // Structured findings: every item of every structured review of the stage; stale reviews are counted and marked.
    var any = r.entries.some(function (e) { return e.items && e.items.length })
    var label = ''
    if (r.open) label = ' \u00b7 ' + r.open + ' open' + (r.openStale ? ' (' + r.openStale + ' on stale reviews)' : '')
    else if (any) label = ' \u00b7 all decided'
    // A legacy review (no items) next to them: its decisions are free text, so say how far they got.
    var legacy = find(r.entries, function (e) { return !e.items && e.decisions && e.verdict !== 'clean' })
    if (!legacy) return label
    if (legacy.complete) return label + ' \u00b7 complete'
    return label + (legacy.decisionCount ? ' \u00b7 ' + legacy.decisionCount + ' decided' : ' \u00b7 undecided (legacy)')
  }
  // One compact row per stage; each opens the Reviews view in the main pane.
  function reviewStatus(c) {
    var ci = commits.indexOf(c)
    var box = el('div', 'reviews')
    if (!c.reviews.length) return add(box, el('span', 'review-none', 'No reviews recorded'))
    c.reviews.forEach(function (r) {
      var cls = reviewClass(r)
      var b = button('rvrow', null, function () { selectReviews(ci, r.stage) })
      b.setAttribute('data-fid', 'rv:' + ci + ':' + r.stage)
      b.title = r.phrase
      add(b, el('span', 'rvdot ' + (cls === 'review-ok' ? 'ok' : cls === 'stale' ? 'warn' : 'none')), el('span', 'rvstage', r.stage), el('span', 'rvtxt', reviewShort(r) + decidedShort(r)),
        el('span', 'rvn', r.entries.length))
      box.appendChild(b)
    })
    return box
  }

  // ---- markdown: a small subset, built as DOM nodes (never parsed as HTML) ----
  var ALNUM = /[A-Za-z0-9]/
  // Review text is untrusted and unbounded: no emphasis or link may reach further than this.
  var MAX_SPAN = 500
  function inline(parent, s) {
    var i = 0, buf = ''
    function flush() { if (buf) { parent.appendChild(text(buf)); buf = '' } }
    while (i < s.length) {
      var ch = s.charAt(i), j, m
      if (ch === '`') {
        j = s.indexOf('`', i + 1)
        if (j > i + 1) { flush(); parent.appendChild(el('code', null, s.slice(i + 1, j))); i = j + 1; continue }
      } else if (ch === '*' && s.charAt(i + 1) === '*') {
        j = s.indexOf('**', i + 2)
        if (j > i + 2) { flush(); parent.appendChild(inline(el('strong'), s.slice(i + 2, j))); i = j + 2; continue }
      } else if (ch === '*' && s.charAt(i + 1) && !/[\s*]/.test(s.charAt(i + 1)) && (i === 0 || !ALNUM.test(s.charAt(i - 1)))) {
        // Looks no further than MAX_SPAN: an unclosed marker would otherwise re-read the rest of the text each time (quadratic).
        for (j = i + 2; j < s.length && j < i + MAX_SPAN; j++) {
          if (s.charAt(j) === '*' && !/\s/.test(s.charAt(j - 1)) && !ALNUM.test(s.charAt(j + 1)) && s.charAt(j + 1) !== '*') break
        }
        if (j < s.length && j < i + MAX_SPAN) { flush(); parent.appendChild(inline(el('em'), s.slice(i + 1, j))); i = j + 1; continue }
      } else if (ch === '[') {
        m = /^\[([^\]]{1,200})\]\(([^)\s]{1,400})\)/.exec(s.slice(i, i + MAX_SPAN))
        if (m) { flush(); inline(parent, m[1]); parent.appendChild(el('span', 'muted', ' (' + m[2] + ')')); i += m[0].length; continue }
      }
      buf += ch
      i++
    }
    flush()
    return parent
  }
  // Headings # to ####, paragraphs, bullet and numbered lists (nested by
  // indentation), fenced code. Anything else is a paragraph of plain text.
  function markdown(src) {
    var root = el('div', 'md')
    var lines = String(src || '').replace(/\r/g, '').split('\n')
    var para = [], stack = [] // stack of { indent, list, li }
    function endPara() { if (para.length) { root.appendChild(inline(el('p'), para.join(' '))); para = [] } }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i], m
      if (/^\s*```/.test(line)) {
        endPara(); stack = []
        var code = []
        for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i])
        root.appendChild(add(el('pre'), el('code', null, code.join('\n'))))
        continue
      }
      if (!line.trim()) { endPara(); continue }
      if ((m = /^(#{1,4})\s+(.*)$/.exec(line))) {
        endPara(); stack = []
        root.appendChild(inline(el('h' + (m[1].length + 2)), m[2]))
        continue
      }
      if ((m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line))) {
        endPara()
        var indent = m[1].length, tag = /^\d/.test(m[2]) ? 'ol' : 'ul'
        while (stack.length && stack[stack.length - 1].indent > indent) stack.pop()
        var top = stack[stack.length - 1]
        if (!top || top.indent < indent || top.list.tagName.toLowerCase() !== tag) {
          if (top && top.indent === indent) stack.pop()
          var list = el(tag)
          // A numbered list starts at its first item's number, so "5. 6." is not shown as "1. 2.".
          var first = tag === 'ol' ? parseInt(m[2], 10) : 0
          if (first > 0 && first < 100000 && first !== 1) list.start = first
          if (stack.length && stack[stack.length - 1].li) stack[stack.length - 1].li.appendChild(list); else root.appendChild(list)
          top = { indent: indent, list: list, li: null }
          stack.push(top)
        }
        top.li = inline(el('li'), m[3])
        top.list.appendChild(top.li)
        continue
      }
      if (stack.length && /^\s/.test(line)) { // a wrapped list item
        var cur = stack[stack.length - 1]
        cur.li.appendChild(text(' '))
        inline(cur.li, line.trim())
        continue
      }
      stack = []
      para.push(line.trim())
    }
    endPara()
    return root
  }

  // ---- the Reviews view in the main pane ----
  function verdictOf(findings) {
    var m = /VERDICT:\W*(CLEAN|ISSUES)/i.exec(String(findings).slice(-400))
    return m ? m[1].toUpperCase() : null
  }
  function entryHead(e) {
    var head = el('div', 'ehead')
    add(head, el('strong', null, e.agent + (e.model ? ':' + e.model : '') + (e.mode ? ' (' + e.mode + ')' : '')),
      el('span', 'muted', e.at.slice(0, 16).replace('T', ' ') + ', of ' + e.target))
    if (e.stale) add(head, el('span', 'chip bad', 'stale review'))
    var v = verdictOf(e.findings)
    if (v) add(head, el('span', 'chip ' + (v === 'ISSUES' ? 'bad' : 'good'), v === 'ISSUES' ? 'issues found' : 'no issues'))
    return head
  }
  // What was decided about one review: the summary, then a row per decision. Text only, never markup.
  function decisionsBlock(e) {
    if (!e.decisions) return null
    var box = el('div', 'decisions')
    add(box, el('h3', 'dhead', 'Decisions'), el('p', 'dsum', e.summary))
    if (e.decisionCount > e.decisions.length) add(box, el('p', 'muted dhidden', 'showing the latest ' + e.decisions.length + ' of ' + e.decisionCount))
    if (e.decisions.length) {
      var ul = el('ul', 'dlist')
      e.decisions.forEach(function (d) {
        var row = el('li', 'drow')
        add(row, el('span', 'chip dchip ' + d.outcome, d.outcome), text(' '), el('span', 'dfinding', d.finding))
        if (d.note) add(row, text(' \u2014 '), el('span', 'dnote', d.note))
        add(row, text(' '), el('span', 'muted dby', d.by + ', ' + d.at.slice(0, 10)))
        ul.appendChild(row)
      })
      add(box, ul)
    }
    return box
  }
  // The report's findings: severity, kind, basis, where each stands, the title. Text only, never markup.
  function itemsBlock(e) {
    if (!e.items) return null
    var box = el('div', 'items')
    add(box, el('h3', 'dhead', plural(e.items.length, 'finding')))
    if (!e.items.length) return box
    var ul = el('ul', 'dlist')
    e.items.forEach(function (i) {
      var row = el('li', 'drow irow')
      add(row, el('span', 'chip dchip ' + (i.status === 'open' ? 'open' : i.status), i.status), text(' '), el('strong', 'iid', i.id), text(' '),
        el('span', 'chip sev-' + i.severity, i.severity), text(' '), el('span', 'chip', i.kind), text(' '), el('span', 'chip', i.basis), text(' '), el('span', 'ititle', i.title))
      if (i.where) add(row, text(' '), el('span', 'muted iwhere', i.where))
      if (i.note) add(row, text(' \u2014 '), el('span', 'dnote', i.note))
      ul.appendChild(row)
    })
    return add(box, ul)
  }
  // The raw report: shown as it is for a legacy review; under a disclosure when the findings are listed above it.
  function reportBlock(e) {
    if (!e.items) return markdown(e.findings)
    return add(el('details', 'rawreport'), el('summary', null, 'Report'), markdown(e.findings))
  }
  function reviewsPane(c, stage) {
    var pane = el('div')
    add(pane, button('btn small back', '‹ Back', goBack))
    add(pane, commitMeta(c), el('h1', 'title', 'Reviews: ' + c.subject))
    if (!c.reviews.length) return add(pane, el('p', 'muted', 'No reviews recorded for this commit.'))
    c.reviews.forEach(function (r) {
      var sec = el('section', 'rvstagepane')
      sec.id = 'rv-' + r.stage
      add(sec, el('h2', null, r.stage), add(el('p', 'rvsum'), el('span', reviewClass(r), r.phrase)))
      var entries = r.entries.slice().sort(function (a, b) { return a.at < b.at ? 1 : a.at > b.at ? -1 : 0 })
      entries.forEach(function (e, i) {
        if (i === 0) add(sec, add(el('div', 'entry'), entryHead(e), itemsBlock(e), decisionsBlock(e), reportBlock(e)))
        else {
          var d = el('details', 'entry old')
          add(d, add(el('summary'), entryHead(e)), itemsBlock(e), decisionsBlock(e), reportBlock(e))
          add(sec, d)
        }
      })
      add(pane, sec)
    })
    return pane
  }
  function goBack() {
    var b = state.back
    if (b && b.kind === 'group') selectGroup(b.ci, b.gid)
    else if (b) selectKind(b.ci, b.kind)
    else selectKind(state.ci, 'overview')
  }
  function selectReviews(ci, stage) {
    if (state.kind !== 'reviews' && state.kind !== 'risks') state.back = { ci: state.ci, kind: state.kind, gid: state.gid }
    state.ci = ci
    state.kind = 'reviews'
    state.gid = null
    state.stage = stage || null
    show(!stage)
    var t = stage && document.getElementById('rv-' + stage)
    if (t) t.scrollIntoView({ block: 'start' }) // deliberately also at load: #reviews-<stage> lands on that stage
  }
  function honestyLabel(c) {
    var honesty = find(c.reviews, function (r) { return r.stage === 'honesty' })
    if (!honesty) return ['stale', 'not reviewed']
    var label = honesty.state !== 'seen' ? 'changed since review'
      : honesty.verdict === 'issues' ? 'honesty: issues found'
      : honesty.verdict === 'clean' ? 'honesty: no issues' : 'honesty-reviewed'
    return [reviewClass(honesty), label]
  }

  // ---- filters ----
  var contractRank = IMPACTS.indexOf('contract') + 1
  var passes = {
    all: function () { return true },
    focus: function (g, c) { return isFocus(c, g) },
    contract: function (g) { return impactRank(effImpact(g)) >= contractRank },
    low: function (g) { return effImpact(g) === 'local' }
  }
  function visibleGroups(c) {
    var p = passes[state.filter]
    return orderedGroups(c).filter(function (g) { return p(g, c) && !state.hidden.has(g.necessity) })
  }

  // ---- the order commits are listed in ----
  function commitOrder() {
    // data.commits is oldest first; the rail lists newest first, like git log.
    var idx = commits.map(function (c, i) { return i }).reverse()
    if (multi && state.hot) {
      idx.sort(function (a, b) { return (levelRank(levelOf(commits[b]).level) - levelRank(levelOf(commits[a]).level)) || (b - a) })
    }
    return idx
  }
  // The groups the reader steps through: those of the open commit, in rail order.
  function neighbor(dir) {
    var all = commits[state.ci].order
    var vis = visibleGroups(commits[state.ci]).map(function (g) { return g.id })
    if (!vis.length) return null
    var i = state.kind === 'group' ? all.indexOf(state.gid) : -1
    if (i < 0) return vis[dir > 0 ? 0 : vis.length - 1]
    // The nearest visible group after / before this one in the full order, even if the filter hides this one.
    for (var j = i + dir; j >= 0 && j < all.length; j += dir) if (vis.indexOf(all[j]) >= 0) return all[j]
    return null
  }
  // j/k and Previous/Next: groups when one is open (or on a single commit's
  // overview), commits on a range's commit list.
  function stepTo(dir) {
    if (!multi && state.kind === 'overview' && dir < 0) return
    if (!multi && state.kind === 'group' && dir < 0 && !neighbor(-1)) { selectKind(0, 'overview'); return }
    if (multi && state.kind !== 'group') {
      var order = commitOrder()
      // The nearest commit the filter shows, not one it hides.
      for (var j = order.indexOf(state.ci) + dir; j >= 0 && j < order.length; j += dir) {
        if (!commitHidden(order[j])) { selectKind(order[j], 'overview'); break }
      }
      return
    }
    var id = neighbor(dir)
    if (id) selectGroup(state.ci, id)
  }
  function resetFilters() { state.filter = 'all'; state.hidden.clear() }

  // ---- the detail pane ----
  var topEl = el('header', 'top')
  // Served by `git gloss ary`: the branch pickers (src/ary/picker.js, included
  // ahead of this script only then) live in the top bar. Built once, since
  // the bar is rebuilt on every change of filter.
  var aryEl = data.ary ? aryBar(data.ary, el, add) : null
  var railEl = el('aside', 'rail')
  railEl.setAttribute('aria-label', multi ? 'Commits in the range' : 'Groups in review order')
  var mainEl = el('main', 'main')
  var body = add(el('div', multi ? 'body range' : 'body'), railEl, mainEl)

  // What the author flagged about the commit as a whole: it belongs to the
  // Overview, not under any one group.
  function risksSection(c, pane) {
    if (c.risks.length) {
      var rl = el('ul', 'list')
      c.risks.forEach(function (r) { rl.appendChild(el('li', null, r)) })
      var h = el('h2', null, 'Risks the author flagged (' + c.risks.length + ')')
      h.id = 'risks'
      add(pane, h, rl)
    }
    if (c.alternatives.length) {
      var al = el('ul', 'list')
      c.alternatives.forEach(function (x) {
        al.appendChild(add(el('li'), el('strong', null, x.option), el('span', 'why', ' — ' + x.rejected_because)))
      })
      add(pane, el('h2', null, 'Alternatives the author rejected (' + c.alternatives.length + ')'), al)
    }
  }
  function riskCounts(c) {
    var parts = []
    if (c.risks.length) parts.push(plural(c.risks.length, 'risk'))
    if (c.alternatives.length) parts.push(plural(c.alternatives.length, 'alternative'))
    return parts.join(' · ')
  }
  // The row that opens the risks and alternatives page; none when there are neither.
  function risksRow(ci) {
    var c = commits[ci]
    if (!c.risks.length && !c.alternatives.length) return null
    var b = button('rvrow', null, function () { selectRisks(ci) })
    b.setAttribute('data-fid', 'risks:' + ci)
    return add(b, el('span', 'rvdot none'), el('span', 'rvstage', 'Risks and alternatives'), el('span', 'rvtxt', riskCounts(c)))
  }
  function risksPane(c) {
    var pane = el('div')
    add(pane, button('btn small back', '‹ Back', goBack))
    add(pane, commitMeta(c), el('h1', 'title', 'Risks and alternatives: ' + c.subject))
    risksSection(c, pane)
    return pane
  }
  function selectRisks(ci) {
    if (state.kind !== 'reviews' && state.kind !== 'risks') state.back = { ci: state.ci, kind: state.kind, gid: state.gid }
    state.ci = ci
    state.kind = 'risks'
    state.gid = null
    show(true)
  }

  // Previous / Next / mark read: rebuilt whenever the filters change, since
  // which neighbours exist depends on the filter and the position only (not on
  // read marks).
  function navBar() {
    var next = neighbor(1)
    var nav = el('div', 'nav')
    var pb = button('btn', 'Previous', function () { stepTo(-1) })
    pb.setAttribute('data-fid', 'nav:prev')
    var nb = button('btn', 'Next', function () { stepTo(1) })
    nb.setAttribute('data-fid', 'nav:next')
    pb.disabled = !neighbor(-1) && !(!multi && state.kind === 'group')
    nb.disabled = !next
    var rb = button('btn primary', next ? 'Mark as read and go to next' : 'Mark as read', function () { markRead(true); stepTo(1) })
    rb.setAttribute('data-fid', 'nav:read')
    return add(nav, pb, nb, rb, add(el('span', 'keys'), el('kbd', null, 'j'), text(' '), el('kbd', null, 'k'), text(multi ? ' step · ' : ' step (the overview comes before the first group) · '),
      el('kbd', null, 'r'), text(' mark read · '), el('kbd', null, 'o'), text(' fold hunk')))
  }
  function refreshNav() {
    var old = mainEl.querySelector('.nav')
    if (old) old.parentNode.replaceChild(navBar(), old)
  }

  // The "Changes" heading with the buttons that fold every hunk of the pane.
  function changesHead(title) {
    var expand = button('btn small', 'Expand all hunks', function () { setCode(true) })
    var collapse = button('btn small', 'Collapse all hunks', function () { setCode(false) })
    expand.setAttribute('data-fid', 'code:expand')
    collapse.setAttribute('data-fid', 'code:collapse')
    return add(el('div', 'chead'), el('h2', null, title), add(el('span'), expand, text(' '), collapse))
  }

  // On a range, a group or the unannotated changes open inside their commit.
  function backLink(c, pane) {
    if (!multi) return
    var b = button('btn small back', '‹ ' + c.subject, function () { selectKind(commits.indexOf(c), 'overview') })
    b.title = 'Back to the commit'
    add(pane, b)
  }

  function groupPane(c, g) {
    var pane = el('div')
    var order = c.order
    var hunkN = g.hunks.length
    var files = []
    var perFile = Object.create(null)
    g.hunks.forEach(function (h) {
      if (!perFile[h.file]) { perFile[h.file] = 0; files.push(h.file) }
      perFile[h.file]++
    })
    backLink(c, pane)
    add(pane, commitMeta(c))
    add(pane, el('div', 'crumbs', (multi ? sha7(c) + ' · ' : '') + 'Group ' + (order.indexOf(g.id) + 1) + ' of ' + order.length + ' · ' +
      plural(hunkN, 'hunk') + ' in ' + plural(files.length, 'file')))
    add(pane, el('h1', 'intent', g.intent))

    var tags = el('div', 'tags')
    add(tags, el('span', 'chip', g.necessity))
    var level = effImpact(g)
    var imp = add(el('span', 'imp' + (g.impact ? '' : ' derived')), meter(level), text(impactWord(g)))
    if (level) imp.style.setProperty('--m', 'var(--impact-' + level + ')')
    if (!g.impact && level) imp.title = 'Derived from the diff, not declared in the gloss'
    add(tags, imp, el('span', 'chip mono', g.id))
    if (g.serves[0] !== 'task') add(tags, add(el('span', 'chip'), text('serves '), linkList(c, g.serves)))
    else add(tags, el('span', 'chip', 'serves task'))
    if (isFocus(c, g)) add(tags, el('span', 'chip', 'look here first'))
    if (g.stale) add(tags, el('span', 'stale', g.stale + ' of ' + plural(g.total, 'hunk') + ' changed or gone'))
    add(tags, stats(g.added, g.removed))
    add(pane, tags)
    if (g.impact_reason) add(pane, el('p', 'reason', g.impact_reason))
    warnings(c, pane)

    var cards = el('div', 'cards')
    function card(label, value) {
      if (value) add(cards, add(el('div', 'card'), el('div', 'eyebrow', label), el('p', null, value)))
    }
    card('If removed', g.removal_impact)
    card('Evidence', g.evidence)
    card('Notes', g.notes)
    add(pane, cards)

    add(pane, changesHead('Changes'))
    if (files.length) {
      var fl = el('div', 'files')
      files.forEach(function (f) { add(fl, add(el('div', 'frow'), el('span', 'mono', f), el('span', 'muted', plural(perFile[f], 'hunk')))) })
      add(pane, fl)
    }
    g.hunks.forEach(function (h) { pane.appendChild(hunkView(c, h, g.id)) })
    add(pane, navBar())
    return pane
  }

  function unannotatedBox(c) {
    var box = add(el('div', 'unannotated'), el('p', null, c.glossed
      ? 'These changes are in the commit but no group explains them.'
      : c.glossRefused ? 'This commit\'s gloss was refused, so nothing explains these changes.'
      : 'This commit has no gloss, so nothing explains these changes.'))
    c.unannotated.forEach(function (h) { box.appendChild(hunkView(c, h, 'un')) })
    return box
  }
  function unannotatedPane(c) {
    var pane = el('div')
    backLink(c, pane)
    add(pane, commitMeta(c), el('h1', 'title', (c.glossed ? 'Unannotated changes' : 'Changes') + ' (' + c.unannotated.length + ')'))
    warnings(c, pane)
    add(pane, changesHead('Changes'), unannotatedBox(c))
    return pane
  }

  // Share of changed lines per necessity, and the groups of the commit.
  function necessityBar(c) {
    var total = c.groups.reduce(function (s, g) { return s + g.weight }, 0) || 1
    var bar = el('div', 'bar')
    var legend = el('div', 'legend')
    data.necessity.forEach(function (n) {
      var gs = c.groups.filter(function (g) { return g.necessity === n.name })
      if (!gs.length) return
      var weight = gs.reduce(function (s, g) { return s + g.weight }, 0)
      var seg = el('span')
      seg.style.setProperty('--c', 'var(--n-' + n.name + ')')
      seg.style.width = (100 * weight / total) + '%'
      seg.title = n.name + ': ' + Math.round(100 * weight / total) + '% of changed lines'
      bar.appendChild(seg)
      var item = el('span', null, n.name + ' ' + gs.length)
      item.title = n.help
      var dot = el('span', 'dot')
      dot.style.setProperty('--c', 'var(--n-' + n.name + ')')
      item.insertBefore(dot, item.firstChild)
      legend.appendChild(item)
    })
    return [bar, legend]
  }

  // The groups the author says to read first, as links; nothing when none are declared.
  function focusSection(c, ci, pane) {
    var focus = c.attention && c.attention.focus ? c.attention.focus : []
    var groups = focus.map(function (id) { return groupOf(c, id) }).filter(Boolean)
    if (!groups.length) return
    var list = el('div', 'focuscards')
    groups.forEach(function (g) {
      var b = button('focuscard', null, function () { selectGroup(ci, g.id) })
      var level = effImpact(g)
      var imp = add(el('span', 'imp'), meter(level), text(impactWord(g)))
      if (level) imp.style.setProperty('--m', 'var(--impact-' + level + ')')
      add(b, el('span', 'fctitle', g.intent), add(el('span', 'fcmeta'), imp, el('span', 'chip', g.necessity)))
      if (g.impact_reason) add(b, el('span', 'fcreason', g.impact_reason))
      list.appendChild(b)
    })
    add(pane, el('h2', null, 'Look here first'), list)
  }

  function overviewPane(c) {
    var ci = commits.indexOf(c)
    var pane = el('div')
    if (multi) add(pane, el('div', 'eyebrow', 'Commit ' + (ci + 1) + ' of ' + commits.length + ' · ' + new Date(c.date).toLocaleDateString()))
    add(pane, el('h1', 'title', c.subject), commitMeta(c))
    if (!c.glossed) {
      var w = add(el('section', 'warnbox'), el('div', 't', c.glossRefused ? 'Gloss refused on this commit' : 'No gloss on this commit'),
        c.glossRefused ? el('p', null, 'The gloss on this commit was refused: ' + c.glossRefused) : null,
        el('p', null, 'Its whole diff is unannotated, so there is no attention level, no groups and no reasons to read.'),
        el('p', 'cmd', 'git gloss add ' + sha7(c) + (c.glossRefused ? ' --force' : '')))
      add(pane, w)
      add(pane, changesHead('Changes (' + c.unannotated.length + ')'), unannotatedBox(c))
      return pane
    }
    warnings(c, pane)
    statement(pane, 'Task', c.task)
    statement(pane, 'Summary', c.summary)
    add(pane, attentionCard(c))
    focusSection(c, ci, pane)
    if (c.groups.length) {
      var nb = necessityBar(c)
      add(pane, el('h2', null, plural(c.groups.length, 'group')), nb[0], nb[1])
      if (multi) groupList(ci, pane, true)
      else {
        var chips = el('div', 'chips')
        orderedGroups(c).forEach(function (g) {
          var b = button('chip link', null, function () { selectGroup(ci, g.id) })
          add(b, el('b', null, g.id), text(' '), el('span', null, g.necessity))
          chips.appendChild(b)
        })
        add(pane, chips)
      }
    }
    if (multi) {
      var rr = risksRow(ci)
      if (rr) add(pane, el('h2', null, 'Risks and alternatives'), rr)
      add(pane, el('h2', null, 'Reviews'), reviewStatus(c))
    }
    return pane
  }

  function renderPane(scroll) {
    var c = commits[state.ci]
    var g = state.kind === 'group' ? groupOf(c, state.gid) : null
    var pane = state.kind === 'reviews' ? reviewsPane(c, state.stage) : state.kind === 'risks' ? risksPane(c) : g ? groupPane(c, g) : state.kind === 'unannotated' && c.unannotated.length ? unannotatedPane(c) : overviewPane(c)
    keepFocus(function () {
      mainEl.textContent = ''
      add(mainEl, pane)
      add(mainEl, footer())
      syncFold()
    }, true)
    if (scroll && !booting) {
      if (window.matchMedia && window.matchMedia('(min-width: 900px)').matches) window.scrollTo(0, 0)
      else mainEl.scrollIntoView({ block: 'start' })
    }
  }

  function footer() {
    var foot = el('footer')
    add(foot, text('Keys: '), el('kbd', null, 'j'), text(' / '), el('kbd', null, 'k'),
      text(multi ? ' next / previous group · ' : ' next / previous group (the overview comes before the first group) · '), el('kbd', null, 'o'), text(' fold or unfold the focused hunk (else the first) · '),
      el('kbd', null, 'e'), text(' expand all hunks · '), el('kbd', null, 'c'), text(' collapse all hunks · '),
      el('kbd', null, 'r'), text(' mark group read or unread.'))
    add(foot, el('p', null, 'A snapshot generated by git-gloss ' + new Date(data.generated).toLocaleString() +
      '. It does not update if the gloss or commit changes; regenerate with git gloss html ' +
      (data.range || commits[0].sha.slice(0, 10)) + '.'))
    return foot
  }

  // ---- the top bar ----
  function filterSeg(c) {
    var seg = el('div', 'seg')
    seg.setAttribute('role', 'group')
    seg.setAttribute('aria-label', 'Show groups')
    FILTERS.forEach(function (f) {
      var n = c.groups.filter(function (g) { return passes[f[0]](g, c) }).length
      var b = add(button(null, f[1]), el('span', 'n', n))
      b.setAttribute('aria-pressed', String(state.filter === f[0]))
      b.setAttribute('data-fid', 'seg:' + f[0])
      b.addEventListener('click', function () { state.filter = f[0]; renderChrome() })
      seg.appendChild(b)
    })
    return seg
  }
  function renderTop() {
    var c = commits[state.ci]
    topEl.textContent = ''
    add(topEl, el('span', 'brand', 'git gloss'), aryEl)
    if (multi) {
      var glossed = commits.filter(function (x) { return x.glossed }).length
      var vetted = commits.filter(function (x) {
        return x.glossed && x.reviews.some(function (r) { return r.stage === 'honesty' && r.state === 'seen' })
      }).length
      add(topEl, el('span', 'sha', data.range || 'commits'),
        el('span', 'subject', plural(commits.length, 'commit') + ', ' + glossed + ' glossed' + (glossed ? ', ' + vetted + ' honesty-reviewed' : '')))
      var order = el('div', 'seg')
      order.setAttribute('role', 'group')
      order.setAttribute('aria-label', 'Order commits')
      ;[[true, 'Hottest first'], [false, 'History order']].forEach(function (o) {
        var b = button(null, o[1], function () { state.hot = o[0]; renderChrome() })
        b.setAttribute('aria-pressed', String(state.hot === o[0]))
        b.setAttribute('data-fid', 'order:' + o[1])
        order.appendChild(b)
      })
      add(topEl, order)
    } else {
      var subject = el('span', 'subject', c.subject)
      subject.title = c.subject
      add(topEl, el('span', 'sha', c.sha.slice(0, 7)), subject)
    }
    var counts = readCounts()
    var fill = el('i')
    fill.style.width = (counts.total ? Math.round(100 * counts.read / counts.total) : 0) + '%'
    var prog = add(el('div', 'prog'), el('span', null, counts.read + ' of ' + counts.total + ' read'), add(el('span', 'track'), fill))
    prog.setAttribute('aria-live', 'polite')
    if (!multi) add(topEl, filterSeg(c))
    add(topEl, prog)
  }

  // ---- the rail ----
  function groupRow(ci, g) {
    var c = commits[ci]
    var k = key(c, g.id)
    var sel = state.ci === ci && state.kind === 'group' && state.gid === g.id
    var done = !!readSet(c)[g.id]
    var row = el('div', 'row' + (sel ? ' sel' : '') + (done ? ' done' : ''))
    var chk = button('check', null, function () { setRead(c, g.id, !readSet(c)[g.id]); renderChrome() })
    chk.setAttribute('aria-pressed', String(done))
    chk.setAttribute('aria-label', (done ? 'Mark unread: ' : 'Mark read: ') + g.id)
    chk.setAttribute('data-fid', 'chk:' + k)
    add(chk, el('span', null, done ? '✓' : ''))
    var pick = button('pick', null, function () { selectGroup(ci, g.id) })
    if (sel) pick.setAttribute('aria-current', 'true')
    pick.setAttribute('data-fid', 'pick:' + k)
    var sub = add(el('span', 'rsub'), el('span', 'mono', g.id), text(' · ' + g.necessity + ' · ' + impactWord(g)))
    add(pick, meter(effImpact(g)), add(el('span', 'rtxt'), el('span', 'rtitle', g.intent), sub))
    if (isFocus(c, g)) {
      var flag = el('span', 'flag', 'first')
      var lv = levelOf(c).level
      if (lv) flag.style.setProperty('--lv', 'var(--attention-' + lv + ')')
      add(pick, flag)
    }
    return add(row, chk, pick)
  }
  function extraRow(ci, kind, label, sub) {
    var sel = state.ci === ci && state.kind === kind
    var row = el('div', sel ? 'row sel' : 'row')
    var pick = button('pick', null, function () { selectKind(ci, kind) })
    if (sel) pick.setAttribute('aria-current', 'true')
    pick.setAttribute('data-fid', 'extra:' + kind + ':' + ci)
    add(pick, add(el('span', 'rtxt'), el('span', 'rtitle', label), el('span', 'rsub', sub)))
    return add(row, pick)
  }

  // The group list of one commit: necessity filter chips, then the rows.
  function groupList(ci, parent, withSeg) {
    var c = commits[ci]
    if (withSeg) add(parent, add(el('div', 'filters'), filterSeg(c)))
    var present = data.necessity.filter(function (n) { return c.groups.some(function (g) { return g.necessity === n.name }) })
    if (present.length > 1 || present.some(function (n) { return state.hidden.has(n.name) })) {
      var necs = el('div', 'necs')
      necs.setAttribute('role', 'group')
      necs.setAttribute('aria-label', 'Show necessity')
      present.forEach(function (n) {
        var count = c.groups.filter(function (g) { return g.necessity === n.name }).length
        var chip = add(button('chip', null, function () {
          if (state.hidden.has(n.name)) state.hidden.delete(n.name); else state.hidden.add(n.name)
          renderChrome()
        }), el('span', null, n.name), el('span', 'count', count))
        chip.title = n.help + ' (click to show or hide)'
        chip.setAttribute('aria-pressed', String(!state.hidden.has(n.name)))
        chip.setAttribute('data-fid', 'nec:' + n.name)
        necs.appendChild(chip)
      })
      add(parent, necs)
    }
    var rows = el('div', 'rows')
    var vis = visibleGroups(c)
    vis.forEach(function (g) { rows.appendChild(groupRow(ci, g)) })
    if (!vis.length && c.groups.length) {
      var none = el('div', 'emptyrows', 'No groups match this filter. ')
      add(none, button('btn small', 'Show all', function () { resetFilters(); renderChrome() }))
      add(parent, none)
    }
    if (c.unannotated.length && c.glossed) rows.appendChild(extraRow(ci, 'unannotated', 'Unannotated changes (' + c.unannotated.length + ')', 'in the commit, explained by no group'))
    add(parent, rows)
  }

  function commitRow(ci) {
    var c = commits[ci]
    var lv = levelOf(c)
    var sel = state.ci === ci
    var wrap = el('div', sel ? 'crow sel' : 'crow')
    var pick = button('pick', null, function () { selectKind(ci, 'overview') })
    if (sel) pick.setAttribute('aria-current', 'true')
    pick.setAttribute('data-fid', 'commit:' + c.sha)
    var level = el('span', 'lv')
    if (lv.level) {
      level.style.setProperty('--lv', 'var(--attention-' + lv.level + ')')
      add(level, gauge(lv.level, true), el('span', null, lv.level.toUpperCase()))
    } else add(level, el('span', null, c.glossed ? 'UNRATED' : 'NO GLOSS'))
    var meta
    if (c.glossed) {
      var rs = readSet(c)
      var done = c.groups.filter(function (g) { return rs[g.id] }).length
      meta = plural(c.groups.length, 'group') + ' · ' + plural(fileCount(c), 'file') + (lv.source === 'unrated' ? '' : ' · ' + lv.source) + ' · ' + done + '/' + c.groups.length + ' read'
    } else {
      var added = 0, removed = 0
      c.unannotated.forEach(function (h) { added += h.added; removed += h.removed })
      meta = plural(fileCount(c), 'file') + ' · +' + added + ' −' + removed
    }
    var metaEl = el('span', 'cmeta', meta)
    if (c.glossed) {
      if (c.warnings.length) add(metaEl, text(' · '), el('span', 'stale', 'stale gloss'))
      var hl = honestyLabel(c)
      add(metaEl, text(' · '), el('span', hl[0], hl[1]))
    } else add(metaEl, text(' · '), el('span', 'stale', 'no gloss'))
    if (c.openFindings) add(metaEl, text(' · '), el('span', 'stale', plural(c.openFindings, 'open finding')))
    add(pick, add(el('span', 'rtop'), el('span', 'sha', sha7(c)), el('span', 'sha', new Date(c.date).toLocaleDateString()), level),
      el('span', 'csubject', c.subject), metaEl)
    add(wrap, pick)
    return wrap
  }

  function railSummary() {
    var counts = {}
    var strip = el('div', 'strip')
    strip.setAttribute('aria-hidden', 'true')
    var order = commitOrder()
    order.forEach(function (ci) {
      var lv = levelOf(commits[ci])
      var name = lv.level || (commits[ci].glossed ? 'unrated' : 'no gloss')
      counts[name] = (counts[name] || 0) + 1
      var seg = el('i', lv.level ? null : 'none')
      if (lv.level) seg.style.setProperty('--lv', 'var(--attention-' + lv.level + ')')
      strip.appendChild(seg)
    })
    var line = el('div', 'line')
    var first = true
    LEVELS.slice().reverse().concat(['unrated', 'no gloss']).forEach(function (name) {
      if (!counts[name]) return
      if (!first) line.appendChild(text(' · '))
      first = false
      add(line, el('b', null, counts[name]), text(' ' + (name === 'no gloss' ? 'without a gloss' : name)))
    })
    var box = add(el('div', 'sum'), el('div', 'eyebrow', 'Range at a glance'), strip, line)
    var top = commits[order[0]]
    if (top && levelOf(top).level) {
      var link = el('a', null, sha7(top) + ' ' + top.subject)
      link.href = '#c-' + sha7(top)
      link.addEventListener('click', function (ev) { ev.preventDefault(); selectKind(order[0], 'overview') })
      add(box, add(el('div', 'line'), text(state.hot ? 'Read first: ' : 'Hottest: '), link))
    }
    return box
  }

  // The box above a range's commit list. Matching is plain text (lower-cased `includes` on the
  // short sha, subject and author), never a pattern or markup. The one input is kept across
  // re-renders so what was typed stays; it is not saved anywhere, so a reload clears it.
  var railRows = []
  var filterBox = null
  var noMatch = el('div', 'emptyrows', 'No commits match.')
  function commitHidden(ci) {
    return railRows.some(function (r) { return r.ci === ci && r.node.hidden })
  }
  function applyCommitFilter() {
    var q = filterBox.value.trim().toLowerCase()
    var shown = 0
    railRows.forEach(function (r) {
      var hit = !q || r.text.indexOf(q) >= 0
      r.node.hidden = !hit
      if (hit) shown++
    })
    noMatch.hidden = !q || !!shown
  }
  function commitFilter() {
    if (!filterBox) {
      filterBox = el('input')
      filterBox.type = 'search'
      filterBox.spellcheck = false
      filterBox.placeholder = 'Filter commits'
      filterBox.setAttribute('aria-label', 'Filter commits by message, author or sha')
      filterBox.addEventListener('input', applyCommitFilter)
    }
    return add(el('div', 'cfilter'), filterBox, noMatch)
  }

  function renderRail() {
    railEl.textContent = ''
    if (multi) {
      add(railEl, railSummary(), add(el('div', 'railhead'), el('div', 'eyebrow', state.hot ? 'Hottest first, then newest' : 'Newest first')))
      var list = el('div', 'commits')
      railRows = []
      commitOrder().forEach(function (ci) {
        var row = commitRow(ci)
        var c = commits[ci]
        railRows.push({ ci: ci, node: row, text: (sha7(c) + ' ' + c.subject + ' ' + c.author).toLowerCase() })
        list.appendChild(row)
      })
      add(railEl, commitFilter(), list)
      applyCommitFilter()
      if (data.merges.length) {
        var ml = add(el('div', 'mergelist'), el('div', 'eyebrow', 'Merges, not reviewed'))
        data.merges.forEach(function (m) { ml.appendChild(add(el('div'), el('span', 'mono', m.sha.slice(0, 7)), text(' ' + m.subject))) })
        add(railEl, ml)
      }
      return
    }
    var c = commits[0]
    var ov = el('div', 'overviewrow')
    var ovRow = extraRow(0, 'overview', 'Overview', 'task, summary, where to start')
    var lvl = levelOf(c).level
    if (lvl) {
      var chip = add(el('span', 'lv'), gauge(lvl, true), el('span', null, lvl.toUpperCase()))
      chip.style.setProperty('--lv', 'var(--attention-' + lvl + ')')
      chip.title = 'Attention: ' + lvl + (c.attention ? ' (declared)' : ' (derived)')
      ovRow.querySelector('.pick').appendChild(chip)
    }
    add(ov, ovRow)
    add(railEl, ov)
    add(railEl, add(el('div', 'railhead'), el('div', 'eyebrow', 'Review order · look first, then by impact')))
    groupList(0, railEl)
    var rr = risksRow(0)
    if (rr) add(railEl, add(el('div', 'railsec'), el('div', 'eyebrow', 'Risks and alternatives'), rr))
    add(railEl, add(el('div', 'railfoot'), el('div', 'eyebrow', 'Reviews'), reviewStatus(c)))
  }

  // Run a re-render and give keyboard focus back to the control that had it:
  // the one with the same data-fid, or if that is gone or disabled (Next on the
  // last group) the enabled button that is left in the same bar.
  function keepFocus(render, pane) {
    var active = document.activeElement
    var fid = active && active.getAttribute ? active.getAttribute('data-fid') : null
    var inPane = !!(pane && active && active !== document.body && mainEl.contains(active))
    render()
    var target = null
    if (fid) {
      target = app.querySelector('[data-fid="' + CSS.escape(fid) + '"]')
      if (!target || target.disabled) {
        var bar = fid.indexOf('nav:') === 0 ? '.nav' : fid.indexOf('code:') === 0 ? '.chead' : null
        target = bar ? mainEl.querySelector(bar + ' button:not(:disabled)') : null
      }
    }
    // A link or card in the pane that opened another pane: focus moves to the new pane's heading.
    if (!target && inPane) {
      target = mainEl.querySelector('h1')
      if (target) target.setAttribute('tabindex', '-1')
    }
    if (target) target.focus({ preventScroll: true })
  }

  // Re-render the rail and top bar (and what depends on the filters in the
  // pane), keeping keyboard focus on the same control.
  function renderChrome() {
    keepFocus(function () {
      renderTop()
      renderRail()
      if (multi && state.kind === 'overview') renderPane(false)
      else refreshNav()
    })
  }

  // ---- selection, kept in the hash so links and reloads land on it ----
  function hashFor() {
    var c = commits[state.ci]
    if (state.kind === 'group') return '#g-' + key(c, state.gid)
    if (state.kind === 'reviews') return '#reviews' + (multi ? '-' + sha7(c) : '') + (state.stage ? '-' + encodeURIComponent(state.stage) : '')
    if (state.kind === 'risks') return '#risks' + (multi ? '-' + sha7(c) : '')
    if (state.kind === 'unannotated') return '#unannotated' + (multi ? '-' + sha7(c) : '')
    return multi ? '#c-' + sha7(c) : '#overview'
  }
  function remember() {
    try { history.replaceState(null, '', hashFor()) } catch (e) { /* not allowed in this context */ }
  }
  function show(scroll) {
    remember()
    renderChrome()
    renderPane(scroll)
  }
  function selectKind(ci, kind) {
    state.ci = ci
    state.kind = kind
    state.gid = null
    show(true)
  }
  function selectGroup(ci, gid) {
    var c = commits[ci]
    var g = groupOf(c, gid)
    if (!g) return
    // Following a link to a group the filters hide turns them off.
    if (visibleGroups(c).indexOf(g) < 0) resetFilters()
    state.ci = ci
    state.kind = 'group'
    state.gid = gid
    show(true)
  }
  function applyHash() {
    var h
    try { h = decodeURIComponent(location.hash.slice(1)) } catch (e) { return false }
    var i, j, c
    if (h.indexOf('g-') === 0) {
      for (i = 0; i < commits.length; i++) {
        for (j = 0; j < commits[i].groups.length; j++) {
          if (key(commits[i], commits[i].groups[j].id) === h.slice(2)) { selectGroup(i, commits[i].groups[j].id); return true }
        }
      }
    } else if (h === 'overview') { selectKind(0, 'overview'); return true }
    else if (h === 'risks' && !multi) { selectRisks(0); return true }
    else if (h.indexOf('risks-') === 0 && multi) {
      for (i = 0; i < commits.length; i++) if (sha7(commits[i]) === h.slice(6)) { selectRisks(i); return true }
    }
    else if (h.indexOf('c-') === 0 || h.indexOf('unannotated-') === 0 || h === 'unannotated') {
      var sha = h.slice(h.indexOf('-') + 1)
      for (i = 0; i < commits.length; i++) {
        c = commits[i]
        if ((h === 'unannotated' && i === 0) || (h !== 'unannotated' && sha7(c) === sha)) {
          selectKind(i, h.indexOf('c-') === 0 ? 'overview' : 'unannotated')
          return true
        }
      }
    } else if (h === 'reviews' || h.indexOf('reviews-') === 0) {
      var rest = h.slice(8)
      if (!multi) { selectReviews(0, rest || null); return true }
      for (i = 0; i < commits.length; i++) {
        if (sha7(commits[i]) === rest.slice(0, 7)) { selectReviews(i, rest.slice(8) || null); return true }
      }
    }
    return false
  }

  // ---- actions ----
  function currentGroup() {
    return state.kind === 'group' ? groupOf(commits[state.ci], state.gid) : null
  }
  function markRead(on) {
    var g = currentGroup()
    if (!g) return
    setRead(commits[state.ci], g.id, on)
    renderChrome()
  }

  document.addEventListener('keydown', function (ev) {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return
    var t = ev.target
    if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return
    if (ev.key === 'j') stepTo(1)
    else if (ev.key === 'k') stepTo(-1)
    else if (ev.key === 'o') {
      var f = document.activeElement
      var w = f && f.closest ? f.closest('.hunk') : null
      var tg = (w && w.querySelector('.htoggle')) || mainEl.querySelector('.htoggle')
      if (tg) { setHunkOpen(tg.closest('.hunk'), tg.getAttribute('aria-expanded') !== 'true'); syncFold() }
    }
    else if (ev.key === 'e') setCode(true)
    else if (ev.key === 'c') setCode(false)
    else if (ev.key === 'r') {
      var g = currentGroup()
      if (g) markRead(!readSet(commits[state.ci])[g.id])
    }
  })
  window.addEventListener('hashchange', function () { applyHash() })

  // ---- start ----
  var desk = add(el('div', 'desk'), topEl, body)
  // The rail sticks below the top bar, whose height varies (the pickers wrap).
  function measureTop() { desk.style.setProperty('--top-h', topEl.offsetHeight + 'px') }
  app.textContent = ''
  app.appendChild(desk)
  measureTop()
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(measureTop).observe(topEl)
  if (multi) {
    var first = commitOrder()[0]
    state.ci = first
    state.kind = 'overview'
  }
  if (!applyHash()) { renderChrome(); renderPane(false); remember() }
  booting = false
})()
