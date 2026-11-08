/**
 * 链上索引（Envio）配置（第 34 轮，无节点阶段 2C）。
 *
 * 环境变量 VITE_INDEXER_URL：索引器的 GraphQL 端点完整 URL
 *（Envio Cloud 部署后由控制台给出；自托管 envio dev 为
 * http://localhost:8080/v1/graphql 口径）。为空时成交记录只读节点 API，
 * 行为与接入前完全一致（默认形态）；配置后 Envio 为权威展示源，
 * 节点独有成交标「待索引」，冲突以链上事件为准（见 services/tradesDual.ts）。
 */
export const INDEXER_URL: string = (import.meta.env.VITE_INDEXER_URL ?? '')
  .trim()
  .replace(/\/$/, '')

export const INDEXER_ENABLED: boolean = INDEXER_URL.length > 0
