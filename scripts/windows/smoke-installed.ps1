# Verify the installed NSIS host, rather than the staging resource directory.
$ErrorActionPreference = 'Stop'
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$installer = @(Get-ChildItem "$root/apps/desktop/src-tauri/target/release/bundle/nsis/*.exe")
if ($installer.Count -ne 1) { throw 'Expected exactly one NSIS installer' }
$directory = Join-Path $env:RUNNER_TEMP 'studio-installed'
$logs = Join-Path $env:RUNNER_TEMP 'studio-installed-logs'
$install = Start-Process -FilePath $installer[0].FullName -ArgumentList @('/S', "/D=$directory") -Wait -PassThru
if ($install.ExitCode -ne 0) { throw "Installer failed: $($install.ExitCode)" }
$executables = @(Get-ChildItem "$directory/*.exe" | Where-Object { $_.Name -notmatch 'uninstall' })
if ($executables.Count -ne 1) { throw 'Installed desktop executable not found' }
$oldLog = $env:REFLEXION_LOG_DIR
$oldData = $env:REFLEXION_DATA_DIR
$oldPath = $env:PATH
$oldSystem = $env:REFLEXION_SYSTEM_RUNTIME_BIN
$hostProcess = $null
try {
    $env:REFLEXION_LOG_DIR = $logs
    $env:REFLEXION_DATA_DIR = Join-Path $env:RUNNER_TEMP 'studio-installed-data'
    # Remove build tools and system Node from PATH; the installed host must be self-contained.
    $env:PATH = "$env:SystemRoot/System32;$env:SystemRoot"
    $env:REFLEXION_SYSTEM_RUNTIME_BIN = $null
    $hostProcess = Start-Process -FilePath $executables[0].FullName -WorkingDirectory $env:RUNNER_TEMP -PassThru
    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    $logFile = Join-Path $logs 'studio.log'
    do {
        Start-Sleep -Milliseconds 500
        if ($hostProcess.HasExited) { throw "Installed host exited: $($hostProcess.ExitCode)" }
        $text = if (Test-Path $logFile) { Get-Content $logFile -Raw } else { '' }
        if ($text -match 'state -> system-ready') {
            $packaged = [regex]::Escape((Join-Path $directory 'pkg'))
            foreach ($resource in @('node', 'runtime', 'bin')) {
                if ($text -notmatch "$packaged[\\/]$resource[\\/]") { throw "Host did not use installed $resource resource" }
            }
            Write-Output 'PASS installed host and both bundled runtimes are ready'
            return
        }
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'Installed host did not reach system-ready within 45 seconds; inspect studio.log'
} finally {
    if ($hostProcess -and -not $hostProcess.HasExited) {
        & "$env:SystemRoot/System32/taskkill.exe" /PID $hostProcess.Id /T /F | Out-Null
    }
    $env:REFLEXION_LOG_DIR = $oldLog
    $env:REFLEXION_DATA_DIR = $oldData
    $env:PATH = $oldPath
    $env:REFLEXION_SYSTEM_RUNTIME_BIN = $oldSystem
}
