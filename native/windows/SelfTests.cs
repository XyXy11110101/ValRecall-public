using System.Buffers.Binary;
using System.Diagnostics;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace ValRecall.SyncHost;

internal static class SelfTests
{
    private static int assertions;
    private static string stage = "unit tests";

    internal static async Task<int> RunAsync()
    {
        try
        {
            await TestFrames();
            TestPairing();
            TestLanPolicy();
            await TestConnection();
            if (OperatingSystem.IsWindows()) await TestRealProcess();
            Console.WriteLine($"PASS: {assertions} native helper assertions; framing, pairing, auth, epoch, discovery, TLS, process lifecycle.");
            return 0;
        }
        catch (Exception error)
        {
            // Names/types only: test failures must not print fixture credentials or message contents.
            Console.Error.WriteLine("FAIL: native helper self-test, " + stage + " (" + error.GetType().Name + "). " +
                (error is TestFailure ? error.Message : "No request or secret data logged."));
            if (error is HttpRequestException network) Console.Error.WriteLine("Network error category: " + network.HttpRequestError);
            for (var inner = error.InnerException; inner is not null; inner = inner.InnerException)
                Console.Error.WriteLine("Inner category: " + inner.GetType().Name + "; HResult=" + inner.HResult);
            return 1;
        }
    }

    internal static string ValidateTestDirectory(string path)
    {
        var full = Path.GetFullPath(path);
        var root = Path.GetFullPath(Path.GetTempPath()).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (!full.StartsWith(root, StringComparison.OrdinalIgnoreCase) ||
            Path.GetDirectoryName(full)?.TrimEnd(Path.DirectorySeparatorChar) != root.TrimEnd(Path.DirectorySeparatorChar) ||
            !Path.GetFileName(full).StartsWith("ValRecall.SyncHost.Tests-", StringComparison.Ordinal) ||
            !Guid.TryParseExact(Path.GetFileName(full)["ValRecall.SyncHost.Tests-".Length..], "N", out _) ||
            !Directory.Exists(full) || (File.GetAttributes(full) & FileAttributes.ReparsePoint) != 0)
            throw new InvalidDataException("Only an isolated self-test temporary directory is accepted.");
        return full;
    }

