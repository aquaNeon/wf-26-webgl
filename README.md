# mw-slider — cloth open/close card slider (OGL)

Skewed looping card row with a physically simulated open/close. The visible
cards are WebGL planes (OGL) deformed by a per-card material sim; the DOM
cards stay as the accessible hit/focus layer. Frame, tip, close button,
counter and backdrop are DOM and never deform.

## Run

```
npm install
npm run dev        # http://localhost:5173
npm run build      # dist/ bundle for Webflow embed
```

## Architecture

- `src/mw-slider/index.js` — module: row physics, input, one-clock flight
  spring, chrome sequencing, DOM/GL sync, `init/initAll/destroy`.
- `src/mw-slider/cloth.js` — angle-chain material sim. Per card, one chain of
  segments along the width. State = fold angle per segment. Torques: water
  drag (∝ slot-velocity², gated by cosθ, felt by loose material), flatten
  spring (grip-graded), bending diffusion, damping. Positions reconstructed
  by walking from the grabbed edge — arc length exact by construction. The
  grabbed edge is a smoothed blend of left/right walks (no snapping on
  reversals). Input is ONLY slot motion: row drags, the flight and the
  centre-card scale bloom are the same code path. No time envelopes.
- `src/mw-slider/gl.js` — one canvas per instance. Camera at
  z = perspective px so 1 unit = 1 px and depth matches CSS. One plane per
  card, one vertex column per chain node, offsets as a uniform array.
  Layering is painter's order sorted by each card's real world z (no depth
  buffer: fold depth exceeds the per-slot gap, and translucent cards writing
  depth punch holes). In the row that reproduces left-over-right exactly; on
  a flight the card climbs the stack going front and descends through it one
  card at a time coming back. Corner
  tag is baked to a texture and difference-blended in-shader so it occludes
  correctly and rides the material. Rounded corners via SDF alpha,
  toggleable procedural checkerboard.
- `src/mw-slider/tweak.js` — dev panel; every physical constant is a live
  slider. Don't ship.

## UI assembly

Cards are 1440 x 851 — the aspect of both the slides and the Designer chrome
in `public/`. The slide lives in its own rect inside the card: at rest that
rect *is* the card, and as the flight lands the rect shrinks into the chrome's
canvas hole while the chrome is revealed around it. Closing reverses it.

It is one uniform scale, so the slide never distorts; the mismatch between the
slide (1.692) and the canvas hole (1.502) resolves as a strip of canvas under
the page (`fit: width`, `anchor: top` — how a real Designer viewport reads) or
as a crop (`fit: cover`).

Two details make it read as one motion rather than a second step: it starts at
`asmGate` while the card is still folding, so the material covers the swap; and
the chrome is *revealed* in the band the slide vacates rather than cross-faded
over it, so the UI is never visible through the artwork.

Fallbacks: `prefers-reduced-motion` or no/software WebGL → DOM cards render
normally, no cloth, instant-ish flights. A lost WebGL context (driver reset,
sleep, a reclaimed background tab) falls back to the DOM cards immediately and
rebuilds itself on `webglcontextrestored` — up to three times. rAF parks when the row, flight,
material and fades are all settled; any input wakes it.

## Webflow authoring

Everything on `[data-mw="root"]` (all optional, defaults in `index.js`):

Row: `data-spacing` `data-skew-y` `data-perspective` `data-push`
`data-chase` `data-lag` `data-friction` `data-lerp` `data-loop`
`data-wave-amp` `data-wave-freq` `data-wave-tilt` `data-wave-turn`
`data-wave-gain`

Hover: `data-hover-radius` `data-hover-lift` `data-hover-dim`

Flight (one spring): `data-spring-k` `data-spring-d` `data-scale-pow`
`data-skew-pow` `data-open-z` `data-z-gap` `data-landed-vel`
`data-landed-dist`

Material: `data-nodes` `data-grip` `data-grip-pow` `data-grip-base`
`data-drag` `data-fold-pow` `data-ripple` `data-damp` `data-settle` `data-iters`
`data-bend-stiff` `data-soft-amp` `data-shade`
(the right edge is always the locked edge; the left side always folds
backward into depth)

UI assembly: `data-ui` (chrome PNG with a transparent canvas hole),
`data-fit` (`width` | `contain` | `cover`), `data-anchor` (`top` | `center`),
`data-plate` (canvas colour behind the slide), `data-hole-x/y/w/h` (the hole
in 0..1 of the image, y from the top), `data-asm-gate` (openness at which it
starts), `data-asm-rate`, `data-asm-wipe` (1 reveals the UI, 0 cross-fades it)

Chrome: `data-frame-gap` `data-radius` `data-checker`

Cards: `data-title` `data-by` `data-href`, colour via `--mw-color`,
optional `<img>` inside `[data-mw="media"]` becomes the plane texture.

## API (Barba)

```js
import { init, initAll } from './mw-slider/index.js';
const instances = initAll();      // idempotent per root
instances[0].destroy();           // full teardown: listeners, rAF, GL context
inst.set('drag', 0.8);            // live-tune any cfg key
inst.open(i); inst.close();
inst.debugStep(ms); inst.state(); // headless testing hooks
```
