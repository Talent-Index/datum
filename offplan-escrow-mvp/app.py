"""
Off-plan escrow MVP — runnable demo.

    python3 app.py            then open http://localhost:8000

Runs an in-process EVM with the escrow contract deployed, so the whole loop
works with no network, no faucet and no wallet. When you are ready for Fuji,
swap `Chain` for a JsonRpcProvider pointed at
https://api.avax-test.network/ext/bc/C/rpc — nothing else changes.

Deliberately custodial: the buyer never holds a key. That is the right product
decision for this market and the right thing to say out loud to a regulator.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from web3 import Web3, EthereumTesterProvider

sys.path.insert(0, str(Path(__file__).resolve().parent))
from evidence.fixtures import SITE_LAT, SITE_LON, build_demo_set  # noqa: E402
from evidence.verifier import EvidenceVerifier, Site, verdict_to_dict  # noqa: E402
from datasources.corroborate import corroborate  # noqa: E402

ROOT = Path(__file__).resolve().parent
SOLC = Path.home() / "bin" / "solc"
KES = 100  # token has 2 decimals

DEVELOPER_NAME = "Willow Park Developments Ltd"
PROJECT_REF = "EBK/PR/2026/00812"

MILESTONES = [
    ("Site clearing and foundation", "foundation", 20),
    ("Ground floor slab", "ground_slab", 20),
    ("First floor structure", "superstructure", 20),
    ("Roofing complete", "roofing", 20),
    ("Finishing and handover", "finishing", 20),
]

ROLE_NAMES = {0: "Evidence pipeline", 1: "Quantity surveyor", 2: "Platform"}


# ─── Compilation ─────────────────────────────────────────────────────────


def compile_contracts() -> dict:
    solc = shutil.which("solc") or str(SOLC)
    out = subprocess.run(
        [solc, "--combined-json", "abi,bin", "--optimize",
         str(ROOT / "contracts" / "PropertyEscrow.sol"),
         str(ROOT / "contracts" / "MockKES.sol")],
        capture_output=True, text=True,
    )
    if out.returncode != 0:
        raise RuntimeError(f"solc failed:\n{out.stderr}")
    data = json.loads(out.stdout)
    arts = {}
    for key, val in data["contracts"].items():
        abi = val["abi"]
        arts[key.split(":")[-1]] = {
            "abi": json.loads(abi) if isinstance(abi, str) else abi,
            "bin": val["bin"],
        }
    return arts


# ─── Chain ───────────────────────────────────────────────────────────────


class Chain:
    """In-process EVM holding one live project."""

    def __init__(self, artifacts: dict):
        self.w3 = Web3(EthereumTesterProvider())
        a = self.w3.eth.accounts
        self.platform, self.developer = a[0], a[1]
        self.oracle, self.surveyor = a[2], a[3]
        self.settlement = a[4]
        self.pool = a[5:12]  # buyer addresses handed out as people sign up
        self.assigned: dict[str, str] = {}
        self.artifacts = artifacts
        self.deploy()

    def deploy(self):
        self.kes = self._deploy("MockKES")
        self.escrow = self._deploy(
            "PropertyEscrow",
            self.kes.address,
            self.developer,
            [self.oracle, self.surveyor, self.platform],
            [m[0] for m in MILESTONES],
            [m[2] for m in MILESTONES],
            30 * 24 * 3600,  # 30 days of silence and anyone can stall it
        )
        self.kes.functions.mint(self.settlement, 500_000_000 * KES).transact(
            {"from": self.platform})
        self.kes.functions.approve(self.escrow.address, 500_000_000 * KES).transact(
            {"from": self.settlement})
        self.assigned.clear()

    def _deploy(self, name, *args):
        art = self.artifacts[name]
        c = self.w3.eth.contract(abi=art["abi"], bytecode=art["bin"])
        tx = c.constructor(*args).transact({"from": self.platform})
        rc = self.w3.eth.wait_for_transaction_receipt(tx)
        return self.w3.eth.contract(address=rc.contractAddress, abi=art["abi"])

    def address_for(self, phone: str) -> str:
        """
        Phone number in, managed address out. In production this is Privy or a
        KMS-backed key; the buyer never sees it and never signs.
        """
        if phone not in self.assigned:
            if len(self.assigned) >= len(self.pool):
                raise HTTPException(400, "Demo buyer pool exhausted. Reset the project.")
            self.assigned[phone] = self.pool[len(self.assigned)]
        return self.assigned[phone]


# ─── App ─────────────────────────────────────────────────────────────────

app = FastAPI(title="Off-plan escrow MVP")

ARTIFACTS = compile_contracts()
chain = Chain(ARTIFACTS)
verifier = EvidenceVerifier()
SITE = Site(
    project_id="willow-park-a",
    name="Willow Park Block A, Kilimani",
    latitude=SITE_LAT,
    longitude=SITE_LON,
)

FIXTURE_DIR = Path(tempfile.mkdtemp(prefix="kescrow-photos-"))
FIXTURES = build_demo_set(FIXTURE_DIR, now=datetime.now())
LAST_VERDICT: dict | None = None
CORROBORATION: dict | None = None


class DepositBody(BaseModel):
    phone: str
    kes: int


class EvidenceBody(BaseModel):
    scenario: str  # honest | recycled | wrong_site | no_gps


class AttestBody(BaseModel):
    role: int


class CorroborateBody(BaseModel):
    developer: str | None = None


def project_state() -> dict:
    e = chain.escrow.functions
    total = e.totalDeposited().call()
    released = e.totalReleased().call()
    held = e.heldBalance().call()
    nxt = e.nextMilestone().call()
    status = ["Active", "Stalled", "Completed"][e.status().call()]

    ms = []
    for i in range(len(MILESTONES)):
        raw = e.milestones(i).call()
        signers = [
            ROLE_NAMES[r] for r in range(3)
            if e.hasAttested(i, r).call()
        ]
        ms.append({
            "id": i,
            "description": raw[0],
            "stage": MILESTONES[i][1],
            "percent": raw[1],
            "cumulative": raw[2],
            "evidence_hash": "0x" + raw[3].hex() if raw[3] != b"\x00" * 32 else None,
            "approvals": raw[4],
            "released": raw[5],
            "signers": signers,
            "current": i == nxt and status == "Active",
        })

    buyers = []
    for phone, addr in chain.assigned.items():
        contributed, rel, still = e.buyerPosition(addr).call()
        if contributed == 0:
            continue
        buyers.append({
            "phone": phone,
            "address": addr,
            "contributed": contributed // KES,
            "released": rel // KES,
            "still_held": still // KES,
            "refunded": e.refunded(addr).call(),
        })

    return {
        "site": SITE.name,
        "status": status,
        "total_deposited": total // KES,
        "total_released": released // KES,
        "held": held // KES,
        "developer_received": chain.kes.functions.balanceOf(chain.developer).call() // KES,
        "next_milestone": nxt,
        "milestones": ms,
        "buyers": buyers,
        "last_verdict": LAST_VERDICT,
        "corroboration": CORROBORATION,
        "developer_name": DEVELOPER_NAME,
        "contract": chain.escrow.address,
    }


@app.get("/")
def index():
    return FileResponse(ROOT / "web" / "index.html")


@app.get("/api/state")
def state():
    return project_state()


@app.post("/api/deposit")
def deposit(body: DepositBody):
    """Stands in for an M-Pesa STK push settling into the platform account."""
    if body.kes <= 0:
        raise HTTPException(400, "Amount must be greater than zero")
    addr = chain.address_for(body.phone)
    try:
        chain.escrow.functions.depositFor(addr, body.kes * KES).transact(
            {"from": chain.settlement})
    except Exception as exc:
        raise HTTPException(400, _revert_reason(exc))
    return {"ok": True, "address": addr, "sms":
            f"Deposit received. KES {body.kes:,} is held in escrow for "
            f"{SITE.name}. It is released to the developer only as construction "
            f"is verified."}


@app.post("/api/evidence")
def submit_evidence(body: EvidenceBody):
    """Developer uploads site photographs; the pipeline rules on them."""
    global LAST_VERDICT
    mid = chain.escrow.functions.nextMilestone().call()
    if mid >= len(MILESTONES):
        raise HTTPException(400, "All milestones complete")

    stage = MILESTONES[mid][1]
    paths = FIXTURES.get(body.scenario)
    if not paths:
        raise HTTPException(400, f"Unknown scenario: {body.scenario}")

    # Regenerate honest photos per milestone so each stage looks different.
    if body.scenario == "honest":
        from evidence.fixtures import make_photo
        paths = [
            make_photo(FIXTURE_DIR / f"m{mid}_{i}.jpg", stage,
                       datetime.now() - timedelta(days=2), seed=mid * 17 + i)
            for i in range(3)
        ]

    verdict = verifier.verify(SITE, mid, stage, paths, now=datetime.now())
    LAST_VERDICT = verdict_to_dict(verdict)

    if verdict.accepted:
        chain.escrow.functions.attest(
            mid, 0, bytes.fromhex(verdict.evidence_hash[2:])
        ).transact({"from": chain.oracle})

    return LAST_VERDICT


@app.post("/api/attest")
def attest(body: AttestBody):
    """Surveyor or platform signs. Two of three releases the funds."""
    mid = chain.escrow.functions.nextMilestone().call()
    if mid >= len(MILESTONES):
        raise HTTPException(400, "All milestones complete")
    signer = {1: chain.surveyor, 2: chain.platform}.get(body.role)
    if signer is None:
        raise HTTPException(400, "Role must be 1 (surveyor) or 2 (platform)")
    evidence = bytes.fromhex((LAST_VERDICT or {}).get("evidence_hash", "0x" + "00" * 32)[2:])
    try:
        chain.escrow.functions.attest(mid, body.role, evidence).transact({"from": signer})
    except Exception as exc:
        raise HTTPException(400, _revert_reason(exc))
    return {"ok": True}


@app.post("/api/corroborate")
def run_corroboration(body: CorroborateBody):
    """
    Check the site and the company against public records. Runs from the
    committed cache, so it works offline; warm the cache to hit the real
    endpoints. See datasources/warm.py.
    """
    global CORROBORATION
    name = body.developer or DEVELOPER_NAME
    result = corroborate(
        site_name=SITE.name,
        developer=name,
        latitude=SITE.latitude,
        longitude=SITE.longitude,
        project_ref=PROJECT_REF,
    )
    CORROBORATION = {
        "developer": name,
        "verdict": result.verdict,
        "corroborating": result.corroborating,
        "findings": result.findings,
        "unavailable": result.unavailable,
        "buildings": (result.footprint or {}).get("building_count"),
        "under_construction": (result.footprint or {}).get("buildings_under_construction"),
        "drift_m": (result.location or {}).get("drift_m"),
    }
    return CORROBORATION


@app.post("/api/stall")
def stall():
    try:
        chain.escrow.functions.declareStalled().transact({"from": chain.platform})
    except Exception as exc:
        raise HTTPException(400, _revert_reason(exc))
    return {"ok": True}


@app.post("/api/refund")
def refund():
    """Every buyer takes their pro rata share of what is left."""
    paid = []
    for phone, addr in chain.assigned.items():
        if chain.escrow.functions.deposited(addr).call() == 0:
            continue
        if chain.escrow.functions.refunded(addr).call():
            continue
        before = chain.kes.functions.balanceOf(addr).call()
        chain.escrow.functions.claimRefund(addr).transact({"from": addr})
        after = chain.kes.functions.balanceOf(addr).call()
        paid.append({"phone": phone, "refund": (after - before) // KES})
    return {"ok": True, "refunds": paid}


@app.post("/api/reset")
def reset():
    global LAST_VERDICT, CORROBORATION
    chain.deploy()
    verifier._seen.clear()
    LAST_VERDICT = None
    CORROBORATION = None
    return {"ok": True}


def _revert_reason(exc: Exception) -> str:
    text = str(exc)
    for marker in ("revert ", "execution reverted: "):
        if marker in text:
            return text.split(marker, 1)[1].strip(" '\")")
    return text[:200]


@app.exception_handler(HTTPException)
def http_error(request, exc: HTTPException):
    return JSONResponse({"error": exc.detail}, status_code=exc.status_code)


if __name__ == "__main__":
    import uvicorn
    print(f"\n  Escrow deployed at {chain.escrow.address}")
    print(f"  Site photos in {FIXTURE_DIR}")
    print("  Open http://localhost:8000\n")
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="warning")
