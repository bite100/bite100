# 依赖升级记录（第十轮，2026-11-07）

Ren 指令「各种依赖要升级到最新版」。三套依赖逐套独立升级、逐套过门禁，互不连坐。
版本数据全部来自实际命令输出（npm view / npm outdated / go list -m -u / git ls-remote）。

## 门禁总览（升级前 → 升级后）

| 套 | 门禁 | 基线 | 升级后 |
|---|---|---|---|
| 合约 | forge build + forge test | 84/84 | ✅ 84/84（桥套件在内，全过） |
| 节点 | go build ./... + go test ./internal/... | build 仅 reputation-updater 历史 stub 错误；internal 全绿 | ✅ 与基线一致（build 仅剩同一 stub 错误；internal 6 个 ok 包全绿） |
| 前端 | npm test + npm run build + 产物地址 grep | 78/78；两链 Settlement 地址都在 | ✅ 78/78；构建成功；两链地址都在；`npm outdated` 清零 |

## A. 合约（contracts/lib/，vendored）

| 包 | 旧版 | 新版 | 处置 |
|---|---|---|---|
| openzeppelin-contracts | 5.5.0 | 5.6.1 | ✅ 已升（git 子模块切 tag v5.6.1，rev 5fd1781） |
| forge-std | 1.14.0 | 1.17.0 | ✅ 已升（官方仓库 v1.17.0，rev f3dae6e） |
| solidity-bytes-utils | 0.8.3 | 0.8.4 | ✅ 已升（npm 官方包整包替换，与第九轮 vendoring 方式一致） |
| @layerzerolabs/oapp-evm | 0.4.1 | 0.4.1 | 已是 npm 最新版，未动 |
| @layerzerolabs/lz-evm-protocol-v2 | 3.0.168 | 3.0.168 | 已是 npm 最新版，未动 |
| @layerzerolabs/lz-evm-messagelib-v2 | 3.0.168 | 3.0.168 | 已是 npm 最新版，未动 |

- foundry.lock 已同步更新 forge-std / openzeppelin-contracts 的 tag 与 rev。
- OAppCore 的 Bit100 vendoring 补丁（OZ 5.x Ownable 显式 initialOwner）：上游 oapp-evm 0.4.1 仍是最新版、补丁仍需要；在 OZ 5.6.1 下构建与测试均通过，补丁保持有效。

提交：debfafe

## B. 节点（node/，Go modules；工具链 go1.27.3，未更换）

直依赖：

| 模块 | 旧版 | 新版 | 处置 |
|---|---|---|---|
| github.com/ethereum/go-ethereum | v1.14.12 | v1.17.10 | ✅ 已升 |
| github.com/libp2p/go-libp2p | v0.39.1 | v0.51.0 | ✅ 已升 |
| github.com/libp2p/go-libp2p-kad-dht | v0.25.2 | v0.43.0 | ✅ 已升（含调用点适配，见下） |
| github.com/libp2p/go-libp2p-pubsub | v0.15.0 | v0.19.0 | ✅ 已升 |
| github.com/multiformats/go-multiaddr | v0.14.0 | v0.16.1 | ✅ 已升 |
| github.com/prometheus/client_golang | v1.20.5 | v1.25.0 | ✅ 已升 |
| golang.org/x/net | v0.46.0 | v0.62.0 | ✅ 已升 |
| modernc.org/sqlite | v1.44.3 | v1.61.1 | ✅ 已升 |
| github.com/gorilla/websocket | v1.5.3 | v1.5.3 | 已是最新版 |
| gopkg.in/yaml.v3 | v3.0.1 | v3.0.1 | 已是最新版 |

适配（仅依赖调用点，未改业务逻辑）：
- kad-dht v0.43 起 `dht.New` 签名由 `New(ctx, host, ...Option)` 改为 `New(host, ...Option)`；`internal/p2p/host.go` 调用点已同步并留注释。

其他：
- go.mod 的 `go` 指令随新依赖要求由 1.24.0 升到 1.26.8；本机工具链 1.27.3 满足，未换工具链。
- 传递依赖经 `go get -u all` 同步抬升一批（如 go-winio v0.6.2→v0.6.4、golang-set/v2 v2.6.0→v2.9.0、fsnotify v1.6.0→v1.10.1、tklauser/go-sysconf、tklauser/numcpus、shirou/gopsutil 等）。
- `go list -m -u all` 仍列出若干可升模块（aws-sdk-go-v2 家族、cockroachdb 家族、Azure SDK、cloudflare-go 等）：均为 go-ethereum / libp2p 的测试依赖图模块，不进入本项目构建与测试产物，版本由上游 go.mod 传递约束，`go get -u all` 在保持模块图一致的前提下无法再抬，本轮保持原版。

