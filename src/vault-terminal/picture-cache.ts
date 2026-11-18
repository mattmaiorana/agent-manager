
export interface Closable {
  close(): void;
}

export const KEPT_CAP = 128 * 1024 * 1024;

export class KeptPictures<T extends Closable> {
  private kept = new Map<number, { key: string; item: T; bytes: number }>();
  private byKey = new Map<string, number[]>();
  private next = 0;
  bytes = 0;

  constructor(readonly cap = KEPT_CAP) {}

  get size(): number {
    return this.kept.size;
  }

  put(key: string, item: T, bytes: number): void {
    if (bytes > this.cap) {
      item.close();
      return;
    }
    for (const v of this.kept.values()) if (v.item === item) return;
    const n = this.next++;
    this.kept.set(n, { key, item, bytes });
    const list = this.byKey.get(key);
    if (list) list.push(n);
    else this.byKey.set(key, [n]);
    this.bytes += bytes;
    for (const [k, v] of this.kept) {
      if (this.bytes <= this.cap) break;
      this.remove(k, v.key, v.bytes);
      v.item.close();
    }
  }

  has(key: string): boolean {
    return this.byKey.has(key);
  }

  take(key: string): T | null {
    const list = this.byKey.get(key);
    const n = list?.[list.length - 1];
    const had = n === undefined ? undefined : this.kept.get(n);
    if (n === undefined || !had) return null;
    this.remove(n, key, had.bytes);
    return had.item;
  }

  clear(): void {
    for (const v of this.kept.values()) v.item.close();
    this.kept.clear();
    this.byKey.clear();
    this.bytes = 0;
  }

  private remove(n: number, key: string, bytes: number): void {
    this.kept.delete(n);
    this.bytes -= bytes;
    const list = this.byKey.get(key);
    if (!list) return;
    const i = list.indexOf(n);
    if (i >= 0) list.splice(i, 1);
    if (!list.length) this.byKey.delete(key);
  }
}
