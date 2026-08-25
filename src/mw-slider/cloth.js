/* ============================================================
   cloth.js — angle-chain material sim

   One chain per card along its width. Instead of free node
   positions (which buckle into multi-crease accordions under a
   PBD solver), the state is the FOLD ANGLE of each segment in
   the x-z plane. Positions are reconstructed by walking from the
   grabbed edge, rotating each rigid slot segment by its angle —
   so arc length is exact by construction, and a curl is always
   one smooth curve.

   Per segment, per step:
     torque  = drag · v² · cosθ · looseness   (water drag folds it
               back into depth; cosθ dies as the segment aligns
               with the flow, so it can't over-rotate)
             − flatten · grip · θ             (the card wants flat;
               firmly gripped material snaps back hard)
             + diffusion of θ along the chain (bending stiffness —
               creases spread into curves)
     ω integrates with damping; θ integrates from ω.

   v is each segment's own slot velocity, so row scroll, the open
   flight and the centre-card scale bloom are all the same input:
   slots that move. No envelopes, no progress terms. If the slots
   don't move, every torque source is zero.

   The grabbed edge is FIXED by design: the right edge is locked and
   the left side — the part tucked behind its neighbour in the row's
   stacking — is the material that folds, always backward into depth,
   whichever way the card travels. No side-switching, no snapping.
   ============================================================ */

export class ClothChain {
  constructor(count) {
    this.resize(count);
  }

  resize(count) {
    const n = Math.max(4, Math.round(count));
    this.n = n;
    const s = n - 1;                     // segments
    this.theta = new Float32Array(s);    // fold angle, rad, +ve = into depth
    this.omega = new Float32Array(s);    // rad / s
    this.slotX = new Float32Array(n);    // rigid targets, written by caller
    this.slotZ = new Float32Array(n);
    this.prevX = new Float32Array(n);
    this.segVel = new Float32Array(s);   // slot-midpoint x velocity, px/s
    this.scratch = new Float32Array(s);
    this.pR = new Float32Array(n * 2);   // reconstructed positions (x, z)
    this.phase = 0;                      // per-card ripple phase, set by caller
    this.velInit = false;
    this.settled = true;
  }

  snap() {
    this.theta.fill(0);
    this.omega.fill(0);
    this.segVel.fill(0);
    this.velInit = false;
    this.settled = true;
  }

  /* once per FRAME, after the caller wrote fresh slots: measure how
     fast each segment's slot is actually moving. this is the sim's
     only input — row drags, the flight and scale spread all arrive
     here as nothing but slot motion. */
  computeSlotVel(dt) {
    const s = this.n - 1;
    if (!this.velInit) {
      this.prevX.set(this.slotX);
      this.segVel.fill(0);
      this.velInit = true;
      return;
    }
    for (let i = 0; i < s; i++) {
      const mid = (this.slotX[i] + this.slotX[i + 1]) * 0.5;
      const pmid = (this.prevX[i] + this.prevX[i + 1]) * 0.5;
      const v = (mid - pmid) / dt;
      // light smoothing so wheel steps don't read as impulses
      this.segVel[i] += (v - this.segVel[i]) * Math.min(1, 12 * dt);
    }
    this.prevX.set(this.slotX);
  }

