/**
 * Runs one conversation's messages one batch at a time, folding a burst into a
 * single batch.
 *
 * Every Slack message used to start its own run. People type in bursts — "Any
 * emails from Analia?", "Or Wozniak?", "Chris Wozniak business", "He's helping
 * us sell the business" inside twenty seconds — and got four separate answers,
 * paid for four times; two quick edits to an email request saved two competing
 * Gmail drafts. Here a message waits a moment for others to follow it, and one
 * arriving while its conversation is being answered waits for that answer, so
 * the next run sees it.
 *
 * In-memory and per process, which matches how the API runs (one instance).
 */
export class ConversationQueue<T> {
  private readonly pending = new Map<string, { items: T[]; firstAt: number }>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly running = new Set<string>();

  /**
   * @param settleMs quiet time after a conversation's latest message before it runs
   * @param maxWaitMs ceiling on how long a steady stream of messages holds back the first
   * @param handle answers one batch; its failures are its own to report
   */
  constructor(
    private readonly settleMs: number,
    private readonly maxWaitMs: number,
    private readonly handle: (key: string, batch: T[]) => Promise<void>,
  ) {}

  push(key: string, item: T, now: number = Date.now()): void {
    const entry = this.pending.get(key) ?? { items: [], firstAt: now };
    entry.items.push(item);
    this.pending.set(key, entry);
    // A run in progress picks the batch up when it finishes.
    if (!this.running.has(key)) this.arm(key, now);
  }

  private arm(key: string, now: number = Date.now()): void {
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);
    const entry = this.pending.get(key);
    if (!entry) return;
    const waited = now - entry.firstAt;
    const delay = Math.max(0, Math.min(this.settleMs, this.maxWaitMs - waited));
    this.timers.set(
      key,
      setTimeout(() => void this.flush(key), delay),
    );
  }

  private async flush(key: string): Promise<void> {
    this.timers.delete(key);
    const entry = this.pending.get(key);
    if (!entry?.items.length || this.running.has(key)) return;
    this.pending.delete(key);
    this.running.add(key);
    try {
      await this.handle(key, entry.items);
    } catch {
      // The handler reports its own failures; the queue only has to keep going.
    } finally {
      this.running.delete(key);
      // What arrived during the run goes next, after the same short settle.
      if (this.pending.get(key)?.items.length) this.arm(key);
    }
  }
}
