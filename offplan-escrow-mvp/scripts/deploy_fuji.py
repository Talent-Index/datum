"""
Deploy the escrow to Avalanche Fuji.

    export DEPLOYER_KEY=0x...            # funded from the Fuji faucet
    python3 scripts/deploy_fuji.py

Prints the deployed addresses and a Snowtrace link. Same contracts the local
demo runs, same tests — only the provider changes.

Faucet:   https://core.app/tools/testnet-faucet
RPC:      https://api.avax-test.network/ext/bc/C/rpc   (chain id 43113)
Explorer: https://testnet.snowtrace.io
"""

import json
import os
import subprocess
import sys
from pathlib import Path

from web3 import Web3
from web3.middleware import ExtraDataToPOAMiddleware

ROOT = Path(__file__).resolve().parent.parent
RPC = os.getenv("FUJI_RPC", "https://api.avax-test.network/ext/bc/C/rpc")
CHAIN_ID = 43113

MILESTONES = [
    ("Site clearing and foundation", 20),
    ("Ground floor slab", 20),
    ("First floor structure", 20),
    ("Roofing complete", 20),
    ("Finishing and handover", 20),
]
STALL_AFTER = 30 * 24 * 3600


def compile_all():
    solc = os.getenv("SOLC", str(Path.home() / "bin" / "solc"))
    out = subprocess.run(
        [solc, "--combined-json", "abi,bin", "--optimize",
         str(ROOT / "contracts" / "PropertyEscrow.sol"),
         str(ROOT / "contracts" / "MockKES.sol")],
        capture_output=True, text=True,
    )
    if out.returncode != 0:
        sys.exit(out.stderr)
    data = json.loads(out.stdout)
    arts = {}
    for key, val in data["contracts"].items():
        abi = val["abi"]
        arts[key.split(":")[-1]] = {
            "abi": json.loads(abi) if isinstance(abi, str) else abi,
            "bin": val["bin"],
        }
    return arts


def send(w3, acct, tx):
    tx.update({
        "chainId": CHAIN_ID,
        "from": acct.address,
        "nonce": w3.eth.get_transaction_count(acct.address),
        "gasPrice": w3.eth.gas_price,
    })
    tx.setdefault("gas", 3_500_000)
    signed = acct.sign_transaction(tx)
    h = w3.eth.send_raw_transaction(signed.raw_transaction)
    return w3.eth.wait_for_transaction_receipt(h, timeout=180)


def main():
    key = os.getenv("DEPLOYER_KEY")
    if not key:
        sys.exit("Set DEPLOYER_KEY to a Fuji-funded private key")

    w3 = Web3(Web3.HTTPProvider(RPC))
    w3.middleware_onion.inject(ExtraDataToPOAMiddleware, layer=0)
    if not w3.is_connected():
        sys.exit(f"Cannot reach {RPC}")

    acct = w3.eth.account.from_key(key)
    balance = w3.from_wei(w3.eth.get_balance(acct.address), "ether")
    print(f"Deployer  {acct.address}  ({balance:.3f} AVAX)")
    if balance < 0.1:
        sys.exit("Top up from the Fuji faucet first: https://core.app/tools/testnet-faucet")

    arts = compile_all()

    # Roles. Separate keys in production — the whole point is that no single
    # party can move the money.
    developer = os.getenv("DEVELOPER_ADDR", acct.address)
    oracle = os.getenv("ORACLE_ADDR", acct.address)
    surveyor = os.getenv("SURVEYOR_ADDR", acct.address)
    platform = acct.address

    kes_c = w3.eth.contract(abi=arts["MockKES"]["abi"], bytecode=arts["MockKES"]["bin"])
    rc = send(w3, acct, kes_c.constructor().build_transaction({"gas": 900_000}))
    kes_addr = rc.contractAddress
    print(f"Token     {kes_addr}")

    esc_c = w3.eth.contract(abi=arts["PropertyEscrow"]["abi"], bytecode=arts["PropertyEscrow"]["bin"])
    rc = send(w3, acct, esc_c.constructor(
        kes_addr, developer, [oracle, surveyor, platform],
        [m[0] for m in MILESTONES], [m[1] for m in MILESTONES], STALL_AFTER,
    ).build_transaction({"gas": 3_500_000}))
    esc_addr = rc.contractAddress
    print(f"Escrow    {esc_addr}")

    (ROOT / "deployment.fuji.json").write_text(json.dumps({
        "chainId": CHAIN_ID, "rpc": RPC, "token": kes_addr, "escrow": esc_addr,
        "developer": developer, "oracle": oracle, "surveyor": surveyor,
        "platform": platform,
        "abi": {"PropertyEscrow": arts["PropertyEscrow"]["abi"],
                "MockKES": arts["MockKES"]["abi"]},
    }, indent=2))

    print(f"\nExplorer  https://testnet.snowtrace.io/address/{esc_addr}")
    print("Written   deployment.fuji.json")


if __name__ == "__main__":
    main()
