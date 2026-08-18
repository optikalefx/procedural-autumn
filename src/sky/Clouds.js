// Volumetric / billboard cloud layer.
// Stub — owned by a dedicated system author. See docs/DESIGN_BRIEF.md.
import { System } from '../core/System.js';

export class Clouds extends System {
  constructor(ctx) {
    super(ctx);
    this.name = 'Clouds';
  }

  async init() {}

  update(dt, elapsed) { void dt; void elapsed; }

  dispose() {}
}
