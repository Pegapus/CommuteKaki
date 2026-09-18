const https = require('https');
const { fetchLTADatamallDataset } = require('../scripts/fetchLTADatamallDataset');

let stationCodesCache = null;

async function getStationCodesMapping() {
    if (stationCodesCache) return stationCodesCache;

    return new Promise((resolve, reject) => {
        https.get('https://data.gov.sg/api/action/datastore_search?resource_id=d_d312a5b127e1ae74299b8ae664cedd4e&limit=1000', (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const records = JSON.parse(data).result.records;
                    const mapping = {};
                    for (const record of records) {
                        const normName = String(record.mrt_station_english || '').toUpperCase().trim();
                        mapping[record.stn_code] = normName;
                    }
                    stationCodesCache = mapping;
                    resolve(mapping);
                } catch (err) {
                    reject(err);
                }
            });
        }).on('error', reject);
    });
}

let crowdDensityCache = null;
let crowdDensityLastFetch = 0;

async function getStationCrowdDensity() {
    // Cache for 10 minutes (600,000 ms)
    if (crowdDensityCache && Date.now() - crowdDensityLastFetch < 600000) {
        return crowdDensityCache;
    }

    const lines = ['CCL', 'CEL', 'CGL', 'DTL', 'EWL', 'NEL', 'NSL', 'BPL', 'SLRT', 'PLRT', 'TEL'];
    
    // Fetch lines sequentially to avoid LTA Datamall spike arrest rate limits
    const allRecords = [];
    for (const line of lines) {
        try {
            const records = await fetchLTADatamallDataset({ 
                endpoint: `PCDRealTime?TrainLine=${line}`, 
                datasetName: `PCDRealTime-${line}` 
            });
            allRecords.push(...records);
        } catch (err) {
            console.error(`Failed to fetch PCDRealTime for ${line}:`, err.message);
        }
    }
    
    const mapping = await getStationCodesMapping();
    
    const densityMap = {};
    for (const record of allRecords) {
        if (!record.Station) continue;
        const normName = mapping[record.Station];
        if (normName) {
            // Keep the most severe crowd level if multiple codes map to the same station
            const current = densityMap[normName];
            const newLevel = record.CrowdLevel;
            if (!current || (current === 'l' && newLevel !== 'l') || (current === 'm' && newLevel === 'h')) {
                densityMap[normName] = newLevel;
            }
        }
    }
    
    crowdDensityCache = densityMap;
    crowdDensityLastFetch = Date.now();
    return densityMap;
}

module.exports = {
    getStationCrowdDensity,
    getStationCodesMapping
};
