// Chess Helper on the phone: film the board with the rear camera, follow the game and show
// Stockfish's best move on the live picture. Everything runs in this page.

import { Chess } from '../vendor/chess.js';
import { BoardView, quadArea } from './geometry.js';
import { MoveDetector, Stillness, legalMoves } from './detector.js';
import { Engine } from './engine.js';
import { Session } from './session.js';
import { DEFAULT_CORNERS, CANVAS_W, render } from './synthetic.js';
import { WRONG_CORNERS, changeScores, checkStartPosition, sampleBoard, samplePoints } from './vision.js';

const PROC_WIDTH = 640; // frames are shrunk to this width before the board is read
const FRAME_MS = 200; // about 5 readings per second
const STILL_TIMEOUT_MS = 3000; // longest wait for a still picture before taking a reference anyway
const MIN_BOARD_AREA = 0.01; // tapped corners enclosing less of the picture than this cannot be a board
const CORNER_PROMPTS = [
  'Tap corner a1 (under White’s left rook)',
  'Tap corner h1 (under White’s right rook)',
  'Tap corner h8 (Black’s rook on that side)',
  'Tap corner a8 (the last corner)',
];
const DEMO_GAME = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'O-O', 'Nf6', 'd3', 'd6', 'h3', 'O-O'];

const $ = (id) => document.getElementById(id);
const els = {
  stage: $('stage'), video: $('video'), demo: $('demo'), overlay: $('overlay'),
  status: $('status'), intro: $('intro'), introError: $('intro-error'), start: $('start'),
  cornerBar: $('corner-bar'), clearCorners: $('clear-corners'),
  colourBar: $('colour-bar'), playWhite: $('play-white'), playBlack: $('play-black'),
  playBar: $('play-bar'), undo: $('undo'), fix: $('fix'), redo: $('redo'), demoNext: $('demo-next'),
};

const demoMode = new URLSearchParams(location.search).has('demo');
const proc = document.createElement('canvas');
const procCtx = proc.getContext('2d', { willReadFrequently: true });

const state = {
  stage: 'intro', // intro, corners, checking, colour, play
  message: '', // shown in the banner instead of the normal prompt, e.g. after a failed check
  corners: [], // tapped corners in processing-canvas pixels
  view: null,
  points: null,
  session: null,
  detector: null,
  stillness: new Stillness(),
  previous: null,
  engine: null,
  engineNote: '',
  job: null, // the position the search in flight was started for
  demoBoard: null,
  demoIndex: 0,
  running: false,
};

// ---- frame source: the camera, or a rendered board in demo mode ----

function sourceSize() {
  return demoMode ? { w: els.demo.width, h: els.demo.height } : { w: els.video.videoWidth, h: els.video.videoHeight };
}

function grabFrame() {
  const { w, h } = sourceSize();
  if (!w || !h) return null;
  const ph = Math.round((PROC_WIDTH * h) / w);
  if (proc.width !== PROC_WIDTH || proc.height !== ph) {
    proc.width = PROC_WIDTH;
    proc.height = ph;
  }
  procCtx.drawImage(demoMode ? els.demo : els.video, 0, 0, PROC_WIDTH, ph);
  return procCtx.getImageData(0, 0, PROC_WIDTH, ph);
}

function drawDemoBoard() {
  const picture = render(state.demoBoard, { noise: 3, seed: state.demoIndex });
  els.demo.width = picture.width;
  els.demo.height = picture.height;
  els.demo.getContext('2d').putImageData(new ImageData(picture.data, picture.width, picture.height), 0, 0);
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('This browser can’t use the camera here. Open the page over https in Safari or Chrome.');
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    els.video.srcObject = stream;
    await els.video.play();
  } catch (error) {
    if (error.name === 'NotAllowedError') {
      throw new Error('Camera access is blocked. Allow the camera for this site in your browser settings, then reload.');
    }
    if (error.name === 'NotFoundError') throw new Error('No camera found on this device.');
    throw error;
  }
}

let wakeLock = null;
async function keepAwake() {
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch {
    wakeLock = null; // not supported or refused: the screen may dim, nothing else breaks
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.running) keepAwake();
});

// ---- coordinates: processing pixels <-> the picture on screen ----

function displayFit() {
  const { w, h } = sourceSize();
  const rect = els.stage.getBoundingClientRect();
  const scale = Math.min(rect.width / w, rect.height / h);
  return { scale, dx: (rect.width - w * scale) / 2, dy: (rect.height - h * scale) / 2, w, rect };
}

