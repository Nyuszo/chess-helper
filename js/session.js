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

  /** Take in one detection; `sample` is the board picture it was made from. */
  onDetection(det, sample) {
    this.kind = det.kind;
    this.proposal = det.kind === 'unsure' && det.moves.length ? { moves: det.moves, alternatives: det.alternatives, sample } : null;
    if (det.kind === 'confirmed') this.accept(det.moves, det.alternatives, sample);
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
    return this.board.turn() === this.userColor && !this.best && !this.board.isGameOver();
  }

  setBest(move) {
    this.best = move;
  }

  lastMoveSquares() {
    const moves = this.board.history({ verbose: true });
    const last = moves[moves.length - 1];
    return `${last.from} → ${last.to}`;
  }

  status() {
    const board = this.board;
    if (board.isGameOver()) {
      return `Game over: ${board.isCheckmate() ? 'checkmate' : board.isStalemate() ? 'stalemate' : 'draw'}`;
    }
    if (this.kind === 'board_moved') return BOARD_MOVED;
    if (this.proposal) return `${READING} tap Fix for ${this.proposal.moves.map(moveText).join(', ')}`;
    if (this.kind === 'pending') return READING;
    const moved = board.history().length > 0;
    if (board.turn() === this.userColor) {
      // It is the user's turn, so the last move on the board (if any) was the opponent's.
      const after = moved ? ` (after ${this.lastMoveSquares()})` : '';
      if (!this.best) return this.hasEngine ? `Your move: thinking…${after}` : `Your move${after}`;
      return `Your move: ${moveText(this.best)}${after}`;
    }
    return moved ? `Opponent's turn — last move ${this.lastMoveSquares()}` : "Opponent's turn";
  }
}
