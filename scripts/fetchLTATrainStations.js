'use strict';

const https = require('https');
const http = require('http');
const zlib = require('zlib');
const dotenv = require('dotenv');

dotenv.config();

const { saveMrtStations } = require('../models/MRTStations');
const { disconnect } = require('../configs/database');

const BASE_URL = 'https://datamall2.mytransport.sg';

function getAccountKey() {
    return process.env.LTA_DATAMALL_KEY || process.env.LTA_ACCOUNT_KEY;
}

function httpsGetJson(url, headers, redirectsLeft = 5) {
    return new Promise((resolve, reject) => {
        const lib = url.startsWith('https') ? https : http;
        lib.get(url, { headers }, res => {
            const statusCode = res.statusCode || 0;
            if ([301, 302, 303, 307, 308].includes(statusCode) && res.headers.location && redirectsLeft > 0) {
                const nextUrl = new URL(res.headers.location, url).toString();
                res.resume();
                return resolve(httpsGetJson(nextUrl, headers, redirectsLeft - 1));
            }
            let raw = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { raw += chunk; });
            res.on('end', () => {
                if (statusCode < 200 || statusCode >= 300)
                    return reject(new Error(`HTTP ${statusCode}: ${raw.slice(0, 200)}`));
                try { resolve(JSON.parse(raw)); }
                catch (e) { reject(new Error(`Invalid JSON: ${e.message}`)); }
            });
        }).on('error', reject);
    });
}

function downloadBinary(url, redirectsLeft = 10) {
    return new Promise((resolve, reject) => {
        const lib = url.startsWith('https') ? https : http;
        lib.get(url, res => {
            const statusCode = res.statusCode || 0;
            if ([301, 302, 303, 307, 308].includes(statusCode) && res.headers.location && redirectsLeft > 0) {
                const nextUrl = new URL(res.headers.location, url).toString();
                res.resume();
                return resolve(downloadBinary(nextUrl, redirectsLeft - 1));
            }
            if (statusCode < 200 || statusCode >= 300) {
                res.resume();
                return reject(new Error(`HTTP ${statusCode} downloading file`));
            }
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks)));
        }).on('error', reject);
    });
}

// ---------------------------------------------------------------------------
// Minimal ZIP extractor — supports Store (0) and Deflate (8)
// ---------------------------------------------------------------------------
function extractZip(buf) {
    const EOCD_SIG = 0x06054B50;
    const CD_SIG   = 0x02014B50;
    const LFH_SIG  = 0x04034B50;

    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65536); i--) {
        if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd === -1) throw new Error('Invalid ZIP: EOCD signature not found');

    const totalEntries = buf.readUInt16LE(eocd + 10);
    let cdPos          = buf.readUInt32LE(eocd + 16);

    const files = {};

    for (let i = 0; i < totalEntries; i++) {
        if (buf.readUInt32LE(cdPos) !== CD_SIG) break;

        const method      = buf.readUInt16LE(cdPos + 10);
        const compSize    = buf.readUInt32LE(cdPos + 20);
        const nameLen     = buf.readUInt16LE(cdPos + 28);
        const extraLen    = buf.readUInt16LE(cdPos + 30);
        const commentLen  = buf.readUInt16LE(cdPos + 32);
        const localOffset = buf.readUInt32LE(cdPos + 42);
        const name        = buf.slice(cdPos + 46, cdPos + 46 + nameLen).toString('utf8');

        cdPos += 46 + nameLen + extraLen + commentLen;

        if (name.endsWith('/')) continue;

        if (buf.readUInt32LE(localOffset) !== LFH_SIG) continue;
        const localNameLen  = buf.readUInt16LE(localOffset + 26);
        const localExtraLen = buf.readUInt16LE(localOffset + 28);
        const dataStart     = localOffset + 30 + localNameLen + localExtraLen;
        const compressed    = buf.slice(dataStart, dataStart + compSize);

        let data;
        if (method === 0) {
            data = compressed;
        } else if (method === 8) {
            data = zlib.inflateRawSync(compressed);
        } else {
            throw new Error(`Unsupported ZIP compression method ${method} for ${name}`);
        }

        const baseName = name.split('/').pop().toLowerCase();
        files[baseName] = data;
    }

    return files;
}

