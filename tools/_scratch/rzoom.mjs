import { decodePNG, crop, writePNG } from './rock_px.mjs';
const [f, rect, zoomS, out] = process.argv.slice(2);
const img = decodePNG(f);
const [x0, y0, x1, y1] = rect.split(',').map(Number);
const c = crop(img, x0 / img.w, y0 / img.h, x1 / img.w, y1 / img.h, Number(zoomS || 3));
writePNG(out, c.w, c.h, c.rgb);
console.log(out, c.w + 'x' + c.h);
