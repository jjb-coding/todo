// ============================================================================
//  Pure colour / shape helpers shared by main.ts (column backgrounds) and the
//  view modules (node rings, tallies). No DOM, no state.
// ============================================================================

export const HL = { yellow: [245, 179, 1], green: [47, 158, 68], red: [224, 49, 49] };
export const DOTTED_COL = [120, 128, 138];                 // neutral grey for the "frontier" outline
export const NEUTRAL_COL = [[238, 242, 247], [231, 236, 243]];   // even, odd column bg
const DROP = "0 1px 2px #1b273312, 0 6px 14px -10px #1b273340"; // default node shadow

export function tintCol(region: "anc" | "self" | "desc", parity: number): number[] {
  if (region === "anc")  return parity ? [214, 236, 223] : [224, 242, 231];
  if (region === "self") return parity ? [241, 234, 201] : [247, 241, 214];
  return parity ? [242, 222, 222] : [248, 231, 231];
}

export const lerpCol = (a: number[], b: number[], t: number): number[] =>
  a.map((v, i) => Math.round(v + (b[i] - v) * t));
export const rgbStr  = (c: number[]): string => `rgb(${c[0]},${c[1]},${c[2]})`;
export const rgbaStr = (c: number[], a: number): string => `rgba(${c[0]},${c[1]},${c[2]},${a.toFixed(3)})`;
export const darker  = (c: number[]): number[] => c.map(v => Math.round(v * 0.82));

export const ringShadow = (color: string, w: number, glow: number): string =>
  `0 0 0 ${w.toFixed(1)}px ${color}` +
  (glow > 0 ? `, 0 0 ${(10 * glow).toFixed(1)}px ${rgbaStr(HL.yellow, 0.3 * glow)}` : "") +
  `, ${DROP}`;

// A unary tally (marks grouped in fives, the fifth a diagonal) rendered as tiny SVG.
export function tallySvg(n: number, color: string): string {
  const H = 13, m = 4, gg = 5;
  const marks: string[] = [];
  let x = 1, c = n;
  while (c > 0) {
    const k = Math.min(5, c), gs = x, bars = Math.min(k, 4);
    for (let i = 0; i < bars; i++) {
      marks.push(`<line x1="${x}" y1="1" x2="${x}" y2="${H - 1}"/>`);
      if (i < bars - 1) x += m;
    }
    if (k === 5) marks.push(`<line x1="${gs - 2}" y1="${H - 1}" x2="${x + 2}" y2="1"/>`);
    x += m + gg; c -= k;
  }
  const w = Math.max(3, x - gg);
  return `<svg width="${w}" height="${H}" viewBox="0 0 ${w} ${H}" fill="none" stroke="${color}" ` +
         `stroke-width="1.6" stroke-linecap="round">${marks.join("")}</svg>`;
}
