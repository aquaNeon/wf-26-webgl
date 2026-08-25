import { initAll } from './mw-slider/index.js';
import { attachTweak } from './mw-slider/tweak.js';

const boot = () => {
  const instances = initAll();
  if (instances[0]) attachTweak(instances[0]);
  // exposed for Barba hooks / console poking:
  window.MwSlider = { instances, initAll };
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
