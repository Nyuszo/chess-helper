// Decide which legal move (or pair of moves) was played from per-square change scores.
// Port of the Mac version's move_detector.py: same constants, fit formula and decision rules.
//
// `scores` has 64 numbers indexed a1 = 0 ... h8 = 63, from 0 (unchanged) to 1 (completely
// different from the last confirmed board picture). Positions are chess.js `Chess` objects.

import { distance, fileOf, rankOf, squareAt, squareIndex } from './geometry.js';

export const CHANGED = 0.35; // a square scoring at least this has really changed
export const NOISE = 0.2; // scores below this on an unaffected square are ignored
export const MARGIN = 0.15; // the best candidate must beat the runner-up by this much
export const MAX_ALTERNATIVES = 3; // other plausible readings handed back with a move
export const STILL_MAX = 0.2; // a frame is "quiet" when no square changed more than this
export const STILL_FRAMES = 3; // quiet frames in a row before the picture counts as still
export const CONFIRM_STREAK = 2; // identical accepted readings in a row before a move is confirmed
export const UNSURE_FRAMES = 3; // still frames the same close call must lead before it is offered
export const BOARD_MOVED_SQUARES = 8; // more changed squares than this means the camera or board moved

/** A move as used here: square indexes plus what chess.js says about it. */
export function toMove(verbose) {
  return {
    from: squareIndex(verbose.from),
    to: squareIndex(verbose.to),
    promotion: verbose.promotion || null,
    flags: verbose.flags,
    piece: verbose.piece,
    uci: verbose.lan,
  };
}

export const sameMoves = (a, b) => !!a && !!b && a.length === b.length && a.every((m, i) => m.uci === b[i].uci);

const NEIGHBOURS = Array.from({ length: 64 }, (_, s) => Array.from({ length: 64 }, (_, t) => t).filter((t) => distance(s, t) === 1));

/** Legal moves of `board`, promotions to a queen only. */
export function legalMoves(board) {
  return board
    .moves({ verbose: true })
    .filter((m) => !m.promotion || m.promotion === 'q')
    .map(toMove);
}

/** Every square whose contents change when `move` is played. */
export function affectedSquares(move) {
  const squares = new Set([move.from, move.to]);
  const rank = rankOf(move.from);
  if (move.flags.includes('k')) {
    squares.add(squareAt(7, rank)).add(squareAt(5, rank));
  } else if (move.flags.includes('q')) {
    squares.add(squareAt(0, rank)).add(squareAt(3, rank));
  } else if (move.flags.includes('e')) {
    squares.add(squareAt(fileOf(move.to), rank));
  }
  return squares;
}

function sequenceAffected(moves) {
  const squares = new Set();
  for (const move of moves) for (const s of affectedSquares(move)) squares.add(s);
  return squares;
}

/** The square `behind` steps away from `square`, or null if that falls off the board. */
function behindOf(square, behind) {
  const target = square + behind;
  if (target < 0 || target >= 64) return null;
  if (Math.abs(behind) === 1 && rankOf(target) !== rankOf(square)) return null;
  return target;
}

/** The squares behind the affected ones (away from the camera), where tall pieces spill into. */
function smear(aff, behind) {
  const squares = new Set();
  for (const s of aff) {
    const t = behindOf(s, behind);
    if (t !== null) squares.add(t);
  }
  return squares;
}

/** How cleanly the changed squares match `aff`: weakest affected square minus stray change. */
function fit(scores, aff, behind) {
  let hit = Infinity;
  for (const s of aff) hit = Math.min(hit, scores[s]);
  const free = smear(aff, behind);
  const near = new Set();
  for (const s of aff) for (const n of NEIGHBOURS[s]) if (!aff.has(n)) near.add(n);
  let extra = 0;
  for (let s = 0; s < 64; s++) {
    if (aff.has(s)) continue;
    const weight = free.has(s) ? 0 : near.has(s) ? 0.5 : 1;
    extra += weight * Math.max(0, scores[s] - NOISE);
  }
  return hit - extra;
}

/** True if some square outside `aff` and its behind squares changed as much as a real move would. */
function leavesUnexplained(scores, aff, behind) {
  const explained = new Set([...aff, ...smear(aff, behind)]);
  for (let s = 0; s < 64; s++) if (!explained.has(s) && scores[s] >= CHANGED) return true;
  return false;
}

