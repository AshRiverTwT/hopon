# HopOn release notes

**Download the latest:** [Windows: HopOn-setup.exe](https://github.com/AshRiverTwT/hopon/raw/downloads/HopOn-setup.exe) · [Linux: HopOn-x86_64.AppImage](https://github.com/AshRiverTwT/hopon/raw/downloads/HopOn-x86_64.AppImage)

## HopOn 0.8.1

App only: no server update needed.

### New

- **New logo: the step H.** An H whose right leg has hopped up a step,
  joined by a signal-orange bar. On the app icon, the tray, the installer and
  the logo inside the app.
- **Startup splash.** The logo builds itself while HopOn signs you in,
  instead of flashing the login screen for a moment.

### Fixed

- **Selecting text** picks up messages only: names, times, buttons and
  React / Reply / Save stay out of what you copy.
- **Games** closes itself when you switch channel, voice room, server or
  view, so it never covers a call, a stream or a camera.
- **Voice rooms** have one line under the title, not two.
- **Status (bottom right)** stays on one line at any window size: the light
  leads it, and the clock, then the latency, step aside when space is tight.
- **In-game overlay** sits tight in the bottom-right corner, its chat panel is
  30 % see-through, and the people in voice have no box behind them.

## HopOn 0.8.0

App only: no server update needed (works with the 0.7 server).

A new look for HopOn, tested as the Moon experiment: a precision instrument
in black and white.

### New

- **Servers on the dial.** Your servers sit on a straight list through the
  server letters: previous above, next below. Scroll inside the dial's arc to
  switch (outside it, the wheel moves through channels), or click one. The new
  server slides in from the direction you scrolled.
- **The channel wheel is a rotary dial.** A ring of ticks turns with your
  channels, with a lit pointer on the selected one and a readout under the
  server letters (`01/08 TXT`, `VOX` for voice).
- **Hardware keys.** Sharp buttons with thin borders, uppercase labels and a
  press. Friends | Servers is a two-position switch; People, Games, Server
  and Settings are one strip of keys; Mic and Sound have a light.
- **Black and white, with one signal colour.** Orange marks what's happening:
  LIVE, speaking, unread, mentions, lit lights, the dial's pointer and
  updates. Game results and profile colours stay in colour.
- **New type:** Geist for text, Geist Mono for labels and numbers.
- **Sharp everywhere:** no rounded corners; shadows give depth. Presence is
  a solid square (online), half-filled (idle), a bar (do not disturb) or an
  outline (invisible).
- **New icon:** a square black icon with a white H.

### Changed

- The message bar, Mic/Sound and the status readout sit on one line at the
  bottom; "is typing" shows above the message bar.
- Viewfinder corners frame the app and the login screen.

## HopOn 0.7.0

**Update the server too** (new protocol): 0.6 apps and servers don't talk to
0.7 ones. The app offers the update as soon as it starts.

### New

- **Profiles.** Click anyone's name or picture (chat, people, voice room,
  friends) for their card: picture, banner, status, what they're playing or
  which room they're in, about me, member since and when they joined the
  server. Message, add friend, their volume (in your voice room), and Remove
  for server owners.
- **Edit profile** (your name bottom-left, or Settings → Profile): picture,
  banner, a colour for your name, display name and about me.
