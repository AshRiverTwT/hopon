import { test } from "node:test";
import assert from "node:assert/strict";
const { parse, encodeMentions, decodeMentions, preview, mentionsUser } = await import("../src/rich.ts");

const flat = (nodes) => nodes.map((n) => (n.t === "text" ? n.v : n.t === "link" ? `[${n.v}]` : n.t === "mention" ? `@${n.id}` : n.t === "code" ? `\`${n.v}\`` : n.t === "pre" ? `<pre>${n.v}</pre>` : `<${n.t}>${flat(n.c)}</${n.t}>`)).join("");

test("html is never markup", () => {
  const n = parse(`<img src=x onerror=alert(1)><script>alert(2)</script>`);
  assert.equal(n.length, 1);
  assert.equal(n[0].t, "text");
  assert.equal(n[0].v, `<img src=x onerror=alert(1)><script>alert(2)</script>`);
});

test("bold, italic, strike, nesting", () => {
  assert.equal(flat(parse("a **b** c")), "a <b>b</b> c");
  assert.equal(flat(parse("**bold _it_**")), "<b>bold <i>it</i></b>");
  assert.equal(flat(parse("~~gone~~ *yes*")), "<s>gone</s> <i>yes</i>");
});

test("unbalanced or spaced markers stay literal", () => {
  assert.equal(flat(parse("**oops")), "**oops");
  assert.equal(flat(parse("2 * 3 * 4")), "2 * 3 * 4");
  assert.equal(flat(parse("snake_case_name")), "snake_case_name");
  assert.equal(flat(parse("``")), "``");
});

test("code wins over formatting", () => {
  assert.equal(flat(parse("`**x**` and **y**")), "`**x**` and <b>y</b>");
  assert.equal(flat(parse("before\n```rust\nlet x = *p;\n```\nafter")), "before\n<pre>let x = *p;</pre>after");
  assert.equal(flat(parse("```unclosed")), "```unclosed");
});

test("links: http(s) only, trailing punctuation trimmed", () => {
  assert.equal(flat(parse("see https://example.com/a?b=1.")), "see [https://example.com/a?b=1].");
  assert.equal(flat(parse("(https://en.wikipedia.org/wiki/Foo_(bar))")), "([https://en.wikipedia.org/wiki/Foo_(bar)])");
  assert.equal(flat(parse("javascript:alert(1) ftp://x")), "javascript:alert(1) ftp://x");
  assert.equal(flat(parse("nothttps://x.com")), "nothttps://x.com");
});

test("mentions", () => {
  const members = [{ id: "1", name: "ash" }, { id: "2", name: "ashley" }, { id: "3", name: "jun" }];
  const wire = encodeMentions("hey @ashley and @ash, @jun! email a@b.com @nobody", members);
  assert.equal(wire, "hey <@2> and <@1>, <@3>! email a@b.com @nobody");
  assert.equal(flat(parse(wire)), "hey @2 and @1, @3! email a@b.com @nobody");
  assert.ok(mentionsUser(wire, "3") && !mentionsUser(wire, "4"));
  const names = { 1: "ash", 2: "ashley", 3: "jun" };
  assert.equal(decodeMentions(wire, (id) => names[id]), "hey @ashley and @ash, @jun! email a@b.com @nobody");
});

test("reply preview is one short line", () => {
  const p = preview("line one\n```\ncode\n```\n<@3> " + "x".repeat(200), () => "jun", 40);
  assert.ok(p.length <= 40 && !p.includes("\n") && p.startsWith("line one [code] @jun"));
});

test("reply preview strips formatting markers", () => {
  assert.equal(preview("try **voice** with `echo off`, it's _so_ ~~bad~~ good", () => ""), "try voice with echo off, it's so bad good");
  assert.equal(preview("snake_case_name stays", () => ""), "snake_case_name stays");
});

test("emoji search", async () => {
  const { searchEmoji, CATEGORIES } = await import("../src/emoji.ts");
  assert.equal(searchEmoji("fire")[0].e, "🔥");
  assert.ok(searchEmoji("thumbs up").some((x) => x.e === "👍"));
  assert.ok(searchEmoji("lol").some((x) => x.e === "😂"));
  assert.equal(searchEmoji("zzqx").length, 0);
  const all = CATEGORIES.flatMap((c) => c.list.map((x) => x.e));
  assert.equal(new Set(all).size, all.length - (all.length - new Set(all).size), "parsed");
  assert.ok(all.length > 300, `only ${all.length}`);
});
