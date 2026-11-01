using System.Security.Cryptography;
using System.Text;
using System.Globalization;

namespace ValRecall.SyncHost;

internal sealed record PairingQr(int Version, string ServerId, string Host, int Port,
    string Fingerprint, string Secret, string ExpiresAt);
internal sealed record PairingResult(int Version, string DeviceId, string Token, string Epoch);
internal sealed record HostStatus(string ServerId, bool Paired, string[] Addresses, int Port, PairingQr? Pairing);
internal sealed record SavedCredentials(int Version, string ServerId, string Epoch, string? DeviceId, string? Token);

internal sealed class PairingException(int status, string message) : Exception(message)
{
    internal int Status { get; } = status;
}

internal sealed class PairingState
{
    private readonly object gate = new();
    private readonly TimeProvider clock;
    private readonly Action<SavedCredentials> save;
    private SavedCredentials credentials;
    private PairingQr? qr;
    private DateTimeOffset windowStart;
    private int attempts;
    private long generation;

    internal PairingState(SavedCredentials initial, Action<SavedCredentials> save, TimeProvider? clock = null)
    {
        credentials = initial;
        this.save = save;
        this.clock = clock ?? TimeProvider.System;
        windowStart = this.clock.GetUtcNow();
    }

    internal string ServerId => credentials.ServerId;

    internal void Initialize(string epoch)
    {
        lock (gate)
        {
            if (credentials.Epoch == epoch) return;
            var next = credentials with { Epoch = epoch, DeviceId = null, Token = null };
            save(next);
            credentials = next;
            qr = null;
            generation++;
        }
    }

    internal HostStatus Status(string[] addresses)
    {
        lock (gate)
        {
            if (qr is not null && DateTimeOffset.Parse(qr.ExpiresAt) <= clock.GetUtcNow()) qr = null;
            return new HostStatus(ServerId, credentials.DeviceId is not null, addresses, LanPolicy.Port, qr);
        }
    }

    internal PairingQr Start(string address, string fingerprint)
    {
        lock (gate)
        {
            if (credentials.DeviceId is not null)
                throw new PairingException(409, "Revoke the paired phone before pairing another device.");
            qr = new PairingQr(1, ServerId, address, LanPolicy.Port, fingerprint,
                RandomToken(), clock.GetUtcNow().AddMinutes(5).UtcDateTime.ToString(
                    "yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture));
            return qr;
        }
    }

    internal PairingResult Pair(string serverId, string secret, string deviceId)
    {
        lock (gate)
        {
            RateLimit();
            if (credentials.DeviceId is not null)
                throw new PairingException(409, "A phone is already paired. Revoke it on the computer to pair again.");
            if (!Guid.TryParseExact(deviceId, "D", out _) || qr is null || serverId != ServerId ||
                DateTimeOffset.Parse(qr.ExpiresAt) <= clock.GetUtcNow() || !SecretEquals(secret, qr.Secret))
                throw new PairingException(401, "Pairing expired or was not accepted. Generate a new code on the computer.");
            var next = credentials with { DeviceId = deviceId, Token = RandomToken() };
            save(next);
            credentials = next;
            qr = null;
            generation++;
            return new PairingResult(1, deviceId, next.Token!, next.Epoch);
        }
    }

    internal void Revoke()
    {
        lock (gate)
        {
            var next = credentials with { DeviceId = null, Token = null };
            save(next);
            credentials = next;
            qr = null;
            generation++;
        }
    }

    internal long? Authenticate(string? token, string deviceId)
    {
        lock (gate)
            return credentials.DeviceId == deviceId && token is not null && credentials.Token is { } stored &&
                SecretEquals(token, stored) ? generation : null;
    }

    internal bool SessionCurrent(long session)
    {
        lock (gate) return generation == session && credentials.DeviceId is not null;
    }

    private void RateLimit()
    {
        var now = clock.GetUtcNow();
        if (now - windowStart >= TimeSpan.FromMinutes(1)) { windowStart = now; attempts = 0; }
        if (++attempts > 10) throw new PairingException(429, "Too many pairing attempts. Wait one minute and try again.");
    }

    internal static string RandomToken() => Convert.ToBase64String(RandomNumberGenerator.GetBytes(32))
        .TrimEnd('=').Replace('+', '-').Replace('/', '_');

    internal static bool SecretEquals(string supplied, string expected)
    {
        if (supplied.Length != 43 || expected.Length != 43) return false;
        return CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(supplied), Encoding.ASCII.GetBytes(expected));
    }
}
