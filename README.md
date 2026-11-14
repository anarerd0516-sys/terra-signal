# Terra Signal

Terra Signal serves the interactive globe and a small read-only API for map entities. The deployed service is [spacehorse.onrender.com](https://spacehorse.onrender.com).

## API

All endpoints are same-origin with the web app and allow cross-origin GET requests.

- `GET /api/health` — health check for hosting platforms.
- `GET /api/v1/layers` — layer IDs, labels, and source availability.
- `GET /api/v1/entities` — aircraft entities from OpenSky Network, normalized to latitude, longitude, and altitude in kilometers.

Example:

```sh
curl 'https://spacehorse.onrender.com/api/v1/entities?kind=air&limit=100'
```

The entities response contains `entities`, `count`, `updatedAt`, `source`, `live`, `stale`, and `cachedUntil`. Aircraft properties include `latitude`, `longitude`, `altitudeKm`, `speedKmh`, `headingDeg`, and `timestamp`.

Supported query parameters:

- `kind`: comma-separated entity kinds
- `minAltitude`, `maxAltitude`: altitude bounds in kilometers
- `south`, `north`, `west`, `east`: bounding box in degrees; west greater than east crosses the antimeridian
- `limit`: maximum results (1–5000)

When OpenSky is temporarily unavailable and a previous snapshot exists, the API returns that snapshot with `stale: true`. If there is no usable snapshot, it returns HTTP 503 with `error: "upstream_unavailable"`. Anonymous aircraft snapshots are cached for 15 minutes to stay within OpenSky's daily quota. Set `OPENSKY_CLIENT_ID` and `OPENSKY_CLIENT_SECRET` in the hosting service environment to use OpenSky OAuth credentials; authenticated snapshots are cached for 5 minutes.

## Run locally

Requires Node.js 20 or newer.

```sh
npm start
```

The server listens on `PORT` (defaults to 3000). The current live data integration is aircraft only; ships, satellites, hazards, and infrastructure are listed as planned layers and do not yet have live providers.
