"""
Synthetic site photographs with real EXIF GPS and timestamps.

Lets the evidence pipeline be exercised end to end before anyone has driven to
a site. Replace with real photographs as soon as you have them — the fraud
checks are only as good as the images you test them against.
"""

from __future__ import annotations

import random
from datetime import datetime, timedelta
from pathlib import Path

import piexif
from PIL import Image, ImageDraw

# Kilimani, Nairobi — stands in for a registered development site.
SITE_LAT, SITE_LON = -1.29210, 36.78270

STAGE_PALETTE = {
    "site_clearing": ((122, 108, 88), (150, 138, 116)),
    "foundation": ((104, 100, 96), (138, 132, 124)),
    "ground_slab": ((128, 126, 122), (162, 160, 154)),
    "superstructure": ((146, 142, 134), (178, 174, 166)),
    "roofing": ((92, 78, 70), (132, 112, 100)),
    "finishing": ((186, 180, 170), (214, 208, 198)),
}


def _deg_to_dms_rational(value: float):
    value = abs(value)
    deg = int(value)
    minutes_full = (value - deg) * 60
    minutes = int(minutes_full)
    seconds = round((minutes_full - minutes) * 60 * 10000)
    return ((deg, 1), (minutes, 1), (seconds, 10000))


def make_photo(
    path: Path,
    stage: str,
    captured_at: datetime,
    lat: float = SITE_LAT,
    lon: float = SITE_LON,
    seed: int = 0,
) -> Path:
    """Write a JPEG with GPS + timestamp EXIF and a sidecar stage label."""
    rng = random.Random(seed)
    base, accent = STAGE_PALETTE.get(stage, ((120, 120, 120), (160, 160, 160)))

    img = Image.new("RGB", (640, 480), base)
    draw = ImageDraw.Draw(img)

    # Enough structure that two photos of the same stage are not identical,
    # so perceptual hashing has something real to distinguish.
    for _ in range(24):
        x0, y0 = rng.randint(0, 600), rng.randint(120, 440)
        draw.rectangle(
            [x0, y0, x0 + rng.randint(20, 90), y0 + rng.randint(20, 70)],
            fill=tuple(min(255, c + rng.randint(-24, 24)) for c in accent),
        )
    draw.rectangle([0, 0, 640, 110], fill=(150, 168, 190))  # sky band

    exif = {
        "0th": {
            piexif.ImageIFD.Make: b"Demo",
            piexif.ImageIFD.Model: b"SiteCapture",
            piexif.ImageIFD.DateTime: captured_at.strftime("%Y:%m:%d %H:%M:%S").encode(),
        },
        "Exif": {
            piexif.ExifIFD.DateTimeOriginal: captured_at.strftime("%Y:%m:%d %H:%M:%S").encode(),
        },
        "GPS": {
            piexif.GPSIFD.GPSLatitudeRef: b"S" if lat < 0 else b"N",
            piexif.GPSIFD.GPSLatitude: _deg_to_dms_rational(lat),
            piexif.GPSIFD.GPSLongitudeRef: b"W" if lon < 0 else b"E",
            piexif.GPSIFD.GPSLongitude: _deg_to_dms_rational(lon),
        },
        "1st": {},
        "thumbnail": None,
    }

    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, "jpeg", quality=90, exif=piexif.dump(exif))
    path.with_suffix(path.suffix + ".stage").write_text(f"{stage} 0.93")
    return path


def strip_gps(src: Path, dst: Path) -> Path:
    """A photo with the location metadata removed."""
    img = Image.open(src)
    dst.parent.mkdir(parents=True, exist_ok=True)
    img.save(dst, "jpeg", quality=90)
    sidecar = src.with_suffix(src.suffix + ".stage")
    if sidecar.exists():
        dst.with_suffix(dst.suffix + ".stage").write_text(sidecar.read_text())
    return dst


def relabel_timestamp(src: Path, dst: Path, captured_at: datetime) -> Path:
    """Same pixels, different claimed capture time — the classic resubmission."""
    img = Image.open(src)
    exif = piexif.load(str(src))
    stamp = captured_at.strftime("%Y:%m:%d %H:%M:%S").encode()
    exif["0th"][piexif.ImageIFD.DateTime] = stamp
    exif["Exif"][piexif.ExifIFD.DateTimeOriginal] = stamp
    dst.parent.mkdir(parents=True, exist_ok=True)
    img.save(dst, "jpeg", quality=90, exif=piexif.dump(exif))
    sidecar = src.with_suffix(src.suffix + ".stage")
    if sidecar.exists():
        dst.with_suffix(dst.suffix + ".stage").write_text(sidecar.read_text())
    return dst


def build_demo_set(root: Path, now: datetime | None = None) -> dict:
    """A clean submission plus one of each fraud pattern."""
    now = now or datetime.now()
    root.mkdir(parents=True, exist_ok=True)

    honest = [
        make_photo(root / f"foundation_{i}.jpg", "foundation", now - timedelta(days=2), seed=i)
        for i in range(3)
    ]
    wrong_site = [
        make_photo(
            root / f"elsewhere_{i}.jpg",
            "foundation",
            now - timedelta(days=1),
            lat=-1.30500,  # ~1.5km away
            lon=36.79500,
            seed=50 + i,
        )
        for i in range(3)
    ]
    no_gps = [strip_gps(honest[i], root / f"nogps_{i}.jpg") for i in range(3)]
    recycled = [
        relabel_timestamp(honest[i], root / f"recycled_{i}.jpg", now - timedelta(hours=6))
        for i in range(3)
    ]
    return {
        "honest": honest,
        "wrong_site": wrong_site,
        "no_gps": no_gps,
        "recycled": recycled,
    }
