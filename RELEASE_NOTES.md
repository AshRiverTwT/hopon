# HopOn release notes

**Download the latest:** [HopOn-setup.exe](https://github.com/AshRiverTwT/hopon/raw/downloads/HopOn-setup.exe)

## HopOn 0.4.1

- Settings → Account shows the app version.
- Same protocol as 0.4.0: no server update needed.

## HopOn 0.4.0

**Update the app and the server together** (new protocol: a 0.3 app shows
*Update needed* on a 0.4 server).

### New

- **Screen share, 1080p 60 fps or 720p 60 fps.** In a voice room: pick a
  quality, press **Share screen**, choose a screen or window. Others see
  **LIVE** next to your name and press **Watch** (with fullscreen). Nothing
  is downloaded until someone presses Watch. *Include audio* shares your
  computer's sound too (off by default: viewers on speakers may hear voice
  chat echo). The picture starts a little soft and sharpens within
  seconds as the connection ramps up.
- **Close to tray.** The close button hides HopOn to the tray; voice, the
  overlay and hotkeys keep working. Click the tray icon to open it again,
  right-click → *Quit HopOn* to exit. Settings → Display switches it off.
- **"Playing ARC Raiders"** is now recognised (THE FINALS already was).
- **Discord-style emoji everywhere** (Twemoji): messages, reactions, the
  picker and the overlay look the same on every PC.

### Changed

- The message box sits at the very bottom of the window.
- The channel header no longer repeats the server name.

## HopOn 0.3.0

**Update the app and the server together** (new protocol again: a 0.2 app
shows *Update needed* on a 0.3 server).

### New

- **People column.** Everyone in the server on the right, online first, with
  **"Playing VALORANT"** (or whatever game they're in) under their name. It
  makes room for the games panel when you open it.
- **Per-person volume, 0–200 %.** In a voice room, each person has a slider
  (double-click resets to 100 %). Remembered per person on your account.
- **Show what I'm playing** can be switched off in Settings → Profile.

### Changed

- **Overlay no longer takes focus from the game**, so fullscreen games
  don't minimize when it appears. To type, press **Ctrl+`** (or click the
  box); Enter sends and Esc cancels, and both put you straight back in the
  game. **Alt+`** still shows/hides it.
- **Chat uses the full width** (small margin on the right). Opening Games
  slides the chat left; closing slides it back.
- **Avatars sit in their own column**: messages line up with the name and
  never run under the picture.
- **Emoji-only messages show at 200 %.**
- The message box sits a little lower.

### Known issues

- Overlay and fullscreen: it's shown over **borderless / windowed
  fullscreen** games. A game in true exclusive fullscreen may not show it,
  and typing (which needs focus) will minimize such a game. In VALORANT,
  use *Windowed Fullscreen* (Settings → Video → Display Mode).
- "Playing …" recognises a fixed list of popular games (VALORANT, League,
  CS2, Fortnite, Apex, Overwatch 2, Marvel Rivals, Rocket League, Dota 2,
  GTA V, Minecraft (Bedrock), Roblox, and more), not every game.

## HopOn 0.2.0

**Update the app and the server together.** 0.2.0 uses a new protocol: a
0.1 app shows *Update needed* on a 0.2 server, and the other way round.

### New

- **Files, images and videos.** Attach with **+**, paste, or drag files
  anywhere onto the window. Up to 10 per message, 25 MB each. Images, GIFs
  and videos show in the chat; click one to see it full size. Other files
  download.
- **GIFs.** The **GIF** button next to emoji searches KLIPY, with trending
  GIFs first. Click to send. (The server needs a free KLIPY key.)
- **In-game overlay.** Press **Alt+`** in a game: a small chat for your open
  channel appears bottom-right, with your voice room beside it (whoever is
  talking glows). Type and press Enter to send. Press **Alt+`** again (or Esc)
  to go straight back to your game.
- **Hotkeys.** Switch channels (Alt+↓/↑), jump to unread channels
  (Alt+Shift+↓/↑), switch servers (Ctrl+Alt+↓/↑), mute (Ctrl+Shift+M),
  deafen (Ctrl+Shift+D), games (Ctrl+G), message box (Ctrl+T), zoom
  (Ctrl + / − / 0). Every one can be changed in Settings → Hotkeys.
- **Scale.** Settings → Display → Scale, 80 % to 150 %.
- **Welcome messages.** New members get a random welcome in general.

### Fixed

- With the games panel open in a smaller window, the chat disappeared, and
  stayed gone after maximizing again. The chat now always comes back, and
  the games panel closes itself when the window is too narrow for both.

### Known issues

- The overlay can't draw over games in **exclusive fullscreen** or games
  **run as administrator**. Use borderless/windowed fullscreen.
- If another app already uses Alt+`, pick a different overlay key in
  Settings → Hotkeys.
- GIF search shows "not set up" until the server owner adds a KLIPY key.

## HopOn 0.1.0

The first release of HopOn: a fast, light chat and voice app for Windows,
built in Rust.

It connects to the public server by default: install, create an account,
done.

### Highlights

- **Fast.** Messages reach other people in 0.43 ms (p95) on the server side;
  the rest is your internet connection. Cold start in 657 ms.
- **Light.** 190 MB of memory at idle, 0.13% CPU, a 9.9 MB installer.
- **Voice that holds up.** Under 90 ms network path (p95), with no dropouts
  in a one-hour test.
- **Games beside the chat.** Play Wordle, Minute Cryptic or Krillion in the
  side panel and share your result to #general, as often as you like.

### Features

**Chat**
- Servers with text channels (with topics) and voice rooms; invite links.
- Edit and delete your messages; replies; emoji reactions; @mentions with
  autocomplete; typing indicator.
- Emoji picker in the message bar; reactions use the same picker.
- Formatting: bold, italic, strikethrough, code, code blocks, links.
- Unread markers that survive restarts, a "new messages" divider, day
  separators and "jump to latest".
- Online/offline presence; the taskbar flashes when you're mentioned.

**Voice**
- Join, leave, mute, deafen, push-to-talk, and pick your microphone and output.
- Echo cancellation, noise suppression and auto gain, each toggleable.
- Join/leave chimes and speaking indicators.

**Your account**
- Profile pictures.
- Settings follow your account to any PC: sounds, push-to-talk, voice
  processing, recent emoji, last server and channel.

**Server settings**
- Owners: rename the server and channels, set topics, delete channels or the
  whole server, remove members, revoke invites, delete any message.
- Members: leave a server from the People panel.

**Windows**
- Native Rust core; one copy runs at a time; crash reports are saved to
  `%LOCALAPPDATA%\app.hopon.desktop\crash.log`.

### Known issues

- **"Windows protected your PC" warning:** the installer isn't code-signed yet.
  Click *More info → Run anyway*.
- **Upgrading from a pre-release build:** if the app shows *Offline*, log out
  and set the server on the sign-in screen to `wss://hopon-chat.duckdns.org/ws`
  (only needed once).
- **App and server must be the same version.** An outdated app shows
  *Update needed*; install the latest from the link above.
- Games are third-party websites and need an internet connection; if one
  changes its Share button, sharing to chat may stop working until we update.
- Uses Windows' built-in WebView2 for its interface; the installer adds it if
  it's missing.

### Not in this version

Image and file attachments, per-person voice volume, message search.
