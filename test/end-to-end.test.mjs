import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Chess } from '../vendor/chess.js';
import { BoardView } from '../js/geometry.js';
import { MoveDetector } from '../js/detector.js';
import { changeScores, sampleBoard, samplePoints } from '../js/vision.js';
import { DEFAULT_CORNERS, render } from '../js/synthetic.js';

const view = new BoardView(DEFAULT_CORNERS);
const points = samplePoints(view);

/** Render the board before and after `sans`, then run the detector `frames` times on that change. */
function read(board, sans, seed, frames = 2) {
  const before = sampleBoard(render(board, { seed }), points);
  const later = new Chess(board.fen());
  for (const san of sans) later.move(san);
  const now = sampleBoard(render(later, { seed: seed + 1, light: 1.08 }), points);
  const scores = changeScores(before, now);
  const detector = new MoveDetector(view.behindStep());
  let det;
  for (let i = 0; i < frames; i++) det = detector.update(board, scores, true);
  return det;
}

const ucis = (moves) => moves.map((m) => m.uci);
const uciOf = (board, san) => new Chess(board.fen()).move(san).lan;

test('reads a whole game', () => {
  const board = new Chess();
  ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'O-O', 'Nf6', 'Bxf7+'].forEach((san, i) => {
    const det = read(board, [san], 2 * i);
    assert.equal(det.kind, 'confirmed', `${san}: ${det.kind}`);
    assert.deepEqual(ucis(det.moves), [uciOf(board, san)], san);
    board.move(san);
  });
});

test('reads a fast reply as two moves', () => {
  const det = read(new Chess(), ['Nf3', 'Nc6'], 40);
  assert.equal(det.kind, 'confirmed');
  assert.deepEqual(ucis(det.moves), ['g1f3', 'b8c6']);
});

test('a single pawn push is the reading or its first alternative', () => {
  const det = read(new Chess(), ['h3'], 50);
  assert.equal(det.kind, 'confirmed');
  const readings = [det.moves, ...det.alternatives].map(ucis);
  assert.ok(readings.some((r) => r.length === 1 && r[0] === 'h2h3'), JSON.stringify(readings));
});

test('a close call like 1.e3 is offered, never guessed', () => {
  const det = read(new Chess(), ['e3'], 60, 5);
  assert.ok(['unsure', 'confirmed'].includes(det.kind), det.kind);
  const readings = [det.moves, ...det.alternatives].map(ucis);
  assert.ok(readings.some((r) => r.length === 1 && r[0] === 'e2e3'), JSON.stringify(readings));
});
