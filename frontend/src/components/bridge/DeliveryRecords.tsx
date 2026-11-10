/**
 * 跨链默认桥 · 交付记录区（第四十一轮，第一期；设计 §4.2 展示位 + §7.1 编排 + §7.3 异常操作）
 *
 * 挂在订单历史（TradeTabsPanel）下方：每笔成交下挂其交付记录（不新建页面孤岛）。
 * 本组件挂载时即编排器的一次扫描：读本地链上成交历史（TradeStorage），为当前用户
 * 作为收款方的成交幂等生成交付记录（planDelivery），重扫不重复生成、更不重复发起。
 * 发起/重试等动作都收敛为记录上的按钮：提款与桥存入须本人钱包逐笔签名（见
 * services/defaultBridge/orchestrator.ts 的载体说明）。
 */
import { useCallback, useEffect, useState } from 'react'
import { Contract } from 'ethers'
import { CHAIN_ID, VAULT_ABI } from '../../config'
import { getChainConfig } from '../../config/chains'
import { formatError, formatTokenAmount, getProvider, withSigner } from '../../utils'
import { withdrawFromVault } from '../../services/bridgeExecutors'
import { getDisclosure } from '../../services/defaultBridge/disclosures'
import {
  loadDeliveries,
  saveDeliveries,
  transition,
  type DeliveryEvent,
} from '../../services/defaultBridge/deliveries'
import {
  executeDelivery,
  fillFromLocalTrade,
  planDelivery,
  refreshDelivery,
  revalidatePendingDisclosures,
} from '../../services/defaultBridge/orchestrator'
import { loadSettings } from '../../services/defaultBridge/settings'
import { hasValidConfirmation, supportedChannelsFor } from '../../services/defaultBridge/support'
import { TradeStorage } from '../../services/storage'
import type { DeliveryRecord, DeliveryStatus } from '../../services/defaultBridge/types'
import './DeliveryRecords.css'

const STATUS_LABELS: Record<DeliveryStatus, string> = {
  'not-needed': '无需交付',
  'pending-decision': '待发起交付',
  'suspended-disclosure': '交付待确认（披露已更新）',
  'ask-required': '待选择交付方式',
  initiating: '交付发起中',
  'in-flight': '交付中',
  delivered: '已到账',
  anomaly: '交付异常',
}

function applyEvent(account: string, record: DeliveryRecord, event: DeliveryEvent): DeliveryRecord {
  const next = transition(record, event)
  const all = loadDeliveries(account)
  const idx = all.findIndex((r) => r.id === next.id)
  if (idx >= 0) all[idx] = next
  else all.push(next)
  saveDeliveries(account, all)
  return next
}

