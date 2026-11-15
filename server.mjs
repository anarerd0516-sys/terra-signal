import http from 'node:http';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)));
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const temperatureRoot = resolve(process.env.TEMPERATURE_DATA_DIR || resolve(root, 'data/temperature'));
const temperatureSourceRoot = resolve(process.env.TEMPERATURE_SOURCE_DIR || resolve(root, 'temperature'));
const radiationRoot = resolve(process.env.RADIATION_DATA_DIR || resolve(root, 'Radiation'));
const waterRoot = resolve(process.env.WATER_DATA_DIR || resolve(root, 'water'));
const soilRoot = resolve(process.env.SOIL_DATA_DIR || resolve(root, 'soil'));
const atmosphereRoot = resolve(process.env.ATMOSPHERE_DATA_DIR || resolve(root, 'Atmosphere'));
const environmentalRoot = resolve(process.env.ENVIRONMENTAL_DATA_DIR || resolve(root, 'data/environmental'));
const environmentalProcessor = resolve(root, 'scripts/prepare_environmental_texture.py');
const cacheMs = 6 * 60 * 1000;
let aircraftCache = { expires: 0, entities: null, error: null, sourceTime: null };
let tokenCache = { token: null, expires: 0 };
let aircraftRefreshPromise = null;
let dataIndexCache = { expires: 0, radiation: null, water: null, soil: null, atmosphere: null };
const environmentalJobs = new Map();

const radiationVariables = {
  'toa-sw': { label: 'Outgoing shortwave · TOA', units: 'W/m²', min: 0, max: 500 },
  'toa-lw': { label: 'Outgoing longwave · TOA', units: 'W/m²', min: 100, max: 350 },
  'toa-net': { label: 'Net radiation · TOA', units: 'W/m²', min: -200, max: 300 },
  'solar-in': { label: 'Incoming solar · TOA', units: 'W/m²', min: 0, max: 1400 },
  'surface-sw-down': { label: 'Downward shortwave · surface (Model B)', units: 'W/m²', min: 0, max: 1000 },
  'surface-lw-down': { label: 'Downward longwave · surface (Model B)', units: 'W/m²', min: 100, max: 500 }
};
const waterVariables = {
  'soil-moisture': { label: 'Soil moisture (DCA)', units: 'cm³/cm³' },
  'soil-moisture-h': { label: 'Soil moisture (SCA-H)', units: 'cm³/cm³' },
  'soil-moisture-v': { label: 'Soil moisture (SCA-V)', units: 'cm³/cm³' }
};
const soilVariables = {
  'moisture-c1': { label: 'Soil moisture · 6.9 GHz', units: '%' },
  'moisture-c2': { label: 'Soil moisture · 7.3 GHz', units: '%' },
  'moisture-x': { label: 'Soil moisture · 10.7 GHz', units: '%' },
  'skin-temperature': { label: 'Surface skin temperature', units: '°C' },
  'optical-depth-c1': { label: 'Optical depth · 6.9 GHz', units: '' }
};
const atmosphereVariables = {
  r90p: { field: 'R90P', label: 'Heavy-rain precipitation · 90th percentile', units: 'mm/day' },
  r90d: { field: 'R90D', label: 'Heavy-rain days · 90th percentile', units: 'days' },
  r95p: { field: 'R95P', label: 'Very-heavy-rain precipitation · 95th percentile', units: 'mm/day' },
  r95d: { field: 'R95D', label: 'Very-heavy-rain days · 95th percentile', units: 'days' },
  r99p: { field: 'R99P', label: 'Extreme-rain precipitation · 99th percentile', units: 'mm/day' },
  r99d: { field: 'R99D', label: 'Extreme-rain days · 99th percentile', units: 'days' },
  drydays: { field: 'drydays', label: 'Dry days (<1 mm precipitation)', units: 'days' },
  wetdays: { field: 'wetdays', label: 'Wet days (≥1 mm precipitation)', units: 'days' },
  r10mm: { field: 'R10mm', label: 'Days with ≥10 mm precipitation', units: 'days' },
  r20mm: { field: 'R20mm', label: 'Days with ≥20 mm precipitation', units: 'days' },
  rx1day: { field: 'RX1Day', label: 'Maximum one-day precipitation', units: 'mm/day' },
  cwd: { field: 'CWD', label: 'Longest consecutive wet spell', units: 'days' },
  sdii: { field: 'SDII', label: 'Precipitation intensity on wet days', units: 'mm/day' },
  cdd: { field: 'CDD', label: 'Longest consecutive dry spell', units: 'days' },
  fd: { field: 'FD', label: 'Frost days', units: 'days' },
  su: { field: 'SU', label: 'Summer days (>25 C maximum temperature)', units: 'days' },
  id: { field: 'ID', label: 'Icing days (<0 C maximum temperature)', units: 'days' },
  tr: { field: 'TR', label: 'Tropical nights (>20 C minimum temperature)', units: 'days' },
  dtr: { field: 'DTR', label: 'Diurnal temperature range', units: 'K' },
  tx90p: { field: 'TX90p', label: 'Warm maximum-temperature days', units: '%' },
  tn90p: { field: 'TN90p', label: 'Warm minimum-temperature nights', units: '%' },
  tx10p: { field: 'TX10p', label: 'Cool maximum-temperature days', units: '%' },
  tn10p: { field: 'TN10p', label: 'Cool minimum-temperature nights', units: '%' },
  hwn: { field: 'HWN', label: 'Heatwave events', units: 'events' },
  hwd: { field: 'HWD', label: 'Longest heatwave duration', units: 'days' },
  hwf: { field: 'HWF', label: 'Heatwave days', units: 'days' },
  hwa: { field: 'HWA', label: 'Heatwave amplitude', units: 'K' },
  hwm: { field: 'HWM', label: 'Heatwave magnitude anomaly', units: 'K' },
  wsdi: { field: 'WSDI', label: 'Warm-spell duration index', units: 'days' },
  lws: { field: 'LWS', label: 'Longest warm spell', units: 'days' },
  csdi: { field: 'CSDI', label: 'Cold-spell duration index', units: 'days' },
  lcs: { field: 'LCS', label: 'Longest cold spell', units: 'days' },
  rx5day: { field: 'RX5Day', label: 'Maximum five-day precipitation', units: 'mm/5 days' },
  rx5daycount: { field: 'RX5Daycount', label: 'Heavy five-day precipitation periods', units: 'periods' }
};
const monthlyRadiationVariables = {
  'toa-sw': radiationVariables['toa-sw'],
  'toa-lw': radiationVariables['toa-lw'],
  'toa-net': radiationVariables['toa-net']
};

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

