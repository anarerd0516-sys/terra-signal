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

Ships, satellites, hazards, and infrastructure remain demo-only/unconnected layers in the current baseline.

## Temperature layer

The MOD21C2 Collection 6.1 files are 8-day global land-surface temperature composites. The browser uses a transparent equirectangular PNG per composite and view (`day` or `night`). The Node API reads `manifest.json` and serves images from `data/temperature` by default; set `TEMPERATURE_DATA_DIR` to another folder containing that manifest and a `textures` subfolder.

Prepare textures with Python, NumPy, Pillow, and a GDAL build with HDF4/HDF-EOS support. Install GDAL separately using a build that matches your operating system:

```sh
python -m pip install -r requirements-temperature.txt
python scripts/prepare_temperature.py --input-dir "D:\hackathon2026\temperature\MOD21C2_061-20261114_154004" --output-dir "data/temperature" --limit 1
```

Remove `--limit 1` to process every source file. The preparation step reads LST and quality-control SDS fields, applies the 0.02 K scale, converts to Celsius, and writes transparent PNG textures. Textures use a fixed −40 to 60 °C display range. Generated texture files are not included in the repository; for a hosted deployment, place the generated folder on storage available to the service and set `TEMPERATURE_DATA_DIR` accordingly.
## Radiation and water layers

The local backend can also read CERES SSF 1-degree hourly/monthly files from `Radiation` and SMAP L3 Enhanced daily files from `water`. The raw folders are intentionally ignored by Git because the hourly CERES source files alone are several gigabytes. The API rasterizes the selected source field into a transparent equirectangular PNG on first request and caches it under `data/environmental/textures`.

Install the environmental decoder dependencies into the Python environment used by the server:

```sh
python -m pip install -r requirements-environmental.txt
```

If Python is not on the server's default path, set `PYTHON_BIN` to its executable. You can also set `RADIATION_DATA_DIR`, `WATER_DATA_DIR`, `SOIL_DATA_DIR`, and `ENVIRONMENTAL_DATA_DIR` when the raw data or texture cache is stored outside this folder.

Read-only endpoints:

- `GET /api/v1/radiation/availability` returns available hourly dates, monthly platform/month pairs, variables, and the 24 hourly slots.
- `GET /api/v1/radiation/texture?date=YYYYMMDD&hour=0&variable=toa-sw` returns an hourly texture. Supported fields include TOA shortwave/longwave/net flux, incoming solar, and Model B surface downward shortwave/longwave flux.
- `GET /api/v1/radiation/texture?cadence=monthly&platform=NPP&date=YYYYMM&variable=toa-sw` returns a monthly TOA texture. Monthly products currently expose shortwave, longwave, and net flux.
- `GET /api/v1/water/dates` returns the SMAP dates, AM/PM passes, and soil-moisture retrieval variants.
- `GET /api/v1/water/texture?date=YYYYMMDD&pass=am&variable=soil-moisture` returns soil moisture in cm³/cm³. SCA-H and SCA-V variants are also available.
- `GET /api/v1/soil/dates` lists the daily AMSR2 LPRM files.
- `GET /api/v1/soil/texture?date=YYYYMMDD&variable=moisture-c1` returns a daily AMSR2 soil-moisture texture. The C1, C2, and X frequency estimates, surface skin temperature, and C1 optical depth are available.

The browser can load these PNGs with its existing Three.js texture overlay. The uploaded source files are local to this workspace; a hosted deployment needs the source folders on service-accessible storage and a Python environment with the requirements above. The current Render Node service does not automatically receive local workspace files.

## Deploy

Deploy this directory to any Node.js host that runs `npm start`, with outbound HTTPS access. The host should provide a `PORT` environment variable. Add the OpenSky client credentials as host secrets if you have them; never commit credentials to this repository.

For Render, push this project to a Git repository, connect that repository in Render, and create a Blueprint from `render.yaml`. Render will provision the public web service and assign its `onrender.com` URL. The included free plan is suitable for a public preview; free web services can spin down after inactivity.
