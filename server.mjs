import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)));
const port = Number(process.env.PORT || 3000);
const host = '0.0.0.0';
const cacheMs = 6 * 60 * 1000;
let aircraftCache = { expires: 0, entities: null, error: null, sourceTime: null };
let tokenCache = { token: null, expires: 0 };
let aircraftRefreshPromise = null;

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

function json(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-allow-headers': 'content-type'
  });
  res.end(JSON.stringify(body));
}

async function openskyToken() {
  const clientId = process.env.OPENSKY_CLIENT_ID;
  const clientSecret = process.env.OPENSKY_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  if (tokenCache.token && tokenCache.expires > Date.now() + 30_000) return tokenCache.token;
  const form = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret
  });
  const response = await fetch('https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
    signal: AbortSignal.timeout(12_000)
  });
  if (!response.ok) throw new Error(`OpenSky token request returned ${response.status}`);
  const data = await response.json();
  tokenCache = { token: data.access_token, expires: Date.now() + Number(data.expires_in || 1800) * 1000 };
  return tokenCache.token;
}

async function refreshAircraft() {
  if (aircraftCache.expires > Date.now() && aircraftCache.entities) return aircraftCache;
  if (aircraftRefreshPromise) return aircraftRefreshPromise;
  aircraftRefreshPromise = loadAircraft();
  try {
    return await aircraftRefreshPromise;
  } finally {
    aircraftRefreshPromise = null;
  }
}

async function loadAircraft() {
  try {
    const token = await openskyToken();
    const response = await fetch('https://opensky-network.org/api/states/all', {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(18_000)
    });
    if (!response.ok) throw new Error(`OpenSky returned ${response.status}`);
    const data = await response.json();
    const fetchedAt = new Date().toISOString();
    const entities = (data.states || []).filter(row => Number.isFinite(row[5]) && Number.isFinite(row[6])).map(row => {
      const altitudeM = Number.isFinite(row[13]) ? row[13] : Number.isFinite(row[7]) ? row[7] : 0;
      const callsign = (row[1] || '').trim();
      return {
        id: `opensky-${row[0]}`,
        name: callsign || `Aircraft ${row[0]}`,
        kind: 'air',
        latitude: row[6],
        longitude: row[5],
        altitudeKm: Math.max(0, altitudeM) / 1000,
        speedKmh: Number.isFinite(row[9]) ? Math.round(row[9] * 3.6) : null,
        headingDeg: Number.isFinite(row[10]) ? row[10] : null,
        onGround: Boolean(row[8]),
        country: row[2] || null,
        source: 'OpenSky Network',
        timestamp: Number.isFinite(row[4]) ? new Date(row[4] * 1000).toISOString() : fetchedAt
      };
    });
    aircraftCache = { expires: Date.now() + cacheMs, entities, error: null, sourceTime: fetchedAt };
  } catch (error) {
    aircraftCache = { expires: Date.now() + cacheMs, entities: [], error: error.message, sourceTime: null };
  }
  return aircraftCache;
}

function filterEntities(entities, params) {
  const kinds = params.get('kind')?.split(',').filter(Boolean);
  const minAlt = Number(params.get('minAltitude') ?? 0);
  const maxAlt = Number(params.get('maxAltitude') ?? 100_000);
  const limit = Math.max(1, Math.min(5000, Number(params.get('limit') || 1500)));
  const south = Number(params.get('south'));
  const north = Number(params.get('north'));
  const west = Number(params.get('west'));
  const east = Number(params.get('east'));
  return entities.filter(entity => {
    if (kinds?.length && !kinds.includes(entity.kind)) return false;
    if (entity.altitudeKm < minAlt || entity.altitudeKm > maxAlt) return false;
    if ([south, north, west, east].every(Number.isFinite)) {
      const inLongitude = west <= east
        ? entity.longitude >= west && entity.longitude <= east
        : entity.longitude >= west || entity.longitude <= east;
      if (entity.latitude < south || entity.latitude > north || !inLongitude) return false;
    }
    return true;
  }).slice(0, limit);
}

async function serveStatic(pathname, res) {
  let relative = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  const target = resolve(root, `.${relative}`);
  if (target !== root && !target.startsWith(root + sep)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  try {
    const data = await readFile(target);
    res.writeHead(200, { 'content-type': mime[extname(target)] || 'application/octet-stream', 'x-content-type-options': 'nosniff' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'OPTIONS') return json(res, 204, {});
  if (req.method !== 'GET') return json(res, 405, { error: 'method_not_allowed', message: 'Use GET for this read-only API.' });

  if (url.pathname === '/api/health') {
    return json(res, 200, { status: 'ok', service: 'terra-signal-api', timestamp: new Date().toISOString() });
  }
  if (url.pathname === '/api/v1/layers') {
    return json(res, 200, { layers: [
      { id: 'surface', label: 'Surface', altitudeUnit: 'km', source: 'Three.js globe' },
      { id: 'air', label: 'Aircraft', altitudeUnit: 'km', source: 'OpenSky Network', live: true },
      { id: 'sea', label: 'Ships', altitudeUnit: 'km', source: null, live: false },
      { id: 'space', label: 'Satellites', altitudeUnit: 'km', source: null, live: false },
      { id: 'hazard', label: 'Hazards', altitudeUnit: 'km', source: null, live: false },
      { id: 'infrastructure', label: 'Infrastructure', altitudeUnit: 'km', source: null, live: false }
    ] });
  }
  if (url.pathname === '/api/v1/entities') {
    const live = await refreshAircraft();
    const entities = filterEntities(live.entities, url.searchParams);
    return json(res, live.error ? 503 : 200, {
      entities,
      count: entities.length,
      updatedAt: live.sourceTime,
      source: 'OpenSky Network',
      live: !live.error,
      cachedUntil: live.expires ? new Date(live.expires).toISOString() : null,
      ...(live.error ? { error: 'upstream_unavailable', message: live.error } : {})
    });
  }
  if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'not_found' });
  return serveStatic(url.pathname, res);
});

server.listen(port, host, () => console.log(`Terra Signal listening on http://${host}:${port}`));
