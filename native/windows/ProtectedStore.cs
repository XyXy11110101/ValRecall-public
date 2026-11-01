using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;

namespace ValRecall.SyncHost;

internal sealed class ProtectedStore
{
    private readonly string directory;
    private const int MaxProtectedBytes = 128 * 1024;

    internal ProtectedStore(string directory) => this.directory = directory;

    internal static ProtectedStore ForCurrentUser() => new(Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ValRecall", "Sync"));

    internal SavedCredentials ReadCredentials()
    {
        var bytes = Read("credentials.dat");
        if (bytes is null) return new SavedCredentials(1, Guid.NewGuid().ToString("D"), "", null, null);
        try
        {
            var saved = JsonSerializer.Deserialize<SavedCredentials>(bytes, WireJson.Options);
            if (saved is null || saved.Version != 1 || !Guid.TryParseExact(saved.ServerId, "D", out _) ||
                saved.Epoch.Length > 128 || (saved.DeviceId is null) != (saved.Token is null) ||
                saved.DeviceId is { } device && !Guid.TryParseExact(device, "D", out _) ||
                saved.Token is { Length: not 43 })
                throw new InvalidDataException("Local pairing settings are invalid.");
            return saved;
        }
        finally { CryptographicOperations.ZeroMemory(bytes); }
    }

    internal void SaveCredentials(SavedCredentials credentials)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(credentials, WireJson.Options);
        try { Write("credentials.dat", bytes); }
        finally { CryptographicOperations.ZeroMemory(bytes); }
    }

    internal X509Certificate2 LoadCertificate()
    {
        var bytes = Read("certificate.dat");
        if (bytes is not null)
        {
            try
            {
                // Schannel needs a Windows key handle; UserKeySet uses user-protected key storage.
                // Do not persist or trust a certificate in the Windows certificate store.
                var stored = X509CertificateLoader.LoadPkcs12(bytes, null, X509KeyStorageFlags.UserKeySet);
                if (!stored.HasPrivateKey || stored.NotAfter.ToUniversalTime() <= DateTime.UtcNow)
                {
                    stored.Dispose();
                    // Never silently rotate a certificate that the phone has pinned.
                    throw new InvalidDataException("The local sync certificate requires an explicit pairing reset.");
                }
                return stored;
            }
            finally { CryptographicOperations.ZeroMemory(bytes); }
        }
        using var key = RSA.Create(3072);
        var request = new CertificateRequest("CN=ValRecall local sync", key, HashAlgorithmName.SHA256,
            RSASignaturePadding.Pkcs1);
        request.CertificateExtensions.Add(new X509BasicConstraintsExtension(false, false, 0, true));
        request.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.DigitalSignature |
            X509KeyUsageFlags.KeyEncipherment, true));
        request.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension(
            new OidCollection { new("1.3.6.1.5.5.7.3.1") }, false));
        using var created = request.CreateSelfSigned(DateTimeOffset.UtcNow.AddMinutes(-5), DateTimeOffset.UtcNow.AddYears(5));
        var exported = created.Export(X509ContentType.Pfx);
        try
        {
            Write("certificate.dat", exported);
            return X509CertificateLoader.LoadPkcs12(exported, null, X509KeyStorageFlags.UserKeySet);
        }
        finally { CryptographicOperations.ZeroMemory(exported); }
    }

    private byte[]? Read(string name)
    {
        var path = Path.Combine(directory, name);
        if (!File.Exists(path)) return null;
        var info = new FileInfo(path);
        if (info.Length is <= 0 or > MaxProtectedBytes) throw new InvalidDataException("Invalid protected settings.");
        var bytes = File.ReadAllBytes(path);
        try { return Dpapi.Unprotect(bytes); }
        finally { CryptographicOperations.ZeroMemory(bytes); }
    }

    private void Write(string name, byte[] bytes)
    {
        Directory.CreateDirectory(directory);
        var path = Path.Combine(directory, name);
        var temporary = Path.Combine(directory, name + ".pending-" + Guid.NewGuid().ToString("N"));
        var protectedBytes = Dpapi.Protect(bytes);
        try
        {
            using (var file = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write,
                FileShare.None, 4096, FileOptions.WriteThrough))
            {
                file.Write(protectedBytes);
                file.Flush(true);
            }
            File.Move(temporary, path, true);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(protectedBytes);
            if (File.Exists(temporary)) File.Delete(temporary);
        }
    }
}

internal static class Dpapi
{
    [StructLayout(LayoutKind.Sequential)]
    private struct DataBlob { internal int Length; internal IntPtr Pointer; }

    [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CryptProtectData(ref DataBlob input, string? description, IntPtr entropy,
        IntPtr reserved, IntPtr prompt, int flags, out DataBlob output);

    [DllImport("crypt32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CryptUnprotectData(ref DataBlob input, IntPtr description, IntPtr entropy,
        IntPtr reserved, IntPtr prompt, int flags, out DataBlob output);

    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);

    internal static byte[] Protect(byte[] bytes) => Transform(bytes, true);
    internal static byte[] Unprotect(byte[] bytes) => Transform(bytes, false);

    private static byte[] Transform(byte[] bytes, bool protect)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        var input = new DataBlob { Length = bytes.Length, Pointer = Marshal.AllocHGlobal(bytes.Length) };
        var output = new DataBlob();
        try
        {
            Marshal.Copy(bytes, 0, input.Pointer, bytes.Length);
            var success = protect
                ? CryptProtectData(ref input, "ValRecall local sync", IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 1, out output)
                : CryptUnprotectData(ref input, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 1, out output);
            if (!success) throw new Win32Exception(Marshal.GetLastWin32Error(), "Protected local settings could not be accessed.");
            var result = new byte[output.Length];
            Marshal.Copy(output.Pointer, result, 0, result.Length);
            return result;
        }
        finally
        {
            ClearNative(input.Pointer, input.Length);
            Marshal.FreeHGlobal(input.Pointer);
            if (output.Pointer != IntPtr.Zero)
            {
                ClearNative(output.Pointer, output.Length);
                LocalFree(output.Pointer);
            }
        }
    }

    private static void ClearNative(IntPtr pointer, int length)
    {
        if (pointer == IntPtr.Zero || length <= 0) return;
        Marshal.Copy(new byte[length], 0, pointer, length);
    }
}
