using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;

namespace ValRecall.SyncHost;

internal sealed record LanAddress(IPAddress Address, IPAddress Mask, int InterfaceIndex);

internal static class LanPolicy
{
    internal const int Port = 19284;

    internal static bool IsPrivateV4(IPAddress address)
    {
        if (address.AddressFamily != AddressFamily.InterNetwork) return false;
        var bytes = address.GetAddressBytes();
        return bytes[0] == 10 || bytes[0] == 172 && bytes[1] is >= 16 and <= 31 ||
            bytes[0] == 192 && bytes[1] == 168;
    }

    internal static bool IsSameSubnet(IPAddress remote, LanAddress local)
    {
        if (!IsPrivateV4(remote) || !IsPrivateV4(local.Address)) return false;
        var source = remote.GetAddressBytes();
        var own = local.Address.GetAddressBytes();
        var mask = local.Mask.GetAddressBytes();
        if (mask.Length != 4 || mask.All(value => value == 0)) return false;
        var network = true;
        var broadcast = true;
        for (var index = 0; index < 4; index++)
        {
            if ((source[index] & mask[index]) != (own[index] & mask[index])) return false;
            network &= (source[index] & ~mask[index]) == 0;
            broadcast &= (source[index] | mask[index]) == 255;
        }
        return !network && !broadcast;
    }

    internal static bool AllowsRemote(IPAddress? remote, IPAddress? destination, IEnumerable<LanAddress> addresses) =>
        remote is not null && destination is not null &&
        addresses.Any(local => local.Address.Equals(destination) && IsSameSubnet(remote, local));

    internal static bool AllowsDiscovery(IPAddress remote, int interfaceIndex, IEnumerable<LanAddress> addresses) =>
        addresses.Any(local => local.InterfaceIndex == interfaceIndex && IsSameSubnet(remote, local));

    internal static LanAddress[] ActiveAddresses() => NetworkInterface.GetAllNetworkInterfaces()
        .Where(network => network.OperationalStatus == OperationalStatus.Up &&
            network.NetworkInterfaceType is NetworkInterfaceType.Ethernet or NetworkInterfaceType.Wireless80211)
        .SelectMany(network => network.GetIPProperties().UnicastAddresses
            .Where(address => IsPrivateV4(address.Address) && address.IPv4Mask is not null)
            .Select(address => new LanAddress(address.Address, address.IPv4Mask,
                network.GetIPProperties().GetIPv4Properties().Index)))
        .DistinctBy(address => address.Address.ToString()).ToArray();
}
