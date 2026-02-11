/**
 * Merkle Airdrop 领取界面
 * 用户从 merkle-distributor 工具获取 index、amount、proof 后在此领取
 */
import { useState, useCallback } from 'react'
import { Contract } from 'ethers'
import { getProvider, withSigner, formatError, isValidAddress } from '../utils'

const MERKLE_DISTRIBUTOR_ABI = [
  'function claimed(address account) view returns (bool)',
  'function claim(uint256 index, address account, uint256 amount, bytes32[] calldata merkleProof)',
  'function merkleRoot() view returns (bytes32)',
] as const

const defaultAddr = (import.meta.env.VITE_MERKLE_DISTRIBUTOR_ADDRESS ?? '').trim()

interface MerkleAirdropClaimProps {
  account: string | null
  onError?: (msg: string | null) => void
}

export function MerkleAirdropClaim({ account, onError }: MerkleAirdropClaimProps) {
  const [contractAddr, setContractAddr] = useState(defaultAddr)
  const [index, setIndex] = useState('')
  const [amount, setAmount] = useState('')
  const [proofJson, setProofJson] = useState('')
  const [claimed, setClaimed] = useState<boolean | null>(null)
  const [checking, setChecking] = useState(false)
  const [claiming, setClaiming] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const setErr = useCallback(
    (msg: string | null) => {
      setError(msg)
      onError?.(msg ?? null)
    },
    [onError]
  )

  const checkClaimed = useCallback(async () => {
    if (!contractAddr || !account || !isValidAddress(contractAddr) || !isValidAddress(account)) {
      setClaimed(null)
      return
    }
    setChecking(true)
    setErr(null)
    try {
      const provider = getProvider()
      if (!provider) throw new Error('未检测到钱包')
      const c = new Contract(contractAddr, MERKLE_DISTRIBUTOR_ABI, provider)
      const ok = await c.claimed(account)
      setClaimed(ok)
    } catch (e) {
      setErr(formatError(e))
      setClaimed(null)
    } finally {
      setChecking(false)
    }
  }, [account, contractAddr, setErr])

  const doClaim = useCallback(async () => {
    if (!contractAddr || !account || !index || !amount || !proofJson) {
      setErr('请填写完整：合约地址、index、amount、proof')
      return
    }
    let proof: string[]
    try {
      proof = JSON.parse(proofJson)
      if (!Array.isArray(proof)) throw new Error('proof 需为数组')
    } catch {
      setErr('proof 格式错误，需为 JSON 数组，如 ["0x...","0x..."]')
      return
    }
    setClaiming(true)
    setErr(null)
    try {
      await withSigner(async (signer) => {
        const c = new Contract(contractAddr, MERKLE_DISTRIBUTOR_ABI, signer)
        const tx = await c.claim(parseInt(index, 10), account, BigInt(amount), proof)
        await tx.wait()
        setClaimed(true)
        setIndex('')
        setAmount('')
        setProofJson('')
      })
    } catch (e) {
      setErr(formatError(e))
    } finally {
      setClaiming(false)
    }
  }, [account, contractAddr, index, amount, proofJson, setErr])

  if (!account) return null

  return (
    <section className="card merkle-airdrop-claim">
      <h3>Merkle 空投领取</h3>
      <p className="hint">使用 merkle-distributor 工具获取 index、amount、proof 后在此领取</p>
      <div className="form-group">
        <label>MerkleDistributor 合约地址</label>
        <input
          type="text"
          placeholder="0x..."
          value={contractAddr}
          onChange={(e) => setContractAddr(e.target.value.trim())}
        />
      </div>
      <div className="form-row">
        <button type="button" onClick={checkClaimed} disabled={checking || !contractAddr}>
          {checking ? '检查中…' : '检查是否已领取'}
        </button>
        {claimed === true && <span className="text-success">已领取</span>}
        {claimed === false && <span className="text-muted">未领取</span>}
      </div>
      {claimed === false && (
        <>
          <div className="form-group">
            <label>index（merkle-distributor 输出）</label>
            <input type="text" placeholder="0" value={index} onChange={(e) => setIndex(e.target.value)} />
          </div>
          <div className="form-group">
            <label>amount（token 最小单位，如 wei）</label>
            <input type="text" placeholder="1000000000000000000" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          <div className="form-group">
            <label>proof（JSON 数组，如 ["0x...","0x..."]）</label>
            <textarea
              rows={3}
              placeholder='["0x...","0x..."]'
              value={proofJson}
              onChange={(e) => setProofJson(e.target.value)}
            />
          </div>
          <button
            type="button"
            className="primary"
            onClick={doClaim}
            disabled={claiming || !index || !amount || !proofJson}
          >
            {claiming ? '领取中…' : '领取'}
          </button>
        </>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  )
}
