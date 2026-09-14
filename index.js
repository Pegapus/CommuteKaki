require('dotenv').config({ path: '.env' });

const requiredEnvVars = ['MONGODB_URI', 'MONGODB_DBNAME', 'MAPBOX_API_KEY', 'LTA_DATAMALL_KEY', 'FRONT_END_URL', 'BRIDGING_POINTS_SHEET_ID'];
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
const ExcelJS = require('exceljs');
const app = express();
const port = process.env.PORT || 3000;

app.set("view engine", "ejs");
app.use(express.static("public"));
app.use(morgan('dev'));

const { getMrtStations } = require('./models/MRTStations');
const { getBusRoutes } = require('./models/LTADatamallBusRoutes');
const { isDatabaseEmpty, disconnect } = require('./configs/database');

// ---------------------------------------------------------------------------
// Bridging / Free Boarding Points sheet
//
// The sheet ("Bridging/Free Boarding Points of Destination Station") lists,
// per MRT station, the bus stop codes near it that count as a free
// boarding/alighting point during a bus bridging service. There is a single
// list per station (not separate "boarding" and "alighting" sheets) — the
// same stops serve as the boarding end for a trip in one direction and the
// alighting end for a trip in the other, which is exactly what's needed to
// answer "what services connect station A to station B".
// ---------------------------------------------------------------------------
async function fetchBridgingPointsSheet(sheetId) {
    const url = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/export?format=xlsx`;
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Google Sheets returned ${response.status}. Ensure the sheet is publicly shared or the ID is correct.`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const worksheet = workbook.worksheets[0];
    if (!worksheet) {
        throw new Error('Bridging points sheet has no worksheets.');
    }

    const maxCol = worksheet.columnCount || 1;
    const rows = [];
    // Rows 1-5 are title/legend, row 6 is the "Line | Station | BS/BI Code" header.
    worksheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
        if (rowNumber < 7) return;
        const line = String(row.getCell(1).text || '').trim();
        const station = String(row.getCell(2).text || '').trim();
        if (!station) return;
        const codes = [];
        for (let c = 3; c <= maxCol; c++) {
            const code = String(row.getCell(c).text || '').trim();
            if (code) codes.push(code);
        }
        if (codes.length) rows.push({ line, station, codes });
    });

    if (rows.length === 0) {
        throw new Error('No station/bus-stop rows found in bridging points sheet (expected data starting row 7).');
    }
    return rows;
}

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
function buildConnectionsIndex(bridgingRows, busRoutesDocs, mrtFeatures) {
    const stations = new Map(); // normName -> { displayName, lines:Set, codes:Set }
    for (const row of bridgingRows) {
        const normName = normalizeStationName(row.station);
        if (!stations.has(normName)) {
            stations.set(normName, { displayName: row.station, lines: new Set(), codes: new Set() });
        }
        const entry = stations.get(normName);
        if (row.line) entry.lines.add(row.line);
        for (const code of row.codes) entry.codes.add(String(code));
    }

    const codeToStations = new Map(); // code -> Set(normName)
    for (const [normName, entry] of stations) {
        for (const code of entry.codes) {
            if (!codeToStations.has(code)) codeToStations.set(code, new Set());
            codeToStations.get(code).add(normName);
        }
    }

    const groups = new Map(); // "ServiceNo|Direction" -> stop docs
    for (const doc of busRoutesDocs) {
        const key = `${doc.ServiceNo}|${doc.Direction}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(doc);
    }

    const connections = new Map(); // normName -> Map(toNormName -> [{serviceNo, direction, boardStopCode, alightStopCode}])
    function addConnection(from, to, svc) {
        if (!connections.has(from)) connections.set(from, new Map());
        const map = connections.get(from);
        if (!map.has(to)) map.set(to, []);
        const list = map.get(to);
        const dupe = list.some(s => s.serviceNo === svc.serviceNo && s.direction === svc.direction);
        if (!dupe) list.push(svc);
    }

    for (const [key, stops] of groups) {
        const [serviceNo, directionRaw] = key.split('|');
        const direction = Number(directionRaw);
        const sorted = stops.slice().sort((a, b) => Number(a.StopSequence) - Number(b.StopSequence));

        // Walk the route in stop order, noting every free-boarding stop it passes.
        const touched = [];
        for (const stop of sorted) {
            const code = String(stop.BusStopCode);
            const names = codeToStations.get(code);
            if (!names) continue;
            for (const normName of names) {
                touched.push({ code, normName });
            }
        }

        // Collapse consecutive stops at the same station (e.g. two codes in a row).
        const collapsed = [];
        for (const t of touched) {
            const last = collapsed[collapsed.length - 1];
            if (last && last.normName === t.normName) continue;
            collapsed.push(t);
        }

        for (let i = 0; i < collapsed.length; i++) {
            for (let j = i + 1; j < collapsed.length; j++) {
                if (collapsed[i].normName === collapsed[j].normName) continue;
                addConnection(collapsed[i].normName, collapsed[j].normName, {
                    serviceNo,
                    direction,
                    boardStopCode: collapsed[i].code,
                    alightStopCode: collapsed[j].code
                });
            }
        }
    }

    const mrtNormNames = new Set(
        (mrtFeatures || [])
            .filter(f => f.properties && f.properties.TYP_CD_DES === 'MRT')
            .map(f => normalizeStationName(f.properties.STN_NAM_DE))
    );
    const unmatchedInSheet = [...stations.keys()].filter(n => !mrtNormNames.has(n));
    const unmatchedInGeo = [...mrtNormNames].filter(n => !stations.has(n));

    const stationsOut = {};
    for (const [normName, entry] of stations) {
        const connMap = connections.get(normName) || new Map();
        const connOut = {};
        for (const [toNorm, services] of connMap) {
            const toEntry = stations.get(toNorm);
            connOut[toNorm] = {
                displayName: toEntry ? toEntry.displayName : toNorm,
                lines: toEntry ? [...toEntry.lines] : [],
                services: services.slice().sort((a, b) => a.serviceNo.localeCompare(b.serviceNo, undefined, { numeric: true }))
            };
        }
        stationsOut[normName] = {
            displayName: entry.displayName,
            lines: [...entry.lines],
            connections: connOut
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

    const [bridgingRows, busRoutesDocs, mrtGeojson] = await Promise.all([
        fetchBridgingPointsSheet(process.env.BRIDGING_POINTS_SHEET_ID),
        getBusRoutes(),
        getMrtStations()
    ]);

    const mrtFeatures = mrtGeojson ? mrtGeojson.features : [];
    connectionsIndexCache = buildConnectionsIndex(bridgingRows, busRoutesDocs, mrtFeatures);

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
        // Scope to heavy-rail MRT stations — the bridging points sheet only covers MRT lines, not LRT.
        const features = geojson.features.filter(f => f.properties && f.properties.TYP_CD_DES === 'MRT');
        res.json({ value: { type: 'FeatureCollection', features } });
    } catch (error) {
        res.status(500).json({ error: error.message });
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
