// Icons sit in the middle of what holds them (Daniel, 2026-10-28), a port of Forge's scripts/measure-icon-centers.js:
// a page's measure, the half of the rule a file check can't see (padding, a box off its holder's middle, a symbol's
// font). Evaluate it in a page; it returns JSON: every icon alone in a ring, box or button, and those whose ink's
// middle is off the holder's middle by `window.iconCentersThreshold` px (0.25, half a device pixel on a Retina screen)
// or more.
// - An icon: a visible SVG up to 40px (its ink: its shapes' boxes through getScreenCTM, grown by half their stroke), or
//   a symbol of up to three characters (× + ⋯ ›; its ink from canvas measureText's actualBoundingBox at its baseline),
//   or a number or letter of up to three in a ring or a drawn box up to 44px (a count, an initial).
// - Its holder: the nearest ancestor that's a control, is drawn (a fill, border or shadow) or holds a ring (an SVG of
//   circles), with nothing else visible in it and no text box. A ring's middle is its circle's; anything else's, its
//   box's inside its borders.
(async () => {
  const threshold = window.iconCentersThreshold ?? 0.25
  const shown = (el) => {
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const cs = getComputedStyle(e)
      if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity < 0.05) return false
    }
    return true
  }
  const box = () => ({ x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity })
  const add = (b, x, y) => {
    b.x0 = Math.min(b.x0, x); b.y0 = Math.min(b.y0, y); b.x1 = Math.max(b.x1, x); b.y1 = Math.max(b.y1, y)
  }
  const svgInk = (svg) => {
    const b = box()
    for (const s of svg.querySelectorAll('path,circle,rect,line,polyline,polygon,ellipse')) {
      if (!shown(s)) continue
      const cs = getComputedStyle(s)
      const fill = cs.fill !== 'none' && +cs.fillOpacity > 0
      const stroke = cs.stroke !== 'none' && +cs.strokeOpacity > 0 && parseFloat(cs.strokeWidth) > 0
      if (!fill && !stroke) continue
      let g
      try { g = s.getBBox() } catch { continue }
      if (!g.width && !g.height) continue
      const m = s.getScreenCTM()
      if (!m) continue
      const w = stroke ? parseFloat(cs.strokeWidth) / 2 : 0
      for (const [x, y] of [[g.x - w, g.y - w], [g.x + g.width + w, g.y - w], [g.x - w, g.y + g.height + w], [g.x + g.width + w, g.y + g.height + w]])
        add(b, m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f)
    }
    return b.x0 === Infinity ? null : b
  }
  const ctx = document.createElement('canvas').getContext('2d')
  const textInk = (node) => {
    const el = node.parentElement
    const cs = getComputedStyle(el)
    const r = document.createRange()
    r.selectNodeContents(node)
    const rect = r.getBoundingClientRect()
    ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
    const t = node.textContent.trim()
    const tt = cs.textTransform
    const drawn = tt === 'uppercase' ? t.toUpperCase() : tt === 'lowercase' ? t.toLowerCase() : tt === 'capitalize' ? t.replace(/(^|\s)\S/g, (c) => c.toUpperCase()) : t
    ctx.letterSpacing = cs.letterSpacing === 'normal' ? '0px' : cs.letterSpacing
    const m = ctx.measureText(drawn)
    const lead = node.textContent.indexOf(t)
    let left = rect.left
    if (lead > 0) { const r2 = document.createRange(); r2.setStart(node, lead); r2.setEnd(node, lead + t.length); left = r2.getBoundingClientRect().left }
    const wrap = document.createElement('span')
    const probe = document.createElement('span')
    probe.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline;margin:0;padding:0;border:0'
    node.parentNode.insertBefore(wrap, node)
    wrap.append(probe, node)
    const base = probe.getBoundingClientRect().bottom
    wrap.parentNode.insertBefore(node, wrap)
    wrap.remove()
    return { x0: left - m.actualBoundingBoxLeft, x1: left + m.actualBoundingBoxRight, y0: base - m.actualBoundingBoxAscent, y1: base + m.actualBoundingBoxDescent }
  }
  const visibleText = (el) => {
    let s = ''
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    for (let n; (n = w.nextNode()); ) if (shown(n.parentElement)) s += n.textContent
    return s.trim()
  }
  const name = (el) => {
    const c = typeof el.className === 'string' ? el.className : el.className?.baseVal || ''
    return `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${c ? '.' + c.trim().split(/\s+/).slice(0, 4).join('.') : ''}`
  }
  const path = (el) => {
    const p = []
    for (let e = el; e && e !== document.body && p.length < 4; e = e.parentElement) p.unshift(name(e))
    return p.join(' > ')
  }
  const painted = (el) => {
    const cs = getComputedStyle(el)
    const bg = cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent'
    const img = cs.backgroundImage !== 'none'
    const border = ['Top', 'Right', 'Bottom', 'Left'].some((s) => parseFloat(cs[`border${s}Width`]) > 0 && !/rgba\(.*, 0\)$/.test(cs[`border${s}Color`]))
    const shadow = cs.boxShadow !== 'none'
    return bg || img || border || shadow
  }
  const holder = (icon) => {
    for (let e = icon.parentElement, hops = 0; e && e !== document.body && hops < 6; e = e.parentElement, hops++) {
      const r = e.getBoundingClientRect()
      if (r.width < 6 || r.height < 6) continue
      const control = e.matches('button, a[href], [role=button], [role=tab], [role=menuitem], label, summary')
      const ring = [...e.querySelectorAll(':scope > svg, :scope > * > svg')].some((s) => s !== icon && s.querySelector('circle') && shown(s))
      if (!(control || painted(e) || ring)) continue
      if (e.querySelector('input, textarea, select, [contenteditable=true]')) return null
      const others = [...e.querySelectorAll('svg, img, canvas, video')].filter((o) => o !== icon && !icon.contains(o) && !o.contains(icon) && shown(o) && !(ring && o.querySelector('circle') && !o.closest('[class*=glyph]')))
      const text = icon.nodeType === 3 ? visibleText(e).replace(icon.textContent.trim(), '') : visibleText(e)
      return { el: e, alone: !others.length && !text, ring, control }
    }
    return null
  }
  const found = []
  const seen = new Set()
  const consider = (icon, inkBox, kind) => {
    if (!inkBox) return
    const h = holder(icon)
    if (!h || !h.alone || seen.has(h.el)) return
    if (kind === 'label') { const r0 = h.el.getBoundingClientRect(); if (!(h.ring || (painted(h.el) && r0.width <= 44 && r0.height <= 44))) return }
    seen.add(h.el)
    const r = h.el.getBoundingClientRect()
    const hs = getComputedStyle(h.el)
    const bl = parseFloat(hs.borderLeftWidth), br = parseFloat(hs.borderRightWidth), bt = parseFloat(hs.borderTopWidth), bb = parseFloat(hs.borderBottomWidth)
    let cx = r.left + bl + (r.width - bl - br) / 2
    let cy = r.top + bt + (r.height - bt - bb) / 2
    if (h.ring) {
      const ringSvg = [...h.el.querySelectorAll('svg')].find((s) => s !== icon && s.querySelector('circle') && shown(s))
      const rb = ringSvg && svgInk(ringSvg)
      if (rb) { cx = (rb.x0 + rb.x1) / 2; cy = (rb.y0 + rb.y1) / 2 }
    }
    const ix = (inkBox.x0 + inkBox.x1) / 2
    const iy = (inkBox.y0 + inkBox.y1) / 2
    const ib = icon.nodeType === 3 ? null : icon.getBoundingClientRect()
    found.push({
      kind,
      where: path(h.el),
      icon: icon.nodeType === 3 ? JSON.stringify(icon.textContent.trim()) : name(icon),
      box: [+r.width.toFixed(2), +r.height.toFixed(2)],
      iconBox: ib ? [+ib.left.toFixed(2) - +r.left.toFixed(2), +ib.top.toFixed(2) - +r.top.toFixed(2), ib.width, ib.height].map((v) => +v.toFixed(2)) : null,
      dx: +(ix - cx).toFixed(2),
      dy: +(iy - cy).toFixed(2),
      drawn: painted(h.el),
      ring: h.ring
    })
  }
  for (const svg of document.querySelectorAll('svg')) {
    if (!shown(svg)) continue
    const r = svg.getBoundingClientRect()
    if (r.width > 40 || r.height > 40 || r.width < 4) continue
    if (svg.querySelector('circle') && [...svg.querySelectorAll('circle')].length >= 2 && r.width > 20) continue
    consider(svg, svgInk(svg), 'svg')
  }
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  for (let n; (n = w.nextNode()); ) {
    const t = n.textContent.trim()
    if (!t || t.length > 3) continue
    if (!shown(n.parentElement)) continue
    // A word in a chip (any lowercase letter: Tag, Low, Off) stays as the font sets it (Daniel's pick,
    // the button-labels measure covers it); counts, initials and symbols alone in a badge are labels.
    if (/\p{Ll}/u.test(t)) continue
    const label = /[\p{L}\p{N}]/u.test(t)
    consider(n, textInk(n), label ? 'label' : 'text')
  }
  const off = found.filter((f) => Math.abs(f.dx) >= threshold || Math.abs(f.dy) >= threshold)
  const kinds = {}
  for (const f of found) kinds[f.kind] = (kinds[f.kind] ?? 0) + 1
  return JSON.stringify({ dpr: devicePixelRatio, size: [innerWidth, innerHeight], threshold, measured: found.length, kinds, off: off.length, list: off }, null, 1)
})()
