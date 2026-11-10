import { useState, useCallback, useEffect } from 'react'
import { Contract, parseEther } from 'ethers'
import { GAS_VAULT_ADDRESS, GAS_VAULT_ABI, ERC20_ABI, CHAIN_ID } from '../config'
import { getProvider, withSigner, formatTokenAmount, formatError } from '../utils'

/**
 * gas库（GasVault）分区（第 63 轮 gas-2）。
 *
 * 干什么：gas库 是全站结算的 gas 周转池——存款人把包装原生币存进来，平台用
 * 池中浮存垫付每笔结算的 gas，结算时再从买卖双方各扣一半回补。存款按
 * 「份额 × 时长」计入贡献奖励的 gas 库存款线（25%）。
 * 部署状态：第 63 轮只交付合约与本页，部署属部署步——未部署的链
 * （GAS_VAULT_ADDRESS 未配置）如实显示「尚未开放」，不伪造任何数据。
 */

const ZERO = '0x0000000000000000000000000000000000000000'
export const isGasVaultDeployed = (addr: string | undefined): boolean =>
  typeof addr === 'string' && addr.length > 0 && addr.toLowerCase() !== ZERO

export type WaterLevel = 'unset' | 'low' | 'ok'

/** 水位状态：未设目标 = unset；浮存低于警戒线 = low（可公开触发换汇补油箱） */
export function gasVaultWaterLevel(floatWei: bigint, targetWei: bigint, watermarkWei: bigint): WaterLevel {
  if (targetWei <= 0n) return 'unset'
  return floatWei < watermarkWei ? 'low' : 'ok'
}

const WETH_ABI = [...ERC20_ABI, 'function deposit() payable']

type VaultState = {
  totalAssets: bigint
  floatNative: bigint
  targetFloat: bigint
  lowWatermark: bigint
  paused: boolean
  assetSymbol: string
  myShares: bigint
  myAssets: bigint
}

