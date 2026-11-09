/**
 * 第 46 轮：链上撤单入口（阶段 5 前置）——与签名撤单并列的第二个动作。
 * 第 47 轮：文案对齐永久撤单语义（撤单墓碑）与无锁多态呈现。
 *
 * 为什么是并列而非一个按钮自动降级：签名撤单免费、链上撤单要用户
 * 自付 gas；自动降级会在用户没预期时弹出付费交易确认。两个动作
 * 并列、各自标清成本，用户自己选（与本站知情选择口径一致）。
 *
 * 流程：确认弹窗（写明立即解锁、永久作废、gas 自付、不可撤销）→
 * services/hardCancel 发交易并回读确认 → 成功后 best-effort 走既有
 * 签名撤单移除节点簿面（cancelOrder，失败不回滚链上结果）→ 结果
 * 区分「链上已释放」与「簿面移除待生效」。中继簿没有撤单接口，
 * 簿面记录只能等到期清理（结果文案按此收窄，不宣称全簿清除）。
 * 链上语义（第 47 轮合约）：releaseOrderLock 置撤单墓碑，该单永久
 * 作废、不可再落锁、不可再成交，见 services/hardCancel.ts 文件头。
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
                链上撤单会立即释放这张订单锁住的 Vault 余额，并在链上把这张订单永久作废：作废后任何人也无法再让它落锁或成交。操作由你的钱包直接发一笔链上交易，需要你自付少量
                gas，交易一旦发出不可撤销。
              </Text>
              <Text size="sm" c="dimmed">
                订单簿里的这条记录可能暂时还在（中继簿没有撤单接口，只能等到期自动清理；节点簿会尽力同步移除），但订单已在链上作废、无法成交，不影响你的余额。
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
              链上锁定已释放，这张订单已永久作废、无法再成交。
              {phase.bookRemoval === 'done'
                ? '节点簿记录已移除；中继簿记录仍待过期清理。'
                : '订单簿记录移除未完成，会随到期自动清理，不影响你的余额。'}
            </Text>
          )}
          {phase.kind === 'done' && phase.result.status === 'never-locked' && (
            <Text size="sm">
              这张订单从未在链上落锁，没有需要释放的锁定。
              <Text span c="red">
                注意：订单本身没有作废，在过期前仍可能被落锁并成交；
              </Text>
              如不想继续挂这张单，请用「撤单」把它从订单簿移除（已为你同步尝试，见下）。
              {phase.bookRemoval === 'done'
                ? '节点簿记录已移除；中继簿记录仍待过期清理。'
                : '订单簿记录移除未完成，会随到期自动清理。'}
            </Text>
          )}
          {phase.kind === 'done' && phase.result.status === 'already-cancelled' && (
            <Text size="sm">
              这张订单此前已经完成链上撤单：锁定已释放、订单已永久作废，无法再成交，无需重复操作。
              {phase.bookRemoval === 'done'
                ? '节点簿记录已移除；中继簿记录仍待过期清理。'
                : '订单簿记录会随到期自动清理。'}
            </Text>
          )}
          {phase.kind === 'done' && phase.result.status === 'filled' && (
            <Text size="sm">
              这张订单已经全部成交，锁定已随成交消耗完毕，没有可释放的余额，也无需撤单。
              {phase.bookRemoval === 'done'
                ? '节点簿记录已移除；中继簿记录仍待过期清理。'
                : '订单簿记录会随到期自动清理。'}
            </Text>
          )}
          {phase.kind === 'done' && phase.result.status === 'expired-released' && (
            <Text size="sm">
              这张订单已过期，锁定已随过期释放完毕，没有可释放的余额；订单已过有效期，无法再成交。
              {phase.bookRemoval === 'done'
                ? '节点簿记录已移除；中继簿记录仍待过期清理。'
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
