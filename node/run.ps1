# P2P node launcher - Docker first, else Go
# Usage: .\run.ps1 [ -port 4002 ] [ -connect <multiaddr> ] [ -publish <topic> <msg> ]
param([string]$connect = "", [int]$port = 4001, [string]$publishTopic = "", [string]$publishMsg = "", [string]$syncFrom = "", [switch]$seedTrades = $false, [string]$config = "", [switch]$m2AcceptanceLocal = $false)
$nodeDir = $PSScriptRoot
if ($connect -and $connect -match '<PeerID>|<\w+>') {
    Write-Host "Error: Replace the placeholder in -connect with the real PeerID from node A." -ForegroundColor Red
    Write-Host "Example: .\run.ps1 -port 4002 -connect /ip4/127.0.0.1/tcp/4001/p2p/12D3KooW..." -ForegroundColor Yellow
    exit 1
}

if (Get-Command docker -ErrorAction SilentlyContinue) {
    $img = "p2p-node"
    $q = docker images -q $img 2>$null
    if (-not $q) {
        Write-Host "Building image $img..."
        docker build -t $img $nodeDir
    }
    $pm = $port.ToString() + ":" + $port.ToString()
    $ra = @("-port", $port.ToString())
    if ($config) { $ra += "-config"; $ra += $config }
    if ($connect) { $ra += "-connect"; $ra += $connect }
    if ($publishTopic -and $publishMsg) { $ra += "-publish-topic"; $ra += $publishTopic; $ra += "-publish-msg"; $ra += $publishMsg }
    if ($syncFrom) { $ra += "-sync-from"; $ra += $syncFrom }
    if ($seedTrades) { $ra += "-seed-trades" }
    if ($m2AcceptanceLocal) { $ra += "-m2-acceptance-local" }
    docker run -it --rm -p $pm $img @ra
    exit $LASTEXITCODE
}

$go = $null
if (Test-Path "C:\Program Files\Go\bin\go.exe") { $go = "C:\Program Files\Go\bin\go.exe" }
elseif (Get-Command go -ErrorAction SilentlyContinue) { $go = "go" }
if ($go) {
    Push-Location $nodeDir
    $ga = @("run", "./cmd/node", "-port", $port.ToString())
    if ($config) { $ga += "-config"; $ga += $config }
    if ($connect) { $ga += "-connect"; $ga += $connect }
    if ($publishTopic -and $publishMsg) { $ga += "-publish-topic"; $ga += $publishTopic; $ga += "-publish-msg"; $ga += $publishMsg }
    if ($syncFrom) { $ga += "-sync-from"; $ga += $syncFrom }
    if ($seedTrades) { $ga += "-seed-trades" }
    if ($m2AcceptanceLocal) { $ga += "-m2-acceptance-local" }
    & $go $ga
    Pop-Location
    exit $LASTEXITCODE
}

Write-Host "Install Docker or Go to run the node." -ForegroundColor Red
exit 1
