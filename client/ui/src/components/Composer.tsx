import { createSignal } from "solid-js";
import { s, sendMessage, set } from "../store";

export default function Composer() {
  const [text, setText] = createSignal("");
  let ta!: HTMLTextAreaElement;
  const name = () => s.servers.flatMap((x) => x.channels).find((c) => c.id === s.selChannel)?.name ?? "";

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      const v = text();
      if (v.trim()) {
        sendMessage(v);
        setText("");
        ta.value = "";
      }
    } else if (e.key === "ArrowUp" && !text()) {
      const mine = [...s.msgs].reverse().find((m) => m.authorId === s.user?.id && !m.id.startsWith("p"));
      if (mine) { e.preventDefault(); set("editing", mine.id); }
    }
  };
  return (
    <div class="composer">
      <textarea
        ref={ta}
        rows={1}
        maxLength={4000}
        placeholder={`Write in ${name()}`}
        onInput={(e) => { setText(e.currentTarget.value); e.currentTarget.style.height = "auto"; e.currentTarget.style.height = Math.min(200, e.currentTarget.scrollHeight) + "px"; }}
        onKeyDown={onKey}
        autofocus
      />
    </div>
  );
}
