// Read the board out of a camera frame: sample each square's inner patch, then score how much
// each square changed between two frames. Same method as the Mac version's board_view.py, but
// sampling a grid of points per square instead of warping the whole image.

import { SQUARE, fileOf, rankOf, apply } from './geometry.js';

export const CHANGE_SCALE = 26; // average Lab colour difference (L1) that counts as "completely different" (30 on the Mac, which blurs more)
export const GRID = 10; // sample points per side of each square's inner patch
const PATCH_START = 13; // the inner patch spans offsets 13..51 of a 64-px square,
const PATCH_SIZE = 39; // clear of the square's edges
const PER_SQUARE = GRID * GRID;
const BOX = 2; // each sample averages a (2*BOX+1)^2 pixel box, which smooths sensor noise

const BUSY_RANKS = [0, 1, 6, 7]; // ranks 1, 2, 7, 8 hold the pieces at the start
const EMPTY_RANKS = [2, 3, 4, 5];
const TEXTURE_RATIO = 1.5;

export const WRONG_CORNERS = "Corners look wrong — the pieces aren't where the start position puts them. Tap the 4 corners again.";
export const UPSIDE_DOWN = "Board looks upside down — tap a1 first (under White's left rook), then the others.";

/** Where to sample: image coordinates of GRID x GRID points inside each square's patch. */
export function samplePoints(view) {
  const points = new Float32Array(64 * PER_SQUARE * 2);
  let k = 0;
  for (let square = 0; square < 64; square++) {
    const x0 = fileOf(square) * SQUARE + PATCH_START;
    const y0 = (7 - rankOf(square)) * SQUARE + PATCH_START;
    for (let j = 0; j < GRID; j++) {
      for (let i = 0; i < GRID; i++) {
        const [x, y] = apply(view.toImage, x0 + ((i + 0.5) * PATCH_SIZE) / GRID, y0 + ((j + 0.5) * PATCH_SIZE) / GRID);
        points[k++] = x;
        points[k++] = y;
      }
    }
  }
  return points;
}

/** The board as seen in `image` ({data RGBA, width, height}): Lab colour and grey value per sample point. */
export function sampleBoard(image, points) {
  const n = points.length / 2;
  const sample = { L: new Float32Array(n), A: new Float32Array(n), B: new Float32Array(n), gray: new Float32Array(n) };
  const { data, width, height } = image;
  for (let p = 0; p < n; p++) {
    const cx = Math.round(points[2 * p]);
    const cy = Math.round(points[2 * p + 1]);
    let r = 0, g = 0, b = 0, count = 0;
    for (let y = cy - BOX; y <= cy + BOX; y++) {
      if (y < 0 || y >= height) continue;
      for (let x = cx - BOX; x <= cx + BOX; x++) {
        if (x < 0 || x >= width) continue;
        const i = (y * width + x) * 4;
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
        count++;
      }
    }
    if (count) {
      r /= count;
      g /= count;
      b /= count;
    }
    const [L, A, B] = toLab(r, g, b);
    sample.L[p] = L;
    sample.A[p] = A;
    sample.B[p] = B;
    sample.gray[p] = 0.299 * r + 0.587 * g + 0.114 * b;
  }
  return sample;
}

const linear = (c) => {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const labF = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);

/** sRGB 0..255 to CIE Lab (D65), the same scale as OpenCV's float conversion: L 0..100. */
export function toLab(r, g, b) {
  const R = linear(r), G = linear(g), B = linear(b);
  const X = (0.412453 * R + 0.35758 * G + 0.180423 * B) / 0.950456;
  const Y = 0.212671 * R + 0.71516 * G + 0.072169 * B;
  const Z = (0.019334 * R + 0.119193 * G + 0.950227 * B) / 1.088754;
  const L = Y > 0.008856 ? 116 * Math.cbrt(Y) - 16 : 903.3 * Y;
  return [L, 500 * (labF(X) - labF(Y)), 200 * (labF(Y) - labF(Z))];
}

function median(values) {
  const sorted = Float32Array.from(values).sort();
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** How different each square looks between two samples: 64 numbers, 0 (same) to 1 (completely different). */
export function changeScores(a, b) {
  const n = a.L.length;
  const shift = new Float32Array(n);
  for (let p = 0; p < n; p++) shift[p] = a.L[p] - b.L[p];
  const m = median(shift); // ignore a lighting change over the whole board
  const scores = new Float64Array(64);
  for (let square = 0; square < 64; square++) {
    let sum = 0;
    for (let p = square * PER_SQUARE; p < (square + 1) * PER_SQUARE; p++) {
      sum += Math.abs(shift[p] - m) + Math.abs(a.A[p] - b.A[p]) + Math.abs(a.B[p] - b.B[p]);
    }
    scores[square] = Math.min(1, sum / PER_SQUARE / CHANGE_SCALE);
  }
  return scores;
}

function squareStats(sample, square) {
  let sum = 0, sumSq = 0;
  for (let p = square * PER_SQUARE; p < (square + 1) * PER_SQUARE; p++) {
    sum += sample.gray[p];
    sumSq += sample.gray[p] * sample.gray[p];
  }
  const mean = sum / PER_SQUARE;
  return { mean, std: Math.sqrt(Math.max(0, sumSq / PER_SQUARE - mean * mean)) };
}

const rankMean = (stats, ranks, key) =>
  ranks.reduce((acc, rank) => acc + stats.slice(rank * 8, rank * 8 + 8).reduce((s, x) => s + x[key], 0), 0) / (ranks.length * 8);

/** null if `sample` looks like the start position seen from White's side, otherwise a message for the user. */
export function checkStartPosition(sample) {
  const stats = Array.from({ length: 64 }, (_, square) => squareStats(sample, square));
  if (rankMean(stats, BUSY_RANKS, 'std') < TEXTURE_RATIO * rankMean(stats, EMPTY_RANKS, 'std')) return WRONG_CORNERS;
  if (rankMean(stats, [0, 1], 'mean') <= rankMean(stats, [6, 7], 'mean')) return UPSIDE_DOWN;
  return null;
}
