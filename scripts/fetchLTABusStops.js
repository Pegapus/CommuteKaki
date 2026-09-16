'use strict';

const { fetchLTADatamallDataset } = require('./fetchLTADatamallDataset');
const { insertBusStops, deleteBusStops } = require('../models/LTADatamallBusStops');
const { disconnect } = require('../configs/database');

(async () => {
    try {
        const records = await fetchLTADatamallDataset({
            endpoint: 'BusStops',
            datasetName: 'BusStops'
        });

        const { deletedCount } = await deleteBusStops();
        console.log(`Deleted ${deletedCount} existing Bus Stops records.`);

        const result = await insertBusStops(records);
        console.log(`Inserted ${result.insertedCount} Bus Stops records into the database.`);
    } catch (error) {
        console.error(`Failed to fetch/insert Bus Stops: ${error.message}`);
        process.exit(1);
    } finally {
        await disconnect();
    }
})().then(() => process.exit(0));