    private static async Task TestFrames()
    {
        using var stream = new MemoryStream();
        await NativeFrames.WriteAsync(stream, new { version = 1, id = "unicode", type = "status", payload = new { text = "任务" } }, default);
        var bytes = stream.ToArray();
        Check(BinaryPrimitives.ReadUInt32LittleEndian(bytes) == bytes.Length - 4, "LE32 payload byte length");
        stream.Position = 0;
        var parsed = NativeEnvelope.Parse((await NativeFrames.ReadAsync(stream, default))!.Value);
        Check(parsed.Id == "unicode" && parsed.Payload.GetProperty("text").GetString() == "任务", "Unicode frame roundtrip");
        Check(await NativeFrames.ReadAsync(stream, default) is null, "EOF is clean shutdown");
        await Expect<EndOfStreamException>(async () => await NativeFrames.ReadAsync(new MemoryStream(bytes[..^1]), default), "truncated frame");
        await Expect<InvalidDataException>(async () => await NativeFrames.ReadAsync(new MemoryStream([255, 255, 255, 127]), default), "oversized frame");
        await Expect<InvalidDataException>(async () => await NativeFrames.ReadAsync(new MemoryStream([0, 0, 0, 0]), default), "empty frame");
        await Expect<InvalidDataException>(() => Task.FromResult(NativeEnvelope.Parse(Parse("{\"version\":1,\"version\":1,\"id\":\"x\",\"type\":\"status\",\"payload\":{}}"))), "duplicate fields");
        using var fragmented = new FragmentedStream(bytes);
        Check((await NativeFrames.ReadAsync(fragmented, default))!.Value.GetProperty("id").GetString() == "unicode", "fragmented pipe");
        using var worstFrame = new MemoryStream();
        var worst = LargestDomainRequest();
        await NativeFrames.WriteAsync(worstFrame, new { version = 1, id = "largest", type = "sync", payload = new { version = 1, deviceId = Guid.Empty.ToString("D"), request = worst } }, default);
        Check(worstFrame.Length < 900_000, "largest legitimate domain request fits stricter native bridge cap");
        worstFrame.Position = 0;
        var roundtrip = NativeEnvelope.Parse((await NativeFrames.ReadAsync(worstFrame, default))!.Value);
        Check(JsonElement.DeepEquals(roundtrip.Payload.GetProperty("request"), worst), "HTML-like task text survives framing exactly");
        using var lifecycleFrame = new MemoryStream();
        await NativeFrames.WriteAsync(lifecycleFrame, new { version = 1, id = "v2-capabilities", type = "sync", payload = new { version = 1, deviceId = "synthetic-device", request = new { version = 2, type = "capabilities", epoch = "synthetic-epoch" } } }, default);
        lifecycleFrame.Position = 0;
        var lifecycle = NativeEnvelope.Parse((await NativeFrames.ReadAsync(lifecycleFrame, default))!.Value);
        Check(lifecycle.Payload.GetProperty("request").GetProperty("version").GetInt32() == 2, "v2 domain survives unchanged v1 native envelope");
        using var receiptFrame = new MemoryStream();
        await NativeFrames.WriteAsync(receiptFrame, new { version = 1, id = "v2-receipt", type = "result", ok = true, payload = new { version = 2, type = "receipts", receipts = new[] { new { operationId = "synthetic-undo", status = "applied", reward = 0, walletDelta = -5 } } } }, default);
        receiptFrame.Position = 0;
        var receipt = NativeEnvelope.Parse((await NativeFrames.ReadAsync(receiptFrame, default))!.Value);
        Check(receipt.Payload.GetProperty("receipts")[0].GetProperty("walletDelta").GetInt32() == -5, "negative undo receipt survives native transport");
        await Expect<InvalidDataException>(async () => await NativeFrames.WriteAsync(new MemoryStream(), new { text = new string('x', NativeFrames.MaxBytes) }, default), "output frame cap still enforced");
    }

    private static JsonElement LargestDomainRequest()
    {
        var operations = new JsonArray();
        for (var index = 0; index < 32; index++)
            operations.Add(JsonSerializer.SerializeToNode(new
            {
                id = "synthetic-create-" + index, kind = "create-task", at = "2026-10-13T12:00:00.000Z",
                task = new
                {
                    id = "synthetic-task-" + index, schemaVersion = 1, title = "Synthetic <task> & 'text'",
                    notes = index < 31 ? string.Concat(Enumerable.Repeat("<>&'", 2000)) : "",
                    kind = "routine", recurrence = "daily", scheduledDate = (string?)null,
                    scheduledTime = (string?)null, selectedWeekdays = Array.Empty<int>(),
                    linkedLearningItemId = (string?)null, priority = "normal", archived = false,
                    createdAt = "2026-10-13T12:00:00.000Z", updatedAt = "2026-10-13T12:00:00.000Z"
                }
            }));
        var request = new JsonObject
        {
            ["version"] = 1, ["type"] = "push", ["epoch"] = "synthetic-epoch-one", ["operations"] = operations
        };
        var size = JsonSerializer.SerializeToUtf8Bytes(request, WireJson.TransportOptions).Length;
        var padding = 256 * 1024 - size;
        Check(padding is >= 0 and <= 8000, "largest request remains within mobile task note limits");
        operations[31]!["task"]!["notes"] = new string('<', padding);
        var bytes = JsonSerializer.SerializeToUtf8Bytes(request, WireJson.TransportOptions);
        Check(bytes.Length == 256 * 1024, "largest synthetic domain request is exactly 256 KiB UTF8");
        using var document = JsonDocument.Parse(bytes);
        return document.RootElement.Clone();
    }

