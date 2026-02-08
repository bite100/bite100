# Create Windows installer package script
# Uses win-unpacked directory to create portable package

$ErrorActionPreference = "Stop"

Write-Host "Creating P2P Exchange installer package..."
Write-Host ""

$releaseDir = Join-Path $PSScriptRoot "..\release"
$winUnpacked = Join-Path $releaseDir "win-unpacked"
$outputDir = $releaseDir

# Check win-unpacked directory
if (-not (Test-Path $winUnpacked)) {
    Write-Host "ERROR: win-unpacked directory not found"
    Write-Host "Please run: npm run build:electron first"
    exit 1
}

Write-Host "Found win-unpacked directory"
Write-Host ""

# Check for 7-Zip
$7zipPath = $null
$possiblePaths = @(
    "C:\Program Files\7-Zip\7z.exe",
    "C:\Program Files (x86)\7-Zip\7z.exe",
    "$env:ProgramFiles\7-Zip\7z.exe",
    "$env:ProgramFiles(x86)\7-Zip\7z.exe"
)

foreach ($path in $possiblePaths) {
    if (Test-Path $path) {
        $7zipPath = $path
        break
    }
}

# Create ZIP package
$zipFile = Join-Path $outputDir "P2P-Exchange-Portable.zip"
if (Test-Path $zipFile) {
    Remove-Item $zipFile -Force
}

if ($7zipPath) {
    Write-Host "Creating ZIP package with 7-Zip..."
    & $7zipPath a -tzip "$zipFile" "$winUnpacked\*" | Out-Null
    
    # Create self-extracting EXE
    $sfxFile = Join-Path $outputDir "P2P-Exchange-Portable.exe"
    if (Test-Path $sfxFile) {
        Remove-Item $sfxFile -Force
    }
    
    Write-Host "Creating self-extracting EXE..."
    & $7zipPath a -sfx "$sfxFile" "$winUnpacked\*" | Out-Null
} else {
    Write-Host "7-Zip not found, using PowerShell compression (may be slower)..."
    Compress-Archive -Path "$winUnpacked\*" -DestinationPath $zipFile -Force
}

Write-Host ""
Write-Host "Build complete!"
Write-Host ""
Write-Host "Output files:"
if (Test-Path $zipFile) {
    $zipSize = (Get-Item $zipFile).Length / 1MB
    Write-Host "  ZIP: $zipFile ($([math]::Round($zipSize, 2)) MB)"
}
if ($7zipPath -and (Test-Path (Join-Path $outputDir "P2P-Exchange-Portable.exe"))) {
    $sfxFile = Join-Path $outputDir "P2P-Exchange-Portable.exe"
    $sfxSize = (Get-Item $sfxFile).Length / 1MB
    Write-Host "  EXE: $sfxFile ($([math]::Round($sfxSize, 2)) MB)"
}
Write-Host ""
Write-Host "Usage:"
Write-Host "  - ZIP: Extract and run P2P Exchange.exe"
Write-Host "  - EXE: Double-click to extract and run"
Write-Host ""
