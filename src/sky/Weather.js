// Wind field, drifting leaves, pollen, dust motes, light shafts.
// Stub — owned by a dedicated system author. See docs/DESIGN_BRIEF.md.
import { System } from '../core/System.js';

export class Weather extends System {
  constructor(ctx) {
    super(ctx);
    this.name = 'Weather';
  }

  async init() {}

  update(dt, elapsed) { void dt; void elapsed; }

  dispose() {}
}