    private static void TestPairing()
    {
        var time = new FakeTimeProvider(new DateTimeOffset(2026, 1, 1, 10, 0, 0, TimeSpan.Zero));
        SavedCredentials? saved = null;
        var pairing = new PairingState(new(1, Guid.NewGuid().ToString("D"), "", null, null), value => saved = value, time);
        var device = Guid.NewGuid().ToString("D");
        pairing.Initialize("epoch-one");
        Check(saved?.Epoch == "epoch-one", "initial epoch persisted");
        var qr = pairing.Start("192.168.1.2", new string('a', 64));
        Check(qr.Secret.Length == 43 && DateTimeOffset.Parse(qr.ExpiresAt) == time.GetUtcNow().AddMinutes(5), "short-lived pairing code");
        RejectPair(pairing, "wrong-server", qr.Secret, device, 401);
        RejectPair(pairing, qr.ServerId, new string('x', 43), device, 401);
        var result = pairing.Pair(qr.ServerId, qr.Secret, device);
        Check(result.Token.Length == 43 && result.Epoch == "epoch-one" && saved?.Token == result.Token, "pair persists before success");
        Check(pairing.Authenticate(result.Token, device) is not null, "paired token accepted");
        Check(pairing.Authenticate(result.Token, Guid.NewGuid().ToString("D")) is null, "wrong device denied");
        Check(pairing.Authenticate(new string('x', 43), device) is null, "wrong token denied");
        RejectPair(pairing, qr.ServerId, qr.Secret, device, 409);
        var session = pairing.Authenticate(result.Token, device)!.Value;
        pairing.Initialize("epoch-two");
        Check(!pairing.SessionCurrent(session) && pairing.Authenticate(result.Token, device) is null, "epoch invalidates token and active response");
        var expiring = pairing.Start("192.168.1.2", new string('a', 64));
        time.Now = time.Now.AddMinutes(5);
        RejectPair(pairing, expiring.ServerId, expiring.Secret, device, 401);
        var fresh = pairing.Start("192.168.1.2", new string('a', 64));
        var current = pairing.Pair(fresh.ServerId, fresh.Secret, device);
        pairing.Revoke();
        Check(pairing.Authenticate(current.Token, device) is null && saved?.Token is null, "explicit revoke persists");
        time.Now = time.Now.AddMinutes(1);
        for (var attempt = 0; attempt < 10; attempt++) RejectPair(pairing, "x", "bad", device, 401);
        RejectPair(pairing, "x", "bad", device, 429);
        var failsSave = new PairingState(new(1, Guid.NewGuid().ToString("D"), "epoch", null, null), _ => throw new IOException(), time);
        var unsaved = failsSave.Start("192.168.1.2", new string('a', 64));
        try { failsSave.Pair(unsaved.ServerId, unsaved.Secret, device); throw new TestFailure("save failure not surfaced"); }
        catch (IOException) { Check(!failsSave.Status([]).Paired, "failed persistence never authenticates"); }
    }

    private static void TestLanPolicy()
    {
        var local = new LanAddress(IPAddress.Parse("192.168.2.10"), IPAddress.Parse("255.255.255.0"), 9);
        foreach (var address in new[] { "10.0.0.2", "172.16.0.2", "172.31.0.2", "192.168.1.2" })
            Check(LanPolicy.IsPrivateV4(IPAddress.Parse(address)), "RFC1918 allowed");
        foreach (var address in new[] { "8.8.8.8", "127.0.0.1", "169.254.1.2", "172.32.1.2", "172.15.1.2", "192.169.1.2", "0.0.0.0", "::1", "::ffff:192.168.2.2" })
            Check(!LanPolicy.IsPrivateV4(IPAddress.Parse(address)), "public/loopback/link-local/IPv6 denied");
        Check(LanPolicy.AllowsDiscovery(IPAddress.Parse("192.168.2.15"), 9, [local]), "same-interface subnet discovery");
        Check(!LanPolicy.AllowsDiscovery(IPAddress.Parse("192.168.2.15"), 10, [local]), "wrong packet interface denied");
        foreach (var address in new[] { "192.168.3.15", "10.0.0.1", "192.168.2.0", "192.168.2.255", "127.0.0.1", "8.8.8.8" })
            Check(!LanPolicy.AllowsDiscovery(IPAddress.Parse(address), 9, [local]), "off-subnet/network/broadcast discovery denied");
        Check(!LanPolicy.AllowsRemote(IPAddress.Parse("192.168.2.15"), IPAddress.Loopback, [local]), "wrong destination denied");
        Check(LanServer.AcceptDiscovery(Parse("{\"version\":1,\"type\":\"discover\",\"serverId\":\"paired-server\"}"), "paired-server"), "discovery identity");
        Check(!LanServer.AcceptDiscovery(Parse("{\"version\":1,\"type\":\"discover\",\"serverId\":\"other-server\"}"), "paired-server"), "unpaired discovery ignored");
    }

