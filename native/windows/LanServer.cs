using System.Net;
using System.Net.Sockets;
using System.Security.Authentication;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;
using Microsoft.AspNetCore.Server.Kestrel.Core;
using BadHttpRequestException = Microsoft.AspNetCore.Http.BadHttpRequestException;

namespace ValRecall.SyncHost;

internal sealed class LanServer : IAsyncDisposable
{
    private readonly WebApplication application;
    private readonly CancellationTokenSource lifetime = new();
    private readonly SemaphoreSlim syncGate = new(1, 1);
    private readonly PairingState pairing;
    private readonly NativeConnection native;
    private readonly LanAddress[] addresses;
    private Socket? discovery;
    private Task? discoveryTask;

    private LanServer(WebApplication application, PairingState pairing, NativeConnection native, LanAddress[] addresses)
    {
        this.application = application;
        this.pairing = pairing;
        this.native = native;
        this.addresses = addresses;
    }

    internal static async Task<LanServer> StartAsync(PairingState pairing, NativeConnection native,
        X509Certificate2 certificate, LanAddress[] addresses, CancellationToken cancellation)
    {
        if (addresses.Length == 0) throw new InvalidOperationException("No private LAN address.");
        var builder = WebApplication.CreateSlimBuilder(new WebApplicationOptions
        {
            Args = [], ApplicationName = typeof(LanServer).Assembly.FullName
        });
        builder.Logging.ClearProviders(); // Never emit Kestrel logs into native-messaging stdout.
        builder.WebHost.ConfigureKestrel(options =>
        {
            options.AddServerHeader = false;
            options.Limits.MaxRequestBodySize = 512 * 1024;
            options.Limits.MaxRequestHeadersTotalSize = 8 * 1024;
            options.Limits.MaxConcurrentConnections = 12;
            options.Limits.RequestHeadersTimeout = TimeSpan.FromSeconds(8);
            options.Limits.KeepAliveTimeout = TimeSpan.FromSeconds(15);
            foreach (var address in addresses)
                options.Listen(address.Address, LanPolicy.Port, endpoint =>
                {
                    endpoint.Protocols = HttpProtocols.Http1;
                    endpoint.UseHttps(certificate, https =>
                        https.SslProtocols = SslProtocols.Tls12 | SslProtocols.Tls13);
                });
        });
        var application = builder.Build();
        var server = new LanServer(application, pairing, native, addresses);
        application.Use(async (context, next) =>
        {
            context.Response.Headers.CacheControl = "no-store";
            context.Response.Headers.XContentTypeOptions = "nosniff";
            // APK native requests have no Origin. Websites are never allowed to use this API.
            if (!LanPolicy.AllowsRemote(context.Connection.RemoteIpAddress,
                    context.Connection.LocalIpAddress, addresses) || context.Request.Headers.ContainsKey("Origin"))
            {
                await WriteError(context, 403, "Only the paired phone on this local network may connect.");
                return;
            }
            try { await next(context); }
            catch (OperationCanceledException) when (context.RequestAborted.IsCancellationRequested || server.lifetime.IsCancellationRequested) { }
            catch (BadHttpRequestException) { await WriteError(context, 400, "The request was not accepted."); }
            catch (JsonException) { await WriteError(context, 400, "The request was not accepted."); }
            catch (Exception) { await WriteError(context, 503, "Local sync is temporarily unavailable. Keep Edge open and retry."); }
        });
        application.MapGet("/health", () => Results.Json(new { version = 1, serverId = pairing.ServerId }, WireJson.TransportOptions));
        application.MapPost("/pair", server.PairAsync);
        application.MapPost("/sync", server.SyncAsync);
        try
        {
            await application.StartAsync(cancellation);
            server.StartDiscovery();
            return server;
        }
        catch
        {
            await server.DisposeAsync();
            throw;
        }
    }

    private async Task PairAsync(HttpContext context)
    {
        var body = await ReadBody(context);
        if (!WireJson.HasOnly(body, "version", "serverId", "secret", "deviceId") || !WireJson.VersionOne(body) ||
            WireJson.Text(body, "serverId") is not { } serverId || WireJson.Text(body, "secret", 43) is not { } secret ||
            WireJson.Text(body, "deviceId", 36) is not { } deviceId)
        {
            await WriteError(context, 400, "The pairing request was not accepted.");
            return;
        }
        try { await context.Response.WriteAsJsonAsync(pairing.Pair(serverId, secret, deviceId), WireJson.TransportOptions, context.RequestAborted); }
        catch (PairingException error) { await WriteError(context, error.Status, error.Message); }
    }

