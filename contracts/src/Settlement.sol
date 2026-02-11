// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./Vault.sol";
import "./FeeDistributor.sol";
import "./NodeRewards.sol";
import "./MerkleProof.sol";

/// @title Settlement 交易结算
/// @notice 根据链下撮合结果执行资产划转并收取手续费；0.01% 单边，买卖双方各自代币收取，每边最高等值 1 美元（由 feeCapPerToken 配置）。
/// @notice 当买卖双方无原生代币付 gas 时，可由交易所（relayer）代付；gas 费卖方买方均摊，从成交额中扣除后转给交易所。
contract Settlement {
    Vault public vault;
    FeeDistributor public feeDistributor;
    address public owner;
    address public governance;
    /// @notice 交易所/中继地址（兼容旧接口）：当有原生代币时代付 gas；与 isRelayer 白名单二选一或同时使用
    address public relayer;
    /// @notice Relayer 白名单：多 relayer 时可在此登记，调用 settleTrade 时 owner 或 relayer 或 isRelayer[msg.sender] 均可
    mapping(address => bool) public isRelayer;
    /// @notice 单笔 settleTrade 允许的 gas 报销上限（token 最小单位之和，gasReimburseIn + gasReimburseOut <= 此值）；0 表示不设上限，防滥用
    uint256 public maxGasReimbursePerTrade;

    uint16 public feeBps = 1; // 0.01%
    address public feeToken; // 保留，兼容旧接口
    /// @notice 每代币手续费上限（该代币最小单位），0 表示不设上限；如 USDC 6 位小数下 1e6 = 1 USD
    mapping(address => uint256) public feeCapPerToken;

    event TradeSettled(
        address indexed maker,
        address indexed taker,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 feeAmount
    );
    event TradeSettledWithGasReimburse(
        address indexed maker,
        address indexed taker,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 feeAmount,
        uint256 gasReimburseIn,
        uint256 gasReimburseOut,
        address indexed gasRecipient
    );
    event FeeBpsSet(uint16 oldBps, uint16 newBps);
    event FeeTokenSet(address indexed token);
    event FeeCapSet(address indexed token, uint256 cap);
    event RelayerSet(address indexed relayer);
    event RelayerAllowedSet(address indexed account, bool allowed);
    event MaxGasReimbursePerTradeSet(uint256 oldCap, uint256 newCap);
    event GovernanceSet(address indexed governance);
    event TradesBatchSettledWithMerkle(uint256 indexed batchId, bytes32 merkleRoot, uint256 count);
    event GasSavingsDistributed(uint256 userRebateUsdt, uint256 toFeeDistributorUsdt, uint256 toFounderUsdt);

    address public nodeRewards;
    address public founder;
    address public usdtToken;

    modifier onlyOwner() {
        require(msg.sender == owner, "Settlement: not owner");
        _;
    }

    modifier onlyOwnerOrGovernance() {
        require(msg.sender == owner || (governance != address(0) && msg.sender == governance), "Settlement: not auth");
        _;
    }

    constructor(address _vault, address _feeDistributor) {
        require(_vault != address(0) && _feeDistributor != address(0), "Settlement: zero address");
        vault = Vault(_vault);
        feeDistributor = FeeDistributor(_feeDistributor);
        owner = msg.sender;
    }

    /// @notice 设置手续费率（万分比，1 = 0.01%）；owner 或 governance 可调用
    function setFeeBps(uint16 _feeBps) external onlyOwnerOrGovernance {
        require(_feeBps <= 1000, "Settlement: fee too high"); // max 10%
        uint16 old = feeBps;
        feeBps = _feeBps;
        emit FeeBpsSet(old, _feeBps);
    }

    /// @notice 设置某代币手续费上限（该代币最小单位），0 表示不设上限；如 USDC 6 位小数下 1e6 = 1 USD
    function setFeeCap(address token, uint256 cap) external onlyOwnerOrGovernance {
        feeCapPerToken[token] = cap;
        emit FeeCapSet(token, cap);
    }

    /// @notice 设置手续费收取代币（保留兼容）
    function setFeeToken(address _feeToken) external onlyOwnerOrGovernance {
        feeToken = _feeToken;
        emit FeeTokenSet(_feeToken);
    }

    function setGovernance(address _governance) external onlyOwner {
        governance = _governance;
        emit GovernanceSet(_governance);
    }

    /// @notice 设置交易所/中继地址（代付 gas 时接收均摊的 gas 费）；0 表示不启用代付；与 isRelayer 白名单兼容
    function setRelayer(address _relayer) external onlyOwner {
        relayer = _relayer;
        emit RelayerSet(_relayer);
    }

    /// @notice 设置 relayer 白名单（多 relayer 时使用）；仅 owner 可调用
    function setRelayerAllowed(address account, bool allowed) external onlyOwner {
        require(account != address(0), "Settlement: zero address");
        isRelayer[account] = allowed;
        emit RelayerAllowedSet(account, allowed);
    }

    /// @notice 设置单笔 settleTrade 的 gas 报销上限（token 最小单位之和）；0 表示不设上限
    function setMaxGasReimbursePerTrade(uint256 _cap) external onlyOwner {
        uint256 old = maxGasReimbursePerTrade;
        maxGasReimbursePerTrade = _cap;
        emit MaxGasReimbursePerTradeSet(old, _cap);
    }

    function setNodeRewards(address _nodeRewards) external onlyOwner {
        nodeRewards = _nodeRewards;
    }

    function setFounder(address _founder) external onlyOwner {
        founder = _founder;
    }

    /// @notice 设置 USDT 代币地址（用于 gas 节省减 fee 与分配）
    function setUsdtToken(address _usdtToken) external onlyOwner {
        usdtToken = _usdtToken;
    }

    /// @notice 检查调用者是否为授权结算方（owner、单一 relayer 或白名单 relayer）
    function _isSettlementCaller() internal view returns (bool) {
        return msg.sender == owner
            || (relayer != address(0) && msg.sender == relayer)
            || isRelayer[msg.sender];
    }

    /// @notice 内部：按给定 fee 执行单笔结算（供批量与 gas 节省逻辑复用）
    function _settleOne(
        address maker,
        address taker,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 feeIn,
        uint256 feeOut,
        uint256 gasReimburseIn,
        uint256 gasReimburseOut
    ) internal {
        require(amountIn >= feeIn + gasReimburseIn, "Settlement: amountIn < fee + gas");
        require(amountOut >= feeOut + gasReimburseOut, "Settlement: amountOut < fee + gas");
        address _feeDist = address(feeDistributor);
        address gasRecipient = (gasReimburseIn > 0 || gasReimburseOut > 0) ? msg.sender : address(0);
        uint256 takerReceives = amountIn - feeIn - gasReimburseIn;
        uint256 makerReceives = amountOut - feeOut - gasReimburseOut;

        vault.transferWithinVault(maker, taker, tokenIn, takerReceives);
        if (feeIn != 0 && _feeDist != address(0)) {
            vault.transferOut(maker, address(this), tokenIn, feeIn);
            require(IERC20(tokenIn).approve(_feeDist, feeIn), "Settlement: approve failed");
            FeeDistributor(_feeDist).receiveFee(tokenIn, feeIn);
        }
        if (gasReimburseIn != 0) vault.transferOut(maker, gasRecipient, tokenIn, gasReimburseIn);

        vault.transferWithinVault(taker, maker, tokenOut, makerReceives);
        if (feeOut != 0 && _feeDist != address(0)) {
            vault.transferOut(taker, address(this), tokenOut, feeOut);
            require(IERC20(tokenOut).approve(_feeDist, feeOut), "Settlement: approve failed");
            FeeDistributor(_feeDist).receiveFee(tokenOut, feeOut);
        }
        if (gasReimburseOut > 0) vault.transferOut(taker, gasRecipient, tokenOut, gasReimburseOut);

        if (gasReimburseIn > 0 || gasReimburseOut > 0) {
            emit TradeSettledWithGasReimburse(maker, taker, tokenIn, tokenOut, amountIn, amountOut, feeIn + feeOut, gasReimburseIn, gasReimburseOut, gasRecipient);
        } else {
            emit TradeSettled(maker, taker, tokenIn, tokenOut, amountIn, amountOut, feeIn + feeOut);
        }
    }

    /// @param maker 挂单方
    /// @param taker 吃单方
    /// @param tokenIn maker 卖出的代币
    /// @param tokenOut maker 买入的代币（即 taker 卖出）
    /// @param amountIn maker 卖出数量
    /// @param amountOut maker 得到数量（taker 卖出数量）
    /// @param gasReimburseIn 从 maker 侧（tokenIn）扣除给 gas 代付方的数量，卖方均摊的 gas 费（0 表示无代付）
    /// @param gasReimburseOut 从 taker 侧（tokenOut）扣除给 gas 代付方的数量，买方均摊的 gas 费（0 表示无代付）
    /// @notice 当 gasReimburseIn 或 gasReimburseOut 非 0 时，仅 owner 或 relayer 可调用，且 relayer 必须已设置；扣完交易费与 gas 费后再转给买家/卖家
    function settleTrade(
        address maker,
        address taker,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 gasReimburseIn,
        uint256 gasReimburseOut
    ) external {
        require(_isSettlementCaller(), "Settlement: not auth");
        bool withGas = gasReimburseIn > 0 || gasReimburseOut > 0;
        if (withGas && maxGasReimbursePerTrade > 0) {
            require(gasReimburseIn + gasReimburseOut <= maxGasReimbursePerTrade, "Settlement: gas reimburse cap");
        }
        require(maker != address(0) && taker != address(0), "Settlement: zero address");
        require(tokenIn != address(0) && tokenOut != address(0), "Settlement: zero token");
        require(amountIn > 0 && amountOut > 0, "Settlement: zero amount");

        uint16 _feeBps = feeBps;
        uint256 feeIn = (amountIn * _feeBps) / 10000;
        uint256 capIn = feeCapPerToken[tokenIn];
        if (capIn != 0 && feeIn > capIn) feeIn = capIn;
        uint256 feeOut = (amountOut * _feeBps) / 10000;
        uint256 capOut = feeCapPerToken[tokenOut];
        if (capOut != 0 && feeOut > capOut) feeOut = capOut;

        _settleOne(maker, taker, tokenIn, tokenOut, amountIn, amountOut, feeIn, feeOut, gasReimburseIn, gasReimburseOut);
    }

    /// @notice 批量结算多笔交易（节省 Gas）；参数数组长度需一致
    /// @param makers 挂单方数组
    /// @param takers 吃单方数组
    /// @param tokenIns maker 卖出的代币数组
    /// @param tokenOuts maker 买入的代币数组
    /// @param amountIns maker 卖出数量数组
    /// @param amountOuts maker 得到数量数组
    /// @param gasReimburseIns 从 maker 侧扣除的 gas 费数组（0 表示无代付）
    /// @param gasReimburseOuts 从 taker 侧扣除的 gas 费数组（0 表示无代付）
    function settleTradesBatch(
        address[] calldata makers,
        address[] calldata takers,
        address[] calldata tokenIns,
        address[] calldata tokenOuts,
        uint256[] calldata amountIns,
        uint256[] calldata amountOuts,
        uint256[] calldata gasReimburseIns,
        uint256[] calldata gasReimburseOuts
    ) external {
        require(_isSettlementCaller(), "Settlement: not auth");
        uint256 len = makers.length;
        require(
            len == takers.length &&
            len == tokenIns.length &&
            len == tokenOuts.length &&
            len == amountIns.length &&
            len == amountOuts.length &&
            len == gasReimburseIns.length &&
            len == gasReimburseOuts.length,
            "Settlement: length mismatch"
        );
        require(len > 0 && len <= 50, "Settlement: batch size 1-50");

        for (uint256 i = 0; i < len; i++) {
            // 通过外部调用复用 settleTrade 的校验与 gas 上限逻辑
            this.settleTrade(
                makers[i],
                takers[i],
                tokenIns[i],
                tokenOuts[i],
                amountIns[i],
                amountOuts[i],
                gasReimburseIns[i],
                gasReimburseOuts[i]
            );
        }
    }

    /// @notice 批量结算并分配 gas 节省：50% 减 fee 退用户，25% 进 FeeDistributor，25% 进 NodeRewards 创始人积分（按当时 USDT 价值）
    /// @param gasSavingsUsdt6 本次批量相对单笔结算节省的 gas 价值（USDT 6 位小数）；0 则不做分配
    /// 调用前 relayer 需 approve(settlement, gasSavingsUsdt6 * 50%)，用于 25% FD + 25% 创始人
    function settleTradesBatchWithGasSavings(
        address[] calldata makers,
        address[] calldata takers,
        address[] calldata tokenIns,
        address[] calldata tokenOuts,
        uint256[] calldata amountIns,
        uint256[] calldata amountOuts,
        uint256[] calldata gasReimburseIns,
        uint256[] calldata gasReimburseOuts,
        uint256 gasSavingsUsdt6
    ) external {
        require(_isSettlementCaller(), "Settlement: not auth");
        uint256 len = makers.length;
        require(
            len == takers.length &&
            len == tokenIns.length &&
            len == tokenOuts.length &&
            len == amountIns.length &&
            len == amountOuts.length &&
            len == gasReimburseIns.length &&
            len == gasReimburseOuts.length,
            "Settlement: length mismatch"
        );
        require(len > 0 && len <= 50, "Settlement: batch size 1-50");

        if (gasSavingsUsdt6 == 0) {
            for (uint256 i = 0; i < len; i++) {
                // gasSavingsUsdt6 为 0 时，直接复用单笔结算逻辑
                this.settleTrade(
                    makers[i], takers[i], tokenIns[i], tokenOuts[i],
                    amountIns[i], amountOuts[i], gasReimburseIns[i], gasReimburseOuts[i]
                );
            }
            return;
        }

        address _usdt = usdtToken;
        uint16 _feeBps = feeBps;
        uint256 totalFeeUsdt;
        uint256[] memory feeIns = new uint256[](len);
        uint256[] memory feeOuts = new uint256[](len);

        for (uint256 i = 0; i < len; i++) {
            require(makers[i] != address(0) && takers[i] != address(0), "Settlement: zero address");
            require(tokenIns[i] != address(0) && tokenOuts[i] != address(0), "Settlement: zero token");
            require(amountIns[i] > 0 && amountOuts[i] > 0, "Settlement: zero amount");
            if (gasReimburseIns[i] + gasReimburseOuts[i] > 0 && maxGasReimbursePerTrade > 0) {
                require(gasReimburseIns[i] + gasReimburseOuts[i] <= maxGasReimbursePerTrade, "Settlement: gas reimburse cap");
            }
            uint256 feeIn = (amountIns[i] * _feeBps) / 10000;
            uint256 capIn = feeCapPerToken[tokenIns[i]];
            if (capIn != 0 && feeIn > capIn) feeIn = capIn;
            uint256 feeOut = (amountOuts[i] * _feeBps) / 10000;
            uint256 capOut = feeCapPerToken[tokenOuts[i]];
            if (capOut != 0 && feeOut > capOut) feeOut = capOut;
            feeIns[i] = feeIn;
            feeOuts[i] = feeOut;
            if (_usdt != address(0)) {
                if (tokenIns[i] == _usdt) totalFeeUsdt += feeIn;
                if (tokenOuts[i] == _usdt) totalFeeUsdt += feeOut;
            }
        }

        uint256 userRebateUsdt;
        if (_usdt != address(0) && totalFeeUsdt > 0) {
            userRebateUsdt = (gasSavingsUsdt6 * 50) / 100;
            if (userRebateUsdt > totalFeeUsdt) userRebateUsdt = totalFeeUsdt;
            for (uint256 i = 0; i < len; i++) {
                uint256 feeInUsdt = tokenIns[i] == _usdt ? feeIns[i] : 0;
                uint256 feeOutUsdt = tokenOuts[i] == _usdt ? feeOuts[i] : 0;
                uint256 part = feeInUsdt + feeOutUsdt;
                if (part == 0 || totalFeeUsdt == 0) continue;
                uint256 deduct = (userRebateUsdt * part) / totalFeeUsdt;
                uint256 deductIn = (deduct * feeInUsdt) / part;
                uint256 deductOut = deduct - deductIn;
                if (feeInUsdt >= deductIn) feeIns[i] -= deductIn; else feeIns[i] = 0;
                if (feeOutUsdt >= deductOut) feeOuts[i] -= deductOut; else feeOuts[i] = 0;
            }
        }

        for (uint256 i = 0; i < len; i++) {
            _settleOne(
                makers[i], takers[i], tokenIns[i], tokenOuts[i],
                amountIns[i], amountOuts[i], feeIns[i], feeOuts[i],
                gasReimburseIns[i], gasReimburseOuts[i]
            );
        }

        uint256 toFD = (gasSavingsUsdt6 * 25) / 100;
        uint256 toFounder = (gasSavingsUsdt6 * 25) / 100;
        if (toFD + toFounder > 0 && _usdt != address(0) && address(feeDistributor) != address(0) && nodeRewards != address(0) && founder != address(0)) {
            require(IERC20(_usdt).transferFrom(msg.sender, address(this), toFD + toFounder), "Settlement: gas savings transfer");
            if (toFD > 0) {
                require(IERC20(_usdt).approve(address(feeDistributor), toFD), "Settlement: approve FD");
                feeDistributor.receiveFee(_usdt, toFD);
            }
            if (toFounder > 0) {
                require(IERC20(_usdt).approve(nodeRewards, toFounder), "Settlement: approve NR");
                NodeRewards(nodeRewards).depositFounderReward(founder, toFounder);
            }
            emit GasSavingsDistributed(userRebateUsdt, toFD, toFounder);
        }
    }

    /// @notice 批量结算带默克尔根验证（便于审计）；先验证默克尔根，再批量结算
    /// @param batchId 批次 ID（用于事件索引）
    /// @param merkleRoot 所有 Trade 的默克尔根
    /// @param makers 挂单方数组
    /// @param takers 吃单方数组
    /// @param tokenIns maker 卖出的代币数组
    /// @param tokenOuts maker 买入的代币数组
    /// @param amountIns maker 卖出数量数组
    /// @param amountOuts maker 得到数量数组
    /// @param gasReimburseIns 从 maker 侧扣除的 gas 费数组
    /// @param gasReimburseOuts 从 taker 侧扣除的 gas 费数组
    /// @param proofs 每个 Trade 的默克尔证明数组（proofs[i] 对应第 i 个 Trade）
    function settleTradesBatchWithMerkle(
        uint256 batchId,
        bytes32 merkleRoot,
        address[] calldata makers,
        address[] calldata takers,
        address[] calldata tokenIns,
        address[] calldata tokenOuts,
        uint256[] calldata amountIns,
        uint256[] calldata amountOuts,
        uint256[] calldata gasReimburseIns,
        uint256[] calldata gasReimburseOuts,
        bytes32[][] calldata proofs
    ) external {
        require(_isSettlementCaller(), "Settlement: not auth");
        uint256 len = makers.length;
        require(
            len == takers.length &&
            len == tokenIns.length &&
            len == tokenOuts.length &&
            len == amountIns.length &&
            len == amountOuts.length &&
            len == gasReimburseIns.length &&
            len == gasReimburseOuts.length &&
            len == proofs.length,
            "Settlement: length mismatch"
        );
        require(len > 0 && len <= 50, "Settlement: batch size 1-50");

        // 验证每个 Trade 的默克尔证明
        for (uint256 i = 0; i < len; i++) {
            bytes32 leaf = keccak256(abi.encodePacked(
                makers[i],
                takers[i],
                tokenIns[i],
                tokenOuts[i],
                amountIns[i],
                amountOuts[i],
                gasReimburseIns[i],
                gasReimburseOuts[i]
            ));
            require(MerkleProof.verify(proofs[i], merkleRoot, leaf), "Settlement: invalid merkle proof");
        }

        // 验证通过后批量结算，复用单笔结算逻辑
        for (uint256 i = 0; i < len; i++) {
            this.settleTrade(
                makers[i],
                takers[i],
                tokenIns[i],
                tokenOuts[i],
                amountIns[i],
                amountOuts[i],
                gasReimburseIns[i],
                gasReimburseOuts[i]
            );
        }

        emit TradesBatchSettledWithMerkle(batchId, merkleRoot, len);
    }
}
