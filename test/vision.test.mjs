import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Chess } from '../vendor/chess.js';
import { BoardView, apply, homography, FLAT_CORNERS, quadArea, squareIndex } from '../js/geometry.js';
import { CHANGED } from '../js/detector.js';
import {
  UPSIDE_DOWN,
  WRONG_CORNERS,
  changeScores,
  checkStartPosition,
  sampleBoard,
  samplePoints,
  toLab,
} from '../js/vision.js';
import { DEFAULT_CORNERS, render } from '../js/synthetic.js';

const view = new BoardView(DEFAULT_CORNERS);
const points = samplePoints(view);
const look = (board, options = {}) => sampleBoard(render(board, options), points);
const max = (scores) => Math.max(...scores);

test('homography maps every corner exactly', () => {
  const h = homography(FLAT_CORNERS, DEFAULT_CORNERS);
  FLAT_CORNERS.forEach(([x, y], i) => {
    const [u, v] = apply(h, x, y);
    assert.ok(Math.hypot(u - DEFAULT_CORNERS[i][0], v - DEFAULT_CORNERS[i][1]) < 1e-6);
  });
});

test('square polygon a1 and h8 touch the tapped corners', () => {
  const near = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1;
  assert.ok(view.squarePolygon(squareIndex('a1')).some((p) => near(p, DEFAULT_CORNERS[0])));
  assert.ok(view.squarePolygon(squareIndex('h8')).some((p) => near(p, DEFAULT_CORNERS[2])));
});

test('behind step follows the camera side', () => {
  const c = DEFAULT_CORNERS;
  assert.equal(new BoardView(c).behindStep(), 8);
  assert.equal(new BoardView([c[2], c[3], c[0], c[1]]).behindStep(), -8);
  assert.equal(new BoardView([c[1], c[2], c[3], c[0]]).behindStep(), 1);
  assert.equal(new BoardView([c[3], c[0], c[1], c[2]]).behindStep(), -1);
});

test('quad area', () => {
  assert.equal(quadArea([[0, 0], [10, 0], [10, 10], [0, 10]]), 100);
  assert.equal(quadArea([[5, 5], [5, 5], [5, 5], [5, 5]]), 0);
});

test('Lab of white and black', () => {
  assert.ok(Math.abs(toLab(255, 255, 255)[0] - 100) < 0.1);
  assert.ok(Math.abs(toLab(0, 0, 0)[0]) < 0.1);
});

test('identical boards score low', () => {
  const start = new Chess();
  assert.ok(max(changeScores(look(start, { seed: 0 }), look(start, { seed: 1 }))) < 0.15);
});

test('a lighting change scores low', () => {
  const start = new Chess();
  assert.ok(max(changeScores(look(start), look(start, { light: 1.15, seed: 1 }))) < CHANGED);
});

test('a move changes its own squares', () => {
  const before = new Chess();
  const after = new Chess();
  after.move('e4');
  const scores = changeScores(look(before), look(after, { seed: 1 }));
  assert.ok(scores[squareIndex('e2')] >= CHANGED, `e2 ${scores[squareIndex('e2')]}`);
  assert.ok(scores[squareIndex('e4')] >= CHANGED, `e4 ${scores[squareIndex('e4')]}`);
  assert.ok(scores[squareIndex('a1')] < 0.15);
});

test('start position is recognised', () => {
  assert.equal(checkStartPosition(look(new Chess())), null);
});

test('upside-down corners are caught', () => {
  const c = DEFAULT_CORNERS;
  const flipped = samplePoints(new BoardView([c[2], c[3], c[0], c[1]]));
  assert.equal(checkStartPosition(sampleBoard(render(new Chess()), flipped)), UPSIDE_DOWN);
});

test('corners off the board are caught', () => {
  const off = samplePoints(new BoardView([[10, 200], [150, 200], [150, 60], [10, 60]]));
  assert.equal(checkStartPosition(sampleBoard(render(new Chess()), off)), WRONG_CORNERS);
});