export function DeliveryRecords({ account, refreshSignal = 0 }: { account: string | null; refreshSignal?: number }) {
  const [records, setRecords] = useState<DeliveryRecord[]>([])
  const [engaged, setEngaged] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    if (!account) {
      setRecords([])
      setEngaged(false)
      return
    }
    const s = loadSettings(account)
    setEngaged(Boolean(s.defaultChannel || s.homeChainId))
    try {
      const trades = await TradeStorage.getUserTrades(account, 50)
      for (const t of trades) {
        const fill = fillFromLocalTrade(t, CHAIN_ID)
        if (fill) planDelivery(account, fill, s)
      }
    } catch {
      // 本地成交历史不可用时，只展示已有交付记录
    }
    // 加载时批量复验（第 63 轮桥-1）：披露升版后，旧 pending-decision 先如实转挂起
    revalidatePendingDisclosures(account, s)
    setRecords(loadDeliveries(account).slice().sort((a, b) => b.createdAt - a.createdAt))
  }, [account])

  useEffect(() => {
    void reload()
  }, [reload, refreshSignal])

  if (!account || (records.length === 0 && !engaged)) return null

  const run = async (rec: DeliveryRecord, fn: () => Promise<unknown>) => {
    setBusyId(rec.id)
    setActionError(null)
    try {
      await fn()
    } catch (e) {
      setActionError(formatError(e))
    } finally {
      setBusyId(null)
      void reload()
    }
  }

  const doWithdrawToWallet = async (rec: DeliveryRecord) => {
    const settleChain = getChainConfig(rec.settleChainId)
    if (!settleChain) return
    const token = settleChain.tokens?.[rec.asset]
    if (!token) return
    await withSigner(async (signer) => {
      const provider = getProvider()
      let amount = BigInt(rec.amountWei)
      if (provider) {
        const vault = new Contract(settleChain.contracts.vault, VAULT_ABI, provider)
        const available: bigint = await vault.availableBalance(token, account!)
        if (available <= 0n) throw new Error('成交链 Vault 可用余额为 0')
        if (available < amount) amount = available
      }
      await withdrawFromVault(signer, settleChain, token, amount)
      const all = loadDeliveries(account!)
      const idx = all.findIndex((r) => r.id === rec.id)
      if (idx >= 0) {
        all[idx] = { ...all[idx], fundsLocation: 'wallet', updatedAt: Date.now() }
        saveDeliveries(account!, all)
      }
    })
  }

  return (
    <section className="drec" aria-label="跨链交付记录">
      <h4 className="drec-title">跨链交付记录</h4>
      {records.length === 0 && <p className="hint">暂无交付记录：跨链成交结算后，交付记录会出现在这里。</p>}
      {actionError && (
        <p className="hint drec-error" role="alert">
          {actionError}
        </p>
      )}
      {records.map((rec) => {
        const busy = busyId === rec.id
        const channelName = rec.channel ? getDisclosure(rec.channel).name : null
        const settleName = getChainConfig(rec.settleChainId)?.name ?? `${rec.settleChainId}`
        const homeName = getChainConfig(rec.homeChainId)?.name ?? `${rec.homeChainId}`
        const settings = loadSettings(account)
        const askChannels =
          rec.status === 'ask-required' ? supportedChannelsFor(rec.settleChainId, rec.homeChainId, rec.asset) : []
        return (
          <div key={rec.id} className="drec-card">
            <div className="drec-head">
              <b>
                {rec.pair || '成交'} · 收到 {formatTokenAmount(BigInt(rec.amountWei))} {rec.asset}
              </b>
              <span className={`pill drec-status-${rec.status}`}>{STATUS_LABELS[rec.status]}</span>
            </div>
            <div className="drec-lines">
              <span>
                路线：{settleName} → {homeName}
                {channelName ? ` · 通道 ${channelName}` : ''}
              </span>
              {rec.feeNativeWei && <span>实际桥费：{formatTokenAmount(BigInt(rec.feeNativeWei))} ETH（由你从成交款承担，与结算 gas 分开）</span>}
              {rec.initiatedAt && <span>发起：{new Date(rec.initiatedAt).toLocaleString()}</span>}
              {rec.deliveredAt && <span>到账：{new Date(rec.deliveredAt).toLocaleString()}</span>}
              {rec.trackingUrl && (
                <a href={rec.trackingUrl} target="_blank" rel="noreferrer">
                  查看交付追踪
                </a>
              )}
            </div>

            {rec.status === 'pending-decision' && (
              <button type="button" className="btn primary drec-btn" disabled={busy} onClick={() => void run(rec, () => executeDelivery(account, rec.id, settings))}>
                {busy ? '发起中…' : '发起交付（钱包签名确认）'}
              </button>
            )}

            {rec.status === 'suspended-disclosure' && (
              <>
                <p className="hint">
                  {channelName} 的披露已更新，本笔交付挂起中（成交款留在 {settleName} 的 Vault）。
                  请到「其他 → 跨链桥」页顶部的默认通道设置里重新确认新版披露。
                </p>
                {rec.channel && hasValidConfirmation(settings, rec.channel) && (
                  <button
                    type="button"
                    className="btn drec-btn"
                    disabled={busy}
                    onClick={() => void run(rec, async () => applyEvent(account, rec, { type: 'reconfirmed', at: Date.now() }))}
                  >
                    已重新确认，继续本笔交付
                  </button>
                )}
              </>
            )}

            {rec.status === 'ask-required' && (
              <div className="drec-ask">
                <p className="hint">你的默认通道不支持本笔交付。请选择本次的交付方式（不会静默换桥）：</p>
                {askChannels.map((ch) => {
                  const ok = hasValidConfirmation(settings, ch)
                  return (
                    <button
                      key={ch}
                      type="button"
                      className="btn drec-btn"
                      disabled={busy || !ok}
                      title={ok ? '' : '需先在跨链桥页的默认通道设置里读完并确认该通道披露'}
                      onClick={() =>
                        void run(rec, async () => applyEvent(account, rec, { type: 'choose-temp-channel', at: Date.now(), channel: ch }))
                      }
                    >
                      本次改用 {getDisclosure(ch).name} 交付{ok ? '' : '（需先确认其披露）'}
                    </button>
                  )
                })}
                <button
                  type="button"
                  className="btn drec-btn"
                  disabled={busy}
                  onClick={() =>
                    void run(rec, async () => applyEvent(account, rec, { type: 'resolve-settle-chain-only', at: Date.now() }))
                  }
                >
                  只在成交链交付（钱留 {settleName} Vault）
                </button>
              </div>
            )}

            {rec.status === 'in-flight' && (
              <button type="button" className="btn drec-btn" disabled={busy} onClick={() => void run(rec, () => refreshDelivery(account, rec.id, getProvider()))}>
                {busy ? '刷新中…' : '刷新状态'}
              </button>
            )}

            {rec.status === 'anomaly' && (
              <div className="drec-anomaly">
                {rec.anomalyNote && <p className="hint">{rec.anomalyNote}</p>}
                {rec.channel && rec.anomalyKind && (
                  <p className="hint">
                    {rec.anomalyKind === 'initiation-failed'
                      ? getDisclosure(rec.channel).failureGuide.initiationFailure
                      : rec.anomalyKind === 'timeout'
                        ? getDisclosure(rec.channel).failureGuide.inTransitTimeout
                        : getDisclosure(rec.channel).failureGuide.destinationIssue}
                  </p>
                )}
                <div className="drec-actions">
                  {rec.anomalyKind === 'initiation-failed' && (
                    <button
                      type="button"
                      className="btn primary drec-btn"
                      disabled={busy}
                      onClick={() =>
                        void run(rec, async () => {
                          applyEvent(account, rec, { type: 'retry', at: Date.now() })
                          await executeDelivery(account, rec.id, settings)
                        })
                      }
                    >
                      {busy ? '处理中…' : '重试交付'}
                    </button>
                  )}
                  {rec.fundsLocation === 'vault' && (
                    <button type="button" className="btn drec-btn" disabled={busy} onClick={() => void run(rec, () => doWithdrawToWallet(rec))}>
                      提取到钱包
                    </button>
                  )}
                  {rec.fundsLocation === 'wallet' && <span className="hint">成交款已在你的钱包里（成交链），可自行处理或重试交付。</span>}
                </div>
              </div>
            )}
          </div>
        )
      })}
    </section>
  )
}
