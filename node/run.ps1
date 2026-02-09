# P2P node launcher - Docker first, else Go
# 领奖地址必填，可通过 -rewardWallet、环境变量 REWARD_WALLET 或配置文件设置；未设置则节点拒绝启动。
# Usage: .\run.ps1 -rewardWallet 0x你的地址 [ -port 4002 ] [ -connect <multiaddr> ] ...
param([string]$rewardWallet = "", [string]$connect = "", [int]$port = 4001, [string]$publishTopic = "", [string]$publishMsg = "", [string]$syncFrom = "", [switch]$seedTrades = $false, [string]$config = "", [switch]$m2AcceptanceLocal = $false)
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
    if ($rewardWallet) { $ra += "-reward-wallet"; $ra += $rewardWallet }
    if ($config) { $ra += "-config"; $ra += $config }
    if ($connect) { $ra += "-connect"; $ra += $connect }
    if ($publishTopic -and $publishMsg) { $ra += "-publish-topic"; $ra += $publishTopic; $ra += "-publish-msg"; $ra += $publishMsg }
    if ($syncFrom) { $ra += "-sync-from"; $ra += $syncFrom }
    if ($seedTrades) { $ra += "-seed-trades" }
    if ($m2AcceptanceLocal) { $ra += "-m2-acceptance-local" }
    docker run -it --rm -p $pm $img @ra
    exit $LASTEXITCODE
}

# 优先使用同目录下已构建的 node.exe（无需 Go），否则用 Go 运行
$nodeExe = Join-Path $nodeDir "node.exe"
if (Test-Path $nodeExe) {
    Push-Location $nodeDir
    $na = @("-port", $port.ToString())
    if ($rewardWallet) { $na += "-reward-wallet"; $na += $rewardWallet }
    if ($config) { $na += "-config"; $na += $config }
    if ($connect) { $na += "-connect"; $na += $connect }
    if ($publishTopic -and $publishMsg) { $na += "-publish-topic"; $na += $publishTopic; $na += "-publish-msg"; $na += $publishMsg }
    if ($syncFrom) { $na += "-sync-from"; $na += $syncFrom }
    if ($seedTrades) { $na += "-seed-trades" }
    if ($m2AcceptanceLocal) { $na += "-m2-acceptance-local" }
    & $nodeExe $na
    $exitCode = $LASTEXITCODE
    Pop-Location
    if ($exitCode -ne 0) { Read-Host "`n节点已退出（请查看上方错误信息），按 Enter 键关闭此窗口" }
    exit $exitCode
}

$go = $null
if (Test-Path "C:\Program Files\Go\bin\go.exe") { $go = "C:\Program Files\Go\bin\go.exe" }
elseif (Get-Command go -ErrorAction SilentlyContinue) { $go = "go" }
if ($go) {
    Push-Location $nodeDir
    $ga = @("run", "./cmd/node", "-port", $port.ToString())
    if ($rewardWallet) { $ga += "-reward-wallet"; $ga += $rewardWallet }
    if ($config) { $ga += "-config"; $ga += $config }
    if ($connect) { $ga += "-connect"; $ga += $connect }
    if ($publishTopic -and $publishMsg) { $ga += "-publish-topic"; $ga += $publishTopic; $ga += "-publish-msg"; $ga += $publishMsg }
    if ($syncFrom) { $ga += "-sync-from"; $ga += $syncFrom }
    if ($seedTrades) { $ga += "-seed-trades" }
    if ($m2AcceptanceLocal) { $ga += "-m2-acceptance-local" }
    & $go $ga
    $exitCode = $LASTEXITCODE
    Pop-Location
    if ($exitCode -ne 0) { Read-Host "`n节点已退出（请查看上方错误信息），按 Enter 键关闭此窗口" }
    exit $exitCode
}

Write-Host "请先构建节点（在 node 目录执行 go build -o node.exe ./cmd/node）或安装 Docker/Go。" -ForegroundColor Red
Read-Host "按 Enter 键关闭此窗口"
exit 1
