// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./MerkleProof.sol";

/// @title MerkleDistributor 基于 Merkle Tree 的奖励分发（上线空投等）
/// @notice Gas 高效，用户按需领取；上线前 owner 设置 merkleRoot 并转入代币
contract MerkleDistributor {
    IERC20 public immutable token;
    address public owner;
    bytes32 public merkleRoot;
    uint256 public totalAmount;

    mapping(address => bool) public claimed;

    event Claimed(address indexed account, uint256 amount);
    event MerkleRootUpdated(bytes32 indexed newRoot, uint256 totalAmount);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        require(msg.sender == owner, "MerkleDistributor: not owner");
        _;
    }

    constructor(address _token) {
        require(_token != address(0), "MerkleDistributor: zero token");
        token = IERC20(_token);
        owner = msg.sender;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "MerkleDistributor: zero owner");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    /// @notice 设置 Merkle Root（仅 Owner，上线前设置）
    function setMerkleRoot(bytes32 _merkleRoot, uint256 _totalAmount) external onlyOwner {
        merkleRoot = _merkleRoot;
        totalAmount = _totalAmount;
        emit MerkleRootUpdated(_merkleRoot, _totalAmount);
    }

    /// @notice 领取奖励
    /// @param index 在 Merkle Tree 中的索引
    /// @param account 领取地址
    /// @param amount 奖励金额（token 最小单位）
    /// @param merkleProof Merkle 证明
    function claim(
        uint256 index,
        address account,
        uint256 amount,
        bytes32[] calldata merkleProof
    ) external {
        require(!claimed[account], "MerkleDistributor: already claimed");
        bytes32 node = keccak256(abi.encodePacked(index, account, amount));
        require(MerkleProof.verify(merkleProof, merkleRoot, node), "MerkleDistributor: invalid proof");
        claimed[account] = true;
        require(token.transfer(account, amount), "MerkleDistributor: transfer failed");
        emit Claimed(account, amount);
    }

    /// @notice 紧急提取（仅 Owner）
    function emergencyWithdraw() external onlyOwner {
        uint256 balance = token.balanceOf(address(this));
        require(balance > 0, "MerkleDistributor: zero balance");
        require(token.transfer(owner, balance), "MerkleDistributor: transfer failed");
    }
}
