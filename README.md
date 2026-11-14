# Terra Signal

Terra Signal serves an interactive globe and read-only API for geospatial data. The deployed service is [spacehorse.onrender.com](https://spacehorse.onrender.com).

## API

- `GET /api/health` — hosting health check.
- `GET /api/v1/layers` — layer IDs, labels, and source status.
- `GET /api/v1/entities` — aircraft entities from OpenSky Network.
- `GET /api/v1/solar` — historical solar-flux sample from NASA CERES, centered on Mongolia for 2021-02-13.

The solar route is historical and returns `live: false`. It supports `date=2021-02-13` and `hour=5` (the only bundled UTC hour), plus `south`, `north`, `west`, `east`, and `limit` (1–10,000). Coordinates are 1-degree cell centers; flux fields are in W m-2. The bundled sample covers Mongolia (41–52°N, 87–120°E).

Example:

```sh
curl 'https://spacehorse.onrender.com/api/v1/solar?hour=5&south=41&north=52&west=87&east=120'
```

The solar sample includes:

- `toaInsolationWm2` — CERES `toa_sw_insol`, top-of-atmosphere shortwave insolation.
- `surfaceShortwaveDownWm2` — CERES `modb_all_sfc_sw_down`, Model B all-sky downwelling surface shortwave flux.

These are radiation-flux measurements/model outputs, not electrical power generation or a live feed. Source: NASA CERES NOAA-20 SSF1deg-Hour Edition 1C, DOI [10.5067/NOAA20/CERES/SSF1deg-Hour_VIIRS_L3.001C](https://doi.org/10.5067/NOAA20/CERES/SSF1deg-Hour_VIIRS_L3.001C). The compact regional sample is in `data/solar-sample-mongolia-2021-02-13.json`; the original HDF4 archive is not required to run the app.

Aircraft snapshots are cached to respect OpenSky's anonymous usage quota. Set `OPENSKY_CLIENT_ID` and `OPENSKY_CLIENT_SECRET` in the hosting environment to use OpenSky OAuth credentials.

## Run locally

Requires Node.js 20 or newer.

```sh
npm start
```

The server listens on `PORT`, defaulting to 3000. Aircraft are currently the live integration. Ships, satellites, hazards, and infrastructure are planned layers without providers yet.
