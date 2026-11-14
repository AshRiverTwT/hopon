import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { createServer } from "vite";

// Uses the real UI with the existing preview IPC fixture. No production accounts.
let server, browser, base;
before(async () => {
  server = await createServer({
    server: { host: "127.0.0.1", port: 5175, strictPort: false },
    optimizeDeps: { include: ["@tauri-apps/api/mocks", "livekit-client"] },
  });
  await server.listen();
  base = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({
    headless: true,
    ...(process.env.HOPON_TEST_BROWSER ? { channel: process.env.HOPON_TEST_BROWSER }
      : process.platform === "win32" ? { channel: "msedge" } : {}),
  });
});
after(async () => { await browser?.close(); await server?.close(); });

async function fixture(t, scene = "chat") {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("https://media.example/**", (route) => route.abort());
  await page.goto(`${base}/preview.html?s=${scene}`);
  await page.getByRole("button", { name: "Settings", exact: true }).waitFor({ timeout: 30000 });
  await page.evaluate(() => {
    const original = window.__TAURI_INTERNALS__.invoke;
    window.testCalls = [];
    window.__TAURI_INTERNALS__.invoke = async (cmd, args, options) => {
      window.testCalls.push({ cmd, args });
      if (cmd === "member_search") return [];
      if (window.testInvoke) {
        const result = window.testInvoke(cmd, args);
        if (result !== undefined) return result;
      }
      return original(cmd, args, options);
    };
  });
  t.after(async () => { await context.close(); assert.deepEqual(errors, [], "no uncaught UI exceptions"); });
  return page;
}
const composer = (p) => p.locator(".composer textarea");
const channel = (p, name) => p.getByRole("option", { name, exact: true }).click();
async function value(p, expected) {
  await p.waitForFunction((text) => document.querySelector(".composer textarea")?.value === text, expected);
}

test("text, emoji and mention drafts survive channel switches and voice view", async (t) => {
  const p = await fixture(t);
  await composer(p).fill("draft ");
  await p.getByRole("button", { name: "Insert emoji" }).click();
  await p.getByPlaceholder("Search emoji").fill("smile");
  await p.locator(".emoji-picker .pick").first().click();
  const emojiDraft = await composer(p).inputValue();
  assert.notEqual(emojiDraft, "draft ");
  await channel(p, "design-crit");
  await value(p, "");
  await channel(p, "general");
  await value(p, emojiDraft);
  await composer(p).fill("@mi");
  await p.getByRole("option", { name: "mira", exact: true }).click();
  await value(p, "@mira ");
  await channel(p, "design-crit");
  await channel(p, "general");
  await value(p, "@mira ");
  await p.getByRole("option", { name: /^Lounge/ }).click();
  await p.getByRole("button", { name: "Join", exact: true }).waitFor();
  await channel(p, "general");
  await value(p, "@mira ");
});

test("uploads stay with their draft and finish after the composer remounts", async (t) => {
  const p = await fixture(t);
  await p.evaluate(() => {
    window.uploads = [];
    window.testInvoke = (cmd) => cmd === "upload_file" ? new Promise((resolve) => window.uploads.push(resolve)) : undefined;
  });
  await p.locator('.composer input[type="file"]').setInputFiles({ name: "first.txt", mimeType: "text/plain", buffer: Buffer.from("first") });
  await p.waitForFunction(() => window.uploads.length === 1);
  await p.getByRole("option", { name: /^Lounge/ }).click();
  await channel(p, "design-crit");
  await p.locator('.composer input[type="file"]').setInputFiles({ name: "second.txt", mimeType: "text/plain", buffer: Buffer.from("second") });
  await p.waitForFunction(() => window.uploads.length === 2);
  await p.evaluate(() => window.uploads[0]({ id: "first", name: "first.txt", size: 5, mime: "text/plain" }));
  assert.match(await p.locator(".pending-files").innerText(), /second.txt[\s\S]*Uploading/);
  await channel(p, "general");
  await p.waitForFunction(() => !document.querySelector(".pending-files")?.textContent.includes("Uploading"));
  assert.match(await p.locator(".pending-files").innerText(), /first.txt/);
  await channel(p, "design-crit");
  await p.getByRole("option", { name: /^Lounge/ }).click();
  await channel(p, "design-crit");
  await p.evaluate(() => window.uploads[1]({ id: "second", name: "second.txt", size: 6, mime: "text/plain" }));
  await p.waitForFunction(() => !document.querySelector(".pending-files")?.textContent.includes("Uploading"));
  await composer(p).press("Enter");
  const sent = await p.evaluate(() => window.testCalls.findLast((x) => x.cmd === "send_message").args);
  assert.deepEqual(sent.files, ["second"]);
  assert.equal(sent.channelId, "7002");
});

