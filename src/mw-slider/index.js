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

  const stage = root.querySelector('[data-mw="stage"]');
  const backdrop = root.querySelector('[data-mw="backdrop"]');
  const frame = root.querySelector('[data-mw="frame"]');
  const tip = root.querySelector('[data-mw="tip"]');
  const tipSwatch = root.querySelector('[data-mw="swatch"]');
  const tipTitle = root.querySelector('[data-mw="tip-title"]');
  const tipBy = root.querySelector('[data-mw="tip-by"]');
  const closeBtn = root.querySelector('[data-mw="close"]');
  const headEl = root.querySelector('[data-mw="head"]');
  const countEl = root.querySelector('[data-mw="counter"]');
  const indexEl = root.querySelector('[data-mw="index"]');
  const totalEl = root.querySelector('[data-mw="total"]');
  const cards = Array.from(stage.querySelectorAll('[data-mw="card"]'));
  const n = cards.length;
  if (!n) return null;

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
    fit: root.dataset.fit || 'width',        // width | contain | cover
    anchor: root.dataset.anchor || 'top',    // top | center
    plate: root.dataset.plate || '',   // canvas behind the slide; empty =
                                       // each card uses its own --mw-color
    asmGate: num('asmGate', 0.62),     // openness at which assembly starts
    asmRate: num('asmRate', 0.10),     // how quickly it resolves
    asmWipe: num('asmWipe', 1),        // 1 = reveal the UI, 0 = cross-fade it

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
  const wipeRect = [0.5, 0.5, 1, 1];
  let rowFrom = null, rowTo = 0;
  let landed = false, frameT = 0, tipT = 0, closeT = 0;
  let pointerX = -1e5, pointerOn = false;
  let dragging = false, pointerId = null, lastX = 0, travel = 0, downCard = -1, wheelLock = 0;
  let cardW = 0, cardH = 0, stageW = 0, stageH = 0, openScale = 1;
  let running = false, raf = 0, lastT = 0, accum = 0;
  let destroyed = false;
  const H = 1 / 120;                                 // sim substep

  let gl = reduced ? null : new GlLayer(stage, cfg.persp);
  let useGl = !!(gl && gl.ok);
  let glRetries = 0;

  const nodeBuf = new Float32Array(MAX_NODES * 3);
  const pt = new Float32Array(3);

  cards.forEach((c, ci) => {
    c._op = 1; c._amp = cfg.softAmp; c._lift = 0; c._oi = 0;
    c._mat = new Float32Array(16);
    c._chain = new ClothChain(cfg.nodes);
    c._chain.phase = ci * 2.399;   // golden-angle spread of the ripple
    c._parked = true;   // snap to slots on the first laid-out frame
  });
  setMediaHidden(useGl);
  if (gl) attachGlHandlers(gl);

  // the DOM media is the fallback face of a card: hidden while the GL
  // layer is drawing, shown again the moment it isn't
  function setMediaHidden(hidden) {
    cards.forEach((c) => {
      const media = c.querySelector('[data-mw="media"]');
      if (media) media.style.visibility = hidden ? 'hidden' : '';
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
    const w = cardW * openScale, h = cardH * openScale, g = cfg.frameGap;
    frame.style.width = (w + g * 2) + 'px';
    frame.style.height = (h + g * 2) + 'px';
    frame.style.marginLeft = -(w / 2 + g) + 'px';
    frame.style.marginTop = -(h / 2 + g) + 'px';
    tip.style.left = 'calc(50% + ' + (w / 2 - 14) + 'px)';
    tip.style.top = 'calc(50% + ' + (h / 2 - 14) + 'px)';
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

    // the chrome is revealed by the hole closing in from the card edges,
    // which is independent of how the slide is fitted inside it
    wipeRect[0] = lerp(0.5, hx + hw / 2, a);
    wipeRect[1] = lerp(0.5, holeTop - hh / 2, a);
    wipeRect[2] = lerp(1, hw, a);
    wipeRect[3] = lerp(1, hh, a);
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

    /* -- chrome clocks: frame after landing, tip after frame */
    const frameWant = landed ? 1 : 0;
    frameT += (frameWant - frameT) * (reduced ? 1 : kOf(0.14));
    const tipWant = frameT > 0.75 && landed ? 1 : 0;
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
        u.uAsmWipe.value = cfg.asmWipe;
        const r = artRectAt(a);
        const ar = u.uArtRect.value;
        ar[0] = r[0]; ar[1] = r[1]; ar[2] = r[2]; ar[3] = r[3];
        const wr = u.uWipeRect.value;
        wr[0] = wipeRect[0]; wr[1] = wipeRect[1]; wr[2] = wipeRect[2]; wr[3] = wipeRect[3];

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
    headEl.style.opacity = (1 - oc).toFixed(3);
    countEl.style.opacity = (1 - oc).toFixed(3);
    frame.style.opacity = frameT.toFixed(3);
    tip.style.opacity = tipT.toFixed(3);
    tip.style.transform = 'translate(-100%,-100%) translateY(' + ((1 - tipT) * 8).toFixed(2) + 'px)';
    tip.style.pointerEvents = tipT > 0.6 ? 'auto' : 'none';
    closeBtn.style.opacity = closeT.toFixed(3);
    closeBtn.style.pointerEvents = closeT > 0.5 ? 'auto' : 'none';

    const idx = ((Math.round(current) % n) + n) % n;
    if (indexEl) indexEl.textContent = String(idx + 1).padStart(2, '0');

    /* -- park when everything is genuinely still */
    const rowAwake = dragging || Math.abs(velocity) > 0.0015 ||
      Math.abs(target - current) > 0.0008 || Math.abs(vSmooth) > 0.0004;
    const chromeAwake = Math.abs(frameT - frameWant) > 0.004 ||
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

    const d = cards[i].dataset;
    tipSwatch.style.background = getComputedStyle(cards[i]).getPropertyValue('--mw-color');
    tipTitle.textContent = d.title || '';
    tipBy.textContent = d.by ? 'by ' + d.by : '';
    tipBy.href = d.href || '#';
    tipBy.style.display = d.by ? '' : 'none';

    root.setAttribute('data-mw-open', '');
    closeBtn.focus({ preventScroll: true });
    wake();
  }

  function closeCard() {
    if (!isOpen) return;
    isOpen = false;
    landed = false;
    oTarget = 0;                        // same spring, retargeted: an
    rowFrom = null;                     // interrupt is continuous by construction
    root.removeAttribute('data-mw-open');
    cards[activeIndex].focus({ preventScroll: true });
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
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openCard(i); }
    };
    card.addEventListener('pointerenter', enter);
    card.addEventListener('pointerleave', leave);
    card.addEventListener('click', click);
    card.addEventListener('keydown', key);
    return { enter, leave, click, key };
  });

  const onKey = (e) => {
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
  closeBtn.addEventListener('click', closeCard);
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
      return { o, ov, current, target, velocity, activeIndex, isOpen, landed, running, frameT, tipT };
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
      closeBtn.removeEventListener('click', closeCard);
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

export function initAll(scope) {
  const out = [];
  (scope || document).querySelectorAll('[data-mw="root"]').forEach((r) => {
    const i = init(r);
    if (i) out.push(i);
  });
  return out;
}