function toScreen([x, y]) {
  const fit = displayFit();
  const s = (fit.w / PROC_WIDTH) * fit.scale;
  return [fit.dx + x * s, fit.dy + y * s];
}

function toProc(clientX, clientY) {
  const fit = displayFit();
  const s = (fit.w / PROC_WIDTH) * fit.scale;
  return [(clientX - fit.rect.left - fit.dx) / s, (clientY - fit.rect.top - fit.dy) / s];
}

// ---- reading the board ----

function look() {
  const frame = grabFrame();
  return frame && sampleBoard(frame, state.points);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A board sample taken once the picture has been still for a moment (or after STILL_TIMEOUT_MS). */
async function stillSample() {
  const stillness = new Stillness();
  const started = performance.now();
  let previous = look();
  for (;;) {
    await sleep(FRAME_MS);
    const sample = look();
    if (stillness.update(changeScores(previous, sample)) || performance.now() - started > STILL_TIMEOUT_MS) return sample;
    previous = sample;
  }
}

function useCorners(corners) {
  state.view = new BoardView(corners);
  state.points = samplePoints(state.view);
}

async function finishCorners() {
  const area = quadArea(state.corners) / (proc.width * proc.height);
  if (area < MIN_BOARD_AREA) {
    state.corners = [];
    state.message = WRONG_CORNERS;
    return render_();
  }
  useCorners(state.corners);
  setStage('checking');
  const sample = await stillSample();
  if (!state.session) {
    const problem = checkStartPosition(sample);
    if (problem) {
      state.corners = [];
      state.message = problem;
      return setStage('corners');
    }
    return setStage('colour');
  }
  // Corners tapped again during a game: keep the game, compare with the new view from now on.
  state.session.setReference(sample);
  startDetecting();
}

async function chooseColour(colour) {
  setStage('checking');
  const reference = await stillSample();
  state.session = new Session(colour, reference);
  if (state.engine === null) state.session.hasEngine = false;
  startDetecting();
}

function startDetecting() {
  state.detector = new MoveDetector(state.view.behindStep());
  state.stillness = new Stillness();
  state.previous = state.session.reference;
  setStage('play');
}

function tick() {
  if (state.stage !== 'play' || document.visibilityState !== 'visible') return;
  const sample = look();
  if (!sample) return;
  const session = state.session;
  const still = state.stillness.update(changeScores(state.previous, sample));
  state.previous = sample;
  const det = state.detector.update(session.board, changeScores(session.reference, sample), still);
  session.onDetection(det, sample);
  askEngine();
  render_();
}

function askEngine() {
  const session = state.session;
  if (!state.engine || state.job || !session.needsEngine()) return;
  const fen = session.board.fen();
  state.job = fen;
  state.engine
    .bestMove(fen)
    .then((uci) => {
      if (!uci || session.board.fen() !== fen) return; // the game moved on while Stockfish was thinking
      const moves = legalMoves(session.board);
      session.setBest(moves.find((m) => m.uci === uci) ?? moves.find((m) => m.uci === uci.slice(0, 4) + 'q') ?? null);
    })
    .catch(() => {
      state.engine = null;
      session.hasEngine = false;
      state.engineNote = ' (Stockfish stopped — reload to get moves)';
    })
    .finally(() => {
      state.job = null;
      render_();
    });
}

async function loop() {
  for (;;) {
    const started = performance.now();
    try {
      tick();
    } catch (error) {
      console.error(error);
    }
    await sleep(Math.max(0, FRAME_MS - (performance.now() - started)));
  }
}

// ---- screen ----

function setStage(stage) {
  state.stage = stage;
  if (stage === 'play') state.message = '';
  render_();
}

function bannerText() {
  switch (state.stage) {
    case 'corners':
      return state.message ? `${state.message} ${CORNER_PROMPTS[state.corners.length]}` : CORNER_PROMPTS[state.corners.length];
    case 'checking':
      return 'Hold still — checking the board…';
    case 'colour':
      return 'Which side are you playing?';
    case 'play':
      return state.session.status() + state.engineNote;
    default:
      return '';
  }
}

function render_() {
  els.intro.hidden = state.stage !== 'intro';
  els.cornerBar.hidden = state.stage !== 'corners';
  els.colourBar.hidden = state.stage !== 'colour';
  els.playBar.hidden = state.stage !== 'play';
  els.demoNext.hidden = !demoMode || state.stage !== 'play';
  els.status.parentElement.hidden = state.stage === 'intro';
  els.status.textContent = bannerText();
  if (state.session) {
    els.undo.disabled = state.session.history.length === 0;
    els.fix.disabled = !state.session.canFix();
  }
  drawOverlay();
}

function drawOverlay() {
  const canvas = els.overlay;
  const rect = els.stage.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(rect.width * ratio) || canvas.height !== Math.round(rect.height * ratio)) {
    canvas.width = Math.round(rect.width * ratio);
    canvas.height = Math.round(rect.height * ratio);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);
  if (!sourceSize().w) return;
  const styles = getComputedStyle(document.documentElement);
  const accent = styles.getPropertyValue('--move').trim();

  if (state.stage === 'corners') {
    const points = state.corners.map(toScreen);
    ctx.strokeStyle = accent;
    ctx.fillStyle = accent;
    ctx.lineWidth = 2;
    ctx.beginPath();
    points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke();
    for (const [x, y] of points) {
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.fill();
    }
    return;
  }
  if (state.stage !== 'play' || !state.view) return;

  // the board outline, so it's clear the corners still line up
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  state.view.corners.map(toScreen).forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.stroke();

  const best = state.session.best;
  if (!best) return;
  const polygons = [best.from, best.to].map((square) => state.view.squarePolygon(square).map(toScreen));
  ctx.fillStyle = accent;
  ctx.strokeStyle = accent;
  for (const polygon of polygons) {
    ctx.beginPath();
    polygon.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.globalAlpha = 0.45;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 3;
    ctx.stroke();
  }
  const centre = (polygon) => polygon.reduce(([sx, sy], [x, y]) => [sx + x / 4, sy + y / 4], [0, 0]);
  const [x1, y1] = centre(polygons[0]);
  const [x2, y2] = centre(polygons[1]);
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const head = 14;
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - head * Math.cos(angle - 0.5), y2 - head * Math.sin(angle - 0.5));
  ctx.lineTo(x2 - head * Math.cos(angle + 0.5), y2 - head * Math.sin(angle + 0.5));
  ctx.closePath();
  ctx.fill();
}

