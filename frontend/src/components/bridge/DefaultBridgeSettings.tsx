/**
 * 跨链默认桥 · 设置区（第四十一轮，第一期；设计 §2.2 主入口，挂在跨链桥页顶部）
 *
 * 流程（§2.2）：四通道并列（第一期只列三条消息桥，极速档待主网与 LI.FI key 就绪后补入）
 * → 点选一条 → 该通道完整披露屏（§2.3 六要素）→ 勾选确认并保存 → 生效。
 * 改选 = 对新通道重走披露屏；披露改版后旧确认失效，此处给重新确认入口（§2.3）。
 * 使用说明（§2.5）随功能同轮上线：本区顶部的说明块即说明书。
 */
import { useMemo, useState } from 'react'
import { ZeroAddress } from 'ethers'
import { SUPPORTED_CHAINS, getChainConfig } from '../../config/chains'
import { CHANNEL_DISCLOSURES, etaShortTextFor } from '../../services/defaultBridge/disclosures'
import { hasValidConfirmation } from '../../services/defaultBridge/support'
import {
  confirmDisclosure,
  loadSettings,
  saveSettings,
} from '../../services/defaultBridge/settings'
import type { DefaultBridgeSettings, DefaultChannelId } from '../../services/defaultBridge/types'
import './DefaultBridgeSettings.css'

const CHANNEL_ORDER: DefaultChannelId[] = ['layerzero', 'ccip', 'wormhole']

/** 可选主场链：已部署全套合约（token0 非零地址）的链——当前只有双测试网，不许选空壳主网配置 */
const HOME_CHAIN_OPTIONS = SUPPORTED_CHAINS.filter(
  (c) => c.contracts.token0 && c.contracts.token0 !== ZeroAddress
)

