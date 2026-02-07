import { useState, useEffect, useCallback } from 'react'
import { BrowserProvider, Contract, Interface } from 'ethers'
import { GOVERNANCE_ADDRESS, SETTLEMENT_ADDRESS, GOVERNANCE_ABI } from './config'
import { getEthereum, shortAddress } from './utils'

const ZERO = '0x0000000000000000000000000000000000000000'
const isGovDeployed = () =>
  typeof GOVERNANCE_ADDRESS === 'string' && GOVERNANCE_ADDRESS.toLowerCase() !== ZERO

function formatError(e: unknown): string {
  if (e == null) return '操作失败'
  const err = e as { reason?: string; message?: string; shortMessage?: string }
  const msg = err.reason ?? err.shortMessage ?? err.message ?? String(e)
  if (msg.includes('Governance: not in active set')) return '当前地址不在活跃集内，无法投票'
  if (msg.includes('Governance: already voted')) return '您已投过票'
  if (msg.includes('Governance: voting ended')) return '投票已结束'
  if (msg.includes('Governance: not passed')) return '赞成票未超过半数，无法执行'
  if (msg.length > 80) return msg.slice(0, 77) + '...'
  return msg
}

type ProposalInfo = {
  target: string
  activeCount: string
  createdAt: string
  votingEndsAt: string
  yesCount: string
  noCount: string
  executed: boolean
}

