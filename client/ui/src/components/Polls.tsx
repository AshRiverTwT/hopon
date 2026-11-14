// Polls: the "New poll" sheet (same full-window sheet as New channel) and the
// poll as it appears in chat. Votes are reactions 1️⃣–5️⃣, so they sync,
// survive reconnects and need nothing new on the server.
import { createSignal, For, Index, Show } from "solid-js";
import { Overlay } from "./Overlay";
import { encodePoll, POLL_EMOJI, type Poll } from "../polls";
import { s, sendMessage, toggleReaction, userName } from "../store";
import type { Msg } from "../types";
import { PollIcon } from "./icons";

const MAX_OPTIONS = 5;

export function PollSheet(p: { close: () => void; channel: string }) {
  const [question, setQuestion] = createSignal("");
  const [options, setOptions] = createSignal(["", ""]);
  const filled = () => options().map((o) => o.trim()).filter(Boolean);
  const ready = () => question().trim().length > 0 && filled().length >= 2;
  const setOption = (i: number, v: string) => setOptions((l) => l.map((o, j) => (j === i ? v : o)));
  const add = () => options().length < MAX_OPTIONS && setOptions((l) => [...l, ""]);
  const remove = (i: number) => setOptions((l) => l.filter((_, j) => j !== i));
  const post = () => {
    if (!ready()) return;
    sendMessage(encodePoll({ question: question().trim(), options: filled() }));
    p.close();
  };
  let list!: HTMLOListElement;
  const focusOption = (i: number) => queueMicrotask(() => (list.querySelectorAll("input")[i] as HTMLInputElement | undefined)?.focus());
  return (
    <Overlay title="New poll" close={p.close}>
      <p class="lede poll-where">Posting in <strong>#{p.channel}</strong>. People vote with one click; votes update live.</p>
      <input class="line big" placeholder="Ask a question" maxLength={200} value={question()} autofocus
        onInput={(e) => setQuestion(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && focusOption(0)} />
      <ol class="poll-edit" ref={list}>
        <Index each={options()}>
          {(o, i) => (
            <li>
              <span class="poll-edit-n">{i + 1}</span>
              <input class="line" placeholder={`Option ${i + 1}`} maxLength={80} value={o()}
                onInput={(e) => setOption(i, e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  if (i === options().length - 1 && options().length < MAX_OPTIONS && o().trim()) { add(); focusOption(i + 1); }
                  else if (ready()) post();
                  else focusOption(i + 1);
                }} />
              <Show when={options().length > 2}>
                <button class="icon-btn" title="Remove option" aria-label={`Remove option ${i + 1}`} onClick={() => remove(i)}>×</button>
              </Show>
            </li>
          )}
        </Index>
      </ol>
      <Show when={options().length < MAX_OPTIONS}>
        <button class="link poll-add" onClick={() => { add(); focusOption(options().length - 1); }}>+ Add an option</button>
      </Show>
      <div class="field-row end">
        <button class="pill solid big" disabled={!ready()} onClick={post}>Post poll</button>
      </div>
    </Overlay>
  );
}

/** A poll in the message list: options as bars filled by their share of votes. */
export function PollCard(p: { poll: Poll; m: Msg }) {
  const votes = (i: number) => p.m.reactions.find((r) => r.emoji === POLL_EMOJI[i])?.users ?? [];
  const total = () => p.poll.options.reduce((t, _, i) => t + votes(i).length, 0);
  const voters = () => new Set(p.poll.options.flatMap((_, i) => votes(i))).size;
  const mine = (i: number) => !!s.user && votes(i).includes(s.user.id);
  const pct = (i: number) => (total() ? Math.round((votes(i).length / total()) * 100) : 0);
  const lead = (i: number) => total() > 0 && votes(i).length === Math.max(...p.poll.options.map((_, j) => votes(j).length));
  return (
    <div class="poll">
      <div class="poll-head"><PollIcon /> Poll</div>
      <div class="poll-q">{p.poll.question}</div>
      <div class="poll-opts">
        <For each={p.poll.options}>
          {(option, i) => (
            <button class="poll-opt" classList={{ mine: mine(i()), lead: lead(i()) }} aria-pressed={mine(i())}
              title={votes(i()).length ? votes(i()).map(userName).join(", ") : "No votes yet"}
              onClick={() => toggleReaction(p.m, POLL_EMOJI[i()])}>
              <span class="poll-bar" style={{ width: `${pct(i())}%` }} />
              <span class="poll-label"><span class="poll-check" aria-hidden="true" />{option}</span>
              <span class="poll-n">{pct(i())}%<span class="poll-count">{votes(i()).length}</span></span>
            </button>
          )}
        </For>
      </div>
      <div class="poll-foot">{voters() === 1 ? "1 person voted" : `${voters()} people voted`} · click to vote, again to take it back</div>
    </div>
  );
}
