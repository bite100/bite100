package match

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/P2P-P2P/p2p/node/internal/storage"
)

// ConsensusMode 共识模式
type ConsensusMode string

const (
	ConsensusModeBFT ConsensusMode = "bft"
	ConsensusModeRaft ConsensusMode = "raft"
)

// MatchProposal 撮合提案（方案 C）
type MatchProposal struct {
	ProposalID   string          `json:"proposalId"`   // 提案 ID（订单 ID + 时间戳）
	Order        *storage.Order  `json:"order"`        // 待撮合订单
	Trades       []*storage.Trade `json:"trades"`      // 撮合结果
	OrderbookHash string         `json:"orderbookHash"` // 订单簿状态哈希
	Timestamp    int64           `json:"timestamp"`    // 提案时间
	LeaderID     string          `json:"leaderId"`     // 主节点 PeerID
	Signature    string          `json:"signature"`     // 主节点签名（可选）
}

// ConsensusVote 共识投票（方案 C）
type ConsensusVote struct {
	ProposalID  string `json:"proposalId"`  // 提案 ID
	VoterID     string `json:"voterId"`      // 投票节点 PeerID
	VoteType    string `json:"voteType"`     // "prevote" | "precommit"
	Result      bool   `json:"result"`       // true=通过, false=拒绝
	Reason      string `json:"reason"`       // 拒绝原因（可选）
	Timestamp   int64  `json:"timestamp"`    // 投票时间
	Signature   string `json:"signature"`     // 投票节点签名（可选）
}

// ConsensusEngine 共识引擎（方案 C：BFT 共识）
type ConsensusEngine struct {
	mu            sync.RWMutex
	mode          ConsensusMode
	localPeerID   string
	nodes         []string // 共识节点列表
	currentLeader string   // 当前 Leader
	term          int64    // 当前任期
	
	// 提案状态
	proposals     map[string]*ProposalState // proposalID -> 状态
	prevotes      map[string]map[string]*ConsensusVote // proposalID -> voterID -> vote
	precommits    map[string]map[string]*ConsensusVote // proposalID -> voterID -> vote
	
	// 订单簿同步
	orderbookHash string // 当前订单簿哈希
	
	// 回调
	onProposal func(*MatchProposal) error // 处理提案
	onCommit   func(*MatchProposal) error  // 提交提案
	publish    func(topic string, data []byte) error
}

// ProposalState 提案状态
type ProposalState struct {
	Proposal   *MatchProposal
	Prevotes   map[string]*ConsensusVote
	Precommits map[string]*ConsensusVote
	Committed  bool
}

// NewConsensusEngine 创建共识引擎
func NewConsensusEngine(mode ConsensusMode, localPeerID string, nodes []string, publish func(topic string, data []byte) error) *ConsensusEngine {
	return &ConsensusEngine{
		mode:        mode,
		localPeerID: localPeerID,
		nodes:       nodes,
		proposals:   make(map[string]*ProposalState),
		prevotes:    make(map[string]map[string]*ConsensusVote),
		precommits:  make(map[string]map[string]*ConsensusVote),
		publish:     publish,
	}
}

// Start 启动共识引擎
func (c *ConsensusEngine) Start() error {
	log.Printf("[consensus] 启动共识引擎 mode=%s nodes=%d", c.mode, len(c.nodes))
	
	// 选举初始 Leader
	c.electLeader()
	
	// 启动 Leader 心跳（如果自己是 Leader）
	if c.isLeader() {
		go c.leaderHeartbeat()
	}
	
	return nil
}

// isLeader 检查是否是 Leader
func (c *ConsensusEngine) isLeader() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.currentLeader == c.localPeerID
}

// electLeader 选举 Leader（简单轮询，实际应该用 Raft）
func (c *ConsensusEngine) electLeader() {
	c.mu.Lock()
	defer c.mu.Unlock()
	
	if len(c.nodes) == 0 {
		c.currentLeader = c.localPeerID
		return
	}
	
	// 简单选择第一个节点作为 Leader
	c.currentLeader = c.nodes[0]
	c.term++
	log.Printf("[consensus] 选举 Leader: %s (term=%d)", c.currentLeader, c.term)
}

