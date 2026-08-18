// River ribbons and lake surfaces.
// Stub — owned by a dedicated system author. See docs/DESIGN_BRIEF.md.
import { System } from '../core/System.js';

export class Water extends System {
  constructor(ctx) {
    super(ctx);
    this.name = 'Water';
  }

  async init() {}

  update(dt, elapsed) { void dt; void elapsed; }

  dispose() {}
}
