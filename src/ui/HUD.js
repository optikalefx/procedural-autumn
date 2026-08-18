// Diegetic HUD, compass, photo mode, settings.
// Stub — owned by a dedicated system author. See docs/DESIGN_BRIEF.md.
import { System } from '../core/System.js';

export class HUD extends System {
  constructor(ctx) {
    super(ctx);
    this.name = 'HUD';
  }

  async init() {}

  update(dt, elapsed) { void dt; void elapsed; }

  dispose() {}
}
