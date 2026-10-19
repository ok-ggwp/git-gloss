// The ary shell: pick a branch, a base to compare it with, and a commit (or the
// whole branch), and the chosen view loads in the frame. Text only goes
// through textContent; nothing from the repo is parsed as HTML.
(function () {
  'use strict'
  var app = document.getElementById('app')
  var PAGE = 100

  // What is selected. head/base choose which commits are listed; rev is what
  // the frame shows (a sha, "wip", a range, or anything typed in).
  var state = { head: null, base: null, rev: null, q: '' }
  var refs = null
  var log = { commits: [], more: false, total: null }
  var logError = null
  var parts = {}

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
  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's') }
  function api(path) {
    return fetch(path).then(function (r) {
      return r.json().then(function (body) {
        if (!r.ok) throw new Error(body.error || r.statusText)
        return body
      })
    })
  }

  // ---- location: the selection is kept in the hash, so reload and links work ----
  function saveHash() {
    var p = new URLSearchParams()
    if (state.rev) p.set('rev', state.rev)
    if (state.head) p.set('head', state.head)
    if (state.base) p.set('base', state.base)
    history.replaceState(null, '', '#' + p.toString())
  }
  function readHash() {
    var p = new URLSearchParams(location.hash.slice(1))
    return { rev: p.get('rev'), head: p.get('head'), base: p.get('base') }
  }

  // ---- sidebar ----
  // A branch picker with a search box: a repo can have hundreds of branches,
  // too many to scan in a <select>. Matching is case-insensitive and every
  // space-separated word must appear in the name.
  var SHOWN = 200
  function picker(onPick) {
    var root = el('div', 'combo')
    var button = el('button', 'combo-btn')
    button.type = 'button'
    button.setAttribute('aria-haspopup', 'listbox')
    var panel = el('div', 'combo-panel')
    panel.hidden = true
    var input = el('input')
    input.type = 'search'
    input.spellcheck = false
    input.placeholder = 'Search branches…'
    input.setAttribute('aria-label', 'Search branches')
    var list = el('div', 'combo-list')
    list.setAttribute('role', 'listbox')
    add(panel, input, list)
    add(root, button, panel)

    var groups = []
    var noneLabel = null
    var value = null
    var items = [] // the rows now shown: { value, node }
    var active = 0

    function matches(name, words) {
      var n = name.toLowerCase()
      return words.every(function (w) { return n.indexOf(w) >= 0 })
    }
    function paint() {
      items.forEach(function (it, i) { it.node.classList.toggle('active', i === active) })
      if (items[active]) items[active].node.scrollIntoView({ block: 'nearest' })
    }
    function render() {
      var words = input.value.toLowerCase().split(/\s+/).filter(Boolean)
      list.textContent = ''
      items = []
      var shown = 0
      var hidden = 0
      function item(label, v) {
        var node = el('button', 'combo-item', label)
        node.type = 'button'
        node.setAttribute('role', 'option')
        node.setAttribute('aria-selected', String(v === value))
        node.addEventListener('click', function () { pick(v) })
        items.push({ value: v, node: node })
        return node
      }
      if (noneLabel && !words.length) list.appendChild(item(noneLabel, null))
      groups.forEach(function (g) {
        var found = g.names.filter(function (n) { return matches(n, words) })
        var room = found.slice(0, Math.max(0, SHOWN - shown))
        hidden += found.length - room.length
        shown += room.length
        if (!room.length) return
        add(list, add(el('div', 'combo-group', g.label), el('span', 'count', found.length)))
        room.forEach(function (n) { list.appendChild(item(n, n)) })
      })
      if (hidden) add(list, el('div', 'combo-more', hidden + ' more: keep typing to narrow the list'))
      if (!items.length) add(list, el('div', 'combo-more', 'No branches match.'))
      // Start on the current value, or on the first match when searching.
      var at = words.length ? -1 : items.findIndex(function (it) { return it.value === value })
      active = at >= 0 ? at : 0
      paint()
    }
    function open() {
      panel.hidden = false
      button.setAttribute('aria-expanded', 'true')
      input.value = ''
      render()
      input.focus()
    }
    function close() {
      panel.hidden = true
      button.setAttribute('aria-expanded', 'false')
    }
    function pick(v) {
      close()
      button.focus()
      if (v !== value) onPick(v)
    }
    button.addEventListener('click', function () { if (panel.hidden) open(); else close() })
    input.addEventListener('input', render)
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault()
        if (items.length) active = (active + (ev.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length
        paint()
      } else if (ev.key === 'Enter') {
        ev.preventDefault()
        if (items[active]) pick(items[active].value)
      } else if (ev.key === 'Escape') {
        ev.preventDefault()
        close()
        button.focus()
      }
    })
    document.addEventListener('mousedown', function (ev) { if (!panel.hidden && !root.contains(ev.target)) close() })

    return {
      root: root,
      // Local and remote branches, and what choosing "no branch" is called (if allowed).
      setOptions: function (g, none) { groups = g; noneLabel = none },
      setValue: function (v) {
        value = v
        button.textContent = v || noneLabel || 'choose a branch'
        button.title = button.textContent
      },
    }
  }

  function branchGroups() {
    return [
      { label: 'Local branches', names: refs.branches.map(function (b) { return b.name }) },
      { label: 'Remote branches', names: refs.remotes.map(function (b) { return b.name }) },
    ]
  }

  // One entry in the list: the title gets the full width (two lines at most),
  // with the details and status marks on a line below it.
  function row(title, details, marks, current, onClick) {
    var b = el('button', 'row')
    b.type = 'button'
    b.setAttribute('aria-current', String(current))
    b.title = title
    add(b, el('div', 'subject', title))
    var meta = el('div', 'meta')
    details.forEach(function (d) { meta.appendChild(d) })
    add(meta, add(el('span', 'marks'), marks[0], marks[1], marks[2]))
    add(b, meta)
    b.addEventListener('click', onClick)
    return b
  }
  function mark(kind, text, tip) {
    var m = el('span', 'mark ' + kind, text)
    if (tip) m.title = tip
    return m
  }
  function glossMark(glossed) {
    return glossed ? mark('glossed', '● glossed', 'This commit has a gloss') : mark('none', '○ no gloss', 'This commit has no gloss')
  }

  function renderList() {
    var list = parts.list
    list.textContent = ''
    if (refs.wip) {
      add(list, el('h2', null, 'Uncommitted work'))
      var w = refs.wip
      add(list, row('wip snapshot', [el('span', null, w.stale || 'the latest snapshot of your working tree')],
        [glossMark(w.glossed), w.stale ? mark('warn', 'stale', w.stale) : null], state.rev === 'wip', function () { select('wip') }))
    }
    add(list, el('h2', null, state.head ? 'Commits on ' + state.head : 'Commits'))
    if (logError) { add(list, el('p', 'error', logError)); return }
    // A search narrows the list to some commits, so it isn't the whole branch.
    if (state.base && state.head && log.commits.length && !state.q) {
      var range = state.base + '..' + state.head
      add(list, row('Whole branch', [el('span', null, range + ' · ' + plural(log.total === null ? log.commits.length : log.total, 'commit'))], [], state.rev === range, function () { select(range) }))
    }
    if (!log.commits.length) {
      add(list, el('p', 'empty', state.q ? 'No commits match “' + state.q + '”.' : state.base ? 'No commits beyond ' + state.base + '.' : 'No commits.'))
    }
    log.commits.forEach(function (c) {
      add(list, row(c.subject,
        [el('span', 'sha', c.sha.slice(0, 7)), el('span', null, ' · ' + c.author + ' · ' + new Date(c.date).toLocaleDateString())],
        c.merge ? [mark('none', 'merge')] : [glossMark(c.glossed), c.reviewed ? mark('reviewed', '✓ reviewed', 'This commit has a recorded review') : null],
        state.rev === c.sha, function () { select(c.sha) }))
    })
    if (log.more) {
      var more = el('button', 'btn more', 'Load more')
      more.type = 'button'
      more.addEventListener('click', function () { loadLog(true) })
      add(list, more)
    }
  }

  function renderSide() {
    parts.head.setOptions(branchGroups(), null)
    parts.head.setValue(state.head)
    parts.base.setOptions(branchGroups(), '(none: all of the branch’s history)')
    parts.base.setValue(state.base)
    parts.rev.value = state.rev && state.rev !== 'wip' ? state.rev : ''
    renderList()
  }

  // ---- viewer ----
  function renderViewer() {
    var v = parts.viewer
    v.textContent = ''
    if (!state.rev) {
      add(v, el('div', 'placeholder', 'Pick a commit, a whole branch, or type any revision or range.'))
      return
    }
    var src = '/view?rev=' + encodeURIComponent(state.rev)
    var open = el('a', null, 'open in a tab ↗')
    open.href = src
    open.target = '_blank'
    open.rel = 'noopener'
    var reload = el('button', 'btn', 'Reload')
    reload.type = 'button'
    var frame = el('iframe')
    frame.title = 'gloss of ' + state.rev
    frame.src = src
    // So the page's keys (j, k, o, e, c) work without clicking into it first.
    frame.addEventListener('load', function () { frame.contentWindow.focus() })
    reload.addEventListener('click', function () { frame.src = src })
    add(v, add(el('div', 'viewer-bar'), el('span', 'what', state.rev === 'wip' ? 'uncommitted work (wip)' : state.rev), reload, open), frame)
  }

  // ---- actions ----
  function select(rev) {
    state.rev = rev
    saveHash()
    renderList()
    parts.rev.value = rev === 'wip' ? '' : rev
    renderViewer()
  }

  function loadLog(append) {
    if (!state.head) { log = { commits: [], more: false, total: null }; renderList(); return Promise.resolve() }
    var q = new URLSearchParams({ head: state.head, limit: PAGE, skip: append ? log.commits.length : 0 })
    if (state.base) q.set('base', state.base)
    if (state.q) q.set('q', state.q)
    var asked = state.head + '..' + state.base + '?' + state.q
    return api('/api/log?' + q).then(function (data) {
      if (asked !== state.head + '..' + state.base + '?' + state.q) return // the selection moved on
      logError = null
      log = append ? { commits: log.commits.concat(data.commits), more: data.more, total: data.total } : data
      renderList()
    }).catch(function (err) {
      logError = err.message
      log = { commits: [], more: false, total: null }
      renderList()
    })
  }

  function pickHead(name) {
    state.head = name
    // A feature branch is most useful against the usual base; the base itself
    // is listed whole.
    state.base = name === refs.defaultBase ? null : refs.defaultBase
    saveHash()
    renderSide()
    loadLog(false)
  }

  function load() {
    return api('/api/refs').then(function (data) {
      parts.error.hidden = true
      refs = data
      var h = readHash()
      // A link or bookmark may name a branch that has since been deleted or
      // renamed: use the usual choice instead, and say so.
      var known = {}
      refs.branches.concat(refs.remotes).forEach(function (b) { known[b.name] = true })
      var head = h.head && known[h.head] ? h.head : null
      state.head = head || refs.current || refs.defaultBase || (refs.branches[0] && refs.branches[0].name) || null
      var notice = null
      if (h.head && !head) {
        // The default base goes with the default branch.
        state.base = state.head === refs.defaultBase ? null : refs.defaultBase
        notice = 'Branch “' + h.head + '” no longer exists; showing ' + (state.head || 'the default') + ' instead.'
      } else if (h.base && !known[h.base]) {
        state.base = null
        notice = 'The branch to compare with, “' + h.base + '”, no longer exists; showing all of ' + state.head + '’s history.'
      } else if (head) {
        state.base = h.base || null
      } else {
        state.base = state.head === refs.defaultBase ? null : refs.defaultBase
      }
      if (notice) {
        parts.error.textContent = notice
        parts.error.hidden = false
      }
      state.rev = h.rev || (refs.wip ? 'wip' : null)
      parts.title.textContent = refs.repo
      renderSide()
      renderViewer()
      return loadLog(false).then(function () {
        // With nothing chosen, show the whole branch, or its newest commit.
        if (!state.rev && state.head) select(state.base && log.commits.length ? state.base + '..' + state.head : log.commits.length ? log.commits[0].sha : null)
      })
    })
  }

  function build() {
    parts.title = el('span', 'repo')
    var refresh = el('button', 'btn', 'Refresh')
    refresh.type = 'button'
    refresh.title = 'Re-read branches and commits'
    refresh.addEventListener('click', function () { load().catch(fail) })

    parts.head = picker(pickHead)
    parts.base = picker(function (name) {
      state.base = name
      parts.base.setValue(name)
      saveHash()
      loadLog(false)
    })

    parts.rev = el('input')
    parts.rev.type = 'text'
    parts.rev.spellcheck = false
    parts.rev.placeholder = 'HEAD~3, abc123, main..feature'
    var go = el('button', 'btn', 'View')
    go.type = 'submit'
    var form = add(el('form', 'rev-row'), parts.rev, go)
    form.addEventListener('submit', function (ev) {
      ev.preventDefault()
      var v = parts.rev.value.trim()
      if (v) select(v)
    })

    parts.search = el('input')
    parts.search.type = 'search'
    parts.search.spellcheck = false
    parts.search.placeholder = 'Search commit messages and authors…'
    parts.search.setAttribute('aria-label', 'Search commits')
    var searching = null
    parts.search.addEventListener('input', function () {
      // Wait for a pause in typing: each search asks git.
      clearTimeout(searching)
      searching = setTimeout(function () {
        state.q = parts.search.value.trim()
        loadLog(false)
      }, 250)
    })

    parts.error = el('p', 'error')
    parts.error.hidden = true
    parts.list = el('div', 'list')
    parts.viewer = el('section', 'viewer')

    var top = add(el('div', 'side-top'),
      add(el('div', 'title'), el('strong', null, 'git gloss ary'), parts.title, refresh),
      parts.error,
      add(el('div', 'field'), el('span', null, 'Branch'), parts.head.root),
      add(el('div', 'field'), el('span', null, 'Compare with'), parts.base.root),
      add(el('label', 'field'), document.createTextNode('Any revision or range'), form))
    add(app, add(el('div', 'shell'), add(el('aside', 'side'), top, add(el('div', 'search-bar'), parts.search), parts.list), parts.viewer))
  }

  function fail(err) {
    parts.error.textContent = 'Could not read the repository: ' + err.message
    parts.error.hidden = false
  }

  build()
  load().catch(fail)
})()