// ---------------------------------------------------------------------------
// SHP parser — supports Point (1), PolyLine (3), Polygon (5), MultiPoint (8)
// ---------------------------------------------------------------------------
function parseShp(buf) {
    const geometries = [];
    let pos = 100; // skip 100-byte file header

    while (pos + 8 <= buf.length) {
        const contentBytes = buf.readInt32BE(pos + 4) * 2;
        pos += 8;

        if (pos + contentBytes > buf.length) break;
        const recType = buf.readInt32LE(pos);

        if (recType === 0) {
            geometries.push(null);
        } else if (recType === 1) {
            geometries.push({
                type: 'Point',
                coordinates: [buf.readDoubleLE(pos + 4), buf.readDoubleLE(pos + 12)]
            });
        } else if (recType === 3 || recType === 5) {
            const numParts  = buf.readInt32LE(pos + 36);
            const numPoints = buf.readInt32LE(pos + 40);
            const parts     = [];
            for (let p = 0; p < numParts; p++) {
                parts.push(buf.readInt32LE(pos + 44 + p * 4));
            }
            const ptsBase = pos + 44 + numParts * 4;
            const allCoords = [];
            for (let p = 0; p < numPoints; p++) {
                allCoords.push([buf.readDoubleLE(ptsBase + p * 16), buf.readDoubleLE(ptsBase + p * 16 + 8)]);
            }
            const rings = parts.map((start, idx) => allCoords.slice(start, parts[idx + 1] ?? numPoints));
            if (recType === 5) {
                geometries.push({ type: 'Polygon', coordinates: rings });
            } else {
                geometries.push(rings.length === 1
                    ? { type: 'LineString', coordinates: rings[0] }
                    : { type: 'MultiLineString', coordinates: rings });
            }
        } else if (recType === 8) {
            const numPoints = buf.readInt32LE(pos + 36);
            const pts = [];
            for (let p = 0; p < numPoints; p++) {
                pts.push([buf.readDoubleLE(pos + 40 + p * 16), buf.readDoubleLE(pos + 40 + p * 16 + 8)]);
            }
            geometries.push({ type: 'MultiPoint', coordinates: pts });
        } else {
            geometries.push(null);
        }

        pos += contentBytes;
    }

    return geometries;
}

// ---------------------------------------------------------------------------
// SVY21 (EPSG:3414) → WGS84 coordinate conversion
// Standard inverse Transverse Mercator (Snyder 1987)
// ---------------------------------------------------------------------------
function svy21ToWgs84(E, N) {
    const a  = 6378137.0;
    const f  = 1.0 / 298.257223563;
    const e2 = 2*f - f*f;
    const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));

    // SVY21 projection constants — use ESRI WKT values from the shapefile PRJ
    // (1°22'00.000"N, 103°50'00.000"E) to match how the data was projected.
    // EPSG:3414 lists 1°22'02.9154"N / 103°50'01.7174"E, but the LTA shapefile
    // uses the rounded ESRI variant; mismatching origins causes a ~90 m N shift.
    const E0   = 28001.642;
    const N0   = 38744.572;
    const k0   = 1.0;
    const phi0 = 1.366666666666667 * Math.PI / 180;
    const lam0 = 103.8333333333333 * Math.PI / 180;

    function meridionalArc(phi) {
        return a * (
            (1 - e2/4 - 3*e2*e2/64 - 5*e2*e2*e2/256) * phi
            - (3*e2/8 + 3*e2*e2/32 + 45*e2*e2*e2/1024) * Math.sin(2*phi)
            + (15*e2*e2/256 + 45*e2*e2*e2/1024) * Math.sin(4*phi)
            - (35*e2*e2*e2/3072) * Math.sin(6*phi)
        );
    }

    const M0  = meridionalArc(phi0);
    const M1  = (N - N0) / k0 + M0;
    const mu1 = M1 / (a * (1 - e2/4 - 3*e2*e2/64 - 5*e2*e2*e2/256));

    const phi1 = mu1
        + (3*e1/2 - 27*e1**3/32)       * Math.sin(2*mu1)
        + (21*e1**2/16 - 55*e1**4/32)  * Math.sin(4*mu1)
        + (151*e1**3/96)                * Math.sin(6*mu1)
        + (1097*e1**4/512)              * Math.sin(8*mu1);

    const sinP = Math.sin(phi1), cosP = Math.cos(phi1), tanP = sinP / cosP;
    const N1  = a / Math.sqrt(1 - e2 * sinP * sinP);
    const R1  = a * (1 - e2) / Math.pow(1 - e2 * sinP * sinP, 1.5);
    const C1  = (e2 / (1 - e2)) * cosP * cosP;
    const T1  = tanP * tanP;
    const D   = (E - E0) / (N1 * k0);
    const ep2 = e2 / (1 - e2);

    const lat = phi1 - (N1 * tanP / R1) * (
        D*D/2
        - (5 + 3*T1 + 10*C1 - 4*C1*C1 - 9*ep2) * D**4/24
        + (61 + 90*T1 + 298*C1 + 45*T1*T1 - 252*ep2 - 3*C1*C1) * D**6/720
    );

    const lon = lam0 + (
        D
        - (1 + 2*T1 + C1) * D**3/6
        + (5 - 2*C1 + 28*T1 - 3*C1*C1 + 8*ep2 + 24*T1*T1) * D**5/120
    ) / cosP;

    return [lon * 180/Math.PI, lat * 180/Math.PI];
}

