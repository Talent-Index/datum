"""
Local EVM tests for PropertyEscrow.

Run:  python3 tests/test_escrow.py

These target the four things that are easy to get wrong and expensive to get
wrong in production:

  1. Release amounts when buyers join mid-construction
  2. Refund fairness regardless of who claims first
  3. Two of three attesters, so no single party controls the money
  4. Buyers can reach their funds without the platform's cooperation
"""

import json
import subprocess
import sys
from pathlib import Path

from web3 import Web3, EthereumTesterProvider

ROOT = Path(__file__).resolve().parent.parent
SOLC = Path.home() / "bin" / "solc"

KES = 100  # 2 decimals: 100 units = KES 1.00


def compile_contracts():
    out = subprocess.run(
        [
            str(SOLC),
            "--combined-json",
            "abi,bin",
            "--optimize",
            str(ROOT / "contracts" / "PropertyEscrow.sol"),
            str(ROOT / "contracts" / "MockKES.sol"),
        ],
        capture_output=True,
        text=True,
    )
    if out.returncode != 0:
        print(out.stderr)
        sys.exit(1)
    data = json.loads(out.stdout)
    result = {}
    for key, val in data["contracts"].items():
        name = key.split(":")[-1]
        abi = val["abi"]
        if isinstance(abi, str):
            abi = json.loads(abi)
        result[name] = {"abi": abi, "bin": val["bin"]}
    return result


def deploy(w3, art, sender, *args):
    c = w3.eth.contract(abi=art["abi"], bytecode=art["bin"])
    tx = c.constructor(*args).transact({"from": sender})
    rc = w3.eth.wait_for_transaction_receipt(tx)
    return w3.eth.contract(address=rc.contractAddress, abi=art["abi"])


class Harness:
    """One development, five milestones, three attesters."""

    MILESTONES = [
        "Site clearing and foundation",
        "Ground floor slab",
        "First floor structure",
        "Roofing complete",
        "Finishing and handover",
    ]
    PERCENTS = [20, 20, 20, 20, 20]

    def __init__(self, artifacts, stall_after=90 * 24 * 3600):
        self.w3 = Web3(EthereumTesterProvider())
        a = self.w3.eth.accounts
        self.platform, self.developer, self.oracle, self.surveyor = a[0], a[1], a[2], a[3]
        self.settlement = a[4]  # platform's fiat settlement wallet
        self.buyers = a[5:9]

        self.kes = deploy(self.w3, artifacts["MockKES"], self.platform)
        self.escrow = deploy(
            self.w3,
            artifacts["PropertyEscrow"],
            self.platform,
            self.kes.address,
            self.developer,
            [self.oracle, self.surveyor, self.platform],
            self.MILESTONES,
            self.PERCENTS,
            stall_after,
        )
        self.kes.functions.mint(self.settlement, 100_000_000 * KES).transact(
            {"from": self.platform}
        )
        self.kes.functions.approve(self.escrow.address, 100_000_000 * KES).transact(
            {"from": self.settlement}
        )

    def deposit(self, buyer, kes_amount):
        """M-Pesa lands in the settlement wallet; platform records the claim."""
        self.escrow.functions.depositFor(buyer, kes_amount * KES).transact(
            {"from": self.settlement}
        )

    def attest(self, milestone_id, role, who, evidence=b"\x11" * 32):
        self.escrow.functions.attest(milestone_id, role, evidence).transact({"from": who})

    def advance(self, milestone_id):
        """Oracle + surveyor. The platform is deliberately not involved."""
        self.attest(milestone_id, 0, self.oracle)
        self.attest(milestone_id, 1, self.surveyor)

    def held(self):
        return self.escrow.functions.heldBalance().call() // KES

    def dev_balance(self):
        return self.kes.functions.balanceOf(self.developer).call() // KES

    def buyer_balance(self, b):
        return self.kes.functions.balanceOf(b).call() // KES


PASS, FAIL = [], []


def check(label, actual, expected):
    if actual == expected:
        PASS.append(label)
        print(f"  PASS  {label}")
    else:
        FAIL.append(label)
        print(f"  FAIL  {label}: got {actual}, expected {expected}")


