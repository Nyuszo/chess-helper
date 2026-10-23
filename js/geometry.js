// Board geometry: square indexing, the camera-to-board homography and which way tall pieces lean.
//
// Squares are indexed like python-chess: a1 = 0, h1 = 7, a8 = 56, h8 = 63.
// The flat board is 512x512 px seen from White's side (a1 bottom-left), so square (file, rank)
// covers x file*64..file*64+63 and y (7-rank)*64..(7-rank)*64+63.
// Corner order everywhere is a1, h1, h8, a8.

export const BOARD = 512;
export const SQUARE = 64;
export const FLAT_CORNERS = [[0, BOARD], [BOARD, BOARD], [BOARD, 0], [0, 0]];

export const fileOf = (square) => square % 8;
export const rankOf = (square) => Math.floor(square / 8);
export const squareAt = (file, rank) => rank * 8 + file;
export const squareIndex = (name) => squareAt(name.charCodeAt(0) - 97, Number(name[1]) - 1);
export const squareName = (square) => 'abcdefgh'[fileOf(square)] + (rankOf(square) + 1);
export const distance = (a, b) => Math.max(Math.abs(fileOf(a) - fileOf(b)), Math.abs(rankOf(a) - rankOf(b)));

/** 3x3 matrix (row-major, 9 numbers) mapping the 4 `src` points onto the 4 `dst` points. */
export function homography(src, dst) {
  const rows = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    rows.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  const h = solve(rows);
  return [...h, 1];
}

/** Gaussian elimination with partial pivoting on an 8x9 augmented matrix. */
function solve(rows) {
  const n = 8;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(rows[r][col]) > Math.abs(rows[pivot][col])) pivot = r;
    if (Math.abs(rows[pivot][col]) < 1e-12) throw new Error('corners do not form a quadrilateral');
    [rows[col], rows[pivot]] = [rows[pivot], rows[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = rows[r][col] / rows[col][col];
      for (let c = col; c <= n; c++) rows[r][c] -= f * rows[col][c];
    }
  }
  return rows.map((row, i) => row[n] / row[i]);
}

export function apply(h, x, y) {
  const w = h[6] * x + h[7] * y + h[8];
  return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w];
}

/** Maps between camera-image coordinates and the flat board, given the 4 tapped corners. */
export class BoardView {
  constructor(corners) {
    this.corners = corners.map(([x, y]) => [x, y]);
    this.toImage = homography(FLAT_CORNERS, this.corners);
    this.toFlat = homography(this.corners, FLAT_CORNERS);
  }

  /** The square offset (+8, -8, +1 or -1) pointing away from the camera.
   *
   * The board edge that is longest in the picture is nearest the camera, and tall pieces lean
   * away from it, into the square behind them. */
  behindStep() {
    const [a1, h1, h8, a8] = this.corners;
    const len = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
    const edges = [
      [len(h1, a1), 8], // rank 1 nearest: behind is towards rank 8
      [len(h8, h1), -1], // h-file nearest: behind is towards the a-file
      [len(a8, h8), -8], // rank 8 nearest
      [len(a1, a8), 1], // a-file nearest
    ];
    return edges.reduce((best, edge) => (edge[0] > best[0] ? edge : best))[1];
  }

  /** The square's outline in image coordinates: bottom-left, bottom-right, top-right, top-left. */
  squarePolygon(square) {
    const x0 = fileOf(square) * SQUARE;
    const y0 = (7 - rankOf(square)) * SQUARE;
    return [[x0, y0 + SQUARE], [x0 + SQUARE, y0 + SQUARE], [x0 + SQUARE, y0], [x0, y0]].map(([x, y]) =>
      apply(this.toImage, x, y),
    );
  }
}

/** Area of the quadrilateral `corners` (shoelace), in the corners' own units. */
export function quadArea(corners) {
  let twice = 0;
  for (let i = 0; i < corners.length; i++) {
    const [x1, y1] = corners[i];
    const [x2, y2] = corners[(i + 1) % corners.length];
    twice += x1 * y2 - x2 * y1;
  }
  return Math.abs(twice) / 2;
}