const play = (board, move) => board.move({ from: move.uci.slice(0, 2), to: move.uci.slice(2, 4), ...(move.promotion && { promotion: move.promotion }) });

/** Candidate moves (or move pairs) that could explain `scores`, best fit first: [{moves, fit}]. */
export function rankMoves(board, scores, behind = 8) {
  const candidates = legalMoves(board).map((move) => ({ moves: [move], fit: fit(scores, affectedSquares(move), behind) }));
  const best = candidates.reduce((a, c) => (c.fit > a.fit ? c : a), candidates[0] ?? { moves: [], fit: 0 });
  const changed = scores.filter((v) => v >= CHANGED).length;
  if (changed >= 3 && (best.fit <= 0 || leavesUnexplained(scores, sequenceAffected(best.moves), behind))) {
    for (const first of legalMoves(board)) {
      if (scores[first.from] < CHANGED) continue;
      play(board, first);
      const firstSquares = affectedSquares(first);
      for (const second of legalMoves(board)) {
        const aff = new Set([...firstSquares, ...affectedSquares(second)]);
        candidates.push({ moves: [first, second], fit: fit(scores, aff, behind) });
      }
      board.undo();
    }
  }
  return candidates.sort((a, b) => b.fit - a.fit);
}

/** Tracks whether the picture has been quiet for several frames in a row. */
export class Stillness {
  constructor() {
    this.quietFrames = 0;
  }

  /** Feed the change scores between two consecutive frames; true once the view is still. */
  update(frameScores) {
    this.quietFrames = Math.max(...frameScores) < STILL_MAX ? this.quietFrames + 1 : 0;
    return this.quietFrames >= STILL_FRAMES;
  }
}

/** kind is "none", "pending", "confirmed", "unsure" or "board_moved". */
export const detection = (kind, moves = [], alternatives = []) => ({ kind, moves, alternatives });

/** Turns repeated (board, scores, still) readings into a confirmed move, or an "unsure" close call. */
export class MoveDetector {
  constructor(behind = 8) {
    this.behind = behind;
    this.reset();
  }

  reset() {
    this.last = null;
    this.streak = 0;
    this.close = null; // the close-call candidate leading right now
    this.closeFrames = 0;
  }

  update(board, scores, still) {
    if (!still) {
      this.reset();
      return detection('pending');
    }
    const changed = scores.filter((v) => v >= CHANGED).length;
    if (!changed) {
      this.reset();
      return detection('none');
    }
    const reading = this.read(board, scores);
    if (!reading) {
      this.reset();
      return detection(changed > BOARD_MOVED_SQUARES ? 'board_moved' : 'pending');
    }
    const { moves, alternatives, closeCall } = reading;
    if (closeCall) {
      // never confirmed, but a candidate that keeps leading is offered to the user
      this.last = null;
      this.streak = 0;
      this.closeFrames = sameMoves(moves, this.close) ? this.closeFrames + 1 : 1;
      this.close = moves;
      return this.closeFrames >= UNSURE_FRAMES ? detection('unsure', moves, alternatives) : detection('pending');
    }
    this.close = null;
    this.closeFrames = 0;
    this.streak = sameMoves(moves, this.last) ? this.streak + 1 : 1;
    this.last = moves;
    if (this.streak >= CONFIRM_STREAK) {
      this.reset();
      return detection('confirmed', moves, alternatives);
    }
    return detection('pending');
  }

  /** The best candidate, its alternatives and whether it is only a close call, if it explains `scores`. */
  read(board, scores) {
    const ranked = rankMoves(board, scores, this.behind);
    if (!ranked.length) return null;
    const [{ moves, fit: bestFit }] = ranked;
    if (bestFit <= 0) return null;
    const allChanged = (ms) => [...sequenceAffected(ms)].every((s) => scores[s] >= CHANGED);
    if (!allChanged(moves)) return null;
    const closeCall = ranked.length > 1 && bestFit - ranked[1].fit < MARGIN;
    const alternatives = ranked
      .slice(1)
      .filter((c) => c.fit > 0 && allChanged(c.moves))
      .slice(0, MAX_ALTERNATIVES)
      .map((c) => c.moves);
    return { moves, alternatives, closeCall };
  }
}
