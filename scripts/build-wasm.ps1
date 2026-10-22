# Rebuild wasm/joydb.wasm and refresh the Go WASM runtime.
# Requires a sibling checkout of JoyDb at ../../../JoyDb (relative to wasm/src).

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root 'wasm\src'
$joydb = Join-Path (Split-Path -Parent $root) 'JoyDb'

if (-not (Test-Path $joydb)) {
    throw "JoyDb checkout not found at $joydb. Clone github.com/LeeNgari/JoyDb next to this repo, or update the replace directive in wasm/src/go.mod."
}

Copy-Item (Join-Path $root 'data\content.json') (Join-Path $src 'data\content.json') -Force

Push-Location $src
try {
    $env:GOOS = 'js'
    $env:GOARCH = 'wasm'
    go build -trimpath -ldflags '-s -w' -o (Join-Path $root 'wasm\joydb.wasm') .
} finally {
    Pop-Location
}

$goroot = go env GOROOT
Copy-Item (Join-Path $goroot 'lib\wasm\wasm_exec.js') (Join-Path $root 'wasm\wasm_exec.js') -Force

$size = (Get-Item (Join-Path $root 'wasm\joydb.wasm')).Length
Write-Host ("Built wasm/joydb.wasm ({0:N0} bytes)" -f $size)
