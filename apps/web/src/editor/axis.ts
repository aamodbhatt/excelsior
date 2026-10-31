/**
 * Offsets along one grid axis with a default size and sparse overrides. offsetOf is O(log k) in the
 * number of overrides and indexAt is a binary search over it, so a million rows cost nothing to lay out.
 */
export class Axis {
  private readonly keys: number[];
  private readonly prefix: number[];

  constructor(
    readonly count: number,
    readonly defaultSize: number,
    private readonly overrides: Map<number, number>,
  ) {
    this.keys = [...overrides.keys()].sort((a, b) => a - b);
    this.prefix = [0];
    for (const k of this.keys)
      this.prefix.push(this.prefix[this.prefix.length - 1] + (overrides.get(k)! - defaultSize));
  }

  size(i: number): number {
    return this.overrides.get(i) ?? this.defaultSize;
  }

  /** Pixel offset of the start of index i. */
  offsetOf(i: number): number {
    let lo = 0;
    let hi = this.keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.keys[mid] < i) lo = mid + 1;
      else hi = mid;
    }
    return i * this.defaultSize + this.prefix[lo];
  }

  get total(): number {
    return this.offsetOf(this.count);
  }

  /** The index whose span contains pixel offset `px`. */
  indexAt(px: number): number {
    let lo = 0;
    let hi = this.count - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.offsetOf(mid) <= px) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
}
