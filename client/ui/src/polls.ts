export interface Poll { question: string; options: string[] }
const PREFIX = "\u001fhopon-poll:";
export function encodePoll(poll: Poll) { return PREFIX + JSON.stringify(poll); }
export function decodePoll(content: string): Poll | null {
  if (!content.startsWith(PREFIX)) return null;
  try {
    const value = JSON.parse(content.slice(PREFIX.length)) as Partial<Poll>;
    if (typeof value.question !== "string" || !Array.isArray(value.options) || value.options.length < 2 || value.options.length > 5 || value.options.some((option) => typeof option !== "string")) return null;
    return { question: value.question, options: value.options };
  } catch { return null; }
}
export const POLL_EMOJI = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣"];
