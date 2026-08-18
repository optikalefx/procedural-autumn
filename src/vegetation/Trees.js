// Procedural autumn trees: birch, aspen, maple, oak, conifer.
// Stub — owned by a dedicated system author. See docs/DESIGN_BRIEF.md.
import { System } from '../core/System.js';

export class Trees extends System {
  constructor(ctx) {
    super(ctx);
    this.name = 'Trees';
  }

  async init() {}

  update(dt, elapsed) { void dt; void elapsed; }

  dispose() {}
}
