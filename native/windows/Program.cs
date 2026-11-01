using System.Net.NetworkInformation;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Threading.Channels;

namespace ValRecall.SyncHost;

internal static class Program
{
    internal static async Task<int> Main(string[] args)
    {
        if (args.Length == 1 && args[0] == "--self-test") return await SelfTests.RunAsync();
        if (!OperatingSystem.IsWindows()) return 1;
        var testDirectory = args.Length == 2 && args[0] == "--test-data-dir"
            ? SelfTests.ValidateTestDirectory(args[1]) : null;
        var userKey = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(
            Environment.UserDomainName + "\\" + Environment.UserName + testDirectory)))[..24];
        using var mutex = new Mutex(false, "Local\\ValRecall.SyncHost." + userKey);
        bool acquired;
        try { acquired = mutex.WaitOne(0); }
        catch (AbandonedMutexException) { acquired = true; }
        if (!acquired)
        {
            Console.Error.WriteLine("ValRecall sync is already running in another Edge connection.");
            return 1;
        }
        // Never write diagnostic output to stdout: it is exclusively the framed native protocol.
        using var cancellation = new CancellationTokenSource();
        using var native = new NativeConnection(Console.OpenStandardOutput());
        await using var controller = new HostController(native, cancellation.Token,
            testDirectory is null ? null : new ProtectedStore(testDirectory));
        var commands = Channel.CreateBounded<NativeEnvelope>(new BoundedChannelOptions(8)
        { SingleReader = true, SingleWriter = true, FullMode = BoundedChannelFullMode.Wait });
        var worker = ConsumeCommands(commands.Reader, controller, native, cancellation.Token);
        try
        {
            using var input = Console.OpenStandardInput();
            while (await NativeFrames.ReadAsync(input, cancellation.Token) is { } message)
            {
                var envelope = NativeEnvelope.Parse(message);
                if (envelope.Type == "result") { native.Complete(envelope); continue; }
                if (!commands.Writer.TryWrite(envelope))
                    await native.ErrorAsync(envelope.Id, "Local sync is busy. Try again shortly.", cancellation.Token);
            }
            return 0;
        }
        catch (Exception)
        {
            Console.Error.WriteLine("ValRecall sync stopped because its Edge connection was interrupted or invalid.");
            return 1;
        }
        finally
        {
            commands.Writer.TryComplete();
            await cancellation.CancelAsync();
            native.Dispose();
            try { await worker; } catch (Exception) { }
            // Mutex ownership is thread-affine; async continuations need not run on the acquiring thread.
            // Closing the handle releases the OS resource when this process exits.
        }
    }

    private static async Task ConsumeCommands(ChannelReader<NativeEnvelope> commands, HostController controller,
        NativeConnection native, CancellationToken cancellation)
    {
        await foreach (var command in commands.ReadAllAsync(cancellation))
        {
            try
            {
                var result = await controller.HandleAsync(command, cancellation);
                await native.ResultAsync(command.Id, result, cancellation);
            }
            catch (PairingException error) { await native.ErrorAsync(command.Id, error.Message, cancellation); }
            catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { break; }
            catch (Exception)
            {
                await native.ErrorAsync(command.Id,
                    "Local sync could not start. Check the helper installation and private Wi-Fi connection.", cancellation);
            }
        }
    }
}

internal sealed class HostController : IAsyncDisposable
{
    private readonly NativeConnection native;
    private readonly CancellationToken cancellation;
    private readonly SemaphoreSlim gate = new(1, 1);
    private ProtectedStore? store;
    private PairingState? pairing;
    private X509Certificate2? certificate;
    private LanAddress[] addresses = [];
    private LanServer? server;
    private bool disposed;

    internal HostController(NativeConnection native, CancellationToken cancellation, ProtectedStore? store = null)
    {
        this.native = native;
        this.cancellation = cancellation;
        this.store = store;
        NetworkChange.NetworkAddressChanged += OnNetworkChanged;
    }

    internal async Task<object> HandleAsync(NativeEnvelope message, CancellationToken cancellation)
    {
        await gate.WaitAsync(cancellation);
        try
        {
            if (message.Type == "init")
            {
                if (!WireJson.HasOnly(message.Payload, "epoch") || WireJson.Text(message.Payload, "epoch") is not { } epoch)
                    throw new PairingException(400, "The computer sync session is invalid.");
                store ??= ProtectedStore.ForCurrentUser();
                pairing ??= new PairingState(store.ReadCredentials(), store.SaveCredentials);
                pairing.Initialize(epoch);
                certificate ??= store.LoadCertificate();
            }
            else if (message.Type is not ("status" or "pairing.start" or "pairing.revoke") ||
                !WireJson.HasOnly(message.Payload))
                throw new PairingException(400, "Unsupported local sync command.");

            if (pairing is null || certificate is null)
                throw new PairingException(409, "Enable phone sync in ValRecall before pairing.");
            await RefreshAddressesAsync(cancellation);
            if (message.Type == "pairing.start")
            {
                if (addresses.Length == 0 || server is null)
                    throw new PairingException(409, "Connect the computer to a private Wi-Fi network first.");
                pairing.Start(addresses[0].Address.ToString(),
                    Convert.ToHexString(SHA256.HashData(certificate.RawData)).ToLowerInvariant());
            }
            else if (message.Type == "pairing.revoke") pairing.Revoke();
            return pairing.Status(addresses.Select(address => address.Address.ToString()).ToArray());
        }
        finally { gate.Release(); }
    }

    private async Task RefreshAddressesAsync(CancellationToken cancellation)
    {
        var current = LanPolicy.ActiveAddresses();
        if (current.SequenceEqual(addresses) && (current.Length == 0 || server is not null)) return;
        if (server is not null) { await server.DisposeAsync(); server = null; }
        addresses = [];
        if (current.Length > 0 && pairing is not null && certificate is not null)
            server = await LanServer.StartAsync(pairing, native, certificate, current, cancellation);
        addresses = current;
    }

    private async void OnNetworkChanged(object? sender, EventArgs arguments)
    {
        try
        {
            await gate.WaitAsync(cancellation);
            try
            {
                if (!disposed && pairing is not null) await RefreshAddressesAsync(cancellation);
            }
            finally { gate.Release(); }
        }
        catch (Exception)
        {
            // A future address event or status command retries; no unbounded retry loop or data logging.
            Console.Error.WriteLine("ValRecall is waiting for its private local network.");
        }
    }

    public async ValueTask DisposeAsync()
    {
        NetworkChange.NetworkAddressChanged -= OnNetworkChanged;
        await gate.WaitAsync();
        try
        {
            disposed = true;
            if (server is not null) await server.DisposeAsync();
            certificate?.Dispose();
        }
        finally { gate.Release(); }
    }
}
