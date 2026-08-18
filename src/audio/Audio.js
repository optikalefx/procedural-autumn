// Procedural ambience, engine, water, wildlife, music.
// Stub — owned by a dedicated system author. See docs/DESIGN_BRIEF.md.
import { System } from '../core/System.js';

export class Audio extends System {
  constructor(ctx) {
    super(ctx);
    this.name = 'Audio';
  }

  async init() {}

  update(dt, elapsed) { void dt; void elapsed; }

  dispose() {}
}
