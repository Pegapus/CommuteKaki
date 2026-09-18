require('dotenv').config({ path: '.env' });

const requiredEnvVars = ['MONGODB_URI', 'MONGODB_DBNAME', 'MAPBOX_API_KEY', 'LTA_DATAMALL_KEY', 'FRONT_END_URL'];
try {
    let missingEnvVars = [];
    for (const varName of requiredEnvVars) {
        if (!process.env[varName]) {
            missingEnvVars.push(varName);
        }
    }
    if (missingEnvVars.length != 0) {
        throw new Error(`Missing required environment variable(s): ${missingEnvVars}. Please add it to your .env file or environment configuration.`);
    }
    console.log('All required environment variables are present and valid.');
} catch (error) {
    console.error(error.message);
    process.exit(1);
}

const express = require("express");
const morgan = require('morgan');
const app = express();
const port = process.env.PORT || 3000;

app.set("view engine", "ejs");
app.use(express.static("public"));
app.use(morgan('dev'));

const { getMrtStations } = require('./models/MRTStations');
const { getBusRoutes } = require('./models/LTADatamallBusRoutes');
const { getBusStops } = require('./models/LTADatamallBusStops');
const { getBusServices } = require('./models/LTADatamallBusServices');
const { getTrainServiceAlerts } = require('./models/TrainServiceAlerts');
const { getBridgingPoints } = require('./models/BridgingPoints');
const { isDatabaseEmpty, disconnect } = require('./configs/database');

// ---------------------------------------------------------------------------
// On-demand bus route geometry (Mapbox Map Matching + Directions)
//
// Rather than pre-computing every service's road-aligned route up front, a
// route is only fetched from Mapbox the first time a user clicks that
// specific service/direction on the map. The result is cached in memory for
// the life of the process so repeat clicks (and other users hitting the same
// route) don't re-spend Mapbox API quota.
// ---------------------------------------------------------------------------
const MAPBOX_SNAP_CHUNK = 100;   // Map Matching API max waypoints per request
const MAPBOX_ROUTE_CHUNK = 25;   // Directions API max waypoints per request

let busStopInfoCache = null;
async function getBusStopInfoMap() {
    if (busStopInfoCache) return busStopInfoCache;
    const stops = await getBusStops();
    busStopInfoCache = {};
    for (const stop of stops) {
        busStopInfoCache[stop.BusStopCode] = {
            coordinates: [stop.Longitude, stop.Latitude],
            description: stop.Description
        };
    }
    return busStopInfoCache;
}

function formatTerminusName(description) {
    return String(description || '').trim();
}

let busRoutesDocsCache = null;
async function getBusRoutesDocsCached() {
    if (!busRoutesDocsCache) {
        busRoutesDocsCache = await getBusRoutes();
    }
    return busRoutesDocsCache;
}

// Snaps a sequence of raw stop coordinates onto the road network so the
// Directions API routes along actual roads instead of straight lines between
// (sometimes slightly off-road) bus stop coordinates.
async function snapToRoadNetwork(stopCoords) {
    const snapped = [];
    for (let i = 0; i < stopCoords.length; i += MAPBOX_SNAP_CHUNK) {
        const chunk = stopCoords.slice(i, i + MAPBOX_SNAP_CHUNK);
        if (chunk.length < 2) {
            snapped.push(...chunk);
            break;
        }

        const coordStr = chunk.map(c => `${c[0]},${c[1]}`).join(';');
        const radiuses = chunk.map(() => '50').join(';');
        const url = `https://api.mapbox.com/matching/v5/mapbox/driving/${coordStr}`
            + `?geometries=geojson&overview=false&radiuses=${radiuses}&access_token=${process.env.MAPBOX_API_KEY}`;

        const response = await fetch(url);
        if (!response.ok) {
            snapped.push(...chunk);
            continue;
        }
        const data = await response.json();
        if (data.tracepoints) {
            data.tracepoints.forEach((tp, idx) => snapped.push(tp ? tp.location : chunk[idx]));
        } else {
            snapped.push(...chunk);
        }
    }
    return snapped;
}

