# 比特100 开发环境快速启动脚本（Windows）

Write-Host "🚀 启动 比特100 开发环境..." -ForegroundColor Green

# 检查 Docker
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Host "❌ 请先安装 Docker Desktop" -ForegroundColor Red
    exit 1
}

# 检查 docker-compose
if (-not (Get-Command docker-compose -ErrorAction SilentlyContinue)) {
    Write-Host "❌ 请先安装 docker-compose" -ForegroundColor Red
    exit 1
}

# 创建配置文件（如果不存在）
if (-not (Test-Path node/config.yaml)) {
    Write-Host "📝 创建节点配置文件..." -ForegroundColor Yellow
    Copy-Item node/config.example.yaml node/config.yaml
}

if (-not (Test-Path frontend/.env)) {
    Write-Host "📝 创建前端配置文件..." -ForegroundColor Yellow
    Copy-Item frontend/.env.example frontend/.env
}

# 启动服务
Write-Host "🐳 启动 Docker 容器..." -ForegroundColor Cyan
docker-compose up --build -d

Write-Host ""
Write-Host "✅ 服务已启动！" -ForegroundColor Green
Write-Host ""
Write-Host "📍 访问地址：" -ForegroundColor Yellow
Write-Host "   前端：        http://localhost:5173"
Write-Host "   撮合节点 API： http://localhost:8080"
Write-Host "   存储节点 API： http://localhost:8081"
Write-Host "   WebSocket：   ws://localhost:8080/ws"
Write-Host ""
Write-Host "📊 查看日志：" -ForegroundColor Yellow
Write-Host "   docker-compose logs -f"
Write-Host ""
Write-Host "🛑 停止服务：" -ForegroundColor Yellow
Write-Host "   docker-compose down"
Write-Host ""