// leaderHeartbeat Leader 心跳
func (c *ConsensusEngine) leaderHeartbeat() {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	
	for range ticker.C {
		if !c.isLeader() {
			return
		}
		// 发送心跳（可选）
	}
}

// ProposeMatch 提出撮合提案（Leader 调用）
func (c *ConsensusEngine) ProposeMatch(order *storage.Order, trades []*storage.Trade, orderbookHash string) error {
	if !c.isLeader() {
		return fmt.Errorf("not leader")
	}
	
	proposalID := fmt.Sprintf("%s-%d", order.OrderID, time.Now().UnixNano())
	proposal := &MatchProposal{
		ProposalID:    proposalID,
		Order:         order,
		Trades:        trades,
		OrderbookHash: orderbookHash,
		Timestamp:     time.Now().Unix(),
		LeaderID:      c.localPeerID,
	}
	
	c.mu.Lock()
	c.proposals[proposalID] = &ProposalState{
		Proposal:   proposal,
		Prevotes:   make(map[string]*ConsensusVote),
		Precommits: make(map[string]*ConsensusVote),
		Committed:  false,
	}
	c.prevotes[proposalID] = make(map[string]*ConsensusVote)
	c.precommits[proposalID] = make(map[string]*ConsensusVote)
	c.mu.Unlock()
	
	// 广播提案
	data, _ := json.Marshal(proposal)
	topic := "/p2p-exchange/consensus/propose"
	if err := c.publish(topic, data); err != nil {
		return err
	}
	
	log.Printf("[consensus] 提出提案 proposalID=%s orderID=%s", proposalID, order.OrderID)
	return nil
}

// HandleProposal 处理收到的提案（从节点调用）
func (c *ConsensusEngine) HandleProposal(proposal *MatchProposal) error {
	if proposal == nil || proposal.ProposalID == "" {
		return fmt.Errorf("invalid proposal")
	}
	
	// 验证提案（检查签名、订单有效性等）
	if err := c.validateProposal(proposal); err != nil {
		log.Printf("[consensus] 提案验证失败: %v", err)
		return err
	}
	
	// 投票（PreVote）
	vote := &ConsensusVote{
		ProposalID: proposal.ProposalID,
		VoterID:    c.localPeerID,
		VoteType:   "prevote",
		Result:     true,
		Timestamp:  time.Now().Unix(),
	}
	
	c.mu.Lock()
	if _, ok := c.proposals[proposal.ProposalID]; !ok {
		c.proposals[proposal.ProposalID] = &ProposalState{
			Proposal:   proposal,
			Prevotes:   make(map[string]*ConsensusVote),
			Precommits: make(map[string]*ConsensusVote),
			Committed:  false,
		}
		c.prevotes[proposal.ProposalID] = make(map[string]*ConsensusVote)
		c.precommits[proposal.ProposalID] = make(map[string]*ConsensusVote)
	}
	c.prevotes[proposal.ProposalID][c.localPeerID] = vote
	c.mu.Unlock()
	
	// 广播 PreVote
	data, _ := json.Marshal(vote)
	topic := "/p2p-exchange/consensus/prevote"
	_ = c.publish(topic, data)
	
	log.Printf("[consensus] 投票 PreVote proposalID=%s", proposal.ProposalID)
	
	// 检查是否达到 2f+1 PreVote
	c.checkPreVoteThreshold(proposal.ProposalID)
	
	return nil
}

// HandleVote 处理投票
func (c *ConsensusEngine) HandleVote(vote *ConsensusVote) error {
	if vote == nil || vote.ProposalID == "" {
		return fmt.Errorf("invalid vote")
	}
	
	c.mu.Lock()
	defer c.mu.Unlock()
	
	if vote.VoteType == "prevote" {
		if _, ok := c.prevotes[vote.ProposalID]; !ok {
			c.prevotes[vote.ProposalID] = make(map[string]*ConsensusVote)
		}
		c.prevotes[vote.ProposalID][vote.VoterID] = vote
		
		// 检查是否达到 2f+1 PreVote
		c.checkPreVoteThresholdLocked(vote.ProposalID)
	} else if vote.VoteType == "precommit" {
		if _, ok := c.precommits[vote.ProposalID]; !ok {
			c.precommits[vote.ProposalID] = make(map[string]*ConsensusVote)
		}
		c.precommits[vote.ProposalID][vote.VoterID] = vote
		
		// 检查是否达到 2f+1 PreCommit
		c.checkPreCommitThresholdLocked(vote.ProposalID)
	}
	
	return nil
}

