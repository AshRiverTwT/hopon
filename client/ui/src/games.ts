// Game result detection for chat rendering (mirrors client/src-tauri/src/games.rs).

export const GAMES = [
  { id: "wordle", name: "Wordle" },
  { id: "cryptic", name: "Minute Cryptic" },
  { id: "krillion", name: "Krillion" },
] as const;
export type GameId = (typeof GAMES)[number]["id"];

export interface GameResult {
  game: GameId;
  title: string;
  /** Rows of cells for emoji-square grids; empty when the result has none. */
  grid: string[][];
  /** Remaining non-grid lines (links, extra text). */
  extra: string[];
}

const SQUARES = new Set(["🟩", "🟨", "⬛", "⬜", "🟦", "🟧", "🟥", "🟪", "🟫"]);
const WORDLE = /^Wordle\s+[\d,.]+\s+[1-6X]\/6\*?$/;

function cells(line: string): string[] | null {
  const chars = [...line.replace(/️/g, "").trim()];
  if (chars.length === 0 || chars.length > 12) return null;
  return chars.every((c) => SQUARES.has(c)) ? chars : null;
}

export function parseGameResult(content: string): GameResult | null {
  const lines = content.split("\n").map((l) => l.trim());
  const first = lines[0] ?? "";
  const lower = content.toLowerCase();
  let game: GameId | null = null;
  if (WORDLE.test(first)) game = "wordle";
  else if (lower.includes("minute cryptic") || lower.includes("minutecryptic")) game = "cryptic";
  else if (lower.includes("krillion")) game = "krillion";
  if (!game) return null;
  const grid: string[][] = [];
  const extra: string[] = [];
  for (const l of lines.slice(1)) {
    if (!l) continue;
    const row = cells(l);
    if (row) grid.push(row); else extra.push(l);
  }
  return { game, title: first, grid, extra };
}

export const cellClass = (c: string) =>
  ({ "🟩": "g", "🟨": "y", "⬛": "k", "⬜": "k", "🟦": "b", "🟧": "o", "🟥": "r", "🟪": "p", "🟫": "n" })[c] ?? "k";
