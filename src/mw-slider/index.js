/* ============================================================
   mw-slider — skewed card row with a physically simulated
   open/close. DOM stays the accessible/interactive layer; the
   visible cards are OGL planes deformed by a per-card grip-chain
   (see cloth.js). One clock owns the flight: a single K/D spring
   on openness `o`. Row position, scale, skew and backdrop all
   read that spring, and the material only ever reacts to the
   motion the spring actually produces.

   Authored from Webflow via data attributes on [data-mw="root"].
   Multiple instances per page, destroy() for page transitions.
   ============================================================ */

import { ClothChain } from './cloth.js';
import { GlLayer, MAX_NODES, composeCardMatrix, transformPoint, cssColor } from './gl.js';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const clamp01 = (v) => clamp(v, 0, 1);
const lerp = (a, b, t) => a + (b - a) * t;

export function init(root) {
  if (root.dataset.mwInit) return root._mw;
  root.dataset.mwInit = 'true';

  /* Two markup flavours: the reference markup in this repo, and a
     Webflow component tree tagged with data-webgl-*. Anything the
     Webflow side doesn't provide (backdrop, close button) is created,
     and anything optional (heading, counter) is simply skipped. */
  const stage = root.querySelector('[data-mw="stage"]') || root;
  const cards = Array.from(root.querySelectorAll('[data-mw="card"], [data-webgl-item]'));
  const n = cards.length;
  if (!n) return null;

  const wf = !root.querySelector('[data-mw="stage"]');
  if (wf) injectCss();

  // chrome can be authored anywhere in the section, not just inside the canvas
  const scope = root.closest('section') || root;
  const el = (sel, make) => scope.querySelector(sel) || (make ? make() : null);
  const backdrop = el('[data-mw="backdrop"], [data-webgl-backdrop]', () => {
    const d = document.createElement('div');
    d.className = 'mw-backdrop';
    d.dataset.mwMade = '1';
    stage.appendChild(d);
    return d;
  });
  /* A close button authored inside the component exists once per card, so
     they must behave like the tags: pinned to the open card, shown only for
     it, and never left sitting in the row. Anything outside a card is
     ordinary global chrome. */
  const closeAll = Array.from(scope.querySelectorAll('[data-mw="close"], [data-webgl-close]'));
  const cardCloses = cards.map((c) => c.querySelector('[data-mw="close"], [data-webgl-close]'));
  const globalCloses = closeAll.filter((e) => !cards.some((c) => c.contains(e)));
  const closeBtn = globalCloses[0] || (cardCloses.some(Boolean) ? null : el('[data-mw="close"]', () => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mw-close';
    b.dataset.mwMade = '1';
    b.setAttribute('aria-label', 'Close');
    b.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M2 2 L14 14 M14 2 L2 14"/></svg>';
    root.appendChild(b);
    return b;
  }));
  const headEl = root.querySelector('[data-mw="head"]')
    || (root.closest('section') || root).querySelector('[data-webgl-heading]');
  const countEl = root.querySelector('[data-mw="counter"]');
  const indexEl = root.querySelector('[data-mw="index"]');
  const totalEl = root.querySelector('[data-mw="total"]');

  /* The tip: either the single one in the reference markup, or the tag
     block each Webflow card carries. Those live INSIDE the card, which
     is skewed and scaled, so they are lifted out into a screen-space
     layer once at init and put back on destroy — that keeps the real
     links and text intact instead of redrawing them. */
  const globalTip = root.querySelector('[data-mw="tip"]');
  const tipSwatch = root.querySelector('[data-mw="swatch"]');
  const tipTitle = root.querySelector('[data-mw="tip-title"]');
  const tipBy = root.querySelector('[data-mw="tip-by"]');
  const cardTips = cards.map((c) => c.querySelector('[data-webgl-tag], .webgl_cards_tag'));
  let tipLayer = null;
  const tipHolders = [];
  if (cardTips.some(Boolean) || cardCloses.some(Boolean)) {
    /* The layer is sized to the OPEN card's rect, so a tag authored as
       `position:absolute; bottom:24px; left:24px` in Webflow lands where
       it was designed to — against the image — instead of wherever the
       module decides. Each tag gets its own holder inside it, which is
       what the module fades; the tag's own styling is left alone. */
    tipLayer = document.createElement('div');
    tipLayer.className = 'mw-tip-layer';
    stage.appendChild(tipLayer);
    cards.forEach((card, i) => {
      const bits = [cardTips[i], cardCloses[i]].filter(Boolean);
      if (!bits.length) { tipHolders[i] = null; return; }
      const holder = document.createElement('div');
      holder.className = 'mw-tip-hold';
      tipLayer.appendChild(holder);
      bits.forEach((b) => lift(holder, b, card));
      tipHolders[i] = holder;
    });

    // anything marked data-webgl-pin anchors to the open card too, so a
    // close button can sit at the card's top-left rather than the viewport's
    scope.querySelectorAll('[data-webgl-pin]').forEach((p) => {
      if (p.closest('.mw-tip-layer')) return;
      // no class shells here: pinned chrome is top level, and rebuilding
      // its ancestors would recreate the section itself inside the layer
      p._mwHome = p.parentNode;
      tipLayer.appendChild(p);
    });
  }
  let activeTip = null;

  /* Move `node` into `holder`, rebuilding the chain of ancestors up to and
     including `top` as empty elements with the same classes.

     Webflow writes nested styles as descendant selectors, so an element
     simply reparented out of the card loses everything styled through its
     parents — text and links go unstyled or invisible while a self-styled
     SVG survives. The class shells keep those selectors matching. */
  function lift(holder, node, top) {
    const chain = [];
    for (let p = node.parentElement; p; p = p.parentElement) {
      chain.unshift(p);
      if (p === top) break;
    }
    node._mwHome = node.parentNode;
    let mount = holder;
    chain.forEach((anc) => {
      const shell = document.createElement(anc.tagName.toLowerCase());
      shell.className = anc.className;
      shell.dataset.mwShell = '1';
      mount.appendChild(shell);
      mount = shell;
    });
    mount.appendChild(node);
  }

  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const num = (k, d) => { const v = parseFloat(root.dataset[k]); return Number.isNaN(v) ? d : v; };

  const cfg = {
    /* row */
    spacing: num('spacing', 0.62),     // fraction of card width between cards
    skewY: num('skewY', 29.5),         // THE angle
    persp: num('perspective', 2200),
    push: num('push', 0.14),           // neighbour slide-out on open
    chase: num('chase', 0.34),         // how fast a card tracks its slot
    lag: num('lag', 0.72),             // 0 = rigid row, 1 = edges barely keep up
    friction: num('friction', 0.93),   // per-frame @60, dt-corrected below
    lerp: reduced ? 1 : num('lerp', 0.11),
    loop: root.dataset.loop !== 'false',
    visible: 5,

    /* rigid row ripple (choreography, kept from the prototype —
       the material softness on top of it comes from the sim) */
    waveAmp: num('waveAmp', 18),
    waveFreq: num('waveFreq', 0.8),
    waveTilt: num('waveTilt', 3),
    waveTurn: num('waveTurn', 4),
    waveGain: num('waveGain', 1.6),

    /* proximity hover */
    hoverRadius: num('hoverRadius', 1.4),  // in card-widths
    hoverLift: num('hoverLift', 14),       // px
    hoverDim: num('hoverDim', 0.28),

    /* flight spring — the one clock */
    springK: num('springK', 58),       // stiffness, 1/s^2
    springD: num('springD', 13.5),     // damping, 1/s (critical ≈ 2·√K ≈ 15.2)
    scalePow: num('scalePow', 1.25),   // scale channel reads o slower
    skewPow: num('skewPow', 0.55),     // unskew channel reads o faster
    openZ: num('openZ', 90),           // px toward viewer when open
    zGap: num('zGap', 4),              // px depth per slot for overlap order

    /* material (angle-chain, see cloth.js) */
    nodes: clamp(Math.round(num('nodes', 24)), 8, MAX_NODES),
    grip: num('grip', 1200),           // flatten spring, rad/s^2 per rad
    gripPow: num('gripPow', 2.6),      // grading toward the grabbed edge
    gripBase: num('gripBase', 0.12),   // floor grip — what "loose" still holds
    drag: num('drag', 0.6),            // fold torque from slot speed^2
    foldPow: num('foldPow', 2.0),      // curl concentration at the free tip
    ripple: num('ripple', 0.45),       // material unevenness along the width
    damp: num('damp', 0),              // extra constant damping, 1/s
    settle: num('settle', 1.05),       // damping ratio: >=1 clean relax, <1 flutters
    iters: clamp(Math.round(num('iters', 2)), 1, 6),   // bend diffusion passes
    bendStiff: num('bendStiff', 0.12), // crease -> curve diffusion rate
    softAmp: num('softAmp', 0.16),     // material amplitude during row scroll
    shade: num('shade', 1.0),          // fold darkening

    /* UI assembly — the landed card becomes the Designer window and the
       slide tucks itself into the canvas hole. hole defaults are measured
       from the shipped chrome PNG (41,40 1158x771 of 1440x851). */
    uiSrc: root.dataset.ui || '',
    holeX: num('holeX', 0.028472),
    holeY: num('holeY', 0.047004),     // from the TOP edge
    holeW: num('holeW', 0.804167),
    holeH: num('holeH', 0.905993),
    fit: root.dataset.fit || 'cover',        // cover | width | contain
    anchor: root.dataset.anchor || 'top',    // top | center
    plate: root.dataset.plate || '',   // canvas behind the slide; empty =
                                       // each card uses its own --mw-color
    asmGate: num('asmGate', 0.62),     // openness at which assembly starts
    asmRate: num('asmRate', 0.10),     // how quickly it resolves

    /* chrome */
    frameGap: num('frameGap', 14),
    landedVel: num('landedVel', 1.4),  // |ov| below this counts as landed
    landedDist: num('landedDist', 0.06),
    radius: num('radius', 4),
    checker: root.dataset.checker !== 'false',
  };

  /* ---------- state ---------- */
  let current = 0, target = 0, velocity = 0, prevCurrent = 0, vSmooth = 0;
  let hovered = -1, activeIndex = -1, isOpen = false;
  let o = 0, ov = 0, oTarget = 0;                    // the flight spring
  let asm = 0;                                       // UI assembly, 0..1
  const artRect = [0.5, 0.5, 1, 1];
  let rowFrom = null, rowTo = 0;
  let landed = false, landedT = 0, tipT = 0, closeT = 0;
  let pointerX = -1e5, pointerOn = false;
  let dragging = false, pointerId = null, lastX = 0, travel = 0, downCard = -1, wheelLock = 0;
  let cardW = 0, cardH = 0, stageW = 0, stageH = 0, openScale = 1;
  let kbd = false;   // was the last interaction keyboard-driven?
  let running = false, raf = 0, lastT = 0, accum = 0;
  let destroyed = false;
  const H = 1 / 120;                                 // sim substep

  let gl = reduced ? null : new GlLayer(stage, cfg.persp);
  let useGl = !!(gl && gl.ok);
  let glRetries = 0;
  if (gl) gl.onTexture = () => wake();   // a late image must redraw a parked loop

  const nodeBuf = new Float32Array(MAX_NODES * 3);
  const pt = new Float32Array(3);

  cards.forEach((c, ci) => {
    c._op = 1; c._amp = cfg.softAmp; c._lift = 0; c._oi = 0;
    c._mat = new Float32Array(16);
    c._chain = new ClothChain(cfg.nodes);
    c._chain.phase = ci * 2.399;   // golden-angle spread of the ripple
    c._parked = true;   // snap to slots on the first laid-out frame
    // Webflow cards are divs — give them the affordances the reference
    // markup gets from being a <button>
    if (!c.matches('button, a') && !c.hasAttribute('tabindex')) {
      c.setAttribute('tabindex', '0');
      c.setAttribute('role', 'button');
      const label = c.querySelector('[data-webgl-title], .webgl_cards_poject');
      if (label && !c.getAttribute('aria-label')) c.setAttribute('aria-label', label.textContent.trim());
    }
  });
  setMediaHidden(useGl);
  if (gl) attachGlHandlers(gl);

  // the DOM media is the fallback face of a card: hidden while the GL
  // layer is drawing, shown again the moment it isn't
  function setMediaHidden(hidden) {
    if (hidden) root.dataset.mwGl = '1';
    else delete root.dataset.mwGl;
    cards.forEach((c) => {
      const media = c.querySelector('[data-mw="media"]');
      if (media) media.style.visibility = hidden ? 'hidden' : '';
      // Webflow cards have no media wrapper; the images themselves are
      // the source for the textures and must not also be painted
      // 'visible', not '': the injected CSS hides them by default, so the
      // fallback has to say so explicitly
      c.querySelectorAll('[data-webgl-image], [data-webgl-overlay]')
        .forEach((im) => { im.style.visibility = hidden ? 'hidden' : 'visible'; });
    });
  }

  function attachGlHandlers(layer) {
    layer.onLost = () => {
      useGl = false;
      setMediaHidden(false);     // degrade to DOM cards rather than blank
      wake();
    };
    layer.onRestored = () => {
      if (destroyed || glRetries >= 3) return;
      glRetries++;
      // reuse the restored context — asking for a brand new one while the
      // browser is mid-restore just fails. reset the state cache, then
      // measure() rebuilds every GL object on it.
      useGl = layer.resetGlState();
      if (!useGl) return;
      setMediaHidden(true);
      builtKey = '';
      measure();
      cards.forEach((c) => { c._parked = true; });
      wake();
    };
  }
  if (totalEl) totalEl.textContent = String(n).padStart(2, '0');

  /* ---------- measure ---------- */
  function measure() {
    stage.style.setProperty('--mw-perspective', cfg.persp + 'px');
    cardW = cards[0].offsetWidth;
    cardH = cards[0].offsetHeight;
    stageW = stage.clientWidth;
    stageH = stage.clientHeight;

    /* Centre the cards explicitly rather than relying on the stage being a
       centring flexbox: any Webflow display value breaks that, and the DOM
       cards — which are the hit areas — then sit somewhere the WebGL cards
       are not, so hovering picks a card two or three along. */
    cards.forEach((c) => {
      c.style.left = '50%';
      c.style.top = '50%';
      c.style.marginLeft = (-cardW / 2) + 'px';
      c.style.marginTop = (-cardH / 2) + 'px';
    });

    const margin = clamp(stageW * 0.07, 28, 96) + cfg.frameGap;
    openScale = Math.min((stageW - margin * 2) / cardW, (stageH - margin * 2) / cardH);

    layoutChrome();
    if (useGl) {
      gl.resize(stageW, stageH, cfg.persp);
      // textures + geometry survive height-only resizes (mobile URL bar)
      const key = cardW + 'x' + cardH + 'x' + cfg.nodes;
      if (key !== builtKey) {
        builtKey = key;
        gl.plateOverride = cfg.plate ? cssColor(cfg.plate) : null;
        gl.buildCards(cards, cfg.nodes, cardW, cardH, cfg.radius);
      }
      gl.loadChrome(cfg.uiSrc, wake);
      gl.items.forEach((it) => { it.program.uniforms.uChecker.value = cfg.checker ? 1 : 0; });
    }
    wake();
  }
  let builtKey = '';

  function layoutChrome() {
    const w = cardW * openScale, h = cardH * openScale;
    if (tipLayer) {
      // exactly the landed card: the tags position against this
      tipLayer.style.width = w + 'px';
      tipLayer.style.height = h + 'px';
      tipLayer.style.marginLeft = -(w / 2) + 'px';
      tipLayer.style.marginTop = -(h / 2) + 'px';
    } else if (globalTip) {
      globalTip.style.left = 'calc(50% + ' + (w / 2 - 14) + 'px)';
      globalTip.style.top = 'calc(50% + ' + (h / 2 - 14) + 'px)';
    }
  }

  /* where the slide sits inside the card at assembly `a`, in card uv
     (y up). one uniform scale for both axes — the slide and the card
     share an aspect, so the only mismatch is against the hole, and that
     resolves as a crop or a strip of canvas, never a stretch. */
  function artRectAt(a) {
    const hx = cfg.holeX, hw = cfg.holeW, hh = cfg.holeH;
    const s = cfg.fit === 'cover' ? Math.max(hw, hh)
      : cfg.fit === 'contain' ? Math.min(hw, hh)
        : hw;                                  // 'width', how a real canvas behaves
    const holeTop = 1 - cfg.holeY;             // hole y is measured from the top
    const cx = hx + hw / 2;
    // pinning to the canvas top reads like a page in a Designer viewport;
    // centring reads like an image placed in a frame
    const cy = cfg.anchor === 'top' ? holeTop - s / 2 : holeTop - hh / 2;
    artRect[0] = lerp(0.5, cx, a);
    artRect[1] = lerp(0.5, cy, a);
    artRect[2] = lerp(1, s, a);
    artRect[3] = lerp(1, s, a);
    return artRect;
  }

  function relOf(i) {
    let rel = i - current;
    if (cfg.loop) rel = ((rel + n / 2) % n + n) % n - n / 2;
    return rel;
  }

  /* ---------- frame ---------- */
  function tick(now) {
    if (destroyed) return;
    // one bad frame must not kill the loop for the rest of the session
    try {
      frameBody(now);
    } catch (err) {
      console.warn('[mw-slider] frame error', err);
      raf = requestAnimationFrame(tick);
    }
  }

  function frameBody(now) {
    const dt = clamp((now - lastT) / 1000, 0.001, 0.05);
    lastT = now;
    const f60 = dt * 60;
    const kOf = (k) => 1 - Math.pow(1 - k, f60);   // frame-rate independent lerp

    /* -- one clock: the openness spring. un-clamped, so arrival
       overshoots the rest pose and settles — requirement 4 for free. */
    let flightActive = activeIndex >= 0;
    if (flightActive) {
      if (reduced) { o = oTarget; ov = 0; }
      else {
        ov += (cfg.springK * (oTarget - o) - cfg.springD * ov) * dt;
        o += ov * dt;
      }
      if (rowFrom !== null) current = rowFrom + (rowTo - rowFrom) * clamp01(o);

      if (isOpen && !landed && Math.abs(o - 1) < cfg.landedDist && Math.abs(ov) < cfg.landedVel) {
        landed = true;
      }
      if (!isOpen && o < 0.002 && Math.abs(ov) < 0.05) {
        o = 0; ov = 0;
        if (rowFrom !== null) { current = rowTo; rowFrom = null; }
        activeIndex = -1;
        flightActive = false;
      }
    }

    /* -- row inertia + settle (prototype, dt-corrected) */
    if (!dragging && activeIndex < 0) {
      if (Math.abs(velocity) > 0.0015) {
        target += velocity * f60;
        velocity *= Math.pow(cfg.friction, f60);
      } else {
        velocity = 0;
        target += (Math.round(target) - target) * (reduced ? 1 : kOf(0.16));
      }
    }
    if (!cfg.loop) target = clamp(target, 0, n - 1);
    if (!(flightActive && rowFrom !== null)) current += (target - current) * kOf(cfg.lerp);

    const frameVel = (current - prevCurrent) / f60;
    prevCurrent = current;
    vSmooth += (frameVel - vSmooth) * kOf(0.25);

    /* -- UI assembly. deliberately starts BEFORE the flight settles: the
       slide retreats into the canvas while the card is still folding, so
       the material motion covers the swap instead of it reading as a
       separate step. on close it lets go the moment the card leaves. */
    const asmWant = (isOpen && activeIndex >= 0 && clamp01(o) > cfg.asmGate) ? 1 : 0;
    asm += (asmWant - asm) * (reduced ? 1 : kOf(cfg.asmRate));
    const asmAwake = Math.abs(asm - asmWant) > 0.002;

    /* -- chrome clocks: the tip arrives once the card reads as landed */
    const landedWant = landed ? 1 : 0;
    landedT += (landedWant - landedT) * (reduced ? 1 : kOf(0.14));
    const tipWant = landedT > 0.75 && landed ? 1 : 0;
    tipT += (tipWant - tipT) * (reduced ? 1 : kOf(0.16));
    const closeWant = flightActive && (isOpen ? clamp01(o) > 0.45 : clamp01(o) > 0.6) ? 1 : 0;
    closeT += (closeWant - closeT) * (reduced ? 1 : kOf(0.2));

    /* -- per-card rigid layout -> matrices -> slots -> sim */
    const spacingPx = cardW * cfg.spacing;
    const oc = clamp01(o);
    const w = clamp(vSmooth * cfg.waveGain, -1, 1) * (1 - oc);
    const tSkew = Math.pow(oc, cfg.skewPow);
    const tScale = o <= 0 ? 0 : o <= 1 ? Math.pow(o, cfg.scalePow) : 1 + (o - 1) * 0.6;

    let simAwake = false, opAwake = false;
    let nearestF = 0, nearestI = -1;

    // hover only while the row is genuinely at rest — a glide after a
    // fling under a stationary cursor must not flicker the dim states
    const rowStill = !dragging && activeIndex < 0 &&
      Math.abs(velocity) < 0.002 && Math.abs(target - current) < 0.02;

    // proximity pass first, so dim can key off the closest card
    if (pointerOn && rowStill) {
      for (let i = 0; i < n; i++) {
        const rel = relOf(i);
        if (Math.abs(rel) > cfg.visible) continue;
        const cx = stageW / 2 + rel * spacingPx;
        const f = clamp01(1 - Math.abs(pointerX - cx) / (cfg.hoverRadius * cardW));
        if (f > nearestF) { nearestF = f; nearestI = i; }
      }
    }

    for (let i = 0; i < n; i++) {
      const card = cards[i];
      const ideal = relOf(i);
      const active = i === activeIndex;

      // trailing chase (prototype): each card chases its slot, outer
      // cards more slowly, snap across the loop seam
      if (card._rel === undefined || Math.abs(ideal - card._rel) > n / 2) card._rel = ideal;
      const norm = clamp01(Math.abs(ideal) / cfg.visible);
      const chase = active ? 1 : cfg.chase * (1 - cfg.lag * norm);
      card._rel += (ideal - card._rel) * (reduced ? 1 : kOf(chase));
      const rel = card._rel;

      const hidden = Math.abs(ideal) > cfg.visible && !active;
      if (hidden) {
        if (card.style.visibility !== 'hidden') {
          card.style.visibility = 'hidden';
          card._chain.snap();
        }
        if (useGl && gl.items[i]) gl.items[i].mesh.visible = false;
        continue;
      }
      if (card.style.visibility === 'hidden') {
        card.style.visibility = '';
        card._parked = true;                 // snap chain once slots are fresh
      }
      if (useGl && gl.items[i]) gl.items[i].mesh.visible = true;

      let x, y, z, ry, rz, sk, s;

      if (active) {
        x = rel * spacingPx * (1 - o);       // raw o: sails slightly past centre
        y = 0;
        // starts on the row's own depth ramp (so there is no pop out of
        // the stack), then: open lifts toward the viewer FAST and early
        // (pow < 1) so nothing in the row can crop it on the way front;
        // close recedes on a cubic, dropping behind the card in front
        // well before their footprints overlap, so it slides back in.
        z = -rel * cfg.zGap + cfg.openZ * Math.pow(Math.max(0, o), isOpen ? 0.6 : 3);
        ry = 0; rz = 0;
        sk = cfg.skewY * (1 - tSkew);
        s = lerp(1, openScale, tScale);
      } else {
        const oi = oc === 0 ? 0 : Math.pow(oc, 1 + Math.min(Math.abs(rel), 5) * 0.14);
        card._oi = oi;
        const phase = rel * cfg.waveFreq;

        // proximity lift, blended so it never steps
        const cx = stageW / 2 + rel * spacingPx;
        const f = (pointerOn && rowStill)
          ? clamp01(1 - Math.abs(pointerX - cx) / (cfg.hoverRadius * cardW)) : 0;
        card._lift += (f * f * cfg.hoverLift - card._lift) * kOf(0.18);

        x = rel * spacingPx + (activeIndex >= 0 ? Math.sign(rel || 1) * spacingPx * cfg.push * oi : 0);
        y = Math.sin(phase) * w * cfg.waveAmp - card._lift;
        z = -rel * cfg.zGap;
        ry = -w * cfg.waveTurn;
        rz = Math.cos(phase) * w * cfg.waveTilt;
        sk = cfg.skewY;
        s = 1 - Math.abs(w) * 0.02;
        if (Math.abs(card._lift) > 0.05) opAwake = true;
      }

      composeCardMatrix(card._mat, rz, ry, x, y, z, sk, s);
      card._z = z;   // the INTENDED depth; see the renderOrder note below

      /* slots: the rigid transform sampled along the card's midline.
         includes scale, so opening spreads the slots and the chain
         has to catch up — the centre-card bloom is just this. */
      const chain = card._chain;
      for (let j = 0; j < chain.n; j++) {
        const lx = (j / (chain.n - 1) - 0.5) * cardW;
        transformPoint(card._mat, lx, 0, pt);
        chain.slotX[j] = pt[0];
        chain.slotZ[j] = pt[2];
      }
      if (card._parked) { chain.snap(); card._parked = false; }
      chain.computeSlotVel(dt);

      // opacity: hover dim / open dim. ONE focused card: the DOM-hovered
      // card wins (it's what the cursor is actually on, overlaps included),
      // proximity is only the fallback — two systems disagreeing here is
      // how you dim everything at once and highlight nothing.
      let wanted = 1;
      if (activeIndex >= 0) {
        wanted = active ? 1 : lerp(1, 0.08, card._oi || 0);
      } else if (rowStill) {
        const focus = hovered >= 0 ? hovered : nearestI;
        const strength = hovered >= 0 ? 1 : nearestF;
        if (focus >= 0 && focus !== i) wanted = lerp(1, cfg.hoverDim, strength);
      }
      card._op = reduced ? wanted : lerp(card._op, wanted, kOf(0.16));
      if (Math.abs(card._op - wanted) > 0.004) opAwake = true;

      // material amplitude: whisper in the row, full on the flight
      const ampWant = active ? 1 : cfg.softAmp;
      card._amp += (ampWant - card._amp) * kOf(0.2);

      // DOM card keeps the same transform for hit area + focus (and
      // is the whole visual in the reduced / no-GL fallback)
      card.style.transform =
        'rotateZ(' + rz.toFixed(2) + 'deg)' +
        ' rotateY(' + ry.toFixed(2) + 'deg)' +
        ' translate3d(' + x.toFixed(2) + 'px,' + y.toFixed(2) + 'px,' + z.toFixed(2) + 'px)' +
        ' skewY(' + sk.toFixed(2) + 'deg)' +
        ' scale3d(' + s.toFixed(4) + ',' + s.toFixed(4) + ',' + s.toFixed(4) + ')';
      if (!useGl) card.style.opacity = card._op.toFixed(3);
      card.style.zIndex = active ? 600 : String(Math.round(400 - rel * 10));
      card.style.pointerEvents = (activeIndex >= 0 && !active) ? 'none' : 'auto';
    }

    /* -- material step, fixed substeps */
    if (!reduced) {
      accum = Math.min(accum + dt, H * 5);
      while (accum >= H) {
        accum -= H;
        for (let i = 0; i < n; i++) {
          const card = cards[i];
          if (card.style.visibility === 'hidden') continue;
          card._chain.step(H, cfg);
        }
      }
      for (let i = 0; i < n; i++) {
        if (cards[i].style.visibility !== 'hidden' && !cards[i]._chain.settled) simAwake = true;
      }
    }

    /* -- push to GL */
    if (useGl) {
      for (let i = 0; i < n; i++) {
        const card = cards[i], it = gl.items[i];
        if (!it || !it.mesh.visible) continue;
        const u = it.program.uniforms;
        u.uModel.value.set(card._mat);
        card._chain.writeOffsets(nodeBuf, card._amp, cfg.shade);
        const arr = u.uNodes.value;                  // plain Array, see gl.js
        for (let k = 0, m = card._chain.n * 3; k < m; k++) arr[k] = nodeBuf[k];
        u.uNodeCount.value = card._chain.n;
        u.uAlpha.value = card._op;
        u.uTagAlpha.value = i === activeIndex ? 1 - clamp01(oc * 2) : 1;

        // only the opened card becomes the Designer window
        const a = i === activeIndex ? asm : 0;
        u.uAssembly.value = a;
        const r = artRectAt(a);
        const ar = u.uArtRect.value;
        ar[0] = r[0]; ar[1] = r[1]; ar[2] = r[2]; ar[3] = r[3];
        const hr = u.uHole.value;                   // uv space, y up
        hr[0] = cfg.holeX; hr[1] = 1 - cfg.holeY - cfg.holeH;
        hr[2] = cfg.holeW; hr[3] = cfg.holeH;

        // stacking = sort by the card's intended depth, active card
        // included. in the row this reproduces left-over-right exactly
        // (z is -rel * zGap, monotonic in rel); on a flight the opening
        // card climbs the stack going front and drops back through it in
        // order coming back, so it slides in BEHIND the cards that read
        // as in front. NOT the composite matrix's z element: the wave's
        // rotateY mixes the card's large x offset into it, which on a
        // hard drag swamps the slot gap and scrambles the whole stack.
        it.mesh.renderOrder = Math.round(500 + card._z * 8);
      }
      gl.render();
    }

    /* -- chrome + fades */
    backdrop.style.opacity = (oc * 0.92).toFixed(3);
    if (headEl) headEl.style.opacity = (1 - oc).toFixed(3);
    if (countEl) countEl.style.opacity = (1 - oc).toFixed(3);
    if (activeTip) {
      activeTip.style.opacity = tipT.toFixed(3);
      // the entrance rides the holder, never the authored tag, so its own
      // transform / position survive untouched
      activeTip.style.transform = tipLayer
        ? 'translateY(' + ((1 - tipT) * 8).toFixed(2) + 'px)'
        : 'translate(-100%,-100%) translateY(' + ((1 - tipT) * 8).toFixed(2) + 'px)';
      activeTip.style.pointerEvents = tipT > 0.6 ? 'auto' : 'none';
    }
    // per-card closes ride their holder's fade; only global ones need driving
    globalCloses.forEach((c) => {
      c.style.opacity = closeT.toFixed(3);
      c.style.pointerEvents = closeT > 0.5 ? 'auto' : 'none';
    });
    if (closeBtn && !globalCloses.includes(closeBtn)) {
      closeBtn.style.opacity = closeT.toFixed(3);
      closeBtn.style.pointerEvents = closeT > 0.5 ? 'auto' : 'none';
    }

    const idx = ((Math.round(current) % n) + n) % n;
    if (indexEl) indexEl.textContent = String(idx + 1).padStart(2, '0');

    /* -- park when everything is genuinely still */
    const rowAwake = dragging || Math.abs(velocity) > 0.0015 ||
      Math.abs(target - current) > 0.0008 || Math.abs(vSmooth) > 0.0004;
    const chromeAwake = Math.abs(landedT - landedWant) > 0.004 ||
      Math.abs(tipT - tipWant) > 0.004 || Math.abs(closeT - closeWant) > 0.004;
    if (rowAwake || flightActive || simAwake || opAwake || chromeAwake || asmAwake) {
      cancelAnimationFrame(raf);    // never let two loops accumulate
      raf = requestAnimationFrame(tick);
    } else {
      running = false;
      if (useGl) gl.render();       // one last clean frame
    }
  }

  function wake() {
    if (running || destroyed) return;
    running = true;
    lastT = performance.now();
    raf = requestAnimationFrame(tick);
  }

  /* ---------- open / close ---------- */
  function openCard(i) {
    if (i < 0) return;
    if (isOpen) return;
    if (activeIndex >= 0 && activeIndex !== i) return;   // still closing another
    isOpen = true;
    activeIndex = i;
    hovered = -1;
    velocity = 0;
    landed = false;
    oTarget = 1;
    rowFrom = current;
    rowTo = current + relOf(i);
    target = rowTo;

    // a Webflow card brings its own tag block; the reference markup has
    // one shared tip that gets filled from the card's data attributes
    activeTip = tipHolders[i] || globalTip;
    if (activeTip === globalTip && globalTip) {
      const d = cards[i].dataset;
      if (tipSwatch) tipSwatch.style.background = getComputedStyle(cards[i]).getPropertyValue('--mw-color');
      if (tipTitle) tipTitle.textContent = d.title || '';
      if (tipBy) {
        tipBy.textContent = d.by ? 'by ' + d.by : '';
        tipBy.href = d.href || '#';
        tipBy.style.display = d.by ? '' : 'none';
      }
    }

    root.setAttribute('data-mw-open', '');
    // Only chase focus for keyboard users. Moving focus after a click makes
    // the browser paint a focus ring around the card, which reads as a thin
    // white border around the artwork.
    const focusTarget = cardCloses[i] || closeBtn;
    if (kbd && focusTarget) focusTarget.focus({ preventScroll: true });
    wake();
  }

  function closeCard() {
    if (!isOpen) return;
    isOpen = false;
    landed = false;
    oTarget = 0;                        // same spring, retargeted: an
    rowFrom = null;                     // interrupt is continuous by construction
    root.removeAttribute('data-mw-open');
    if (kbd) cards[activeIndex].focus({ preventScroll: true });
    wake();
  }

  /* ---------- input ---------- */
  const onWheel = (e) => {
    if (isOpen) return;
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (Math.abs(delta) < 4) return;
    e.preventDefault();
    const now = performance.now();
    if (now < wheelLock) return;
    wheelLock = now + 210;
    velocity = 0;
    target = Math.round(target) + Math.sign(delta);
    wake();
  };

  const onDown = (e) => {
    kbd = false;
    if (isOpen || e.button !== 0) return;
    const hit = e.target.closest('[data-mw="card"]');
    downCard = hit ? cards.indexOf(hit) : -1;
    dragging = true;
    pointerId = e.pointerId;
    lastX = e.clientX;
    travel = 0;
    velocity = 0;
    hovered = -1;
    stage.setAttribute('data-mw-dragging', '');
    addEventListener('pointermove', onMove);
    addEventListener('pointerup', onUp);
    addEventListener('pointercancel', onUp);
    wake();
  };

  function onMove(e) {
    if (!dragging || e.pointerId !== pointerId) return;
    const dx = e.clientX - lastX;
    lastX = e.clientX;
    travel += Math.abs(dx);
    const step = dx / (cardW * cfg.spacing);
    target -= step;
    velocity = clamp(velocity * 0.55 + (-step) * 0.45, -0.34, 0.34);
  }

  function onUp(e) {
    if (e.pointerId !== pointerId) return;
    const card = downCard, tapped = travel < 6;
    dragging = false;
    pointerId = null;
    downCard = -1;
    stage.removeAttribute('data-mw-dragging');
    removeEventListener('pointermove', onMove);
    removeEventListener('pointerup', onUp);
    removeEventListener('pointercancel', onUp);
    if (tapped && card >= 0 && !isOpen && e.type === 'pointerup' && e.pointerType !== 'mouse') {
      openCard(card);
    }
  }

  const onStageMove = (e) => {
    const r = stage.getBoundingClientRect();
    pointerX = e.clientX - r.left;
    pointerOn = true;
    wake();
  };
  const onStageLeave = () => { pointerOn = false; hovered = -1; wake(); };

  const cardHandlers = cards.map((card, i) => {
    const enter = () => { if (!dragging && !isOpen) { hovered = i; wake(); } };
    const leave = () => { if (hovered === i) { hovered = -1; wake(); } };
    const click = (e) => {
      e.preventDefault();
      if (travel > 6 || isOpen) return;
      openCard(i);
    };
    const key = (e) => {
      if (e.key === 'Enter' || e.key === ' ') { kbd = true; e.preventDefault(); openCard(i); }
    };
    card.addEventListener('pointerenter', enter);
    card.addEventListener('pointerleave', leave);
    card.addEventListener('click', click);
    card.addEventListener('keydown', key);
    return { enter, leave, click, key };
  });

  const onKey = (e) => {
    kbd = true;
    if (e.key === 'Escape' && isOpen) { closeCard(); return; }
    if (isOpen) return;
    if (e.key === 'ArrowRight') { velocity = 0; target = Math.round(target) + 1; wake(); }
    if (e.key === 'ArrowLeft') { velocity = 0; target = Math.round(target) - 1; wake(); }
  };

  const onResize = () => measure();
  // rAF is suspended in hidden tabs; make sure we resume cleanly
  const onVis = () => { if (!document.hidden) { lastT = performance.now(); wake(); } };

  stage.addEventListener('wheel', onWheel, { passive: false });
  stage.addEventListener('pointerdown', onDown);
  stage.addEventListener('pointermove', onStageMove);
  stage.addEventListener('pointerleave', onStageLeave);
  backdrop.addEventListener('click', closeCard);
  // stopPropagation: a close authored inside the card would otherwise bubble
  // to the card's own click handler and immediately reopen it
  const onCloseClick = (e) => { e.preventDefault(); e.stopPropagation(); closeCard(); };
  closeAll.forEach((c) => c.addEventListener('click', onCloseClick));
  if (closeBtn && !closeAll.includes(closeBtn)) closeBtn.addEventListener('click', onCloseClick);
  addEventListener('keydown', onKey);
  addEventListener('resize', onResize);
  document.addEventListener('visibilitychange', onVis);

  /* ---------- instance api ---------- */
  const inst = {
    root, cfg, gl,
    set(key, value) {
      cfg[key] = value;
      if (key === 'frameGap') measure();
      if (key === 'radius' && useGl) {
        gl.items.forEach((it) => { it.program.uniforms.uRadius.value = value; });
      }
      if (key === 'perspective' || key === 'persp') { cfg.persp = value; measure(); }
      if (key === 'nodes') {
        cfg.nodes = clamp(Math.round(value), 8, MAX_NODES);
        cards.forEach((c, ci) => { c._chain.resize(cfg.nodes); c._chain.phase = ci * 2.399; c._parked = true; });
        if (useGl) measure();
      }
      if (key === 'plate' && useGl) gl.setPlate(value ? cssColor(value) : null);
      if (key === 'uiSrc' && useGl) { gl.chromeUrl = null; gl.loadChrome(value, wake); }
      if (key === 'checker' && useGl) {
        gl.items.forEach((it) => { it.program.uniforms.uChecker.value = value ? 1 : 0; });
      }
      wake();
    },
    open: openCard,
    close: closeCard,
    // manual clock for tests / headless tabs: advances one frame of `ms`
    debugStep(ms) { frameBody(lastT + (ms || 16.7)); },
    state() {
      return { o, ov, current, target, velocity, activeIndex, isOpen, landed, running, landedT, tipT };
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      cancelAnimationFrame(raf);
      stage.removeEventListener('wheel', onWheel);
      stage.removeEventListener('pointerdown', onDown);
      stage.removeEventListener('pointermove', onStageMove);
      stage.removeEventListener('pointerleave', onStageLeave);
      backdrop.removeEventListener('click', closeCard);
      closeAll.forEach((c) => c.removeEventListener('click', onCloseClick));
      if (closeBtn) closeBtn.removeEventListener('click', onCloseClick);
      removeEventListener('keydown', onKey);
      removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVis);
      removeEventListener('pointermove', onMove);
      removeEventListener('pointerup', onUp);
      removeEventListener('pointercancel', onUp);
      cardHandlers.forEach((h, i) => {
        cards[i].removeEventListener('pointerenter', h.enter);
        cards[i].removeEventListener('pointerleave', h.leave);
        cards[i].removeEventListener('click', h.click);
        cards[i].removeEventListener('keydown', h.key);
        const media = cards[i].querySelector('[data-mw="media"]');
        if (media) media.style.visibility = '';
        cards[i].style.opacity = '';
      });
      // put the tag blocks back where Webflow authored them
      // put every lifted element back; the module never styled them, so
      // there is nothing to reset
      if (tipLayer) {
        tipLayer.querySelectorAll('[data-webgl-tag], .webgl_cards_tag, [data-webgl-pin], [data-webgl-close], [data-mw="close"]')
          .forEach((t) => { if (t._mwHome) { t._mwHome.appendChild(t); delete t._mwHome; } });
        tipLayer.remove();
      }
      if (wf) {
        // only remove chrome the module created, never anything authored
        if (backdrop && backdrop.dataset.mwMade) backdrop.remove();
        if (closeBtn && closeBtn.dataset.mwMade) closeBtn.remove();
        root.removeAttribute('data-mw-dragging');
      }
      if (gl) gl.dispose();
      delete root.dataset.mwInit;
      delete root._mw;
    },
  };
  root._mw = inst;

  measure();
  wake();
  return inst;
}

