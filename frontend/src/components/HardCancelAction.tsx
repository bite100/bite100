/**
 * 第 46 轮：链上撤单入口（阶段 5 前置）——与签名撤单并列的第二个动作。
 *
 * 为什么是并列而非一个按钮自动降级：签名撤单免费、链上撤单要用户
 * 自付 gas；自动降级会在用户没预期时弹出付费交易确认。两个动作
 * 并列、各自标清成本，用户自己选（与本站知情选择口径一致）。
 *
 * 流程：确认弹窗（写明立即解锁、gas 自付、不可撤销）→
 * services/hardCancel 发交易并回读确认 → 成功后 best-effort 走既有
 * 签名撤单移除节点簿面（cancelOrder，失败不回滚链上结果）→ 结果
 * 区分「链上已释放」与「簿面移除待生效」。中继簿没有撤单接口，
 * 簿面记录只能等到期清理，但锁已释放的订单无法成交（合约语义：
 * 结算必须先消费订单锁，见 services/hardCancel.ts 文件头）。
 *
 * 确认弹窗骑 @mantine/core 的 Modal（应用既有 UI 库，main.tsx 已有
 * MantineProvider）；移动端单列、按钮触控高度 ≥44px。
 */
import { useState } from 'react'
import { Button, Group, Modal, Stack, Text } from '@mantine/core'
import type { Signer } from 'ethers'
import type { Order } from '../OrderBookSection'
import { hardCancelOrderOnChain, type HardCancelResult } from '../services/hardCancel'
import { cancelOrder } from '../services/orderService'
import { CHAIN_ID } from '../config'
import { formatError } from '../utils'

export interface HardCancelActionProps {
  order: Order
  account: string | null
  getSigner: () => Promise<Signer | null>
  /** 订单摘要行（由调用面按自己的格式化口径传入） */
  summary: string
  /** 链上处理完成后刷新列表/余额 */
  onSettled?: () => void
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | {
      kind: 'done'
      result: HardCancelResult
      bookRemoval: 'done' | 'pending'
    }
  | { kind: 'error'; message: string }

export function HardCancelAction({ order, account, getSigner, summary, onSettled }: HardCancelActionProps) {
  const [opened, setOpened] = useState(false)
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })

  const close = () => {
    if (phase.kind === 'busy') return
    setOpened(false)
    setPhase({ kind: 'idle' })
  }

  const run = async () => {
    setPhase({ kind: 'busy' })
    try {
      const signer = await getSigner()
      if (!signer) throw new Error('请先连接钱包')
      const result = await hardCancelOrderOnChain({
        order: { ...order, signature: order.signature ?? '' },
        chainId: CHAIN_ID,
        signer,
      })
      // 簿面移除 best-effort：节点可达就走既有签名撤单把节点簿记录
      // 一并移除；失败（节点停机等）不回滚链上结果，如实标待生效。
      let bookRemoval: 'done' | 'pending' = 'pending'
      try {
        await cancelOrder(order.orderId, signer)
        bookRemoval = 'done'
      } catch {
        bookRemoval = 'pending'
      }
      setPhase({ kind: 'done', result, bookRemoval })
      onSettled?.()
    } catch (e) {
      setPhase({ kind: 'error', message: formatError(e) })
    }
  }

  return (
    <>
      <Button
        size="sm"
        variant="light"
        color="dark"
        style={{ minHeight: 44 }}
        onClick={() => setOpened(true)}
      >
        链上撤单
      </Button>
      <Modal opened={opened} onClose={close} title="链上撤单" centered size="sm">
        <Stack gap="sm">
          <Text size="sm">{summary}</Text>
          {phase.kind !== 'done' && (
            <>
              <Text size="sm">
                链上撤单会立即释放这张订单锁住的 Vault 余额，释放后这张订单无法再成交。操作由你的钱包直接发一笔链上交易，需要你自付少量
                gas，交易一旦发出不可撤销。
              </Text>
              <Text size="sm" c="dimmed">
                订单簿里的这条记录可能暂时还在（中继簿没有撤单接口，只能等到期自动清理；节点簿会尽力同步移除），但锁已释放、无法成交，不影响你的余额。
              </Text>
            </>
          )}
          {!account && (
            <Text size="sm" c="red" role="alert">
              钱包未连接，无法执行链上撤单。请先连接钱包。
            </Text>
          )}
          {phase.kind === 'busy' && (
            <Text size="sm" c="dimmed">
              正在等待钱包确认与链上回执，并回读确认锁定状态…
            </Text>
          )}
          {phase.kind === 'error' && (
            <Text size="sm" c="red" role="alert">
              {phase.message}
            </Text>
          )}
          {phase.kind === 'done' && phase.result.status === 'released' && (
            <Text size="sm">
              链上锁定已释放，这张订单无法再成交。
              {phase.bookRemoval === 'done'
                ? '订单簿记录已同步移除。'
                : '订单簿记录移除未完成，会随到期自动清理，不影响你的余额。'}
            </Text>
          )}
          {phase.kind === 'done' && phase.result.status === 'not-locked' && (
            <Text size="sm">
              链上没有这张订单的有效锁定（可能从未落锁，或已释放、已随成交消耗），无需链上撤单；这张订单同样无法再成交。
              {phase.bookRemoval === 'done'
                ? '订单簿记录已同步移除。'
                : '订单簿记录会随到期自动清理。'}
            </Text>
          )}
          <Group grow>
            <Button
              variant="default"
              style={{ minHeight: 44 }}
              onClick={close}
              disabled={phase.kind === 'busy'}
            >
              {phase.kind === 'done' ? '关闭' : '先不撤'}
            </Button>
            {phase.kind !== 'done' && (
              <Button
                color="red"
                style={{ minHeight: 44 }}
                onClick={run}
                loading={phase.kind === 'busy'}
                disabled={!account}
              >
                确认链上撤单
              </Button>
            )}
          </Group>
        </Stack>
      </Modal>
    </>
  )
}