- **Status.** Click your name bottom-left: Online, Do not disturb or
  Invisible, and a custom status ("heads down 📚") that can clear itself after
  1 hour, 4 hours or today.
  - **Idle** turns on by itself after 10 minutes away (on Windows, any input
    counts, so gaming isn't idle; on Linux, input in HopOn, voice or a game).
  - **Do not disturb** silences notifications and sounds.
  - **Invisible** shows you offline, games included.
- **Call view beside other apps.** Esc (or the button) leaves fullscreen but
  keeps the call view in the window, so you can snap HopOn next to another
  app; the × closes it.

### Changed

- **Server settings**, reorganized: invite (and revoke), name, channels as a
  compact list (click one to edit or delete it), people, delete.
- The channel dial stays put when you switch channels.
- No more red edge lines on mentions, polls, notifications and settings.

## HopOn 0.6.4

App only: no server update needed.

### New

- **Linux.** HopOn now comes as an AppImage too (x86_64; Arch, Fedora,
  Ubuntu and others). Download it, `chmod +x HopOn-x86_64.AppImage` and run it.
  Chat, voice, streams, cameras, notifications, "Playing…" and in-app updates
  all work. Global push-to-talk and the in-game overlay are Windows only for now.

### Fixed

- **Quit from the tray** closes HopOn again (it used to stay running when
  "close to tray" was on).

## HopOn 0.6.3

Update the server too, for the 10-minute edit limit (the app works on a
0.6.1 server; edits just aren't limited there).

### Changed

- **Right column, top to bottom:** People, **Games**, Server and Settings
  sit above the people list (or the games panel), which starts at the top
  again.
- **Invite** moved into **Server** (everyone can make an invite link there).
- Settings has a gear; Update sits under Friends / Servers.
- Titles size themselves to fit, so they don't get cut off when Games is open.
- **Messages can be edited for 10 minutes** after sending.
- Fewer explanations: a cleaner Friends page (your @username sits by the
  title), stream quality and polls.
- The selected channel on the wheel is back to its old size.

## HopOn 0.6.1

App only: no server update needed.

### New

- **Call view.** In a voice room, the fullscreen button opens the room
  fullscreen. Switch between **everyone** (a tile per person: their stream,
  else their camera, else their picture, with *Watch stream* on anyone
  sharing) and **focus** (one picture big, everyone else in a strip). Camera,
  Stream, Mic and Leave along the bottom; stream volume, picture in picture
  and Exit on the right. Esc leaves.
- **Real picture in picture** for streams (and your own): the stream floats
  over your other windows and games. HopOn's own mini player is still there
  as a fallback.

### Changed

- **Friends** and **Servers** sit at the top left; the channel's name, icons
  and topic moved up into the top row. The app buttons on the right are now
  quiet icons (people, invite, games, server settings, settings).
- The selected channel on the wheel is a full-width bar with the › at its end.

### Fixed

- The stream quality menu was cut off at the top in the voice room.
- Stream tiles lost their picture-in-picture and fullscreen buttons when the
  tiles view was on (that view is now the call view).

## HopOn 0.6.0

**Update the app and the server together** (new protocol: a 0.5 app shows
*Update needed* on a 0.6 server and offers the one-click update).

### New

- **Friends and direct messages.** **Friends** in the top bar: add people by
  their username (shown on that page, so you can share yours), accept or
  decline requests, and message any friend. Conversations are listed on the
  left, online friends (and what they're playing) on the right. Removing a
  friend keeps your messages but closes the conversation until you're
  friends again.
- **Tiles view in voice rooms.** The small switch next to the room's name
  shows everyone as a picture: their stream if they're sharing, else their
  camera, else their avatar.
- **1440p · 60 fps** streaming.
- Stream volume goes up to **200 %**.

### Changed

- **The voice room is back to the old, clean layout**, with just **Leave**,
  **Camera** (on/off) and **Stream** (pick a quality, then *Stop streaming*).
  *Low resource streams* moved to Settings → Display.
- **Streams always include sound** (when you share a whole screen; Windows
  doesn't share sound from a single window). Viewers on speakers may hear
  voice chat echoed through the stream.
- **Polls** have their own *New poll* page and a new look in chat: each
  option is a bar filled by its share of the votes.
- **The in-game overlay** now looks like the rest of HopOn.
- Search and Saved are icons in the channel header (a magnifying glass and a bookmark), so the
  top bar stays uncluttered.
- Icons are drawn in HopOn's own style everywhere: the favorite star and the
  emoji picker's category tabs were colour emoji and are now line icons.

### Fixed

- Stream sound could keep playing after **Stop watching** if you stopped (or
  clicked Watch twice) while the stream was still connecting.
- Camera pictures were cut off in smaller windows; they're always shown
  whole now.
- The top bar ran off the edge of narrower windows.
- Polls showed as raw data in notifications, reply quotes and the overlay.

## HopOn 0.5.2

**Update the app and the server together** (new protocol: a 0.5.1 app shows
*Update needed* on a 0.5.2 server and offers the one-click update).

### New

- **Webcam video in voice rooms.** Turn your camera on in the room, or press
  **Join with camera**. Your own preview is mirrored.
- **Polls.** The poll button in the message bar asks a question with 2 to 5
  options; people vote with 1️⃣–5️⃣ and the counts update live.
- **Display names.** Set one in Settings → Profile; it shows instead of your
  username.
- **Saved messages.** **Save** on any message; **Saved** in the channel header
  lists them and jumps back to each one.
- **Favorite channels.** The ☆ in the channel header.
- **Search this channel.** **Search** in the channel header finds text in the
  messages loaded so far.
- **Push-to-talk on mouse buttons** (Mouse 4 / Mouse 5).
- **Low resource screen sharing:** 720p at 30 fps, and you watch one stream
  at a time.

### Better

- **Catch-up after reconnecting.** After a dropped connection or a server
  restart, HopOn fetches exactly what you missed (messages, edits, deletions,
  reactions) instead of reloading the channel.
- **No duplicate messages** when a send is retried after a reconnect.
- **Big servers load faster.** Members load in pages as you scroll the people
  list, and @mention suggestions search the whole server.
- **Lighter in the background.** While HopOn is minimized or in the tray it
  skips screen updates it doesn't need; notifications and the in-game overlay
  keep working.
- Screen share connects only when someone shares or watches.
- Drafts and unfinished uploads stay put when you switch channels; a channel
  that fails to load offers **Retry**.

### Known issues

- Saved messages and favorite channels are kept on this PC only (they don't
  follow your account to another computer yet).
- While HopOn is open but not the window you're using, it stops updating the
  chat on screen and catches up when you click back in. Notifications still
  arrive.

## HopOn 0.5.1

App only: no server update needed.

### Fixed

- **Screen share went black** in fullscreen, in the mini player, and when you
  came back to the voice room (until you pressed Stop watching and Watch
  again). A stream now keeps its picture wherever you move it, even when
  the shared screen isn't changing.
- **Stream volume slider** is always there on a stream now (dimmed when the
  stream has no sound). Sharing tip: Windows only includes sound when you
  share a **whole screen**, not a single window; HopOn now tells you when
  that happens.
- **Chat text overlapping or vanishing** after switching channels (fixed
  itself when you moved the mouse over it). Messages now stay laid out
  correctly as pictures, GIFs and emoji load.

## HopOn 0.5.0

**Update the server too** for viewer counts on screen shares (everything
else works on a 0.4 server; the protocol is unchanged).

### New

- **Notifications.** Messages in other channels pop up as a small banner in
  the top right (click to jump to the message). While HopOn is in the
  background or in the tray you get **Windows notifications** instead; click
  one to open the channel. Settings → Notifications switches Windows
  notifications, in-app notifications and the notification sound on or off.
- **Per-channel notifications.** The bell next to a channel's name: *All
  messages*, *Only @mentions* or *Nothing*. Follows your account.
- **Screen share mini player.** Leave the voice room (open a text channel,
  switch servers) and the stream you're watching keeps playing in a floating
  player you can drag and resize. Click it to go back to the room. The
  **picture-in-picture** button pops it out by hand. Settings → Display →
  *Mini player* turns the automatic one off.
- **Fullscreen** for streams: the button (or double-click the picture) fills
  the whole screen; Esc leaves. Your own stream's preview has it too, plus a
  bigger-preview toggle.
- **Stream volume** slider (0–100 %, remembered per person) when a stream
  includes sound.
- **Viewer count**: an eye with the number of people watching, next to LIVE,
  on the stream and for your own stream (hover for names).

### Better

- **Screen share sound**: stereo at 192 kb/s with voice processing off, so
  music and game audio come through clean (it was mono speech quality).

### Fixed

- Small or scaled windows: names and times no longer wrap over each other,
  the channel dial, people column and top bar shrink to fit, and the chat
  keeps a readable width.
- Coming back to the voice room shows the stream straight away (no need to
  press Watch again). Leaving the room no longer leaves you hearing a stream
  you can't see.
- The stream's control bar (Fullscreen, Stop watching) was cut off.

## HopOn 0.4.2

- **One-click updates.** When a new version is out, an **Update to …**
  button appears in the top bar (also Settings → Account → Updates). If the
  server needs a newer app, HopOn asks you to update and does it for you:
  downloads, checks the file, installs and reopens.
- Same protocol as 0.4.0: no server update needed.

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
