import { fork, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { CollectionJson, HostMessage, RunnerMessage, RunOptions } from './protocol';

export interface RunHandle {
  readonly runId: string;
  /** Fires for every runner message belonging to this run. */
  on(event: 'message', listener: (msg: RunnerMessage) => void): this;
  on(event: 'done', listener: (error?: string) => void): this;
  abort(): void;
  /** Resolves when the run finishes (or is aborted). */
  completion: Promise<void>;
}

/**
 * Owns the forked runner process and multiplexes runs over it.
 *
 * Deliberately free of any `vscode` import so it can be exercised headlessly by
 * the unit tests, which is where the compatibility suite lives.
 */
export class RunnerClient {
  private child: ChildProcess | undefined;
  private readonly runs = new Map<string, EventEmitter>();
  private seq = 0;
  private disposed = false;

  constructor(
    private readonly runnerPath: string,
    private readonly onLog: (line: string) => void = () => {}
  ) {}

  private ensureChild(): ChildProcess {
    if (this.child && !this.child.killed && this.child.connected) { return this.child; }

    const child = fork(this.runnerPath, [], {
      // In the extension host `process.execPath` is the Electron binary, so it
      // needs ELECTRON_RUN_AS_NODE to behave as plain Node. This avoids
      // requiring the user to have Node installed.
      execPath: process.execPath,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      execArgv: ['--max-old-space-size=1024'],
      silent: true
    });

    child.stdout?.on('data', (d) => this.onLog(`[runner] ${String(d).trimEnd()}`));
    child.stderr?.on('data', (d) => this.onLog(`[runner:err] ${String(d).trimEnd()}`));

    child.on('message', (msg: RunnerMessage) => this.dispatch(msg));

    child.on('exit', (code, signal) => {
      this.onLog(`[runner] exited code=${code} signal=${signal}`);
      // Fail every in-flight run rather than leaving the UI spinning forever.
      for (const [runId, emitter] of this.runs) {
        emitter.emit('done', `Runner process exited unexpectedly (code=${code}, signal=${signal}).`);
        this.runs.delete(runId);
      }
      this.child = undefined;
    });

    this.child = child;
    return child;
  }

  private dispatch(msg: RunnerMessage): void {
    if (msg.type === 'ready') { return this.onLog(`[runner] ready pid=${msg.pid}`); }
    if (msg.type === 'fatal') {
      this.onLog(`[runner] fatal: ${msg.message}`);
      for (const [runId, emitter] of this.runs) {
        emitter.emit('done', msg.message);
        this.runs.delete(runId);
      }
      return;
    }

    const emitter = this.runs.get(msg.runId);
    if (!emitter) { return; }
    emitter.emit('message', msg);
    if (msg.type === 'runDone') {
      emitter.emit('done', msg.error);
      this.runs.delete(msg.runId);
    }
  }

  run(collection: CollectionJson, options: RunOptions): RunHandle {
    if (this.disposed) { throw new Error('RunnerClient has been disposed.'); }

    const runId = `run-${++this.seq}-${Date.now()}`;
    const emitter = new EventEmitter();
    this.runs.set(runId, emitter);

    const completion = new Promise<void>((resolve) => emitter.once('done', () => resolve()));

    const child = this.ensureChild();
    const msg: HostMessage = { type: 'run', runId, collection, options };
    child.send(msg);

    const handle: RunHandle = {
      runId,
      on: (event: any, listener: any) => { emitter.on(event, listener); return handle; },
      abort: () => {
        this.child?.send({ type: 'abort', runId } satisfies HostMessage);
        // postman-runtime's abort is cooperative; a script stuck in a tight loop
        // will not honour it, so give it a moment then take the process out.
        setTimeout(() => {
          if (this.runs.has(runId)) {
            this.onLog(`[runner] abort timed out for ${runId}; killing process`);
            this.kill();
          }
        }, 2000).unref?.();
      },
      completion
    };
    return handle;
  }

  private kill(): void {
    if (!this.child) { return; }
    const child = this.child;
    child.kill('SIGTERM');
    setTimeout(() => { if (!child.killed) { child.kill('SIGKILL'); } }, 1000).unref?.();
  }

  dispose(): void {
    this.disposed = true;
    if (!this.child) { return; }
    try { this.child.send({ type: 'shutdown' } satisfies HostMessage); } catch { /* already gone */ }
    this.kill();
    this.child = undefined;
  }
}