export function GovernanceSection({ account }: { account: string | null }) {
  const [proposals, setProposals] = useState<ProposalInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Vote form
  const [voteProposalId, setVoteProposalId] = useState('0')
  const [voteSupport, setVoteSupport] = useState(true)
  const [voteProof, setVoteProof] = useState('[]')
  const [loadingVote, setLoadingVote] = useState(false)
  // Execute form
  const [execProposalId, setExecProposalId] = useState('0')
  const [loadingExec, setLoadingExec] = useState(false)
  // Create form (setFeeBps preset)
  const [createFeeBps, setCreateFeeBps] = useState('8')
  const [createMerkleRoot, setCreateMerkleRoot] = useState('')
  const [createActiveCount, setCreateActiveCount] = useState('1')
  const [loadingCreate, setLoadingCreate] = useState(false)

  const fetchProposals = useCallback(async () => {
    if (!isGovDeployed()) return
    const ethereum = getEthereum()
    if (!ethereum) return
    setError(null)
    setLoading(true)
    try {
      const provider = new BrowserProvider(ethereum)
      const gov = new Contract(GOVERNANCE_ADDRESS, GOVERNANCE_ABI, provider)
      const count = await gov.proposalCount()
      const list: ProposalInfo[] = []
      const n = Number(count)
      if (!Number.isFinite(n) || n < 0 || n > 1000) { setLoading(false); return }
      for (let i = 0; i < n; i++) {
        try {
          const p = await gov.getProposal(i)
          if (p && p.length >= 8) {
            list.push({
              target: String(p[0] ?? ''),
              activeCount: String(p[2] ?? 0),
              createdAt: String(p[3] ?? 0),
              votingEndsAt: String(p[4] ?? 0),
              yesCount: String(p[5] ?? 0),
              noCount: String(p[6] ?? 0),
              executed: Boolean(p[7]),
            })
          }
        } catch {
          // 单条提案解析失败则跳过
        }
      }
      setProposals(list)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (account && isGovDeployed()) fetchProposals()
  }, [account, fetchProposals])

  const withSigner = useCallback(async <T,>(fn: (gov: Contract) => Promise<T>): Promise<T> => {
    const ethereum = getEthereum()
    if (!ethereum) throw new Error('未检测到钱包')
    const provider = new BrowserProvider(ethereum)
    const signer = await provider.getSigner()
    const gov = new Contract(GOVERNANCE_ADDRESS, GOVERNANCE_ABI, signer)
    return fn(gov)
  }, [])

  const handleVote = useCallback(async () => {
    if (!account || !isGovDeployed()) return
    let proof: string[]
    try {
      proof = JSON.parse(voteProof) as string[]
    } catch {
      setError('proof 需为 JSON 数组，如 [] 或 ["0x...","0x..."]')
      return
    }
    setError(null)
    setLoadingVote(true)
    try {
      await withSigner((gov) => gov.vote(parseInt(voteProposalId, 10), voteSupport, proof).then((tx) => tx.wait()))
      await fetchProposals()
      setVoteProof('[]')
    } catch (e) {
      setError(formatError(e))
    } finally {
      setLoadingVote(false)
    }
  }, [account, voteProposalId, voteSupport, voteProof, fetchProposals, withSigner])

  const handleExecute = useCallback(async () => {
    if (!account || !isGovDeployed()) return
    setError(null)
    setLoadingExec(true)
    try {
      await withSigner((gov) => gov.execute(parseInt(execProposalId, 10)).then((tx) => tx.wait()))
      await fetchProposals()
    } catch (e) {
      setError(formatError(e))
    } finally {
      setLoadingExec(false)
    }
  }, [account, execProposalId, fetchProposals, withSigner])

  const handleCreate = useCallback(async () => {
    if (!account || !isGovDeployed()) return
    const root = createMerkleRoot.trim().toLowerCase()
    if (!/^0x[0-9a-f]{64}$/.test(root)) {
      setError('merkleRoot 需为 32 字节 hex（0x + 64 位十六进制）')
      return
    }
    const activeCount = parseInt(createActiveCount, 10)
    if (activeCount < 1) {
      setError('activeCount 至少为 1')
      return
    }
    const feeBps = parseInt(createFeeBps, 10)
    if (feeBps < 1 || feeBps > 10000) {
      setError('feeBps 需在 1～10000 之间')
      return
    }
    setError(null)
    setLoadingCreate(true)
    try {
      const iface = new Interface(['function setFeeBps(uint16)'])
      const callData = iface.encodeFunctionData('setFeeBps', [feeBps])
      await withSigner((gov) => gov.createProposal(SETTLEMENT_ADDRESS, callData, root, activeCount).then((tx) => tx.wait()))
      await fetchProposals()
      setCreateMerkleRoot('')
    } catch (e) {
      setError(formatError(e))
    } finally {
      setLoadingCreate(false)
    }
  }, [account, createFeeBps, createMerkleRoot, createActiveCount, fetchProposals, withSigner])

  if (!isGovDeployed()) {
    return (
      <div className="card vault-section">
        <h2>治理</h2>
        <p className="hint">Governance 合约未部署。运行 scripts/deploy-governance.ps1 后，将地址填入 frontend/src/config.ts 的 GOVERNANCE_ADDRESS。</p>
      </div>
    )
  }

  return (
    <div className="card vault-section governance-section">
      <h2>治理</h2>
      <p className="hint">查看提案、投票、执行。活跃集与 proof 由 merkletool 生成，见 node/scripts/governance-merkletool-example.md</p>

      <h3 className="gov-sub">提案列表</h3>
      {loading ? (
        <p className="hint">加载中…</p>
      ) : proposals.length === 0 ? (
        <p className="hint">暂无提案</p>
      ) : (
        <div className="proposal-list">
          {proposals.map((p, i) => (
            <div key={i} className="proposal-item">
              <div className="row">
                <span className="label">提案 #{i}</span>
                <span className="value">{p.executed ? '已执行' : Number(p.votingEndsAt) * 1000 > Date.now() ? '投票中' : '可执行'}</span>
              </div>
              <div className="row">
                <span className="label">赞成 / 反对</span>
                <span className="value">{p.yesCount} / {p.noCount}（需 &gt; {Math.floor(Number(p.activeCount) / 2)}）</span>
              </div>
              <div className="row">
                <span className="label">目标</span>
                <span className="value mono">{shortAddress(p.target, 10, 8)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
      <button className="btn secondary" onClick={fetchProposals} disabled={loading}>刷新</button>

      <h3 className="gov-sub">投票</h3>
      <div className="input-row">
        <input
          type="text"
          placeholder="提案 ID"
          value={voteProposalId}
          onChange={(e) => setVoteProposalId(e.target.value)}
          className="input"
        />
        <label className="vote-support">
          <input type="checkbox" checked={voteSupport} onChange={(e) => setVoteSupport(e.target.checked)} />
          赞成
        </label>
      </div>
      <textarea
        placeholder='proof JSON，如 [] 或 ["0x...","0x..."]'
        value={voteProof}
        onChange={(e) => setVoteProof(e.target.value)}
        className="input proof-input"
        rows={2}
      />
      <button className="btn secondary" onClick={handleVote} disabled={loadingVote || !account}>
        {loadingVote ? '处理中…' : '投票'}
      </button>

      <h3 className="gov-sub">执行</h3>
      <div className="input-row">
        <input
          type="text"
          placeholder="提案 ID"
          value={execProposalId}
          onChange={(e) => setExecProposalId(e.target.value)}
          className="input"
        />
        <button className="btn primary" onClick={handleExecute} disabled={loadingExec || !account}>
          {loadingExec ? '处理中…' : '执行'}
        </button>
      </div>

      <h3 className="gov-sub">创建提案（改 Settlement 费率）</h3>
      <p className="hint">需先用 merkletool 生成 merkleRoot、activeCount</p>
      <div className="input-row">
        <input
          type="number"
          placeholder="feeBps (1-10000)"
          value={createFeeBps}
          onChange={(e) => setCreateFeeBps(e.target.value)}
          className="input"
        />
        <input
          type="number"
          placeholder="activeCount"
          value={createActiveCount}
          onChange={(e) => setCreateActiveCount(e.target.value)}
          className="input"
        />
      </div>
      <div className="input-row">
        <input
          type="text"
          placeholder="merkleRoot (0x + 64 hex)"
          value={createMerkleRoot}
          onChange={(e) => setCreateMerkleRoot(e.target.value)}
          className="input"
        />
      </div>
      <button className="btn secondary" onClick={handleCreate} disabled={loadingCreate || !account}>
        {loadingCreate ? '处理中…' : '创建提案'}
      </button>

      {error && <p className="error">{error}</p>}
    </div>
  )
}
