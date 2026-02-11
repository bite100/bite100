import { useState, useEffect, useCallback } from 'react'
import { Contract, Interface } from 'ethers'
import { GOVERNANCE_ADDRESS, SETTLEMENT_ADDRESS, GOVERNANCE_ABI } from './config'
import { getProvider, shortAddress, withSigner as withSignerUtil, formatError } from './utils'
import { feePercentToBps } from './services/governanceUtils'

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
  const [currentPage, setCurrentPage] = useState(1)
  const [proposalsPerPage] = useState(10)
  const [votingWeights, setVotingWeights] = useState<Map<number, { yes: bigint; no: bigint }>>(new Map())
  // Vote form
  const [voteProposalId, setVoteProposalId] = useState('0')
  const [voteSupport, setVoteSupport] = useState(true)
  const [voteProof, setVoteProof] = useState('[]')
  const [loadingVote, setLoadingVote] = useState(false)
  // Execute form
  const [execProposalId, setExecProposalId] = useState('0')
  const [loadingExec, setLoadingExec] = useState(false)
  // Create form (setFeeBps preset)
  const [createFeePercent, setCreateFeePercent] = useState('0.08') // 手续费%，如 0.08 = 0.08%
  const [createMerkleRoot, setCreateMerkleRoot] = useState('')
  const [createActiveCount, setCreateActiveCount] = useState('1')
  const [loadingCreate, setLoadingCreate] = useState(false)
  const [autoRefresh, setAutoRefresh] = useState(true)

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
    if (account && isGovDeployed()) {
      fetchProposals()
      // 实时更新投票状态
      if (autoRefresh) {
        const interval = setInterval(() => {
          fetchProposals()
        }, 30000) // 每30秒更新一次
        return () => clearInterval(interval)
      }
    }
  }, [account, fetchProposals, autoRefresh])

  // 计算投票权重
  useEffect(() => {
    if (!proposals.length) return
    const weights = new Map<number, { yes: bigint; no: bigint }>()
    proposals.forEach((p, i) => {
      weights.set(i, {
        yes: BigInt(p.yesCount),
        no: BigInt(p.noCount),
      })
    })
    setVotingWeights(weights)
  }, [proposals])

  const withSigner = useCallback(async <T,>(fn: (gov: Contract) => Promise<T>): Promise<T> => {
    return withSignerUtil((signer) => {
      const gov = new Contract(GOVERNANCE_ADDRESS, GOVERNANCE_ABI, signer)
      return fn(gov)
    })
  }, [])

  const handleVote = useCallback(async (proposalId: number, support: boolean) => {
    if (!account || !isGovDeployed()) return
    let proof: string[]
    try {
      proof = JSON.parse(voteProof) as string[]
    } catch {
      setError('proof 需为 JSON 数组。若在活跃集内，可先尝试 []；否则运行 merkletool -proof-for 您的地址 获取')
      return
    }
    setError(null)
    setVoteProposalId(String(proposalId))
    setVoteSupport(support)
    setLoadingVote(true)
    try {
      await withSigner((gov) => gov.vote(proposalId, support, proof).then((tx) => tx.wait()))
      await fetchProposals()
      setVoteProof('[]')
    } catch (e) {
      setError(formatError(e))
    } finally {
      setLoadingVote(false)
    }
  }, [account, voteProof, fetchProposals, withSigner])

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
    if (!root) {
      setError('请填写活跃集证明（merkleRoot），需先用 merkletool 生成')
      return
    }
    if (!/^0x[0-9a-f]{64}$/.test(root)) {
      setError('merkleRoot 格式错误，应为 0x 开头的 64 位十六进制字符串')
      return
    }
    const activeCount = parseInt(createActiveCount, 10)
    if (Number.isNaN(activeCount) || activeCount < 1) {
      setError('活跃集人数至少为 1，且必须为有效数字')
      return
    }
    if (activeCount > 10000) {
      setError('活跃集人数不能超过 10000')
      return
    }
    const feeBps = feePercentToBps(createFeePercent)
    if (feeBps === null) {
      setError('手续费比例需在 0.01～100 之间')
      return
    }
    const feeNum = parseFloat(createFeePercent)
    if (Number.isNaN(feeNum) || feeNum <= 0 || feeNum > 100) {
      setError('手续费比例必须在 0.01～100 之间')
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
  }, [account, createFeePercent, createMerkleRoot, createActiveCount, fetchProposals, withSigner])

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
      <p className="hint">查看提案、投票、执行。参与投票需在活跃集内，proof 由 merkletool 生成。</p>

      <h3 className="gov-sub">
        提案列表
        <label style={{ marginLeft: '1rem', fontSize: '0.75rem', color: '#71717a', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
            style={{ marginRight: '0.25rem' }}
          />
          自动刷新（30秒）
        </label>
      </h3>
      {loading ? (
        <p className="hint">加载中…</p>
      ) : proposals.length === 0 ? (
        <p className="hint">暂无提案</p>
      ) : (
        <>
          <div className="proposal-list">
            {proposals
              .slice((currentPage - 1) * proposalsPerPage, currentPage * proposalsPerPage)
              .map((p, i) => {
                const actualIndex = (currentPage - 1) * proposalsPerPage + i
                const weight = votingWeights.get(actualIndex)
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
                  <div key={actualIndex} className="proposal-item">
                    <div className="row">
                      <span className="label">提案 #{actualIndex}</span>
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
                    {weight && (
                      <div className="row">
                        <span className="label">投票权重</span>
                        <span className="value">
                          赞成：{weight.yes.toString()} | 反对：{weight.no.toString()}
                        </span>
                      </div>
                    )}
                <div className="row">
                  <span className="label">目标</span>
                  <span className="value mono">{shortAddress(p.target, 10, 8)}</span>
                </div>
                {isVoting && (
                  <div className="row vote-buttons-row">
                    <span className="label">投票</span>
                    <span className="value">
                      <button
                        type="button"
                        className="btn primary vote-btn vote-yes"
                        onClick={() => handleVote(actualIndex, true)}
                        disabled={loadingVote || !account}
                        title="请在钱包中确认，完成投票"
                      >
                        {loadingVote && parseInt(voteProposalId, 10) === actualIndex ? '处理中…' : '支持'}
                      </button>
                      <button
                        type="button"
                        className="btn secondary vote-btn vote-no"
                        onClick={() => handleVote(actualIndex, false)}
                        disabled={loadingVote || !account}
                        title="请在钱包中确认，完成投票"
                      >
                        {loadingVote && parseInt(voteProposalId, 10) === actualIndex ? '处理中…' : '反对'}
                      </button>
                    </span>
                  </div>
                )}
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
                        setExecProposalId(String(actualIndex))
                        handleExecute()
                      }}
                      disabled={loadingExec}
                      style={{ fontSize: '0.9em', padding: '4px 12px' }}
                    >
                      {loadingExec && parseInt(execProposalId, 10) === actualIndex ? '执行中...' : '立即执行'}
                    </button>
                  </div>
                )}
              </div>
            )
              })}
            </div>
          )}
          {proposals.length > proposalsPerPage && (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '0.5rem', marginTop: '1rem' }}>
              <button
                className="btn secondary"
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                disabled={currentPage === 1}
              >
                上一页
              </button>
              <span style={{ color: '#71717a', fontSize: '0.875rem' }}>
                第 {currentPage} / {Math.ceil(proposals.length / proposalsPerPage)} 页
              </span>
              <button
                className="btn secondary"
                onClick={() => setCurrentPage((p) => Math.min(Math.ceil(proposals.length / proposalsPerPage), p + 1))}
                disabled={currentPage >= Math.ceil(proposals.length / proposalsPerPage)}
              >
                下一页
              </button>
            </div>
          )}
        </>
      )}
      <button className="btn secondary" onClick={fetchProposals} disabled={loading} style={{ marginTop: '0.5rem' }}>
        {loading ? '刷新中…' : '手动刷新'}
      </button>

      <h3 className="gov-sub">投票</h3>
      <p className="hint">参与投票需在活跃集内。上方每个「投票中」的提案旁可直接点「支持」「反对」；若提示需 proof，请运行 <code>go run ./cmd/merkletool -proof-for 您的地址</code> 获取后粘贴下方。</p>
      <details className="vote-advanced">
        <summary>高级：手动填写 proof</summary>
        <textarea
          placeholder='proof JSON，如 [] 或 ["0x...","0x..."]'
          value={voteProof}
          onChange={(e) => setVoteProof(e.target.value)}
          className="input proof-input"
          rows={2}
        />
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
        <button className="btn secondary" onClick={() => { const id = parseInt(voteProposalId, 10); if (!Number.isNaN(id)) handleVote(id, voteSupport) }} disabled={loadingVote || !account}>
          {loadingVote ? '处理中…' : '投票'}
        </button>
      </details>

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

      <h3 className="gov-sub">创建提案</h3>
      <p className="hint">模板：调整手续费。填写手续费比例后，在下方高级选项中粘贴 merkletool 生成的证明。</p>
      <div className="proposal-create-form">
        <div className="form-group">
          <label>新手续费比例（%）</label>
          <input
            type="number"
            step="0.01"
            min="0.01"
            max="100"
            placeholder="如 0.08 表示 0.08%"
            value={createFeePercent}
            onChange={(e) => setCreateFeePercent(e.target.value)}
            className="input"
          />
        </div>
        {createFeePercent && !Number.isNaN(parseFloat(createFeePercent)) && parseFloat(createFeePercent) > 0 && parseFloat(createFeePercent) <= 100 && (
          <p className="proposal-preview">本提案将把手续费改为 {createFeePercent}%</p>
        )}
        <details className="proposal-create-advanced">
          <summary>高级：活跃集证明（需 merkletool 生成）</summary>
          <div className="input-row">
            <input
              type="number"
              placeholder="活跃集人数"
              value={createActiveCount}
              onChange={(e) => setCreateActiveCount(e.target.value)}
              className="input"
            />
          </div>
          <div className="input-row">
            <input
              type="text"
              placeholder="merkleRoot（0x + 64 位十六进制）"
              value={createMerkleRoot}
              onChange={(e) => setCreateMerkleRoot(e.target.value)}
              className="input"
            />
          </div>
        </details>
        <button className="btn primary" onClick={handleCreate} disabled={loadingCreate || !account}>
          {loadingCreate ? '处理中…' : '提交提案'}
        </button>
      </div>

      {error && <p className="error">{error}</p>}
    </div>
  )
}
