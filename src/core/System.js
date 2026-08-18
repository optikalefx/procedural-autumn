/**
 * Every world system implements this shape. main.js constructs them all in a
 * fixed order and drives them; system authors only ever touch their own file.
 *
 *   constructor(ctx)          — build cheap things only
 *   async init()              — optional; heavy async setup (physics, assets)
 *   update(dt, elapsed)       — per frame
 *   lateUpdate(dt, elapsed)   — optional; after all updates (camera, culling)
 *   onQuality(preset)         — optional; quality-tier change
 *   dispose()
 *
 * ctx fields:
 *   engine, scene, camera, renderer, input
 *   world (WorldData), poi (PointsOfInterest)
 *   atmosphere, lighting, postfx
 *   quality ('ultra'|'high'|'medium'|'low'), preset (QUALITY_PRESETS entry)
 *   systems  — the registry, so a system can find its peers by name
 */
export class System {
  constructor(ctx) { this.ctx = ctx; this.enabled = true; }
  async init() {}
  update() {}
  lateUpdate() {}
  onQuality() {}
  dispose() {}
}
