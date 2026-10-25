// The branch pickers and revision box in the desk's top bar when served by
// `git gloss ary`. Included by page.ts only in that mode, ahead of the desk's
// script, in the same nonce'd <script>; `el` and `add` are the desk's helpers. It makes no requests: the branches
// arrive in the page data. Choosing something loads the URL for it, and the
// server renders that page. Text only goes through textContent.
function aryBar(ary, el, add) {
  'use strict'
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
      { label: 'Local branches', names: ary.branches },
      { label: 'Remote branches', names: ary.remotes },
    ]
  }
  function go(head, base, rev) {
    var p = new URLSearchParams()
    if (rev) p.set('rev', rev)
    if (head) p.set('head', head)
    if (base) p.set('base', base)
    location.assign('/?' + p.toString())
  }

  var headPicker = picker(function (name) {
    // A feature branch is most useful against the usual base; the base itself is listed whole.
    go(name, name === ary.defaultBase ? null : ary.defaultBase, null)
  })
  headPicker.setOptions(branchGroups(), null)
  headPicker.setValue(ary.head)
  var basePicker = picker(function (name) { go(ary.head, name, null) })
  basePicker.setOptions(branchGroups(), '(none: just the newest commit)')
  basePicker.setValue(ary.base)

  var input = el('input')
  input.type = 'text'
  input.spellcheck = false
  input.placeholder = 'HEAD~3, abc123, main..feature, wip'
  input.setAttribute('aria-label', 'Any revision or range')
  input.value = ary.rev || ''
  var form = add(el('form', 'ary-rev'), input)
  form.addEventListener('submit', function (ev) {
    ev.preventDefault()
    var v = input.value.trim()
    if (v) go(ary.head, ary.base, v)
  })

  function field(label, node) { return add(el('div', 'ary-field'), el('span', null, label), node) }
  var bar = add(el('div', 'ary-bar'), el('span', 'ary-repo', ary.repo),
    field('Branch', headPicker.root), field('Compare with', basePicker.root), field('Revision', form))
  if (ary.wip) {
    var wip = el('a', 'ary-wip', 'Uncommitted work (wip)')
    var q = new URLSearchParams({ rev: 'wip' })
    if (ary.head) q.set('head', ary.head)
    if (ary.base) q.set('base', ary.base)
    wip.href = '/?' + q.toString()
    bar.appendChild(wip)
  }
  if (ary.notice) bar.appendChild(el('p', 'ary-notice', ary.notice))
  return bar
}
