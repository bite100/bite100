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
  const [createSnapshotId, setCreateSnapshotId] = useState('')
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
              // 合约字段序：[7]=executableAt、[8]=executed（第 32 轮随 ABI 一并对正，此前两处写反）
              executed: Boolean(p[8]),
              executableAt: String(p[7] ?? 0),
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
                // 合约字段序：[8]=executableAt、[9]=executed（第 32 轮对正）
                executed: Boolean(mp[9]),
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
      setError('proof 需为 JSON 数组。原用于生成 proof 的节点工具已随节点退役，活跃集证明的产出路径正在重整，目前暂时无法自助生成（见页面上方「当前状态」说明）')
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
    // 第 61 轮起：提案只能引用治理管理员已发布上链的活跃集快照编号，
    // 前端不再接受自填 Merkle 根/人数（合约侧同样拒绝自带名单）。
    const snapshotId = parseInt(createSnapshotId.trim(), 10)
    if (createSnapshotId.trim() === '' || Number.isNaN(snapshotId) || snapshotId < 0) {
      setError('请填写活跃集快照编号（治理管理员发布快照后会公布编号）。没有可用快照时创建提案不可用（见页面上方「当前状态」说明）')
      return
    }
    const feeBps = feePercentToBps(createFeePercent)
    if (feeBps === null) {
      setError('手续费比例需在 0.01～100 之间')
      return
    }
    const feeNum = parseFloat(createFeePercent)
    if (Number.isNaN(feeNum) || feeNum <= 0 || feeNum > 100) {
      setError('手续费比例需在 0.01～100 之间')
      return
    }
    setError(null)
    setLoadingCreate(true)
    try {
      // 提交前先链上核对快照存在，避免对未发布编号白付 gas
      const provider = getProvider()
      if (provider) {
        const govRead = new Contract(GOVERNANCE_ADDRESS, GOVERNANCE_ABI, provider)
        const snap = await govRead.getSnapshot(snapshotId)
        if (!snap || !snap[4]) {
          setError(`快照 #${snapshotId} 尚未发布，请向治理管理员确认本期快照编号后再提交`)
          setLoadingCreate(false)
          return
        }
      }
      const iface = new Interface(['function setFeeBps(uint16)'])
      const callData = iface.encodeFunctionData('setFeeBps', [feeBps])
      await withSigner((gov) => gov.createProposal(SETTLEMENT_ADDRESS, callData, snapshotId).then((tx) => tx.wait()))
      await fetchProposals()
      setCreateSnapshotId('')
    } catch (e) {
      setError(formatError(e))
    } finally {
      setLoadingCreate(false)
    }
  }, [account, createFeePercent, createSnapshotId, fetchProposals, withSigner])

  if (!isGovDeployed()) {
    return (
      <div className="card vault-section">
        <h2>治理</h2>
        <p className="hint">治理合约尚未在当前链部署，治理功能暂不可用。部署后可在此查看提案、投票并执行已通过的提案。</p>
      </div>
    )
  }

  return (
    <div className="card vault-section governance-section">
      <h2>治理</h2>
      <p className="hint">治理用于调整交易手续费等协议参数。流程：创建提案 → 投票期 7 天 → 支持票超过活跃集人数一半即通过 → 经过 2 天时间锁 → 执行生效。活跃集是按贡献选出的投票成员名单。名单由治理管理员按周期在链下统计后折成 Merkle 根、连同人数一起发布为链上「快照」并固定下来；提案只能引用已发布快照的编号，不能自带名单（防止有人自选一份只有自己的名单把提案投过）。只有名单内成员可以投票（一人一票），投票时需提交一份证明（proof）向合约证明自己在名单内——链上只保存名单的 Merkle 根、不保存完整名单，所以需要这份证明。</p>
      <p className="hint">当前状态：暂无提案。活跃集名单的新产出路径为「链下贡献计量 → 治理管理员发布快照」：本期快照尚未发布前，创建提案不可用；成员投票用的 proof 仍需由名单产出方随快照一并发放，目前暂不能自助生成。提案列表查看、已通过提案的执行不受影响。</p>

      <h3 className="gov-sub">
        提案列表
        <label style={{ marginLeft: '1rem', fontSize: '0.75rem', color: '#71717a', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
            style={{ marginRight: '0.25rem' }}
          />
          自动刷新（每 30 秒）
        </label>
      </h3>
      {loading && <p className="hint">加载中…</p>}
      {!loading && proposals.length === 0 && <p className="hint">暂无提案</p>}
      {!loading && proposals.length > 0 && (
        <>
          <div className="proposal-list">
            {proposals
              .slice((currentPage - 1) * proposalsPerPage, currentPage * proposalsPerPage)
              .map((p, i) => {
                const actualIndex = (currentPage - 1) * proposalsPerPage + i
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
                  statusText = '已执行'
                  statusColor = 'green'
                } else if (isVoting) {
                  statusText = '投票中'
                  statusColor = 'blue'
                } else if (canExecute) {
                  statusText = '可执行'
                  statusColor = 'green'
                } else if (waitingTimelock) {
                  const waitHours = Math.ceil((executableAt - now) / (1000 * 60 * 60))
                  statusText = `时间锁等待中（约 ${waitHours} 小时后可执行）`
                  statusColor = 'orange'
                } else if (!isPassed) {
                  statusText = '未通过'
                  statusColor = 'red'
                } else {
                  statusText = '待处理'
                  statusColor = 'gray'
                }

                return (
                  <div key={actualIndex} className="proposal-item">
                    <div className="row">
                      <span className="label">提案 #{actualIndex}</span>
                      <span className="value" style={{ color: statusColor, fontWeight: 'bold' }}>
                        {statusText}
                        {p.isMultiStep && '（多步骤提案）'}
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
                          {loadingExec && parseInt(execProposalId, 10) === actualIndex ? '执行中…' : '立即执行'}
                        </button>
                      </div>
                    )}
                  </div>
                )
              })}
          </div>
          {proposals.length > proposalsPerPage && (
            <div
              style={{
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                gap: '0.5rem',
                marginTop: '1rem',
              }}
            >
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
        {loading ? '刷新中…' : '刷新'}
      </button>

      <h3 className="gov-sub">投票</h3>
      <p className="hint">怎么投票：连接钱包，在「投票中」的提案卡片上点「支持」或「反对」即可，前提是当前账户在活跃集内，且投票时要提交一份 proof（活跃集证明）。原生成该证明的节点工具已随节点退役，证明的产出路径正在重整，目前暂时无法自助生成证明（见上方「当前状态」说明）；下方「高级：手动填写 proof」只适用于已经持有证明的情况。不在活跃集内的地址无法投票。</p>
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
            支持
          </label>
        </div>
        <button className="btn secondary" onClick={() => { const id = parseInt(voteProposalId, 10); if (!Number.isNaN(id)) handleVote(id, voteSupport) }} disabled={loadingVote || !account}>
          {loadingVote ? '处理中…' : '投票'}
        </button>
      </details>

      <h3 className="gov-sub">执行</h3>
      <p className="hint">执行已通过的提案：填写提案 ID 后点「执行」。前提：投票期已结束、支持票过半，且 2 天时间锁已到期（提案卡片状态显示「可执行」）。任何连接钱包的账户都可以执行，不限于提案创建者。</p>
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
      <p className="hint">当前模板：调整交易手续费。前提：治理管理员已发布本期活跃集快照并公布编号（没有快照就无法创建，这是为了防止自选投票名单）。步骤：填新手续费比例 → 填快照编号 → 提交并在钱包确认。注意：提案会绑定所填快照的名单与人数，提交后进入 7 天投票期、内容不可修改；同一参数在提案执行后一周内不可重复创建。</p>
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
          <p className="proposal-preview">本提案将把交易手续费调整为 {createFeePercent}%</p>
        )}
        <div className="form-group">
          <label>活跃集快照编号</label>
          <input
            type="number"
            min="0"
            step="1"
            placeholder="如 0（以治理管理员公布的本期编号为准）"
            value={createSnapshotId}
            onChange={(e) => setCreateSnapshotId(e.target.value)}
            className="input"
          />
        </div>
        <button className="btn primary" onClick={handleCreate} disabled={loadingCreate || !account}>
          {loadingCreate ? '处理中…' : '提交提案'}
        </button>
      </div>

      {error && <p className="error">{error}</p>}
    </div>
  )
}
