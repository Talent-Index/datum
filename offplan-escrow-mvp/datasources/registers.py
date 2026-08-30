"""
Kenyan public registers.

None of these publish an API. This module gives each one a uniform adapter
backed by a local CSV, so the pipeline is written against a stable interface
today and the acquisition method can change without touching anything above.

Acquisition, per source, honestly stated:

  NCA register of contractors
    Portal at nca.go.ke. Search is public, bulk export is not. Section 25 of
    the NCA Act lets the Authority deregister contractors who default on
    annual licence renewal, and a deregistered contractor cannot re-register
    under a different name. That makes deregistration a permanent, checkable
    negative signal worth capturing. Get bulk access by asking: the NCA has an
    institutional interest in the same outcome you do.

  EBK project registration
    Launched December 2025. Engineers register a project and receive a unique
    number before drawings go to the county. A live site with no registration
    number is a real risk flag, and almost nobody is checking this yet.

  Kenya Gazette
    Genuinely public at kenyalaw.org. Insolvency notices, winding-up petitions
    and liquidator appointments against a developer are the strongest negative
    signal available and cost nothing.

  Business Registration Service
    Company particulars, directors and registered charges via eCitizen. Paid
    per search, no bulk. Budget for it on named developers only.

Legal note: scraping any of these is a terms question, not just a technical
one, and director details are personal data under the Data Protection Act
2019. Register with the ODPC and document a lawful basis before you hold this
at scale. That is a week of work now and a dead deal later.
"""

from __future__ import annotations

import csv
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "fixtures" / "registers"


@dataclass
class ContractorRecord:
    name: str
    nca_number: str
    category: str
    status: str  # active | lapsed | deregistered
    licence_expiry: date | None
    source: str = "nca"


@dataclass
class GazetteNotice:
    company: str
    notice_type: str  # winding-up | insolvency | liquidator | charge
    gazette_date: date
    reference: str


@dataclass
class DeveloperCheck:
    name: str
    contractor: ContractorRecord | None
    notices: list[GazetteNotice] = field(default_factory=list)
    project_registered: bool | None = None
    flags: list[str] = field(default_factory=list)
    verdict: str = "unknown"


def _rows(filename: str) -> list[dict]:
    path = DATA_DIR / filename
    if not path.exists():
        return []
    with path.open(newline="", encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def _date(value: str) -> date | None:
    try:
        return datetime.strptime(value.strip(), "%Y-%m-%d").date()
    except (ValueError, AttributeError):
        return None


def _norm(name: str) -> str:
    drop = {"ltd", "limited", "company", "co", "and", "the", "&"}
    words = [w.strip(".,") for w in name.lower().split()]
    return " ".join(w for w in words if w and w not in drop)


def find_contractor(name: str) -> ContractorRecord | None:
    target = _norm(name)
    for row in _rows("nca_contractors.csv"):
        if _norm(row["name"]) == target:
            return ContractorRecord(
                name=row["name"],
                nca_number=row["nca_number"],
                category=row["category"],
                status=row["status"],
                licence_expiry=_date(row["licence_expiry"]),
            )
    return None


def find_notices(name: str) -> list[GazetteNotice]:
    target = _norm(name)
    out = []
    for row in _rows("gazette_notices.csv"):
        if _norm(row["company"]) == target:
            out.append(GazetteNotice(
                company=row["company"],
                notice_type=row["notice_type"],
                gazette_date=_date(row["gazette_date"]),
                reference=row["reference"],
            ))
    return sorted(out, key=lambda n: n.gazette_date or date.min, reverse=True)


def project_is_registered(project_ref: str) -> bool | None:
    rows = _rows("ebk_projects.csv")
    if not rows:
        return None
    return any(r["project_ref"].strip() == project_ref.strip() for r in rows)


def check_developer(name: str, project_ref: str | None = None, today: date | None = None) -> DeveloperCheck:
    """
    Combine the registers into one verdict.

    Ordered by severity: an insolvency notice outranks a lapsed licence, and a
    deregistration outranks both because it is permanent.
    """
    today = today or date.today()
    contractor = find_contractor(name)
    notices = find_notices(name)
    registered = project_is_registered(project_ref) if project_ref else None

    flags: list[str] = []

    if contractor is None:
        flags.append("Not found in the NCA register of contractors")
    elif contractor.status == "deregistered":
        flags.append(f"Deregistered by the NCA and barred from re-registering ({contractor.nca_number})")
    elif contractor.status == "lapsed":
        flags.append(f"NCA licence lapsed ({contractor.nca_number})")
    elif contractor.licence_expiry and contractor.licence_expiry < today:
        flags.append(f"NCA licence expired {contractor.licence_expiry}")

    for n in notices:
        if n.notice_type in ("winding-up", "insolvency", "liquidator"):
            flags.append(f"Gazette {n.notice_type} notice dated {n.gazette_date} ({n.reference})")

    if registered is False:
        flags.append("No EBK project registration found for this project reference")

    severe = any(
        k in f.lower()
        for f in flags
        for k in ("deregistered", "winding-up", "insolvency", "liquidator")
    )
    if severe:
        verdict = "do not proceed"
    elif flags:
        verdict = "proceed with conditions"
    elif contractor:
        verdict = "clear"
    else:
        verdict = "unknown"

    return DeveloperCheck(
        name=name,
        contractor=contractor,
        notices=notices,
        project_registered=registered,
        flags=flags,
        verdict=verdict,
    )
