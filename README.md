# Terra Signal

Interactive Three.js globe with a small Node.js API. The browser and API are served from the same origin.

## Run locally

Requires Node.js 20 or newer.

```sh
npm start
```

Open `http://localhost:3000`. Do not open `index.html` directly as a `file://` URL; module imports and the same-origin API require an HTTP server.

## API

- `GET /api/health` — service health and current timestamp.
- `GET /api/v1/layers` — supported map layers and feed status.
- `GET /api/v1/entities` — normalized live aircraft entities from OpenSky Network.

Entity query parameters: `kind=air`, `minAltitude`, `maxAltitude`, `limit` (up to 5000), and optional `south`, `north`, `west`, `east` bounding-box coordinates. Longitude bounds may cross the date line.

Each entity contains `id`, `name`, `kind`, `latitude`, `longitude`, `altitudeKm`, `speedKmh`, `headingDeg`, `onGround`, `country`, `source`, and `timestamp`.

OpenSky anonymous requests are cached for six minutes to keep polling below its published anonymous daily credit allowance. Set `OPENSKY_CLIENT_ID` and `OPENSKY_CLIENT_SECRET` in the host environment to use an OAuth client instead. OpenSky describes its live API as intended for research and non-commercial use; check its current terms and citation requirements before publishing it in a commercial service. The API returns `503` with an error object if OpenSky is unavailable; it does not silently label demo objects as live data. See the [OpenSky REST API documentation](https://openskynetwork.github.io/opensky-api/rest.html).

The current UI exposes environmental layers and location datasets. The aircraft API is separate; ships, satellites, hazards, and infrastructure do not have connected feeds.

## Temperature layer

The MOD21C2 Collection 6.1 files are 8-day global land-surface temperature composites. The browser uses a transparent equirectangular PNG per composite and view (`day` or `night`). The Node API reads `manifest.json` and serves images from `data/temperature` by default; set `TEMPERATURE_DATA_DIR` to another folder containing that manifest and a `textures` subfolder.

Prepare textures with Python, NumPy, Pillow, and a GDAL build with HDF4/HDF-EOS support. Install GDAL separately using a build that matches your operating system:

```sh
python -m pip install -r requirements-temperature.txt
python scripts/prepare_temperature.py --input-dir "D:\hackathon2026\temperature\MOD21C2_061-20261114_154004" --output-dir "data/temperature" --limit 1
```

Remove `--limit 1` to process every source file. The preparation step reads LST and quality-control SDS fields, applies the 0.02 K scale, converts to Celsius, and writes transparent PNG textures. Textures use a fixed −40 to 60 °C display range. Generated texture files are not included in the repository; for a hosted deployment, place the generated folder on storage available to the service and set `TEMPERATURE_DATA_DIR` accordingly.
## Radiation and water layers

The backend reads CERES SSF 1-degree hourly/monthly files from `Radiation`, additional NOAA-20 hourly files from the local `power*` folder, and SMAP L3 Enhanced daily files from `water`. Set `POWER_DATA_DIR` to configure the extra CERES source folder explicitly. Raw source folders are not bundled in the deployment image. The API rasterizes the selected source field into a transparent equirectangular PNG on first request and caches it under `data/environmental/textures`.

Install the environmental decoder dependencies into the Python environment used by the server:

```sh
python -m pip install -r requirements-environmental.txt
```

If Python is not on the server's default path, set `PYTHON_BIN` to its executable. You can also set `RADIATION_DATA_DIR`, `WATER_DATA_DIR`, `SOIL_DATA_DIR`, and `ENVIRONMENTAL_DATA_DIR` when the raw data or texture cache is stored outside this folder.

Read-only endpoints:

- `GET /api/v1/radiation/availability` returns hourly dates and available hours, weekly dates, monthly dates, and supported variables. Weeks average the available daily means, which may cover only part of a week.
- `GET /api/v1/radiation/texture?date=YYYYMMDD&hour=0&variable=toa-sw` returns an hourly texture. Supported fields include TOA shortwave/longwave/net flux, incoming solar, and Model B surface downward shortwave/longwave flux.
- `GET /api/v1/radiation/texture?cadence=monthly&date=YYYYMM&variable=toa-sw` returns a monthly TOA texture. Monthly products expose shortwave, longwave, and net flux. One source is selected per date; the Radiation folder takes priority over the extra CERES folder, and NPP monthly takes priority over NOAA-20. Platform selection is not exposed as a query option.
- `GET /api/v1/water/dates` returns the SMAP dates, AM/PM passes, and soil-moisture retrieval variants.
- `GET /api/v1/water/texture?date=YYYYMMDD&pass=am&variable=soil-moisture` returns soil moisture in cm³/cm³. SCA-H and SCA-V variants are also available.
- `GET /api/v1/soil/dates` lists the daily AMSR2 LPRM files.
- `GET /api/v1/soil/texture?date=YYYYMMDD&variable=moisture-c1` returns a daily AMSR2 soil-moisture texture. The C1, C2, and X frequency estimates, surface skin temperature, and C1 optical depth are available.

The browser loads these PNGs with its Three.js texture overlay. The uploaded source files are local to this workspace; a hosted deployment needs source folders on service-accessible storage. The Docker image supplies Python, GDAL, netCDF4, NumPy and Pillow; it does not contain the large raw datasets.

## Additional dataset APIs

- `GET /api/v1/datasets` lists indexed dates, reference data, and unavailable datasets.
- `GET /api/v1/atmosphere/availability` lists MERRA-2 months and climate indices.
- `GET /api/v1/atmosphere/texture?date=202605&variable=rx1day` renders a monthly climate index.
- `GET /api/v1/mars/profile` exposes the supplied Mars reference, including its provisional status and comparison caveats. It is not a validated Earth-site ranking model.
- `GET /api/v1/aerosol/availability` lists VIIRS NOAA-20 swath granules. By default, the server scans the project root for these files; set `AEROSOL_DATA_DIR` for an external source directory.
- `GET /api/v1/aerosol/texture?granule=2026001_0000&variable=aod550` renders QA-filtered 550 nm aerosol optical thickness; `angstrom` is also supported. This API is available for UI integration; the current UI has no aerosol toggle.
- Add `meta=1` to environmental texture URLs for JSON display ranges and observation statistics.
- `GET /api/v1/environment/sample?layer=aerosol&granule=2026001_0000&variable=aod550&lat=20&lon=10` samples a swath. Locations more than 25 km from the nearest swath cell return a null value and `withinCoverage=false`.
- For radiation, water, soil and atmosphere point sampling, use `/api/v1/environment/sample` with `layer`, `date`, `variable`, `lat`, `lon`, and the same cadence/hour/pass parameters as the texture endpoint. Temperature uses `/api/v1/temperature/sample?period=2025001&view=day&lat=20&lon=10`.

Subsurface files currently have `.crdownload` extensions and cannot be decoded as completed observations. AI4Mars rover terrain labels remain reference material, not an Earth environmental layer. The catalog reports these limitations explicitly.

## Verification

Run `npm test`. Tests start an isolated local server, check validation and private-file handling, and exercise sampling and PNG/metadata delivery against each available source dataset. Data-dependent cases skip when source files are absent. Python decoders must be installed for data-dependent checks. The server automatically uses `.tools/envs/modis-lst/python.exe` on Windows when present; otherwise configure `PYTHON_BIN`.

## Deploy

Deploy with the included Dockerfile, or use a Node.js 20+ host with the Python decoders installed. The host should provide a `PORT` environment variable. Add OpenSky client credentials as host secrets if needed.

The Render blueprint now uses Docker so decoder dependencies and location reference files are included. Provision storage separately for raw datasets and configure `TEMPERATURE_SOURCE_DIR`, `RADIATION_DATA_DIR`, `POWER_DATA_DIR`, `WATER_DATA_DIR`, `SOIL_DATA_DIR`, `ATMOSPHERE_DATA_DIR`, and `AEROSOL_DATA_DIR` as appropriate. Set writable `TEMPERATURE_DATA_DIR` and `ENVIRONMENTAL_DATA_DIR` for generated textures. Without the source storage, availability lists are empty. Decoding large datasets requires enough host memory; the free plan is not verified for those workloads. The Docker build must be checked on a machine with Docker before release.
