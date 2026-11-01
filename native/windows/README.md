# ValRecall Windows local-sync helper

This is an opt-in Edge native messaging host, not a Windows service. It forwards
authenticated local-network requests to the running extension; it never opens an
Edge profile database or calculates rewards. No listener starts before the
extension sends `init`, and closing the native messaging pipe stops the process.

## Build and test

From the repository root, run `scripts/build-sync-helper.ps1` in PowerShell. It
uses the free .NET 10 SDK, runs deterministic unit checks and an isolated temporary
process/TLS integration test, then publishes a self-contained Windows x64 app to
`build/sync-helper/win-x64`. No NuGet library dependency is added. The published
`ValRecall.SyncHost.exe --self-test` also works without an installed .NET runtime.
The integration test requires an active private IPv4 LAN address. It creates only
synthetic test credentials under a validated temporary directory and removes that
directory after shutting down its child process. It does not modify real pairing
settings, extension data, native-host registrations or firewall rules.

The build script supports `-DotnetPath` for an existing SDK and `-SkipTests` for
offline packaging after testing. SDK CLI telemetry and automatic development
certificate creation are disabled by the script.

## Explicit current-user installation

After building, provide the exact ID shown for the installed ValRecall extension
in `edge://extensions` to `scripts/install-sync-helper.ps1 -ExtensionId <id>`.
Use `-WhatIf` to inspect the operation first. It copies the published app to
`%LOCALAPPDATA%/ValRecall/Sync/Host` and registers only
`HKCU/SOFTWARE/Microsoft/Edge/NativeMessagingHosts/com.valrecall.sync`, with one
exact `chrome-extension://<id>/` origin. It neither starts the helper nor enables
sync. The user enables sync inside ValRecall.

The optional `-AllowPrivateLanFirewall` switch requires an explicitly elevated
PowerShell. It creates only program-scoped TCP/UDP port 19284 rules on the Windows
Private profile, with `LocalSubnet` as the remote scope. It never changes the
network profile or allows Public-profile access. Without that switch the firewall
is unchanged. Do not run an elevated installation under a different Windows user.
`-Uninstall` unregisters the native host but preserves files and encrypted pairing
settings; adding the firewall switch removes only the two named ValRecall rules.

## Wire contract

Native messages are UTF-8 JSON prefixed by their unsigned little-endian 32-bit byte
length. The maximum frame is 1,000,000 bytes. Requests are
`{version:1,id,type,payload}` and responses are
`{version:1,id,type:"result",ok:true,payload}` or the same with `ok:false,error`.
The supported extension commands are `init` with `{epoch}`, and `status`,
`pairing.start`, `pairing.revoke` with `{}`. Successful commands return
`{serverId,paired,addresses,port,pairing?}`. Pairing expiry is UTC ISO 8601 with
exactly three fractional digits and a trailing `Z`.

HTTPS listens only on active Ethernet/Wi-Fi RFC1918 IPv4 addresses, port 19284.
Both the source subnet and destination interface are checked. Browser-origin
requests are denied, and there is no CORS exemption. `GET /health` exposes only
`version` and `serverId`. `POST /pair` accepts the short-lived QR secret and a
device UUID, returning a random per-device bearer token and current epoch. Only
one phone is paired; pairing again requires explicit revoke. QR secrets expire
after five minutes, are single-use, and pairing attempts are rate-limited.

`POST /sync` requires that token and the matching device UUID. It accepts
`{version:1,deviceId,request}` and forwards this unchanged in a native envelope
with `type:"sync"`. The extension's matching result payload becomes the HTTP
response. There is one active HTTP sync at a time, a 512 KiB request limit, a
30-second native response deadline and no automatic mutation retries. Epoch
changes revoke credentials, and revoked sessions cannot receive an in-flight
response. Application operation receipts remain the extension's responsibility.

UDP discovery uses port 19284. Broadcast reception uses a wildcard UDP socket,
but each packet must arrive on an allowlisted private interface from the same
private subnet. Loopback, public, link-local, wrong-subnet, network and broadcast
source addresses are rejected. Only a matching `serverId` receives
`{version:1,type:"discovered",serverId,port:19284}`; no token or key is returned.
Replies are limited to five per second. TCP never uses a wildcard bind.

## Local key protection

Certificate/private-key PFX and credentials are encrypted with current-user
Windows DPAPI under `%LOCALAPPDATA%/ValRecall/Sync`. Certificate imports use a
temporary Windows user key handle for Schannel compatibility; no certificate is
installed into a trust store. The Android native client verifies the SHA-256 DER
fingerprint obtained from the pairing QR instead of suppressing a browser warning.
Expired/corrupt certificate state fails closed, rather than silently changing the
pinned identity. No request body, task text, credential or certificate key is
written to logs. Stdout is exclusively the native protocol; failures on stderr
use fixed diagnostic messages.
