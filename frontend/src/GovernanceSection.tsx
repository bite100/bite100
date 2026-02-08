import { useState, useEffect, useCallback } from 'react'
import { Contract, Interface } from 'ethers'
import { GOVERNANCE_ADDRESS, SETTLEMENT_ADDRESS, GOVERNANCE_ABI } from './config'
import { getProvider, shortAddress, withSigner as withSignerUtil, formatError } from './utils'

const ZERO = '0x0000000000000000000000000000000000000000'
const isGovDeployed = () =>
  typeof GOVERNANCE_ADDRESS === 'string' && GOVERNANCE_ADDRESS.toLowerCase() !== ZERO

type ProposalInfo = {
  target: string
  activeCount: string
  createdAt: string
  votingEndsAt: string
  yesCount: string
  noCount: string
  executed: boolean
  executableAt: string
  isMultiStep?: boolean
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
    const provider = getProvider()
    if (!provider) return
    setError(null)
    setLoading(true)
    try {
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
              executableAt: String(p[8] ?? 0),
              isMultiStep: false,
            })
          }
        } catch {
          // 可能是多步骤提案，尝试获取多步骤提案信息
          try {
            const mp = await gov.getMultiStepProposal(i)
            if (mp && mp.length >= 9) {
              list.push({
                target: mp[0]?.[0] ?? '', // 使用第一个目标
                activeCount: String(mp[3] ?? 0),
                createdAt: String(mp[4] ?? 0),
                votingEndsAt: String(mp[5] ?? 0),
                yesCount: String(mp[6] ?? 0),
                noCount: String(mp[7] ?? 0),
                executed: Boolean(mp[8]),
                executableAt: String(mp[8] ?? 0),
                isMultiStep: true,
              })
            }
          } catch {
            // 单条提案解析失败则跳过
          }
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
    return withSignerUtil((signer) => {
      const gov = new Contract(GOVERNANCE_ADDRESS, GOVERNANCE_ABI, signer)
      return fn(gov)
    })
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
          {proposals.map((p, i) => {
            const now = Date.now()
            const votingEnds = Number(p.votingEndsAt) * 1000
            const executableAt = Number(p.executableAt) * 1000
            const isVoting = votingEnds > now
            const isPassed = Number(p.yesCount) > Math.floor(Number(p.activeCount) / 2)
            const canExecute = !p.executed && !isVoting && isPassed && now >= executableAt
            const waitingTimelock = !p.executed && !isVoting && isPassed && now < executableAt
            
            let statusText = ''
            let statusColor = ''
            if (p.executed) {
              statusText = '✅ 已执行'
              statusColor = 'green'
            } else if (isVoting) {
              statusText = '⏳ 投票中'
              statusColor = 'blue'
            } else if (canExecute) {
              statusText = '✅ 可执行'
              statusColor = 'green'
            } else if (waitingTimelock) {
              const waitHours = Math.ceil((executableAt - now) / (1000 * 60 * 60))
              statusText = `⏰ 等待 Timelock（${waitHours} 小时后可执行）`
              statusColor = 'orange'
            } else if (!isPassed) {
              statusText = '❌ 未通过'
              statusColor = 'red'
            } else {
              statusText = '⏳ 等待中'
              statusColor = 'gray'
            }
            
            return (
              <div key={i} className="proposal-item">
                <div className="row">
                  <span className="label">提案 #{i}</span>
                  <span className="value" style={{ color: statusColor, fontWeight: 'bold' }}>
                    {statusText}
                    {p.isMultiStep && ' (多步骤)'}
                  </span>
                </div>
                <div className="row">
                  <span className="label">赞成 / 反对</span>
                  <span className="value">
                    {p.yesCount} / {p.noCount}（需 &gt; {Math.floor(Number(p.activeCount) / 2)}）
                    {isPassed && !p.executed && <span style={{ color: 'green' }}> ✓</span>}
                  </span>
                </div>
                <div className="row">
                  <span className="label">目标</span>
                  <span className="value mono">{shortAddress(p.target, 10, 8)}</span>
                </div>
                {waitingTimelock && (
                  <div className="row">
                    <span className="label">可执行时间</span>
                    <span className="value">{new Date(executableAt).toLocaleString('zh-CN')}</span>
                  </div>
                )}
                {canExecute && (
                  <div className="row" style={{ marginTop: '8px' }}>
                    <button
                      className="btn primary"
                      onClick={() => {
                        setExecProposalId(String(i))
                        handleExecute()
                      }}
                      disabled={loadingExec}
                      style={{ fontSize: '0.9em', padding: '4px 12px' }}
                    >
                      {loadingExec ? '执行中...' : '立即执行'}
                    </button>
                  </div>
                )}
              </div>
            )
          })}
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
