// Instanced wind-animated grass field.
// Stub — owned by a dedicated system author. See docs/DESIGN_BRIEF.md.
import { System } from '../core/System.js';

export class Grass extends System {
  constructor(ctx) {
    super(ctx);
    this.name = 'Grass';
  }

  async init() {}

  update(dt, elapsed) { void dt; void elapsed; }

  dispose() {}
}
