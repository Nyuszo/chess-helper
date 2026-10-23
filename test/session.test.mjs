import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Chess } from '../vendor/chess.js';
import { detection, legalMoves } from '../js/detector.js';
import { BOARD_MOVED, READING, Session, moveText } from '../js/session.js';

/** The legal move with this UCI in `fen` (start position by default). */
function move(uci, fen) {
  return legalMoves(new Chess(fen)).find((m) => m.uci === uci);
}
function after(ucis) {
  const board = new Chess();
  for (const uci of ucis) board.move(uci);
  return board.fen();
}

test('move text', () => {
  assert.equal(moveText(move('g1f3')), 'Knight g1 → f3');
  assert.equal(moveText(move('e2e4')), 'Pawn e2 → e4');
  assert.equal(moveText(move('e4d5', after(['e2e4', 'd7d5']))), 'Pawn e4 takes d5');
  assert.equal(moveText(move('e1g1', 'r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4')), 'Castle kingside');
  assert.equal(moveText(move('e1c1', 'r3kbnr/pppqpppp/2n5/3p1b2/3P1B2/2N5/PPPQPPPP/R3KBNR w KQkq - 6 5')), 'Castle queenside');
  assert.equal(moveText(move('a7a8q', '4k3/P7/8/8/8/8/8/4K3 w - - 0 1')), 'Pawn a7 → a8 = Queen');
  assert.equal(moveText(move('e5d6', '4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2')), 'Pawn e5 takes d6');
});

test('White thinks first, Black waits', () => {
  const white = new Session('w', 'ref');
  assert.ok(white.needsEngine());
  assert.equal(white.status(), 'Your move: thinking…');
  const black = new Session('b', 'ref');
  assert.ok(!black.needsEngine());
  assert.equal(black.status(), "Opponent's turn");
});

test('a confirmed move updates the board and the reference', () => {
  const session = new Session('b', 'ref');
  session.onDetection(detection('confirmed', [move('e2e4')]), 'new');
  assert.equal(session.board.history()[0], 'e4');
  assert.equal(session.reference, 'new');
  assert.ok(session.needsEngine());
  assert.equal(session.status(), 'Your move: thinking… (after e2 → e4)');
  session.setBest(move('g8f6', after(['e2e4'])));
  assert.equal(session.status(), 'Your move: Knight g8 → f6 (after e2 → e4)');
});

test("the opponent's turn names the user's last move", () => {
  const session = new Session('w', 'ref');
  session.onDetection(detection('confirmed', [move('e2e4')]), 'new');
  assert.equal(session.status(), "Opponent's turn — last move e2 → e4");
});

test('undo restores the reference', () => {
  const session = new Session('w', 'ref');
  session.onDetection(detection('confirmed', [move('e2e4')]), 'new');
  session.undo();
  assert.equal(session.board.history().length, 0);
  assert.equal(session.reference, 'ref');
  session.undo();
  assert.equal(session.board.history().length, 0);
});

test('a fast reply is two moves and undoes together', () => {
  const session = new Session('b', 'ref');
  session.onDetection(detection('confirmed', [move('e2e4'), move('e7e5', after(['e2e4']))]), 'new');
  assert.equal(session.board.history().length, 2);
  assert.equal(session.status(), "Opponent's turn — last move e7 → e5");
  session.undo();
  assert.equal(session.board.history().length, 0);
});

test('pending and board moved', () => {
  const session = new Session('w', 'ref');
  session.onDetection(detection('pending'), 'x');
  assert.equal(session.status(), READING);
  session.onDetection(detection('board_moved'), 'x');
  assert.equal(session.status(), BOARD_MOVED);
  session.onDetection(detection('none'), 'x');
  assert.equal(session.status(), 'Your move: thinking…');
});

test('Fix switches to the next reading', () => {
  const session = new Session('b', 'ref');
  session.onDetection(detection('confirmed', [move('e2e4')], [[move('e2e3')]]), 'new');
  assert.ok(session.canFix());
  session.fix();
  assert.deepEqual(session.board.history(), ['e3']);
  assert.equal(session.reference, 'new');
  session.fix();
  assert.deepEqual(session.board.history(), ['e3']);
});

test('Fix accepts an unsure reading', () => {
  const session = new Session('b', 'ref');
  session.onDetection(detection('unsure', [move('e2e3')], [[move('e2e4')]]), 'flat');
  assert.equal(session.status(), 'Reading move… tap Fix for Pawn e2 → e3');
  session.fix();
  assert.deepEqual(session.board.history(), ['e3']);
  assert.equal(session.reference, 'flat');
  session.fix();
  assert.deepEqual(session.board.history(), ['e4']);
});

test('an offered close call survives a shaky frame', () => {
  const session = new Session('b', 'ref');
  session.onDetection(detection('unsure', [move('e2e3')], [[move('e2e4')]]), 'flat');
  session.onDetection(detection('pending'), 'shaky');
  assert.ok(session.canFix());
  session.fix();
  assert.deepEqual(session.board.history(), ['e3']);
  assert.equal(session.reference, 'flat');
});

test('an offer is dropped when the board settles back or a move is confirmed', () => {
  const session = new Session('b', 'ref');
  session.onDetection(detection('unsure', [move('e2e3')]), 'flat');
  session.onDetection(detection('none'), 'same');
  assert.ok(!session.canFix());
});

test('a repetition is not game over', () => {
  const session = new Session('w', 'ref');
  for (const uci of ['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8']) session.board.move(uci);
  assert.ok(session.needsEngine());
  assert.ok(!session.status().startsWith('Game over'));
});

test('without an engine it says only whose move it is', () => {
  const session = new Session('w', 'ref');
  session.hasEngine = false;
  assert.equal(session.status(), 'Your move');
});

test('game over', () => {
  const session = new Session('w', 'ref');
  for (const uci of ['f2f3', 'e7e5', 'g2g4']) session.board.move(uci);
  session.onDetection(detection('confirmed', [move('d8h4', session.board.fen())]), 'x');
  assert.equal(session.status(), 'Game over: checkmate');
});

test('new corners drop the history', () => {
  const session = new Session('w', 'ref');
  session.onDetection(detection('confirmed', [move('e2e4')], [[move('e2e3')]]), 'new');
  session.setReference('again');
  assert.ok(!session.canFix());
  session.undo();
  assert.equal(session.board.history().length, 1);
});