export function DefaultBridgeSettings({ account }: { account: string | null }) {
  const [settings, setSettings] = useState<DefaultBridgeSettings>(() =>
    account ? loadSettings(account) : loadSettings('')
  )
  const [openChannel, setOpenChannel] = useState<DefaultChannelId | null>(null)
  const [ack, setAck] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  // account 变化时重读该用户的设置
  const accountKey = account ?? ''
  const [lastAccount, setLastAccount] = useState(accountKey)
  if (accountKey !== lastAccount) {
    setLastAccount(accountKey)
    setSettings(loadSettings(accountKey))
    setOpenChannel(null)
    setAck(false)
    setMsg(null)
  }

  const defaultStale = useMemo(
    () => Boolean(settings.defaultChannel) && !hasValidConfirmation(settings, settings.defaultChannel!),
    [settings]
  )

  const persist = (next: DefaultBridgeSettings, note?: string) => {
    setSettings(next)
    if (account) saveSettings(account, next)
    if (note) setMsg(note)
  }

  const openDisclosure = (ch: DefaultChannelId) => {
    setOpenChannel(openChannel === ch ? null : ch)
    setAck(false)
    setMsg(null)
  }

  const saveAsDefault = (ch: DefaultChannelId) => {
    if (!account) return
    if (!settings.homeChainId) {
      setMsg('请先选择你的主场链（成交款要送回的那条链），再保存默认通道。')
      return
    }
    const next = confirmDisclosure(
      { ...settings, defaultChannel: ch, standingAuth: true },
      ch
    )
    persist(next, `已保存：默认通道 ${CHANNEL_DISCLOSURES[ch].name}，自动交付已开启。之后跨链成交的成交款会自动经它送回你的主场链。`)
    setOpenChannel(null)
    setAck(false)
  }

  const currentName = settings.defaultChannel ? CHANNEL_DISCLOSURES[settings.defaultChannel].name : null
  const homeName = settings.homeChainId ? (getChainConfig(settings.homeChainId)?.name ?? '—') : null

  return (
    <section className="card dbs" aria-label="跨链默认通道设置">
      <div className="dbs-head">
        <b>我的默认通道（跨链自动交付）</b>
        <span className="pill">
          {!account
            ? '未连接钱包'
            : !settings.defaultChannel
              ? '未设置'
              : settings.standingAuth
                ? `生效中：${currentName}`
                : '已关闭自动交付'}
        </span>
      </div>

      <div className="dbs-guide">
        <p>
          <b>干什么：</b>在这里选一次默认通道，之后你在别的链成交时，成交款会自动经默认通道送回你的主场链，
          不用再自己去桥页搬运。同链成交不受影响、没有交付这一步。
        </p>
        <p>
          <b>使用前提：</b>已连接钱包；成交时你在成交链的 Vault 里有余额（成交款本来就落在那里）；
          交付一旦发起不可撤销、必然走完。
        </p>
        <p>
          <b>操作步骤：</b>选主场链 → 点一条通道 → 读完它的完整披露 → 勾选确认并保存 → 生效。
          改选默认通道要对新通道重走一遍披露；关闭自动交付在下方开关，关闭后新成交不再自动交付，在途的交付不受影响、会走完。
        </p>
        <p>
          <b>注意事项：</b>三条通道的时效不同（见各卡片）；交付桥费由你（收款方）从成交款里承担，
          与结算 gas 的双方对半分摊是两笔分开的账；某条通道的披露文案更新后，你需要回来重新确认，
          重新确认前该通道的自动交付会挂起（钱先留成交链 Vault，不会丢）；交付失败时钱退回成交链 Vault，
          详见各通道披露里的失败说明。预计费用与时间只是预估，最终以交付记录为准。
        </p>
      </div>

      {!account ? (
        <p className="hint">连接钱包后可以设置默认通道。未设置时，跨链成交款就留在成交链的 Vault 里，不会有任何自动动作。</p>
      ) : (
        <>
          <div className="dbs-row">
            <label htmlFor="dbs-home-chain">我的主场链（成交款送回这里）</label>
            <select
              id="dbs-home-chain"
              value={settings.homeChainId ?? ''}
              onChange={(e) => {
                const v = Number(e.target.value) || null
                persist({ ...settings, homeChainId: v })
              }}
            >
              <option value="">请选择主场链</option>
              {HOME_CHAIN_OPTIONS.map((c) => (
                <option key={c.chainId} value={c.chainId}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          {defaultStale && settings.defaultChannel && (
            <p className="dbs-warn" role="alert">
              {currentName} 的披露已更新，你之前的确认已失效：该通道的自动交付暂时挂起（成交款先留成交链 Vault）。
              请点开下方 {currentName} 的披露，读完新版后重新确认。
            </p>
          )}

          <div className="dbs-cards">
            {CHANNEL_ORDER.map((ch) => {
              const d = CHANNEL_DISCLOSURES[ch]
              const isDefault = settings.defaultChannel === ch
              const confirmed = hasValidConfirmation(settings, ch)
              return (
                <div key={ch} className={`dbs-card${isDefault ? ' selected' : ''}`}>
                  <div className="dbs-card-head">
                    <strong>{d.name}</strong>
                    {isDefault && <span className="bridge-card-badge">我的默认</span>}
                    {confirmed && !isDefault && <span className="bridge-card-badge muted">已确认披露</span>}
                  </div>
                  <p>{d.feeStructure.split('。')[0]}。</p>
                  <p>
                    时效：主网 {etaShortTextFor(ch, 1)} · 测试网 {etaShortTextFor(ch, 11155111)}
                  </p>
                  <p>{d.securityModel.split('。')[0]}。</p>
                  <button type="button" className="btn dbs-open" onClick={() => openDisclosure(ch)}>
                    {openChannel === ch ? '收起披露' : isDefault && !confirmed ? '查看新版披露并重新确认' : '查看完整披露并设为默认'}
                  </button>
                  {openChannel === ch && (
                    <div className="dbs-disclosure">
                      <p>
                        <b>费率结构：</b>
                        {d.feeStructure}
                      </p>
                      <p>
                        <b>时效：</b>
                        {d.etaMainnetText}
                        {d.etaTestnetText}
                      </p>
                      <p>
                        <b>安全模型：</b>
                        {d.securityModel}
                      </p>
                      <b>具体风险点：</b>
                      <ul>
                        {d.riskPoints.map((r) => (
                          <li key={r.slice(0, 14)}>{r}</li>
                        ))}
                      </ul>
                      <p>
                        <b>不可撤销：</b>
                        {d.irreversibility}
                      </p>
                      <p>
                        <b>失败时资金去向：</b>
                        {d.failureDestination}
                      </p>
                      <b>失败处理（分三种情况）：</b>
                      <ul>
                        <li>{d.failureGuide.initiationFailure}</li>
                        <li>{d.failureGuide.inTransitTimeout}</li>
                        <li>{d.failureGuide.destinationIssue}</li>
                      </ul>
                      <p className="hint">披露版本 v{d.version}。文案改版后本确认自动失效，届时需要重新确认。</p>
                      <label className="dbs-ack">
                        <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                        我已读完以上披露，理解费用、时效、安全模型与风险，并同意把 {d.name} 设为我的默认交付通道。
                      </label>
                      <button
                        type="button"
                        className="btn primary dbs-save"
                        disabled={!ack}
                        onClick={() => saveAsDefault(ch)}
                      >
                        确认并设为默认通道（开启自动交付）
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          <div className="dbs-row">
            <span>自动交付（常设授权）</span>
            <button
              type="button"
              className="btn"
              onClick={() => persist({ ...settings, standingAuth: !settings.standingAuth })}
              aria-pressed={settings.standingAuth}
            >
              {settings.standingAuth ? '已开启（点此关闭）' : '已关闭（点此开启）'}
            </button>
          </div>
          <p className="hint">
            关闭后，新成交不再自动发起交付，成交款留成交链 Vault；在途交付不受影响、必然走完。开启后，
            凡你作为收款方、主场链与成交链不同的成交，都会按默认通道发起交付（发起时仍需你在钱包里逐笔签名确认提款与桥存入）。
          </p>

          <div className="dbs-row">
            <span>默认通道不支持某笔时</span>
            <label>
              <input
                type="radio"
                name="dbs-nofallback"
                checked={settings.noFallbackPref === 'ask'}
                onChange={() => persist({ ...settings, noFallbackPref: 'ask' })}
              />{' '}
              成交前问我一次（默认）
            </label>
            <label>
              <input
                type="radio"
                name="dbs-nofallback"
                checked={settings.noFallbackPref === 'settle-chain-only'}
                onChange={() => persist({ ...settings, noFallbackPref: 'settle-chain-only' })}
              />{' '}
              一律只在成交链交付（不问我）
            </label>
          </div>
          <p className="hint">
            无论哪种设置，都不会静默换桥：临时改用其他通道一定先经你确认（且要先读过那条通道的披露）。
            改选默认通道不影响已成交待交付的订单，它们按成交时生效的设置执行。
            {homeName && currentName && (
              <>
                {' '}
                当前设置：默认通道 {currentName}，主场链 {homeName}。
              </>
            )}
          </p>

          {msg && (
            <p className="hint" role="status">
              {msg}
            </p>
          )}
        </>
      )}
    </section>
  )
}
