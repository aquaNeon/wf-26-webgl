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
  // drop any instance destroyed since the last boot
  api.instances = api.instances.filter((i) => i.root.dataset.mwInit).concat(made);
  window.MwSlider = api;
  return made;
}

if (document.readyState === 'loading') {
  // wrapped: as a listener, boot would receive the Event as its scope
  document.addEventListener('DOMContentLoaded', () => boot());
} else {
  boot();
}

export { init, initAll, attachTweak };
