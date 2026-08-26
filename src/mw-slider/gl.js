/* ============================================================
   gl.js — OGL render layer for the slider

   One transparent canvas per slider instance, sized to the stage.
   Camera sits at z = the CSS perspective distance with a fov that
   makes 1 GL unit = 1 CSS px on the z=0 plane, so translateZ in the
   sim matches what translateZ would have done in CSS.

   Each card is one Plane with widthSegments = nodes - 1: one vertex
   column per chain node. Columns are translated by the node offsets
   (uniform vec3 array) — a ruled surface between simulated slices,
   so arc length survives from the sim untouched and the fold is
   smooth at any curl. The rigid part of the card transform
   (rotateZ · rotateY · translate · skewY · scale, exactly the CSS
   order from the prototype) is a mat4 uniform built on the CPU.

   The corner tag is baked into a small canvas texture and
   difference-blended in the fragment shader, so it occludes
   correctly between overlapping cards and rides the material.
   ============================================================ */

import { Renderer, Camera, Program, Mesh, Plane, Texture, Transform } from 'ogl';

export const MAX_NODES = 32;

/* ---------- minimal column-major mat4 helpers ----------
   CSS composes y-down; GL is y-up. Conversion baked into the
   factories: rotateZ and skewY flip sign, translate flips y. */

function multiply(out, a, b) {
  const r = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let ro = 0; ro < 4; ro++) {
      r[c * 4 + ro] =
        a[ro] * b[c * 4] + a[4 + ro] * b[c * 4 + 1] +
        a[8 + ro] * b[c * 4 + 2] + a[12 + ro] * b[c * 4 + 3];
    }
  }
  out.set(r);
  return out;
}

