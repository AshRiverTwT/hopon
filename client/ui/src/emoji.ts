// Emoji set for the picker: category → "emoji keyword keyword …" entries.
// Keywords drive search. Kept small and curated (no external data file).

const RAW: Record<string, string[]> = {
  Smileys: [
    "😀 grin happy smile", "😃 smile happy joy", "😄 smile laugh happy", "😁 grin beam", "😆 laugh squint", "😅 sweat smile nervous",
    "😂 joy laugh tears lol", "🤣 rofl laugh rolling", "🙂 slight smile", "🙃 upside down", "😉 wink", "😊 blush smile",
    "😇 angel innocent halo", "🥰 love hearts adore", "😍 heart eyes love", "🤩 star struck wow", "😘 kiss", "😋 yum tasty",
    "😛 tongue", "😜 wink tongue crazy", "🤪 zany crazy goofy", "😎 cool sunglasses", "🤓 nerd glasses", "🧐 monocle curious",
    "🤔 thinking hmm", "🤨 raised eyebrow sus", "😐 neutral meh", "😑 expressionless", "😶 no mouth silent", "🙄 eye roll",
    "😏 smirk", "😬 grimace awkward", "🤥 lying", "😌 relieved calm", "😔 pensive sad", "😪 sleepy", "😴 sleeping zzz",
    "😷 mask sick", "🤒 thermometer sick", "🤢 nauseated sick", "🤮 vomit", "🥵 hot", "🥶 cold freezing", "🥴 woozy drunk",
    "😵 dizzy", "🤯 mind blown exploding", "🤠 cowboy", "🥳 party celebrate", "🥸 disguise", "😕 confused", "😟 worried",
    "🙁 frown", "😮 wow open mouth", "😯 hushed", "😲 astonished shocked", "😳 flushed embarrassed", "🥺 pleading puppy eyes",
    "🥲 smile tear", "😢 cry sad", "😭 sob crying", "😱 scream fear", "😖 confounded", "😣 persevere", "😞 disappointed",
    "😓 sweat", "😩 weary tired", "😫 tired", "🥱 yawn bored", "😤 triumph huff", "😡 rage angry", "😠 angry mad",
    "🤬 swearing cursing", "😈 devil smiling", "💀 skull dead lmao", "☠️ skull crossbones", "💩 poop", "🤡 clown", "👻 ghost",
    "👽 alien", "🤖 robot", "🫡 salute", "🫠 melting", "🤫 shush quiet", "🤭 giggle oops", "🫣 peek", "🤗 hug",
  ],
  People: [
    "👍 thumbs up yes like +1", "👎 thumbs down no dislike", "👌 ok okay", "✌️ peace victory", "🤞 fingers crossed luck",
    "🤟 love you", "🤘 rock horns", "🤙 call me shaka", "👈 point left", "👉 point right", "👆 point up", "👇 point down",
    "☝️ index up", "👋 wave hello bye", "🤚 raised back hand", "✋ hand stop high five", "🖖 vulcan", "👏 clap applause",
    "🙌 raise hands celebrate", "🫶 heart hands", "👐 open hands", "🤲 palms up", "🤝 handshake deal", "🙏 pray please thanks",
    "✍️ writing", "💪 muscle strong flex", "🦾 mechanical arm", "🧠 brain smart", "👀 eyes look see", "👁️ eye", "👂 ear",
    "👃 nose", "👄 mouth lips", "🫦 biting lip", "👶 baby", "🧒 child", "🧑 person", "👨 man", "👩 woman", "🧓 older person",
    "🙋 raising hand", "🙅 no gesture", "🙆 ok gesture", "🤷 shrug idk", "🤦 facepalm", "🙇 bow", "💁 tipping hand",
    "🧑‍💻 technologist coder", "🧑‍🎤 singer", "🧑‍🍳 cook chef", "🥷 ninja", "🦸 superhero", "🧙 mage wizard", "🧛 vampire",
    "🧟 zombie", "🕺 dancing man", "💃 dancing woman", "🏃 running", "🚶 walking", "🧘 yoga meditate",
  ],
  Hearts: [
    "❤️ red heart love", "🧡 orange heart", "💛 yellow heart", "💚 green heart", "💙 blue heart", "💜 purple heart",
    "🖤 black heart", "🤍 white heart", "🤎 brown heart", "💔 broken heart", "❤️‍🔥 heart on fire", "💕 two hearts",
    "💞 revolving hearts", "💓 beating heart", "💗 growing heart", "💖 sparkling heart", "💘 cupid arrow", "💝 heart ribbon gift",
    "💯 hundred 100 perfect", "💢 anger", "💥 boom collision", "💫 dizzy star", "💦 sweat drops", "💨 dash wind", "🔥 fire lit hot",
    "✨ sparkles", "⭐ star", "🌟 glowing star", "⚡ lightning zap", "💤 zzz sleep", "🎉 tada party celebrate", "🎊 confetti",
  ],
  Animals: [
    "🐶 dog puppy", "🐱 cat kitty", "🐭 mouse", "🐹 hamster", "🐰 rabbit bunny", "🦊 fox", "🐻 bear", "🐼 panda",
    "🐨 koala", "🐯 tiger", "🦁 lion", "🐮 cow", "🐷 pig", "🐸 frog", "🐵 monkey", "🙈 see no evil", "🙉 hear no evil",
    "🙊 speak no evil", "🐔 chicken", "🐧 penguin", "🐦 bird", "🦆 duck", "🦅 eagle", "🦉 owl", "🦇 bat", "🐺 wolf",
    "🐴 horse", "🦄 unicorn", "🐝 bee", "🐛 bug", "🦋 butterfly", "🐌 snail", "🐞 ladybug", "🐢 turtle", "🐍 snake",
    "🦖 t-rex dinosaur", "🐙 octopus", "🦑 squid", "🦀 crab", "🐟 fish", "🐬 dolphin", "🐳 whale", "🦈 shark", "🐊 crocodile",
    "🌵 cactus", "🌲 tree", "🌴 palm", "🍀 clover luck", "🍁 maple leaf", "🌸 cherry blossom", "🌹 rose", "🌻 sunflower",
    "🌙 moon", "☀️ sun", "🌈 rainbow", "☁️ cloud", "❄️ snowflake", "🌊 wave ocean",
  ],
  Food: [
    "🍏 green apple", "🍎 apple", "🍌 banana", "🍉 watermelon", "🍇 grapes", "🍓 strawberry", "🍒 cherries", "🍑 peach",
    "🥭 mango", "🍍 pineapple", "🥥 coconut", "🥑 avocado", "🍆 eggplant", "🌶️ chili hot pepper", "🌽 corn", "🥕 carrot",
    "🥔 potato", "🍞 bread", "🥐 croissant", "🧀 cheese", "🥚 egg", "🍳 cooking egg", "🥓 bacon", "🍔 burger", "🍟 fries",
    "🍕 pizza", "🌭 hotdog", "🥪 sandwich", "🌮 taco", "🌯 burrito", "🍜 ramen noodles", "🍝 spaghetti", "🍣 sushi",
    "🍤 shrimp", "🍙 rice ball", "🍚 rice", "🍛 curry", "🥟 dumpling", "🍦 ice cream", "🍩 donut", "🍪 cookie", "🎂 cake birthday",
    "🍰 cake slice", "🧁 cupcake", "🍫 chocolate", "🍬 candy", "🍿 popcorn", "☕ coffee", "🍵 tea", "🧋 boba bubble tea",
    "🥤 soda drink", "🍺 beer", "🍻 cheers beers", "🍷 wine", "🥂 champagne toast", "🍸 cocktail", "🧃 juice",
  ],
  Activity: [
    "⚽ soccer football", "🏀 basketball", "🏈 american football", "⚾ baseball", "🎾 tennis", "🏐 volleyball", "🏓 ping pong",
    "🏸 badminton", "🥊 boxing", "🥅 goal", "⛳ golf", "🏆 trophy win", "🥇 gold medal first", "🥈 silver second",
    "🥉 bronze third", "🏅 medal", "🎮 video game controller gaming", "🕹️ joystick arcade", "🎲 dice", "♟️ chess",
    "🧩 puzzle", "🎯 bullseye target", "🎳 bowling", "🎸 guitar", "🎹 piano", "🥁 drum", "🎤 microphone karaoke", "🎧 headphones",
    "🎬 movie clapper", "🎨 art palette", "🎭 theater", "🎟️ ticket", "🎁 gift present", "🎈 balloon", "🏁 finish flag race",
    "🚀 rocket launch ship", "✈️ airplane", "🚗 car", "🏎️ race car", "🚲 bike", "⛵ sailboat", "🏠 house home", "🏖️ beach",
  ],
  Objects: [
    "💻 laptop computer", "🖥️ desktop", "⌨️ keyboard", "🖱️ mouse", "📱 phone", "📷 camera", "🎥 video camera", "📺 tv",
    "🔋 battery", "🔌 plug", "💡 idea bulb", "🔦 flashlight", "📚 books", "📖 book", "📝 memo note", "✏️ pencil", "📌 pin",
    "📎 paperclip", "✂️ scissors", "🗑️ trash", "🔒 lock", "🔑 key", "🔨 hammer", "🛠️ tools", "⚙️ gear settings", "🧪 test tube",
    "🔭 telescope", "📡 satellite", "💰 money bag", "💸 money wings", "💳 card", "🛒 cart", "📦 package", "📫 mailbox",
    "📅 calendar", "⏰ alarm", "⏳ hourglass", "🕹️ joystick", "🧸 teddy", "👑 crown king", "💎 gem diamond", "🔔 bell",
  ],
  Symbols: [
    "✅ check done yes", "☑️ ballot check", "✔️ check mark", "❌ cross no x", "❎ cross box", "⭕ circle", "🚫 prohibited no",
    "⛔ no entry", "⚠️ warning", "❗ exclamation", "❓ question", "‼️ double exclamation", "⁉️ interrobang", "💬 speech bubble",
    "💭 thought bubble", "🗯️ anger bubble", "🔴 red circle", "🟠 orange circle", "🟡 yellow circle", "🟢 green circle",
    "🔵 blue circle", "🟣 purple circle", "⚫ black circle", "⚪ white circle", "🟥 red square", "🟩 green square",
    "🟨 yellow square", "⬛ black square", "⬜ white square", "➕ plus", "➖ minus", "➗ divide", "✖️ multiply", "♾️ infinity",
    "🔁 repeat", "🔄 refresh", "⬆️ up arrow", "⬇️ down arrow", "⬅️ left arrow", "➡️ right arrow", "🆗 ok button", "🆕 new",
    "🆒 cool", "🆙 up", "🔝 top", "🎵 music note", "🎶 notes music", "🔊 loud speaker", "🔇 mute", "📢 loudspeaker",
  ],
};

export interface Emoji { e: string; k: string }

export const CATEGORIES: { name: string; list: Emoji[] }[] = Object.entries(RAW).map(([name, rows]) => ({
  name,
  list: rows.map((r) => {
    const i = r.indexOf(" ");
    return { e: r.slice(0, i), k: r.slice(i + 1).toLowerCase() };
  }),
}));

const ALL: Emoji[] = CATEGORIES.flatMap((c) => c.list);

export function searchEmoji(q: string, limit = 64): Emoji[] {
  const t = q.trim().toLowerCase();
  if (!t) return [];
  const words = t.split(/\s+/);
  const hits = ALL.filter((x) => words.every((w) => x.k.split(" ").some((k) => k.startsWith(w)) || x.k.includes(w)));
  // Prefix matches on the first keyword rank first.
  hits.sort((a, b) => Number(!a.k.startsWith(words[0])) - Number(!b.k.startsWith(words[0])));
  return hits.slice(0, limit);
}