    private async Task SyncAsync(HttpContext context)
    {
        var authorization = context.Request.Headers.Authorization;
        if (authorization.Count != 1 || authorization[0] is not { } value ||
            !value.StartsWith("Bearer ", StringComparison.Ordinal) || value.Length != 50)
        {
            await WriteError(context, 401, "Pair this phone with the computer again.");
            return;
        }
        var body = await ReadBody(context);
        if (!WireJson.HasOnly(body, "version", "deviceId", "request") || !WireJson.VersionOne(body) ||
            WireJson.Text(body, "deviceId", 36) is not { } deviceId || !Guid.TryParseExact(deviceId, "D", out _) ||
            !body.TryGetProperty("request", out var request) || request.ValueKind != JsonValueKind.Object)
        {
            await WriteError(context, 400, "The sync request was not accepted.");
            return;
        }
        var session = pairing.Authenticate(value[7..], deviceId);
        if (session is null)
        {
            await WriteError(context, 401, "Pair this phone with the computer again.");
            return;
        }
        if (!await syncGate.WaitAsync(0, context.RequestAborted))
        {
            await WriteError(context, 429, "Another sync is in progress. Retry after it finishes.");
            return;
        }
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(context.RequestAborted, lifetime.Token);
        timeout.CancelAfter(TimeSpan.FromSeconds(35));
        try
        {
            if (!pairing.SessionCurrent(session.Value))
            {
                await WriteError(context, 401, "Pair this phone with the computer again.");
                return;
            }
            var result = await native.RequestSyncAsync(body, timeout.Token);
            if (!pairing.SessionCurrent(session.Value))
            {
                await WriteError(context, 401, "Pairing changed while syncing. Pair the phone again.");
                return;
            }
            await context.Response.WriteAsJsonAsync(result, WireJson.TransportOptions, context.RequestAborted);
        }
        catch (OperationCanceledException) when (!context.RequestAborted.IsCancellationRequested)
        { await WriteError(context, 504, "The computer did not confirm sync in time. Your pending changes can be retried."); }
        catch (SyncUnavailableException)
        { await WriteError(context, 503, "Keep Edge and ValRecall open, then retry sync."); }
        finally { syncGate.Release(); }
    }

    private static async Task<JsonElement> ReadBody(HttpContext context)
    {
        if (!context.Request.HasJsonContentType()) throw new BadHttpRequestException("JSON required.");
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(context.RequestAborted);
        timeout.CancelAfter(TimeSpan.FromSeconds(10));
        using var document = await JsonDocument.ParseAsync(context.Request.Body,
            new JsonDocumentOptions { MaxDepth = 48 }, timeout.Token);
        return document.RootElement.Clone();
    }

    private static Task WriteError(HttpContext context, int status, string error)
    {
        if (context.Response.HasStarted) return Task.CompletedTask;
        context.Response.StatusCode = status;
        return context.Response.WriteAsJsonAsync(new { version = 1, error }, WireJson.TransportOptions, context.RequestAborted);
    }

    private void StartDiscovery()
    {
        discovery = new Socket(AddressFamily.InterNetwork, SocketType.Dgram, ProtocolType.Udp);
        discovery.SetSocketOption(SocketOptionLevel.IP, SocketOptionName.PacketInformation, true);
        discovery.ExclusiveAddressUse = true;
        // UDP broadcast reception requires wildcard binding. Validate packet interface AND source subnet below.
        // TCP is still bound only to the allowlisted RFC1918 addresses.
        discovery.Bind(new IPEndPoint(IPAddress.Any, LanPolicy.Port));
        discoveryTask = DiscoverAsync(discovery, lifetime.Token);
    }

    private async Task DiscoverAsync(Socket socket, CancellationToken cancellation)
    {
        var buffer = new byte[1024];
        var interval = TimeProvider.System.GetTimestamp();
        var replyCount = 0;
        while (!cancellation.IsCancellationRequested)
        {
            SocketReceiveMessageFromResult received;
            try
            {
                received = await socket.ReceiveMessageFromAsync(buffer.AsMemory(), SocketFlags.None,
                    new IPEndPoint(IPAddress.Any, 0), cancellation);
            }
            catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { break; }
            catch (SocketException) when (cancellation.IsCancellationRequested) { break; }
            catch (ObjectDisposedException) when (cancellation.IsCancellationRequested) { break; }
            catch (SocketException) { continue; }
            if (received.RemoteEndPoint is not IPEndPoint remote || received.ReceivedBytes == 0 ||
                received.SocketFlags.HasFlag(SocketFlags.Truncated) ||
                !LanPolicy.AllowsDiscovery(remote.Address, received.PacketInformation.Interface, addresses)) continue;
            if (TimeProvider.System.GetElapsedTime(interval) >= TimeSpan.FromSeconds(1))
            { interval = TimeProvider.System.GetTimestamp(); replyCount = 0; }
            if (replyCount >= 5) continue;
            try
            {
                using var document = JsonDocument.Parse(buffer.AsMemory(0, received.ReceivedBytes),
                    new JsonDocumentOptions { MaxDepth = 4 });
                if (!AcceptDiscovery(document.RootElement, pairing.ServerId)) continue;
                replyCount++;
                var bytes = JsonSerializer.SerializeToUtf8Bytes(new
                { version = 1, type = "discovered", serverId = pairing.ServerId, port = LanPolicy.Port }, WireJson.Options);
                await socket.SendToAsync(bytes, SocketFlags.None, remote, cancellation);
            }
            catch (JsonException) { }
            catch (SocketException) { }
        }
    }

    internal static bool AcceptDiscovery(JsonElement value, string serverId) =>
        WireJson.HasOnly(value, "version", "type", "serverId") && WireJson.VersionOne(value) &&
        WireJson.Text(value, "type") == "discover" && WireJson.Text(value, "serverId") == serverId;

    public async ValueTask DisposeAsync()
    {
        await lifetime.CancelAsync();
        discovery?.Dispose();
        if (discoveryTask is not null)
        {
            try { await discoveryTask; } catch (OperationCanceledException) { }
        }
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        try { await application.StopAsync(deadline.Token); } catch (OperationCanceledException) { }
        await application.DisposeAsync();
        lifetime.Dispose();
    }
}
