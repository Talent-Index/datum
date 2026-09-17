// Regenerates lib/artifacts.ts from the Foundry build output.
import { readFileSync, writeFileSync } from "node:fs";
const load = (n) => JSON.parse(readFileSync(`contracts/out/${n}.sol/${n}.json`, "utf8"));
const esc = load("PropertyEscrow"), kes = load("MockKES");
writeFileSync("lib/artifacts.ts", `/**
 * Compiled contract artifacts, so the app can deploy an escrow for a new
 * project without a Foundry toolchain on the server. Regenerate after any
 * change to the Solidity: npm run artifacts.
 */
export const escrowArtifact = {
  abi: ${JSON.stringify(esc.abi)} as const,
  bytecode: ${JSON.stringify(esc.bytecode.object)} as \`0x\${string}\`,
};

export const kesArtifact = {
  abi: ${JSON.stringify(kes.abi)} as const,
  bytecode: ${JSON.stringify(kes.bytecode.object)} as \`0x\${string}\`,
};
`);
console.log("lib/artifacts.ts regenerated");
