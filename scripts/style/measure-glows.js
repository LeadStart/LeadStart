// Glows are never capped (Daniel, 2026-10-30: "the glow is capped incorrectly … this needs to be resolved for ALL
// styling notes going forward"), a port of Forge's scripts/measure-glows.js. A page's measure: evaluate it in a page
// (the measure gate over CDP, Forge's page_check, or a browser's console); it returns JSON with two lists.
// - `capped`: a glow drawn out from an element that something cuts off while the element itself is fully in view. A
//   glow: an outer box-shadow or a filter's drop-shadow (its reach on each side: blur + spread, less or plus its
//   offset), a filter's blur (twice its radius; nothing on a gradient that already fades to transparent at its edge),
//   or a glow layer (a radial-gradient box that takes no taps: its own box is the glow, its parent the element it glows
//   round). The same on an element's ::before and ::after. What cuts: an ancestor in its containing-block chain whose
//   overflow isn't visible on that axis (a scroller too), at its padding box, or one with `contain: paint`; not the
//   page's body, nor any side lying on the window's edge. Cut by `window.glowsThreshold` px (0.5) or more is listed.
// - `strips`: the room a box borrows for a glow (a negative margin paid back as padding) lying over something you can
//   press: the points where the top hit is the box itself and a button, link or field beside it lies under it.
// Run it in every state that glows (chosen, hover, working), with the glowing element first and last in its scroller.
(() => {
  const threshold = window.glowsThreshold ?? 0.5
  const shown = (el) => {
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const cs = getComputedStyle(e)
      if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity < 0.05) return false
    }
    return true
  }
  const name = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + [...el.classList].slice(0, 3).map((c) => '.' + c).join('')
  const path = (el) => {
    const out = []
    for (let e = el; e && e !== document.body && out.length < 4; e = e.parentElement) out.unshift(name(e))
    return out.join(' > ')
  }
  const round = (n) => Math.round(n * 10) / 10
  const layers = (v) => {
    const out = []
    let depth = 0
    let cur = ''
    for (const ch of v) {
      if (ch === '(') depth++
      if (ch === ')') depth--
      if (ch === ',' && !depth) {
        out.push(cur.trim())
        cur = ''
      } else cur += ch
    }
    if (cur.trim()) out.push(cur.trim())
    return out
  }
  const COLOR = /(rgba?|hsla?|color|oklab|oklch|lab|lch|hwb)\(([^)]*)\)/
  const alphaOf = (s) => {
    if (/\btransparent\b/.test(s)) return 0
    const m = s.match(COLOR)
    if (!m) return 1
    const slash = m[2].split('/')
    const commas = m[2].split(',')
    const a = slash.length > 1 ? slash[1] : commas.length === 4 ? commas[3] : null
    if (a == null) return 1
    return a.trim().endsWith('%') ? parseFloat(a) / 100 : parseFloat(a)
  }
  const lengths = (s) => (s.replace(new RegExp(COLOR.source, 'g'), '').match(/-?[\d.]+px/g) || []).map(parseFloat)
  const grow = (r, by) => {
    r.t = Math.max(r.t, by.t)
    r.r = Math.max(r.r, by.r)
    r.b = Math.max(r.b, by.b)
    r.l = Math.max(r.l, by.l)
  }
  const shadowReach = (x, y, reach) => ({ t: reach - y, b: reach + y, l: reach - x, r: reach + x })
  const reachOf = (cs) => {
    const r = { t: 0, r: 0, b: 0, l: 0 }
    let any = false
    if (cs.boxShadow && cs.boxShadow !== 'none') {
      for (const layer of layers(cs.boxShadow)) {
        if (/\binset\b/.test(layer) || alphaOf(layer) < 0.02) continue
        const [x = 0, y = 0, blur = 0, spread = 0] = lengths(layer)
        if (blur + spread <= 0) continue
        grow(r, shadowReach(x, y, blur + spread))
        any = true
      }
    }
    if (cs.filter && cs.filter !== 'none') {
      const fades = /radial-gradient/.test(cs.backgroundImage) && /(transparent|rgba\([^)]*,\s*0\))(\s+[\d.]+%)?\)\s*$/.test(cs.backgroundImage)
      for (const m of cs.filter.matchAll(/blur\(([\d.]+)px\)/g)) {
        const b = fades ? 0 : parseFloat(m[1]) * 2
        if (b > 0) {
          grow(r, { t: b, r: b, b: b, l: b })
          any = true
        }
      }
      for (const m of cs.filter.matchAll(/drop-shadow\(((?:[^()]|\([^)]*\))*)\)/g)) {
        if (alphaOf(m[1]) < 0.02) continue
        const [x = 0, y = 0, blur = 0] = lengths(m[1])
        grow(r, shadowReach(x, y, blur))
        any = true
      }
    }
    return any ? r : null
  }
  const glowLayer = (cs) => cs.pointerEvents === 'none' && /radial-gradient/.test(cs.backgroundImage)
  const makesFixedBlock = (cs) =>
    cs.transform !== 'none' || cs.filter !== 'none' || cs.perspective !== 'none' || (cs.backdropFilter && cs.backdropFilter !== 'none') || /paint|layout|strict|content/.test(cs.contain) || /transform|filter/.test(cs.willChange)
  const clippers = (el, position) => {
    const out = []
    let pos = position
    for (let a = el.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
      const cs = getComputedStyle(a)
      const block = pos === 'absolute' ? cs.position !== 'static' || makesFixedBlock(cs) : pos === 'fixed' ? makesFixedBlock(cs) : true
      if (!block) continue
      const paint = /paint|strict|content/.test(cs.contain)
      const x = paint || cs.overflowX !== 'visible'
      const y = paint || cs.overflowY !== 'visible'
      if (x || y) {
        const r = a.getBoundingClientRect()
        const sx = r.width / (a.offsetWidth || 1)
        const sy = r.height / (a.offsetHeight || 1)
        const left = r.left + a.clientLeft * sx
        const top = r.top + a.clientTop * sy
        out.push({ el: a, x, y, sx: /auto|scroll/.test(cs.overflowX), sy: /auto|scroll/.test(cs.overflowY), box: { left, top, right: left + a.clientWidth * sx, bottom: top + a.clientHeight * sy } })
      }
      pos = cs.position
    }
    return out
  }
  const inside = (r, box, x, y) => (!x || (r.left >= box.left - 0.5 && r.right <= box.right + 0.5)) && (!y || (r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5))
  const capped = []
  let glows = 0
  const check = (el, label, rect, reach, anchor, position) => {
    glows++
    const paint = { left: rect.left - reach.l, top: rect.top - reach.t, right: rect.right + reach.r, bottom: rect.bottom + reach.b }
    for (const c of clippers(el, position)) {
      if (!inside(anchor, c.box, c.x, c.y)) continue
      const more = {
        top: c.sy && c.el.scrollTop > 0.5,
        bottom: c.sy && c.el.scrollHeight - c.el.scrollTop - c.el.clientHeight > 0.5,
        left: c.sx && c.el.scrollLeft > 0.5,
        right: c.sx && c.el.scrollWidth - c.el.scrollLeft - c.el.clientWidth > 0.5
      }
      const cut = {}
      if (c.y && !more.top && c.box.top > 0.5 && c.box.top - paint.top >= threshold) cut.top = round(c.box.top - paint.top)
      if (c.y && !more.bottom && c.box.bottom < innerHeight - 0.5 && paint.bottom - c.box.bottom >= threshold) cut.bottom = round(paint.bottom - c.box.bottom)
      if (c.x && !more.left && c.box.left > 0.5 && c.box.left - paint.left >= threshold) cut.left = round(c.box.left - paint.left)
      if (c.x && !more.right && c.box.right < innerWidth - 0.5 && paint.right - c.box.right >= threshold) cut.right = round(paint.right - c.box.right)
      if (Object.keys(cut).length) capped.push({ glow: label, cut, by: path(c.el) })
    }
  }
  for (const el of document.querySelectorAll('body *')) {
    if (el.namespaceURI !== 'http://www.w3.org/1999/xhtml' && el.tagName.toLowerCase() !== 'svg') continue
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || !shown(el)) continue
    const rect = el.getBoundingClientRect()
    if (!rect.width || !rect.height) continue
    const reach = reachOf(cs)
    const layer = glowLayer(cs) && el.parentElement
    if (reach || layer) {
      const anchor = layer ? el.parentElement.getBoundingClientRect() : rect
      check(el, path(el), rect, reach ?? { t: 0, r: 0, b: 0, l: 0 }, anchor, cs.position)
    }
    for (const pseudo of ['::before', '::after']) {
      const ps = getComputedStyle(el, pseudo)
      if (ps.content === 'none' || ps.content === 'normal' || ps.display === 'none' || +ps.opacity < 0.05) continue
      const pReach = reachOf(ps)
      if (!pReach && !glowLayer(ps)) continue
      const w = parseFloat(ps.width)
      const h = parseFloat(ps.height)
      if (!(w > 0 && h > 0)) continue
      const abs = ps.position === 'absolute'
      const left = abs ? rect.left + el.clientLeft + (parseFloat(ps.left) || 0) + (parseFloat(ps.marginLeft) || 0) : rect.left
      const top = abs ? rect.top + el.clientTop + (parseFloat(ps.top) || 0) + (parseFloat(ps.marginTop) || 0) : rect.top
      const pRect = { left, top, right: left + w, bottom: top + h }
      const paint = pReach ?? { t: 0, r: 0, b: 0, l: 0 }
      const anchor = glowLayer(ps) ? rect : pRect
      check(el, path(el) + pseudo, pRect, paint, anchor, cs.position)
    }
  }
  const PRESS = 'button, a[href], input, select, textarea, label, summary, [role=button], [role=link], [role=tab], [role=menuitem], [contenteditable=""], [contenteditable=true], [tabindex]:not([tabindex="-1"])'
  const pressOf = (e) => {
    const p = e.closest(PRESS)
    if (p) return p
    for (let a = e; a && a !== document.body; a = a.parentElement) if (getComputedStyle(a).cursor === 'pointer') return a
    return null
  }
  const strips = []
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.display === 'contents' || !shown(el)) continue
    const r = el.getBoundingClientRect()
    if (!r.width || !r.height) continue
    for (const side of ['top', 'bottom', 'left', 'right']) {
      const cap = side[0].toUpperCase() + side.slice(1)
      const m = parseFloat(cs['margin' + cap])
      const pad = parseFloat(cs['padding' + cap])
      if (!(m <= -2 && pad >= -m - 0.5)) continue
      const band =
        side === 'top' ? { x0: r.left, x1: r.right, y0: r.top, y1: r.top - m }
        : side === 'bottom' ? { x0: r.left, x1: r.right, y0: r.bottom + m, y1: r.bottom }
        : side === 'left' ? { x0: r.left, x1: r.left - m, y0: r.top, y1: r.bottom }
        : { x0: r.right + m, x1: r.right, y0: r.top, y1: r.bottom }
      const step = Math.max(1, Math.sqrt(((band.x1 - band.x0) * (band.y1 - band.y0)) / 4000))
      const covered = new Map()
      let points = 0
      for (let y = band.y0 + 0.5; y < band.y1; y += step) {
        for (let x = band.x0 + 0.5; x < band.x1; x += step) {
          if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue
          const stack = document.elementsFromPoint(x, y)
          const top = stack[0]
          if (!top || !el.contains(top)) continue
          const own = pressOf(top)
          if (own && el.contains(own)) continue
          points++
          for (const e of stack.slice(1)) {
            if (e.contains(el)) break
            if (el.contains(e)) continue
            const p = pressOf(e)
            if (p && !el.contains(p) && !p.contains(el)) {
              const k = path(p)
              covered.set(k, (covered.get(k) || 0) + 1)
              break
            }
          }
        }
      }
      if (covered.size) strips.push({ box: path(el), side, borrowed: round(-m), sampled: points, covers: Object.fromEntries(covered) })
    }
  }
  return JSON.stringify({ threshold, glows, capped, strips }, null, 1)
})()
