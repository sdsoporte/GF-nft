/**
 * Server-owned simulation clocks.
 *
 * The authoritative tick loop always belongs to the server. Tests inject a
 * manual clock so they can advance ticks synchronously; no HTTP route can
 * advance or mutate the match.
 */

export interface TickClock {
  /** Configured tick interval in milliseconds. */
  readonly intervalMs: number;
  /** Begin delivering ticks to `onTick`. */
  start(onTick: () => void): void;
  /** Stop delivering ticks. Safe to call more than once. */
  stop(): void;
}

/** Wall-clock driven clock used by the real entrypoint. */
export class IntervalTickClock implements TickClock {
  public readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(intervalMs: number) {
    this.intervalMs = intervalMs;
  }

  public start(onTick: () => void): void {
    if (this.timer !== null) return;
    this.timer = setInterval(onTick, this.intervalMs);
  }

  public stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}

/**
 * Test clock: ticks only when the test calls `advance`.
 * It implements the same interface so the server cannot tell the difference.
 */
export class ManualTickClock implements TickClock {
  public readonly intervalMs: number;
  private handler: (() => void) | null = null;
  private deliveredTicks = 0;

  constructor(intervalMs: number) {
    this.intervalMs = intervalMs;
  }

  public start(onTick: () => void): void {
    this.handler = onTick;
  }

  public stop(): void {
    this.handler = null;
  }

  public get isRunning(): boolean {
    return this.handler !== null;
  }

  public get deliveredTickCount(): number {
    return this.deliveredTicks;
  }

  public advance(ticks = 1): void {
    if (this.handler === null) {
      throw new Error('ManualTickClock.advance requires a started clock');
    }
    for (let index = 0; index < ticks; index += 1) {
      this.deliveredTicks += 1;
      this.handler();
    }
  }
}
