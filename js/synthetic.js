// A fake camera view of a green-and-white chess board, for tests and the browser demo.
// Port of the Mac version's tests/synthetic.py: draw the flat 512x512 board (pieces as a round
// base plus a "body" that leans into the square behind), warp it onto a grey canvas as seen by a
// tilted camera, then add lighting and sensor noise.

import { BOARD, FLAT_CORNERS, homography, apply } from './geometry.js';

export const CANVAS_W = 1000;
export const CANVAS_H = 800;
export const DEFAULT_CORNERS = [[180, 700], [820, 690], [700, 260], [290, 270]]; // a1, h1, h8, a8

const LIGHT_SQUARE = [230, 235, 225]; // RGB
const DARK_SQUARE = [70, 140, 70];
const BACKGROUND = [90, 90, 90];
const WHITE_PIECE = [[235, 235, 235], [40, 40, 40]]; // fill, outline
const BLACK_PIECE = [[35, 35, 35], [200, 200, 200]];
const PIECE_RADIUS = 22;
const BODY_AXES = [14, 20]; // half-width, half-height of the body ellipse
const BODY_OFFSET = 40; // the body sits this far towards the top of the flat image

function ellipse(flat, cx, cy, ax, ay, fill, outline) {
  const edge = (ax + ay) / 2;
  for (let y = Math.floor(cy - ay - 2); y <= Math.ceil(cy + ay + 2); y++) {
    if (y < 0 || y >= BOARD) continue;
    for (let x = Math.floor(cx - ax - 2); x <= Math.ceil(cx + ax + 2); x++) {
      if (x < 0 || x >= BOARD) continue;
      const d = Math.hypot((x + 0.5 - cx) / ax, (y + 0.5 - cy) / ay);
      const ring = Math.abs(d - 1) * edge <= 1;
      if (d > 1 && !ring) continue;
      const colour = ring ? outline : fill;
      const i = (y * BOARD + x) * 3;
      flat[i] = colour[0];
      flat[i + 1] = colour[1];
      flat[i + 2] = colour[2];
    }
  }
}

/** The 512x512 RGB board seen from above, White at the bottom. `board` is a chess.js Chess. */
export function flatBoard(board) {
  const flat = new Uint8ClampedArray(BOARD * BOARD * 3);
  for (let y = 0; y < BOARD; y++) {
    for (let x = 0; x < BOARD; x++) {
      const file = x >> 6;
      const rank = 7 - (y >> 6);
      const colour = (file + rank) % 2 ? LIGHT_SQUARE : DARK_SQUARE;
      flat.set(colour, (y * BOARD + x) * 3);
    }
  }
  // chess.js lists rank 8 first, so far ranks are drawn first and a piece in front covers the one behind.
  board.board().forEach((row, r) =>
    row.forEach((piece, file) => {
      if (!piece) return;
      const [fill, outline] = piece.color === 'w' ? WHITE_PIECE : BLACK_PIECE;
      const cx = file * 64 + 32;
      const cy = r * 64 + 32;
      ellipse(flat, cx, cy - BODY_OFFSET, BODY_AXES[0], BODY_AXES[1], fill, outline);
      ellipse(flat, cx, cy, PIECE_RADIUS, PIECE_RADIUS, fill, outline);
    }),
  );
  return flat;
}

/** Seeded random numbers (mulberry32) with a normal-distribution helper. */
function randomNormal(seed) {
  let a = seed >>> 0;
  const uniform = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return () => Math.sqrt(-2 * Math.log(uniform() || 1e-12)) * Math.cos(2 * Math.PI * uniform());
}

/** A CANVAS_W x CANVAS_H picture ({data RGBA, width, height}) of `board` with its corners at `corners`. */
export function render(board, { light = 1, noise = 4, seed = 0, corners = DEFAULT_CORNERS, width = CANVAS_W, height = CANVAS_H } = {}) {
  const flat = flatBoard(board);
  const toFlat = homography(corners, FLAT_CORNERS);
  const normal = randomNormal(seed + 1);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [fx, fy] = apply(toFlat, x + 0.5, y + 0.5);
      let colour = BACKGROUND;
      if (fx >= 0 && fx < BOARD && fy >= 0 && fy < BOARD) {
        const i = ((fy | 0) * BOARD + (fx | 0)) * 3;
        colour = [flat[i], flat[i + 1], flat[i + 2]];
      }
      const o = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) data[o + c] = colour[c] * light + normal() * noise;
      data[o + 3] = 255;
    }
  }
  return { data, width, height };
}
