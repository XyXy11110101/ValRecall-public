param(
    [ValidateSet('Debug', 'Release', 'Test')][string]$Configuration = 'Release',
    [switch]$Bootstrap,
    [switch]$RequireExistingSigningKey,
    [string]$OutputDirectory = 'build\android',
    [string]$ToolchainRoot = (Join-Path $env:LOCALAPPDATA 'ValRecall\toolchains')
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$repoRoot = Split-Path -Parent $PSScriptRoot
$androidRoot = Join-Path $repoRoot 'native\android'
$toolRoot = [IO.Path]::GetFullPath($ToolchainRoot)
$sdkRoot = Join-Path $toolRoot 'android-sdk'
$gradleVersion = '9.3.1'
$gradleRoot = Join-Path $toolRoot "gradle-$gradleVersion"
$jdkRoot = Join-Path $toolRoot 'jdk-17'
$outputRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot $OutputDirectory))
$allowedOutput = [IO.Path]::GetFullPath((Join-Path $repoRoot 'build')).TrimEnd('\') + '\'
if (-not $outputRoot.StartsWith($allowedOutput, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Android output must be a child of this project build directory.'
}

function Get-VerifiedArchive([string]$Url, [string]$Destination, [string]$Hash, [string]$Algorithm = 'SHA256') {
    if (-not (Test-Path -LiteralPath $Destination)) {
        Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Destination
    }
    if ((Get-FileHash -LiteralPath $Destination -Algorithm $Algorithm).Hash -ine $Hash) {
        throw "Download checksum mismatch: $Destination. No archive was executed."
    }
}

if ($Bootstrap) {
    New-Item -ItemType Directory -Force -Path $toolRoot | Out-Null
    if (-not (Test-Path -LiteralPath (Join-Path $jdkRoot 'bin\java.exe'))) {
        $jdkRelease = @(Invoke-RestMethod 'https://api.adoptium.net/v3/assets/latest/17/hotspot?architecture=x64&image_type=jdk&os=windows&vendor=eclipse')[0]
        $jdkZip = Join-Path $toolRoot 'temurin17-windows-x64.zip'
        Get-VerifiedArchive $jdkRelease.binary.package.link $jdkZip $jdkRelease.binary.package.checksum
        $jdkExtract = Join-Path $toolRoot 'jdk-extract'
        Expand-Archive -LiteralPath $jdkZip -DestinationPath $jdkExtract -Force
        $jdkSource = @(Get-ChildItem -LiteralPath $jdkExtract -Directory | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'bin\java.exe') })
        if ($jdkSource.Count -ne 1) { throw 'Expected one extracted JDK.' }
        # Copy generated tool files only; never move or delete a user workspace.
        Copy-Item -LiteralPath $jdkSource[0].FullName -Destination $jdkRoot -Recurse
    }
    if (-not (Test-Path -LiteralPath (Join-Path $gradleRoot 'bin\gradle.bat'))) {
        $gradleZip = Join-Path $toolRoot "gradle-$gradleVersion-bin.zip"
        $checksumContent = (Invoke-WebRequest -UseBasicParsing "https://services.gradle.org/distributions/gradle-$gradleVersion-bin.zip.sha256").Content
        $gradleChecksum = if ($checksumContent -is [byte[]]) { [Text.Encoding]::UTF8.GetString($checksumContent).Trim() } else { ([string]$checksumContent).Trim() }
        Get-VerifiedArchive "https://services.gradle.org/distributions/gradle-$gradleVersion-bin.zip" $gradleZip $gradleChecksum
        Expand-Archive -LiteralPath $gradleZip -DestinationPath $toolRoot -Force
    }
    if (-not (Test-Path -LiteralPath (Join-Path $sdkRoot 'cmdline-tools\latest\bin\sdkmanager.bat'))) {
        [xml]$sdkMetadata = (Invoke-WebRequest -UseBasicParsing 'https://dl.google.com/android/repository/repository2-3.xml').Content
        $package = $sdkMetadata.SelectNodes('//*[local-name()="remotePackage"]') | Where-Object { $_.path -eq 'cmdline-tools;latest' }
        $archive = $package.archives.archive | Where-Object { $_.'host-os' -eq 'windows' }
        if (-not $archive) { throw 'Official Android Windows command-line tools metadata was unavailable.' }
        $toolsZip = Join-Path $toolRoot 'android-commandline-tools.zip'
        Get-VerifiedArchive ("https://dl.google.com/android/repository/" + $archive.complete.url) $toolsZip $archive.complete.checksum.InnerText 'SHA1'
        $toolsExtract = Join-Path $toolRoot 'android-tools-extract'
        Expand-Archive -LiteralPath $toolsZip -DestinationPath $toolsExtract -Force
        New-Item -ItemType Directory -Force -Path (Join-Path $sdkRoot 'cmdline-tools') | Out-Null
        Copy-Item -LiteralPath (Join-Path $toolsExtract 'cmdline-tools') -Destination (Join-Path $sdkRoot 'cmdline-tools\latest') -Recurse
    }
}

foreach ($required in @((Join-Path $jdkRoot 'bin\java.exe'), (Join-Path $gradleRoot 'bin\gradle.bat'), (Join-Path $sdkRoot 'cmdline-tools\latest\bin\sdkmanager.bat'))) {
    if (-not (Test-Path -LiteralPath $required)) { throw "Missing tool $required. Run with -Bootstrap to download verified official tools to your user-local directory." }
}

