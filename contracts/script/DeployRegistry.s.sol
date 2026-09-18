// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {DatumRegistry} from "../src/DatumRegistry.sol";

/**
 * Deploys the platform registry once. The platform wallet is its owner.
 *
 *   forge script script/DeployRegistry.s.sol --rpc-url $RPC_URL --broadcast
 */
contract DeployRegistry is Script {
    function run() external {
        uint256 platformKey = vm.envUint("PLATFORM_KEY");
        vm.startBroadcast(platformKey);
        DatumRegistry reg = new DatumRegistry();
        vm.stopBroadcast();
        console2.log("DatumRegistry:  ", address(reg));
    }
}