async function readTemperatureManifest() {
  let prepared = [];
  try { const manifest = JSON.parse(await readFile(resolve(temperatureRoot, 'manifest.json'), 'utf8')); if (Array.isArray(manifest.periods)) prepared = manifest.periods; } catch {}
  const preparedByKey = new Map(prepared.map(item => [item.key, item]));
  const files = await listDataFiles(temperatureSourceRoot);
  const periods = new Map();
  for (const file of files) {
    const match = file.name.match(/^MOD21C2\.A(\d{4})(\d{3})\.061\..+\.hdf$/i);
    if (!match) continue;
    const key = `${match[1]}${match[2]}`;
    if (periods.has(key)) continue;
    const start = new Date(Date.UTC(Number(match[1]), 0, Number(match[2])));
    const end = new Date(start.getTime() + 7 * 86400000);
    const fmt = value => value.toISOString().slice(0, 10);
    const label = `${start.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })} ${start.getUTCDate()}–${end.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })} ${end.getUTCDate()}, ${end.getUTCFullYear()}`;
    const old = preparedByKey.get(key) || {};
    periods.set(key, { ...old, key, start: fmt(start), end: fmt(end), label, source: file.name, day: true, night: true });
  }
  return { periods: [...periods.values()].sort((a, b) => a.key.localeCompare(b.key)) };
}

