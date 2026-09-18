let cachedAlerts = null;
let lastFetchTime = 0;
const CACHE_DURATION_MS = 60 * 1000; // 1 minute

async function getTrainServiceAlerts() {
    const now = Date.now();
    if (cachedAlerts && (now - lastFetchTime < CACHE_DURATION_MS)) {
        return cachedAlerts;
    }

    try {
        const response = await fetch('https://datamall2.mytransport.sg/ltaodataservice/TrainServiceAlerts', {
            headers: {
                'AccountKey': process.env.LTA_DATAMALL_KEY,
                'accept': 'application/json'
            }
        });
        
        if (!response.ok) {
            throw new Error(`LTA API returned ${response.status} ${response.statusText}`);
        }
        
        const data = await response.json();
        
        // APPEND MOCK DATA
        data.value.AffectedSegments.push({
            "Line": "NEL",
            "Direction": "Both",
            "Stations": "NE9,NE8,NE7,NE6",
            "FreePublicBus": "NE9,NE8,NE7,NE6",
            "FreeMRTShuttle": "",
            "MRTShuttleDirection": ""
        });
        data.value.Message.push({
            "Content": "16:57-NEL-Additional travelling time of 20 minutes between Boon Keng and Dhoby Ghaut stations in both directions due to a signal fault.",
            "CreatedDate": "2026-09-18 16:57:25"
        });
        data.value.AffectedSegments.push({
            "Line": "EWL",
            "Direction": "Both",
            "Stations": "EW2,EW3,EW4,EW5",
            "FreePublicBus": "EW2,EW3,EW4,EW5",
            "FreeMRTShuttle": "",
            "MRTShuttleDirection": ""
        });
        data.value.Message.push({
            "Content": "16:57-EWL-Additional travelling time of 20 minutes between Tampines and Bedok stations in both directions due to a signal fault.",
            "CreatedDate": "2026-09-18 16:57:25"
        });
        // cachedAlerts = {
        //     "Status": 2,
        //     "AffectedSegments": [
        //         {
        //             "Line": "NEL",
        //             "Direction": "HarbourFront",
        //             "Stations": "NE9,NE8,NE7,NE6",
        //             "FreePublicBus": "NE9,NE8,NE7,NE6",
        //             "FreeMRTShuttle": "",
        //             "MRTShuttleDirection": ""
        //         }
        //     ],
        //     "Message": [
        //         {
        //             "Content": "1657hrs : NEL - Additional travelling time of 20 minutes between Boon Keng and Dhoby Ghaut stations towards HarbourFront station due to a signal fault.",
        //             "CreatedDate": "2026-09-18 16:57:25"
        //         }
        //     ]
        // };

        cachedAlerts = data.value;
        lastFetchTime = now;
        return cachedAlerts;
    } catch (error) {
        console.error('Error fetching Train Service Alerts:', error);
        // If fetch fails but we have a cache, return stale cache rather than breaking
        if (cachedAlerts) {
            return cachedAlerts;
        }
        throw error;
    }
}

module.exports = { getTrainServiceAlerts };