// Routes between snapped coordinates, stitching consecutive chunks (the
// Directions API caps waypoints per request) into one continuous line.
async function fetchRouteGeometryFromMapbox(snappedCoords) {
    const all = [];
    for (let i = 0; i < snappedCoords.length - 1; i += MAPBOX_ROUTE_CHUNK - 1) {
        const chunk = snappedCoords.slice(i, i + MAPBOX_ROUTE_CHUNK);
        if (chunk.length < 2) break;

        const coordStr = chunk.map(c => `${c[0]},${c[1]}`).join(';');
        const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${coordStr}`
            + `?geometries=geojson&overview=full&access_token=${process.env.MAPBOX_API_KEY}`;

        const response = await fetch(url);
        if (!response.ok) continue;
        const data = await response.json();
        if (data.routes && data.routes.length > 0) {
            const seg = data.routes[0].geometry.coordinates;
            all.push(...(all.length > 0 ? seg.slice(1) : seg));
        }
    }
    return all;
}

const routeGeometryCache = new Map(); // "ServiceNo|Direction" -> { coordinates, startName, endName, stops }

async function computeRouteGeometry(serviceNo, direction) {
    const cacheKey = `${serviceNo}|${direction}`;
    if (routeGeometryCache.has(cacheKey)) {
        return routeGeometryCache.get(cacheKey);
    }

    const [busStopInfo, routesDocs] = await Promise.all([getBusStopInfoMap(), getBusRoutesDocsCached()]);

    const stops = routesDocs
        .filter(r => String(r.ServiceNo) === serviceNo && String(r.Direction) === direction)
        .sort((a, b) => Number(a.StopSequence) - Number(b.StopSequence));

    const stopEntries = stops
        .map(r => {
            const info = busStopInfo[r.BusStopCode];
            return info ? { code: r.BusStopCode, description: info.description, coordinates: info.coordinates } : null;
        })
        .filter(Boolean);
    if (stopEntries.length < 2) {
        throw new Error(`Bus ${serviceNo} direction ${direction} was not found, or has too few stops with known coordinates.`);
    }

    const snapped = await snapToRoadNetwork(stopEntries.map(entry => entry.coordinates));
    const routeCoords = await fetchRouteGeometryFromMapbox(snapped);
    if (routeCoords.length === 0) {
        throw new Error('Mapbox did not return a route geometry for this service.');
    }

    const result = {
        coordinates: routeCoords,
        startName: formatTerminusName(stopEntries[0].description),
        endName: formatTerminusName(stopEntries[stopEntries.length - 1].description),
        stops: stopEntries
    };

    routeGeometryCache.set(cacheKey, result);
    return result;
}

// ---------------------------------------------------------------------------
// Bridging / Free Boarding Points
//
// The data is fetched from the database, populated from a Google Sheet by
// running `npm run fetch-bridging-points`.
// ---------------------------------------------------------------------------

// Strips the "MRT STATION"/"LRT STATION" suffix LTA's dataset uses so sheet
// station names ("Jurong East") line up with GeoJSON ones ("JURONG EAST MRT STATION").
function normalizeStationName(name) {
    return String(name || '')
        .toUpperCase()
        .replace(/\s+MRT STATION$/, '')
        .replace(/\s+LRT STATION$/, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// Builds, for every station in the bridging sheet, the set of other stations
// reachable by a single bus service — i.e. a ServiceNo+Direction whose stop
// sequence passes a free-boarding stop of station A before (or after) a
// free-boarding stop of station B.
function buildConnectionsIndex(bridgingRows, busRoutesDocs, mrtFeatures, busStopInfo) {
    const stations = new Map(); // normName -> { displayName, lines:Set, codes: Map(code -> type) }
    for (const row of bridgingRows) {
        const normName = normalizeStationName(row.station);
        if (!stations.has(normName)) {
            stations.set(normName, { displayName: row.station, lines: new Set(), codes: new Map() });
        }
        const entry = stations.get(normName);
        if (row.line) entry.lines.add(row.line);
        for (const c of row.codes) {
            entry.codes.set(String(c.code), c.type);
        }
    }

    const codeToStations = new Map(); // code -> Set({normName, type})
    for (const [normName, entry] of stations) {
        for (const [code, type] of entry.codes) {
            if (!codeToStations.has(code)) codeToStations.set(code, new Set());
            codeToStations.get(code).add({ normName, type });
        }
    }

    const groups = new Map(); // "ServiceNo|Direction" -> stop docs
    for (const doc of busRoutesDocs) {
        const key = `${doc.ServiceNo}|${doc.Direction}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(doc);
    }

    // normName -> Map(boardStopCode -> Map(toNormName -> Map("ServiceNo|Direction" -> {serviceNo, direction, alightStopCode, numStops})))
    const connections = new Map();
    function addConnection(from, boardStopCode, to, svc) {
        if (!connections.has(from)) connections.set(from, new Map());
        const byBoard = connections.get(from);
        if (!byBoard.has(boardStopCode)) byBoard.set(boardStopCode, new Map());
        const byDest = byBoard.get(boardStopCode);
        if (!byDest.has(to)) byDest.set(to, new Map());
        const byService = byDest.get(to);
        const serviceKey = `${svc.serviceNo}|${svc.direction}`;
        const existing = byService.get(serviceKey);
        // A service can pass the same pair of free-boarding stops more than once on a
        // looping route — keep whichever occurrence is the shortest ride.
        if (!existing || svc.numStops < existing.numStops) {
            byService.set(serviceKey, svc);
        }
    }

    for (const [key, stops] of groups) {
        const [serviceNo, directionRaw] = key.split('|');
        const direction = Number(directionRaw);
        const sorted = stops.slice().sort((a, b) => Number(a.StopSequence) - Number(b.StopSequence));

        // Walk the route in stop order, noting every free-boarding stop it passes
        // together with its position in the sequence (used to count stops between
        // a boarding point and an alighting point further down the route).
        const touched = [];
        for (const stop of sorted) {
            const code = String(stop.BusStopCode);
            const stationEntries = codeToStations.get(code);
            if (!stationEntries) continue;
            for (const entry of stationEntries) {
                touched.push({ code, normName: entry.normName, type: entry.type, seq: Number(stop.StopSequence) });
            }
        }

        for (let i = 0; i < touched.length; i++) {
            // Only allow boarding at 'both' (yellow) bus stops
            if (touched[i].type !== 'both') continue;

            for (let j = i + 1; j < touched.length; j++) {
                if (touched[i].normName === touched[j].normName) continue;
                // Alighting is allowed at 'both' (yellow) or 'alight_only' (green)
                addConnection(touched[i].normName, touched[i].code, touched[j].normName, {
                    serviceNo,
                    direction,
                    alightStopCode: touched[j].code,
                    numStops: touched[j].seq - touched[i].seq
                });
            }
        }
    }

    const mrtNormNames = new Set(
        (mrtFeatures || [])
            .filter(f => f.properties && f.properties.STN_NAM_DE && (f.properties.STN_NAM_DE.includes('MRT STATION') || f.properties.STN_NAM_DE.includes('LRT STATION')))
            .map(f => normalizeStationName(f.properties.STN_NAM_DE))
    );
    const unmatchedInSheet = [...stations.keys()].filter(n => !mrtNormNames.has(n));
    const unmatchedInGeo = [...mrtNormNames].filter(n => !stations.has(n));

    const stationsOut = {};
    for (const [normName, entry] of stations) {
        const byBoard = connections.get(normName) || new Map();
        const boardingPoints = [...entry.codes]
            .filter(([code, type]) => type === 'both')
            .map(([code, type]) => code)
            .sort()
            .map((code) => {
            const byDest = byBoard.get(code) || new Map();
            const destinations = [...byDest.entries()].map(([toNorm, byService]) => {
                const toEntry = stations.get(toNorm);
                const services = [...byService.values()]
                    .sort((a, b) => a.serviceNo.localeCompare(b.serviceNo, undefined, { numeric: true }) || a.numStops - b.numStops);
                return {
                    displayName: toEntry ? toEntry.displayName : toNorm,
                    lines: toEntry ? [...toEntry.lines] : [],
                    services
                };
            }).sort((a, b) => a.displayName.localeCompare(b.displayName));

            const stopInfo = busStopInfo[code];
            return { code, name: stopInfo ? stopInfo.description : null, destinations };
        });

        stationsOut[normName] = {
            displayName: entry.displayName,
            lines: [...entry.lines],
            boardingPoints
        };
    }

    return {
        stations: stationsOut,
        diagnostics: {
            sheetStationCount: stations.size,
            matchedMrtStationCount: mrtNormNames.size - unmatchedInGeo.length,
            unmatchedInSheet,
            unmatchedInGeo
        }
    };
}

