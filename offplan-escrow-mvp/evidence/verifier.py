"""
Evidence verification for construction milestones.

This is the part of the product that is actually hard to copy. The escrow
contract is a weekend of Solidity; the reason a developer pays you and a bank
trusts you is that the photographs backing each release survive scrutiny.

Four checks run on every submitted image:

  1. Location   — EXIF GPS inside the geofence for this site
  2. Recency    — capture timestamp within the reporting window
  3. Novelty    — perceptual hash not seen on this project before, which
                  catches a photo resubmitted from an earlier milestone or
                  lifted from another site
  4. Stage      — the visible construction stage matches what is claimed

The stage classifier here is a deliberately swappable stub. Wire a real model
into `StageClassifier.classify` — a fine-tuned ONNX image classifier, or a
vision-language model call — without touching anything else.
"""

from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass, asdict, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Iterable

import imagehash
from PIL import Image, ExifTags

# Construction stages in the order they occur on site. Order matters: seeing
# roofing when foundation is claimed is odd but not fraud; seeing foundation
# when roofing is claimed means the project has not progressed.
STAGES = [
    "site_clearing",
    "foundation",
    "ground_slab",
    "superstructure",
    "roofing",
    "finishing",
]

PHASH_DISTANCE_THRESHOLD = 6  # Hamming distance below this counts as a repeat
DEFAULT_GEOFENCE_METRES = 150
DEFAULT_MAX_AGE_DAYS = 30


# ─── EXIF ────────────────────────────────────────────────────────────────


def _rational(value) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        try:
            return value.numerator / value.denominator
        except Exception:
            return 0.0


def _dms_to_degrees(dms, ref: str) -> float:
    deg, minutes, seconds = (_rational(v) for v in dms)
    result = deg + minutes / 60 + seconds / 3600
    return -result if ref in ("S", "W") else result


def read_exif(path: Path) -> dict:
    """Pull GPS and capture time. Missing EXIF is a finding, not an error."""
    out: dict = {"gps": None, "captured_at": None, "make": None, "model": None}
    try:
        with Image.open(path) as img:
            raw = img._getexif()
    except Exception:
        return out
    if not raw:
        return out

    tags = {ExifTags.TAGS.get(k, k): v for k, v in raw.items()}
    out["make"] = tags.get("Make")
    out["model"] = tags.get("Model")

    stamp = tags.get("DateTimeOriginal") or tags.get("DateTime")
    if stamp:
        try:
            out["captured_at"] = datetime.strptime(str(stamp), "%Y:%m:%d %H:%M:%S")
        except ValueError:
            pass

    gps_raw = tags.get("GPSInfo")
    if gps_raw:
        gps = {ExifTags.GPSTAGS.get(k, k): v for k, v in gps_raw.items()}
        if all(k in gps for k in ("GPSLatitude", "GPSLatitudeRef", "GPSLongitude", "GPSLongitudeRef")):
            out["gps"] = (
                _dms_to_degrees(gps["GPSLatitude"], gps["GPSLatitudeRef"]),
                _dms_to_degrees(gps["GPSLongitude"], gps["GPSLongitudeRef"]),
            )
    return out


def haversine_metres(a: tuple[float, float], b: tuple[float, float]) -> float:
    r = 6_371_000
    lat1, lon1, lat2, lon2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    dlat, dlon = lat2 - lat1, lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


# ─── Stage classification ────────────────────────────────────────────────


class StageClassifier:
    """
    Swap point for the real model.

    Production options, in order of effort:
      - Vision-language model with a constrained JSON response
      - CLIP zero-shot against textual stage descriptions (runs offline)
      - Fine-tuned classifier exported to ONNX once you have labelled sites

    The stub reads a sidecar `<image>.stage` file so the whole pipeline can be
    exercised deterministically before any model exists.
    """

    def __init__(self, model=None):
        self.model = model

    def classify(self, path: Path) -> tuple[str, float]:
        if self.model is not None:
            return self.model(path)
        sidecar = path.with_suffix(path.suffix + ".stage")
        if sidecar.exists():
            parts = sidecar.read_text().strip().split()
            stage = parts[0]
            confidence = float(parts[1]) if len(parts) > 1 else 0.9
            return stage, confidence
        return "unknown", 0.0


# ─── Site register ───────────────────────────────────────────────────────


@dataclass
class Site:
    project_id: str
    name: str
    latitude: float
    longitude: float
    geofence_metres: int = DEFAULT_GEOFENCE_METRES
    max_age_days: int = DEFAULT_MAX_AGE_DAYS


@dataclass
class ImageFinding:
    filename: str
    sha256: str
    phash: str
    passed: bool
    checks: dict = field(default_factory=dict)
    notes: list[str] = field(default_factory=list)
    failures: list[str] = field(default_factory=list)


@dataclass
class Verdict:
    project_id: str
    milestone_id: int
    claimed_stage: str
    accepted: bool
    evidence_hash: str
    images: list[ImageFinding]
    summary: str


