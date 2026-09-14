'use strict';

const { fetchLTADatamallDataset } = require('./fetchLTADatamallDataset');
const { insertBusRoutes, deleteBusRoutes } = require('../models/LTADatamallBusRoutes');
const { disconnect } = require('../configs/database');

(async () => {
    try {
        const records = await fetchLTADatamallDataset({
            endpoint: 'BusRoutes',
            datasetName: 'BusRoutes'
        });

        const { deletedCount } = await deleteBusRoutes();
        console.log(`Deleted ${deletedCount} existing Bus Routes records.`);

        const result = await insertBusRoutes(records);
        console.log(`Inserted ${result.insertedCount} Bus Routes records into the database.`);
    } catch (error) {
        console.error(`Failed to fetch/insert Bus Routes: ${error.message}`);
        process.exit(1);
    } finally {
        await disconnect();
    }
})().then(() => process.exit(0));
