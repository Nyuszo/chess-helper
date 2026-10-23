// Stockfish running in a Web Worker (the Stockfish 18 lite single-threaded browser build).
// One search at a time: the caller waits for `bestMove` to settle before asking again.

const READY_TIMEOUT_MS = 90000; // the 7 MB engine can take a while to download on mobile data
const SEARCH_SLACK_MS = 5000; // a search taking this much longer than asked means the engine hung

// A tiny module using WebAssembly SIMD, which this Stockfish build needs (Safari has it from iOS 16.4).
const SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);

/** Null if this browser can run the engine, otherwise why not, for the user. */
export function engineProblem() {
  try {
    if (typeof Worker === 'undefined' || typeof WebAssembly === 'undefined') return 'this browser can’t run Stockfish';
    if (!WebAssembly.validate(SIMD_PROBE)) return 'Stockfish needs iOS 16.4 or newer';
  } catch {
    return 'this browser can’t run Stockfish';
  }
  return null;
}

export class Engine {
  constructor(url = 'vendor/stockfish-18-lite-single.js') {
    this.worker = new Worker(url);
    this.waiter = null; // { until(line) -> bool, resolve, reject }
    this.failed = null;
    this.worker.onmessage = (event) => {
      const line = String(event.data);
      if (this.waiter && this.waiter.until(line)) {
        const { resolve } = this.waiter;
        this.waiter = null;
        resolve(line);
      }
    };
    this.worker.onerror = (event) => this.fail(new Error(event.message || 'Stockfish stopped'));
    this.ready = this.send('uci', (line) => line === 'uciok')
      .then(() => this.send('isready', (line) => line === 'readyok'))
      .then(() => true);
    this.timer = setTimeout(() => this.fail(new Error('Stockfish did not load')), READY_TIMEOUT_MS);
    this.ready.then(() => clearTimeout(this.timer), () => {});
  }

  send(command, until) {
    if (this.failed) return Promise.reject(this.failed);
    return new Promise((resolve, reject) => {
      this.waiter = { until, resolve, reject };
      this.worker.postMessage(command);
    });
  }

  fail(error) {
    if (this.failed) return;
    this.failed = error;
    clearTimeout(this.timer);
    if (this.waiter) this.waiter.reject(error);
    this.waiter = null;
    this.worker.terminate();
  }

  /** The best move for `fen` as a UCI string (e.g. "e2e4"), or null when there is none. */
  async bestMove(fen, ms = 800) {
    await this.ready;
    this.worker.postMessage(`position fen ${fen}`);
    const hung = setTimeout(() => this.fail(new Error('Stockfish stopped responding')), ms + SEARCH_SLACK_MS);
    try {
      const line = await this.send(`go movetime ${ms}`, (l) => l.startsWith('bestmove'));
      const uci = line.split(/\s+/)[1];
      return uci && uci !== '(none)' ? uci : null;
    } finally {
      clearTimeout(hung);
    }
  }
}
