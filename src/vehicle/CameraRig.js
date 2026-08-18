// Chase / cockpit / photo cameras.
// Stub — owned by a dedicated system author. See docs/DESIGN_BRIEF.md.
import { System } from '../core/System.js';

export class CameraRig extends System {
  constructor(ctx) {
    super(ctx);
    this.name = 'CameraRig';
  }

  async init() {}

  update(dt, elapsed) { void dt; void elapsed; }

  dispose() {}
}
