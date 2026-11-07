import { defineConfig } from 'vitest/config'

/** 纯逻辑单测（node 环境）：订单重建/验签/digest、Nostr 事件组装与 mock 中继发布 */
export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
  },
})
