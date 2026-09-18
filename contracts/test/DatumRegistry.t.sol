// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {DatumRegistry} from "../src/DatumRegistry.sol";

contract DatumRegistryTest is Test {
    DatumRegistry reg;
    address seller = address(0xA11CE);
    address buyer = address(0xB0B);
    address trustee = address(0x7E57);

    function setUp() public {
        reg = new DatumRegistry();
    }

    function test_RegisterOnce() public {
        reg.register(seller, DatumRegistry.Role.Seller);
        (DatumRegistry.Role role, bool verified,,) = reg.accounts(seller);
        assertEq(uint8(role), uint8(DatumRegistry.Role.Seller));
        assertFalse(verified);
        vm.expectRevert(abi.encodeWithSelector(DatumRegistry.AlreadyRegistered.selector, seller));
        reg.register(seller, DatumRegistry.Role.Buyer);
    }

    function test_ListingNeedsVerifiedIdentity() public {
        reg.register(seller, DatumRegistry.Role.Seller);
        vm.expectRevert(abi.encodeWithSelector(DatumRegistry.NotVerified.selector, seller));
        reg.postListing(keccak256("plot-1"), seller, keccak256("content"));

        reg.setKyc(seller, true, keccak256("id-doc"), trustee);
        reg.postListing(keccak256("plot-1"), seller, keccak256("content"));
        (address owner_, bytes32 hash, bool live,) = reg.listings(keccak256("plot-1"));
        assertEq(owner_, seller);
        assertEq(hash, keccak256("content"));
        assertFalse(live);

        reg.setListingLive(keccak256("plot-1"), true);
        (,, live,) = reg.listings(keccak256("plot-1"));
        assertTrue(live);
    }

    function test_BuyersCannotList() public {
        reg.register(buyer, DatumRegistry.Role.Buyer);
        reg.setKyc(buyer, true, keccak256("id"), trustee);
        vm.expectRevert(DatumRegistry.BadRole.selector);
        reg.postListing(keccak256("x"), buyer, keccak256("c"));
    }

    function test_OnlyOwnerWrites() public {
        vm.prank(seller);
        vm.expectRevert(DatumRegistry.NotOwner.selector);
        reg.register(seller, DatumRegistry.Role.Seller);
    }

    function test_ActivitySequence() public {
        uint256 a = reg.log(buyer, keccak256("commitment"), keccak256("p1"));
        uint256 b = reg.log(buyer, keccak256("deposit"), keccak256("p2"));
        assertEq(a, 1);
        assertEq(b, 2);
        assertEq(reg.activityCount(), 2);
    }
}
