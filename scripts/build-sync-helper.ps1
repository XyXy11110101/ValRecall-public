[CmdletBinding()]
param(
    [string]$DotnetPath,
    [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$project = Join-Path $repoRoot 'native\windows\ValRecall.SyncHost.csproj'
$publishDirectory = Join-Path $repoRoot 'build\sync-helper\win-x64'

if (-not $DotnetPath) {
    $localSdk = Join-Path $env:LOCALAPPDATA 'ValRecall\Toolchains\dotnet-10.0.401\dotnet.exe'
    if (Test-Path -LiteralPath $localSdk -PathType Leaf) {
        $DotnetPath = $localSdk
    } else {
        $command = Get-Command dotnet -ErrorAction SilentlyContinue
        if ($command) { $DotnetPath = $command.Source }
    }
}
if (-not $DotnetPath -or -not (Test-Path -LiteralPath $DotnetPath -PathType Leaf)) {
    throw '.NET 10 SDK is required. Install the free official Microsoft SDK or pass -DotnetPath.'
}
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:DOTNET_NOLOGO = '1'
$env:DOTNET_GENERATE_ASPNET_CERTIFICATE = 'false'
$sdks = @(& $DotnetPath --list-sdks)
if ($LASTEXITCODE -ne 0 -or -not ($sdks | Where-Object { $_ -match '^10\.' })) {
    throw 'The selected dotnet installation does not contain the .NET 10 SDK.'
}
& $DotnetPath build $project --configuration Release --nologo
if ($LASTEXITCODE -ne 0) { throw 'Sync helper build failed.' }
if (-not $SkipTests) {
    & $DotnetPath run --project $project --configuration Release --no-build -- --self-test
    if ($LASTEXITCODE -ne 0) { throw 'Sync helper self-tests failed. Nothing was installed.' }
}
& $DotnetPath publish $project --configuration Release --runtime win-x64 --self-contained true --output $publishDirectory --nologo
if ($LASTEXITCODE -ne 0) { throw 'Self-contained helper publishing failed.' }
Write-Output "Built Windows x64 helper: $publishDirectory"
Write-Output 'This build does not install a native host, change the firewall, pair a device, or access real ValRecall data.'
