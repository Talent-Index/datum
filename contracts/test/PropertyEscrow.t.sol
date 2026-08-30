// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PropertyEscrow} from "../src/PropertyEscrow.sol";
import {MockKES} from "../src/MockKES.sol";

/**
 * Ported from tests/test_escrow.py. Same four scenarios, same 22 assertions,
 * same expected figures. These target the things that are easy to get wrong
 * and expensive to get wrong in production:
 *
 *   1. Release amounts when buyers join mid-construction
 *   2. Refund fairness regardless of who claims first
 *   3. Two of three attesters, so no single party controls the money
 *   4. Buyers can reach their funds without the platform's cooperation
 */
contract PropertyEscrowTest is Test {
    uint256 constant KES = 100; // token has 2 decimals: 100 units = KES 1.00
    bytes32 constant EVIDENCE = bytes32(uint256(0x1111111111111111111111111111111111111111111111111111111111111111));

    address platform = makeAddr("platform");
    address developer = makeAddr("developer");
    address oracle = makeAddr("oracle");
    address surveyor = makeAddr("surveyor");
    address settlement = makeAddr("settlement"); // platform's fiat settlement wallet
    address[4] buyers = [makeAddr("buyer0"), makeAddr("buyer1"), makeAddr("buyer2"), makeAddr("buyer3")];

    MockKES kes;
    PropertyEscrow escrow;

    function _deploy(uint256 stallAfter) internal {
        string[] memory descriptions = new string[](5);
        descriptions[0] = "Site clearing and foundation";
        descriptions[1] = "Ground floor slab";
        descriptions[2] = "First floor structure";
        descriptions[3] = "Roofing complete";
        descriptions[4] = "Finishing and handover";
        uint8[] memory percents = new uint8[](5);
        for (uint256 i = 0; i < 5; i++) percents[i] = 20;

        kes = new MockKES();
        escrow = new PropertyEscrow(
            address(kes),
            developer,
            [oracle, surveyor, platform],
            descriptions,
            percents,
            stallAfter
        );
        kes.mint(settlement, 100_000_000 * KES);
        vm.prank(settlement);
        kes.approve(address(escrow), 100_000_000 * KES);
    }

    function setUp() public {
        _deploy(90 days);
    }

    // M-Pesa lands in the settlement wallet; platform records the claim.
    function _deposit(address buyer, uint256 kesAmount) internal {
        vm.prank(settlement);
        escrow.depositFor(buyer, kesAmount * KES);
    }

    function _attest(uint256 milestoneId, uint8 role, address who) internal {
        vm.prank(who);
        escrow.attest(milestoneId, role, EVIDENCE);
    }

    // Oracle + surveyor. The platform is deliberately not involved.
    function _advance(uint256 milestoneId) internal {
        _attest(milestoneId, 0, oracle);
        _attest(milestoneId, 1, surveyor);
    }

    function _held() internal view returns (uint256) {
        return escrow.heldBalance() / KES;
    }

    function _devBalance() internal view returns (uint256) {
        return kes.balanceOf(developer) / KES;
    }

    function _buyerBalance(address b) internal view returns (uint256) {
        return kes.balanceOf(b) / KES;
    }

    /// The bug that breaks every naive escrow: buyers arriving mid-build.
    function test_LateJoiners() public {
        _deposit(buyers[0], 1_000_000);
        _advance(0); // 20% cumulative
        assertEq(_devBalance(), 200_000, "milestone 1 releases 20% of KES 1M");

        _deposit(buyers[1], 1_000_000); // joins after foundation
        _advance(1); // 40% cumulative on a KES 2M pool
        assertEq(_devBalance(), 800_000, "milestone 2 releases catch-up to 40% of KES 2M");
        assertEq(_held(), 1_200_000, "still held after milestone 2");

        _deposit(buyers[2], 2_000_000); // joins at roofing
        _advance(2);
        _advance(3);
        _advance(4);
        assertEq(_devBalance(), 4_000_000, "all funds released at handover");
        assertEq(_held(), 0, "nothing stranded in escrow");

        (uint256 contributed,,) = escrow.buyerPosition(buyers[0]);
        assertEq(contributed / KES, 1_000_000, "buyer position reconciles");
    }

    /// Claim order must not change what anyone receives.
    function test_RefundFairness() public {
        _deposit(buyers[0], 1_000_000);
        _deposit(buyers[1], 1_000_000);
        _deposit(buyers[2], 2_000_000);

        _advance(0);
        _advance(1); // 40% gone to the developer, KES 2.4M left
        assertEq(_devBalance(), 1_600_000, "developer took 40%");
        assertEq(_held(), 2_400_000, "escrow retains the rest");

        vm.prank(platform);
        escrow.declareStalled();

        // Deliberately claim in a different order than deposits were made.
        vm.prank(buyers[2]);
        escrow.claimRefund(buyers[2]);
        vm.prank(buyers[0]);
        escrow.claimRefund(buyers[0]);
        vm.prank(buyers[1]);
        escrow.claimRefund(buyers[1]);

        assertEq(_buyerBalance(buyers[2]), 1_200_000, "first claimant gets pro rata, not everything");
        assertEq(_buyerBalance(buyers[0]), 600_000, "second claimant gets equal share");
        assertEq(_buyerBalance(buyers[1]), 600_000, "last claimant is not shortchanged");
        assertEq(_held(), 0, "pool fully distributed");

        vm.expectRevert(PropertyEscrow.NothingToRefund.selector);
        vm.prank(buyers[0]);
        escrow.claimRefund(buyers[0]); // double refund blocked
    }

    /// Two of three. No single party can force or block a release.
    function test_Threshold() public {
        _deposit(buyers[0], 1_000_000);

        _attest(0, 0, oracle);
        assertEq(_devBalance(), 0, "one attester does not release");

        vm.expectRevert(PropertyEscrow.AlreadyAttested.selector);
        vm.prank(oracle);
        escrow.attest(0, 0, EVIDENCE); // same attester cannot sign twice

        vm.expectRevert(PropertyEscrow.NotAttester.selector);
        vm.prank(buyers[0]);
        escrow.attest(0, 1, EVIDENCE); // outsider cannot attest

        _attest(0, 1, surveyor);
        assertEq(_devBalance(), 200_000, "oracle + surveyor release without the platform");

        // And the platform can substitute for a missing oracle.
        _attest(1, 1, surveyor);
        _attest(1, 2, platform);
        assertEq(_devBalance(), 400_000, "surveyor + platform also release");
    }

    /// Milestones run in order; buyers can escape a silent platform.
    function test_OrderingAndTimeout() public {
        _deploy(60); // short stall window for this scenario
        _deposit(buyers[0], 1_000_000);

        vm.expectRevert("milestones complete in order");
        vm.prank(oracle);
        escrow.attest(2, 0, EVIDENCE); // cannot skip ahead to a later milestone

        vm.expectRevert("not stalled yet");
        vm.prank(buyers[0]);
        escrow.declareStalled(); // cannot stall an active project early

        vm.warp(block.timestamp + 200);
        vm.prank(buyers[0]);
        escrow.declareStalled();
        assertEq(uint256(escrow.status()), 1, "a buyer can stall a silent project");

        vm.prank(buyers[0]);
        escrow.claimRefund(buyers[0]);
        assertEq(_buyerBalance(buyers[0]), 1_000_000, "and recover the full unreleased balance");
    }
}
