// Deer, bears, rabbits, birds — spawning, AI, animation.
// Stub — owned by a dedicated system author. See docs/DESIGN_BRIEF.md.
import { System } from '../core/System.js';

export class Wildlife extends System {
  constructor(ctx) {
    super(ctx);
    this.name = 'Wildlife';
  }

  async init() {}

  update(dt, elapsed) { void dt; void elapsed; }

  dispose() {}
}
