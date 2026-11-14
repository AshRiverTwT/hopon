import { test } from "node:test";
import assert from "node:assert/strict";
const { encodePoll, decodePoll } = await import("../src/polls.ts");

test("polls round-trip as ordinary message text", () => {
  const poll = { question: "Which game?", options: ["Chess", "Wordle"] };
  assert.deepEqual(decodePoll(encodePoll(poll)), poll);
});

test("invalid poll payloads render as ordinary text", () => {
  assert.equal(decodePoll("hello"), null);
  assert.equal(decodePoll("\u001fhopon-poll:{bad json"), null);
  assert.equal(decodePoll(encodePoll({ question: "One choice", options: ["Only"] })), null);
});
