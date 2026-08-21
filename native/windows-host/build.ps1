$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$build = Join-Path $root 'build'
$output = Join-Path (Split-Path -Parent $root) 'windows-x64'
$h264Output = Join-Path $output 'dsh-remote-host-h264.exe'
$cmakeCommand = Get-Command cmake -ErrorAction SilentlyContinue
$cmakePath = if ($cmakeCommand) { $cmakeCommand.Source } else {
  $candidates = @(
    "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe",
    "${env:ProgramFiles}\Microsoft Visual Studio\2022\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe"
  )
  $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}
if (-not $cmakePath) { throw 'cmake.exe was not found. Install CMake or the Visual Studio CMake component.' }
& $cmakePath -S $root -B $build -A x64
if ($LASTEXITCODE -ne 0) { throw "native CMake configure failed: $LASTEXITCODE" }
& $cmakePath --build $build --config Release
if ($LASTEXITCODE -ne 0) { throw "native helper build failed: $LASTEXITCODE" }
New-Item -ItemType Directory -Force -Path $output | Out-Null
$built = Join-Path $build 'Release\dsh-remote-host.exe'
Copy-Item -Force $built $h264Output
try {
  Copy-Item -Force $built (Join-Path $output 'dsh-remote-host.exe')
} catch {
  Write-Warning "Legacy helper is in use; left it unchanged. The H.264 helper was written to $h264Output"
}
Write-Output "Built $h264Output"
