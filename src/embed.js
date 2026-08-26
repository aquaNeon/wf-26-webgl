/* Production entry for the Webflow embed. Bundled to one IIFE file with
   OGL inside, so the page needs a single <script src>.

   The dev tweak panel ships but stays dormant: add ?mw-tweak to the URL
   (or data-tweak on the slider) to open it on the live site. */

import { init, initAll } from './mw-slider/index.js';
import { attachTweak } from './mw-slider/tweak.js';

function boot(scope) {
  const made = initAll(scope);
  const wanted = location.search.includes('mw-tweak')
    || (made[0] && made[0].root.hasAttribute('data-tweak'));
  if (wanted && made[0]) attachTweak(made[0]);

  const api = window.MwSlider && window.MwSlider.instances ? window.MwSlider : {
    instances: [],
    init,
    // for Barba and friends: re-scan after a page swap, tear down before one
    initAll: boot,
    destroyAll() {
      api.instances.forEach((i) => i.destroy());
      api.instances = [];
    },
    attachTweak,
  };
  // drop any instance destroyed since the last boot, and any root that was
  // already live — an early boot means boot() can run twice over one root,
  // and init() hands back the SAME instance rather than a second one
  const kept = api.instances.filter((i) => i.root.dataset.mwInit && !made.includes(i));
  api.instances = kept.concat(made);
  window.MwSlider = api;
  return made;
}

/* Boot each slider as soon as its OWN markup is complete, rather than waiting
   for DOMContentLoaded. On a Webflow page DCL routinely lands a second after
   this script has run — every other embed on the page is in front of us — and
   until init the section is deliberately blank, because the cards are hidden
   to stop them flashing as a raw stack. A fast scroll arrives inside exactly
   that window and finds nothing there.

   A root whose nextSibling exists has had its closing tag parsed, so all of
   its cards are present and it is safe to build. DOMContentLoaded stays as
   the backstop for anything the observer did not catch (a root that is the
   last node in its parent, markup injected later). boot() is idempotent:
   init() returns the existing instance for a root it has already built. */
function bootWhenParsed() {
  if (document.readyState !== 'loading') { boot(); return; }

  const anyParsed = () => Array.prototype.some.call(
    document.querySelectorAll('[data-mw="root"], [data-webgl-canvas]'),
    (r) => !r.dataset.mwInit && r.nextSibling,
  );

  let obs = null;
  const done = () => { if (obs) { obs.disconnect(); obs = null; } boot(); };

  if (anyParsed()) { boot(); }
  else if (typeof MutationObserver === 'function') {
    obs = new MutationObserver(() => { if (anyParsed()) done(); });
    obs.observe(document.documentElement, { childList: true, subtree: true });
  }
  // wrapped: as a listener, boot would receive the Event as its scope
  document.addEventListener('DOMContentLoaded', done, { once: true });
}

bootWhenParsed();

export { init, initAll, attachTweak };
