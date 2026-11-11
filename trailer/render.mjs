// Renders trailer/index.html frame by frame and encodes trailer/hopon-trailer.mp4.
//   node trailer/render.mjs              full render (30 s @ 30 fps)
//   node trailer/render.mjs --stills 2,9,15,22.5   check frames only
// Needs Playwright (Chromium) and ffmpeg on PATH.
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const FPS = 30;
const args = process.argv.slice(2);
const stills = args.includes("--stills") ? args[args.indexOf("--stills") + 1].split(",").map(Number) : null;
const out = path.join(dir, "out");
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(path.join(dir, "index.html")).href + "?capture");
await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map((i) => i.decode())); });

if (stills) {
  for (const t of stills) {
    await page.evaluate((t) => window.render(t), t);
    await page.screenshot({ path: path.join(out, `still-${t}.png`) });
  }
  console.log("stills written to", out);
} else {
  const dur = await page.evaluate(() => window.DURATION);
  const video = path.join(dir, "hopon-trailer-silent.mp4");
  const ff = spawn("ffmpeg", ["-loglevel", "error", "-y", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "png", "-i", "-",
    "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p", "-movflags", "+faststart", video], { stdio: ["pipe", "inherit", "inherit"] });
  const n = Math.round(dur * FPS);
  for (let f = 0; f < n; f++) {
    await page.evaluate((t) => window.render(t), f / FPS);
    const buf = await page.screenshot({ type: "png" });
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
    if (f % 60 === 0) process.stdout.write(`frame ${f}/${n}\r`);
  }
  ff.stdin.end();
  await new Promise((r, j) => ff.on("close", (c) => (c ? j(new Error(`ffmpeg ${c}`)) : r())));
  console.log("\nwrote", video);
}
await browser.close();