function transformCoords(coords) {
    if (typeof coords[0] === 'number') return svy21ToWgs84(coords[0], coords[1]);
    return coords.map(transformCoords);
}

function transformGeometry(geom) {
    if (!geom) return null;
    return { type: geom.type, coordinates: transformCoords(geom.coordinates) };
}

// ---------------------------------------------------------------------------
// DBF parser — returns array of property objects
// ---------------------------------------------------------------------------
function parseDbf(buf) {
    const recordCount = buf.readUInt32LE(4);
    const headerSize  = buf.readUInt16LE(8);
    const recordSize  = buf.readUInt16LE(10);

    const fields = [];
    let pos = 32;
    while (pos < headerSize - 1 && buf[pos] !== 0x0D) {
        fields.push({
            name:   buf.slice(pos, pos + 11).toString('ascii').replace(/\0/g, '').trim(),
            type:   String.fromCharCode(buf[pos + 11]),
            length: buf[pos + 16]
        });
        pos += 32;
    }

    const records = [];
    for (let i = 0; i < recordCount; i++) {
        const recStart = headerSize + i * recordSize;
        if (recStart >= buf.length) break;

        const deleted = buf[recStart] === 0x2A;
        if (deleted) continue;

        const props = {};
        let fPos = recStart + 1;
        for (const { name, type, length } of fields) {
            const raw = buf.slice(fPos, fPos + length).toString('ascii').trim();
            fPos += length;
            props[name] = (type === 'N' || type === 'F') ? (raw === '' ? null : Number(raw)) : raw;
        }
        records.push(props);
    }

    return records;
}

// ---------------------------------------------------------------------------
// Assemble GeoJSON FeatureCollection
// ---------------------------------------------------------------------------
function toGeoJSON(geometries, properties) {
    const features = [];
    const len = Math.min(geometries.length, properties.length);
    for (let i = 0; i < len; i++) {
        if (!geometries[i]) continue;
        features.push({ type: 'Feature', geometry: transformGeometry(geometries[i]), properties: properties[i] });
    }
    return { type: 'FeatureCollection', features };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
    try {
        const accountKey = getAccountKey();
        if (!accountKey) throw new Error('Missing LTA_DATAMALL_KEY (or LTA_ACCOUNT_KEY) in environment.');

        const headers = { AccountKey: accountKey, accept: 'application/json' };

        console.log('Fetching TrainStation download link from LTA DataMall...');
        const data = await httpsGetJson(
            `${BASE_URL}/ltaodataservice/GeospatialWholeIsland?ID=TrainStation`,
            headers
        );

        const link = data?.value?.[0]?.Link;
        if (!link) throw new Error('No download link in API response: ' + JSON.stringify(data).slice(0, 300));

        console.log(`Download link: ${link}`);
        console.log('Downloading shapefile ZIP...');
        const zipBuffer = await downloadBinary(link);
        console.log(`Downloaded ${(zipBuffer.length / 1024).toFixed(1)} KB.`);

        console.log('Extracting ZIP...');
        const files = extractZip(zipBuffer);
        console.log(`Found files: ${Object.keys(files).join(', ')}`);

        const shpName = Object.keys(files).find(f => f.endsWith('.shp'));
        const dbfName = Object.keys(files).find(f => f.endsWith('.dbf'));
        if (!shpName) throw new Error('No .shp file found in ZIP');
        if (!dbfName) throw new Error('No .dbf file found in ZIP');

        console.log('Parsing shapefile...');
        const geometries = parseShp(files[shpName]);
        const properties = parseDbf(files[dbfName]);

        const geojson = toGeoJSON(geometries, properties);
        if (!geojson.features.length) throw new Error('No features parsed from shapefile.');

        console.log(`Parsed ${geojson.features.length} station feature(s) (MRT + LRT).`);
        console.log('Deleting existing records and saving to database...');
        await saveMrtStations(geojson);
        console.log(`Done. ${geojson.features.length} station feature(s) saved.`);
    } finally {
        await disconnect();
    }
}

main()
    .then(() => process.exit(0))
    .catch(async err => {
        console.error('Fatal:', err.message);
        await disconnect();
        process.exit(1);
    });
