import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Chess } from '../vendor/chess.js';
import {
  buildReport,
  classify,
  formatScore,
  gamePlies,
  moveAccuracy,
  terminalScore,
  whiteScore,
  winPercent,
} from '../js/analysis.js';
import { parseScore } from '../js/engine.js';

const SCHOLAR = `[Event "Live Chess"]
[Site "Chess.com"]
[White "ich"]
[Black "Martin"]
[Result "1-0"]

1. e4 {[%clk 0:09:58]} 1... e5 {[%clk 0:09:57]} 2. Qh5 Nc6 3. Bc4 Nf6?? 4. Qxf7# 1-0`;

test('reads engine score lines', () => {
  assert.deepEqual(parseScore('info depth 18 seldepth 25 multipv 1 score cp 34 nodes 9 pv e2e4 e7e5'), { cp: 34 });
  assert.deepEqual(parseScore('info depth 5 score mate -3 pv h7h6'), { mate: -3 });
  assert.equal(parseScore('info string NNUE evaluation using nn.nnue'), null);
  assert.equal(parseScore('bestmove e2e4 ponder e7e5'), null);
});

test('engine scores turn into White-side scores', () => {
  assert.deepEqual(whiteScore({ cp: 34 }, 'w'), { cp: 34 });
  assert.deepEqual(whiteScore({ cp: 34 }, 'b'), { cp: -34 });
  assert.deepEqual(whiteScore({ mate: 2 }, 'b'), { mate: -2 });
  assert.deepEqual(whiteScore({ mate: 0 }, 'b'), { mate: 0, winner: 'w' });
});

test('winning chances', () => {
  assert.equal(winPercent({ cp: 0 }), 50);
  assert.ok(winPercent({ cp: 1000 }) > 95);
  assert.ok(winPercent({ cp: -300 }) < 30);
  assert.equal(winPercent({ mate: 3 }), 100);
  assert.equal(winPercent({ mate: -2 }), 0);
  assert.equal(winPercent({ mate: 0, winner: 'b' }), 0);
});

test('scores for people', () => {
  assert.equal(formatScore({ cp: 123 }), '+1.2');
  assert.equal(formatScore({ cp: -40 }), '−0.4');
  assert.equal(formatScore({ cp: 3 }), '0.0');
  assert.equal(formatScore({ mate: 3 }), '#3');
  assert.equal(formatScore({ mate: -2 }), '#−2');
  assert.equal(formatScore({ mate: 0, winner: 'w' }), 'Matt');
});

test('mistake thresholds', () => {
  assert.equal(classify(4.9), null);
  assert.equal(classify(5), 'inaccuracy');
  assert.equal(classify(10), 'mistake');
  assert.equal(classify(15), 'blunder');
  assert.ok(moveAccuracy(0) > 99.9);
  assert.ok(moveAccuracy(30) < 30);
});

test('reads a chess.com PGN with clock comments', () => {
  const { headers, plies } = gamePlies(SCHOLAR);
  assert.equal(headers.Black, 'Martin');
  assert.deepEqual(plies.map((p) => p.san), ['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'Nf6', 'Qxf7#']);
  assert.deepEqual(plies.map((p) => p.moveNumber), [1, 1, 2, 2, 3, 3, 4]);
  assert.equal(plies[5].uci, 'g8f6');
});

test('reads a plain move list', () => {
  assert.equal(gamePlies('1. d4 d5 2. c4').plies.length, 3);
});

test('rejects text that is not a game', () => {
  assert.throws(() => gamePlies('hallo'), /PGN/);
});

test('finished positions need no engine', () => {
  const { plies } = gamePlies(SCHOLAR);
  assert.deepEqual(terminalScore(new Chess(plies[6].fenAfter)), { mate: 0, winner: 'w' });
  assert.equal(terminalScore(new Chess(plies[0].fenBefore)), null);
});

test('the report finds the blunder and the better move', () => {
  const { plies } = gamePlies(SCHOLAR);
  const evals = [
    { score: { cp: 30 }, best: 'e2e4' },
    { score: { cp: 30 }, best: 'e7e5' },
    { score: { cp: 30 }, best: 'g1f3' },
    { score: { cp: 0 }, best: 'b8c6' },
    { score: { cp: 10 }, best: 'f1c4' },
    { score: { cp: 50 }, best: 'g7g6' }, // before 3...Nf6??: Black should play g6
    { score: { mate: 1 }, best: 'h5f7' },
    { score: { mate: 0, winner: 'w' }, best: null },
  ];
  const report = buildReport(plies, evals);
  const nf6 = report.moves[5];
  assert.equal(nf6.label, 'blunder');
  assert.equal(nf6.bestSan, 'g6');
  assert.ok(nf6.loss > 40);
  const qh5 = report.moves[2];
  assert.equal(qh5.bestSan, 'Nf3');
  assert.equal(report.moves[6].label, null); // the mate was the best move
  assert.equal(report.moves[6].bestSan, null);
  assert.equal(report.summary.b.blunder, 1);
  assert.equal(report.summary.w.blunder, 0);
  assert.ok(report.summary.w.accuracy > report.summary.b.accuracy);
});
