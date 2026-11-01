// The analysis page: paste a PGN, let Stockfish evaluate every position, then step through the
// game with the played move and the better move drawn on the board.

import { Chess } from '../vendor/chess.js';
import { LABELS, buildReport, formatScore, gamePlies, terminalScore, whiteScore, winPercent } from './analysis.js';
import { Engine, engineProblem } from './engine.js';

const STORE_KEY = 'chess-helper-analyse-pgn';
const EXAMPLE = `[Event "Paris Opera"]
[White "Paul Morphy"]
[Black "Duke Karl / Count Isouard"]
[Result "1-0"]

1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5 6. Bc4 Nf6 7. Qb3 Qe7 8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5 11. Bxb5+ Nbd7 12. O-O-O Rd8 13. Rxd7 Rxd7 14. Rd1 Qe6 15. Bxd7+ Nxd7 16. Qb8+ Nxb8 17. Rd8# 1-0`;
const GLYPHS = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
const FIGURINES = { K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘' };
const TEXT = '\uFE0E'; // show chess symbols as text, never as emoji

const $ = (id) => document.getElementById(id);
const els = Object.fromEntries(
  ['pgn', 'example', 'depth', 'side', 'analyse', 'error', 'progress-panel', 'progress-text', 'progress', 'cancel', 'results',
    'summary', 'evalbar', 'board', 'first', 'prev', 'next', 'last', 'comment', 'next-mistake', 'graph', 'moves'].map((id) => [id, $(id)]),
);

const state = { report: null, current: -1, side: 'w', cancelled: false, engine: null };

/** SAN with piece letters as figurines, which read the same in any language. */
const figurine = (san) => san.replace(/[KQRBN]/g, (letter) => FIGURINES[letter] + TEXT);
const moveLabel = (m) => `${m.moveNumber}${m.color === 'w' ? '.' : '…'} ${figurine(m.san)}`;

function showError(message) {
  els.error.textContent = message;
  els.error.hidden = !message;
}

try {
  els.pgn.value = localStorage.getItem(STORE_KEY) ?? '';
} catch {
  // storage blocked: start with an empty box
}

els.example.addEventListener('click', () => {
  els.pgn.value = EXAMPLE;
  els.side.value = 'w';
});

// ---- running the analysis ----

async function analyse() {
  showError('');
  let game;
  try {
    game = gamePlies(els.pgn.value);
  } catch (error) {
    return showError(error.message);
  }
  const problem = engineProblem();
  if (problem) return showError(`Die Analyse geht hier nicht: ${problem}.`);
  try {
    localStorage.setItem(STORE_KEY, els.pgn.value);
  } catch {
    // not saved, nothing else changes
  }

  state.side = els.side.value;
  state.cancelled = false;
  els.analyse.disabled = true;
  els['progress-panel'].hidden = false;
  const ms = Number(els.depth.value);
  const { plies, headers } = game;
  const fens = [plies[0].fenBefore, ...plies.map((p) => p.fenAfter)];
  els.progress.max = fens.length;
  els.progress.value = 0;
  els['progress-text'].textContent = state.engine ? 'Stockfish startet …' : 'Stockfish lädt … (beim ersten Mal bis zu 30 s)';

  try {
    state.engine ??= new Engine();
    await state.engine.ready;
    state.engine.newGame();
    const evals = [];
    for (let i = 0; i < fens.length; i++) {
      if (state.cancelled) throw new Error('cancelled');
      const left = Math.ceil(((fens.length - i) * ms) / 1000);
      els['progress-text'].textContent = `Stockfish prüft Stellung ${i + 1} von ${fens.length} (noch etwa ${left} s) …`;
      const board = new Chess(fens[i]);
      const finished = terminalScore(board);
      if (finished) {
        evals.push({ score: finished, best: null });
      } else {
        const { best, score } = await state.engine.analyse(fens[i], ms);
        evals.push({ score: score ? whiteScore(score, board.turn()) : { cp: 0 }, best });
      }
      els.progress.value = i + 1;
    }
    state.report = buildReport(plies, evals);
    state.report.headers = headers;
    showResults();
  } catch (error) {
    if (error.message !== 'cancelled') {
      console.error(error);
      state.engine = null;
      showError('Stockfish hat nicht geantwortet. Lade die Seite neu und versuch es noch einmal.');
    }
  } finally {
    els.analyse.disabled = false;
    els['progress-panel'].hidden = true;
  }
}

els.analyse.addEventListener('click', analyse);
els.cancel.addEventListener('click', () => {
  state.cancelled = true;
});

// ---- results ----

function showResults() {
  const { summary, headers, moves } = state.report;
  els.summary.replaceChildren(...['w', 'b'].map((color) => sideCard(color, summary[color], headers)));
  els.moves.replaceChildren(...moveList(moves));
  els.results.hidden = false;
  select(firstMistake() ?? -1);
  els.results.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  node.append(...children);
  return node;
}

function sideCard(color, s, headers) {
  const name = (color === 'w' ? headers.White : headers.Black) || (color === 'w' ? 'Weiß' : 'Schwarz');
  const you = color === state.side ? ' (du)' : '';
  const dot = el('span', { class: 'dot', style: `background:${color === 'w' ? '#fff' : '#222'}` });
  return el(
    'div',
    { class: 'panel side' },
    el('h2', {}, dot, `${name}${you}`),
    el('span', { class: 'big' }, s.accuracy === null ? '–' : `${s.accuracy} %`),
    el('span', { class: 'muted small' }, 'Genauigkeit'),
    el(
      'div',
      { class: 'counts', style: 'grid-column:1/-1' },
      el('span', { class: 'chip blunder' }, `${s.blunder} Patzer`),
      el('span', { class: 'chip mistake' }, `${s.mistake} Fehler`),
      el('span', { class: 'chip inaccuracy' }, `${s.inaccuracy} Ungenauigkeiten`),
    ),
  );
}

function moveList(moves) {
  const cells = [];
  moves.forEach((m, i) => {
    if (m.color === 'w' || i === 0) cells.push(el('span', { class: 'no' }, `${m.moveNumber}.`));
    if (i === 0 && m.color === 'b') cells.push(el('span', {}));
    const symbol = m.label ? el('span', { class: `sym ${m.label}` }, LABELS[m.label].symbol) : '';
    cells.push(el('button', { type: 'button', 'data-ply': String(i), onclick: () => select(i) }, figurine(m.san), symbol));
  });
  return cells;
}

const mistakes = (color) => state.report.moves.filter((m) => m.label && (!color || m.color === color));
function firstMistake() {
  return mistakes(state.side)[0]?.ply;
}

function select(index) {
  const moves = state.report.moves;
  state.current = Math.max(-1, Math.min(moves.length - 1, index));
  const move = moves[state.current] ?? null;
  drawBoard(move);
  drawGraph();
  drawComment(move);
  const win = move ? move.winAfter : state.report.startWin;
  els.evalbar.firstElementChild.style.height = `${win}%`;
  for (const button of els.moves.querySelectorAll('button')) {
    const isCurrent = Number(button.dataset.ply) === state.current;
    button.classList.toggle('current', isCurrent);
    if (isCurrent) button.scrollIntoView({ block: 'nearest' });
  }
  els.prev.disabled = els.first.disabled = state.current < 0;
  els.next.disabled = els.last.disabled = state.current >= moves.length - 1;
}

function drawComment(move) {
  els.comment.replaceChildren();
  if (!move) {
    els.comment.append(`Ausgangsstellung · Bewertung ${formatScore(state.report.moves[0].scoreBefore)}`);
    return;
  }
  els.comment.append(el('span', { class: 'san' }, moveLabel(move)));
  if (move.label) {
    els.comment.append(' ', el('span', { class: `tag ${move.label}` }, `${LABELS[move.label].symbol} ${LABELS[move.label].text}`));
  } else if (!move.bestSan) {
    els.comment.append(' ', el('span', { class: 'tag best' }, '✓ bester Zug'));
  }
  els.comment.append(` · Bewertung ${formatScore(move.scoreBefore)} → ${formatScore(move.scoreAfter)}`);
  if (move.bestSan && move.label) {
    const number = `${move.moveNumber}${move.color === 'w' ? '.' : '…'}`;
    els.comment.append(el('br'), 'Besser war ', el('span', { class: 'san' }, `${number} ${figurine(move.bestSan)}`), '.');
  }
}

// ---- board ----

const SVG = 'http://www.w3.org/2000/svg';
function svg(tag, attrs = {}) {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

/** Board coordinates (column, row from the top) of a square name, for the chosen side. */
function cell(square) {
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]) - 1;
  return state.side === 'w' ? [file, 7 - rank] : [7 - file, rank];
}

