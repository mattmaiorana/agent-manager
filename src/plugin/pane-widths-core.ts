
export function keepWidths(widths: number[], fixed: boolean[], dLeft: number, dRight: number, min: number): number[] | null {
  const n = widths.length;
  if (n < 2 || (!dLeft && !dRight)) return null;
  const out = widths.slice();
  const order = (fromLeft: boolean) => {
    const idx = [...Array(n).keys()].filter((i) => !fixed[i]);
    return fromLeft ? idx : idx.reverse();
  };
  const give = (fromLeft: boolean, delta: number): boolean => {
    const takers = order(fromLeft);
    if (!takers.length) return false;
    if (delta >= 0) { out[takers[0]] += delta; return true; }
    let owed = -delta;
    for (const floor of [min, 0]) {
      for (const i of takers) {
        const take = Math.min(owed, Math.max(0, out[i] - floor));
        out[i] -= take;
        owed -= take;
        if (owed <= 0) return true;
      }
    }
    return false;
  };
  if (dLeft && !give(true, dLeft)) return null;
  if (dRight && !give(false, dRight)) return null;
  return out;
}

export function sharesOf(widths: number[]): number[] {
  const total = widths.reduce((a, b) => a + b, 0);
  return total > 0 ? widths.map((w) => (w / total) * 100) : widths.map(() => 100 / widths.length);
}

export function widthsFromShares(grows: number[], hidden: boolean[], total: number): number[] {
  const all = grows.reduce((a, b) => a + b, 0);
  const shown = grows.reduce((a, g, i) => a + (hidden[i] ? 0 : g), 0);
  return grows.map((g, i) => (hidden[i] ? (all > 0 ? (g / all) * total : 0) : shown > 0 ? (g / shown) * total : 0));
}

export function sharesFor(widths: number[], hidden: boolean[], total: number): number[] {
  const shown = widths.reduce((a, w, i) => a + (hidden[i] ? 0 : w), 0);
  if (!hidden.some(Boolean) || shown <= 0) return sharesOf(widths);
  return sharesOf(widths.map((w, i) => (hidden[i] ? (total > w ? (w * shown) / (total - w) : w) : w)));
}

export interface SplitEdges { width: number; left: number; outerWidth: number; screenLeft: number; screenRight: number }
export function edgeChanges(before: SplitEdges, after: SplitEdges): { dLeft: number; dRight: number } {
  const atLeft = before.left - after.left;
  const rest = after.width - before.width - atLeft;
  const dOuter = after.outerWidth - before.outerWidth;
  let windowLeft = 0;
  if (dOuter) {
    const grewLeft = before.screenLeft - after.screenLeft, grewRight = after.screenRight - before.screenRight;
    if (!grewRight) windowLeft = dOuter;
    else if (grewLeft && Math.sign(grewLeft) === Math.sign(grewRight)) windowLeft = grewLeft;
  }
  return { dLeft: atLeft + windowLeft, dRight: rest - windowLeft };
}

export function fitFixed(widths: number[], fixedAt: number, total: number, keep: number): number[] {
  const out = widths.slice();
  out[fixedAt] = Math.max(0, Math.min(keep, total));
  const rest = Math.max(0, total - out[fixedAt]);
  const others = out.map((_, i) => i).filter((i) => i !== fixedAt);
  const sum = others.reduce((a, i) => a + Math.max(0, out[i]), 0);
  others.forEach((i, k) => { out[i] = sum > 0 ? (Math.max(0, out[i]) / sum) * rest : k === 0 ? rest : 0; });
  return out;
}