class EvidenceVerifier:
    """
    Holds the perceptual hashes already seen for a project so a resubmitted
    photograph is caught. Back this with your database in production; the
    in-memory dict is fine for a demo and for local development.
    """

    def __init__(self, classifier: StageClassifier | None = None):
        self.classifier = classifier or StageClassifier()
        self._seen: dict[str, list[tuple[imagehash.ImageHash, str]]] = {}

    def remember(self, project_id: str, phash: imagehash.ImageHash, label: str) -> None:
        self._seen.setdefault(project_id, []).append((phash, label))

    def _duplicate_of(self, project_id: str, phash: imagehash.ImageHash) -> str | None:
        for known, label in self._seen.get(project_id, []):
            if abs(phash - known) <= PHASH_DISTANCE_THRESHOLD:
                return label
        return None

    def verify(
        self,
        site: Site,
        milestone_id: int,
        claimed_stage: str,
        paths: Iterable[Path],
        now: datetime | None = None,
        min_images: int = 3,
    ) -> Verdict:
        now = now or datetime.now()
        findings: list[ImageFinding] = []

        for path in paths:
            data = path.read_bytes()
            sha = hashlib.sha256(data).hexdigest()
            with Image.open(path) as im:
                phash = imagehash.phash(im)

            exif = read_exif(path)
            checks: dict[str, bool] = {}
            notes: list[str] = []

            # 1. Location
            if exif["gps"] is None:
                checks["location"] = False
                notes.append("No GPS data in image metadata")
            else:
                distance = haversine_metres(exif["gps"], (site.latitude, site.longitude))
                checks["location"] = distance <= site.geofence_metres
                if not checks["location"]:
                    notes.append(f"Captured {distance:,.0f}m from the registered site")
                else:
                    notes.append(f"Within {distance:,.0f}m of the registered site")

            # 2. Recency
            captured = exif["captured_at"]
            if captured is None:
                checks["recency"] = False
                notes.append("No capture timestamp in image metadata")
            else:
                age = now - captured
                checks["recency"] = timedelta(0) <= age <= timedelta(days=site.max_age_days)
                if age < timedelta(0):
                    notes.append("Capture timestamp is in the future")
                elif not checks["recency"]:
                    notes.append(f"Captured {age.days} days ago, outside the reporting window")
                else:
                    notes.append(f"Captured {age.days} days ago")

            # 3. Novelty
            duplicate = self._duplicate_of(site.project_id, phash)
            checks["novelty"] = duplicate is None
            if duplicate:
                notes.append(f"Matches an image already submitted for {duplicate}")

            # 4. Stage
            stage, confidence = self.classifier.classify(path)
            checks["stage"] = stage == claimed_stage and confidence >= 0.6
            if stage == "unknown":
                notes.append("Stage could not be determined")
            elif not checks["stage"]:
                notes.append(f"Shows {stage.replace('_', ' ')}, not {claimed_stage.replace('_', ' ')}")
            else:
                notes.append(f"Shows {stage.replace('_', ' ')} ({confidence:.0%} confidence)")

            # Notes are appended in check order, so a note belongs to a failure
            # exactly when its corresponding check failed.
            failures = [n for n, ok in zip(notes, checks.values()) if not ok]

            findings.append(
                ImageFinding(
                    filename=path.name,
                    sha256=sha,
                    phash=str(phash),
                    passed=all(checks.values()),
                    checks=checks,
                    notes=notes,
                    failures=failures,
                )
            )

        clean = [f for f in findings if f.passed]
        accepted = len(clean) >= min_images

        if accepted:
            for f, path in zip(findings, paths):
                if f.passed:
                    with Image.open(path) as im:
                        self.remember(site.project_id, imagehash.phash(im), f"milestone {milestone_id}")

        evidence_hash = self._bundle_hash(site, milestone_id, claimed_stage, findings)

        if accepted:
            summary = f"{len(clean)} of {len(findings)} images verified. Milestone evidence accepted."
        else:
            reasons = sorted({r for f in findings for r in f.failures})
            summary = (
                f"{len(clean)} of {len(findings)} images passed, {min_images} required. "
                + "; ".join(reasons[:2])
                + ("." if reasons else "")
            )

        return Verdict(
            project_id=site.project_id,
            milestone_id=milestone_id,
            claimed_stage=claimed_stage,
            accepted=accepted,
            evidence_hash=evidence_hash,
            images=findings,
            summary=summary,
        )

    @staticmethod
    def _bundle_hash(site: Site, milestone_id: int, stage: str, findings: list[ImageFinding]) -> str:
        """
        Deterministic hash over the whole submission. This is what gets written
        on chain, so anyone holding the original images can prove later that the
        record was never altered.
        """
        payload = {
            "project_id": site.project_id,
            "milestone_id": milestone_id,
            "claimed_stage": stage,
            "site": [site.latitude, site.longitude],
            "images": sorted(
                [{"sha256": f.sha256, "phash": f.phash, "passed": f.passed} for f in findings],
                key=lambda d: d["sha256"],
            ),
        }
        blob = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
        return "0x" + hashlib.sha256(blob).hexdigest()


def verdict_to_dict(v: Verdict) -> dict:
    d = asdict(v)
    return d
