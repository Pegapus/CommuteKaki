'use strict';

const { fetchLTADatamallDataset } = require('./fetchLTADatamallDataset');
const { insertBusServices, deleteBusServices } = require('../models/LTADatamallBusServices');
const { disconnect } = require('../configs/database');

(async () => {
    try {
        const records = await fetchLTADatamallDataset({
            endpoint: 'BusServices',
            datasetName: 'BusServices'
        });

        const { deletedCount } = await deleteBusServices();
        console.log(`Deleted ${deletedCount} existing Bus Services records.`);

        const result = await insertBusServices(records);
        console.log(`Inserted ${result.insertedCount} Bus Services records into the database.`);
    } catch (error) {
        console.error(`Failed to fetch/insert Bus Services: ${error.message}`);
        process.exit(1);
    } finally {
        await disconnect();
    }
})().then(() => process.exit(0));