test("failed uploads block sending until removed", async (t) => {
  const p = await fixture(t);
  await p.evaluate(() => { window.testInvoke = (cmd) => cmd === "upload_file" ? Promise.reject(new Error("test upload failure")) : undefined; });
  await p.locator('.composer input[type="file"]').setInputFiles({ name: "failed.txt", mimeType: "text/plain", buffer: Buffer.from("test") });
  await p.locator(".pending-files .failed").waitFor();
  await composer(p).fill("keep this");
  await composer(p).press("Enter");
  assert.equal(await p.evaluate(() => window.testCalls.filter((x) => x.cmd === "send_message").length), 0);
  await p.getByRole("button", { name: "Remove failed.txt" }).click();
  await composer(p).press("Enter");
  await p.waitForFunction(() => window.testCalls.some((x) => x.cmd === "send_message"));
});

test("poll creation, live vote counts, removal and unrelated reactions", async (t) => {
  const p = await fixture(t);
  // The New poll sheet (no browser dialogs).
  await p.getByRole("button", { name: "New poll" }).click();
  await p.getByPlaceholder("Ask a question").fill("Which game?");
  await p.getByPlaceholder("Option 1").fill("Chess");
  await p.getByPlaceholder("Option 2").fill("Wordle");
  await p.getByRole("button", { name: "Post poll" }).click();
  await p.locator(".poll").waitFor();
  await p.evaluate(async () => {
    const { s, set } = await import("/src/store.ts");
    const pending = s.msgs.at(-1);
    set("msgs", [{ ...pending, id: "999999999", state: 2, reactions: [] }]);
    window.testInvoke = (cmd, args) => {
      if (cmd === "react") { window.__push({ t: "reaction", ...args, userId: "1001" }); return null; }
    };
  });
  const chess = p.locator(".poll-opt").filter({ hasText: "Chess" });
  await chess.click();
  await p.waitForFunction(() => document.querySelector(".poll-opt")?.classList.contains("mine"));
  assert.equal(await chess.locator(".poll-count").innerText(), "1");
  await p.evaluate(() => window.__push({ t: "reaction", channelId: "7001", messageId: "999999999", emoji: "🔥", userId: "1002", add: true }));
  await p.waitForFunction(() => document.querySelector(".reactions")?.textContent.includes("🔥"));
  assert.equal(await p.locator(".poll-foot").innerText(), "1 vote");
  // Poll votes aren't repeated as reaction chips; other reactions are.
  assert.equal(await p.locator(".reactions .chip").count(), 1);
  await chess.click();
  await p.waitForFunction(() => document.querySelector(".poll-foot")?.textContent === "0 votes");
  assert.equal(await chess.locator(".poll-count").innerText(), "0");
});

test("favorites persist and saved messages open the message", async (t) => {
  const p = await fixture(t);
  await p.locator('button[title*="Favorite"],button[title*="favorite"]').click();
  assert.deepEqual(await p.evaluate(() => JSON.parse(localStorage.getItem("hopon.favorites"))), ["7001"]);
  await p.evaluate(async () => { (await import("/src/localFeatures.ts")).toggleBookmark("7001", "10002006"); });
  await p.getByRole("button", { name: "Saved messages", exact: true }).click();
  await p.locator(".sheet .index-row").first().click();
  await composer(p).waitFor();
  assert.equal(await p.locator(".sheet").count(), 0);
  await p.reload();
  await composer(p).waitFor();
  assert.deepEqual(await p.evaluate(() => JSON.parse(localStorage.getItem("hopon.favorites"))), ["7001"]);
});

test("channel search finds loaded text", async (t) => {
  const p = await fixture(t);
  await p.getByRole("button", { name: "Search this channel", exact: true }).click();
  await p.getByPlaceholder("Search loaded messages").fill("sunset");
  await p.locator(".sheet .index-row").filter({ hasText: "sunset" }).waitFor();
  await p.locator(".sheet .index-row").filter({ hasText: "sunset" }).click();
  await composer(p).waitFor();
  assert.equal(await p.getByPlaceholder("Search loaded messages").count(), 0);
});

test("channel load failure recovers through Retry", async (t) => {
  const p = await fixture(t);
  await p.evaluate(() => {
    let fail = true;
    window.testInvoke = (cmd) => cmd === "open_channel" && fail ? (fail = false, Promise.reject(new Error("offline"))) : undefined;
  });
  await channel(p, "design-crit");
  await p.getByRole("button", { name: "Retry", exact: true }).click();
  await p.waitForFunction(() => !document.querySelector(".channel-error"));
});

