// Stockfish running in a Web Worker (the Stockfish 18 lite single-threaded browser build).
// One search at a time: the caller waits for `bestMove` to settle before asking again.

const READY_TIMEOUT_MS = 30000; // the 7 MB engine can take a while to download on mobile data

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
    const line = await this.send(`go movetime ${ms}`, (l) => l.startsWith('bestmove'));
    const uci = line.split(/\s+/)[1];
    return uci && uci !== '(none)' ? uci : null;
  }
}