// Computed once per server process (data only changes when you re-run the
// fetch scripts / restart), so repeat requests don't re-walk every route.
let connectionsIndexCache = null;
async function getConnectionsIndex() {
    if (connectionsIndexCache) return connectionsIndexCache;

    const [bridgingRows, busRoutesDocs, mrtGeojson, busStopInfo] = await Promise.all([
        getBridgingPoints(),
        getBusRoutes(),
        getMrtStations(),
        getBusStopInfoMap()
    ]);

    const mrtFeatures = mrtGeojson ? mrtGeojson.features : [];
    connectionsIndexCache = buildConnectionsIndex(bridgingRows, busRoutesDocs, mrtFeatures, busStopInfo);

    console.log(
        `Bridging points: ${connectionsIndexCache.diagnostics.sheetStationCount} stations in sheet, ` +
        `${connectionsIndexCache.diagnostics.matchedMrtStationCount} matched to MRT station geometry.`
    );
    if (connectionsIndexCache.diagnostics.unmatchedInSheet.length) {
        console.warn('Sheet stations with no matching MRT station geometry:', connectionsIndexCache.diagnostics.unmatchedInSheet.join(', '));
    }
    if (connectionsIndexCache.diagnostics.unmatchedInGeo.length) {
        console.warn('MRT stations with no bridging points sheet entry:', connectionsIndexCache.diagnostics.unmatchedInGeo.join(', '));
    }

    return connectionsIndexCache;
}

