# mw-slider — cloth open/close card slider (OGL)

Skewed looping card row with a physically simulated open/close. The visible
cards are WebGL planes (OGL) deformed by a per-card material sim; the DOM
cards stay as the accessible hit/focus layer. Frame, tip, close button,
counter and backdrop are DOM and never deform.

## Run

```
npm install
npm run dev          # http://localhost:5173
npm run build        # dist/mw-slider.js — one self-contained file for Webflow
npm run build:site   # dist-site/ — the demo pages
```

Pages: `index.html` is the reference markup, `webflow.html` is the Webflow
component markup, `test-embed.html` loads the built bundle as a plain script
(what actually ships).

## Webflow embed

`dist/mw-slider.js` is ~84 kB (27 kB gzipped) with OGL bundled in, so it is
too big for a custom-code field and has to be hosted. Add before `</body>`:

```html
<script src="https://your-host/mw-slider.js"></script>
```

It boots itself on every `[data-webgl-canvas]` (and `[data-mw="root"]`) on the
page and exposes `window.MwSlider = { instances, init, initAll }` for page
transitions. Adding `?mw-tweak` to any URL — including the live site — opens
the tuning panel, so the physics can be tuned in place.

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

**Slide export sizes.** A slide only fills the canvas edge to edge if its
aspect matches the *hole* (1158 x 771, 3:2), not the chrome's outer frame.
Export at 3:2, or taller than 3:2 so the page runs past the fold and gets
cropped by the canvas — which is what a real Designer window looks like. At
the current 1440 x 851 the page is ~11% short, and the strip below it is
filled with the plate: by default the median colour of the artwork's own
bottom row, so it reads as the page continuing. Override per card with
`--mw-plate`, or globally with `data-plate`.

Two details make it read as one motion rather than a second step: it starts at
`asmGate` while the card is still folding, so the material covers the swap; and
the chrome is *revealed* in the band the slide vacates rather than cross-faded
over it, so the UI is never visible through the artwork.

Fallbacks: `prefers-reduced-motion` or no/software WebGL → DOM cards render
normally, no cloth, instant-ish flights. A lost WebGL context (driver reset,
sleep, a reclaimed background tab) falls back to the DOM cards immediately and
rebuilds itself on `webglcontextrestored` — up to three times. rAF parks when the row, flight,
material and fades are all settled; any input wakes it.

## Webflow markup

The module accepts the Webflow component tree directly — see `webflow.html`:

- `data-webgl-canvas` on the stage element (this is the root; put the
  `data-*` config on it)
- `data-webgl-item` on each card
- `data-webgl-image` on the **artwork** image
- `data-webgl-overlay` on the **UI chrome** image (transparent canvas hole)
- `data-webgl-tag` (or `.webgl_cards_tag`) on the card's tag block
- `data-webgl-heading` on anything that should fade out while a card is open
- `data-webgl-close` on your own close button, `data-webgl-backdrop` on your
  own backdrop — the module only drives their opacity, and creates plain ones
  only if they are absent. They can live anywhere in the section.

A close button authored *inside* the component exists once per card, which is
handled: each is lifted onto the open card, shown only for that card, and
hidden in the row. The backdrop is transparent unless you set `--mw-backdrop`
— a guessed colour is a white sheet on a dark site.

Design the tag in Webflow, not in code: it is lifted into a layer that is
exactly the open card's rect, so `position:absolute; right:24px; bottom:24px`
resolves against the image as authored. The module fades a wrapper around it
and never touches the tag's own styles. Add `data-webgl-pin` to anything else
that should anchor to the open card — a close button at the card's top-left,
for instance — instead of to the viewport.

`data-webgl-pin` also takes a corner: `top-left`, `top-right`, `bottom-left`,
`bottom-right` or `center` centres the element *on* that corner of the card,
which otherwise needs a -50%/-50% transform stacked on the offsets. Nudge it
off the corner with plain margins — `margin: 18px 0 0 -18px` sits it down and
out — since margin is the one offset a visual editor exposes cleanly. A bare
`data-webgl-pin` leaves the positioning entirely to your CSS.

Lifted elements keep their ancestors rebuilt as empty same-class shells,
because Webflow writes nested styles as descendant selectors: without them a
tag moved out of the card loses everything styled through its parents, and
the text disappears while a self-styled SVG survives.

The module's CSS is injected FIRST in `<head>`, so every Webflow class wins.
If the canvas needs to be `position:absolute; inset:0` inside a section with
a heading above it, just set that in Webflow — otherwise the canvas is laid
out below the heading and the row centres in the leftover space.

Every card can carry its own overlay, which is what a component wants;
textures are cached per URL, so eight cards sharing one UI cost one upload.
Textures are re-fetched from the URL with CORS rather than reused from the
`<img>` — WebGL rejects a cross-origin image that wasn't requested with CORS,
and Webflow serves assets from its CDN.

The module injects the layout CSS it needs (absolute cards, stage flexbox,
perspective) and creates a backdrop and close button when the markup has none.
The tag blocks are lifted into a screen-space layer at init — inside the card
they would inherit its skew and scale — and put back on `destroy()`. Sizing
comes from `--mw-card-w` and `--mw-stage-h` so Webflow classes can override it.

## Reference-markup authoring

Everything on `[data-mw="root"]` (all optional, defaults in `index.js`):

Scroll: `data-scroll-span` — how far the row is CARRIED, in cards, across one
full pass of the section through the viewport (0, the default, is off).

The page scroll carries the row; it does not drive it. The offset is visual
only and never becomes part of the carousel position, so scrolling cannot
scrub through the cards, cannot fight a drag and cannot change which card is
which — the row is simply centred when the section is centred, and offset
either side of that. Dragging remains the only way to move through the cards,
and it still settles onto a slot. The wheel belongs to the page, so the
section always scrolls past normally.

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