    private static async Task TestConnection()
    {
        using var output = new MemoryStream();
        using var native = new NativeConnection(output);
        var request = native.RequestSyncAsync(Parse("{\"version\":1,\"deviceId\":\"synthetic\",\"request\":{}}"), default);
        output.Position = 0;
        var envelope = NativeEnvelope.Parse((await NativeFrames.ReadAsync(output, default))!.Value);
        Check(envelope.Type == "sync", "host sync direction");
        native.Complete(new NativeEnvelope(envelope.Id, "result", Parse("{\"version\":1,\"type\":\"probe\"}"), true, null));
        Check((await request).GetProperty("type").GetString() == "probe", "correlated sync reply");
        var pending = native.RequestSyncAsync(Parse("{}"), default);
        native.Dispose();
        await Expect<SyncUnavailableException>(async () => await pending, "disconnect rejects in-flight sync");
    }

    private static async Task TestRealProcess()
    {
        Check(LanPolicy.ActiveAddresses().Length > 0, "private LAN required for real TLS self-test");
        var directory = Path.Combine(Path.GetTempPath(), "ValRecall.SyncHost.Tests-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        ValidateTestDirectory(directory);
        var start = new ProcessStartInfo(Environment.ProcessPath!)
        { RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true };
        if (string.Equals(Path.GetFileNameWithoutExtension(Environment.ProcessPath), "dotnet", StringComparison.OrdinalIgnoreCase))
            start.ArgumentList.Add(typeof(SelfTests).Assembly.Location);
        start.ArgumentList.Add("--test-data-dir");
        start.ArgumentList.Add(directory);
        using var process = Process.Start(start) ?? throw new TestFailure("test child startup");
        var errors = process.StandardError.ReadToEndAsync();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(45));
        try
        {
            var input = process.StandardInput.BaseStream;
            var output = process.StandardOutput.BaseStream;
            var before = await Command(input, output, "status", new { }, timeout.Token);
            Check(before.Ok == false, "no listener or state before opt-in init");
            Check(!File.Exists(Path.Combine(directory, "credentials.dat")), "uninitialized host writes no credentials");
            var initialized = await Command(input, output, "init", new { epoch = "synthetic-epoch-one" }, timeout.Token);
            Check(initialized.Ok == true, "real init status");
            var started = await Command(input, output, "pairing.start", new { }, timeout.Token);
            Check(started.Ok == true, "real pairing status");
            var qr = started.Payload.GetProperty("pairing");
            Check(System.Text.RegularExpressions.Regex.IsMatch(qr.GetProperty("expiresAt").GetString()!,
                "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$"), "pairing expiry matches strict TS ISO UTC contract");
            var address = qr.GetProperty("host").GetString()!;
            var fingerprint = qr.GetProperty("fingerprint").GetString()!;
            var secret = qr.GetProperty("secret").GetString()!;
            var serverId = qr.GetProperty("serverId").GetString()!;
            using var client = PinnedClient(address, fingerprint);
            stage = "pinned TLS health";
            using var health = await client.GetAsync("health", timeout.Token);
            Check(health.IsSuccessStatusCode, "real pinned TLS health");
            using var wrongPin = PinnedClient(address, new string('0', 64));
            await Expect<HttpRequestException>(async () => await wrongPin.GetAsync("health", timeout.Token), "certificate pin mismatch denied");
            var deviceId = Guid.NewGuid().ToString("D");
            using var pair = await client.PostAsJsonAsync("pair", new { version = 1, serverId, secret, deviceId }, timeout.Token);
            Check(pair.IsSuccessStatusCode, "real TLS pairing");
            using var pairBody = JsonDocument.Parse(await pair.Content.ReadAsStringAsync(timeout.Token));
            var token = pairBody.RootElement.GetProperty("token").GetString()!;
            using var duplicate = await client.PostAsJsonAsync("pair", new { version = 1, serverId, secret, deviceId }, timeout.Token);
            Check(duplicate.StatusCode == HttpStatusCode.Conflict, "pairing secret replay denied");
            using var unauthorized = await client.PostAsJsonAsync("sync", new { version = 1, deviceId, request = new { version = 1, type = "probe" } }, timeout.Token);
            Check(unauthorized.StatusCode == HttpStatusCode.Unauthorized, "missing token denied");
            client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
            stage = "HTTP/stdin sync bridge";
            var sync = client.PostAsJsonAsync("sync", new { version = 1, deviceId, request = new { version = 1, type = "probe" } }, timeout.Token);
            var forwarded = NativeEnvelope.Parse((await NativeFrames.ReadAsync(output, timeout.Token))!.Value);
            Check(forwarded.Type == "sync" && forwarded.Payload.GetProperty("deviceId").GetString() == deviceId, "real HTTP to stdio forwarding");
            await NativeFrames.WriteAsync(input, new { version = 1, id = forwarded.Id, type = "result", ok = true, payload = new { version = 1, type = "probe", message = "synthetic-ok" } }, timeout.Token);
            using var synced = await sync;
            using var syncBody = JsonDocument.Parse(await synced.Content.ReadAsStringAsync(timeout.Token));
            Check(synced.IsSuccessStatusCode && syncBody.RootElement.GetProperty("message").GetString() == "synthetic-ok", "real stdio to HTTP reply");
            stage = "largest HTML-like HTTP/stdin request";
            var largest = LargestDomainRequest();
            var largeBody = JsonSerializer.Serialize(new { version = 1, deviceId, request = largest }, WireJson.TransportOptions);
            using var largeContent = new StringContent(largeBody, Encoding.UTF8, "application/json");
            var largeSync = client.PostAsync("sync", largeContent, timeout.Token);
            var largeForwarded = NativeEnvelope.Parse((await NativeFrames.ReadAsync(output, timeout.Token))!.Value);
            Check(JsonElement.DeepEquals(largeForwarded.Payload.GetProperty("request"), largest), "largest valid request survives real HTTP to native stdio");
            var pageText = string.Concat(Enumerable.Repeat("中文</script>&'", 3000));
            await NativeFrames.WriteAsync(input, new { version = 1, id = largeForwarded.Id, type = "result", ok = true, payload = new { version = 1, type = "page", chunk = pageText } }, timeout.Token);
            using var largeSynced = await largeSync;
            using var largeResponse = JsonDocument.Parse(await largeSynced.Content.ReadAsStringAsync(timeout.Token));
            Check(largeSynced.IsSuccessStatusCode && largeResponse.RootElement.GetProperty("chunk").GetString() == pageText, "HTML-like Unicode page survives real native stdio to HTTP");
            using var origin = new HttpRequestMessage(HttpMethod.Get, "health");
            origin.Headers.Add("Origin", "https://untrusted.example");
            using var deniedOrigin = await client.SendAsync(origin, timeout.Token);
            Check(deniedOrigin.StatusCode == HttpStatusCode.Forbidden, "web origin rejected");
            var rotated = await Command(input, output, "init", new { epoch = "synthetic-epoch-two" }, timeout.Token);
            Check(rotated.Ok == true && !rotated.Payload.GetProperty("paired").GetBoolean(), "real epoch reset");
            using var stale = await client.PostAsJsonAsync("sync", new { version = 1, deviceId, request = new { version = 1, type = "probe" } }, timeout.Token);
            Check(stale.StatusCode == HttpStatusCode.Unauthorized, "old token rejected after restore epoch");
            using var udp = new UdpClient(new IPEndPoint(IPAddress.Parse(address), 0));
            stage = "UDP discovery";
            var discovery = JsonSerializer.SerializeToUtf8Bytes(new { version = 1, type = "discover", serverId });
            await udp.SendAsync(discovery, new IPEndPoint(IPAddress.Parse(address), LanPolicy.Port), timeout.Token);
            var discovered = await udp.ReceiveAsync(timeout.Token);
            using var discoveryJson = JsonDocument.Parse(discovered.Buffer);
            Check(discoveryJson.RootElement.GetProperty("serverId").GetString() == serverId &&
                discoveryJson.RootElement.EnumerateObject().Count() == 4, "UDP discovery contains no keys");
            var persisted = File.ReadAllBytes(Path.Combine(directory, "credentials.dat"));
            Check(!Encoding.UTF8.GetString(persisted).Contains("synthetic-epoch", StringComparison.Ordinal), "credentials encrypted at rest");
            input.Close();
            stage = "EOF process shutdown";
            await process.WaitForExitAsync(timeout.Token);
            Check(process.ExitCode == 0, "EOF closes helper process and listener");
            Check((await errors).Length == 0, "no unsolicited stdout/stderr data");
            using var afterExit = PinnedClient(address, fingerprint);
            await Expect<HttpRequestException>(async () => await afterExit.GetAsync("health", timeout.Token), "no listener after Edge disconnect");
        }
        finally
        {
            if (!process.HasExited) { process.Kill(true); await process.WaitForExitAsync(); }
            // This exact newly-created test directory is validated before recursive cleanup.
            ValidateTestDirectory(directory);
            Directory.Delete(directory, true);
        }
    }

