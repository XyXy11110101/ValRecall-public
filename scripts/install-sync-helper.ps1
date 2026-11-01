[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-p]{32}$')]
    [string]$ExtensionId,
    [string]$SourceDirectory,
    [switch]$AllowPrivateLanFirewall,
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $SourceDirectory) { $SourceDirectory = Join-Path $repoRoot 'build\sync-helper\win-x64' }
$installDirectory = Join-Path $env:LOCALAPPDATA 'ValRecall\Sync\Host'
$manifestPath = Join-Path $installDirectory 'com.valrecall.sync.json'
$registryPath = 'HKCU:\SOFTWARE\Microsoft\Edge\NativeMessagingHosts\com.valrecall.sync'
$executable = Join-Path $installDirectory 'ValRecall.SyncHost.exe'
$ruleNames = @('ValRecall-Local-Sync-TCP', 'ValRecall-Local-Sync-UDP')

if ($Uninstall) {
    if ($PSCmdlet.ShouldProcess('ValRecall native host registration for the current Windows user', 'Unregister')) {
        if (Test-Path -LiteralPath $registryPath) { Remove-Item -LiteralPath $registryPath }
        Write-Output 'Native host unregistered. Helper files and encrypted pairing settings were preserved for recovery.'
    }
    if ($AllowPrivateLanFirewall -and $PSCmdlet.ShouldProcess('The two named ValRecall private-LAN firewall rules', 'Remove')) {
        foreach ($ruleName in $ruleNames) {
            $rule = Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue
            if ($rule) { $rule | Remove-NetFirewallRule }
        }
    }
    return
}

$sourceRoot = (Resolve-Path -LiteralPath $SourceDirectory).Path
$sourceExecutable = Join-Path $sourceRoot 'ValRecall.SyncHost.exe'
if (-not (Test-Path -LiteralPath $sourceExecutable -PathType Leaf)) {
    throw 'Build the Windows helper first with scripts/build-sync-helper.ps1.'
}
if ($sourceRoot.TrimEnd('\') -eq $installDirectory.TrimEnd('\')) { throw 'Source and installation directories must differ.' }
if (Get-Process -Name 'ValRecall.SyncHost' -ErrorAction SilentlyContinue) {
    throw 'Turn off phone sync or close Edge before installing or updating the helper.'
}
if (Test-Path -LiteralPath $manifestPath) {
    $existing = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
    if ($existing.allowed_origins -notcontains "chrome-extension://$ExtensionId/") {
        throw 'An existing registration belongs to another extension ID. Unregister it explicitly before changing IDs.'
    }
}
if ($AllowPrivateLanFirewall) {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Adding private-LAN firewall rules requires an explicitly elevated PowerShell. Run without this switch to register only.'
    }
}
if ($PSCmdlet.ShouldProcess("$installDirectory, HKCU native host, extension $ExtensionId", 'Install current-user ValRecall helper')) {
    New-Item -ItemType Directory -Force -Path $installDirectory | Out-Null
    foreach ($entry in Get-ChildItem -LiteralPath $sourceRoot -File) {
        if ($entry.Extension -notin @('.exe', '.dll', '.json', '.dat', '.txt')) { continue }
        Copy-Item -LiteralPath $entry.FullName -Destination (Join-Path $installDirectory $entry.Name)
    }
    $manifest = [ordered]@{
        name = 'com.valrecall.sync'
        description = 'ValRecall opt-in local Wi-Fi sync'
        path = $executable
        type = 'stdio'
        allowed_origins = @("chrome-extension://$ExtensionId/")
    }
    $json = $manifest | ConvertTo-Json -Depth 4
    [IO.File]::WriteAllText($manifestPath, $json, (New-Object Text.UTF8Encoding($false)))
    New-Item -Path $registryPath -Force | Out-Null
    Set-Item -LiteralPath $registryPath -Value $manifestPath
    Write-Output "Native host registered only for Edge extension $ExtensionId in HKCU."
}
if ($AllowPrivateLanFirewall -and $PSCmdlet.ShouldProcess('TCP/UDP 19284, this executable, Private profile, LocalSubnet only', 'Allow local Wi-Fi sync through Windows Firewall')) {
    $index = 0
    foreach ($protocol in @('TCP', 'UDP')) {
        $name = $ruleNames[$index]
        $index++
        if (Get-NetFirewallRule -Name $name -ErrorAction SilentlyContinue) {
            throw "Firewall rule $name already exists; inspect it before replacing anything."
        }
        New-NetFirewallRule -Name $name -DisplayName "ValRecall local sync ($protocol)" -Direction Inbound -Action Allow -Profile Private -Program $executable -Protocol $protocol -LocalPort 19284 -RemoteAddress LocalSubnet -EdgeTraversalPolicy Block | Out-Null
    }
    Write-Output 'Added only Private-profile, LocalSubnet, program-scoped TCP/UDP rules on port 19284.'
} elseif (-not $AllowPrivateLanFirewall) {
    Write-Output 'Firewall unchanged. Incoming phone connections remain subject to the existing Windows Firewall rules.'
}
Write-Output 'Nothing was started automatically. Open Edge and explicitly enable phone sync in ValRecall.'
