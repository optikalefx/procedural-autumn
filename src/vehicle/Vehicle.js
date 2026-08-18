// The camper: model, suspension, drivetrain, physics.
// Stub — owned by a dedicated system author. See docs/DESIGN_BRIEF.md.
import { System } from '../core/System.js';

export class Vehicle extends System {
  constructor(ctx) {
    super(ctx);
    this.name = 'Vehicle';
  }

  async init() {}

  update(dt, elapsed) { void dt; void elapsed; }

  dispose() {}
}