### HOLD 清单（Go）

| 模块 | 当前 | 最新 | 卡住原因 / 升级条件 |
|---|---|---|---|
| github.com/quic-go/quic-go | v0.64.1（保持） | v0.65.0 | v0.65.0 将 `http3.HTTPStreamer.HTTPStream` 改为返回 2 个值，webtransport-go 最新版 v0.13.0 尚未跟进，编译直接报错（错误位于 webtransport-go 自身源码，非本项目可适配）。当前版本是 go-libp2p v0.51.0 官方配对版本。升级条件：webtransport-go 发布适配 quic-go v0.65 的新版后，两者一起升。风险：低——v0.64.1 是 libp2p 0.51 的出厂配对组合，QUIC 传输功能不受影响。 |

提交：f861c38

## C. 前端（frontend/，npm；`npm outdated` 已清零，无 HOLD）

运行时依赖：

| 包 | 旧版 | 新版 |
|---|---|---|
| react / react-dom | 18.3.1 | 19.3.1 |
| @mantine/core / @mantine/hooks | 7.17.8 | 9.7.5 |
| @chainsafe/libp2p-noise | 15.1.2 | 17.0.0 |
| @chainsafe/libp2p-yamux | 5.0.4 | 8.0.1 |
| @libp2p/gossipsub | 15.0.12 | 17.2.1 |
| @libp2p/tcp | 7.0.3 | 11.0.32 |
| @libp2p/webrtc | 6.0.11 | 7.0.2 |
| @libp2p/bootstrap | 12.0.11 | 12.0.36 |
| @libp2p/identify | 4.0.10 | 4.1.18 |
| @libp2p/kad-dht | 16.1.3 | 16.4.9 |
| @libp2p/websockets | 10.1.3 | 10.1.25 |
| uint8arrays | 5.1.0 | 6.1.1 |
| react-resizable | 3.1.3 | 4.0.2 |
| ethers | 6.16.0 | 6.17.0 |
| viem | 2.45.2 | 2.57.16 |
| wagmi | 3.4.2 | 3.7.11 |
| libp2p | 3.1.3 | 3.5.1 |
| @tanstack/react-query | 5.90.20 | 5.107.1 |
| @rainbow-me/rainbowkit | 2.2.10 | 2.2.11 |
| dexie | 4.3.0 | 4.4.7 |
| lightweight-charts | 5.1.0 | 5.2.1 |
| react-grid-layout | 2.2.2 | 2.3.0 |
| ws | 8.19.0 | 8.22.1 |

开发依赖：

| 包 | 旧版 | 新版 |
|---|---|---|
| vite | 5.4.21 | 8.3.6 |
| @vitejs/plugin-react | 4.7.0 | 6.2.1 |
| vitest | 2.1.9 | 5.1.0 |
| jsdom | 28.0.0 | 31.0.0 |
| typescript | 5.6.3 | 7.0.2 |
| @types/react / @types/react-dom | 18.3.28 / 18.3.7 | 19.3.0 / 19.3.0 |
| cross-env | 7.0.3 | 10.1.0 |
| @testing-library/dom | 10.4.1 | 10.4.2 |
| @testing-library/react | 16.3.2 | 16.3.3 |
| esbuild | —（新增） | 0.28.2 |

适配（仅一处，非业务代码）：
- 新增 devDependency `esbuild`：Vite 8 中 `transformWithEsbuild` 已弃用且要求 esbuild 独立安装，依赖链上有插件仍在调用它；补装后构建恢复。

注意事项（如实记录）：
- Mantine 跨了 8、9 两个大版本、React 跨 19：类型检查（tsc -b）与 78 个单测全过，无业务代码改动；但门禁无法覆盖浏览器里的实际视觉表现，建议在真实页面上目视确认一次主题/样式细节。

提交：3c4a194

## 总结

- 三套共完成升级：合约 3 项（另 3 项已是最新）、Go 直依赖 8 项（另 2 项已是最新）+ 传递依赖一批、前端 34 项 + 新增 1 项。
- 唯一 HOLD：quic-go（等 webtransport-go 上游跟进），已在上文列明原因与升级条件。
- 全程零业务逻辑改动；仅两处依赖调用点/配置适配（kad-dht 的 dht.New 签名、前端补 esbuild）。
