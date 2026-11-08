/**
 * 无节点阶段 4（停节点总验收）运行器 — CLI 入口。
 *
 * 用法（先 `node build.mjs` 打包，再以 node 跑 dist/stage4.mjs）：
 *   node dist/stage4.mjs check   只读预检：中继健康/索引器/链配置/
 *                                钱包余额/节点本地端口状态，全部只读，
 *                                不签单、不发交易（Phase P 即可跑）
 *   node dist/stage4.mjs run     正式验收运行：纯无节点路径整夜跑
 *                                （Phase X，主聊天发 go 后才可执行；
 *                                前置 = 节点已按 RUNBOOK 停机、前端
 *                                已切无节点模式、S4_INDEXER_URL 为
 *                                切换后的现行端点）
 *
 * 配置全走环境变量（见 README）：S4_KEYS_DIR / S4_RELAY_URL /
 * S4_INDEXER_URL / S4_NODE_URL_<chainId> / S4_DIR / S4_INTERVAL_SEC /
 * S4_MAX_HOURS / S4_TARGET_PER_CHAIN / S4_SUBMIT_GAP_MS /
 * S4_INDEXER_GRACE_SEC。密钥只经 engine 从 S4_KEYS_DIR 读取，
 * 本文件不接触密钥材料。
 */
import { loadConfig, runCheck, runStage4, log } from './engine'

const mode = process.argv[2]
const cfg = loadConfig()

if (mode === 'check') {
  process.exitCode = await runCheck(cfg)
} else if (mode === 'run') {
  if (!cfg.indexerUrl) {
    console.error(
      '[stage4] 拒绝启动 run：S4_INDEXER_URL 未设置——索引器探针是零容忍线的一部分，端点必须在 go 时给全',
    )
    process.exitCode = 2
  } else {
    log(`run 模式启动（Phase X）：outDir=${cfg.outDir}`)
    process.exitCode = await runStage4(cfg)
  }
} else {
  console.error('用法: node dist/stage4.mjs <check|run>')
  process.exitCode = 2
}