async function listDataFiles(directory) {
  const files = [];
  async function walk(current, depth = 0) {
    if (depth > 3) return;
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) await walk(path, depth + 1);
      else if (entry.isFile()) files.push({ name: entry.name, path });
    }
  }
  await walk(directory);
  return files;
}

async function readEnvironmentalIndex(force = false) {
  if (!force && dataIndexCache.expires > Date.now() && dataIndexCache.radiation && dataIndexCache.water && dataIndexCache.soil && dataIndexCache.atmosphere) return dataIndexCache;
  const [radiationFiles, waterFiles, soilFiles, atmosphereFiles] = await Promise.all([listDataFiles(radiationRoot), listDataFiles(waterRoot), listDataFiles(soilRoot), listDataFiles(atmosphereRoot)]);
  const radiation = {};
  const radiationMonthly = {};
  const radiationGridHourly = {};
  const radiationGridMonthly = {};
  for (const file of radiationFiles) {
    const match = file.name.match(/^CER_SSF_NPP-FM5-VIIRS_Edition2B_\d+\.(\d{8})(\d{2})\.nc$/i);
    if (match) radiation[`${match[1]}${match[2]}`] = file.path;
    const hourlyGrid = file.name.match(/^CER_SSF1deg-Hour_NPP-VIIRS_Edition2B_\d+\.(\d{8})$/i);
    if (hourlyGrid) radiationGridHourly[hourlyGrid[1]] = file.path;
    const monthlyGrid = file.name.match(/^CER_SSF1deg-Month_(?:NPP-VIIRS_Edition2B_\d+|NOAA20-VIIRS_Edition1C_\d+)\.(\d{6})$/i);
    if (monthlyGrid && file.name.includes('NPP-VIIRS')) radiationGridMonthly[monthlyGrid[1]] = file.path;
  }
  const water = {};
  for (const file of waterFiles) {
    const match = file.name.match(/^SMAP_L3_SM_P_E_(\d{8})_R\d+_\d+\.h5$/i);
    if (match) water[match[1]] = file.path;
  }
  const soil = {};
  for (const file of soilFiles) {
    const match = file.name.match(/^LPRM-AMSR2_L3_D_SOILM3_V001_(\d{8})\d{6}\.nc4$/i);
    if (match) soil[match[1]] = file.path;
  }
  const atmosphere = {};
  for (const file of atmosphereFiles) {
    const match = file.name.match(/^MERRA2\.statM_2d_edi_Nx\.v2_1\.(\d{6})\.nc4$/i);
    if (match) atmosphere[match[1]] = file.path;
  }
  dataIndexCache = { expires: Date.now() + 60_000, radiation, radiationMonthly, radiationGridHourly, radiationGridMonthly, water, soil, atmosphere };
  return dataIndexCache;
}

async function pythonExecutable() {
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
  if (process.platform === 'win32') {
    const projectPython = resolve(root, '.tools/envs/modis-lst/python.exe');
    try { await access(projectPython); return projectPython; } catch { return 'python'; }
  }
  return 'python3';
}