  /* p: { grip, gripPow, gripBase, drag, foldPow, damp, settle, iters,
          bendStiff } — see index.js for the knob meanings.

     The grabbed edge is FIXED: the right edge is always the locked one
     and the left side — the part tucked behind its neighbour in the
     stack — is always the part that folds, and it always folds BACK
     into depth, whichever way the card travels. */
  step(h, p) {
    const s = this.n - 1;
    let energy = 0;

    for (let i = 0; i < s; i++) {
      const u = (i + 0.5) / s;
      const g = p.gripBase + (1 - p.gripBase) * Math.pow(u, p.gripPow);

      const v = this.segVel[i];
      const th = this.theta[i];

      // fold torque: quadratic in slot speed, gated by cosθ, and
      // concentrated toward the free left tip (uT = 1 there, 0 at the
      // locked right edge). without the grading the whole card takes
      // one uniform arc and reads as sheet metal; cloth curls at the
      // free end.
      const uT = 1 - u;
      // cloth, not paper: the material's response varies along its width
      // (a sine profile with a per-card phase), so the curl comes out as
      // soft uneven lumps instead of one uniform arc. the variation is a
      // property of the material, not of time — at rest it's invisible.
      const soft = 1 + p.ripple * Math.sin(u * 14.5 + this.phase);
      // cos² alignment gate: torque collapses as a segment turns into the
      // flow, so the fold can't saturate into one long flat plateau — the
      // depth of the curl stays graded and the ripple stays legible.
      const cg = Math.cos(th);
      let tq = p.drag * 0.001 * v * v * cg * Math.abs(cg) * Math.pow(uT, p.foldPow) * soft;
      // flatten: gripped material is snapped flat, loose material sags back late
      tq -= p.grip * g * th;

      // damping relative to CRITICAL for this segment's flatten spring
      // (2·√(k·g)). settle ≥ 1 means the fold releases as one clean,
      // draggy relax — no ring-back. while the slots are moving fast the
      // v² drag torque dwarfs the damping, so the fold still forms fully.
      const c = p.damp + p.settle * 2 * Math.sqrt(p.grip * g);
      this.omega[i] = (this.omega[i] + tq * h) * Math.exp(-c * h);
      this.theta[i] += this.omega[i] * h;

      // hard cap so an extreme fling can't wrap the surface over itself
      if (this.theta[i] > 2.4) { this.theta[i] = 2.4; this.omega[i] = Math.min(0, this.omega[i]); }
      if (this.theta[i] < -2.4) { this.theta[i] = -2.4; this.omega[i] = Math.max(0, this.omega[i]); }

      energy += Math.abs(this.omega[i]) + Math.abs(this.theta[i]) * 3;
    }

    // bending stiffness: diffuse θ along the chain. a kink becomes a
    // curve; the curve becomes flat; the flutter dies like fabric.
    const kb = Math.min(0.45, p.bendStiff);
    for (let it = 0; it < p.iters; it++) {
      const t = this.theta, sc = this.scratch;
      sc.set(t);
      for (let i = 1; i < s - 1; i++) {
        t[i] += (((sc[i - 1] + sc[i + 1]) * 0.5) - sc[i]) * kb;
      }
      if (s > 1) {
        t[0] += (sc[1] - sc[0]) * kb * 0.5;
        t[s - 1] += (sc[s - 2] - sc[s - 1]) * kb * 0.5;
      }
    }

    this.settled = energy / s < 0.02;
  }

  /* reconstruct the surface and write per-node render data:
     (dx, dz, shade) offsets from the rigid slots, scaled by amp.
     one walk from the locked RIGHT edge leftward, each rigid slot
     segment rotated by -θ so positive θ always folds the left side
     BACK into depth. arc length is exact by construction. */
  writeOffsets(out, amp, shadeAmt) {
    const n = this.n, s = n - 1;
    const pR = this.pR;

    pR[(n - 1) * 2] = this.slotX[n - 1];
    pR[(n - 1) * 2 + 1] = this.slotZ[n - 1];
    for (let i = s - 1; i >= 0; i--) {
      const sx = this.slotX[i + 1] - this.slotX[i];
      const sz = this.slotZ[i + 1] - this.slotZ[i];
      const c = Math.cos(this.theta[i]), si = Math.sin(this.theta[i]);
      // R_y(-θ): x' = x·c − z·si, z' = x·si + z·c → left of a fold sits at −z
      pR[i * 2] = pR[(i + 1) * 2] - (sx * c - sz * si);
      pR[i * 2 + 1] = pR[(i + 1) * 2 + 1] - (sx * si + sz * c);
    }

    for (let i = 0; i < n; i++) {
      out[i * 3] = (pR[i * 2] - this.slotX[i]) * amp;
      out[i * 3 + 1] = (pR[i * 2 + 1] - this.slotZ[i]) * amp;

      const th = Math.abs(this.theta[Math.min(i, s - 1)]) * amp;
      out[i * 3 + 2] = Math.max(0.3, 1 - (1 - Math.cos(th)) * shadeAmt * 1.6);
    }
  }
}
