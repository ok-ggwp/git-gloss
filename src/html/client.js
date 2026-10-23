// Renders the gloss page from the embedded JSON. All text goes through
// textContent; nothing from the data is ever parsed as HTML.
(function () {
  'use strict'
  var data = JSON.parse(document.getElementById('gloss-data').textContent)
  var app = document.getElementById('app')
  var hidden = new Set() // necessity values filtered out
  var multi = data.commits.length > 1 || data.range !== null
  // Group ids are unique within a commit, not across a range, so a range page
  // keys cards by commit too: #g-<sha7>-<group>.
  function key(c, id) { return multi ? c.sha.slice(0, 7) + '-' + id : id }

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
  function levelBadge(kind, name) {
    var b = el('span', 'badge ' + kind, name)
    b.style.setProperty('--c', 'var(--' + kind + '-' + name + ')')
    return b
  }
  // A badge for a value derived from the diff rather than declared by the author.
  function derivedBadge(kind, name) {
    var b = levelBadge(kind, name)
    b.classList.add('derived')
    b.textContent = name + ' (derived)'
    b.title = 'Derived from the diff, not declared in the gloss'
    return b
  }
  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's') }
  function stats(added, removed) {
    return add(el('span', 'stats'), el('span', 'plus', '+' + added), document.createTextNode(' '), el('span', 'minus', '−' + removed))
  }
  function groupLink(c, id) {
    var a = el('a', null, id)
    a.href = '#g-' + key(c, id)
    a.addEventListener('click', function (ev) { ev.preventDefault(); focusGroup(key(c, id), true) })
    return a
  }

  // ---- diff rendering ----
  function hunkView(c, h) {
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
      h.alsoIn.forEach(function (id, i) { if (i) also.appendChild(document.createTextNode(', ')); also.appendChild(groupLink(c, id)) })
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
  function groupCard(c, g) {
    var card = color(el('article', 'group'), g.necessity)
    card.id = 'g-' + key(c, g.id)
    card.tabIndex = -1
    card.dataset.necessity = g.necessity

    var title = add(el('div', 'group-title'),
      el('span', 'badge', g.necessity),
      g.impact ? levelBadge('impact', g.impact) : g.impact_derived ? derivedBadge('impact', g.impact_derived) : null,
      el('span', 'intent', g.intent),
      el('span', 'gid', g.id))
    if (g.stale) add(title, el('span', 'stale', g.stale + ' of ' + plural(g.total, 'hunk') + ' changed or gone'))
    add(title, stats(g.added, g.removed))

    var facts = el('dl', 'facts')
    function fact(label, value) {
      if (!value) return
      add(facts, el('dt', null, label), typeof value === 'string' ? el('dd', null, value) : add(el('dd'), value))
    }
    if (g.serves[0] !== 'task') {
      var links = el('span')
      g.serves.forEach(function (id, i) { if (i) links.appendChild(document.createTextNode(', ')); links.appendChild(groupLink(c, id)) })
      fact('serves', links)
    }
    fact('if removed', g.removal_impact)
    fact('impact', g.impact_reason ? g.impact + ': ' + g.impact_reason : null)
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
        if (open && !rendered) { g.hunks.forEach(function (h) { code.appendChild(hunkView(c, h)) }); rendered = true }
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
  function statement(parent, label, text) {
    if (text) add(parent, add(el('p', 'statement'), el('span', 'label', label), document.createTextNode(text)))
  }
  function commitMeta(c) {
    return add(el('div', 'commit'), el('span', 'sha', c.sha.slice(0, 10)),
      el('span', null, c.author), el('span', null, new Date(c.date).toLocaleString()))
  }

  // The declared attention (or the one derived from the diff, marked as such),
  // the computed floor, the reasons and links to the groups to read first;
  // "unrated" when there is nothing declared and no signals.
  function attentionBanner(c) {
    var a = c.attention, k = c.computed
    var box = el('section', 'attention-banner')
    if (!a && !k) return add(box, el('span', 'label', 'Attention'), el('span', 'unrated', 'unrated'))
    if (!a) {
      add(box, el('span', 'label', 'Attention'), derivedBadge('attention', k.derived.level))
      if (k.derived.reasons.length) {
        var dl = el('ul', 'reasons')
        k.derived.reasons.forEach(function (r) { dl.appendChild(el('li', null, r)) })
        add(box, dl)
      }
      return box
    }
    add(box, el('span', 'label', 'Attention'), levelBadge('attention', a.level))
    if (k) add(box, el('span', 'floor', 'declared · floor: ' + k.floor))
    if (a.focus && a.focus.length) {
      var look = add(el('span', 'look'), document.createTextNode('look here first: '))
      a.focus.forEach(function (id, i) { if (i) look.appendChild(document.createTextNode(', ')); look.appendChild(groupLink(c, id)) })
      add(box, look)
    }
    if (a.reasons && a.reasons.length) {
      var ul = el('ul', 'reasons')
      a.reasons.forEach(function (r) { ul.appendChild(el('li', null, r)) })
      add(box, ul)
    }
    if (k && k.below) add(box, el('p', 'override mismatch', 'Declared ' + a.level + ', below the computed floor ' + k.floor + (a.override_reason ? '. Reason given: ' + a.override_reason : ' (no reason given).')))
    else if (a.override_reason) add(box, el('p', 'override', 'Rated below what the change suggests: ' + a.override_reason))
    return box
  }

  // One commit's groups, unannotated changes, risks and alternatives, with its
  // entries in the sidebar.
  function commitBody(c, main) {
    var tocList = el('ol')
    var groupsEl = el('section', 'groups')
    c.groups.forEach(function (g) {
      groupsEl.appendChild(groupCard(c, g))
      var li = el('li')
      li.dataset.necessity = g.necessity
      li.dataset.key = key(c, g.id)
      var a = add(el('a'), color(el('span', 'dot'), g.necessity), el('span', null, g.id))
      a.href = '#g-' + key(c, g.id)
      a.title = g.intent
      a.addEventListener('click', function (ev) { ev.preventDefault(); focusGroup(key(c, g.id), false) })
      tocList.appendChild(add(li, a))
    })
    add(main, groupsEl)

    var h = multi ? 'h3' : 'h2'
    if (c.unannotated.length) {
      var unId = 'unannotated' + (multi ? '-' + c.sha.slice(0, 7) : '')
      var un = add(el('section', 'section'), el(h, null, (c.glossed ? 'Unannotated changes' : 'Changes') + ' (' + c.unannotated.length + ')'))
      var box = add(el('div', 'unannotated'), el('p', null, c.glossed
        ? 'These changes are in the commit but no group explains them.'
        : 'This commit has no gloss, so nothing explains these changes.'))
      c.unannotated.forEach(function (hk) { box.appendChild(hunkView(c, hk)) })
      un.id = unId
      add(main, add(un, box))
      var ua = add(el('a'), el('span', null, c.glossed ? 'unannotated' : 'unglossed diff'))
      ua.href = '#' + unId
      tocList.appendChild(add(el('li'), ua))
    }
    if (c.risks.length) {
      var rl = el('ul', 'list')
      c.risks.forEach(function (r) { rl.appendChild(el('li', null, r)) })
      add(main, add(el('section', 'section'), el(h, null, 'Risks'), rl))
    }
    if (c.alternatives.length) {
      var al = el('ul', 'list')
      c.alternatives.forEach(function (x) {
        al.appendChild(add(el('li'), el('strong', null, x.option), el('span', 'why', ' — ' + x.rejected_because)))
      })
      add(main, add(el('section', 'section'), el(h, null, 'Alternatives considered'), al))
    }
    return tocList
  }

  function render() {
    var layout = el('div', 'layout')
    var toc = el('nav', 'toc')
    var main = el('main')
    add(layout, toc, main)
    var allGroups = []
    data.commits.forEach(function (c) { allGroups = allGroups.concat(c.groups) })

    // Whether each commit as it is now was reviewed, per stage; each stage's
    // reports open on demand. Findings are shown as text.
    function reviewsBlock(c, target) {
      var box = el('div', 'reviews')
      if (!c.reviews.length) { add(target, add(box, el('span', 'review-none', 'No reviews recorded'))); return }
      c.reviews.forEach(function (r) {
        var d = el('details', 'review')
        add(d, add(el('summary'), el('span', r.state === 'seen' && r.verdict !== 'issues' ? (r.verdict === 'clean' ? 'review-ok' : 'review-none') : 'stale', r.phrase)))
        r.entries.forEach(function (e) {
          add(d, el('div', 'note', r.stage + ' by ' + e.agent + (e.model ? ':' + e.model : '') + (e.mode ? ' (' + e.mode + ')' : '') +
            ', ' + e.at.slice(0, 16).replace('T', ' ') + ', of ' + e.target), el('pre', 'findings', e.findings))
        })
        add(box, d)
      })
      add(target, box)
    }

    // Header: the commit itself, or the range and its commits.
    if (multi) {
      var glossed = data.commits.filter(function (c) { return c.glossed }).length
      var vetted = data.commits.filter(function (c) {
        return c.glossed && c.reviews.some(function (r) { return r.stage === 'honesty' && r.state === 'seen' })
      }).length
      add(main, add(el('div', 'commit'), el('span', 'sha', data.range),
        el('span', null, plural(data.commits.length, 'commit') + ', ' + glossed + ' glossed' + (glossed ? ', ' + vetted + ' honesty-reviewed' : ''))))
      add(main, el('h1', null, 'Branch ' + data.range))
      var list = el('ol', 'commit-list')
      data.commits.forEach(function (c) {
        var a = add(el('a'), el('span', 'sha', c.sha.slice(0, 7)), document.createTextNode(' ' + c.subject))
        a.href = '#c-' + c.sha.slice(0, 7)
        var li = add(el('li'), a)
        if (!c.glossed) add(li, el('span', 'stale', 'no gloss'))
        else if (c.warnings.length) add(li, el('span', 'stale', 'stale gloss'))
        if (c.glossed) {
          var honesty = c.reviews.filter(function (r) { return r.stage === 'honesty' })[0]
          add(li, !honesty ? el('span', 'stale', 'not reviewed')
            : honesty.state !== 'seen' ? el('span', 'stale', 'changed since review')
            : honesty.verdict === 'issues' ? el('span', 'stale', 'honesty: issues found')
            : el('span', 'review-ok', honesty.verdict === 'clean' ? 'honesty: no issues' : 'honesty-reviewed'))
        }
        list.appendChild(li)
      })
      data.merges.forEach(function (m) {
        list.appendChild(add(el('li'), el('span', 'sha', m.sha.slice(0, 7)), document.createTextNode(' ' + m.subject),
          el('span', 'stale', 'merge, not reviewed')))
      })
      add(main, list)
    } else {
      var only = data.commits[0]
      add(main, commitMeta(only), el('h1', null, only.subject))
      statement(main, 'Task', only.task)
      statement(main, 'Summary', only.summary)
      only.warnings.forEach(function (w) { add(main, el('div', 'warning', '⚠ ' + w)) })
      if (only.glossed) add(main, attentionBanner(only))
      reviewsBlock(only, main)
    }

    // Necessity overview across every commit: bar weighted by changed lines,
    // chips filter groups.
    var present = data.necessity.filter(function (n) { return allGroups.some(function (g) { return g.necessity === n.name }) })
    var total = allGroups.reduce(function (s, g) { return s + g.weight }, 0) || 1
    var bar = el('div', 'bar')
    var chips = el('div', 'chips')
    present.forEach(function (n) {
      var groups = allGroups.filter(function (g) { return g.necessity === n.name })
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
      el('div', 'note', 'Bar shows each category’s share of changed lines' + (multi ? ' across the range' : '') +
        '. Click a category to hide or show its groups.')))

    // Toolbar
    var shown = el('span', 'shown')
    var expand = el('button', 'btn', 'Expand all code')
    var collapse = el('button', 'btn', 'Collapse all')
    expand.type = collapse.type = 'button'
    expand.addEventListener('click', function () { setAll(true) })
    collapse.addEventListener('click', function () { setAll(false) })
    add(main, add(el('div', 'toolbar'), shown, add(el('span'), expand, document.createTextNode(' '), collapse)))

    // Commits, each with its groups; the sidebar groups them by commit.
    data.commits.forEach(function (c) {
      var target = main
      if (multi) {
        target = el('section', 'commit-section')
        target.id = 'c-' + c.sha.slice(0, 7)
        add(target, commitMeta(c), el('h2', null, c.subject))
        statement(target, 'Task', c.task)
        statement(target, 'Summary', c.summary)
        c.warnings.forEach(function (w) { add(target, el('div', 'warning', '⚠ ' + w)) })
        if (c.glossed) add(target, attentionBanner(c))
        reviewsBlock(c, target)
        add(main, target)
      }
      var tocList = commitBody(c, target)
      var heading = multi ? c.sha.slice(0, 7) + ' ' + c.subject : 'Groups'
      var tocHead = el('h2', multi ? 'commit-head' : null, heading)
      if (multi) tocHead.title = c.subject
      add(toc, tocHead, tocList)
    })

    var foot = el('footer')
    add(foot, document.createTextNode('Keys: '), el('kbd', null, 'j'), document.createTextNode(' / '), el('kbd', null, 'k'),
      document.createTextNode(' next / previous group · '), el('kbd', null, 'o'), document.createTextNode(' show or hide code · '),
      el('kbd', null, 'e'), document.createTextNode(' expand all · '), el('kbd', null, 'c'),
      document.createTextNode(' collapse all.'))
    add(foot, el('p', null, 'A snapshot generated by git-gloss ' + new Date(data.generated).toLocaleString() +
      '. It does not update if the gloss or commit changes; regenerate with git gloss html ' +
      (data.range || data.commits[0].sha.slice(0, 10)) + '.'))
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
      toc.querySelectorAll('li[data-necessity]').forEach(function (li) { li.classList.toggle('hidden', hidden.has(li.dataset.necessity)) })
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
  function focusGroup(k, openCode, instant) {
    var i = cards.findIndex(function (c) { return c.id === 'g-' + k })
    if (i < 0) return
    var card = cards[i]
    // Following a link to a filtered-out group turns its category back on.
    if (card.classList.contains('hidden')) showNecessity(card.dataset.necessity)
    cards.forEach(function (c) { c.classList.remove('focused') })
    card.classList.add('focused')
    current = i
    if (openCode && card.setOpen) card.setOpen(true)
    card.scrollIntoView({ block: 'start', behavior: instant ? 'auto' : 'smooth' })
    document.querySelectorAll('.toc li').forEach(function (li) { li.classList.toggle('active', li.dataset.key === k) })
    history.replaceState(null, '', '#g-' + k)
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
