#!/usr/bin/env python3
"""Convert MOD21C2 HDF-EOS composites into globe-ready transparent PNGs.

Requires a GDAL build with HDF4/HDF-EOS support, NumPy, and Pillow.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import date, timedelta
from pathlib import Path

# Keep GDAL's bundled HDF4 driver discoverable in the project's Windows
# environment. Without this, MOD21C2 files appear to have no readable bands.
_gdal_bin = Path(sys.prefix) / "Library" / "bin"
_gdal_plugins = Path(sys.prefix) / "Library" / "lib" / "gdalplugins"
_gdal_dll_directory = os.add_dll_directory(str(_gdal_bin)) if os.name == "nt" and _gdal_bin.is_dir() else None
if _gdal_bin.is_dir():
    os.environ["PATH"] = str(_gdal_bin) + os.pathsep + os.environ.get("PATH", "")
if _gdal_plugins.is_dir():
    os.environ.setdefault("GDAL_DRIVER_PATH", str(_gdal_plugins))

import numpy as np
from osgeo import gdal
from PIL import Image


FILENAME = re.compile(r"^MOD21C2\.A(?P<year>\d{4})(?P<doy>\d{3})\.061\..+\.hdf$", re.I)
WIDTH = 7200
HEIGHT = 3600
TEMP_MIN_C = -40.0
TEMP_MAX_C = 60.0
PALETTE = np.array([
    [33, 102, 172],
    [103, 169, 207],
    [247, 247, 247],
    [239, 138, 98],
    [178, 24, 43],
], dtype=np.float32)


def field_dataset(container: gdal.Dataset, field: str) -> gdal.Dataset:
    for subdataset, description in container.GetSubDatasets():
        if (subdataset.rsplit(":", 1)[-1].casefold() == field.casefold()
                or field.casefold() in description.casefold()):
            result = gdal.Open(subdataset, gdal.GA_ReadOnly)
            if result is not None:
                return result
    raise RuntimeError(f"Could not find {field} in {container.GetDescription()}")


def colorize(path: Path, view: str, output: Path) -> None:
    gdal.UseExceptions()
    container = gdal.OpenEx(str(path), gdal.OF_RASTER, open_options=["LIST_SDS=YES"])
    if container is None:
        raise RuntimeError(f"GDAL could not open {path}")

    lst = field_dataset(container, f"LST_{view.title()}")
    qc = field_dataset(container, f"QC_{view.title()}")
    if (lst.RasterXSize, lst.RasterYSize) != (WIDTH, HEIGHT):
        raise RuntimeError(f"Unexpected grid size in {path.name}: {lst.RasterXSize}x{lst.RasterYSize}")

    output.parent.mkdir(parents=True, exist_ok=True)
    image = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
    lst_band, qc_band = lst.GetRasterBand(1), qc.GetRasterBand(1)
    chunk_rows = 128
    for y in range(0, HEIGHT, chunk_rows):
        rows = min(chunk_rows, HEIGHT - y)
        raw = lst_band.ReadAsArray(0, y, WIDTH, rows).astype(np.float32)
        quality = qc_band.ReadAsArray(0, y, WIDTH, rows).astype(np.uint8)
        # MODLAND QA == 0, input data quality == 0, and LST accuracy better than 2 K.
        good = (raw != 0) & ((quality & 0b11) == 0) & (((quality >> 2) & 0b11) == 0) & (((quality >> 6) & 0b11) >= 2)
        celsius = raw * 0.02 - 273.15
        position = np.clip((celsius - TEMP_MIN_C) / (TEMP_MAX_C - TEMP_MIN_C), 0.0, 1.0) * (len(PALETTE) - 1)
        lower = np.floor(position).astype(np.int8)
        upper = np.minimum(lower + 1, len(PALETTE) - 1)
        fraction = (position - lower)[..., None]
        rgb = PALETTE[lower] * (1.0 - fraction) + PALETTE[upper] * fraction
        rgba = np.empty((rows, WIDTH, 4), dtype=np.uint8)
        rgba[..., :3] = np.clip(rgb, 0, 255).astype(np.uint8)
        rgba[..., 3] = np.where(good, 205, 0).astype(np.uint8)
        # SphereGeometry puts longitude -90 degrees at texture u=0; rotate the global grid to match.
        rgba = np.roll(rgba, -WIDTH // 4, axis=1)
        image.paste(Image.fromarray(rgba, "RGBA"), (0, y))
    image.save(output, format="PNG", optimize=True)


def sample_value(path: Path, view: str, latitude: float, longitude: float) -> dict:
    gdal.UseExceptions()
    container = gdal.OpenEx(str(path), gdal.OF_RASTER, open_options=["LIST_SDS=YES"])
    if container is None:
        raise RuntimeError(f"GDAL could not open {path}")
    lst = field_dataset(container, f"LST_{view.title()}")
    qc = field_dataset(container, f"QC_{view.title()}")
    x = min(WIDTH - 1, max(0, int(((longitude + 180.0) % 360.0) / 360.0 * WIDTH)))
    y = min(HEIGHT - 1, max(0, int((90.0 - latitude) / 180.0 * HEIGHT)))
    raw = int(lst.GetRasterBand(1).ReadAsArray(x, y, 1, 1)[0, 0])
    quality = int(qc.GetRasterBand(1).ReadAsArray(x, y, 1, 1)[0, 0])
    good = raw != 0 and (quality & 0b11) == 0 and ((quality >> 2) & 0b11) == 0 and ((quality >> 6) & 0b11) >= 2
    return {"layer": "temperature", "period": period_metadata(path)["key"],
            "view": view, "label": f"Land surface temperature · {view}", "units": "°C",
            "value": round(raw * 0.02 - 273.15, 3) if good else None,
            "latitude": 90.0 - (y + 0.5) * 180.0 / HEIGHT,
            "longitude": -180.0 + (x + 0.5) * 360.0 / WIDTH, "masked": not good, "source": path.name, "gridResolution": "0.05 degrees",
            "observationStart": period_metadata(path)["start"], "observationEnd": period_metadata(path)["end"],
            "measurementType": "8-day average land-surface temperature", "qualityCode": quality,
            "missingReason": "No value passing the selected quality filter" if not good else None}


def period_metadata(path: Path) -> dict[str, str]:
    match = FILENAME.match(path.name)
    if not match:
        raise ValueError(f"Unexpected MOD21C2 filename: {path.name}")
    year, doy = int(match.group("year")), int(match.group("doy"))
    start = date(year, 1, 1) + timedelta(days=doy - 1)
    end = start + timedelta(days=7)
    return {
        "key": f"{year:04d}{doy:03d}",
        "start": start.isoformat(),
        "end": end.isoformat(),
        "label": f"{start.strftime('%b')} {start.day}–{end.strftime('%b')} {end.day}, {end.year}",
        "source": path.name,
    }


def write_manifest(output_root: Path, files: list[Path]) -> None:
    periods = []
    for source in files:
        metadata = period_metadata(source)
        key = metadata["key"]
        texture_dir = output_root / "textures"
        metadata["day"] = (texture_dir / f"{key}_day.png").is_file()
        metadata["night"] = (texture_dir / f"{key}_night.png").is_file()
        if metadata["day"] or metadata["night"]:
            periods.append(metadata)
    periods.sort(key=lambda item: item["key"])
    manifest = {
        "source": "MODIS/Terra MOD21C2.061",
        "units": "degC",
        "grid": {"width": WIDTH, "height": HEIGHT, "resolutionDegrees": 0.05},
        "colorRangeC": {"min": TEMP_MIN_C, "max": TEMP_MAX_C},
        "periods": periods,
    }
    manifest_path = output_root / "manifest.json"
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = manifest_path.with_suffix(".json.tmp")
    temp_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    temp_path.replace(manifest_path)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-dir", type=Path, help="Folder containing MOD21C2 Collection 061 HDF files")
    parser.add_argument("--source", type=Path, help="Render one source HDF on demand")
    parser.add_argument("--view", choices=("day", "night"), help="Observation view for --source")
    parser.add_argument("--output", type=Path, help="Output PNG for --source")
    parser.add_argument("--sample-lat", type=float)
    parser.add_argument("--sample-lon", type=float)
    parser.add_argument("--output-dir", type=Path, default=Path("data/temperature"), help="Output folder served by the Node API")
    parser.add_argument("--views", nargs="+", choices=("day", "night"), default=("day", "night"))
    parser.add_argument("--limit", type=int, help="Process only the first N files, useful for a small initial ingest")
    parser.add_argument("--overwrite", action="store_true", help="Regenerate textures that already exist")
    args = parser.parse_args()

    if args.sample_lat is not None or args.sample_lon is not None:
        if not args.source or not args.view or args.sample_lat is None or args.sample_lon is None:
            parser.error("sampling requires --source, --view, --sample-lat, and --sample-lon")
        if not -90 <= args.sample_lat <= 90 or not -180 <= args.sample_lon <= 180:
            parser.error("sample coordinates must be latitude -90..90 and longitude -180..180")
        print(json.dumps(sample_value(args.source, args.view, args.sample_lat, args.sample_lon)))
        return
    if args.source:
        if not args.view or not args.output:
            parser.error("--source requires both --view and --output")
        colorize(args.source, args.view, args.output)
        print(f"Prepared {args.view} temperature texture for {args.source.name}")
        return
    if not args.input_dir:
        parser.error("--input-dir is required unless --source is provided")

    all_files = sorted(path for path in args.input_dir.glob("MOD21C2.A*.061.*.hdf") if FILENAME.match(path.name))
    if not all_files:
        raise SystemExit(f"No MOD21C2 Collection 061 files found in {args.input_dir}")
    files = all_files[:args.limit] if args.limit else all_files

    texture_dir = args.output_dir / "textures"
    for index, source in enumerate(files, start=1):
        key = period_metadata(source)["key"]
        for view in args.views:
            target = texture_dir / f"{key}_{view}.png"
            if target.exists() and not args.overwrite:
                continue
            print(f"[{index}/{len(files)}] {source.name} ({view})", flush=True)
            colorize(source, view, target)
        write_manifest(args.output_dir, all_files)

    write_manifest(args.output_dir, all_files)
    print(f"Prepared {len(files)} composite(s) in {args.output_dir}")


if __name__ == "__main__":
    main()
