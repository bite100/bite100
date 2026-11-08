// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @title NodeRegistry 节点钱包绑定注册表
/// @notice 节点 ID => 奖励钱包映射，用于上线奖励分发、防作弊、可验证
contract NodeRegistry {
    address public owner;

    /// @notice nodeId (keccak256(peerId)) => 奖励接收钱包
    mapping(bytes32 => address) public nodeToWallet;
    /// @notice 钱包 => nodeId，用于限制一钱包最多绑一节点（防 Sybil 可选）
    mapping(address => bytes32) public walletToNode;
    /// @notice 注册时间
    mapping(bytes32 => uint256) public registrationTime;

    event NodeRegistered(bytes32 indexed nodeId, address indexed wallet, uint256 timestamp);
    event NodeUpdated(bytes32 indexed nodeId, address indexed oldWallet, address indexed newWallet);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        require(msg.sender == owner, "NodeRegistry: not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    /// @notice 注册节点钱包绑定（任意人可调用，通常由节点运营者用其钱包调用）
    /// @param nodeId 节点 ID 的 hash（如 keccak256(abi.encodePacked(peerId))）
    /// @param wallet 奖励接收钱包地址
    function register(bytes32 nodeId, address wallet) external {
        require(wallet != address(0), "NodeRegistry: zero wallet");
        require(nodeToWallet[nodeId] == address(0), "NodeRegistry: already registered");
        bytes32 existing = walletToNode[wallet];
        require(existing == bytes32(0) || existing == nodeId, "NodeRegistry: wallet bound to other node");

        nodeToWallet[nodeId] = wallet;
        walletToNode[wallet] = nodeId;
        registrationTime[nodeId] = block.timestamp;

        emit NodeRegistered(nodeId, wallet, block.timestamp);
    }

    /// @notice 更新节点绑定的钱包（仅当前绑定的钱包或 owner 可调用）
    /// @param nodeId 节点 ID
    /// @param newWallet 新钱包地址
    function updateWallet(bytes32 nodeId, address newWallet) external {
        require(newWallet != address(0), "NodeRegistry: zero wallet");
        address oldWallet = nodeToWallet[nodeId];
        require(oldWallet != address(0), "NodeRegistry: not registered");
        require(msg.sender == oldWallet || msg.sender == owner, "NodeRegistry: not auth");
        // 第 33 轮 N4：补 register() 已有的占用检查——新钱包已被其它节点
        // 占用时拒绝，否则 walletToNode 被覆盖后双向映射不一致（旧节点的
        // nodeToWallet 仍指向该钱包、反查却归本节点）。
        bytes32 existing = walletToNode[newWallet];
        require(existing == bytes32(0) || existing == nodeId, "NodeRegistry: wallet bound to other node");

        nodeToWallet[nodeId] = newWallet;
        walletToNode[oldWallet] = bytes32(0);
        walletToNode[newWallet] = nodeId;

        emit NodeUpdated(nodeId, oldWallet, newWallet);
    }

    /// @notice owner 可强制设置节点绑定（用于迁移或修复）
    /// @dev 第 33 轮 N4：写入非零钱包前同样做占用检查（与 register /
    /// updateWallet 同款）——目标钱包已被其它节点占用时拒绝，强制迁移须先
    /// 把该钱包从原节点解绑（setNodeWallet(原节点, 0) 或其 updateWallet），
    /// 不允许一次调用同时「偷」走反向映射。自身旧钱包的反向映射先完整清
    /// 除再写新映射，保持 nodeToWallet / walletToNode 双向恒一致。
    function setNodeWallet(bytes32 nodeId, address wallet) external onlyOwner {
        if (wallet != address(0)) {
            bytes32 existing = walletToNode[wallet];
            require(existing == bytes32(0) || existing == nodeId, "NodeRegistry: wallet bound to other node");
        }
        address oldWallet = nodeToWallet[nodeId];
        if (oldWallet != address(0)) {
            walletToNode[oldWallet] = bytes32(0);
        }
        if (wallet != address(0)) {
            nodeToWallet[nodeId] = wallet;
            walletToNode[wallet] = nodeId;
            registrationTime[nodeId] = block.timestamp;
        } else {
            delete nodeToWallet[nodeId];
            delete registrationTime[nodeId];
        }
        emit NodeUpdated(nodeId, oldWallet, wallet);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "NodeRegistry: zero address");
        owner = newOwner;
        emit OwnershipTransferred(msg.sender, newOwner);
    }
}
