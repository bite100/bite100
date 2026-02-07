# P2P 节点

Phase 2 节点软件：libp2p 网络接入，支持存储节点与中继节点。

## M1：两节点连通

### 运行方式（任选其一，无需额外安装）

**方式一：Docker（推荐，无需 Go）**

```bash
cd node
docker build -t p2p-node .
docker run -it --rm -p 4001:4001 p2p-node
```

**方式二：一键脚本（自动选 Docker 或 Go）**

```powershell
# Windows
cd node
.\run.ps1
```

```bash
# Linux / macOS
cd node
chmod +x run.sh && ./run.sh
```

**方式三：Go 源码**

```bash
cd node
go mod tidy   # 首次运行需拉取依赖
go run ./cmd/node
```

**终端 1（节点 A，监听）**：任选上面一种方式启动。

输出示例：
```
节点启动 | PeerID: Qm...
  监听: /ip4/0.0.0.0/tcp/4001/p2p/Qm...
```

**终端 2（节点 B，连接）**：

把**节点 A** 输出里整行「监听」地址复制下来，把其中的 `0.0.0.0` 改成 `127.0.0.1`（本机时）。**同机测试**时节点 B 必须加 `-port 4002` 避免端口冲突。例如节点 A 显示：

```
监听: /ip4/127.0.0.1/tcp/4001/p2p/12D3KooWAbc123...
```

则节点 B 执行（把下面的地址换成你复制的、并把 0.0.0.0→127.0.0.1）：

```powershell
.\run.ps1 -port 4002 -connect /ip4/127.0.0.1/tcp/4001/p2p/12D3KooWAbc123...
```

**注意**：`12D3KooWAbc123...` 要换成节点 A 实际打印的 PeerID，不要写成字面量 `<PeerID>`。

### 验收

- 节点 A 日志出现 `已连接对等节点: <PeerID>`
- 节点 B 日志出现 `已连接到远程节点，当前连接数: 1`
- 按 Ctrl+C 可正常退出

### 配置

参见 `config.example.yaml`（M2 起将支持从文件加载）。

## 项目结构

```
node/
├── cmd/node/        # 入口
├── internal/        # 内部包（M2 起）
├── config.example.yaml
├── go.mod
└── README.md
```

## 参考

- [Phase2 设计文档](../docs/Phase2-设计文档.md)
- [go-libp2p](https://github.com/libp2p/go-libp2p)
