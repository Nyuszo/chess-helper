// Chess Helper on the phone: film the board with the rear camera, follow the game and show
// Stockfish's best move on the live picture. Everything runs in this page.

import { Chess } from '../vendor/chess.js';
import { BoardView, quadArea } from './geometry.js';
import { MoveDetector, Stillness, legalMoves } from './detector.js';
import { Engine, engineProblem } from './engine.js';
import { Session } from './session.js';
import { DEFAULT_CORNERS, CANVAS_W, render } from './synthetic.js';
import { WRONG_CORNERS, changeScores, checkStartPosition, sampleBoard, samplePoints } from './vision.js';

const PROC_WIDTH = 640; // frames are shrunk to this width before the board is read
const FRAME_MS = 200; // about 5 readings per second
const STILL_TIMEOUT_MS = 3000; // longest wait for a still picture before taking a reference anyway
const PLAY_TIMEOUT_MS = 4000; // don't wait longer than this for the video to report it is playing
const MIN_BOARD_AREA = 0.01; // tapped corners enclosing less of the picture than this cannot be a board
const CORNER_PROMPTS = [
  'Tap corner a1 (under White’s left rook)',
  'Tap corner h1 (under White’s right rook)',
  'Tap corner h8 (Black’s rook on that side)',
  'Tap corner a8 (the last corner)',
];
const READ_FAILED = 'Couldn’t read the board there.';
const TURNED = 'The picture turned.';
const AUTO_LOCK_TIP = ' Tip: set Auto-Lock to Never so the screen stays on.';
const DEMO_GAME = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'O-O', 'Nf6', 'd3', 'd6', 'h3', 'O-O'];

const $ = (id) => document.getElementById(id);
const els = {
  stage: $('stage'), video: $('video'), demo: $('demo'), overlay: $('overlay'),
  banner: $('banner'), status: $('status'), intro: $('intro'), introError: $('intro-error'), start: $('start'),
  cornerBar: $('corner-bar'), clearCorners: $('clear-corners'),
  colourBar: $('colour-bar'), playWhite: $('play-white'), playBlack: $('play-black'),
  playBar: $('play-bar'), undo: $('undo'), fix: $('fix'), redo: $('redo'), demoNext: $('demo-next'),
  cameraBar: $('camera-bar'), restartCamera: $('restart-camera'),
};

// Right after an update, the browser can hold an old copy of the page next to this newer script.
// Then some buttons are missing: say so instead of half-working.
const missing = Object.keys(els).filter((key) => !els[key]);
if (missing.length) {
  const note = document.getElementById('intro-error');
  if (note) {
    note.textContent = 'This page was just updated. Reload it to get the new version (wait a minute if it happens again).';
    note.hidden = false;
  }
  window.chessHelperLoaded = true; // the message above replaces the generic "didn't load" one
  throw new Error(`page and script versions differ; missing: ${missing.join(', ')}`);
}

const demoMode = new URLSearchParams(location.search).has('demo');
const proc = document.createElement('canvas');
const procCtx = proc.getContext('2d', { willReadFrequently: true });

const state = {
  stage: 'intro', // intro, corners, checking, colour, play, camera-lost
  message: '', // shown before the corner prompt, e.g. after a failed check
  corners: [], // tapped corners in processing-canvas pixels
  dragPoint: null, // where the finger is while placing a corner
  calibratedSize: null, // the picture size the corners were tapped on
  view: null,
  points: null,
  session: null,
  detector: null,
  stillness: new Stillness(),
  previous: null,
  engine: null,
  engineNote: '',
  job: false, // a search is in flight
  stream: null,
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

const timeout = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sleep = timeout;

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('This browser can’t use the camera here. Open the page over https in Safari or Chrome.');
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
  } catch (error) {
    if (error.name === 'NotAllowedError') {
      throw new Error('Camera access is blocked. Allow the camera for this site in your browser settings, then reload.');
    }
    if (error.name === 'NotFoundError') throw new Error('No camera found on this device.');
    throw error;
  }
  els.video.srcObject = stream;
  try {
    await Promise.race([els.video.play(), timeout(PLAY_TIMEOUT_MS)]);
  } catch {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error('The camera started but the picture didn’t play. Reload the page and try again.');
  }
  state.stream?.getTracks().forEach((track) => track.stop());
  state.stream = stream;
  for (const track of stream.getVideoTracks()) track.addEventListener('ended', cameraLost);
}

function cameraLost() {
  if (state.stage === 'intro') return;
  setStage('camera-lost');
}

