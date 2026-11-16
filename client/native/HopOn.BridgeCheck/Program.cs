// End-to-end check of the native bridge, from real C# through hopon_ffi to a
// running HopOn server. Two processes, because the core is one per process:
//
//   owner:  sign up, create a server, write an invite to a file, upload a file
//           (binary blob path), send a message, check error paths, then wait
//           for the guest's message to arrive as an event.
//   guest:  sign up, join with the invite, send a message.
//
// Run (server on localhost:8080, hopon_ffi on the library path):
//   HOPON_URL=ws://127.0.0.1:8080/ws dotnet run -- owner <work-dir>
// The owner starts the guest itself. Exit code 0 = every check passed.

using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
using HopOn.Native;

var role = args.ElementAtOrDefault(0) ?? "owner";
var work = args.ElementAtOrDefault(1) ?? Path.Combine(Path.GetTempPath(), "hopon-bridge-check");
Directory.CreateDirectory(work);
var timeout = TimeSpan.FromSeconds(20);
var failures = 0;

void Pass(string what) => Console.WriteLine($"[{role}] ok   {what}");
void Fail(string what) { failures++; Console.WriteLine($"[{role}] FAIL {what}"); }

Console.WriteLine($"[{role}] hopon_ffi {HopOnCore.NativeVersion}");
var events = new BlockingCollection<JsonElement>();
var core = HopOnCore.Start(new Host(), Path.Combine(work, role + "-data"));
core.Subscribe("main", ev => events.Add(ev));

// Wait for an event matching `pred` (other events are skipped).
JsonElement? WaitFor(Func<JsonElement, bool> pred)
{
    var until = DateTime.UtcNow + timeout;
    while (DateTime.UtcNow < until)
        if (events.TryTake(out var ev, 200) && pred(ev)) return ev;
    return null;
}
static string T(JsonElement e) => e.GetProperty("t").GetString() ?? "";

if (WaitFor(e => T(e) == "conn" && e.GetProperty("state").GetString() == "online") is null) { Fail("connected"); return 1; }
Pass("connected (conn: online event)");

var name = $"{role}{Guid.NewGuid().ToString("N")[..8]}";
await core.CallAsync("signup", new JsonObject { ["username"] = name, ["password"] = "bridge-check-pass" });
var session = WaitFor(e => T(e) == "session" && e.GetProperty("user").ValueKind == JsonValueKind.Object);
if (session is null) { Fail("signed up (session event with user)"); return 1; }
Pass($"signed up as {session.Value.GetProperty("user").GetProperty("name").GetString()}");

var invitePath = Path.Combine(work, "invite.txt");
var guestText = "hello from the guest " + Guid.NewGuid().ToString("N")[..6];

