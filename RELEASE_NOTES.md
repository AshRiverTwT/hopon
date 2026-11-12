# HopOn 0.1.0

The first release of HopOn: a fast, light chat and voice app for Windows,
built in Rust.

**Download:** [HopOn_0.1.0_x64-setup.exe](https://github.com/AshRiverTwT/hopon/raw/downloads/HopOn_0.1.0_x64-setup.exe) (9.9 MB).
It connects to the public server by default: install, create an account,
done.

## Highlights

- **Fast.** Messages reach other people in 0.43 ms (p95) on the server side;
  the rest is your internet connection. Cold start in 657 ms.
- **Light.** 190 MB of memory at idle, 0.13% CPU, a 9.9 MB installer.
- **Voice that holds up.** Under 90 ms network path (p95), with no dropouts
  in a one-hour test.
- **Games beside the chat.** Play Wordle, Minute Cryptic or Krillion in the
  side panel and share your result to #general, as often as you like.

## Features

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

## Known issues

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

## Not in this version

Image and file attachments, per-person voice volume, message search.
