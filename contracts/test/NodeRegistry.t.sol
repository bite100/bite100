// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "forge-std/Test.sol";
import "../src/NodeRegistry.sol";

contract NodeRegistryTest is Test {
    NodeRegistry registry;

    address owner;
    address alice;
    address bob;

    function setUp() public {
        owner = address(this);
        alice = makeAddr("alice");
        bob = makeAddr("bob");
        registry = new NodeRegistry();
    }

    function test_Register() public {
        bytes32 nodeId = keccak256("node-1");
        vm.prank(alice);
        registry.register(nodeId, alice);

        assertEq(registry.nodeToWallet(nodeId), alice);
        assertEq(registry.walletToNode(alice), nodeId);
        assertTrue(registry.registrationTime(nodeId) > 0);
    }

    function test_Register_AnyoneCanCall() public {
        bytes32 nodeId = keccak256("node-1");
        // bob 为 alice 注册（例如前端代提交）
        vm.prank(bob);
        registry.register(nodeId, alice);

        assertEq(registry.nodeToWallet(nodeId), alice);
        assertEq(registry.walletToNode(alice), nodeId);
    }

    function test_Register_RevertZeroWallet() public {
        vm.expectRevert("NodeRegistry: zero wallet");
        registry.register(keccak256("n1"), address(0));
    }

    function test_Register_RevertAlreadyRegistered() public {
        bytes32 nodeId = keccak256("node-1");
        registry.register(nodeId, alice);
        vm.expectRevert("NodeRegistry: already registered");
        registry.register(nodeId, bob);
    }

    function test_Register_RevertWalletBoundToOther() public {
        bytes32 n1 = keccak256("n1");
        bytes32 n2 = keccak256("n2");
        registry.register(n1, alice);
        vm.expectRevert("NodeRegistry: wallet bound to other node");
        registry.register(n2, alice);
    }

    function test_UpdateWallet_ByWallet() public {
        bytes32 nodeId = keccak256("node-1");
        registry.register(nodeId, alice);

        vm.prank(alice);
        registry.updateWallet(nodeId, bob);

        assertEq(registry.nodeToWallet(nodeId), bob);
        assertEq(registry.walletToNode(alice), bytes32(0));
        assertEq(registry.walletToNode(bob), nodeId);
    }

    function test_UpdateWallet_ByOwner() public {
        bytes32 nodeId = keccak256("node-1");
        registry.register(nodeId, alice);

        registry.updateWallet(nodeId, bob);

        assertEq(registry.nodeToWallet(nodeId), bob);
    }

    function test_UpdateWallet_RevertNotAuth() public {
        bytes32 nodeId = keccak256("node-1");
        registry.register(nodeId, alice);

        vm.prank(bob);
        vm.expectRevert("NodeRegistry: not auth");
        registry.updateWallet(nodeId, bob);
    }

    function test_SetNodeWallet_Owner() public {
        bytes32 nodeId = keccak256("node-1");
        registry.setNodeWallet(nodeId, alice);

        assertEq(registry.nodeToWallet(nodeId), alice);
        assertEq(registry.walletToNode(alice), nodeId);

        registry.setNodeWallet(nodeId, bob);
        assertEq(registry.nodeToWallet(nodeId), bob);
        assertEq(registry.walletToNode(alice), bytes32(0));

        registry.setNodeWallet(nodeId, address(0));
        assertEq(registry.nodeToWallet(nodeId), address(0));
    }

    // ===== 第 33 轮 N4：三条写路径的钱包占用检查 =====

    /// updateWallet 把钱包改到已被其它节点占用的钱包 → 拒绝且状态不变
    /// （钱包本人与 owner 两种调用者都挡）。
    function test_UpdateWallet_RevertWalletBoundToOther() public {
        bytes32 n1 = keccak256("n1");
        bytes32 n2 = keccak256("n2");
        registry.register(n1, alice);
        registry.register(n2, bob);

        vm.prank(alice);
        vm.expectRevert("NodeRegistry: wallet bound to other node");
        registry.updateWallet(n1, bob);

        vm.expectRevert("NodeRegistry: wallet bound to other node");
        registry.updateWallet(n1, bob);

        // 双向映射保持原状、恒一致
        assertEq(registry.nodeToWallet(n1), alice);
        assertEq(registry.nodeToWallet(n2), bob);
        assertEq(registry.walletToNode(alice), n1);
        assertEq(registry.walletToNode(bob), n2);
    }

    /// updateWallet 改回自己当前钱包（幂等）→ 允许，映射不变。
    function test_UpdateWallet_SameWalletIdempotent() public {
        bytes32 nodeId = keccak256("node-1");
        registry.register(nodeId, alice);

        vm.prank(alice);
        registry.updateWallet(nodeId, alice);

        assertEq(registry.nodeToWallet(nodeId), alice);
        assertEq(registry.walletToNode(alice), nodeId);
    }

    /// setNodeWallet 把已被其它节点占用的钱包强设给新节点 → 拒绝且状态不变。
    function test_SetNodeWallet_RevertWalletBoundToOther() public {
        bytes32 n1 = keccak256("n1");
        bytes32 n2 = keccak256("n2");
        registry.register(n1, alice);

        vm.expectRevert("NodeRegistry: wallet bound to other node");
        registry.setNodeWallet(n2, alice);

        assertEq(registry.nodeToWallet(n1), alice);
        assertEq(registry.nodeToWallet(n2), address(0));
        assertEq(registry.walletToNode(alice), n1);
    }

    /// 合法强制迁移：先解绑原节点，再把钱包设给新节点 → 成功且双向一致。
    function test_SetNodeWallet_ForceMigrateAfterUnbind() public {
        bytes32 n1 = keccak256("n1");
        bytes32 n2 = keccak256("n2");
        registry.register(n1, alice);

        registry.setNodeWallet(n1, address(0));
        assertEq(registry.walletToNode(alice), bytes32(0));

        registry.setNodeWallet(n2, alice);
        assertEq(registry.nodeToWallet(n2), alice);
        assertEq(registry.walletToNode(alice), n2);
        assertEq(registry.nodeToWallet(n1), address(0));
    }
}