test("a stale channel response cannot populate a different empty server", async (t) => {
  const p = await fixture(t);
  await p.evaluate(async () => {
    const { s, set, selectChannel, selectServer } = await import("/src/store.ts");
    window.testInvoke = (cmd) => cmd === "open_channel" ? new Promise((resolve) => { window.resolveChannel = resolve; }) : undefined;
    void selectChannel("7002");
    set("servers", [...s.servers, { id: "empty", name: "Empty", ownerId: "1001", channels: [], memberIds: [], memberCount: 0, reads: {}, online: [], activities: {} }]);
    selectServer("empty");
    window.resolveChannel([{ id: "123", channelId: "7002", authorId: "1001", content: "stale", nonce: "", state: 2, ts: Date.now(), reactions: [], attachments: [] }]);
  });
  assert.deepEqual(await p.evaluate(async () => { const { s } = await import("/src/store.ts"); return { channel: s.selChannel, count: s.msgs.length }; }), { channel: null, count: 0 });
});

test("display name editor validates and submits, mouse push-to-talk binds", async (t) => {
  const p = await fixture(t);
  await p.getByRole("button", { name: "Settings", exact: true }).click();
  await p.locator(".cascade-opts li").filter({ hasText: "Display name" }).locator("button.v").click();
  await p.getByLabel("Display name", { exact: true }).fill("x".repeat(33));
  await p.getByRole("button", { name: "Save name" }).click();
  assert.match(await p.getByRole("alert").innerText(), /32/);
  await p.getByLabel("Display name", { exact: true }).fill("Test Player");
  await p.getByRole("button", { name: "Save name" }).click();
  await p.waitForFunction(() => window.testCalls.some((x) => x.cmd === "set_display_name"));
  assert.equal(await p.evaluate(() => window.testCalls.find((x) => x.cmd === "set_display_name").args.name), "Test Player");
  await p.locator(".cascade-cats button").filter({ hasText: "Controls" }).click();
  await p.locator(".cascade-opts li").filter({ hasText: "Talk key" }).locator("button.v").click();
  await p.evaluate(() => window.dispatchEvent(new MouseEvent("mousedown", { button: 3, bubbles: true })));
  await p.getByRole("button", { name: "Mouse 4", exact: true }).waitFor();
  assert.equal(await p.evaluate(() => window.testCalls.findLast((x) => x.cmd === "voice_ptt")?.args.keyCode), 0x1004);
});

test("voice room: Camera and Stream (quality menu) only; Leave clears media presence", async (t) => {
  const p = await fixture(t, "voice");
  await p.getByRole("option", { name: /^Lounge/ }).click();
  await p.getByRole("button", { name: "Camera", exact: true }).waitFor();
  assert.equal(await p.getByRole("button", { name: "Camera", exact: true }).isEnabled(), true);
  await p.getByRole("button", { name: "Stream", exact: true }).click();
  const qualities = await p.getByRole("menuitem").allInnerTexts();
  assert.deepEqual(qualities.map((q) => q.split("\n")[0]), ["720p · 30 fps", "720p · 60 fps", "1080p · 60 fps", "1440p · 60 fps"]);
  await p.keyboard.press("Escape");
  assert.equal(await p.getByRole("menu").count(), 0);
  for (const gone of ["Show cameras", "Include audio", "Low resource", "Mic on", "Leave call"]) {
    assert.equal(await p.locator(".stage").getByText(gone, { exact: true }).count(), 0, `${gone} is gone from the room`);
  }
  await p.getByRole("button", { name: "Leave", exact: true }).click();
  assert.equal(await p.evaluate(() => window.testCalls.some((x) => x.cmd === "voice_leave")), true);
  await p.evaluate(() => window.__push({ t: "channelDeleted", serverId: "9001", channelId: "7101" }));
  await p.waitForFunction(async () => { const { s } = await import("/src/store.ts"); return !s.media.screen["1002"]; });
});

test("hotkeys, games resize behavior and narrow layout", async (t) => {
  const p = await fixture(t);
  await p.keyboard.press("Alt+ArrowDown");
  await value(p, "");
  assert.equal(await composer(p).getAttribute("placeholder"), "Write in design-crit");
  await p.keyboard.press("Control+g");
  await p.waitForFunction(() => window.testCalls.some((x) => x.cmd === "games_open"));
  await p.setViewportSize({ width: 720, height: 480 });
  await p.waitForFunction(() => window.testCalls.some((x) => x.cmd === "games_close"));
  assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
});

