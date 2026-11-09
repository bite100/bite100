/**
 * 链上索引（Envio）配置（第 34 轮，无节点阶段 2C）。
 *
 * 环境变量 VITE_INDEXER_URL：索引器的 GraphQL 端点完整 URL
 *（Envio Cloud 部署后由控制台给出；自托管 envio dev 为
 * http://localhost:8080/v1/graphql 口径）。第 51 轮（阶段 5 节点
 * 退役）起索引是成交记录的唯一展示源：为空时成交记录不可用（界面
 * 如实显示，不冒充「暂无成交」）；配置后成交以链上事件为准
 * （见 services/tradesDual.ts）。
 */
export const INDEXER_URL: string = (import.meta.env.VITE_INDEXER_URL ?? '')
  .trim()
  .replace(/\/$/, '')

export const INDEXER_ENABLED: boolean = INDEXER_URL.length > 0