/* The Webflow tree only carries content and styling, so the module
   supplies the layout it depends on. Everything is behind a CSS var with
   a fallback, so a Webflow class can still override it. */
let cssDone = false;
function injectCss() {
  if (cssDone) return;
  cssDone = true;
  const card = 'var(--mw-card-w, clamp(240px, 26cqw, 620px))';
  const s = document.createElement('style');
  s.textContent = `
[data-webgl-canvas]{position:relative;display:flex;align-items:center;justify-content:center;
  min-height:var(--mw-stage-h,100svh);overflow:clip;container-type:inline-size;
  perspective:var(--mw-perspective,2200px);cursor:grab;user-select:none;-webkit-user-select:none;touch-action:pan-y}
[data-webgl-canvas][data-mw-dragging]{cursor:grabbing}
[data-webgl-canvas] [data-webgl-item]{position:absolute;margin:0;padding:0;border:0;background:none;
  width:${card};height:calc(${card} * 851 / 1440);transform-origin:50% 50%;cursor:pointer;outline:none}
[data-webgl-canvas] [data-webgl-item]:focus-visible{outline:var(--mw-focus, 2px solid currentColor);outline-offset:4px}
[data-webgl-canvas] [data-webgl-item] > *{width:100%;height:100%}
/* hidden up front so the raw stacked images never flash before init;
   the no-WebGL fallback sets visibility:visible inline, which wins */
[data-webgl-canvas] [data-webgl-item] img{width:100%;height:100%;object-fit:cover;display:block;visibility:hidden}
[data-webgl-canvas] [data-webgl-item] [data-webgl-image]{position:absolute;inset:0}
/* transparent by default: a guessed colour is a white sheet on a dark site.
   Set --mw-backdrop to dim the row behind an open card. */
[data-webgl-canvas] .mw-backdrop{position:absolute;inset:0;z-index:500;opacity:0;pointer-events:none;
  background:var(--mw-backdrop, transparent)}
[data-mw-open] .mw-backdrop{pointer-events:auto}
/* sized to the open card, so a tag authored absolute against the image
   lands exactly where it was designed */
[data-webgl-canvas] .mw-tip-layer{position:absolute;left:50%;top:50%;z-index:640;pointer-events:none}
[data-webgl-canvas] .mw-tip-hold{position:absolute;inset:0;opacity:0;pointer-events:none}
.mw-close{position:absolute;top:clamp(16px,3svh,34px);right:clamp(16px,3cqw,34px);z-index:800;
  width:42px;height:42px;border-radius:50%;border:1px solid rgba(0,0,0,.15);background:#fff;color:#101010;
  display:grid;place-items:center;cursor:pointer;opacity:0;pointer-events:none;transition:transform .3s ease}
.mw-close:hover{transform:rotate(90deg)}
.mw-close svg{width:15px;height:15px}`;
  // FIRST in head, not last: these are defaults the module needs to work,
  // and every one of them must lose to a Webflow class. Appending instead
  // means the module quietly overrides the design — e.g. forcing the
  // canvas back to position:relative when it was authored absolute.
  document.head.prepend(s);

  /* The one exception, appended so it wins: the class shells exist only to
     keep descendant selectors matching, so they must contribute no geometry
     of their own — otherwise the card class's own width or layout would
     re-anchor whatever was pinned inside them. */
  const scaffold = document.createElement('style');
  scaffold.textContent = `
/* mechanics, not design: cards must be absolutely placed for the module to
   position them, and while WebGL is drawing them the DOM copy must paint
   nothing — otherwise a background on the card or its wrapper shows through
   as a plain rectangle behind the flying card */
[data-webgl-canvas] [data-webgl-item]{position:absolute!important}
[data-mw-gl] [data-webgl-item]:not(:focus-visible){background:none!important;border:0!important;
  box-shadow:none!important;outline:0!important}
[data-mw-gl] [data-webgl-item] > *{visibility:hidden!important}
[data-mw-shell]{position:absolute!important;inset:0!important;
  width:auto!important;height:auto!important;min-width:0!important;min-height:0!important;
  margin:0!important;padding:0!important;border:0!important;background:none!important;
  transform:none!important;display:block!important;overflow:visible!important;opacity:1!important}`;
  document.head.appendChild(scaffold);
}

export function initAll(scope) {
  const out = [];
  (scope || document).querySelectorAll('[data-mw="root"], [data-webgl-canvas]').forEach((r) => {
    const i = init(r);
    if (i) out.push(i);
  });
  return out;
}