async function prepareEnvironmentalTexture(args, target) {
  const key = target.toLowerCase();
  if (environmentalJobs.has(key)) return environmentalJobs.get(key);
  const job = (async () => {
    await mkdir(resolve(target, '..'), { recursive: true });
    const executable = await pythonExecutable();
    await new Promise((resolveJob, rejectJob) => {
      const child = spawn(executable, [environmentalProcessor, ...args], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      let errorOutput = '';
      child.stdout.on('data', chunk => { output = (output + chunk.toString()).slice(-4000); });
      child.stderr.on('data', chunk => { errorOutput = (errorOutput + chunk.toString()).slice(-4000); });
      child.once('error', error => rejectJob(new Error(`Could not start the environmental data processor (${error.message}). Set PYTHON_BIN and install requirements-environmental.txt.`)));
      child.once('close', async code => {
        if (code !== 0) return rejectJob(new Error((errorOutput || output || `Data processor exited with code ${code}.`).trim()));
        try {
          const metadata = JSON.parse(output.trim());
          await writeFile(`${target}.json`, JSON.stringify(metadata));
          resolveJob(metadata);
        } catch (error) { rejectJob(new Error(`Could not save map scale metadata: ${error.message}`)); }
      });
    });
  })().finally(() => environmentalJobs.delete(key));
  environmentalJobs.set(key, job);
  return job;
}

async function sampleEnvironmentalValue(args) {
  const executable = await pythonExecutable();
  return await new Promise((resolveValue, rejectValue) => {
    const child = spawn(executable, [environmentalProcessor, ...args], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let errorOutput = '';
    child.stdout.on('data', chunk => { output = (output + chunk.toString()).slice(-4000); });
    child.stderr.on('data', chunk => { errorOutput = (errorOutput + chunk.toString()).slice(-4000); });
    child.once('error', error => rejectValue(new Error(`Could not start the environmental data processor (${error.message}).`)));
    child.once('close', code => {
      if (code !== 0) return rejectValue(new Error((errorOutput || output || `Data processor exited with code ${code}.`).trim()));
      try { resolveValue(JSON.parse(output.trim())); }
      catch { rejectValue(new Error('The environmental sampler returned an invalid result.')); }
    });
  });
}

function weekStartKey(dayKey) {
  const year = Number(dayKey.slice(0, 4)), month = Number(dayKey.slice(4, 6)), day = Number(dayKey.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10).replaceAll('-', '');
}

function radiationPeriodKeys(files, gridHourly = {}, gridMonthly = {}) {
  const keys = Object.keys(files).sort();
  const gridDays = Object.keys(gridHourly).sort();
  const allDays = [...new Set([...keys.map(key => key.slice(0, 8)), ...gridDays])].sort();
  const months = [...new Set([...keys.map(key => key.slice(0, 6)), ...Object.keys(gridMonthly)])].sort();
  return {
    days: allDays,
    weeks: [...new Set(allDays.map(key => weekStartKey(key)))].sort(),
    months,
    hoursByDate: Object.fromEntries(allDays.map(day => [day, gridHourly[day] ? Array.from({ length: 24 }, (_, hour) => hour) : keys.filter(key => key.startsWith(day)).map(key => Number(key.slice(8, 10)))]))
  };
}

function selectRadiationSources(files, cadence, date, hourText = '12', gridsHourly = {}, gridsMonthly = {}) {
  const keys = Object.keys(files).sort();
  if (cadence === 'hourly' && /^\d{8}$/.test(date) && gridsHourly[date]) return { mode: 'grid', sources: [gridsHourly[date]] };
  if (cadence === 'hourly') {
    const swath = /^\d{8}$/.test(date) && /^\d{1,2}$/.test(hourText) && files[`${date}${String(Number(hourText)).padStart(2, '0')}`];
    return swath ? { mode: 'swath', sources: [swath] } : { mode: 'grid', sources: [] };
  }
  if (cadence === 'weekly' && /^\d{8}$/.test(date)) {
    const grid = Object.keys(gridsHourly).filter(key => weekStartKey(key) === date).sort().map(key => gridsHourly[key]);
    if (grid.length) return { mode: 'grid', sources: grid };
    const swath = keys.filter(key => weekStartKey(key) === date).map(key => files[key]);
    return { mode: 'swath', sources: swath };
  }
  if (cadence === 'monthly' && /^\d{6}$/.test(date)) {
    if (gridsMonthly[date]) return { mode: 'grid', sources: [gridsMonthly[date]] };
    const swath = keys.filter(key => key.startsWith(date)).map(key => files[key]);
    return { mode: 'swath', sources: swath };
  }
  return { mode: 'grid', sources: [] };
}

async function serveEnvironmentalSample(url, res) {
  const layer = url.searchParams.get('layer') || '';
  const date = url.searchParams.get('date') || '';
  const variable = url.searchParams.get('variable') || '';
  if (!url.searchParams.has('lat') || !url.searchParams.has('lon')) return json(res, 400, { error: 'invalid_coordinates', message: 'Provide lat and lon.' });
  const latitude = Number(url.searchParams.get('lat'));
  const longitude = Number(url.searchParams.get('lon'));
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    return json(res, 400, { error: 'invalid_coordinates', message: 'Use lat from -90 to 90 and lon from -180 to 180.' });
  }
  const index = await readEnvironmentalIndex();
  let source;
  let args = ['--layer', layer, '--variable', variable];
  if (layer === 'radiation') {
    const cadence = url.searchParams.get('cadence') || 'hourly';
    const hourText = url.searchParams.get('hour') || '12';
    const hour = Number(hourText);
    const selected = selectRadiationSources(index.radiation, cadence, date, hourText, index.radiationGridHourly, index.radiationGridMonthly);
    if (!selected.sources.length) return json(res, 404, { error: 'radiation_period_not_found' });
    if (!radiationVariables[variable]) return json(res, 400, { error: 'invalid_radiation_query' });
    args.push(selected.mode === 'grid' ? '--grid-sources-json' : '--sources-json', JSON.stringify(selected.sources), '--cadence', cadence, '--hour', String(hour));
    source = selected.sources[0];
  } else if (layer === 'water') {
    const passName = url.searchParams.get('pass') || 'am';
    if (!/^\d{8}$/.test(date) || !waterVariables[variable] || !['am', 'pm'].includes(passName)) return json(res, 400, { error: 'invalid_water_query' });
    source = index.water[date];
    args.push('--pass', passName);
    if (!source) return json(res, 404, { error: 'water_date_not_found' });
  } else if (layer === 'soil') {
    if (!/^\d{8}$/.test(date) || !soilVariables[variable]) return json(res, 400, { error: 'invalid_soil_query' });
    source = index.soil[date];
    if (!source) return json(res, 404, { error: 'soil_date_not_found' });
  } else if (layer === 'atmosphere') {
    if (!/^\d{6}$/.test(date) || !atmosphereVariables[variable]) return json(res, 400, { error: 'invalid_atmosphere_query' });
    source = index.atmosphere[date];
    if (!source) return json(res, 404, { error: 'atmosphere_date_not_found' });
  } else {
    return json(res, 400, { error: 'invalid_layer', allowed: ['radiation', 'water', 'soil', 'atmosphere'] });
  }
  args.push('--source', source);
  args.push('--sample-lat', String(latitude), '--sample-lon', String(longitude));
  try {
    const result = await sampleEnvironmentalValue(args);
    return json(res, 200, { ...result, requestedLatitude: latitude, requestedLongitude: longitude, date });
  } catch (error) {
    return json(res, 500, { error: 'environmental_sample_failed', layer, message: error.message });
  }
}

async function serveEnvironmentalTexture(layer, url, res) {
  const date = url.searchParams.get('date') || '';
  const index = await readEnvironmentalIndex();
  let source;
  let outputKey;
  let options;

  if (layer === 'atmosphere') {
    if (!/^\d{6}$/.test(date)) return json(res, 400, { error: 'invalid_date', message: 'Use date=YYYYMM.' });
    source = index.atmosphere[date];
    if (!source) return json(res, 404, { error: 'atmosphere_date_not_found', availableDates: Object.keys(index.atmosphere).sort() });
    const variable = url.searchParams.get('variable') || 'rx1day';
    if (!atmosphereVariables[variable]) return json(res, 400, { error: 'invalid_atmosphere_query', variables: atmosphereVariables });
    outputKey = `atmosphere_${date}_${variable}.png`;
    options = ['--layer', 'atmosphere', '--source', source, '--variable', variable,
      '--output', resolve(environmentalRoot, 'textures', outputKey)];
  } else if (layer === 'radiation') {
    const cadence = url.searchParams.get('cadence') || 'hourly';
    const hourText = url.searchParams.get('hour') || '12';
    const variable = url.searchParams.get('variable') || 'toa-sw';
    if (!['hourly', 'weekly', 'monthly'].includes(cadence) || !radiationVariables[variable]) return json(res, 400, { error: 'invalid_radiation_query' });
    const selected = selectRadiationSources(index.radiation, cadence, date, hourText, index.radiationGridHourly, index.radiationGridMonthly);
    if (!selected.sources.length) return json(res, 404, { error: 'radiation_period_not_found', availableDates: radiationPeriodKeys(index.radiation, index.radiationGridHourly, index.radiationGridMonthly)[cadence === 'hourly' ? 'days' : cadence === 'weekly' ? 'weeks' : 'months'] });
    source = selected.sources[0];
    const hour = String(Number(hourText)).padStart(2, '0');
    outputKey = `radiation_${cadence}_${date}${cadence === 'hourly' ? `_${hour}` : ''}_${variable}.png`;
    options = ['--layer', 'radiation', '--source', source, selected.mode === 'grid' ? '--grid-sources-json' : '--sources-json', JSON.stringify(selected.sources), '--cadence', cadence, '--hour', hour, '--variable', variable,
      '--output', resolve(environmentalRoot, 'textures', outputKey)];
  } else if (layer === 'water') {
    if (!/^\d{8}$/.test(date)) return json(res, 400, { error: 'invalid_date', message: 'Use date=YYYYMMDD.' });
    source = index.water[date];
    if (!source) return json(res, 404, { error: 'water_date_not_found', availableDates: Object.keys(index.water).sort() });
    const passName = url.searchParams.get('pass') || 'am';
    const variable = url.searchParams.get('variable') || 'soil-moisture';
    if (!['am', 'pm'].includes(passName) || !waterVariables[variable]) {
      return json(res, 400, { error: 'invalid_water_query', passes: ['am', 'pm'], variables: waterVariables });
    }
    outputKey = `water_${date}_${passName}_${variable}.png`;
    options = ['--layer', 'water', '--source', source, '--pass', passName, '--variable', variable,
      '--output', resolve(environmentalRoot, 'textures', outputKey)];
  } else {
    if (!/^\d{8}$/.test(date)) return json(res, 400, { error: 'invalid_date', message: 'Use date=YYYYMMDD.' });
    source = index.soil[date];
    if (!source) return json(res, 404, { error: 'soil_date_not_found', availableDates: Object.keys(index.soil).sort() });
    const variable = url.searchParams.get('variable') || 'moisture-c1';
    if (!soilVariables[variable]) return json(res, 400, { error: 'invalid_soil_query', variables: soilVariables });
    outputKey = `soil_${date}_${variable}.png`;
    options = ['--layer', 'soil', '--source', source, '--variable', variable,
      '--output', resolve(environmentalRoot, 'textures', outputKey)];
  }
  const cacheName = resolve(environmentalRoot, 'textures', outputKey);

  try {
    try { await access(cacheName); await access(`${cacheName}.json`); } catch { await prepareEnvironmentalTexture(options, cacheName); }
    if (url.searchParams.get('meta') === '1') {
      const metadata = JSON.parse(await readFile(`${cacheName}.json`, 'utf8'));
      return json(res, 200, metadata);
    }
    const image = await readFile(cacheName);
    res.writeHead(200, {
      'content-type': 'image/png',
      'cache-control': 'public, max-age=604800, immutable',
      'x-content-type-options': 'nosniff',
      'x-data-layer': layer
    });
    res.end(image);
  } catch (error) {
    return json(res, 500, { error: 'environmental_texture_failed', layer, message: error.message });
  }
}

async function prepareTemperatureTexture(source, target, view) {
  await mkdir(resolve(target, '..'), { recursive: true });
  const executable = await pythonExecutable();
  const processor = resolve(root, 'scripts/prepare_temperature.py');
  await new Promise((resolveJob, rejectJob) => {
    const child = spawn(executable, [processor, '--source', source, '--view', view, '--output', target], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errorOutput = '';
    child.stdout.on('data', chunk => { output = (output + chunk.toString()).slice(-4000); });
    child.stderr.on('data', chunk => { errorOutput = (errorOutput + chunk.toString()).slice(-4000); });
    child.once('error', error => rejectJob(new Error(`Could not start the temperature data processor (${error.message}).`)));
    child.once('close', code => code === 0 ? resolveJob() : rejectJob(new Error((errorOutput || output || `Temperature processor exited with code ${code}.`).trim())));
  });
}

async function serveTemperatureTexture(url, res) {
  const period = url.searchParams.get('period') || '';
  const view = url.searchParams.get('view') || '';
  if (!/^\d{7}$/.test(period) || !['day', 'night'].includes(view)) {
    return json(res, 400, { error: 'invalid_temperature_query', message: 'Use a seven-digit period and view=day or view=night.' });
  }
  const manifest = await readTemperatureManifest();
  const periodData = manifest.periods.find(item => item.key === period && item[view]);
  if (!periodData) {
    return json(res, 404, { error: 'temperature_period_not_found' });
  }
  try {
    const target = resolve(temperatureRoot, 'textures', `${period}_${view}.png`);
    try { await access(target); } catch {
      const source = (await listDataFiles(temperatureSourceRoot)).find(file => file.name === periodData.source)?.path;
      if (!source) return json(res, 404, { error: 'temperature_source_not_found' });
      await prepareTemperatureTexture(source, target, view);
    }
    const image = await readFile(target);
    res.writeHead(200, {
      'content-type': 'image/png',
      'cache-control': 'public, max-age=86400',
      'x-content-type-options': 'nosniff'
    });
    res.end(image);
  } catch (error) {
    return json(res, 500, { error: 'temperature_texture_failed', message: error.message });
  }
}

async function serveTemperatureSample(url, res) {
  const period = url.searchParams.get('period') || '';
  const view = url.searchParams.get('view') || '';
  if (!url.searchParams.has('lat') || !url.searchParams.has('lon')) return json(res, 400, { error: 'invalid_coordinates' });
  const latitude = Number(url.searchParams.get('lat'));
  const longitude = Number(url.searchParams.get('lon'));
  if (!/^\d{7}$/.test(period) || !['day', 'night'].includes(view) || !Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    return json(res, 400, { error: 'invalid_temperature_sample_query' });
  }
  const periodData = (await readTemperatureManifest()).periods.find(item => item.key === period);
  if (!periodData) return json(res, 404, { error: 'temperature_period_not_found' });
  const source = (await listDataFiles(temperatureSourceRoot)).find(file => file.name === periodData.source)?.path;
  if (!source) return json(res, 404, { error: 'temperature_source_not_found' });
  const executable = await pythonExecutable();
  const processor = resolve(root, 'scripts/prepare_temperature.py');
  try {
    const result = await new Promise((resolveValue, rejectValue) => {
      const child = spawn(executable, [processor, '--source', source, '--view', view, '--sample-lat', String(latitude), '--sample-lon', String(longitude)], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '', errorOutput = '';
      child.stdout.on('data', chunk => { output = (output + chunk.toString()).slice(-4000); });
      child.stderr.on('data', chunk => { errorOutput = (errorOutput + chunk.toString()).slice(-4000); });
      child.once('error', error => rejectValue(error));
      child.once('close', code => {
        if (code !== 0) return rejectValue(new Error((errorOutput || output || `Temperature sampler exited with code ${code}.`).trim()));
        try { resolveValue(JSON.parse(output.trim())); } catch { rejectValue(new Error('The temperature sampler returned an invalid result.')); }
      });
    });
    return json(res, 200, { ...result, requestedLatitude: latitude, requestedLongitude: longitude });
  } catch (error) {
    return json(res, 500, { error: 'temperature_sample_failed', message: error.message });
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
      { id: 'temperature', label: 'Land temperature', source: 'MODIS/Terra MOD21C2', live: false },
      { id: 'radiation', label: 'Radiation & energy', source: 'CERES SSF swath observations', live: false },
      { id: 'water', label: 'Hydrosphere', source: 'SMAP L3 Enhanced', live: false },
      { id: 'soil', label: 'Soil moisture', source: 'AMSR2 LPRM', live: false },
      { id: 'atmosphere', label: 'Atmosphere', source: 'MERRA-2 statistical monthly', live: false },
      { id: 'nasa-bases', label: 'NASA centers', source: 'NASA centers & Moon/Mars exploration dataset', live: false },
      { id: 'earth-analogs', label: 'Earth analog sites', source: 'Earth analog site dataset', live: false }
    ] });
  }
  if (url.pathname === '/api/v1/locations/nasa') {
    try {
      const raw = await readFile(resolve(root, 'nasa_moon_and_mars_locations_dataset.md'), 'utf8');
      const data = JSON.parse(raw);
      const locations = (data.nasa_centers || []).filter(center =>
        Number.isFinite(center.location?.coordinates?.latitude)
        && Number.isFinite(center.location?.coordinates?.longitude)
      ).map(center => ({
        id: center.id,
        name: center.name,
        acronym: center.acronym,
        city: center.location.city,
        state: center.location.state,
        country: center.location.country,
        latitude: center.location.coordinates.latitude,
        longitude: center.location.coordinates.longitude,
        focus: center.primary_focus,
        roles: center.moon_mars_roles || []
      }));
      return json(res, 200, { source: data.metadata?.title || 'NASA centers', locations });
    } catch (error) {
      return json(res, 500, { error: 'nasa_locations_unavailable', message: error.message });
    }
  }
  if (url.pathname === '/api/v1/locations/analogs') {
    try {
      const data = JSON.parse(await readFile(resolve(root, 'earth_analog_sites.json'), 'utf8'));
      const locations = (data.sites || []).filter(site =>
        Number.isFinite(site.latitude) && Number.isFinite(site.longitude)
        && site.latitude >= -90 && site.latitude <= 90
        && site.longitude >= -180 && site.longitude <= 180
      );
      return json(res, 200, { source: data.title || 'Earth analog sites', coordinateNote: data.coordinateNote, locations });
    } catch (error) {
      return json(res, 500, { error: 'analog_locations_unavailable', message: error.message });
    }
  }
  if (url.pathname === '/api/v1/radiation/availability') {
    const index = await readEnvironmentalIndex();
    const periods = radiationPeriodKeys(index.radiation, index.radiationGridHourly, index.radiationGridMonthly);
    return json(res, 200, {
      source: 'CERES global 1° grids, with SSF footprint fallback',
      hourly: { dates: periods.days, hoursByDate: periods.hoursByDate, variables: radiationVariables },
      weekly: { dates: periods.weeks, variables: radiationVariables },
      monthly: { dates: periods.months, variables: monthlyRadiationVariables }
    });
  }
  if (url.pathname === '/api/v1/water/dates') {
    const index = await readEnvironmentalIndex();
    return json(res, 200, { source: 'SMAP L3 Enhanced', dates: Object.keys(index.water).sort(), passes: ['am', 'pm'], variables: waterVariables });
  }
  if (url.pathname === '/api/v1/soil/dates') {
    const index = await readEnvironmentalIndex();
    return json(res, 200, { source: 'AMSR2 LPRM Level 3 daily soil moisture', dates: Object.keys(index.soil).sort(), variables: soilVariables });
  }
  if (url.pathname === '/api/v1/atmosphere/availability') {
    const index = await readEnvironmentalIndex();
    return json(res, 200, { source: 'MERRA-2 statistical monthly climate indices', dates: Object.keys(index.atmosphere).sort(), variables: atmosphereVariables, scale: '2nd–98th percentile per selected month' });
  }
  if (url.pathname === '/api/v1/environment/sample') return serveEnvironmentalSample(url, res);
  if (url.pathname === '/api/v1/radiation/texture') return serveEnvironmentalTexture('radiation', url, res);
  if (url.pathname === '/api/v1/water/texture') return serveEnvironmentalTexture('water', url, res);
  if (url.pathname === '/api/v1/soil/texture') return serveEnvironmentalTexture('soil', url, res);
  if (url.pathname === '/api/v1/atmosphere/texture') return serveEnvironmentalTexture('atmosphere', url, res);
  if (url.pathname === '/api/v1/temperature/periods') {
    const manifest = await readTemperatureManifest();
    return json(res, 200, { ...manifest, source: 'MODIS/Terra MOD21C2.061', cadenceDays: 8 });
  }
  if (url.pathname === '/api/v1/temperature/texture') return serveTemperatureTexture(url, res);
  if (url.pathname === '/api/v1/temperature/sample') return serveTemperatureSample(url, res);
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
