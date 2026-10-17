// Renders the gloss page from the embedded JSON. All text goes through
// textContent; nothing from the data is ever parsed as HTML.
(function () {
  'use strict'
  var data = JSON.parse(document.getElementById('gloss-data').textContent)
  var app = document.getElementById('app')
  var hidden = new Set() // necessity values filtered out

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
  function color(e, necessity) {
    e.style.setProperty('--c', 'var(--n-' + necessity + ')')
    return e
  }
  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's') }
  function stats(added, removed) {
    return add(el('span', 'stats'), el('span', 'plus', '+' + added), document.createTextNode(' '), el('span', 'minus', '−' + removed))
  }
  function groupLink(id) {
    var a = el('a', null, id)
    a.href = '#g-' + id
    a.addEventListener('click', function (ev) { ev.preventDefault(); focusGroup(id, true) })
    return a
  }

  // ---- diff rendering ----
  function hunkView(h) {
    var head = add(el('div', 'hunk-head'),
      el('span', 'range', h.ref),
      el('span', 'file', h.oldFile ? h.oldFile + ' → ' + h.file : h.file),
      el('span', 'range', h.range),
      stats(h.added, h.removed))
    if (h.status === 'changed') add(head, el('span', 'stale', 'changed since glossed'))
    if (h.status === 'missing') {
      add(head, el('span', 'stale', 'no longer in this commit'))
      return add(el('div', 'hunk'), head)
    }
    if (h.alsoIn.length) {
      var also = add(el('span', 'also'), document.createTextNode('shares lines with '))
      h.alsoIn.forEach(function (id, i) { if (i) also.appendChild(document.createTextNode(', ')); also.appendChild(groupLink(id)) })
      add(head, also)
    }
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
    return add(el('div', 'hunk'), head, add(el('div', 'scroll'), table))
  }

  // ---- group cards ----
  var cards = []
  function groupCard(g) {
    var card = color(el('article', 'group'), g.necessity)
    card.id = 'g-' + g.id
    card.tabIndex = -1
    card.dataset.necessity = g.necessity

    var title = add(el('div', 'group-title'),
      el('span', 'badge', g.necessity),
      el('span', 'intent', g.intent),
      el('span', 'gid', g.id))
    if (g.stale) add(title, el('span', 'stale', g.stale + ' of ' + plural(g.total, 'hunk') + ' changed or gone'))
    add(title, stats(g.added, g.removed))

    var facts = el('dl', 'facts')
    function fact(label, value) {
      if (!value) return
      add(facts, el('dt', null, label), typeof value === 'string' ? el('dd', null, value) : add(el('dd'), value))
    }
    if (g.serves !== 'task') fact('serves', groupLink(g.serves))
    fact('if removed', g.removal_impact)
    fact('evidence', g.evidence)
    fact('notes', g.notes)

    add(card, add(el('div', 'group-head'), title), facts)

    if (g.hunks.length) {
      var code = el('div', 'code')
      code.hidden = true
      var toggle = el('button', 'code-toggle')
      toggle.type = 'button'
      var rendered = false
      function setOpen(open) {
        if (open && !rendered) { g.hunks.forEach(function (h) { code.appendChild(hunkView(h)) }); rendered = true }
        code.hidden = !open
        toggle.textContent = (open ? '▾ Hide code' : '▸ Show code') + ' · ' + plural(g.hunks.length, 'hunk')
        toggle.setAttribute('aria-expanded', String(open))
      }
      toggle.addEventListener('click', function () { setOpen(code.hidden) })
      setOpen(false)
      card.setOpen = setOpen
      card.isOpen = function () { return !code.hidden }
      add(card, toggle, code)
    }
    cards.push(card)
    return card
  }

  // ---- page ----
  function render() {
    var layout = el('div', 'layout')
    var toc = el('nav', 'toc')
    var main = el('main')
    add(layout, toc, main)

    // Header
    var commit = add(el('div', 'commit'), el('span', 'sha', data.sha.slice(0, 10)),
      el('span', null, data.author), el('span', null, new Date(data.date).toLocaleString()))
    add(main, commit, el('h1', null, data.subject))
    function statement(label, text) {
      if (text) add(main, add(el('p', 'statement'), el('span', 'label', label), document.createTextNode(text)))
    }
    statement('Task', data.task)
    statement('Summary', data.summary)
    data.warnings.forEach(function (w) { add(main, el('div', 'warning', '⚠ ' + w)) })

    // Necessity overview: bar weighted by lines changed, chips filter groups.
    var present = data.necessity.filter(function (n) { return data.groups.some(function (g) { return g.necessity === n.name }) })
    var total = data.groups.reduce(function (s, g) { return s + g.weight }, 0) || 1
    var bar = el('div', 'bar')
    var chips = el('div', 'chips')
    present.forEach(function (n) {
      var groups = data.groups.filter(function (g) { return g.necessity === n.name })
      var weight = groups.reduce(function (s, g) { return s + g.weight }, 0)
      var seg = color(el('span'), n.name)
      seg.style.width = (100 * weight / total) + '%'
      seg.title = n.name + ': ' + Math.round(100 * weight / total) + '% of changed lines'
      bar.appendChild(seg)

      var chip = color(el('button', 'chip'), n.name)
      chip.type = 'button'
      chip.title = n.help + ' (click to show or hide)'
      chip.setAttribute('aria-pressed', 'true')
      add(chip, el('span', 'dot'), el('span', null, n.name), el('span', 'count', groups.length))
      chip.dataset.necessity = n.name
      chip.addEventListener('click', function () {
        if (hidden.has(n.name)) hidden.delete(n.name); else hidden.add(n.name)
        chip.setAttribute('aria-pressed', String(!hidden.has(n.name)))
        applyFilter()
      })
      chips.appendChild(chip)
    })
    add(main, add(el('section', 'overview'), bar, chips,
      el('div', 'note', 'Bar shows each category’s share of changed lines. Click a category to hide or show its groups.')))

    // Toolbar
    var shown = el('span', 'shown')
    var expand = el('button', 'btn', 'Expand all code')
    var collapse = el('button', 'btn', 'Collapse all')
    expand.type = collapse.type = 'button'
    expand.addEventListener('click', function () { setAll(true) })
    collapse.addEventListener('click', function () { setAll(false) })
    add(main, add(el('div', 'toolbar'), shown, add(el('span'), expand, document.createTextNode(' '), collapse)))

    // Groups + sidebar
    var tocList = el('ol')
    add(toc, el('h2', null, 'Groups'), tocList)
    var groupsEl = el('section', 'groups')
    data.groups.forEach(function (g) {
      groupsEl.appendChild(groupCard(g))
      var li = el('li')
      li.dataset.necessity = g.necessity
      li.dataset.id = g.id
      var a = add(el('a'), color(el('span', 'dot'), g.necessity), el('span', null, g.id))
      a.href = '#g-' + g.id
      a.title = g.intent
      a.addEventListener('click', function (ev) { ev.preventDefault(); focusGroup(g.id, false) })
      tocList.appendChild(add(li, a))
    })
    add(main, groupsEl)

    if (data.unannotated.length) {
      var un = add(el('section', 'section'), el('h2', null, 'Unannotated changes (' + data.unannotated.length + ')'))
      var box = add(el('div', 'unannotated'), el('p', null, 'These changes are in the commit but no group explains them.'))
      data.unannotated.forEach(function (h) { box.appendChild(hunkView(h)) })
      un.id = 'unannotated'
      add(main, add(un, box))
      var ua = el('a', null, 'unannotated')
      ua.href = '#unannotated'
      add(toc, el('h2', null, 'Other'), add(el('ol'), add(el('li'), ua)))
    }
    if (data.risks.length) {
      var rl = el('ul', 'list')
      data.risks.forEach(function (r) { rl.appendChild(el('li', null, r)) })
      add(main, add(el('section', 'section'), el('h2', null, 'Risks'), rl))
    }
    if (data.alternatives.length) {
      var al = el('ul', 'list')
      data.alternatives.forEach(function (x) {
        al.appendChild(add(el('li'), el('strong', null, x.option), el('span', 'why', ' — ' + x.rejected_because)))
      })
      add(main, add(el('section', 'section'), el('h2', null, 'Alternatives considered'), al))
    }

    var foot = el('footer')
    add(foot, document.createTextNode('Keys: '), el('kbd', null, 'j'), document.createTextNode(' / '), el('kbd', null, 'k'),
      document.createTextNode(' next / previous group · '), el('kbd', null, 'o'), document.createTextNode(' show or hide code · '),
      el('kbd', null, 'e'), document.createTextNode(' expand all · '), el('kbd', null, 'c'),
      document.createTextNode(' collapse all.'))
    add(foot, el('p', null, 'A snapshot generated by git-gloss ' + new Date(data.generated).toLocaleString() +
      '. It does not update if the gloss or commit changes; regenerate with git gloss html ' + data.sha.slice(0, 10) + '.'))
    add(main, foot)

    app.textContent = ''
    app.appendChild(layout)

    function applyFilter() {
      var visible = 0
      cards.forEach(function (c) {
        var off = hidden.has(c.dataset.necessity)
        c.classList.toggle('hidden', off)
        if (!off) visible++
      })
      tocList.querySelectorAll('li').forEach(function (li) { li.classList.toggle('hidden', hidden.has(li.dataset.necessity)) })
      shown.textContent = visible === cards.length
        ? plural(cards.length, 'group')
        : 'Showing ' + visible + ' of ' + plural(cards.length, 'group')
    }
    applyFilter()
    showNecessity = function (n) {
      hidden.delete(n)
      chips.querySelectorAll('.chip').forEach(function (c) { if (c.dataset.necessity === n) c.setAttribute('aria-pressed', 'true') })
      applyFilter()
    }
  }
  var showNecessity = function () {}

  function setAll(open) {
    cards.forEach(function (c) { if (c.setOpen && !c.classList.contains('hidden')) c.setOpen(open) })
  }

  var current = -1
  function focusGroup(id, openCode, instant) {
    var i = cards.findIndex(function (c) { return c.id === 'g-' + id })
    if (i < 0) return
    var card = cards[i]
    // Following a link to a filtered-out group turns its category back on.
    if (card.classList.contains('hidden')) showNecessity(card.dataset.necessity)
    cards.forEach(function (c) { c.classList.remove('focused') })
    card.classList.add('focused')
    current = i
    if (openCode && card.setOpen) card.setOpen(true)
    card.scrollIntoView({ block: 'start', behavior: instant ? 'auto' : 'smooth' })
    document.querySelectorAll('.toc li').forEach(function (li) { li.classList.toggle('active', li.dataset.id === id) })
    history.replaceState(null, '', '#g-' + id)
  }
  function step(dir) {
    var visible = cards.filter(function (c) { return !c.classList.contains('hidden') })
    if (!visible.length) return
    var pos = visible.indexOf(cards[current])
    var next = visible[Math.min(visible.length - 1, Math.max(0, pos + dir))] || visible[0]
    focusGroup(next.id.slice(2), false)
  }

  document.addEventListener('keydown', function (ev) {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return
    var t = ev.target
    if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return
    if (ev.key === 'j') step(1)
    else if (ev.key === 'k') step(-1)
    else if (ev.key === 'o' && cards[current] && cards[current].setOpen) cards[current].setOpen(!cards[current].isOpen())
    else if (ev.key === 'e') setAll(true)
    else if (ev.key === 'c') setAll(false)
  })

  render()
  if (location.hash.indexOf('#g-') === 0) {
    try { focusGroup(decodeURIComponent(location.hash.slice(3)), true, true) } catch (e) { /* malformed hash */ }
  }
})()
