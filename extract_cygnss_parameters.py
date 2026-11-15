"""Extract local CYGNSS map metadata and latest-day geolocated values."""
import csv
import json
import re
from pathlib import Path

import netCDF4
import numpy as np


def plain(value):
    if isinstance(value, np.ndarray):
        return value.tolist()
    if isinstance(value, np.generic):
        return value.item()
    return value


def main():
    root = Path(__file__).resolve().parents[1]
    files = sorted(p for p in (root / "soil").rglob("cyg.*.nc") if not p.name.startswith("._"))
    output = root / "data" / "cygnss-extracted"
    output.mkdir(parents=True, exist_ok=True)
    manifest = {"source": "CYGNSS Level 3 Soil Moisture", "file_count": len(files),
                "notes": ["Coordinates are cell centers; use the supplied 2-D latitude/longitude arrays for mapping.",
                          "Missing values are excluded from CSV exports; blank sigma values indicate missing sigma.",
                          "Sigma is retrieval standard deviation, not a confidence interval.",
                          "Time interval units and comments disagree in the source; raw values and both attributes are preserved.",
                          "Nominal grid coverage does not imply observations in every cell or on every date."],
                "resolutions": {}}
    for resolution in ("9km", "36km"):
        selected = [p for p in files if f"-{resolution}." in p.name]
        if not selected:
            continue
        dates = sorted({re.search(r"\.s(\d{8})-", p.name).group(1) for p in selected})
        latest = selected[-1]
        with netCDF4.Dataset(latest) as ds:
            entry = {"file_count": len(selected), "dates": dates, "latest_source": str(latest.relative_to(root)),
                     "dimensions": {k: len(v) for k, v in ds.dimensions.items()},
                     "global_attributes": {k: plain(ds.getncattr(k)) for k in ds.ncattrs()},
                     "variables": {k: {"dimensions": list(v.dimensions), "shape": list(v.shape),
                                       "attributes": {a: plain(v.getncattr(a)) for a in v.ncattrs()}}
                                   for k, v in ds.variables.items()}, "exports": {}}
            lat = ds["latitude"][:]
            lon = ds["longitude"][:]
            coords_valid = ~(np.ma.getmaskarray(lat) | np.ma.getmaskarray(lon))
            entry["coordinate_bounds"] = {"south": float(lat.min()), "north": float(lat.max()),
                                           "west": float(lon.min()), "east": float(lon.max())}
            entry["timeintervals_raw"] = ds["timeintervals"][:].filled(np.nan).tolist()
            for cadence in ("daily", "subdaily"):
                path = output / f"cygnss_{dates[-1]}_{resolution}_{cadence}.csv"
                counts = []
                with path.open("w", newline="", encoding="utf-8") as handle:
                    writer = csv.writer(handle)
                    writer.writerow(["date", "slice_index", "latitude", "longitude", "soil_moisture_cm3_cm3", "sigma_cm3_cm3"])
                    for i in range(ds[f"SM_{cadence}"].shape[0]):
                        moisture = ds[f"SM_{cadence}"][i]
                        sigma = ds[f"SIGMA_{cadence}"][i]
                        valid = coords_valid & ~np.ma.getmaskarray(moisture) & np.isfinite(moisture.filled(np.nan))
                        rows, cols = np.where(valid)
                        counts.append(len(rows))
                        for r, c in zip(rows, cols):
                            s = sigma[r, c]
                            writer.writerow([dates[-1], i, float(lat[r, c]), float(lon[r, c]),
                                             float(moisture[r, c]), "" if np.ma.is_masked(s) or not np.isfinite(s) else float(s)])
                entry["exports"][cadence] = {"file": path.name, "valid_cells_per_slice": counts,
                                               "rows": sum(counts)}
            manifest["resolutions"][resolution] = entry
    destination = output / "map-parameters.json"
    destination.write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps({"manifest": str(destination), "file_count": len(files),
                      "resolutions": {k: {"dates": [v["dates"][0], v["dates"][-1]], "bounds": v["coordinate_bounds"],
                                          "exports": v["exports"]} for k, v in manifest["resolutions"].items()}}, indent=2))


if __name__ == "__main__":
    main()