export function GasVaultSection({ account }: { account: string | null }) {
  const deployed = isGasVaultDeployed(GAS_VAULT_ADDRESS)
  const [state, setState] = useState<VaultState | null>(null)
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!deployed) return
    const provider = getProvider()
    if (!provider) return
    try {
      const vault = new Contract(GAS_VAULT_ADDRESS!, GAS_VAULT_ABI, provider)
      const assetAddr: string = await vault.asset()
      const asset = new Contract(assetAddr, ERC20_ABI, provider)
      const [totalAssets, targetFloat, lowWatermark, paused, assetSymbol, floatNative] = await Promise.all([
        vault.totalAssets() as Promise<bigint>,
        vault.targetFloat() as Promise<bigint>,
        vault.lowWatermark() as Promise<bigint>,
        vault.paused() as Promise<boolean>,
        asset.symbol() as Promise<string>,
        provider.getBalance(GAS_VAULT_ADDRESS!),
      ])
      let myShares = 0n
      let myAssets = 0n
      if (account) {
        myShares = (await vault.balanceOf(account)) as bigint
        if (myShares > 0n) myAssets = (await vault.convertToAssets(myShares)) as bigint
      }
      setState({ totalAssets, floatNative, targetFloat, lowWatermark, paused, assetSymbol, myShares, myAssets })
    } catch (e) {
      setError(formatError(e))
    }
  }, [deployed, account])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const runTx = async (label: string, fn: () => Promise<void>) => {
    setBusy(label)
    setError(null)
    setNotice(null)
    try {
      await fn()
      setNotice(`${label}已提交上链。`)
      setAmount('')
      await refresh()
    } catch (e) {
      setError(formatError(e))
    } finally {
      setBusy(null)
    }
  }

  /** 存入已持有的包装原生币：授权 → deposit */
  const depositWrapped = () =>
    runTx('存入', async () => {
      if (!account) throw new Error('请先连接钱包')
      const value = parseEther(amount || '0')
      if (value <= 0n) throw new Error('请输入大于 0 的金额')
      await withSigner(async (signer) => {
        const vault = new Contract(GAS_VAULT_ADDRESS!, GAS_VAULT_ABI, signer)
        const assetAddr: string = await new Contract(GAS_VAULT_ADDRESS!, GAS_VAULT_ABI, signer).asset()
        const asset = new Contract(assetAddr, ERC20_ABI, signer)
        const allowance = (await asset.allowance(account, GAS_VAULT_ADDRESS!)) as bigint
        if (allowance < value) {
          const tx = await asset.approve(GAS_VAULT_ADDRESS!, value)
          await tx.wait()
        }
        const tx = await vault.deposit(value, account)
        await tx.wait()
      })
    })

  /** 用原生币存入：先打包成包装原生币（WETH deposit），再授权 → deposit */
  const wrapAndDeposit = () =>
    runTx('打包并存入', async () => {
      if (!account) throw new Error('请先连接钱包')
      const value = parseEther(amount || '0')
      if (value <= 0n) throw new Error('请输入大于 0 的金额')
      await withSigner(async (signer) => {
        const vaultRead = new Contract(GAS_VAULT_ADDRESS!, GAS_VAULT_ABI, signer)
        const assetAddr: string = await vaultRead.asset()
        const weth = new Contract(assetAddr, WETH_ABI, signer)
        const wrapTx = await weth.deposit({ value })
        await wrapTx.wait()
        const allowance = (await weth.allowance(account, GAS_VAULT_ADDRESS!)) as bigint
        if (allowance < value) {
          const apTx = await weth.approve(GAS_VAULT_ADDRESS!, value)
          await apTx.wait()
        }
        const vault = new Contract(GAS_VAULT_ADDRESS!, GAS_VAULT_ABI, signer)
        const tx = await vault.deposit(value, account)
        await tx.wait()
      })
    })

  const withdraw = () =>
    runTx('取回', async () => {
      if (!account) throw new Error('请先连接钱包')
      const value = parseEther(amount || '0')
      if (value <= 0n) throw new Error('请输入大于 0 的金额')
      await withSigner(async (signer) => {
        const vault = new Contract(GAS_VAULT_ADDRESS!, GAS_VAULT_ABI, signer)
        const tx = await vault.withdraw(value, account, account)
        await tx.wait()
      })
    })

  const level = state ? gasVaultWaterLevel(state.floatNative, state.targetFloat, state.lowWatermark) : 'unset'

  return (
    <div className="card vault-section">
      <h2>gas库</h2>
      <p className="hint">
        干什么：gas库 是全站结算的 gas 周转池。存款人把所在链的包装原生币存进来，平台结算时先用池里的原生币浮存垫付
        gas，再从买卖双方各扣一半成交额回补（gas 对半收）；垫付的计量差额由 gas库 吸收，存款人因此按「份额 ×
        时长」计入贡献奖励的 gas 库存款线（25%）。平台只做中介和垫付，不拿池里的钱下场交易。
      </p>
      <p className="hint">
        前提：需要连接钱包；存入的币种是当前链的包装原生币（如 WETH），没有的话可以在下方用原生币一键打包存入。
        步骤：① 输入金额；② 点「打包并存入」（原生币）或「存入」（已持有包装原生币，第一笔需先授权）；③
        取回时输入金额点「取回」，份额按当前总资产折算返还包装原生币。
      </p>
      <p className="hint">
        注意事项：暂停只会停「存入」，永远不挡取回；池内原生币水位低于警戒线（目标水位的 40%）时，任何人都可以
        公开触发把库内回收的成交币换回原生币补油箱，换汇到手价由合约按参考价 97% 熔断线把关，不经管理员之手；
        本页数据全部来自链上合约，页面打不开不影响你在合约上直接操作。
      </p>

      {!deployed && (
        <p className="hint" style={{ marginTop: '0.75rem' }}>
          当前链（chainId {CHAIN_ID}）的 gas库 尚未部署开放——合约已完成并通过测试，部署与接线在后续部署步进行，
          部署后本页会自动显示池子状态与存取入口。在此之前请勿向任何自称 gas库 的地址存款。
        </p>
      )}

      {deployed && (
        <>
          <div className="balances" style={{ marginTop: '1rem' }}>
            <div className="row result">
              <span className="label">池子总资产</span>
              <span className="value mono">{state ? `${formatTokenAmount(state.totalAssets)} ${state.assetSymbol}` : '读取中…'}</span>
            </div>
            <div className="row result">
              <span className="label">其中原生币浮存</span>
              <span className="value mono">{state ? formatTokenAmount(state.floatNative) : '—'}</span>
            </div>
            <div className="row result">
              <span className="label">目标水位 / 警戒线</span>
              <span className="value mono">
                {state ? `${formatTokenAmount(state.targetFloat)} / ${formatTokenAmount(state.lowWatermark)}` : '—'}
              </span>
            </div>
            <div className="row result">
              <span className="label">水位状态</span>
              <span className="value">
                {!state ? '—' : level === 'unset' ? '目标水位未设定' : level === 'low' ? '低于警戒线（可触发换汇补油箱）' : '正常'}
                {state?.paused ? ' · 已暂停存入（取回不受影响）' : ''}
              </span>
            </div>
            <div className="row result">
              <span className="label">我的份额 / 可取回</span>
              <span className="value mono">
                {account
                  ? state
                    ? `${formatTokenAmount(state.myShares)} 份 / ${formatTokenAmount(state.myAssets)} ${state.assetSymbol}`
                    : '读取中…'
                  : '连接钱包后显示'}
              </span>
            </div>
          </div>

          <div className="input-row" style={{ marginTop: '1rem' }}>
            <input
              type="text"
              inputMode="decimal"
              placeholder="金额（原生币 / 包装原生币，18 位小数）"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="input"
            />
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button type="button" className="btn secondary" onClick={wrapAndDeposit} disabled={busy !== null || !account}>
              {busy === '打包并存入' ? '处理中…' : '打包并存入'}
            </button>
            <button type="button" className="btn secondary" onClick={depositWrapped} disabled={busy !== null || !account}>
              {busy === '存入' ? '处理中…' : '存入（包装原生币）'}
            </button>
            <button type="button" className="btn secondary" onClick={withdraw} disabled={busy !== null || !account}>
              {busy === '取回' ? '处理中…' : '取回'}
            </button>
            <button type="button" className="btn secondary" onClick={() => void refresh()} disabled={busy !== null}>
              刷新
            </button>
          </div>
        </>
      )}

      {error && (
        <p className="hint" style={{ color: '#b91c1c', marginTop: '0.75rem' }}>
          {error}
        </p>
      )}
      {notice && (
        <p className="hint" style={{ marginTop: '0.75rem' }}>
          {notice}
        </p>
      )}
    </div>
  )
}
