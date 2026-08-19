(() => {
  const THREE = window.__THREE, w = window.__world;
  const anchors = JSON.parse(document.querySelector('#__anchors')?.textContent || 'null');
  // Re-resolve the river anchor exactly the way shot.mjs does.
  const pin = window.__pinnedAnchors || null;
  const a = window.__anchorAt ? window.__anchorAt('river', 0) : null;
  return JSON.stringify({ a, pin });
})()
