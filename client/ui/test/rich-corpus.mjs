// Writes client/native/fixtures/rich.json: inputs and what rich.ts returns
// for them. The native client's C# port must produce identical output
// (client/native/HopOn.Interop.Tests). Regenerate after changing rich.ts:
//   node --experimental-strip-types test/rich-corpus.mjs
import { writeFileSync } from "node:fs";
const { parse, encodeMentions, decodeMentions } = await import("../src/rich.ts");

// Fixed inputs: the unit tests' cases and known edge cases.
const fixed = [
  "<img src=x onerror=alert(1)><script>alert(2)</script>",
  "a **b** c", "**bold _it_**", "~~gone~~ *yes*", "**oops", "2 * 3 * 4", "snake_case_name", "``",
  "`**x**` and **y**", "before\n```rust\nlet x = *p;\n```\nafter", "```unclosed",
  "see https://example.com/a?b=1.", "(https://en.wikipedia.org/wiki/Foo_(bar))", "javascript:alert(1) ftp://x",
  "nothttps://x.com", "hey <@2> and <@1>, <@3>! email a@b.com @nobody", "https://", "http://a", "https://a.b",
  "**a **b** c**", "*a *b* c*", "_a_b_", "x_a_ y", "**", "****", "* *", "_ _", "~~~~", "```\n```", "```js\ncode```tail",
  "```this is not a tag\ncode```", "<@>", "<@123456789012345678901>", "<@12", "[https://x.y/z]", "https://x.y/z),",
  "https://x.y/(a)).", "é**ü**é", "😄 **😄** 😄", "** x**", "line\n**bold\nline**", "\t*tab*", "a　_b_",
  "١٢٣ <@١٢٣>", "word_ _x_", "_x_word", "*****", "**a*b**c*", "~~a**b~~c**", "`a``b`", "``a``", "x```y```z```w",
];

// Random combinations of the syntax's tokens (fixed seed: reproducible).
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const tokens = ["*", "**", "_", "~~", "`", "```", "https://a.b/c", "http://x.y/(z)", "(", ")", ".", ",", "<@12>", "<@", ">",
  "x", "yz", " ", " ", "\n", "rust\n", "é", "😄", "a_b", " ", "[", "]", "!", "?", "'", "\"", "h", "ttps://"];
const random = [];
for (let n = 0; n < 3000; n++) {
  const len = 1 + Math.floor(rnd() * 12);
  let s = "";
  for (let k = 0; k < len; k++) s += tokens[Math.floor(rnd() * tokens.length)];
  random.push(s);
}

// Structured: markers wrapped around words, nested, with neighbours.
const marks = ["*", "**", "_", "~~", "`"];
const words = ["a", "bold", "x y", " sp", "sp ", "snake_case", "😄", "é", "https://h.io/p", "<@7>", "1"];
const pick = (a) => a[Math.floor(rnd() * a.length)];
const wrap = (d) => {
  if (d > 2 || rnd() < 0.35) return pick(words);
  const m = pick(marks);
  const inner = wrap(d + 1) + (rnd() < 0.4 ? pick([" ", "", "_", "x"]) + wrap(d + 1) : "");
  return m + inner + (rnd() < 0.85 ? m : "");
};
for (let n = 0; n < 1500; n++) random.push((rnd() < 0.3 ? pick(words) : "") + wrap(0) + (rnd() < 0.5 ? pick([" ", ".", "x", "_y", " end"]) + wrap(0) : ""));

const members = [{ id: "1", name: "ash" }, { id: "2", name: "ashley" }, { id: "3", name: "jun" }, { id: "4", name: "Mr. T" }];
const names = { 1: "ash", 2: "ashley", 3: "jun", 4: "Mr. T" };
const mentionInputs = [
  "hey @ashley and @ash, @jun! email a@b.com @nobody", "@ash", "@ASH hi", "(@jun)", "@ashley's turn", "@Mr. T rocks",
  "@jun@ash", "@ash@jun", "x@ash", "@", "@ @ash", "@ashx", "@ash.", "@jun?", "@ashley\n@jun", "<@1> already",
];

const out = {
  parse: [...fixed, ...random].map((input) => ({ input, nodes: parse(input) })),
  encodeMentions: { members, cases: mentionInputs.map((input) => ({ input, output: encodeMentions(input, members) })) },
  decodeMentions: { names, cases: mentionInputs.map((input) => encodeMentions(input, members)).map((input) => ({ input, output: decodeMentions(input, (id) => names[id] ?? "unknown") })) },
};
writeFileSync(new URL("../../native/fixtures/rich.json", import.meta.url), JSON.stringify(out) + "\n");
console.log(`rich.json: ${out.parse.length} parse cases, ${mentionInputs.length} mention cases`);