function drawBoard(move) {
  const board = els.board;
  const styles = getComputedStyle(document.documentElement);
  const colour = (name) => styles.getPropertyValue(name).trim();
  const position = new Chess(move ? move.fenAfter : state.report.moves[0].fenBefore);
  board.replaceChildren();
  const defs = svg('defs');
  for (const [id, fill] of [['played', colour('--played')], ['best', colour('--accent')]]) {
    const marker = svg('marker', { id: `head-${id}`, viewBox: '0 0 10 10', refX: '5', refY: '5', markerWidth: '3', markerHeight: '3', orient: 'auto-start-reverse' });
    marker.append(svg('path', { d: 'M0,0 L10,5 L0,10 z', fill }));
    defs.append(marker);
  }
  board.append(defs);
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      board.append(svg('rect', { x: col, y: row, width: 1, height: 1, fill: (row + col) % 2 ? colour('--sq-dark') : colour('--sq-light') }));
    }
  }
  if (move) {
    for (const square of [move.uci.slice(0, 2), move.uci.slice(2, 4)]) {
      const [col, row] = cell(square);
      board.append(svg('rect', { x: col, y: row, width: 1, height: 1, fill: colour('--played'), opacity: '0.28' }));
    }
  }
  // file names along the bottom row, rank names down the left column, in the opposite square colour
  const onSquare = (col, row) => ((row + col) % 2 ? colour('--sq-light') : colour('--sq-dark'));
  const label = (text, x, y, anchor, fill) => {
    const t = svg('text', { x, y, 'font-size': '0.2', 'text-anchor': anchor, fill, 'font-family': 'system-ui, sans-serif', 'font-weight': '600' });
    t.textContent = text;
    return t;
  };
  for (let i = 0; i < 8; i++) {
    const file = 'abcdefgh'[state.side === 'w' ? i : 7 - i];
    const rank = String(state.side === 'w' ? 8 - i : i + 1);
    board.append(label(file, i + 0.94, 7.94, 'end', onSquare(i, 7)), label(rank, 0.05, i + 0.22, 'start', onSquare(0, i)));
  }
  for (const row of position.board()) {
    for (const piece of row) {
      if (!piece) continue;
      const [col, rowIndex] = cell(piece.square);
      const t = svg('text', {
        x: col + 0.5, y: rowIndex + 0.8, 'font-size': '0.82', 'text-anchor': 'middle',
        fill: piece.color === 'w' ? '#ffffff' : '#1d1f1e', stroke: piece.color === 'w' ? '#1d1f1e' : '#e9e6db',
        'stroke-width': '0.035', 'paint-order': 'stroke', 'font-family': '"Apple Symbols", "Segoe UI Symbol", "DejaVu Sans", serif',
      });
      t.textContent = GLYPHS[piece.type] + TEXT;
      board.append(t);
    }
  }
  if (move) {
    board.append(arrow(move.uci, 'played', colour('--played')));
    if (move.bestUci && move.label) board.append(arrow(move.bestUci, 'best', colour('--accent')));
  }
}

