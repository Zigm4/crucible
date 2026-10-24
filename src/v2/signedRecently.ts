/**
 * What was just signed, until a read of the chain shows it.
 * ─────────────────────────────────────────────────────────────
 * After the wallet confirms, the staking page reads the chain again. That
 * read can reach a node that has not applied the transaction yet, since the
 * wallet broadcasts through its own, and it then answers with the state from
 * before: the page offered the same withdrawal again. Seen on 2026-10-24,
 * ineek.wam signed the same eight farms twice, thirty seconds apart, and
 * claimall twice. Both second signatures did nothing (the chain accepts an
 * unstake from an emptied farm), but they were asked for.
 *
 * So each signature leaves a mark per thing it changed (a farm's NFTs, a
 * farm's rewards, a pool, a refund), and the page offers nothing a mark
 * covers until a read no longer shows that thing, or `ttlMs` has passed:
 * past that, what a read shows is what is there.
 */
export interface Mark {
  trx: string;
  /** When it was signed, in ms. */
  at: number;
}

export class SignedRecently {
  private marks = new Map<string, Mark>();

  constructor(private ttlMs = 180_000, private now: () => number = Date.now) {}

  add(keys: string[], trx: string): void {
    const at = this.now();
    for (const k of keys) this.marks.set(k, { trx, at });
  }

  /** The mark on `key`, if one is still standing. */
  get(key: string): Mark | undefined {
    const m = this.marks.get(key);
    if (m && this.now() - m.at > this.ttlMs) {
      this.marks.delete(key);
      return undefined;
    }
    return m;
  }

  has(key: string): boolean {
    return Boolean(this.get(key));
  }

  /**
   * After a read: every mark whose thing the read no longer shows is done.
   * Only marks under `prefix`, so one account's read settles only its own.
   */
  settle(prefix: string, stillThere: (key: string) => boolean): void {
    for (const key of [...this.marks.keys()]) {
      if (key.startsWith(prefix) && (!this.get(key) || !stillThere(key))) this.marks.delete(key);
    }
  }
}
