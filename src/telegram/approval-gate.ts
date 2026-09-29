/**
 * ApprovalGate — testable buy-approval primitive.
 *
 * Pure coordination logic with NO axios / Telegram imports so it can be
 * unit tested. The Telegram layer (src/telegram/bot.ts) owns one module
 * instance, creates an entry FIRST, then sends the Approve/Reject message
 * with `appr:yes:<id>` / `appr:no:<id>` buttons, and resolves via `resolve()`
 * when a callback query arrives.
 *
 * Fail closed: only an explicit approve yields 'approved'. Timeout, reject,
 * and cancelAll all yield 'expired' / 'rejected' (never 'approved').
 */

export type ApprovalDecision = 'approved' | 'rejected' | 'expired';
export type ApprovalResolveStatus = 'ok' | 'unknown';

export interface ApprovalGateTimers {
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

interface PendingEntry {
  resolve: (d: ApprovalDecision) => void;
  timer: unknown;
}

export class ApprovalGate {
  private seq = 0;
  private entries = new Map<string, PendingEntry>();
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (h: unknown) => void;

  constructor(opts?: ApprovalGateTimers) {
    this.setTimer = opts?.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts?.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /**
   * Open a new approval entry. Ids are short decimal strings, unique and
   * monotonically increasing — `appr:yes:<id>` stays far under the 64-byte
   * Telegram callback_data limit.
   */
  open(timeoutMs: number): { id: string; decision: Promise<ApprovalDecision> } {
    const id = String(++this.seq);
    let entry: PendingEntry;
    const decision = new Promise<ApprovalDecision>(resolve => {
      const timer = this.setTimer(() => {
        if (!this.entries.has(id)) return;
        this.entries.delete(id);
        resolve('expired');
      }, timeoutMs);
      entry = { resolve, timer };
    });
    // `entry` is assigned synchronously by the Promise executor above.
    this.entries.set(id, entry!);
    return { id, decision };
  }

  /**
   * Resolve a pending entry. Returns 'unknown' for a missing,
   * already-resolved, or expired id (double click / late click).
   */
  resolve(id: string, approved: boolean): ApprovalResolveStatus {
    const entry = this.entries.get(id);
    if (!entry) return 'unknown';
    this.entries.delete(id);
    try {
      this.clearTimer(entry.timer);
    } catch {
      // best-effort — a throwing clearTimer must not break resolution
    }
    entry.resolve(approved ? 'approved' : 'rejected');
    return 'ok';
  }

  /** Number of currently pending approvals (for tests / diagnostics). */
  pending(): number {
    return this.entries.size;
  }

  /** Resolve every pending decision as 'expired' (used on shutdown). */
  cancelAll(): void {
    if (this.entries.size === 0) return;
    const outstanding = [...this.entries.entries()];
    this.entries.clear();
    for (const [, entry] of outstanding) {
      try {
        this.clearTimer(entry.timer);
      } catch {
        // best-effort
      }
      entry.resolve('expired');
    }
  }
}