if (role == "guest")
{
    var code = File.ReadAllText(invitePath).Trim();
    var serverId = (await core.CallAsync("join_invite", new JsonObject { ["code"] = code })).GetString()!;
    var channel = WaitFor(e => T(e) == "server" && e.GetProperty("server").GetProperty("id").GetString() == serverId);
    var channelId = channel?.GetProperty("server").GetProperty("channels").EnumerateArray()
        .First(c => !c.GetProperty("voice").GetBoolean()).GetProperty("id").GetString();
    if (channelId is null) { Fail("joined (server event)"); return 1; }
    Pass("joined the owner's server");
    var text = File.ReadAllText(Path.Combine(work, "guest-text.txt"));
    await core.CallAsync("send_message", new JsonObject
    {
        ["channelId"] = channelId, ["content"] = text,
        ["nonce"] = Random.Shared.NextInt64(1, long.MaxValue).ToString(),
        ["tInputMs"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
    });
    Pass("sent a message");
    // Give the frame time to leave before the process exits.
    WaitFor(e => T(e) == "msgState" && e.GetProperty("state").GetInt32() >= 2);
    return failures == 0 ? 0 : 1;
}

// ---- owner ----
var server = (await core.CallAsync("create_server", new JsonObject { ["name"] = "bridge check" })).GetString()!;
var srv = WaitFor(e => T(e) == "server" && e.GetProperty("server").GetProperty("id").GetString() == server);
var general = srv?.GetProperty("server").GetProperty("channels").EnumerateArray()
    .First(c => !c.GetProperty("voice").GetBoolean()).GetProperty("id").GetString();
if (general is null) { Fail("created a server (server event with a text channel)"); return 1; }
Pass("created a server");
await core.CallAsync("open_channel", new JsonObject { ["channelId"] = general });

// Binary path: upload_file with the bytes in the blob.
var bytes = System.Text.Encoding.UTF8.GetBytes("bridge check upload\n");
var att = await core.CallAsync("upload_file", new JsonObject { ["name"] = "check.txt" }, bytes);
var attId = att.GetProperty("id").GetString();
if (att.GetProperty("size").GetInt64() == bytes.Length && attId is not null) Pass($"uploaded a file through the blob ({att.GetProperty("size")} bytes)");
else Fail("upload size");

var nonce = Random.Shared.NextInt64(1, long.MaxValue).ToString();
var mine = "owner says hi " + nonce[..6];
await core.CallAsync("send_message", new JsonObject
{
    ["channelId"] = general, ["content"] = mine, ["nonce"] = nonce,
    ["tInputMs"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
    ["files"] = new JsonArray(attId),
});
if (WaitFor(e => T(e) == "msgState" && e.GetProperty("nonce").GetString() == nonce && e.GetProperty("state").GetInt32() == 2) is not null)
    Pass("sent a message with the file (durable)");
else Fail("message became durable");

// Error paths come back as exceptions with the core's message.
try { await core.CallAsync("no_such_command"); Fail("unknown command rejected"); }
catch (HopOnException e) when (e.Message.StartsWith("unknown command")) { Pass("unknown command rejected"); }
try { await core.CallAsync("mark_read", new JsonObject { ["channel_id"] = general }); Fail("bad arguments rejected"); }
catch (HopOnException e) when (e.Message.Contains("bad arguments")) { Pass("bad arguments rejected"); }
try { await core.CallAsync("set_server_url", new JsonObject { ["url"] = "http://nope" }); Fail("validation error"); }
catch (HopOnException e) { Pass($"validation error: \"{e.Message}\""); }

// Inbound: the guest joins and posts; it must arrive here as an event.
var invite = (await core.CallAsync("create_invite", new JsonObject { ["serverId"] = server })).GetString()!;
File.WriteAllText(invitePath, invite.Split('/').Last());
File.WriteAllText(Path.Combine(work, "guest-text.txt"), guestText);
var self = Environment.ProcessPath!;
var selfArgs = Environment.GetCommandLineArgs()[0].EndsWith(".dll") ? $"\"{Environment.GetCommandLineArgs()[0]}\" " : "";
using var guest = Process.Start(new ProcessStartInfo(self, $"{selfArgs}guest \"{work}\"") { UseShellExecute = false })!;
var got = WaitFor(e => T(e) == "messages" && e.GetProperty("channelId").GetString() == general
    && e.GetProperty("msgs").EnumerateArray().Any(m => m.GetProperty("content").GetString() == guestText));
if (got is not null) Pass("received the guest's message as an event");
else Fail("guest's message arrived");
guest.WaitForExit(30_000);
if (guest.ExitCode != 0) Fail($"guest exited {guest.ExitCode}");

var older = await core.CallAsync("open_channel", new JsonObject { ["channelId"] = general });
if (older.EnumerateArray().Any(m => m.GetProperty("content").GetString() == mine)) Pass("open_channel returns history");
else Fail("history");

Console.WriteLine(failures == 0 ? "[owner] all checks passed" : $"[owner] {failures} check(s) failed");
return failures == 0 ? 0 : 1;

sealed class Host : IHopOnHost
{
    public bool MainHidden => false;
    public void RequestAttention() { }
    public void Exit(int code) => Environment.Exit(code);
}
