// A button's words sit in its middle (Daniel, 2026-10-29), a port of Forge's scripts/measure-button-labels.js: a page's
// measure, the half of the rule a file check can't see (a button stretched wider than its words, padding uneven, a box
// off its middle). Evaluate it in a page; it returns JSON: every button and chip drawn at rest with words, and those
// whose label's middle is off its own middle across by `window.buttonLabelsThreshold` px (0.25) or more, or up and down
// by `window.buttonLabelsThresholdY` px (0.5) or more.
// - A button: a `<button>`, `[role=button]`, `[role=tab]`, a link or a label, drawn (a fill, border or shadow). A chip:
//   anything else drawn with a fill or a border, a pill (round ends) or sized to its words (`inline-*`). Each shown, up to
//   64px tall (a chip 44px), holding no text box and no other button or chip with words. Words set from the left
//   (`text-align: left` or `start`) are a row's, counted apart and listed with `window.buttonLabelsRows = true`, unless
//   it's a pill or sized to its words. A pill whose round mark sits at an end of its label as far from that end as from
//   its top is tucked, counted apart.
// - Its label: everything in it that's drawn in its flow, as the font sets it, clipped by any box in it that clips.
//   Words longer than it fill it from its start (`safe center`): counted apart.
// - Its middle: its box inside its borders, so uneven padding shows.
(() => {
  const threshold = window.buttonLabelsThreshold ?? 0.25
  const thresholdY = window.buttonLabelsThresholdY ?? 0.5
  const shown = (el) => {
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const cs = getComputedStyle(e)
      if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity < 0.05) return false
    }
    return true
  }
  const painted = (el, fill = false) => {
    const cs = getComputedStyle(el)
    const bg = cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent'
    const img = cs.backgroundImage !== 'none'
    const border = ['Top', 'Right', 'Bottom', 'Left'].some((s) => parseFloat(cs[`border${s}Width`]) > 0 && !/rgba\(.*, 0\)$/.test(cs[`border${s}Color`]))
    const shadow = cs.boxShadow !== 'none' && !/^rgba\(0, 0, 0, 0\) 0px 0px 0px 0px$/.test(cs.boxShadow)
    return bg || img || border || (!fill && shadow)
  }
  const name = (el) => {
    const c = typeof el.className === 'string' ? el.className : el.className?.baseVal || ''
    return `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${c ? '.' + c.trim().split(/\s+/).slice(0, 4).join('.') : ''}`
  }
  const path = (el) => {
    const p = []
    for (let e = el; e && e !== document.body && p.length < 3; e = e.parentElement) p.unshift(name(e))
    return p.join(' > ')
  }
  const pinned = (el, holder) => {
    for (let e = el; e && e !== holder; e = e.parentElement) {
      if (e.nodeType !== 1) continue
      const p = getComputedStyle(e).position
      if (p === 'absolute' || p === 'fixed') return true
    }
    return false
  }
  const clip = (r, from, holder) => {
    let { left, top, right, bottom } = r
    for (let e = from; e; e = e.parentElement) {
      const cs = getComputedStyle(e)
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
        const b = e.getBoundingClientRect()
        if (cs.overflowX !== 'visible') { left = Math.max(left, b.left); right = Math.min(right, b.right) }
        if (cs.overflowY !== 'visible') { top = Math.max(top, b.top); bottom = Math.min(bottom, b.bottom) }
      }
      if (e === holder) break
    }
    return right > left && bottom > top ? { left, top, right, bottom } : null
  }
  const unturned = (k) => {
    const q = k.getBoundingClientRect()
    const cs = getComputedStyle(k)
    if (cs.transform === 'none' && cs.rotate === 'none' && cs.scale === 'none') return q
    const w = parseFloat(cs.width) || q.width
    const h = parseFloat(cs.height) || q.height
    const x = (q.left + q.right) / 2
    const y = (q.top + q.bottom) / 2
    return { left: x - w / 2, right: x + w / 2, top: y - h / 2, bottom: y + h / 2, width: w, height: h }
  }
  const label = (el) => {
    const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }
    const add = (q) => {
      if (!q) return
      box.x0 = Math.min(box.x0, q.left); box.y0 = Math.min(box.y0, q.top); box.x1 = Math.max(box.x1, q.right); box.y1 = Math.max(box.y1, q.bottom)
    }
    let words = ''
    let full = false
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    for (let n; (n = w.nextNode()); ) {
      const t = n.textContent
      const a = t.search(/\S/)
      if (a < 0 || !shown(n.parentElement) || pinned(n.parentElement, el)) continue
      const range = document.createRange()
      range.setStart(n, a)
      range.setEnd(n, t.trimEnd().length)
      for (const q of range.getClientRects()) {
        if (!(q.width > 0)) continue
        const c = clip(q, n.parentElement, el)
        if (!c || c.left > q.left + 0.5 || c.right < q.right - 0.5) full = true
        add(c)
      }
      words += t.trim() + ' '
    }
    for (const pic of el.querySelectorAll('*')) {
      if (pic.parentElement?.closest('svg')) continue
      if (!/^(svg|img|canvas|video)$/i.test(pic.tagName) && !painted(pic)) continue
      if (!shown(pic) || pinned(pic, el)) continue
      const q = unturned(pic)
      if (q.width > 0 && q.height > 0) add(clip(q, pic.parentElement, el))
    }
    return { box, words: words.trim(), full }
  }
  const tucked = (el, box, inner) => {
    for (const k of el.querySelectorAll('*')) {
      if (k.parentElement?.closest('svg') || !shown(k) || pinned(k, el)) continue
      const q = k.getBoundingClientRect()
      if (q.width < inner.h / 2 || Math.abs(q.width - q.height) > 1) continue
      const cs = getComputedStyle(k)
      const roundSelf = /50%/.test(cs.borderTopLeftRadius) || parseFloat(cs.borderTopLeftRadius) >= q.width / 2 - 0.5
      const roundIn = /^(svg|img|canvas)$/i.test(k.tagName) && k.parentElement !== el && (() => { const pc = getComputedStyle(k.parentElement); const pq = k.parentElement.getBoundingClientRect(); return Math.abs(pq.width - q.width) < 1 && (/50%/.test(pc.borderTopLeftRadius) || parseFloat(pc.borderTopLeftRadius) >= q.width / 2 - 0.5) })()
      if (!roundSelf && !roundIn && !(/^svg$/i.test(k.tagName) && k.querySelector('circle'))) continue
      const top = q.top - inner.top
      if (Math.abs(q.left - box.x0) < 0.5 && Math.abs(q.left - inner.left - top) <= 1) return 'left'
      if (Math.abs(q.right - box.x1) < 0.5 && Math.abs(inner.right - q.right - top) <= 1) return 'right'
    }
    return null
  }
  const worded = (words) => /[\p{L}\p{N}]{2}|[\p{L}\p{N}].*\s|\S{4}/u.test(words)
  const controls = 'button, [role=button], [role=tab], a[href], label'
  const holders = new Set()
  for (const el of document.querySelectorAll(controls)) if (painted(el)) holders.add(el)
  for (const el of document.querySelectorAll('body *')) {
    if (holders.has(el) || el.closest('svg') || !painted(el, true)) continue
    const cs = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    const round = parseFloat(cs.borderTopLeftRadius) >= r.height / 2 - 1 && parseFloat(cs.borderTopRightRadius) >= r.height / 2 - 1
    if (r.height <= 44 && r.width <= 480 && (round || /^inline-/.test(cs.display))) holders.add(el)
  }
  const found = []
  const rows = []
  const tucks = []
  const fills = []
  for (const el of holders) {
    if (!shown(el)) continue
    const r = el.getBoundingClientRect()
    if (r.width < 8 || r.height < 8 || r.height > 64) continue
    if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue
    if (el.querySelector('input, textarea, select, [contenteditable=true]')) continue
    if ([...el.querySelectorAll(controls)].some((c) => shown(c))) continue
    if ([...holders].some((h) => h !== el && el.contains(h) && shown(h) && worded(label(h).words))) continue
    const { box, words, full } = label(el)
    if (box.x0 === Infinity || !worded(words)) continue
    // A lone label (a count, an initial: `[data-ink]`) sits on its ink, measured by measure-icon-centers.js, not on its run box.
    if ([...el.querySelectorAll('[data-ink]')].some((l) => l.textContent.trim() === words)) continue
    const cs = getComputedStyle(el)
    const bl = parseFloat(cs.borderLeftWidth), br = parseFloat(cs.borderRightWidth), bt = parseFloat(cs.borderTopWidth), bb = parseFloat(cs.borderBottomWidth)
    const cx = r.left + bl + (r.width - bl - br) / 2
    const cy = r.top + bt + (r.height - bt - bb) / 2
    const one = {
      where: path(el),
      words: words.length > 40 ? words.slice(0, 39) + '…' : words,
      box: [+r.width.toFixed(2), +r.height.toFixed(2)],
      dx: +((box.x0 + box.x1) / 2 - cx).toFixed(2),
      dy: +((box.y0 + box.y1) / 2 - cy).toFixed(2),
      room: [+(box.x0 - r.left - bl).toFixed(2), +(r.right - br - box.x1).toFixed(2)]
    }
    const pill = r.height <= 44 && parseFloat(cs.borderTopLeftRadius) >= r.height / 2 - 1 && parseFloat(cs.borderTopRightRadius) >= r.height / 2 - 1
    const end = pill && tucked(el, box, { left: r.left + bl, right: r.right - br, top: r.top + bt, h: r.height - bt - bb })
    if (full) fills.push(one)
    else if (end) tucks.push({ ...one, tucked: end })
    else if (!pill && !/^inline-/.test(cs.display) && /^(left|start|-webkit-left)$/.test(cs.textAlign)) rows.push(one)
    else found.push(one)
  }
  const off = found.filter((f) => Math.abs(f.dx) >= threshold || Math.abs(f.dy) >= thresholdY)
  return JSON.stringify(
    { dpr: devicePixelRatio, size: [innerWidth, innerHeight], threshold: [threshold, thresholdY], measured: found.length, rows: rows.length, tucked: tucks.length, full: fills.length, off: off.length, list: off, ...(window.buttonLabelsRows ? { rowList: rows, tuckList: tucks, fullList: fills } : {}) },
    null,
    1
  )
})()
