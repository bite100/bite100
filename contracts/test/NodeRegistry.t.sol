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
}
