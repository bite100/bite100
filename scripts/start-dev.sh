#!/bin/bash
# 比特100 开发环境快速启动脚本

set -e

echo "🚀 启动 比特100 开发环境..."

# 检查 Docker
if ! command -v docker &> /dev/null; then
    echo "❌ 请先安装 Docker"
    exit 1
fi

# 检查 docker-compose
if ! command -v docker-compose &> /dev/null; then
    echo "❌ 请先安装 docker-compose"
    exit 1
fi

# 创建配置文件（如果不存在）
if [ ! -f node/config.yaml ]; then
    echo "📝 创建节点配置文件..."
    cp node/config.example.yaml node/config.yaml
fi

if [ ! -f frontend/.env ]; then
    echo "📝 创建前端配置文件..."
    cp frontend/.env.example frontend/.env
fi

# 启动服务
echo "🐳 启动 Docker 容器..."
docker-compose up --build -d

echo ""
echo "✅ 服务已启动！"
echo ""
echo "📍 访问地址："
echo "   前端：        http://localhost:5173"
echo "   撮合节点 API： http://localhost:8080"
echo "   存储节点 API： http://localhost:8081"
echo "   WebSocket：   ws://localhost:8080/ws"
echo ""
echo "📊 查看日志："
echo "   docker-compose logs -f"
echo ""
echo "🛑 停止服务："
echo "   docker-compose down"
echo ""