$oldJava = $env:JAVA_HOME
$oldSdk = $env:ANDROID_HOME
$oldGradle = $env:GRADLE_USER_HOME
$oldPath = $env:PATH
$oldBuildRoot = $env:VALRECALL_ANDROID_BUILD_ROOT
try {
    $env:JAVA_HOME = $jdkRoot
    $env:ANDROID_HOME = $sdkRoot
    $env:GRADLE_USER_HOME = Join-Path $toolRoot 'gradle-user-home'
    $env:PATH = (Join-Path $jdkRoot 'bin') + [IO.Path]::PathSeparator + $env:PATH
    $env:VALRECALL_ANDROID_BUILD_ROOT = Join-Path $outputRoot 'gradle'
    if ($Bootstrap) {
        # The official Android CLI supersedes sdkmanager as of tools 23.
        # Disable build-tool metrics explicitly; the APK itself has no telemetry.
        foreach ($sdkPackage in @('platforms/android-37.0', 'build-tools/36.0.0', 'platform-tools')) {
            & (Join-Path $sdkRoot 'cmdline-tools\latest\bin\android.exe') '--no-metrics' "--sdk=$sdkRoot" 'sdk' 'install' $sdkPackage
            if ($LASTEXITCODE -ne 0) { throw "Android SDK installation failed: $sdkPackage" }
        }
    }
    if ($Configuration -eq 'Release') {
        $signingRoot = Join-Path $env:LOCALAPPDATA 'ValRecall\android-signing'
        New-Item -ItemType Directory -Force -Path $signingRoot | Out-Null
        $keyFile = Join-Path $signingRoot 'valrecall-release.p12'
        $passwordFile = Join-Path $signingRoot 'password.dpapi'
        if ($RequireExistingSigningKey -and (-not (Test-Path -LiteralPath $keyFile) -or -not (Test-Path -LiteralPath $passwordFile))) {
            throw 'Original signing material is missing. No replacement will be generated.'
        }
        Add-Type -AssemblyName System.Security
        if ((Test-Path -LiteralPath $keyFile) -and -not (Test-Path -LiteralPath $passwordFile)) {
            throw 'Existing signing key has no recoverable password. Restore the signing credentials; never replace the key for an installed app.'
        }
        if (-not (Test-Path -LiteralPath $passwordFile)) {
            $secretBytes = New-Object byte[] 32
            $random = [Security.Cryptography.RandomNumberGenerator]::Create()
            try { $random.GetBytes($secretBytes) } finally { $random.Dispose() }
            $passwordBytes = [Text.Encoding]::UTF8.GetBytes([Convert]::ToBase64String($secretBytes))
            $protected = [Security.Cryptography.ProtectedData]::Protect($passwordBytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
            [IO.File]::WriteAllBytes($passwordFile, $protected)
        }
        $passwordBytes = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($passwordFile), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
        $env:VALRECALL_ANDROID_STORE_PASSWORD = [Text.Encoding]::UTF8.GetString($passwordBytes)
        $env:VALRECALL_ANDROID_KEY_PASSWORD = $env:VALRECALL_ANDROID_STORE_PASSWORD
        $env:VALRECALL_ANDROID_KEYSTORE = $keyFile
        if (-not (Test-Path -LiteralPath $keyFile)) {
            & (Join-Path $jdkRoot 'bin\keytool.exe') '-genkeypair' '-keystore' $keyFile '-storetype' 'PKCS12' '-alias' 'valrecall' '-keyalg' 'RSA' '-keysize' '3072' '-validity' '10000' '-dname' 'CN=ValRecall private installation' '-storepass:env' 'VALRECALL_ANDROID_STORE_PASSWORD' '-keypass:env' 'VALRECALL_ANDROID_KEY_PASSWORD'
            if ($LASTEXITCODE -ne 0) { throw 'Persistent private APK signing key creation failed.' }
        }
    }
    [string[]]$tasks = if ($Configuration -eq 'Test') { @('testDebugUnitTest') } elseif ($Configuration -eq 'Debug') { @('testDebugUnitTest', 'assembleDebug') } else { @('testDebugUnitTest', 'lintRelease', 'assembleRelease') }
    & (Join-Path $gradleRoot 'bin\gradle.bat') '-p' $androidRoot '--no-daemon' '--console=plain' @tasks
    if ($LASTEXITCODE -ne 0) { throw 'Android build or unit tests failed.' }
    if ($Configuration -ne 'Test') {
        $variant = $Configuration.ToLowerInvariant()
        $apk = Join-Path $env:VALRECALL_ANDROID_BUILD_ROOT "app\outputs\apk\$variant\app-$variant.apk"
        New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
        $outputApk = Join-Path $outputRoot "ValRecall-$variant.apk"
        Copy-Item -LiteralPath $apk -Destination $outputApk -Force
        & (Join-Path $sdkRoot 'build-tools\36.0.0\apksigner.bat') 'verify' '--verbose' $outputApk
        if ($LASTEXITCODE -ne 0) { throw 'APK signature verification failed.' }
        Get-FileHash -LiteralPath $outputApk -Algorithm SHA256
        Write-Output "Built $outputApk. No phone installation was performed."
    }
} finally {
    $env:JAVA_HOME = $oldJava
    $env:ANDROID_HOME = $oldSdk
    $env:GRADLE_USER_HOME = $oldGradle
    $env:PATH = $oldPath
    $env:VALRECALL_ANDROID_BUILD_ROOT = $oldBuildRoot
    Remove-Item Env:VALRECALL_ANDROID_STORE_PASSWORD -ErrorAction SilentlyContinue
    Remove-Item Env:VALRECALL_ANDROID_KEY_PASSWORD -ErrorAction SilentlyContinue
    Remove-Item Env:VALRECALL_ANDROID_KEYSTORE -ErrorAction SilentlyContinue
}