def test_late_joiners(art):
    """The bug that breaks every naive escrow: buyers arriving mid-build."""
    print("\nBuyers joining throughout construction")
    h = Harness(art)

    h.deposit(h.buyers[0], 1_000_000)
    h.advance(0)  # 20% cumulative
    check("milestone 1 releases 20% of KES 1M", h.dev_balance(), 200_000)

    h.deposit(h.buyers[1], 1_000_000)  # joins after foundation
    h.advance(1)  # 40% cumulative on a KES 2M pool
    check("milestone 2 releases catch-up to 40% of KES 2M", h.dev_balance(), 800_000)
    check("still held after milestone 2", h.held(), 1_200_000)

    h.deposit(h.buyers[2], 2_000_000)  # joins at roofing
    h.advance(2)
    h.advance(3)
    h.advance(4)
    check("all funds released at handover", h.dev_balance(), 4_000_000)
    check("nothing stranded in escrow", h.held(), 0)

    contributed, released, still_held = h.escrow.functions.buyerPosition(h.buyers[0]).call()
    check("buyer position reconciles", contributed // KES, 1_000_000)


def test_refund_fairness(art):
    """Claim order must not change what anyone receives."""
    print("\nRefunds after a developer walks away")
    h = Harness(art)

    h.deposit(h.buyers[0], 1_000_000)
    h.deposit(h.buyers[1], 1_000_000)
    h.deposit(h.buyers[2], 2_000_000)

    h.advance(0)
    h.advance(1)  # 40% gone to the developer, KES 2.4M left
    check("developer took 40%", h.dev_balance(), 1_600_000)
    check("escrow retains the rest", h.held(), 2_400_000)

    h.escrow.functions.declareStalled().transact({"from": h.platform})

    # Deliberately claim in a different order than deposits were made.
    h.escrow.functions.claimRefund(h.buyers[2]).transact({"from": h.buyers[2]})
    h.escrow.functions.claimRefund(h.buyers[0]).transact({"from": h.buyers[0]})
    h.escrow.functions.claimRefund(h.buyers[1]).transact({"from": h.buyers[1]})

    check("first claimant gets pro rata, not everything", h.buyer_balance(h.buyers[2]), 1_200_000)
    check("second claimant gets equal share", h.buyer_balance(h.buyers[0]), 600_000)
    check("last claimant is not shortchanged", h.buyer_balance(h.buyers[1]), 600_000)
    check("pool fully distributed", h.held(), 0)

    try:
        h.escrow.functions.claimRefund(h.buyers[0]).transact({"from": h.buyers[0]})
        check("double refund blocked", "allowed", "reverted")
    except Exception:
        check("double refund blocked", "reverted", "reverted")


def test_threshold(art):
    """Two of three. No single party can force or block a release."""
    print("\nAttestation threshold")
    h = Harness(art)
    h.deposit(h.buyers[0], 1_000_000)

    h.attest(0, 0, h.oracle)
    check("one attester does not release", h.dev_balance(), 0)

    try:
        h.attest(0, 0, h.oracle)
        check("same attester cannot sign twice", "allowed", "reverted")
    except Exception:
        check("same attester cannot sign twice", "reverted", "reverted")

    try:
        h.attest(0, 1, h.buyers[0])
        check("outsider cannot attest", "allowed", "reverted")
    except Exception:
        check("outsider cannot attest", "reverted", "reverted")

    h.attest(0, 1, h.surveyor)
    check("oracle + surveyor release without the platform", h.dev_balance(), 200_000)

    # And the platform can substitute for a missing oracle.
    h.attest(1, 1, h.surveyor)
    h.attest(1, 2, h.platform)
    check("surveyor + platform also release", h.dev_balance(), 400_000)


def test_ordering_and_timeout(art):
    """Milestones run in order; buyers can escape a silent platform."""
    print("\nOrdering and the timeout escape hatch")
    h = Harness(art, stall_after=60)
    h.deposit(h.buyers[0], 1_000_000)

    try:
        h.attest(2, 0, h.oracle)
        check("cannot skip ahead to a later milestone", "allowed", "reverted")
    except Exception:
        check("cannot skip ahead to a later milestone", "reverted", "reverted")

    try:
        h.escrow.functions.declareStalled().transact({"from": h.buyers[0]})
        check("cannot stall an active project early", "allowed", "reverted")
    except Exception:
        check("cannot stall an active project early", "reverted", "reverted")

    h.w3.provider.ethereum_tester.time_travel(
        h.w3.eth.get_block("latest").timestamp + 200
    )
    h.escrow.functions.declareStalled().transact({"from": h.buyers[0]})
    check("a buyer can stall a silent project", h.escrow.functions.status().call(), 1)

    h.escrow.functions.claimRefund(h.buyers[0]).transact({"from": h.buyers[0]})
    check("and recover the full unreleased balance", h.buyer_balance(h.buyers[0]), 1_000_000)


if __name__ == "__main__":
    print("Compiling contracts")
    artifacts = compile_contracts()
    print(f"  {', '.join(artifacts)}")

    test_late_joiners(artifacts)
    test_refund_fairness(artifacts)
    test_threshold(artifacts)
    test_ordering_and_timeout(artifacts)

    print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
    sys.exit(1 if FAIL else 0)
