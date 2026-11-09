// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Settlement 订单结构镜像：字段顺序与 Settlement.Order 严格一致，
/// 供 Vault 调用 Settlement 的验签与摘要函数（ABI 元组编码相同）。
/// side 与 Settlement 同口径：0 = BUY（付 tokenOut）、1 = SELL（付 tokenIn），
/// 阶段 3 起为签名字段（docs/eip712-order-spec.md §2）。
struct VaultOrder {
    string orderId;
    address userAddress;
    address tokenIn;
    address tokenOut;
    uint256 amountIn;
    uint256 amountOut;
    uint256 price;
    uint256 timestamp;
    uint256 expiresAt;
    uint256 nonce;
    uint8 side;
}

/// @notice Vault 需要的 Settlement 只读接口（验签 + 订单摘要）
interface ISettlementVerifier {
    function orderDigest(VaultOrder calldata order) external view returns (bytes32);
    function verifyOrderSignature(VaultOrder calldata order, bytes calldata signature) external view returns (bool);
}

/// @title Vault 资产托管
/// @notice 用户存入/提取资产，仅 Settlement 可划转用于结算；挂单落锁后（第三十轮起
/// 无权限，见 lockForOrder），对应余额被锁定：不可提取、随成交消耗、撤单/过期释放
/// （设计见 docs/order-balance-locking.md、docs/nodeless-design-2026-11-07.md §4.2 L2）
/// @dev 第 33 轮安全加固（ChatGPT 复审 N1）：继承 OpenZeppelin ReentrancyGuard
/// （骑既有依赖，与 Settlement/MakerVault/Governance 同款）。凡函数体内含代币
/// 外部调用（transferFrom/transfer）或外部验签回调（lockForOrder 调
/// Settlement.verifyOrderSignature）的入口一律 nonReentrant，防恶意代币在
/// 回调中重入造成重复记账；纯账本内划转（transferWithinVault）无外部调用、
/// 无回调面，不加（理由见该函数注释）。
contract Vault is ReentrancyGuard {
    address public settlement;
    address public owner;

    /// user => token => balance（含锁定部分）
    mapping(address => mapping(address => uint256)) public balances;
    /// user => token => 已被挂单锁定的余额（恒 ≤ balances）
    mapping(address => mapping(address => uint256)) public locked;

    /// @notice 单笔订单的锁定记录，以订单 EIP-712 摘要为键
    struct OrderLock {
        address user;
        address token;
        uint256 remaining;
        uint256 expiresAt;
    }
    mapping(bytes32 => OrderLock) public orderLocks;

    /// @notice 锁定墓碑（第二十一轮）：订单摘要 => 曾落锁的归属（用户 + 锁定代币）。
    /// 落锁时写入，释放/耗尽后**不删除**。用途：失败结算归责扣费（Settlement.chargeFailedSettlement）
    /// 需要在链上证明「该订单确实落过锁、且归属是谁」——活动锁记录会被删除，无法充当证据；
    /// 墓碑由 Vault 在验签落锁时写入，归属不可伪造。
    struct LockTombstone {
        address user;
        address token;
    }
    mapping(bytes32 => LockTombstone) public lockTombstones;

    /// @notice 撤单墓碑（第四十七轮）：订单摘要 => 是否已永久关闭。
    /// 与 lockTombstones 严格分工：lockTombstones 是「曾落锁」的归属证据
    /// （落锁时写、永不删，供失败结算归责）；本标记是「不得再落锁」的
    /// 准入闸门。置位点只有两处：① releaseOrderLock 撤单释放（订单用户
    /// 本人或 locker 调用）；② consumeOrderLock 把锁定完全消耗（订单已
    /// 完全成交）。置位后不可清除、无 setter，lockForOrder 遇标记直接
    /// revert。背景：第三十轮 L2 落锁无权限后，releaseOrderLock 只删活动
    /// 锁记录，任何人拿公开的签名订单可重新落锁并继续成交——「释放后
    /// 无法再成交」在第 46 轮前端文案里无法兑现（第 46 轮 ChatGPT 复审
    /// P1）；本标记使撤单成为链上永久事实。releaseExpiredOrderLock 不
    /// 置位：订单已过期，lockForOrder 的时效检查本身已挡重锁，无需标记。
    mapping(bytes32 => bool) public cancelledOrders;

    /// @notice 挂单锁定操作员（节点/中继身份）；仅 owner 可增删。
    /// 第三十轮 L2 后落锁已无权限（见 lockForOrder），本角色不再是落锁的准入条件，
    /// 保留仅为向后兼容：releaseOrderLock 仍认 locker 身份（locker 或锁属用户本人
    /// 可释放），既有节点/中继以 locker 身份运行的路径不受影响。
    /// 测试网阶段为部署/运营身份，主网须换成领导者/BFT 授权的中继集合。
    mapping(address => bool) public lockers;

    event Deposit(address indexed user, address indexed token, uint256 amount);
    event Withdraw(address indexed user, address indexed token, uint256 amount);
    event TransferOut(address indexed fromUser, address indexed to, address indexed token, uint256 amount);
    event SettlementSet(address indexed oldSettlement, address indexed newSettlement);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event LockerSet(address indexed account, bool allowed);
    event OrderLocked(bytes32 indexed digest, address indexed user, address indexed token, uint256 amount);
    event OrderLockConsumed(bytes32 indexed digest, address indexed user, address indexed token, uint256 amount, uint256 remaining);
    event OrderLockReleased(bytes32 indexed digest, address indexed user, address indexed token, uint256 amount);
    event OrderCancelled(bytes32 indexed digest, address indexed user);

    modifier onlyOwner() {
        require(msg.sender == owner, "Vault: not owner");
        _;
    }

    modifier onlySettlement() {
        require(msg.sender == settlement, "Vault: not settlement");
        _;
    }

    /// @dev 第三十轮 L2 后 lockForOrder 不再使用本修饰器（落锁无权限）；保留定义是
    /// 为 ABI/源码向后兼容与未来如需收紧时的现成挂点，当前无函数引用它。
    modifier onlyLocker() {
        require(lockers[msg.sender], "Vault: not locker");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function setSettlement(address _settlement) external onlyOwner {
        require(_settlement != address(0), "Vault: zero address");
        address old = settlement;
        settlement = _settlement;
        emit SettlementSet(old, _settlement);
    }

    /// @notice 用户存入代币：需先 approve Vault
    /// @dev 第 32 轮起按**实际到账**记账（ChatGPT 审查整改）：transferFrom 前后
    /// 各读一次 Vault 的代币余额，差额即实收。带转账扣费/税的代币实收小于
    /// 名义额，按实收记账与发事件，保证内部账本与 Vault 真实余额恒一致；
    /// 标准代币实收恒等于名义额，行为不变。实收为 0（全额扣费）时 revert，
    /// 不记空账。withdraw/结算等下游一律以 balances 为准，无需感知此口径。
    /// nonReentrant（第 33 轮 N1）：差额记账横跨 transferFrom 外部调用，恶意
    /// 代币可在回调中重入 deposit，使外层把内层转入也算作自己的实收而重复
    /// 记账——重入守卫令内层调用直接回滚（专项测试见 VaultReentrancy.t.sol）。
    function deposit(address token, uint256 amount) external nonReentrant {
        require(token != address(0) && amount > 0, "Vault: invalid input");
        uint256 balanceBefore = IERC20(token).balanceOf(address(this));
        require(IERC20(token).transferFrom(msg.sender, address(this), amount), "Vault: transfer failed");
        uint256 received = IERC20(token).balanceOf(address(this)) - balanceBefore;
        require(received > 0, "Vault: nothing received");
        balances[msg.sender][token] += received;
        emit Deposit(msg.sender, token, received);
    }

    /// @notice 用户提取代币：只能提取可用余额（总余额 − 挂单锁定），锁定部分提不出
    /// @dev nonReentrant（第 33 轮 N1）：账面先扣后转，transfer 含代币回调面；
    /// 与 deposit 共用同一重入锁，跨函数重入（如提取回调中再存入）同样被挡。
    function withdraw(address token, uint256 amount) external nonReentrant {
        require(token != address(0) && amount > 0, "Vault: invalid input");
        require(amount <= balances[msg.sender][token] - locked[msg.sender][token], "Vault: insufficient available balance");
        balances[msg.sender][token] -= amount;
        require(IERC20(token).transfer(msg.sender, amount), "Vault: transfer failed");
        emit Withdraw(msg.sender, token, amount);
    }

    /// @notice 设置挂单锁定操作员（节点/中继身份）；仅 owner 可调用
    function setLocker(address account, bool allowed) external onlyOwner {
        require(account != address(0), "Vault: zero address");
        lockers[account] = allowed;
        emit LockerSet(account, allowed);
    }

    /// @notice 可用余额 = 总余额 − 挂单锁定（接单校验与前端展示口径）
    function availableBalance(address user, address token) public view returns (uint256) {
        return balances[user][token] - locked[user][token];
    }

    /// @notice 为一笔签名订单落锁：锁定其全部付款义务。签名订单是交易对朝向的
    /// （tokenIn/tokenOut 恒为交易对两币），付款义务由**签名方向**派生：
    /// side = SELL(1) 锁 (tokenIn, amountIn)；side = BUY(0) 锁
    /// (tokenOut, amountOut)。代币与金额一律由 Vault 从验签后的订单本身
    /// 派生，调用者无法传入方向、无法传入任意金额。
    /// 【阶段 3 ⑥方向一致性】本函数旧签名带调用者自填的方向参数
    /// payWithTokenIn——第 35 轮复审 N1 证伪其安全性：任何人可按错误方向
    /// 抢先为他人订单落锁（锁错币/错量）。side 进入 EIP-712 签名结构后
    /// （Route A），方向成为签名事实，本函数改为只从 order.side 派生，
    /// 参数删除；「落锁方向 ≠ 签名方向」在接口层即不可能表达。Settlement
    /// 结算时另有方向强制（付款侧与签名方向比对），双重一致。
    /// 【第三十轮 L2：无权限落锁】任何人可调用（不再限 locker）。安全性不来自
    /// 调用者身份，而来自 Vault 强制向 Settlement 验签并由 Settlement 计算摘要：
    /// 调用者只能替订单签名者执行其已签名同意的锁定（方向/金额/代币/归属全部
    /// 由签名订单派生），无法凭空锁定他人余额、无法伪造锁定键、无法改动锁定条款。
    /// 无效签名、非法 side、同一订单重复上锁、已过期、可用余额不足均 revert。
    /// lockers 角色保留（见 lockers 注释）：releaseOrderLock 的授权仍认 locker。
    /// nonReentrant（第 33 轮 N1）：本函数向 Settlement 发起外部验签调用，
    /// 验签方若为恶意/被攻陷合约可在回调中重入 Vault 的记账入口——加守卫后
    /// 回调期内的 deposit/withdraw/transferOut 一律被挡；Settlement 自身的
    /// 结算划转不经本函数嵌套调用，不受影响。
    function lockForOrder(VaultOrder calldata order, bytes calldata signature)
        external
        nonReentrant
        returns (bytes32 digest)
    {
        require(settlement != address(0), "Vault: settlement unset");
        require(order.expiresAt > block.timestamp, "Vault: order expired");
        require(order.side == 0 || order.side == 1, "Vault: invalid side");
        ISettlementVerifier verifier = ISettlementVerifier(settlement);
        require(verifier.verifyOrderSignature(order, signature), "Vault: invalid order signature");
        digest = verifier.orderDigest(order);
        // 第四十七轮撤单墓碑：已撤单（或已完全成交）的订单永久禁止再落锁，
        // 否则任何人拿公开签名单重锁即可让已撤订单继续成交（第 46 轮复审 P1）。
        require(!cancelledOrders[digest], "Vault: order cancelled");
        require(orderLocks[digest].user == address(0), "Vault: order already locked");
        bool payWithTokenIn = order.side == 1; // SELL 付 tokenIn；BUY 付 tokenOut
        address token = payWithTokenIn ? order.tokenIn : order.tokenOut;
        uint256 amount = payWithTokenIn ? order.amountIn : order.amountOut;
        require(amount > 0, "Vault: zero lock amount");
        require(availableBalance(order.userAddress, token) >= amount, "Vault: insufficient available");
        orderLocks[digest] = OrderLock({
            user: order.userAddress,
            token: token,
            remaining: amount,
            expiresAt: order.expiresAt
        });
        // 墓碑与锁同写：归属在验签通过后落定，后续释放/耗尽不清除
        lockTombstones[digest] = LockTombstone({user: order.userAddress, token: token});
        locked[order.userAddress][token] += amount;
        emit OrderLocked(digest, order.userAddress, token, amount);
    }

    /// @notice 结算时消费锁定（仅 Settlement）：Settlement 把本笔成交折算到该订单
    /// 自身朝向的 (addIn, addOut) 一并传入，Vault 按锁定记录的 token 取对应侧的量
    /// 消费（卖单锁 tokenIn 取 addIn、买单锁 tokenOut 取 addOut），与结算实际扣款恒等。
    /// 无锁定记录或超出剩余锁定均 revert——未落锁的订单无法结算。
    /// 与结算划转同事务，结算失败时本消耗一并回滚，不吞锁定。
    function consumeOrderLock(bytes32 digest, address orderTokenIn, uint256 addIn, uint256 addOut) external onlySettlement {
        OrderLock storage lockRec = orderLocks[digest];
        require(lockRec.user != address(0), "Vault: order not locked");
        uint256 amount = lockRec.token == orderTokenIn ? addIn : addOut;
        require(amount > 0 && amount <= lockRec.remaining, "Vault: lock underflow");
        address user = lockRec.user;
        address token = lockRec.token;
        lockRec.remaining -= amount;
        locked[user][token] -= amount;
        uint256 remaining = lockRec.remaining;
        if (remaining == 0) {
            delete orderLocks[digest];
            // 第四十七轮：订单已完全成交，一并置撤单墓碑——该摘要对应的
            // 签名义务已全部履行，Settlement 累计上限本就使其无法再结超量，
            // 置位防的是无意义重锁把用户资金困到释放/过期。语义与撤单同为
            // 「该订单已永久关闭」，见 cancelledOrders 注释。
            cancelledOrders[digest] = true;
        }
        emit OrderLockConsumed(digest, user, token, amount, remaining);
    }

    /// @notice 撤单释放：释放该订单全部剩余锁定（locker 或订单用户本人可调用）
    /// @dev 第四十七轮起本函数即链上撤单：释放的同时置撤单墓碑
    /// （cancelledOrders），该订单从此不可再落锁、不可再成交，撤单成为
    /// 永久事实（此前只删活动锁记录，任何人可拿公开签名单重锁——第 46
    /// 轮复审 P1）。locker 释放他人锁同样置位：locker 是受信运营角色
    /// （见 lockers 注释），其释放与用户本人释放同为运营口径的撤单，
    /// 语义保持一致；信任边界在 docs/round47-permanent-cancel-2026-11-09.md
    /// 写明。部分成交后释放剩余锁定同样置位：未成交余量永久作废，这
    /// 正是撤单语义（已成交部分不受影响，成交记录在 Settlement）。
    function releaseOrderLock(bytes32 digest) external {
        OrderLock storage lockRec = orderLocks[digest];
        require(lockRec.user != address(0), "Vault: order not locked");
        require(lockers[msg.sender] || msg.sender == lockRec.user, "Vault: not authorized to release");
        address user = lockRec.user;
        cancelledOrders[digest] = true;
        emit OrderCancelled(digest, user);
        _releaseOrderLock(digest);
    }

    /// @notice 过期释放：订单过期后任何人可释放其剩余锁定，防节点掉线永久锁死资金
    /// @dev 第四十七轮注记：本路径**不**置撤单墓碑（cancelledOrders）。
    /// 订单已过期，lockForOrder 的时效检查（order expired）本身已永久挡住
    /// 重锁，墓碑在此冗余；且过期释放是任何人可触发的清理动作，不应由它
    /// 产生撤单语义（撤单只来自 releaseOrderLock 的授权调用）。
    function releaseExpiredOrderLock(bytes32 digest) external {
        OrderLock storage lockRec = orderLocks[digest];
        require(lockRec.user != address(0), "Vault: order not locked");
        require(block.timestamp > lockRec.expiresAt, "Vault: order not expired");
        _releaseOrderLock(digest);
    }

    function _releaseOrderLock(bytes32 digest) internal {
        OrderLock storage lockRec = orderLocks[digest];
        address user = lockRec.user;
        address token = lockRec.token;
        uint256 amount = lockRec.remaining;
        locked[user][token] -= amount;
        delete orderLocks[digest];
        emit OrderLockReleased(digest, user, token, amount);
    }

    /// @notice 结算合约：从 fromUser 扣减并转至 to（仅 Settlement 调用），代币转出到 to 地址
    /// @dev nonReentrant（第 33 轮 N1）：含 transfer 外部调用与代币回调面，与
    /// deposit/withdraw 共用重入锁。结算事务内 Settlement 对本函数的多次调用
    /// 是顺序独立调用（非嵌套），守卫不影响正常结算。
    function transferOut(address fromUser, address to, address token, uint256 amount) external onlySettlement nonReentrant {
        require(token != address(0) && to != address(0) && amount > 0, "Vault: invalid input");
        require(balances[fromUser][token] >= amount, "Vault: insufficient balance");
        balances[fromUser][token] -= amount;
        require(IERC20(token).transfer(to, amount), "Vault: transfer failed");
        emit TransferOut(fromUser, to, token, amount);
    }

    /// @notice 结算合约：在托管账本内划转（仅 Settlement 调用），不转出代币
    /// @dev 不加 nonReentrant（第 33 轮 N1 取舍）：函数体只有账本加减、无任何
    /// 外部调用，不存在回调面；且结算路径常与 transferOut 同事务顺序调用，
    /// 保持无守卫避免无谓约束。
    function transferWithinVault(address fromUser, address toUser, address token, uint256 amount) external onlySettlement {
        require(token != address(0) && toUser != address(0) && amount > 0, "Vault: invalid input");
        require(balances[fromUser][token] >= amount, "Vault: insufficient balance");
        balances[fromUser][token] -= amount;
        balances[toUser][token] += amount;
        emit TransferOut(fromUser, toUser, token, amount);
    }

    function balanceOf(address token, address user) external view returns (uint256) {
        return balances[user][token];
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Vault: zero address");
        owner = newOwner;
        emit OwnershipTransferred(msg.sender, newOwner);
    }
}
