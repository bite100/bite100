// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/CrossChainBridge.sol";
import "../src/mock/MockERC20.sol";
import {
    MessagingParams,
    MessagingFee,
    MessagingReceipt
} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";
import { Origin } from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroReceiver.sol";

/// @notice 最小 LayerZero Endpoint 替身：实现 OApp 构造与发送/报价实际调用的三个函数，
///         并捕获最后一条消息，供测试把消息“投递”到目标桥。
contract MockLzEndpoint {
    uint256 public mockNativeFee = 0.001 ether;
    bytes public lastMessage;
    uint32 public lastDstEid;
    uint64 public nonceCounter;

    function setDelegate(address) external {}

    function quote(MessagingParams calldata, address) external view returns (MessagingFee memory) {
        return MessagingFee(mockNativeFee, 0);
    }

    function send(MessagingParams calldata _params, address) external payable returns (MessagingReceipt memory) {
        lastMessage = _params.message;
        lastDstEid = _params.dstEid;
        uint64 nonce = ++nonceCounter;
        bytes32 guid = keccak256(abi.encodePacked("mock-guid", _params.dstEid, nonce, _params.message));
        return MessagingReceipt(guid, nonce, MessagingFee(msg.value, 0));
    }
}

contract CrossChainBridgeTest is Test {
    uint32 constant SRC_EID = 40161; // Sepolia
    uint32 constant DST_EID = 40245; // Base Sepolia

    MockLzEndpoint endpoint;
    CrossChainBridge bridgeSrc;
    CrossChainBridge bridgeDst;
    MockERC20 tokenSrc;
    MockERC20 tokenDst;

    address user = address(0x2);
    address stranger = address(0x3);

    function setUp() public {
        endpoint = new MockLzEndpoint();
        // 测试合约即部署者/owner（真实 OApp 的 owner = msg.sender）
        bridgeSrc = new CrossChainBridge(address(endpoint), address(this));
        bridgeDst = new CrossChainBridge(address(endpoint), address(this));

        tokenSrc = new MockERC20("Token A", "TKA", 0);
        tokenDst = new MockERC20("Token A (Base)", "TKA", 0);
        tokenSrc.mint(user, 1000e18);
        vm.deal(user, 10 ether); // 付 LZ 消息费
        vm.deal(stranger, 10 ether);
        vm.deal(address(this), 10 ether);
        // 目标桥预存流动性
        tokenDst.mint(address(bridgeDst), 500e18);

        bridgeSrc.setPeer(DST_EID, bytes32(uint256(uint160(address(bridgeDst)))));
        bridgeDst.setPeer(SRC_EID, bytes32(uint256(uint160(address(bridgeSrc)))));

        bridgeSrc.setSupportedToken(address(tokenSrc), true);
        bridgeDst.setSupportedToken(address(tokenDst), true);
        bridgeSrc.setTokenMapping(DST_EID, address(tokenSrc), address(tokenDst));
        bridgeSrc.setBridgeFee(address(tokenSrc), 0.1e18);
    }

    // ---------------- 配置类 ----------------

    function test_SetSupportedToken_OnlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert();
        bridgeSrc.setSupportedToken(address(tokenSrc), false);
    }

    function test_SetTokenMapping() public {
        bridgeSrc.setTokenMapping(DST_EID, address(tokenSrc), address(0x999));
        assertEq(bridgeSrc.tokenMapping(DST_EID, address(tokenSrc)), address(0x999));
    }

    function test_SetBridgeFee() public {
        bridgeSrc.setBridgeFee(address(tokenSrc), 1e18);
        assertEq(bridgeSrc.bridgeFees(address(tokenSrc)), 1e18);
    }

    // ---------------- 发送侧校验 ----------------

    function test_BridgeToken_RevertNative() public {
        vm.prank(user);
        vm.expectRevert("Bridge: native token not supported");
        bridgeSrc.bridgeToken(address(0), 1e18, DST_EID, "");
    }

    function test_BridgeToken_RevertIfNotSupported() public {
        MockERC20 unsupported = new MockERC20("Unsupported", "UNS", 0);
        unsupported.mint(user, 100e18);
        vm.startPrank(user);
        unsupported.approve(address(bridgeSrc), 100e18);
        vm.expectRevert("Bridge: token not supported");
        bridgeSrc.bridgeToken(address(unsupported), 100e18, DST_EID, "");
        vm.stopPrank();
    }

    function test_BridgeToken_RevertIfNoMapping() public {
        MockERC20 newToken = new MockERC20("New", "NEW", 0);
        newToken.mint(user, 100e18);
        bridgeSrc.setSupportedToken(address(newToken), true);
        vm.startPrank(user);
        newToken.approve(address(bridgeSrc), 100e18);
        vm.expectRevert("Bridge: token mapping not set");
        bridgeSrc.bridgeToken(address(newToken), 100e18, DST_EID, "");
        vm.stopPrank();
    }

    // ---------------- 发送 + 记账 ----------------

    function _bridge10() internal returns (uint256 transferId, bytes32 guid, bytes memory payload) {
        vm.startPrank(user);
        tokenSrc.approve(address(bridgeSrc), 10e18);
        (transferId, guid) = bridgeSrc.bridgeToken{ value: 0.001 ether }(
            address(tokenSrc), 10e18, DST_EID, ""
        );
        vm.stopPrank();
        payload = endpoint.lastMessage();
    }

    function test_BridgeToken_LocksAndRecords() public {
        (uint256 transferId, bytes32 guid, bytes memory payload) = _bridge10();
        assertEq(transferId, 1);
        assertTrue(guid != bytes32(0));
        assertEq(tokenSrc.balanceOf(address(bridgeSrc)), 10e18); // 全额锁定（含费）
        assertEq(tokenSrc.balanceOf(user), 990e18);

        (
            address tUser,
            ,
            ,
            uint256 amount,
            uint256 netAmount,
            uint32 dstEid,
            ,
            ,
            uint256 attempts,
            bytes32 lastGuid,
            CrossChainBridge.BridgeStatus status
        ) = bridgeSrc.transfers(transferId);
        assertEq(tUser, user);
        assertEq(amount, 10e18);
        assertEq(netAmount, 9.9e18); // 扣 0.1 费
        assertEq(dstEid, DST_EID);
        assertEq(attempts, 0);
        assertEq(lastGuid, guid);
        assertEq(uint256(status), uint256(CrossChainBridge.BridgeStatus.Pending));
        assertEq(bridgeSrc.guidToTransfer(guid), transferId);

        (uint256 pId, address pUser, address pToken, uint256 pAmount) =
            abi.decode(payload, (uint256, address, address, uint256));
        assertEq(pId, transferId);
        assertEq(pUser, user);
        assertEq(pToken, address(tokenDst));
        assertEq(pAmount, 9.9e18);
    }

    function test_QuoteBridgeFee() public {
        (uint256 nativeFee, uint256 lzFee) =
            bridgeSrc.quoteBridgeFee(address(tokenSrc), 10e18, DST_EID, user, "");
        assertEq(nativeFee, 0.001 ether);
        assertEq(lzFee, 0);
    }

    // ---------------- 接收侧 ----------------

    function _deliver(bytes memory payload, bytes32 guid) internal {
        Origin memory origin = Origin({
            srcEid: SRC_EID,
            sender: bytes32(uint256(uint160(address(bridgeSrc)))),
            nonce: 1
        });
        vm.prank(address(endpoint));
        bridgeDst.lzReceive(origin, guid, payload, address(0xE), "");
    }

    function test_LzReceive_CompletesDelivery() public {
        (uint256 transferId, bytes32 guid, bytes memory payload) = _bridge10();
        uint256 balBefore = tokenDst.balanceOf(user);
        _deliver(payload, guid);
        assertEq(tokenDst.balanceOf(user), balBefore + 9.9e18);
        (CrossChainBridge.BridgeStatus st, uint256 completedAt, bytes32 dGuid) =
            bridgeDst.getDeliveryStatus(SRC_EID, transferId);
        assertEq(uint256(st), uint256(CrossChainBridge.BridgeStatus.Completed));
        assertTrue(completedAt > 0);
        assertEq(dGuid, guid);
        (CrossChainBridge.BridgeStatus gst,,,,) = bridgeDst.getBridgeStatus(guid);
        assertEq(uint256(gst), uint256(CrossChainBridge.BridgeStatus.Completed));
    }

    function test_LzReceive_ReplayRejected() public {
        (, bytes32 guid, bytes memory payload) = _bridge10();
        _deliver(payload, guid);
        // 同一 guid 重放
        vm.expectRevert("Bridge: transfer already processed");
        _deliver(payload, guid);
        // 换一个 guid、同一 transferId（模拟 retry 与原消息竞速）同样被拒
        vm.expectRevert("Bridge: transfer already processed");
        _deliver(payload, bytes32(uint256(12345)));
    }

    function test_LzReceive_NoExpiryAfterLongDelay() public {
        (, bytes32 guid, bytes memory payload) = _bridge10();
        vm.warp(block.timestamp + 365 days); // 旧版 5 分钟校验必然拒绝
        _deliver(payload, guid);
        assertEq(tokenDst.balanceOf(user), 9.9e18);
    }

    function test_LzReceive_WrongPeerReverts() public {
        (, , bytes memory payload) = _bridge10();
        Origin memory origin = Origin({
            srcEid: SRC_EID,
            sender: bytes32(uint256(uint160(stranger))),
            nonce: 1
        });
        vm.prank(address(endpoint));
        vm.expectRevert();
        bridgeDst.lzReceive(origin, bytes32(uint256(7)), payload, address(0xE), "");
    }

    // ---------------- 重试 ----------------

    function test_RetryBridge_ResendsAndDedupes() public {
        (uint256 transferId, bytes32 guid1, bytes memory payload) = _bridge10();
        vm.warp(block.timestamp + 6 minutes);
        vm.prank(user);
        bytes32 guid2 = bridgeSrc.retryBridge{ value: 0.001 ether }(transferId, "");
        assertTrue(guid2 != guid1);
        (,,,,,,,, uint256 attempts, bytes32 lastGuid,) = bridgeSrc.transfers(transferId);
        assertEq(attempts, 1);
        assertEq(lastGuid, guid2);
        // 重试消息先到 → 完成
        bytes memory payload2 = endpoint.lastMessage();
        _deliver(payload2, guid2);
        assertEq(tokenDst.balanceOf(user), 9.9e18);
        // 原消息迟到 → 被去重拒绝，不会双重到账
        vm.expectRevert("Bridge: transfer already processed");
        _deliver(payload, guid1);
        assertEq(tokenDst.balanceOf(user), 9.9e18);
    }

    function test_RetryBridge_TooSoon() public {
        (uint256 transferId,,) = _bridge10();
        vm.prank(user);
        vm.expectRevert("Bridge: retry too soon");
        bridgeSrc.retryBridge{ value: 0.001 ether }(transferId, "");
    }

    function test_RetryBridge_Unauthorized() public {
        (uint256 transferId,,) = _bridge10();
        vm.warp(block.timestamp + 6 minutes);
        vm.prank(stranger);
        vm.expectRevert("Bridge: not authorized");
        bridgeSrc.retryBridge{ value: 0.001 ether }(transferId, "");
    }

    function test_RetryBridge_MaxAttempts() public {
        (uint256 transferId,,) = _bridge10();
        bridgeSrc.setRetryConfig(1, 1); // 最多重试 1 次、间隔 1 秒
        vm.warp(block.timestamp + 2);
        vm.prank(user);
        bridgeSrc.retryBridge{ value: 0.001 ether }(transferId, "");
        vm.warp(block.timestamp + 2);
        vm.prank(user);
        vm.expectRevert("Bridge: max retries exceeded");
        bridgeSrc.retryBridge{ value: 0.001 ether }(transferId, "");
    }

    // ---------------- 费用提取 ----------------

    function test_WithdrawFees() public {
        _bridge10();
        uint256 before = tokenSrc.balanceOf(address(this));
        bridgeSrc.withdrawFees(address(tokenSrc), address(this), 0.1e18);
        assertEq(tokenSrc.balanceOf(address(this)), before + 0.1e18);
    }
}
