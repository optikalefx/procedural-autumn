// Boulders, scree fields, cliff outcrops.
// Stub — owned by a dedicated system author. See docs/DESIGN_BRIEF.md.
import { System } from '../core/System.js';

export class Rocks extends System {
  constructor(ctx) {
    super(ctx);
    this.name = 'Rocks';
  }

  async init() {}

  update(dt, elapsed) { void dt; void elapsed; }

  dispose() {}
}