export function composeCardMatrix(out, cssRz, cssRy, x, y, z, cssSkewY, s, sx) {
  const rz = -cssRz * Math.PI / 180;
  const ry = cssRy * Math.PI / 180;
  const k = -Math.tan(cssSkewY * Math.PI / 180);
  const cz = Math.cos(rz), sz = Math.sin(rz);
  const cy = Math.cos(ry), sy = Math.sin(ry);

  const RZ = [cz, sz, 0, 0, -sz, cz, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const RY = [cy, 0, -sy, 0, 0, 1, 0, 0, sy, 0, cy, 0, 0, 0, 0, 1];
  const T = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, -y, z, 1];
  const K = [1, k, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const S = [s * (sx === undefined ? 1 : sx), 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1];

  // CSS transform list applies right-to-left: M = Rz · Ry · T · K · S
  out.set(RZ);
  multiply(out, out, RY);
  multiply(out, out, T);
  multiply(out, out, K);
  multiply(out, out, S);
  return out;
}

export function transformPoint(m, x, y, out) {
  out[0] = m[0] * x + m[4] * y + m[12];
  out[1] = m[1] * x + m[5] * y + m[13];
  out[2] = m[2] * x + m[6] * y + m[14];
  return out;
}

/* ---------- shaders ---------- */

const VERT = /* glsl */ `
attribute vec3 position;
attribute vec2 uv;

uniform mat4 projectionMatrix;
uniform mat4 viewMatrix;
uniform mat4 uModel;
uniform vec3 uNodes[${MAX_NODES}];   // dx, dz, shade — stage space
uniform float uNodeCount;

varying vec2 vUv;
varying float vShade;

void main() {
  vUv = uv;

  float f = uv.x * (uNodeCount - 1.0);
  float fl = floor(f);
  float ft = f - fl;
  int i0 = int(fl);
  int i1 = int(min(fl + 1.0, uNodeCount - 1.0));
  vec3 a = uNodes[i0];
  vec3 b = uNodes[i1];
  vec3 nd = mix(a, b, ft);

  vec4 world = uModel * vec4(position.xy, 0.0, 1.0);
  world.x += nd.x;
  world.z += nd.y;
  vShade = nd.z;

  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const FRAG = /* glsl */ `
precision highp float;

uniform vec3 uColor;
uniform float uAlpha;
uniform float uChecker;
uniform float uHasImage;
uniform sampler2D uMap;
uniform sampler2D uTag;
uniform float uTagAlpha;
uniform vec4 uTagRect;       // x, y, w, h of the tag in uv space
uniform vec2 uSize;          // card w/h in px, for the corner sdf
uniform float uRadius;

// UI assembly: the slide sits in its own rect inside the card. at rest
// that rect IS the card; as the chrome fades in the rect shrinks into
// the chrome's canvas hole. one uniform scale, so the slide never
// distorts — the aspect mismatch resolves as crop or canvas gap.
uniform vec4 uArtRect;       // cx, cy, sx, sy in card uv
uniform vec4 uHole;          // the chrome's canvas hole: x, y, w, h in uv
uniform vec3 uPlate;         // canvas showing past the slide
uniform sampler2D uChrome;
uniform float uHasChrome;
uniform float uAssembly;

varying vec2 vUv;
varying float vShade;

void main() {
  vec2 p = (vUv - 0.5) * uSize;
  vec2 q = abs(p) - (uSize * 0.5 - uRadius);
  float d = length(max(q, 0.0)) - uRadius;
  float edge = 1.0 - smoothstep(-1.0, 0.5, d);
  if (edge <= 0.001) discard;

  vec2 auv = (vUv - uArtRect.xy) / uArtRect.zw + 0.5;
  // the epsilon closes the hairline gap that float error opens between the
  // slide's last texel and the fallback colour
  bool inArt = auv.x >= -0.002 && auv.x <= 1.002 && auv.y >= -0.002 && auv.y <= 1.002;

  // Past the slide there are two different answers. Inside the canvas hole
  // it is the canvas itself showing past a short page. Outside the hole the
  // chrome is about to cover it, so it must be the slide's own edge — the
  // plate there would bleed through the chrome's antialiased edge as a pale
  // hairline right along the artwork.
  bool inHole = vUv.x >= uHole.x && vUv.x <= uHole.x + uHole.z
             && vUv.y >= uHole.y && vUv.y <= uHole.y + uHole.w;
  vec3 col = inHole ? uPlate
    : (uHasImage > 0.5 ? texture2D(uMap, clamp(auv, 0.0, 1.0)).rgb : uColor);

  if (inArt) {
    vec2 suv = clamp(auv, 0.0, 1.0);
    col = uColor;
    if (uHasImage > 0.5) col = texture2D(uMap, suv).rgb;

    // debug checkerboard STANDS IN for missing artwork — never over it
    if (uChecker > 0.5 && uHasImage < 0.5) {
      vec2 c = floor(suv * vec2(12.0, 8.0));
      float ck = mod(c.x + c.y, 2.0);
      col = mix(col * 0.82, mix(col, vec3(1.0), 0.18), ck);
    }

    // corner tag, difference-blended like the DOM version's
    // mix-blend-mode. it lives on the surface, so it folds too.
    vec2 tuv = (vec2(suv.x, 1.0 - suv.y) - uTagRect.xy) / uTagRect.zw;
    if (tuv.x >= 0.0 && tuv.x <= 1.0 && tuv.y >= 0.0 && tuv.y <= 1.0) {
      float t = texture2D(uTag, vec2(tuv.x, 1.0 - tuv.y)).a * uTagAlpha;
      col = mix(col, abs(vec3(1.0) - col), t * 0.82);
    }
  }

  // the slide is simply BEHIND the UI, which fades in over it. the
  // chrome is opaque everywhere except its canvas hole, so the slide's
  // overflow is hidden by the panels themselves — no masking needed.
  if (uHasChrome > 0.5 && uAssembly > 0.001) {
    vec4 ch = texture2D(uChrome, vUv);
    // Where the slide has pulled away, the chrome is the only thing that can
    // be there, so it is already at full strength — otherwise the bare plate
    // shows through the half-faded UI as a pale panel beside the artwork.
    // Inside the slide it still cross-fades, which is the look we want.
    vec2 dOut = abs(vUv - uArtRect.xy) - uArtRect.zw * 0.5;
    float vacated = smoothstep(0.0, 0.0015, max(dOut.x, dOut.y));
    col = mix(col, ch.rgb, ch.a * max(uAssembly, vacated));
  }

  col *= vShade;
  gl_FragColor = vec4(col, uAlpha * edge);
}
`;

/* ---------- tag texture ---------- */

function makeTagTexture(gl, text) {
  const scale = 3;                       // survives the open zoom
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  const font = `600 ${11 * scale}px Inter, "Helvetica Neue", Arial, sans-serif`;
  ctx.font = font;
  const label = (text || '').toUpperCase();
  const ls = 0.09 * 11 * scale;
  let w = 0;
  for (const ch of label) w += ctx.measureText(ch).width + ls;
  c.width = Math.max(2, Math.ceil(w));
  c.height = Math.ceil(15 * scale);
  ctx.font = font;
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  let x = 0;
  for (const ch of label) {
    ctx.fillText(ch, x, c.height / 2);
    x += ctx.measureText(ch).width + ls;
  }
  const tex = new Texture(gl, { image: c, generateMipmaps: false });
  return { tex, w: c.width / scale, h: c.height / scale };
}

/* ---------- layer ---------- */

export class GlLayer {
  constructor(stage, persp) {
    this.stage = stage;
    this.persp = persp;
    this.ok = false;

    try {
      this.renderer = new Renderer({ alpha: true, antialias: true, dpr: Math.min(2, window.devicePixelRatio || 1) });
    } catch (e) {
      console.warn('[mw-slider] WebGL unavailable, falling back to DOM', e);
      return;
    }
    const gl = this.gl = this.renderer.gl;

    // bail on software renderers, same gate as the shader modules
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    if (dbg) {
      const r = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '';
      if (/swiftshader|llvmpipe|software/i.test(r)) {
        console.warn('[mw-slider] software GL renderer, falling back to DOM');
        this.dispose();
        return;
      }
    }

    gl.clearColor(0, 0, 0, 0);
    const cv = gl.canvas;
    cv.style.cssText = 'position:absolute;inset:0;z-index:550;pointer-events:none;';
    stage.appendChild(cv);

    // a context can go at any time — GPU driver reset, laptop sleep, a
    // backgrounded tab being reclaimed. without this the slider is blank
    // for the rest of the session. preventDefault() is what makes the
    // browser willing to hand a restored context back.
    this.onLost = null;
    this.onRestored = null;
    cv.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.ok = false;
      if (this.onLost) this.onLost();
    });
    cv.addEventListener('webglcontextrestored', () => {
      if (this.onRestored) this.onRestored();
    });

    this.camera = new Camera(gl);
    this.scene = new Transform();
    this.white = new Texture(gl);       // 1px placeholder for uMap/uTag
    this.items = [];
    this.plateOverride = null;
    this.chromeUrl = null;
    this.textures = new Map();   // src -> { tex, waiting[] }
    this.onTexture = null;       // wakes the render loop when one arrives
    this.ok = true;
  }

  /* Textures are fetched from the URL with CORS rather than reused from
     the <img> in the page: WebGL rejects a cross-origin image that was
     not requested with CORS, and Webflow serves every asset from its CDN.
     Keyed by src, so eight cards pointing at the same UI overlay cost one
     upload. */
  loadTexture(src, onReady) {
    if (!src || !this.ok) return;
    const hit = this.textures.get(src);
    if (hit) {
      if (hit.tex) onReady(hit.tex);
      else hit.waiting.push(onReady);
      return;
    }
    const entry = { tex: null, waiting: [onReady] };
    this.textures.set(src, entry);
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.onload = () => {
      if (!this.ok) return;
      entry.tex = new Texture(this.gl, {
        image: im,
        // NPOT mipmaps need WebGL2; without them a 1440px slide drawn at
        // card size shimmers as the row moves
        generateMipmaps: !!this.renderer.isWebgl2,
      });
      entry.waiting.forEach((fn) => fn(entry.tex));
      entry.waiting.length = 0;
      if (this.onTexture) this.onTexture();
    };
    im.onerror = () => {
      this.textures.delete(src);
      console.warn('[mw-slider] image failed to load (CORS or 404):', src);
    };
    im.src = src;
  }

  /* after a context restore the SAME gl object is live again, but every
     object made from it is dead and OGL's state cache still describes the
     old context. re-seed the cache (mirrors Renderer's constructor) and
     let buildCards recreate the programs, geometries and textures. */
  resetGlState() {
    const gl = this.gl;
    const s = (this.renderer.state = {});
    s.blendFunc = { src: gl.ONE, dst: gl.ZERO };
    s.blendEquation = { modeRGB: gl.FUNC_ADD };
    s.cullFace = false;
    s.frontFace = gl.CCW;
    s.depthMask = true;
    s.depthFunc = gl.LEQUAL;
    s.premultiplyAlpha = false;
    s.flipY = false;
    s.unpackAlignment = 4;
    s.framebuffer = null;
    s.viewport = { x: 0, y: 0, width: null, height: null };
    s.textureUnits = [];
    s.activeTextureUnit = 0;
    s.boundBuffer = null;
    s.uniformLocations = new Map();
    s.currentProgram = null;
    gl.clearColor(0, 0, 0, 0);
    this.white = new Texture(gl);
    this.textures = new Map();   // every upload died with the context
    // unparent the dead meshes FIRST — left in the scene they keep being
    // drawn from destroyed programs and buffers, which is a GL error per
    // mesh per frame even though the rebuilt ones look correct
    this.items.forEach((it) => this.scene.removeChild(it.mesh));
    this.items = [];
    this.ok = !gl.isContextLost();
    return this.ok;
  }

  resize(w, h, persp) {
    if (!this.ok) return;
    this.persp = persp;
    this.renderer.setSize(w, h);
    this.camera.perspective({
      fov: 2 * Math.atan(h / 2 / persp) * 180 / Math.PI,
      aspect: w / h,
      near: Math.max(1, persp - 1500),
      far: persp + 3000,
    });
    this.camera.position.z = persp;
  }

  /* one mesh per card. geometry column count = node count, rebuilt
     when the node slider moves. */
  buildCards(cards, nodeCount, cardW, cardH, radius) {
    if (!this.ok) return;
    this.items.forEach((it) => this.scene.removeChild(it.mesh));
    this.items = cards.map((card) => {
      const geometry = new Plane(this.gl, {
        width: cardW, height: cardH,
        widthSegments: nodeCount - 1, heightSegments: 1,
      });

      const cs = getComputedStyle(card);
      const color = cs.getPropertyValue('--mw-color').trim() || '#cccccc';
      // the canvas showing past the slide defaults to the slide's OWN
      // background, so a short page reads as the page continuing rather
      // than as a hole punched in the card
      const plate = this.plateOverride
        || cssColor(cs.getPropertyValue('--mw-plate').trim() || color);
      // a card carrying real artwork brings its own branding — only the
      // placeholder cards get the baked corner tag
      const img = card.querySelector('[data-webgl-image]') || card.querySelector('img:not([data-webgl-overlay])');
      const overlay = card.querySelector('[data-webgl-overlay]');
      const tag = makeTagTexture(this.gl, img ? '' : card.dataset.title);
      const pad = 20;
      const tagRect = [pad / cardW, 1 - (pad + tag.h) / cardH, tag.w / cardW, tag.h / cardH];

      const program = new Program(this.gl, {
        vertex: VERT, fragment: FRAG,
        // painter's algorithm, like the DOM prototype's z-index. a depth
        // buffer is wrong here twice over: fold depth routinely exceeds
        // any per-slot z gap (hard drags make planes cut through each
        // other), and translucent cards writing depth punch holes in the
        // stack. renderOrder — sorted by each card's real z every frame —
        // owns the layering instead.
        transparent: true,
        depthTest: false, depthWrite: false,
        uniforms: {
          uModel: { value: new Float32Array(16) },
          // must be a plain Array: OGL's uniform-name parsing treats
          // "uNodes[0]" as a component path and only backs off when
          // Array.isArray(value) — a Float32Array gets dropped silently
          uNodes: { value: new Array(MAX_NODES * 3).fill(0) },
          uNodeCount: { value: nodeCount },
          uColor: { value: cssColor(color) },
          uAlpha: { value: 1 },
          uChecker: { value: 1 },
          uHasImage: { value: 0 },
          uMap: { value: this.white },
          uTag: { value: tag.tex },
          uTagAlpha: { value: 1 },
          uTagRect: { value: tagRect },
          uSize: { value: [cardW, cardH] },
          uRadius: { value: radius },
          uArtRect: { value: [0.5, 0.5, 1, 1] },
          uHole: { value: [0, 0, 1, 1] },
          uPlate: { value: plate.slice() },
          uChrome: { value: this.white },
          uHasChrome: { value: 0 },
          uAssembly: { value: 0 },
        },
      });

      const mesh = new Mesh(this.gl, { geometry, program });
      mesh.setParent(this.scene);

      const artSrc = bestSrc(img);
      const uiSrc = bestSrc(overlay);
      /* artAspect drives the art rect, so a slide is never stretched to fit
         the card or the hole. 0 until the texture lands, which reads as
         "assume the card's aspect" — the old behaviour, and the right guess
         for the frames before an image arrives. */
      const item = { mesh, program, card, ownUi: !!uiSrc, artAspect: 0, uiAspect: 0,
        // the reveal waits on the art, not the chrome: a card with no slide
        // has nothing to wait for
        needsArt: !!artSrc, hasArt: !artSrc };
      if (artSrc) {
        this.loadTexture(artSrc, (t) => {
          program.uniforms.uMap.value = t;
          program.uniforms.uHasImage.value = 1;
          item.hasArt = true;
          const im = t.image;
          if (im && im.naturalHeight) item.artAspect = im.naturalWidth / im.naturalHeight;
        });
      }
      if (uiSrc) {
        this.loadTexture(uiSrc, (t) => {
          program.uniforms.uChrome.value = t;
          program.uniforms.uHasChrome.value = 1;
          const im = t.image;
          if (im && im.naturalHeight) item.uiAspect = im.naturalWidth / im.naturalHeight;
        });
      }

      return item;
    });
    if (this.chromeUrl) this.applyChrome();
  }

  /* one shared UI overlay for every card that didn't bring its own */
  loadChrome(url, done) {
    if (!url) return;
    this.chromeUrl = url;
    if (done) this.onTexture = done;
    this.applyChrome();
  }

  applyChrome() {
    if (!this.chromeUrl || !this.ok) return;
    this.items.forEach((it) => {
      if (it.ownUi) return;
      this.loadTexture(this.chromeUrl, (t) => {
        it.program.uniforms.uChrome.value = t;
        it.program.uniforms.uHasChrome.value = 1;
        const im = t.image;
        if (im && im.naturalHeight) it.uiAspect = im.naturalWidth / im.naturalHeight;
      });
    });
  }

  /* null override = every card uses its own colour */
  setPlate(rgb) {
    this.plateOverride = rgb;
    this.items.forEach((it) => {
      const cs = getComputedStyle(it.card);
      const p = rgb || cssColor(cs.getPropertyValue('--mw-plate').trim()
        || cs.getPropertyValue('--mw-color').trim() || '#cccccc');
      it.program.uniforms.uPlate.value = p.slice();
    });
  }

  render() {
    if (!this.ok) return;
    this.renderer.render({ scene: this.scene, camera: this.camera });
  }

  dispose() {
    if (this.renderer) {
      const gl = this.renderer.gl;
      const lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
      if (gl.canvas.parentNode) gl.canvas.parentNode.removeChild(gl.canvas);
    }
    this.items = [];
    this.ok = false;
  }
}

/* Always the full-resolution source. Webflow emits a srcset and the card
   is small, so currentSrc can resolve to a thumbnail — which would then be
   the texture the card is drawn from, blurry the moment it opens.
   data-webgl-src overrides everything. */
function bestSrc(img) {
  if (!img) return '';
  if (img.dataset && img.dataset.webglSrc) return img.dataset.webglSrc;
  /* index.js parks the DOM img's own src while GL is drawing, so the browser
     does not fetch and decode every slide a second time — its request goes
     out without CORS and cannot be shared with the texture's, which needs
     CORS. Read the parked values back so nothing else has to know. */
  const held = img.dataset || {};
  const set = img.getAttribute('srcset') || held.mwHeldSrcset || '';
  if (set) {
    let best = '', bestW = -1;
    set.split(',').forEach((part) => {
      const bits = part.trim().split(/\s+/);
      if (!bits[0]) return;
      const d = bits[1] || '';
      const w = d.endsWith('w') ? parseFloat(d) : d.endsWith('x') ? parseFloat(d) * 1000 : 0;
      if (w >= bestW) { bestW = w; best = bits[0]; }
    });
    if (best) return best;
  }
  return img.getAttribute('src') || held.mwHeldSrc || img.currentSrc || '';
}

export function cssColor(str) {
  const c = document.createElement('canvas');
  c.width = c.height = 1;
  const ctx = c.getContext('2d');
  ctx.fillStyle = str;
  ctx.fillRect(0, 0, 1, 1);
  const d = ctx.getImageData(0, 0, 1, 1).data;
  return [d[0] / 255, d[1] / 255, d[2] / 255];
}
