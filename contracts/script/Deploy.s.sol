// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {PropertyEscrow} from "../src/PropertyEscrow.sol";
import {MockKES} from "../src/MockKES.sol";

/**
 * Deploys the token and the escrow for one development.
 *
 *   forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast
 *
 * Environment: PLATFORM_KEY (deployer, settlement and attester 2),
 * ORACLE_ADDRESS, SURVEYOR_ADDRESS, DEVELOPER_ADDRESS. The settlement
 * wallet is minted test shillings and approves the escrow, so depositFor
 * works immediately.
 */
contract Deploy is Script {
    uint256 constant KES = 100;

    function run() external {
        uint256 platformKey = vm.envUint("PLATFORM_KEY");
        address platform = vm.addr(platformKey);
        address oracle = vm.envAddress("ORACLE_ADDRESS");
        address surveyor = vm.envAddress("SURVEYOR_ADDRESS");
        address developer = vm.envAddress("DEVELOPER_ADDRESS");

        string[] memory descriptions = new string[](5);
        descriptions[0] = "Site clearing and foundation";
        descriptions[1] = "Ground floor slab";
        descriptions[2] = "First floor structure";
        descriptions[3] = "Roofing complete";
        descriptions[4] = "Finishing and handover";
        uint8[] memory percents = new uint8[](5);
        for (uint256 i = 0; i < 5; i++) percents[i] = 20;

        vm.startBroadcast(platformKey);
        MockKES kes = new MockKES();
        PropertyEscrow escrow = new PropertyEscrow(
            address(kes),
            developer,
            [oracle, surveyor, platform],
            descriptions,
            percents,
            30 days
        );
        kes.mint(platform, 500_000_000 * KES);
        kes.approve(address(escrow), 500_000_000 * KES);
        vm.stopBroadcast();

        console2.log("MockKES:        ", address(kes));
        console2.log("PropertyEscrow: ", address(escrow));
    }
}
