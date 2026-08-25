/* ---- DEV TWEAK PANEL. don't ship this import to production ---- */

export function attachTweak(inst) {
  if (!inst) return;
  const box = document.createElement('div');
  box.id = 'tweak';
  const btn = document.createElement('button');
  btn.id = 'tweakBtn';
  btn.type = 'button';
  btn.textContent = 'Tweak open';
  document.body.appendChild(box);
  document.body.appendChild(btn);

  const knobs = [
    /* material */
    ['grip', 100, 6000, 50, 'flatten spring'],
    ['gripPow', 0.5, 6, 0.1, 'grip grading'],
    ['gripBase', 0, 0.6, 0.01, 'grip floor'],
    ['drag', 0, 3, 0.02, 'water drag'],
    ['foldPow', 0.3, 4, 0.05, 'curl to free tip'],
    ['ripple', 0, 1, 0.02, 'cloth unevenness'],
    ['damp', 0, 20, 0.25, 'extra damping'],
    ['settle', 0.2, 2, 0.05, 'settle ratio'],
    ['iters', 1, 6, 1, 'bend passes'],
    ['bendStiff', 0, 0.45, 0.01, 'crease spread'],
    ['nodes', 8, 32, 1, 'chain nodes'],
    ['softAmp', 0, 1, 0.01, 'row material amp'],
    ['shade', 0, 3, 0.05, 'fold shading'],
    /* flight */
    ['springK', 10, 200, 1, 'flight stiffness'],
    ['springD', 2, 30, 0.25, 'flight damping'],
    ['scalePow', 0.5, 3, 0.05, 'scale channel'],
    ['skewPow', 0.2, 2, 0.05, 'unskew channel'],
    ['openZ', 0, 200, 1, 'open lift z'],
    ['landedVel', 0.2, 5, 0.1, 'landed vel gate'],
    ['landedDist', 0.01, 0.2, 0.005, 'landed dist gate'],
    /* row */
    ['push', 0, 0.6, 0.01, 'neighbour push'],
    ['spacing', 0.2, 1.2, 0.01, 'card spacing'],
    ['skewY', -45, 45, 0.5, 'skew'],
    ['chase', 0.05, 1, 0.01, 'row chase'],
    ['lag', 0, 1, 0.01, 'row lag'],
    ['friction', 0.8, 0.99, 0.005, 'fling friction'],
    ['hoverLift', 0, 40, 1, 'hover lift'],
    ['hoverRadius', 0.4, 3, 0.05, 'hover radius'],
    ['frameGap', 0, 48, 1, 'frame gap'],
    /* UI assembly */
    ['asmGate', 0, 1, 0.01, 'assembly starts at'],
    ['asmRate', 0.02, 0.5, 0.01, 'assembly speed'],
    ['asmWipe', 0, 1, 0.05, 'reveal vs crossfade'],
    ['holeX', 0, 0.3, 0.001, 'hole x'],
    ['holeY', 0, 0.3, 0.001, 'hole y'],
    ['holeW', 0.3, 1, 0.001, 'hole width'],
    ['holeH', 0.3, 1, 0.001, 'hole height'],
  ];

  const picks = [
    ['fit', ['width', 'contain', 'cover'], 'slide fit'],
    ['anchor', ['top', 'center'], 'slide anchor'],
  ];

  box.innerHTML = knobs.map(([k, min, max, step, label]) =>
    '<label>' + label + '<span data-out="' + k + '"></span>' +
    '<input type="range" data-k="' + k + '" min="' + min + '" max="' + max + '" step="' + step + '"></label>'
  ).join('') +
  picks.map(([k, opts, label]) =>
    '<label>' + label + '<select data-k="' + k + '" style="width:100%;margin-top:3px;font:inherit;font-size:11px">' +
    opts.map((o) => '<option value="' + o + '">' + o + '</option>').join('') +
    '</select></label>'
  ).join('') +
  '<label style="display:flex;gap:8px;align-items:center">checker' +
  '<input type="checkbox" data-k="checker" style="width:auto;margin-left:auto"></label>' +
  '<button id="tweakClose" type="button" style="width:100%;margin-top:4px;padding:6px;font:inherit;font-size:11px;border:1px solid var(--hair);border-radius:4px;background:none;color:var(--ink-soft);cursor:pointer">Close</button>';

  const sync = () => box.querySelectorAll('input, select').forEach((el) => {
    const k = el.dataset.k;
    if (el.type === 'checkbox') { el.checked = !!inst.cfg[k]; return; }
    el.value = inst.cfg[k];
    const out = box.querySelector('[data-out="' + k + '"]');
    if (out) out.textContent = inst.cfg[k];
  });

  box.addEventListener('input', (e) => {
    const el = e.target;
    const k = el.dataset.k;
    if (!k) return;
    if (el.type === 'checkbox') { inst.set(k, el.checked); return; }
    if (el.tagName === 'SELECT') { inst.set(k, el.value); return; }
    const v = parseFloat(el.value);
    inst.set(k, (k === 'nodes' || k === 'iters') ? Math.round(v) : v);
    box.querySelector('[data-out="' + k + '"]').textContent = v;
  });

  btn.addEventListener('click', () => { sync(); box.setAttribute('data-open', ''); });
  box.addEventListener('click', (e) => {
    if (e.target.id === 'tweakClose') box.removeAttribute('data-open');
  });

  return () => { box.remove(); btn.remove(); };
}