let wakeLock = null;
function keepAwake() {
  if (wakeLock || !navigator.wakeLock) return;
  navigator.wakeLock
    .request('screen')
    .then((lock) => {
      wakeLock = lock;
      lock.addEventListener('release', () => {
        wakeLock = null;
      });
    })
    .catch(() => {
      wakeLock = null; // not allowed here: the screen may lock, the banner says how to avoid it
    });
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !state.running) return;
  keepAwake();
  if (!demoMode && els.video.paused && state.stream) els.video.play().catch(() => {});
});

// The picture changes shape when the phone turns: the tapped corners no longer line up.
els.video.addEventListener('resize', () => {
  const size = state.calibratedSize;
  if (!size || ['intro', 'corners', 'camera-lost'].includes(state.stage)) return;
  const { w, h } = sourceSize();
  if (w === size.w && h === size.h) return;
  restartCorners(TURNED);
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

/** A board sample taken once the picture has been still for a moment (or after STILL_TIMEOUT_MS). */
async function stillSample() {
  const stillness = new Stillness();
  const started = performance.now();
  let previous = look();
  for (;;) {
    await sleep(FRAME_MS);
    const sample = look();
    if (!sample) continue; // the camera has no frame yet
    if (!previous) {
      previous = sample;
      continue;
    }
    if (stillness.update(changeScores(previous, sample)) || performance.now() - started > STILL_TIMEOUT_MS) return sample;
    previous = sample;
  }
}

function restartCorners(message = '') {
  state.corners = [];
  state.dragPoint = null;
  state.message = message;
  setStage('corners');
}

async function finishCorners() {
  try {
    const area = quadArea(state.corners) / (proc.width * proc.height);
    if (area < MIN_BOARD_AREA) return restartCorners(WRONG_CORNERS);
    try {
      state.view = new BoardView(state.corners);
    } catch {
      return restartCorners(WRONG_CORNERS); // three corners in a line
    }
    state.points = samplePoints(state.view);
    const { w, h } = sourceSize();
    state.calibratedSize = { w, h };
    setStage('checking');
    const sample = await stillSample();
    const fresh = !state.session || state.session.board.history().length === 0;
    if (fresh) {
      const problem = checkStartPosition(sample);
      if (problem) return restartCorners(problem);
    }
    if (!state.session) return setStage('colour');
    // Corners tapped again during a game: keep the game, compare with the new view from now on.
    state.session.setReference(sample);
    startDetecting();
  } catch (error) {
    console.error(error);
    restartCorners(READ_FAILED);
  }
}

async function chooseColour(colour) {
  keepAwake();
  try {
    setStage('checking');
    const reference = await stillSample();
    state.session = new Session(colour, reference);
    if (!state.engine) state.session.hasEngine = false;
    startDetecting();
  } catch (error) {
    console.error(error);
    state.session = null;
    restartCorners(READ_FAILED);
  }
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
  state.job = true;
  state.engine.bestMove(fen).then(
    (uci) => {
      state.job = false;
      if (uci && session.board.fen() === fen) {
        // the game may have moved on while Stockfish was thinking; then this answer is dropped
        const moves = legalMoves(session.board);
        session.setBest(moves.find((m) => m.uci === uci) ?? moves.find((m) => m.uci === uci.slice(0, 4) + 'q') ?? null);
      }
      render_();
    },
    () => {
      state.job = false;
      state.engine = null;
      session.hasEngine = false;
      state.engineNote = ' (Stockfish stopped — reload to get moves)';
      render_();
    },
  );
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
    case 'corners': {
      const prompt = CORNER_PROMPTS[state.corners.length] ?? 'Checking…';
      return state.message ? `${state.message} ${prompt}` : prompt;
    }
    case 'checking':
      return 'Hold still — checking the board…';
    case 'colour':
      return `Which side are you playing?${wakeLock ? '' : AUTO_LOCK_TIP}`;
    case 'play':
      return state.session.status() + state.engineNote;
    case 'camera-lost':
      return 'The camera stopped. Tap Restart camera, then tap the 4 corners again.';
    default:
      return '';
  }
}

function render_() {
  els.intro.hidden = state.stage !== 'intro';
  els.banner.hidden = state.stage === 'intro';
  els.cornerBar.hidden = state.stage !== 'corners';
  els.colourBar.hidden = state.stage !== 'colour';
  els.playBar.hidden = state.stage !== 'play';
  els.cameraBar.hidden = state.stage !== 'camera-lost';
  els.demoNext.hidden = !demoMode || state.stage !== 'play';
  els.demoNext.disabled = state.demoIndex >= DEMO_GAME.length;
  const text = bannerText();
  if (els.status.textContent !== text) els.status.textContent = text;
  if (state.session) {
    els.undo.disabled = state.session.history.length === 0;
    els.fix.disabled = !state.session.canFix();
  }
  drawOverlay();
}

function drawPath(ctx, points, close) {
  ctx.beginPath();
  points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  if (close) ctx.closePath();
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
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--move').trim();
  ctx.strokeStyle = accent;
  ctx.fillStyle = accent;

  if (state.stage === 'corners') {
    const points = state.corners.map(toScreen);
    ctx.lineWidth = 2;
    drawPath(ctx, state.dragPoint ? [...points, toScreen(state.dragPoint)] : points, false);
    ctx.stroke();
    for (const [x, y] of points) {
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fill();
    }
    if (state.dragPoint) {
      // a ring with a cross, so the exact spot shows around the finger
      const [x, y] = toScreen(state.dragPoint);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, 18, 0, Math.PI * 2);
      ctx.moveTo(x - 28, y);
      ctx.lineTo(x + 28, y);
      ctx.moveTo(x, y - 28);
      ctx.lineTo(x, y + 28);
      ctx.stroke();
    }
    return;
  }
  if (state.stage !== 'play' || !state.view) return;

  // the board outline, so it's clear the corners still line up
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 1;
  drawPath(ctx, state.view.corners.map(toScreen), true);
  ctx.stroke();

  const best = state.session.best;
  if (!best) return;
  const polygons = [best.from, best.to].map((square) => state.view.squarePolygon(square).map(toScreen));
  ctx.strokeStyle = accent;
  for (const polygon of polygons) {
    drawPath(ctx, polygon, true);
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
  drawPath(ctx, [[x1, y1], [x2, y2]], false);
  ctx.stroke();
  drawPath(ctx, [[x2, y2], [x2 - head * Math.cos(angle - 0.5), y2 - head * Math.sin(angle - 0.5)], [x2 - head * Math.cos(angle + 0.5), y2 - head * Math.sin(angle + 0.5)]], true);
  ctx.fill();
}

// ---- controls ----

function startEngine() {
  const problem = engineProblem();
  if (problem) {
    state.engineNote = ` (${problem})`;
    return;
  }
  try {
    state.engine = new Engine();
  } catch {
    state.engineNote = ' (Stockfish didn’t load — reload to try again)';
    return;
  }
  state.engine.ready.catch(() => {
    state.engine = null;
    if (state.session) state.session.hasEngine = false;
    state.engineNote = ' (Stockfish didn’t load — reload to try again)';
    render_();
  });
}

els.start.addEventListener('click', async () => {
  keepAwake(); // ask while the tap still counts as a user action
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
  startEngine();
  state.running = true;
  restartCorners();
  if (demoMode) {
    // the demo board's corners are known, so skip the taps
    state.corners = DEFAULT_CORNERS.map(([x, y]) => [(x * PROC_WIDTH) / CANVAS_W, (y * PROC_WIDTH) / CANVAS_W]);
    grabFrame();
    finishCorners();
  }
  loop();
});

// Corners: put a finger down, slide it onto the corner, lift it to place the corner.
function cornerPoint(event) {
  if (!event.isPrimary || state.stage !== 'corners' || state.corners.length >= 4 || !grabFrame()) return null;
  const point = toProc(event.clientX, event.clientY);
  const inside = point[0] >= 0 && point[0] <= proc.width && point[1] >= 0 && point[1] <= proc.height;
  return inside ? point : null;
}

els.overlay.addEventListener('pointerdown', (event) => {
  const point = cornerPoint(event);
  if (!point) return;
  els.overlay.setPointerCapture(event.pointerId);
  state.dragPoint = point;
  render_();
});
els.overlay.addEventListener('pointermove', (event) => {
  if (!state.dragPoint) return;
  const point = cornerPoint(event);
  if (point) state.dragPoint = point;
  render_();
});
els.overlay.addEventListener('pointerup', (event) => {
  if (!state.dragPoint || !event.isPrimary) return;
  state.corners.push(state.dragPoint);
  state.dragPoint = null;
  state.message = '';
  render_();
  if (state.corners.length === 4) finishCorners();
});
els.overlay.addEventListener('pointercancel', () => {
  state.dragPoint = null;
  render_();
});

els.clearCorners.addEventListener('click', () => restartCorners());
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
els.redo.addEventListener('click', () => restartCorners());
els.restartCamera.addEventListener('click', async () => {
  try {
    await startCamera();
    restartCorners();
  } catch (error) {
    els.status.textContent = error.message;
  }
});
els.demoNext.addEventListener('click', () => {
  const san = DEMO_GAME[state.demoIndex];
  if (!san) return;
  state.demoBoard.move(san);
  state.demoIndex++;
  drawDemoBoard();
  render_();
});

if (demoMode) els.start.textContent = 'Start demo board';
window.addEventListener('resize', () => render_());
window.chessHelperLoaded = true;
render_();
