/* Production entry for the Webflow embed. Bundled to one IIFE file with
   OGL inside, so the page needs a single <script src>.

   The dev tweak panel ships but stays dormant: add ?mw-tweak to the URL
   (or data-tweak on the slider) to open it on the live site. */

import { init, initAll } from './mw-slider/index.js';
import { attachTweak } from './mw-slider/tweak.js';

function boot() {
  const instances = initAll();
  const wanted = location.search.includes('mw-tweak')
    || (instances[0] && instances[0].root.hasAttribute('data-tweak'));
  if (wanted && instances[0]) attachTweak(instances[0]);
  window.MwSlider = { instances, init, initAll };
  return instances;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

export { init, initAll, attachTweak };
