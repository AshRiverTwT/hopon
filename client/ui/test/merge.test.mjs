// Runs the TS helpers directly (Node 22 strips types with --experimental-strip-types).
import { test } from "node:test";
import assert from "node:assert/strict";
const { mergeMsgs, findId, showsHeader } = await import("../src/merge.ts");

const m = (id, extra = {}) => ({ id, channelId: "1", authorId: "a", content: id, editedAt: null, ts: 0, nonce: "", state: 2, ...extra });

test("append, insert, dedupe", () => {
  let { list } = mergeMsgs([], [m("10"), m("12")]);
  ({ list } = mergeMsgs(list, [m("11"), m("12", { content: "x" }), m("9")]));
  assert.deepEqual(list.map((x) => x.id), ["9", "10", "11", "12"]);
  assert.equal(list[3].content, "x");
  assert.equal(findId(list, "11"), 2);
  assert.equal(findId(list, "13"), -1);
});

test("numeric ordering of decimal ids of different length", () => {
  const { list } = mergeMsgs([], [m("100"), m("99"), m("1000")]);
  assert.deepEqual(list.map((x) => x.id), ["99", "100", "1000"]);
});

test("pending replaced by server copy with the same nonce", () => {
  let { list } = mergeMsgs([m("5")], [m("p77", { nonce: "77", state: 0 })]);
  assert.deepEqual(list.map((x) => x.id), ["5", "p77"]);
  ({ list } = mergeMsgs(list, [m("6"), m("8", { nonce: "77", state: 1 })]));
  assert.deepEqual(list.map((x) => x.id), ["5", "6", "8"]);
});

test("state never goes backwards", () => {
  let { list } = mergeMsgs([], [m("8", { state: 2 })]);
  ({ list } = mergeMsgs(list, [m("8", { state: 1 })]));
  assert.equal(list[0].state, 2);
});

test("headers group by author and time", () => {
  const l = [m("1", { ts: 0 }), m("2", { ts: 1000 }), m("3", { ts: 10 * 60_000 }), m("4", { authorId: "b", ts: 10 * 60_000 })];
  assert.deepEqual(l.map((_, i) => showsHeader(l, i)), [true, false, true, true]);
});

test("merging into 5000 messages is fast", () => {
  const base = Array.from({ length: 5000 }, (_, i) => m(String(1_000_000 + i)));
  const t = performance.now();
  for (let i = 0; i < 100; i++) mergeMsgs(base, [m(String(2_000_000 + i))]);
  const per = (performance.now() - t) / 100;
  assert.ok(per < 2, `${per.toFixed(3)} ms per merge`);
  console.log(`merge into 5000: ${per.toFixed(3)} ms`);
});

test("game results are recognised and parsed", async () => {
  const { parseGameResult } = await import("../src/games.ts");
  const w = parseGameResult("Wordle 1,234 3/6\n\n⬛🟨⬛⬛⬛\n🟩🟩⬛🟩⬛\n🟩🟩🟩🟩🟩");
  assert.equal(w.game, "wordle");
  assert.equal(w.grid.length, 3);
  assert.deepEqual(w.grid[2], ["🟩", "🟩", "🟩", "🟩", "🟩"]);
  assert.equal(parseGameResult("Wordle is fun"), null);
  assert.equal(parseGameResult("Wordle 1,234 7/6"), null);
  assert.equal(parseGameResult("hello there"), null);
  assert.equal(parseGameResult("Minute Cryptic #88 solved, 1 hint\nminutecryptic.com").game, "cryptic");
  assert.equal(parseGameResult("Krillion 12 — 3 tries").game, "krillion");
});
