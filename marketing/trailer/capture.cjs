// Records the trailer's scenes as timestamped frames (CDP screencast).
//   node capture.cjs <outDir> [scene ...]      (vite dev server on :5173)
// Each scene runs on a fresh page at 1920x1080 (1280x720 CSS at 1.5x).
// Animations play at RATE while recording; assemble.py speeds them back up,
// so motion is captured at ~2.5x the screencast's frame rate.
const { chromium } = require(process.env.PLAYWRIGHT ?? "playwright");
const fs = require("fs");
const path = require("path");

const BASE = process.env.BASE ?? "http://localhost:5173";
const out = process.argv[2];
const only = process.argv.slice(3);
const numbers = process.env.NUMBERS ? JSON.parse(fs.readFileSync(process.env.NUMBERS, "utf8")) : null;

async function page(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1.5 });
  const p = await ctx.newPage();
  await p.route("https://media.example/**", (r) => r.abort());
  return p;
}

/** Record `run` on page p. rate: animation playback rate while recording. */
async function record(p, name, rate, run) {
  const dir = path.join(out, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const cdp = await p.context().newCDPSession(p);
  await cdp.send("Animation.enable");
  await cdp.send("Animation.setPlaybackRate", { playbackRate: rate });
  const times = [];
  let n = 0;
  cdp.on("Page.screencastFrame", (f) => {
    fs.writeFileSync(path.join(dir, `${String(n++).padStart(5, "0")}.jpg`), Buffer.from(f.data, "base64"));
    times.push(f.metadata.timestamp);
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 93, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
  const start = Date.now() / 1000;
  // A no-op repaint so the first frame is the starting picture.
  await p.evaluate(() => { document.body.style.outline = "0 solid transparent"; });
  await run((ms) => p.waitForTimeout(ms));
  const end = Date.now() / 1000;
  await cdp.send("Page.stopScreencast");
  await p.waitForTimeout(200);
  fs.writeFileSync(path.join(dir, "times.json"), JSON.stringify({ start, end, rate, times }));
  console.log(`${name}: ${n} frames over ${(end - start).toFixed(1)} s (rate ${rate})`);
}

const push = (p, ev) => p.evaluate((e) => window.__push(e), ev);
const speaking = (p, ...names) => p.evaluate((ns) => window.__push({ t: "speaking", userIds: ns.map((n) => window.__ids[n]) }), names);

const scenes = {
  async intro(b) {
    const p = await page(b);
    await p.goto(`${BASE}/trailer-scenes.html?scene=intro`); await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(300);
    await p.evaluate(() => document.getAnimations().forEach((a) => a.pause()));
    await record(p, "intro", 0.5, async (w) => { await p.evaluate(() => document.getAnimations().forEach((a) => { a.currentTime = 0; a.play(); })); await w(6600); });
  },
  async launch(b) {
    const p = await page(b);
    await p.goto("data:text/html,<body style='margin:0;background:%230b0b0c'></body>");
    await record(p, "launch", 1, async (w) => { await w(250); await p.goto(`${BASE}/trailer.html`); await w(2600); });
  },
  async dial(b) {
    const p = await page(b);
    await p.goto(`${BASE}/trailer.html`); await p.waitForTimeout(2500);
    await p.mouse.move(255, 470); // on the dial, over the channels (outside the server arc)
    await record(p, "dial", 0.4, async (w) => {
      await w(900);
      for (let i = 0; i < 4; i++) { await p.mouse.wheel(0, 60); await w(1250); }
      await w(700);
      for (let i = 0; i < 4; i++) { await p.mouse.wheel(0, -60); await w(1100); }
      await w(900);
    });
  },
  async rail(b) {
    const p = await page(b);
    await p.goto(`${BASE}/trailer.html`); await p.waitForTimeout(2500);
    await p.mouse.move(70, 360); // inside the arc, over the server letters
    await record(p, "rail", 0.4, async (w) => {
      await w(800);
      await p.mouse.wheel(0, 60); await w(2100);
      await p.mouse.wheel(0, 60); await w(2100);
      await p.mouse.wheel(0, -60); await w(250); await p.mouse.wheel(0, -60); await w(3600);
    });
  },
  async voice(b) {
    const p = await page(b);
    await p.goto(`${BASE}/trailer.html`); await p.waitForTimeout(2500);
    await p.getByRole("option", { name: /^Lounge/ }).click(); await p.waitForTimeout(2200);
    await record(p, "voice", 0.4, async (w) => {
      await speaking(p, "mira"); await w(900);
      await p.getByRole("button", { name: "Join", exact: true }).click();
      await push(p, { t: "voice", channelId: "7101", state: "connected", muted: false, deafened: false, detail: null });
      await speaking(p, "mira", "ash"); await w(1100);
      await speaking(p, "tobias"); await w(900);
      await p.getByRole("button", { name: "Open call view" }).click(); await w(1500);
      await speaking(p, "mira", "tobias"); await w(1100);
      await speaking(p, "ash"); await w(1000);
      await p.locator(".call-tile", { hasText: "tobias" }).first().click(); await w(1500);
      await speaking(p, "tobias"); await w(1200);
      await speaking(p, "tobias", "mira"); await w(1300);
    });
  },
  async profile(b) {
    const p = await page(b);
    await p.goto(`${BASE}/trailer.html`); await p.waitForTimeout(2500);
    await record(p, "profile", 0.4, async (w) => {
      await w(500);
      await p.locator(".rail li", { hasText: "mira" }).first().click(); await w(2600);
      await p.keyboard.press("Escape"); await w(500);
      await p.locator(".rail li", { hasText: "kaito" }).first().click(); await w(2000);
      await p.keyboard.press("Escape"); await w(400);
      await p.locator("button.me").click(); await w(1200);
      await p.getByRole("radio", { name: "Do not disturb" }).click(); await w(2600);
    });
  },
  async compare(b) {
    const n = numbers ?? { hopon: { launch_s: 0, memory_mb: 0 }, discord: { launch_s: 0, memory_mb: 0 } };
    const q = new URLSearchParams({ scene: "compare", hl: n.hopon.launch_s, dl: n.discord.launch_s, hm: n.hopon.memory_mb, dm: n.discord.memory_mb });
    if (!numbers) q.set("draft", "1");
    const p = await page(b);
    await p.goto(`${BASE}/trailer-scenes.html?${q}`);
    await record(p, "compare", 0.5, async (w) => { await p.evaluate(() => location.reload()); await w(10600); });
  },
  async outro(b) {
    const p = await page(b);
    await p.goto(`${BASE}/trailer-scenes.html?scene=outro`);
    await p.evaluate(() => document.getAnimations().forEach((a) => a.pause()));
    await record(p, "outro", 0.5, async (w) => { await p.evaluate(() => document.getAnimations().forEach((a) => { a.currentTime = 0; a.play(); })); await w(7800); });
  },
};

(async () => {
  const browser = await chromium.launch({ args: ["--hide-scrollbars", "--force-color-profile=srgb"] });
  for (const [name, run] of Object.entries(scenes)) if (!only.length || only.includes(name)) await run(browser);
  await browser.close();
})();
