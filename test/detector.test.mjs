import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Chess } from '../vendor/chess.js';
import { squareIndex } from '../js/geometry.js';
import { MARGIN, MoveDetector, Stillness, rankMoves } from '../js/detector.js';

const BACKGROUND = 0.05;

function scoresFor(changes) {
  const scores = new Array(64).fill(BACKGROUND);
  for (const [name, value] of Object.entries(changes)) scores[squareIndex(name)] = value;
  return scores;
}

const ucis = (det) => det.moves.map((m) => m.uci);

function runTwice(board, scores, detector = new MoveDetector()) {
  return [detector.update(board, scores, true), detector.update(board, scores, true)];
}

test('quiet move', () => {
  const [first, second] = runTwice(new Chess(), scoresFor({ e2: 1, e4: 1, e3: 0.5, e5: 0.5 }));
  assert.equal(first.kind, 'pending');
  assert.equal(second.kind, 'confirmed');
  assert.deepEqual(ucis(second), ['e2e4']);
});

test('knight move', () => {
  const [, second] = runTwice(new Chess(), scoresFor({ g1: 1, f3: 0.9 }));
  assert.deepEqual(ucis(second), ['g1f3']);
});

test('capture', () => {
  const board = new Chess('rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2');
  const [, second] = runTwice(board, scoresFor({ e4: 0.9, d5: 0.8 }));
  assert.deepEqual(ucis(second), ['e4d5']);
});

test('kingside castle', () => {
  const board = new Chess('r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4');
  const [, second] = runTwice(board, scoresFor({ e1: 1, f1: 1, g1: 1, h1: 1 }));
  assert.deepEqual(ucis(second), ['e1g1']);
});

test('queenside castle', () => {
  const board = new Chess('r3kbnr/pppqpppp/2n5/3p1b2/3P1B2/2N5/PPPQPPPP/R3KBNR w KQkq - 6 5');
  const [, second] = runTwice(board, scoresFor({ e1: 1, d1: 1, c1: 1, a1: 1 }));
  assert.deepEqual(ucis(second), ['e1c1']);
});

test('en passant', () => {
  const board = new Chess('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2');
  const [, second] = runTwice(board, scoresFor({ e5: 1, d6: 1, d5: 0.9 }));
  assert.deepEqual(ucis(second), ['e5d6']);
});

test('promotion is to a queen', () => {
  const board = new Chess('4k3/P7/8/8/8/8/8/4K3 w - - 0 1');
  const [, second] = runTwice(board, scoresFor({ a7: 1, a8: 1 }));
  assert.deepEqual(ucis(second), ['a7a8q']);
});

test('two moves between reads', () => {
  const [, second] = runTwice(new Chess(), scoresFor({ e2: 1, e4: 1, e7: 1, e5: 1 }));
  assert.deepEqual(ucis(second), ['e2e4', 'e7e5']);
});

test('a nudged piece does not hide the move', () => {
  const [, second] = runTwice(new Chess(), scoresFor({ e2: 1, e4: 1, b8: 0.3 }));
  assert.deepEqual(ucis(second), ['e2e4']);
});

test('smear behind the pieces is free', () => {
  const scores = scoresFor({ e2: 0.46, e4: 0.6, e3: 0.88, e5: 0.88 });
  const [, second] = runTwice(new Chess(), scores, new MoveDetector(8));
  assert.deepEqual(ucis(second), ['e2e4']);
  const fitFor = (behind) => rankMoves(new Chess(), scores, behind).find((c) => c.moves[0].uci === 'e2e4').fit;
  assert.ok(fitFor(8) > fitFor(-8));
});

test('not still is pending', () => {
  const detector = new MoveDetector();
  const scores = scoresFor({ e2: 1, e4: 1 });
  assert.equal(detector.update(new Chess(), scores, false).kind, 'pending');
  assert.equal(detector.update(new Chess(), scores, false).kind, 'pending');
  const [, second] = runTwice(new Chess(), scores, detector);
  assert.equal(second.kind, 'confirmed');
});

test('no change is none', () => {
  const [first, second] = runTwice(new Chess(), scoresFor({}));
  assert.equal(first.kind, 'none');
  assert.equal(second.kind, 'none');
});

test('a lone changed square stays pending', () => {
  const detector = new MoveDetector();
  for (let i = 0; i < 3; i++) assert.equal(detector.update(new Chess(), scoresFor({ e2: 1 }), true).kind, 'pending');
});

test('a close call is never confirmed but is offered', () => {
  const scores = scoresFor({ e2: 1, e3: 0.9, e4: 0.8 });
  const ranked = rankMoves(new Chess(), scores);
  assert.ok(ranked[0].fit - ranked[1].fit < MARGIN);
  const detector = new MoveDetector();
  const kinds = [];
  let last;
  for (let i = 0; i < 5; i++) {
    last = detector.update(new Chess(), scores, true);
    kinds.push(last.kind);
  }
  assert.ok(!kinds.includes('confirmed'));
  assert.deepEqual(kinds.slice(2), ['unsure', 'unsure', 'unsure']);
  assert.deepEqual(last.moves.map((m) => m.uci), ranked[0].moves.map((m) => m.uci));
});

test('alternatives come with a confirmed move', () => {
  const [, second] = runTwice(new Chess(), scoresFor({ e2: 1, e3: 0.5, e4: 1, e5: 0.5 }));
  assert.deepEqual(ucis(second), ['e2e4']);
  assert.ok(Array.isArray(second.alternatives));
  assert.ok(second.alternatives.every((alt) => !(alt.length === 1 && alt[0].uci === 'e2e4')));
});

test('a camera bump is board_moved', () => {
  const changes = {};
  for (let s = 16; s < 36; s++) changes['abcdefgh'[s % 8] + (Math.floor(s / 8) + 1)] = 0.8;
  const [, second] = runTwice(new Chess(), scoresFor(changes));
  assert.equal(second.kind, 'board_moved');
});

test('the streak needs the same move twice', () => {
  const detector = new MoveDetector();
  assert.equal(detector.update(new Chess(), scoresFor({ e2: 1, e4: 1 }), true).kind, 'pending');
  assert.equal(detector.update(new Chess(), scoresFor({ d2: 1, d4: 1 }), true).kind, 'pending');
});

test('stillness needs three quiet frames', () => {
  const stillness = new Stillness();
  const quiet = new Array(64).fill(0.05);
  assert.equal(stillness.update(quiet), false);
  assert.equal(stillness.update(quiet), false);
  assert.equal(stillness.update(quiet), true);
  const busy = quiet.slice();
  busy[3] = 0.5;
  assert.equal(stillness.update(busy), false);
});

test('the caller board is left unchanged by the pair search', () => {
  const board = new Chess();
  rankMoves(board, scoresFor({ e2: 1, e4: 1, e7: 1, e5: 1 }));
  assert.equal(board.fen(), new Chess().fen());
});