// checkPreVoteThreshold 检查是否达到 2f+1 PreVote（需要锁）
func (c *ConsensusEngine) checkPreVoteThreshold(proposalID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.checkPreVoteThresholdLocked(proposalID)
}

// checkPreVoteThresholdLocked 检查是否达到 2f+1 PreVote（已持锁）
func (c *ConsensusEngine) checkPreVoteThresholdLocked(proposalID string) {
	prevotes := c.prevotes[proposalID]
	if len(prevotes) < c.quorumSize() {
		return
	}
	
	// 达到阈值，发送 PreCommit
	vote := &ConsensusVote{
		ProposalID: proposalID,
		VoterID:    c.localPeerID,
		VoteType:   "precommit",
		Result:     true,
		Timestamp:  time.Now().Unix(),
	}
	
	if _, ok := c.precommits[proposalID]; !ok {
		c.precommits[proposalID] = make(map[string]*ConsensusVote)
	}
	c.precommits[proposalID][c.localPeerID] = vote
	
	// 广播 PreCommit
	data, _ := json.Marshal(vote)
	topic := "/p2p-exchange/consensus/precommit"
	go func() {
		_ = c.publish(topic, data)
	}()
	
	log.Printf("[consensus] 发送 PreCommit proposalID=%s", proposalID)
	
	// 检查是否达到 2f+1 PreCommit
	c.checkPreCommitThresholdLocked(proposalID)
}

// checkPreCommitThresholdLocked 检查是否达到 2f+1 PreCommit（已持锁）
func (c *ConsensusEngine) checkPreCommitThresholdLocked(proposalID string) {
	precommits := c.precommits[proposalID]
	if len(precommits) < c.quorumSize() {
		return
	}
	
	// 达到阈值，提交提案
	state, ok := c.proposals[proposalID]
	if !ok || state.Committed {
		return
	}
	
	state.Committed = true
	log.Printf("[consensus] 提交提案 proposalID=%s", proposalID)
	
	// 调用回调
	if c.onCommit != nil {
		go func() {
			_ = c.onCommit(state.Proposal)
		}()
	}
}

// quorumSize 计算法定人数（2f+1，f 为最大容错节点数）
func (c *ConsensusEngine) quorumSize() int {
	n := len(c.nodes)
	if n == 0 {
		return 1
	}
	f := (n - 1) / 3
	return 2*f + 1
}

// validateProposal 验证提案
func (c *ConsensusEngine) validateProposal(proposal *MatchProposal) error {
	if proposal.LeaderID != c.currentLeader {
		return fmt.Errorf("invalid leader")
	}
	if proposal.Order == nil {
		return fmt.Errorf("order is nil")
	}
	// TODO: 验证签名、订单有效性等
	return nil
}

// UpdateOrderbookHash 更新订单簿哈希
func (c *ConsensusEngine) UpdateOrderbookHash(pair string, bids, asks []*storage.Order) {
	// 计算订单簿哈希
	data := fmt.Sprintf("%s-%d-%d", pair, len(bids), len(asks))
	hash := sha256.Sum256([]byte(data))
	hashStr := fmt.Sprintf("%x", hash)
	
	c.mu.Lock()
	c.orderbookHash = hashStr
	c.mu.Unlock()
}

// GetOrderbookHash 获取订单簿哈希
func (c *ConsensusEngine) GetOrderbookHash() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.orderbookHash
}

// GetLeader 获取当前 Leader
func (c *ConsensusEngine) GetLeader() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.currentLeader
}

// SetOnProposal 设置提案处理回调
func (c *ConsensusEngine) SetOnProposal(fn func(*MatchProposal) error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.onProposal = fn
}

// SetOnCommit 设置提交回调
func (c *ConsensusEngine) SetOnCommit(fn func(*MatchProposal) error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.onCommit = fn
}
