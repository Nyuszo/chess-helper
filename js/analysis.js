// Game analysis: turn a PGN plus one Stockfish evaluation per position into a report of
// mistakes, better moves and accuracy. Pure logic, no engine or page code.
//
// Scores are { cp } (centipawns) or { mate } (moves to mate). Engine scores are from the side to
// move; everything in a report is from White's side (positive = good for White). A position that
// is already checkmate is { mate: 0, winner: 'w' | 'b' }.
// Thresholds follow lichess: a move that loses 5 / 10 / 15 points of winning chance is an
// inaccuracy / mistake / blunder.

import { Chess } from '../vendor/chess.js';

export const INACCURACY = 5;
export const MISTAKE = 10;
export const BLUNDER = 15;

export const LABELS = {
  blunder: { text: 'Patzer', symbol: '??' },
  mistake: { text: 'Fehler', symbol: '?' },
  inaccuracy: { text: 'Ungenauigkeit', symbol: '?!' },
};

/** An engine score (from the side to move, `turn` = 'w' or 'b') seen from White's side. */
export function whiteScore(score, turn) {
  const sign = turn === 'w' ? 1 : -1;
  if ('cp' in score) return { cp: sign * score.cp };
  if (score.mate === 0) return { mate: 0, winner: turn === 'w' ? 'b' : 'w' }; // the side to move is mated
  return { mate: sign * score.mate };
}

/** The score of a finished position (White's side), or null if the game goes on. */
export function terminalScore(board) {
  if (board.isCheckmate()) return { mate: 0, winner: board.turn() === 'w' ? 'b' : 'w' };
  if (board.isDraw() || board.isStalemate()) return { cp: 0 };
  return null;
}

/** White's chance of winning, 0..100, from a White-side score (lichess formula). */
export function winPercent(score) {
  if ('cp' in score) return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * score.cp)) - 1);
  if (score.mate === 0) return score.winner === 'w' ? 100 : 0;
  return score.mate > 0 ? 100 : 0;
}

/** A White-side score for people: "+1.2", "−0.4", "#3", "#−2", "Matt". */
export function formatScore(score) {
  if ('cp' in score) {
    const pawns = score.cp / 100;
    const text = Math.abs(pawns).toFixed(1);
    if (text === '0.0') return '0.0';
    return pawns > 0 ? `+${text}` : `−${text}`;
  }
  if (score.mate === 0) return 'Matt';
  return score.mate > 0 ? `#${score.mate}` : `#−${-score.mate}`;
}

export function classify(loss) {
  if (loss >= BLUNDER) return 'blunder';
  if (loss >= MISTAKE) return 'mistake';
  if (loss >= INACCURACY) return 'inaccuracy';
  return null;
}

/** How accurate one move was, 0..100, from the winning chance it lost (lichess formula). */
export function moveAccuracy(loss) {
  return Math.min(100, Math.max(0, 103.1668 * Math.exp(-0.04354 * loss) - 3.1669));
}

/** The game's moves with the position before and after each, from a PGN or a plain move list. */
export function gamePlies(pgn) {
  const board = new Chess();
  try {
    board.loadPgn(pgn.trim());
  } catch {
    throw new Error('Das PGN konnte nicht gelesen werden. Kopiere es nach der Partie bei chess.com über Teilen → PGN.');
  }
  const moves = board.history({ verbose: true });
  if (!moves.length) throw new Error('In dem Text stehen keine Züge.');
  return {
    headers: board.getHeaders(),
    plies: moves.map((move, i) => ({
      ply: i,
      moveNumber: Number(move.before.split(' ')[5]), // the FEN's full-move counter
      color: move.color,
      san: move.san,
      uci: move.lan,
      fenBefore: move.before,
      fenAfter: move.after,
    })),
  };
}

/** The best move `uci` in SAN for the position `fen`, or null. */
function sanOf(fen, uci) {
  if (!uci) return null;
  try {
    return new Chess(fen).move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || 'q' }).san;
  } catch {
    return null;
  }
}

/**
 * The report. `evals[i]` is the evaluation of the position before ply i (and `evals[plies.length]`
 * the final position): { score: White-side score, best: engine's best move in UCI or null }.
 */
export function buildReport(plies, evals) {
  const moves = plies.map((ply, i) => {
    const before = evals[i];
    const after = evals[i + 1];
    const winBefore = winPercent(before.score);
    const winAfter = winPercent(after.score);
    const mover = (win) => (ply.color === 'w' ? win : 100 - win);
    const isBest = before.best === ply.uci;
    const loss = isBest ? 0 : Math.max(0, mover(winBefore) - mover(winAfter));
    const label = classify(loss);
    return {
      ...ply,
      scoreBefore: before.score,
      scoreAfter: after.score,
      winAfter,
      loss,
      label,
      accuracy: moveAccuracy(loss),
      bestUci: isBest ? null : before.best,
      bestSan: isBest ? null : sanOf(ply.fenBefore, before.best),
    };
  });
  const summary = {};
  for (const color of ['w', 'b']) {
    const own = moves.filter((m) => m.color === color);
    summary[color] = {
      moves: own.length,
      accuracy: own.length ? Math.round(own.reduce((sum, m) => sum + m.accuracy, 0) / own.length) : null,
      blunder: own.filter((m) => m.label === 'blunder').length,
      mistake: own.filter((m) => m.label === 'mistake').length,
      inaccuracy: own.filter((m) => m.label === 'inaccuracy').length,
    };
  }
  return { moves, summary, startWin: winPercent(evals[0].score) };
}