function arrow(uci, kind, stroke) {
  const [c1, r1] = cell(uci.slice(0, 2));
  const [c2, r2] = cell(uci.slice(2, 4));
  const [x1, y1, x2, y2] = [c1 + 0.5, r1 + 0.5, c2 + 0.5, r2 + 0.5];
  const length = Math.hypot(x2 - x1, y2 - y1);
  const shorten = 0.28 / length; // stop before the square's centre so the head stays on the square
  return svg('line', {
    x1, y1, x2: x2 - (x2 - x1) * shorten, y2: y2 - (y2 - y1) * shorten,
    stroke, 'stroke-width': '0.15', 'stroke-linecap': 'round', opacity: '0.85', 'marker-end': `url(#head-${kind})`,
  });
}

// ---- evaluation curve ----

function drawGraph() {
  const { moves, startWin } = state.report;
  const styles = getComputedStyle(document.documentElement);
  const colour = (name) => styles.getPropertyValue(name).trim();
  const n = moves.length;
  const x = (i) => ((i + 1) / n) * 100; // i = -1 is the start
  const y = (win) => 40 - (win / 100) * 40;
  const points = [[x(-1), y(startWin)], ...moves.map((m, i) => [x(i), y(m.winAfter)])];
  const graph = els.graph;
  graph.replaceChildren(
    svg('rect', { x: 0, y: 0, width: 100, height: 40, fill: colour('--graph-black') }),
    svg('path', { d: `M0,40 ${points.map(([px, py]) => `L${px},${py}`).join(' ')} L100,40 Z`, fill: colour('--graph-white') }),
    svg('line', { x1: 0, y1: 20, x2: 100, y2: 20, stroke: colour('--muted'), 'stroke-width': '0.3', 'stroke-dasharray': '1 1', 'vector-effect': 'non-scaling-stroke' }),
  );
  moves.forEach((m, i) => {
    if (!m.label) return;
    graph.append(svg('line', { x1: x(i), y1: 0, x2: x(i), y2: 40, stroke: colour(`--${m.label}`), 'stroke-width': '2', 'vector-effect': 'non-scaling-stroke', opacity: '0.8' }));
  });
  graph.append(svg('line', { x1: x(state.current), y1: 0, x2: x(state.current), y2: 40, stroke: colour('--accent'), 'stroke-width': '3', 'vector-effect': 'non-scaling-stroke' }));
}

els.graph.addEventListener('click', (event) => {
  if (!state.report) return;
  const rect = els.graph.getBoundingClientRect();
  const n = state.report.moves.length;
  select(Math.round(((event.clientX - rect.left) / rect.width) * n) - 1);
});

// ---- navigation ----

els.first.addEventListener('click', () => select(-1));
els.prev.addEventListener('click', () => select(state.current - 1));
els.next.addEventListener('click', () => select(state.current + 1));
els.last.addEventListener('click', () => select(Infinity));
els['next-mistake'].addEventListener('click', () => {
  const own = mistakes(state.side);
  const next = own.find((m) => m.ply > state.current) ?? own[0];
  if (next) select(next.ply);
});
document.addEventListener('keydown', (event) => {
  if (!state.report || event.target === els.pgn) return;
  const keys = { ArrowLeft: state.current - 1, ArrowRight: state.current + 1, Home: -1, End: Infinity };
  if (event.key in keys) {
    event.preventDefault();
    select(keys[event.key]);
  }
});
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => state.report && select(state.current));