// Run with HOPON_TEST_LIVEKIT=1 and scripts/windows-kit/livekit-local.yaml.
// LiveKit should advertise a reachable interface IP as its WebRTC node IP.
test("camera and screen video publish, render, and stop through local LiveKit", {
  skip: !process.env.HOPON_TEST_LIVEKIT,
  timeout: 60000,
}, async (t) => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const room = `hopon-media-test-${randomUUID()}`;
  const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  function token(identity) {
    const claims = {
      iss: "devkey", sub: `${identity}:screen`, exp: Math.floor(Date.now() / 1000) + 120,
      video: {
        room, roomJoin: true, canPublish: true, canSubscribe: true, canUpdateOwnMetadata: true,
        canPublishSources: ["camera", "screen_share", "screen_share_audio"],
      },
    };
    const body = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}`;
    const signature = createHmac("sha256", "secret-secret-secret-secret-secret").update(body).digest("base64url");
    return `${body}.${signature}`;
  }
  async function participant(userId) {
    const p = await context.newPage();
    const query = new URLSearchParams({ url: "ws://127.0.0.1:7880", token: token(userId) });
    await p.goto(`${base}/screen-test.html?${query}`);
    await p.waitForFunction(() => window.__ready);
    await p.evaluate(({ room, userId }) => window.__screen.setScreenContext(room, userId), { room, userId });
    return p;
  }
  const publisher = await participant("1001");
  const viewer = await participant("1002");
  await publisher.evaluate(() => {
    const makeVideo = () => {
      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = 180;
      const drawing = canvas.getContext("2d");
      let frame = 0;
      const paint = () => {
        drawing.fillStyle = frame++ % 2 ? "orange" : "navy";
        drawing.fillRect(0, 0, canvas.width, canvas.height);
      };
      paint();
      const stream = canvas.captureStream(30);
      const timer = setInterval(paint, 33);
      return { stream, timer };
    };
    const fakeCamera = makeVideo();
    const fakeScreen = makeVideo();
    window.syntheticMedia = [fakeCamera, fakeScreen];
    navigator.mediaDevices.getUserMedia = async () => fakeCamera.stream;
    navigator.mediaDevices.getDisplayMedia = async () => fakeScreen.stream;
  });
  await publisher.evaluate(() => window.__screen.setCameraEnabled(true));
  assert.equal(await publisher.evaluate(() => window.__screen.screen.cameraOn), true);
  await viewer.evaluate(() => window.__screen.setViewingCameras(true));
  await viewer.waitForFunction(() => window.__screen.cameraTrack("1001"));
  await viewer.evaluate(() => window.__screen.cameraTrack("1001").attach(document.querySelector("#v")));
  await viewer.waitForFunction(() => document.querySelector("#v").videoWidth > 0);
  await viewer.evaluate(() => {
    window.__screen.cameraTrack("1001").detach(document.querySelector("#v"));
    return window.__screen.setViewingCameras(false);
  });
  assert.equal(await viewer.evaluate(() => !!window.__screen.cameraTrack("1001")), false);

  await publisher.evaluate(() => window.__screen.startShare("720p30", false));
  assert.equal(await publisher.evaluate(() => window.__screen.screen.sharing), true);
  await viewer.evaluate(async () => {
    const slot = document.createElement("div");
    slot.id = "stream-slot";
    slot.style.width = "640px";
    document.body.appendChild(slot);
    window.__screen.bindVideo("1001", slot);
    await window.__screen.watch("1001");
  });
  await viewer.waitForFunction(() => document.querySelector("#stream-slot video")?.videoWidth > 0);
  await publisher.waitForFunction(() => window.__screen.viewerCount("1001") === 1);
  await publisher.evaluate(async () => {
    await window.__screen.stopShare();
    await window.__screen.setCameraEnabled(false);
    for (const media of window.syntheticMedia) clearInterval(media.timer);
  });
  await viewer.waitForFunction(() => !window.__screen.screen.watching.length);
  assert.deepEqual(await publisher.evaluate(() => ({
    connected: window.__screen.screen.connected,
    camera: window.__screen.screen.cameraOn,
    tracks: window.syntheticMedia.map(({ stream }) => stream.getVideoTracks()[0].readyState),
  })), { connected: false, camera: false, tracks: ["ended", "ended"] });
});

test("call view: opens fullscreen from the voice room, switches everyone/focus, Esc leaves", async (t) => {
  const p = await fixture(t, "voice");
  await p.getByRole("option", { name: /^Lounge/ }).click();
  await p.getByRole("button", { name: "Open call view" }).click();
  await p.locator(".call").waitFor();
  assert.equal(await p.locator(".call-grid .call-tile").count(), 3, "everyone as a tile");
  assert.equal(await p.locator(".call-watch").count(), 1, "Watch stream on the person sharing");
  await p.getByRole("radio", { name: "Focus" }).click();
  await p.locator(".call-main .call-tile").waitFor();
  assert.equal(await p.locator(".call-strip .call-tile").count(), 2, "the others in the strip");
  await p.getByRole("radio", { name: "Everyone" }).click();
  await p.locator(".call-grid").waitFor();
  await p.keyboard.press("Escape");
  await p.waitForFunction(() => !document.querySelector(".call"));
  assert.equal(await p.evaluate(() => window.testCalls.filter((x) => x.cmd === "set_fullscreen").map((x) => x.args.on).join()), "true,false");
});
