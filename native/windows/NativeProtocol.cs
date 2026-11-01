using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.Encodings.Web;

namespace ValRecall.SyncHost;

internal static class WireJson
{
    internal static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web)
    {
        MaxDepth = 48,
        PropertyNameCaseInsensitive = false,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    // These bytes are JSON on native stdio / application/json, never embedded in HTML.
    // Avoid expanding legitimate 256 KiB task text sixfold before applying the frame cap.
    internal static readonly JsonSerializerOptions TransportOptions = new(Options)
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
    };

    internal static bool HasOnly(JsonElement value, params string[] names) =>
        value.ValueKind == JsonValueKind.Object &&
        value.EnumerateObject().Select(property => property.Name).Distinct().Count() ==
        value.EnumerateObject().Count() &&
        value.EnumerateObject().All(property => names.Contains(property.Name, StringComparer.Ordinal));

    internal static string? Text(JsonElement value, string name, int max = 128) =>
        value.ValueKind == JsonValueKind.Object && value.TryGetProperty(name, out var property) &&
        property.ValueKind == JsonValueKind.String && property.GetString() is { Length: > 0 } text &&
        text.Length <= max ? text : null;

    internal static bool VersionOne(JsonElement value) =>
        value.ValueKind == JsonValueKind.Object && value.TryGetProperty("version", out var version) &&
        version.ValueKind == JsonValueKind.Number && version.TryGetInt32(out var number) && number == 1;
}

internal sealed record NativeEnvelope(string Id, string Type, JsonElement Payload, bool? Ok, string? Error)
{
    internal static NativeEnvelope Parse(JsonElement value)
    {
        if (!WireJson.HasOnly(value, "version", "id", "type", "payload", "ok", "error") ||
            !WireJson.VersionOne(value) || WireJson.Text(value, "id") is not { } id ||
            WireJson.Text(value, "type", 40) is not { } type)
            throw new InvalidDataException("Invalid native message.");
        var payload = value.TryGetProperty("payload", out var found) ? found.Clone() : default;
        bool? ok = value.TryGetProperty("ok", out var okElement) &&
            okElement.ValueKind is JsonValueKind.True or JsonValueKind.False ? okElement.GetBoolean() : null;
        return new NativeEnvelope(id, type, payload, ok, WireJson.Text(value, "error", 500));
    }
}

internal static class NativeFrames
{
    // Chrome limits messages sent by native hosts to 1 MiB. Reserve JSON envelope space.
    internal const int MaxBytes = 1_000_000;

    internal static async Task<JsonElement?> ReadAsync(Stream input, CancellationToken cancellation)
    {
        var header = new byte[4];
        var first = await input.ReadAsync(header.AsMemory(0, 4), cancellation);
        if (first == 0) return null;
        await ReadRemainingAsync(input, header, first, cancellation);
        var length = BinaryPrimitives.ReadUInt32LittleEndian(header);
        if (length == 0 || length > MaxBytes) throw new InvalidDataException("Native message too large.");
        var bytes = new byte[checked((int)length)];
        await ReadRemainingAsync(input, bytes, 0, cancellation);
        using var document = JsonDocument.Parse(bytes, new JsonDocumentOptions { MaxDepth = 48 });
        return document.RootElement.Clone();
    }

    internal static async Task WriteAsync(Stream output, object message, CancellationToken cancellation)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(message, WireJson.TransportOptions);
        if (bytes.Length > MaxBytes) throw new InvalidDataException("Native response too large.");
        var header = new byte[4];
        BinaryPrimitives.WriteUInt32LittleEndian(header, checked((uint)bytes.Length));
        await output.WriteAsync(header, cancellation);
        await output.WriteAsync(bytes, cancellation);
        await output.FlushAsync(cancellation);
    }

    private static async Task ReadRemainingAsync(Stream input, byte[] buffer, int offset, CancellationToken cancellation)
    {
        while (offset < buffer.Length)
        {
            var read = await input.ReadAsync(buffer.AsMemory(offset), cancellation);
            if (read == 0) throw new EndOfStreamException("Incomplete native message.");
            offset += read;
        }
    }
}

internal sealed class NativeConnection(Stream output) : IDisposable
{
    private readonly SemaphoreSlim writeLock = new(1, 1);
    private readonly ConcurrentDictionary<string, TaskCompletionSource<NativeEnvelope>> pending = new();
    private bool closed;

    internal async Task SendAsync(object message, CancellationToken cancellation)
    {
        await writeLock.WaitAsync(cancellation);
        try
        {
            if (closed) throw new IOException("Edge connection closed.");
            await NativeFrames.WriteAsync(output, message, cancellation);
        }
        finally { writeLock.Release(); }
    }

    internal Task ResultAsync(string id, object payload, CancellationToken cancellation) =>
        SendAsync(new { version = 1, id, type = "result", ok = true, payload }, cancellation);

    internal Task ErrorAsync(string id, string error, CancellationToken cancellation) =>
        SendAsync(new { version = 1, id, type = "result", ok = false, error }, cancellation);

    internal bool Complete(NativeEnvelope message) => message.Type == "result" &&
        pending.TryRemove(message.Id, out var completion) && completion.TrySetResult(message);

    internal async Task<JsonElement> RequestSyncAsync(JsonElement payload, CancellationToken cancellation)
    {
        if (closed || pending.Count >= 4) throw new SyncUnavailableException();
        var id = "host-" + Guid.NewGuid().ToString("N");
        var completion = new TaskCompletionSource<NativeEnvelope>(TaskCreationOptions.RunContinuationsAsynchronously);
        if (!pending.TryAdd(id, completion)) throw new SyncUnavailableException();
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        timeout.CancelAfter(TimeSpan.FromSeconds(30));
        try
        {
            await SendAsync(new { version = 1, id, type = "sync", payload }, timeout.Token);
            var result = await completion.Task.WaitAsync(timeout.Token);
            if (result.Ok != true || result.Payload.ValueKind == JsonValueKind.Undefined)
                throw new SyncUnavailableException();
            return result.Payload;
        }
        finally { pending.TryRemove(id, out _); }
    }

    public void Dispose()
    {
        closed = true;
        foreach (var entry in pending)
            if (pending.TryRemove(entry.Key, out var completion))
                completion.TrySetException(new SyncUnavailableException());
        // Active writers release this semaphore during shutdown; do not dispose it early.
    }
}

internal sealed class SyncUnavailableException : Exception;
