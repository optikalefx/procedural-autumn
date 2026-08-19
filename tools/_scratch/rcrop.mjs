// Magnified crop of a captured PNG, so a defect can be looked at rather than
// guessed at. Nearest-neighbour on purpose — I am judging facet edges.
//   node tools/_scratch/rcrop.mjs in.png out.png x0,y0,x1,y1 [zoom]
import { decodePNG, crop, writePNG } from './rock_px.mjs';
const [inF, outF, rect, zoomS] = process.argv.slice(2);
const [x0, y0, x1, y1] = rect.split(',').map(Number);
const img = decodePNG(inF);
const c = crop(img, x0, y0, x1, y1, Number(zoomS || 2));
writePNG(outF, c.w, c.h, c.rgb);
console.log(outF, c.w + 'x' + c.h);