app.get("/", async (req, res) => {
    res.render("main", {
        MAPBOX_API_KEY: process.env.MAPBOX_API_KEY
    });
});

app.get('/api/mrt-stations', async (req, res) => {
    try {
        const geojson = await getMrtStations();
        if (!geojson) {
            res.json({ value: null });
            return;
        }
        // Include both MRT and LRT stations on the map
        const features = geojson.features.filter(f => f.properties && f.properties.STN_NAM_DE && (f.properties.STN_NAM_DE.includes('MRT STATION') || f.properties.STN_NAM_DE.includes('LRT STATION')));
        res.json({ value: { type: 'FeatureCollection', features } });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/bus-stops', async (req, res) => {
    try {
        const records = await getBusStops();
        res.json({ value: records });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/bus-services', async (req, res) => {
    try {
        const records = await getBusServices();
        res.json({ value: records });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/route-geometry', async (req, res) => {
    const serviceNo = typeof req.query.serviceNo === 'string' ? req.query.serviceNo.trim() : '';
    const direction = typeof req.query.direction === 'string' ? req.query.direction.trim() : '';
    if (!serviceNo || !direction) {
        res.status(400).json({ error: 'serviceNo and direction query parameters are required.' });
        return;
    }

    try {
        const geometry = await computeRouteGeometry(serviceNo, direction);
        res.json({ value: geometry });
    } catch (error) {
        res.status(502).json({ error: error.message });
    }
});

app.get('/api/mrt-connections', async (req, res) => {
    try {
        const index = await getConnectionsIndex();
        res.json({ value: index.stations, diagnostics: index.diagnostics });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const { getStationCrowdDensity } = require('./models/StationCrowdDensity');
app.get('/api/mrt-crowd-density', async (req, res) => {
    try {
        const densityData = await getStationCrowdDensity();
        res.json({ value: densityData });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/train-alerts', async (req, res) => {
    try {
        const alertsData = await getTrainServiceAlerts();
        res.json({ value: alertsData });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

async function bootstrap() {
    try {
        const emptyDatabase = await isDatabaseEmpty();
        if (emptyDatabase) {
            console.log('Database is empty. Run `npm run refresh-all-data` to populate MRT stations and bus routes.');
        }
    } catch (error) {
        console.error(error.message);
    }
}
bootstrap();

app.listen(port, () => {
    console.log(`Application listening at http://localhost:${port}`);
});

process.on('SIGINT', async () => {
    await disconnect();
    process.exit(0);
});