    private static HttpClient PinnedClient(string address, string fingerprint) => new(new HttpClientHandler
    {
        UseProxy = false,
        ServerCertificateCustomValidationCallback = (_, certificate, _, _) => certificate is not null &&
            CryptographicOperations.FixedTimeEquals(SHA256.HashData(certificate.RawData), Convert.FromHexString(fingerprint))
    }) { BaseAddress = new Uri($"https://{address}:{LanPolicy.Port}/"), Timeout = TimeSpan.FromSeconds(8) };

    private static async Task<NativeEnvelope> Command(Stream input, Stream output, string type, object payload, CancellationToken token)
    {
        var id = Guid.NewGuid().ToString("N");
        await NativeFrames.WriteAsync(input, new { version = 1, id, type, payload }, token);
        var response = NativeEnvelope.Parse((await NativeFrames.ReadAsync(output, token))!.Value);
        Check(response.Id == id && response.Type == "result", "command response correlated");
        return response;
    }

    private static void RejectPair(PairingState pairing, string serverId, string secret, string deviceId, int status)
    {
        try { pairing.Pair(serverId, secret, deviceId); throw new TestFailure("pair rejection expected"); }
        catch (PairingException error) { Check(error.Status == status, "pair auth/expiry/replay/rate-limit"); }
    }

    private static JsonElement Parse(string json)
    { using var document = JsonDocument.Parse(json); return document.RootElement.Clone(); }

    private static void Check(bool result, string name)
    { if (!result) throw new TestFailure(name); assertions++; }

    private static async Task Expect<T>(Func<Task> action, string name) where T : Exception
    {
        try { await action(); throw new TestFailure(name); }
        catch (T) { assertions++; }
    }

    private sealed class TestFailure(string message) : Exception(message);
    private sealed class FakeTimeProvider(DateTimeOffset now) : TimeProvider
    {
        internal DateTimeOffset Now { get; set; } = now;
        public override DateTimeOffset GetUtcNow() => Now;
    }
    private sealed class FragmentedStream(byte[] bytes) : MemoryStream(bytes)
    {
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default) =>
            base.ReadAsync(buffer[..Math.Min(1, buffer.Length)], cancellationToken);
    }
}
