// The game so far, the engine's best move, and the board picture the next move is compared with.
// Port of the Mac version's Session (chess_helper/app.py), with tap-friendly wording.

import { Chess } from '../vendor/chess.js';
import { squareName } from './geometry.js';

export const READING = 'Reading move…';
export const BOARD_MOVED = 'Board moved? Tap Redo corners.';

const NAMES = { p: 'Pawn', n: 'Knight', b: 'Bishop', r: 'Rook', q: 'Queen', k: 'King' };

/** A move in words, e.g. "Knight g1 → f3" or "Bishop c4 takes f7". */
export function moveText(move) {
  if (move.flags.includes('k')) return 'Castle kingside';
  if (move.flags.includes('q')) return 'Castle queenside';
  const joint = move.flags.includes('c') || move.flags.includes('e') ? 'takes' : '→';
  const text = `${NAMES[move.piece]} ${squareName(move.from)} ${joint} ${squareName(move.to)}`;
  return move.promotion ? `${text} = ${NAMES[move.promotion]}` : text;
}

export function play(board, move) {
  board.move({ from: squareName(move.from), to: squareName(move.to), ...(move.promotion && { promotion: move.promotion }) });
}

export class Session {
  /** `userColor` is "w" or "b"; `reference` is the board picture taken before the first move. */
  constructor(userColor, reference) {
    this.userColor = userColor;
    this.board = new Chess();
    this.best = null;
    this.reference = reference;
    this.history = []; // per confirmed reading: how many moves it pushed and the reference before it
    this.alternatives = []; // other readings of the last confirmed picture
    this.kind = 'none'; // kind of the last detection
    this.hasEngine = true; // false when Stockfish failed: "thinking…" would never end
    this.proposal = null; // a close call the user can accept with Fix: { moves, alternatives, sample }
  }

  /** Take in one detection; `sample` is the board picture it was made from.
   *
   * A close call on offer survives "pending" frames: tapping the phone shakes the picture for a
   * moment, and the offer must still be there when the tap lands. */
  onDetection(det, sample) {
    this.kind = det.kind;
    if (det.kind === 'unsure' && det.moves.length) {
      this.proposal = { moves: det.moves, alternatives: det.alternatives, sample };
    } else if (det.kind !== 'pending') {
      this.proposal = null;
    }
    if (det.kind === 'confirmed') this.accept(det.moves, det.alternatives, sample);
  }

  /** Checkmate, stalemate or bare kings. Repetitions and the 50-move rule are claims, not automatic. */
  gameOver() {
    const board = this.board;
    return board.isCheckmate() || board.isStalemate() || board.isInsufficientMaterial();
  }

  accept(moves, alternatives, sample) {
    this.history.push({ count: moves.length, reference: this.reference });
    for (const move of moves) play(this.board, move);
    this.reference = sample;
    this.best = null;
    this.alternatives = alternatives;
  }

  /** Take back the last confirmed reading (both moves after a fast reply) and its reference. */
  undo() {
    const last = this.history.pop();
    if (!last) return;
    for (let i = 0; i < last.count; i++) this.board.undo();
    this.reference = last.reference;
    this.best = null;
    this.alternatives = [];
    this.proposal = null;
  }

  /** Accept the close call on offer; otherwise swap the last confirmed reading for the next likely one. */
  fix() {
    if (this.proposal) {
      const { moves, alternatives, sample } = this.proposal;
      this.proposal = null;
      this.kind = 'confirmed';
      this.accept(moves, alternatives, sample);
      return;
    }
    if (!this.alternatives.length) return;
    const last = this.history[this.history.length - 1];
    for (let i = 0; i < last.count; i++) this.board.undo();
    const [moves, ...rest] = this.alternatives;
    for (const move of moves) play(this.board, move);
    last.count = moves.length;
    this.alternatives = rest;
    this.best = null;
  }

  /** Use `sample` as the new reference after the corners were tapped again; older pictures no longer line up. */
  setReference(sample) {
    this.reference = sample;
    this.history = [];
    this.alternatives = [];
    this.proposal = null;
  }

  canFix() {
    return !!this.proposal || this.alternatives.length > 0;
  }

  needsEngine() {
    return this.board.turn() === this.userColor && !this.best && !this.gameOver();
  }

  setBest(move) {
    this.best = move;
  }

  status() {
    const board = this.board;
    if (this.gameOver()) {
      return `Game over: ${board.isCheckmate() ? 'checkmate' : board.isStalemate() ? 'stalemate' : 'draw'}`;
    }
    if (this.kind === 'board_moved') return BOARD_MOVED;
    if (this.proposal) return `${READING} tap Fix for ${this.proposal.moves.map(moveText).join(', ')}`;
    if (this.kind === 'pending') return READING;
    const moves = board.history({ verbose: true });
    const last = moves[moves.length - 1];
    const lastSquares = last && `${last.from} → ${last.to}`;
    if (board.turn() === this.userColor) {
      // It is the user's turn, so the last move on the board (if any) was the opponent's.
      const after = last ? ` (after ${lastSquares})` : '';
      if (!this.best) return this.hasEngine ? `Your move: thinking…${after}` : `Your move${after}`;
      return `Your move: ${moveText(this.best)}${after}`;
    }
    return last ? `Opponent's turn — last move ${lastSquares}` : "Opponent's turn";
  }
}
