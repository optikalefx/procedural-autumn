// Bushes, ferns, flowers, fallen leaves, deadfall.
// Stub — owned by a dedicated system author. See docs/DESIGN_BRIEF.md.
import { System } from '../core/System.js';

export class GroundCover extends System {
  constructor(ctx) {
    super(ctx);
    this.name = 'GroundCover';
  }

  async init() {}

  update(dt, elapsed) { void dt; void elapsed; }

  dispose() {}
}