// ---- controls ----

els.start.addEventListener('click', async () => {
  els.introError.hidden = true;
  els.start.disabled = true;
  try {
    if (demoMode) {
      state.demoBoard = new Chess();
      drawDemoBoard();
      els.demo.hidden = false;
      els.video.hidden = true;
    } else {
      await startCamera();
    }
  } catch (error) {
    els.introError.textContent = error.message;
    els.introError.hidden = false;
    els.start.disabled = false;
    return;
  }
  try {
    state.engine = new Engine();
    state.engine.ready.catch(() => {
      state.engine = null;
      if (state.session) state.session.hasEngine = false;
      state.engineNote = ' (Stockfish didn’t load — reload to try again)';
      render_();
    });
  } catch {
    state.engine = null;
    state.engineNote = ' (Stockfish didn’t load — reload to try again)';
  }
  keepAwake();
  state.running = true;
  setStage('corners');
  if (demoMode) {
    // the demo board's corners are known, so skip the taps
    state.corners = DEFAULT_CORNERS.map(([x, y]) => [(x * PROC_WIDTH) / CANVAS_W, (y * PROC_WIDTH) / CANVAS_W]);
    grabFrame();
    finishCorners();
  }
  loop();
});

els.overlay.addEventListener('pointerdown', (event) => {
  if (state.stage !== 'corners' || state.corners.length >= 4) return;
  if (!grabFrame()) return; // sets the processing size used by toProc
  state.message = '';
  state.corners.push(toProc(event.clientX, event.clientY));
  render_();
  if (state.corners.length === 4) finishCorners();
});

els.clearCorners.addEventListener('click', () => {
  state.corners = [];
  state.message = '';
  render_();
});
els.playWhite.addEventListener('click', () => chooseColour('w'));
els.playBlack.addEventListener('click', () => chooseColour('b'));
els.undo.addEventListener('click', () => {
  state.session.undo();
  state.detector.reset();
  render_();
});
els.fix.addEventListener('click', () => {
  state.session.fix();
  state.detector.reset();
  render_();
});
els.redo.addEventListener('click', () => {
  state.corners = [];
  state.message = '';
  setStage('corners');
});
els.demoNext.addEventListener('click', () => {
  const san = DEMO_GAME[state.demoIndex];
  if (!san) return; // the demo game is over
  state.demoBoard.move(san);
  state.demoIndex++;
  drawDemoBoard();
});

if (demoMode) els.start.textContent = 'Start demo board';
window.addEventListener('resize', () => render_());
render_();
