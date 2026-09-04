/**
 * Process-level serialization gate for agent runs.
 *
 * Usage limits are account-global: two concurrent agent subprocesses (an
 * implement run and a scheduled estimation sweep, say) burn the same quota
 * and risk tripping it twice. The coordinator hands out one slot at a time
 * in FIFO order, so whoever asked first runs next.
 *
 * Only wired when scheduled estimation joins the worker process; without
 * `[[estimations]]` every acquirer keeps today's behavior.
 */
export class RunCoordinator {
  private tail: Promise<void> = Promise.resolve();
  private transition = 0;

  constructor(private enabled = true) {}

  /** Enable serialization for newly started runs. */
  enable(): void {
    this.transition += 1;
    this.enabled = true;
  }

  /** Disable after already-held and queued slots drain. */
  disableWhenIdle(): void {
    const transition = ++this.transition;
    void this.tail.then(() => {
      if (this.transition === transition) this.enabled = false;
    });
  }

  /** Wait for a free slot; returns the release function for that slot. */
  async acquire(): Promise<() => void> {
    if (!this.enabled) return () => undefined;
    let release!: () => void;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.tail;
    this.tail = previous.then(() => turn);
    await previous;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
    };
  }

  /** Run `operation` while holding exactly one slot. */
  async run<T>(operation: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
