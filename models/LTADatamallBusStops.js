const { ObjectId } = require("mongodb");
const { connect } = require("../configs/database");
let { client } = require("../configs/database");

let busStops = null;

async function initDBIfNecessary() {
    if (!client) {
        client = await connect();
    }

    if (!busStops) {
        busStops = client.db(process.env.MONGODB_DBNAME).collection("LTADatamallBusStops");
    }
}

async function insertBusStops(busStopsList) {
    await initDBIfNecessary();
    if (!client) {
        throw new Error("Database not connected");
    }

    if (!busStops) {
        throw new Error("Bus stops collection not initialized");
    }

    if (!Array.isArray(busStopsList)) {
        throw new Error("busStopsList must be an array");
    }

    if (busStopsList.length === 0) {
        return { insertedCount: 0, insertedIds: [] };
    }

    const result = await busStops.insertMany(busStopsList, { ordered: false });
    return {
        insertedCount: result.insertedCount,
        insertedIds: Object.values(result.insertedIds),
    };
}

async function getBusStops(busStopCodeList) {
    if (arguments.length > 1) {
        throw new Error("getBusStops accepts at most 1 argument");
    }

    await initDBIfNecessary();
    if (!client) {
        throw new Error("Database not connected");
    }

    if (!busStops) {
        throw new Error("Bus stops collection not initialized");
    }

    const hasList = busStopCodeList !== undefined && busStopCodeList !== null;

    if (!hasList) {
        return await busStops.find({}).toArray();
    }

    if (!Array.isArray(busStopCodeList)) {
        throw new Error("busStopCodeList must be an array");
    }

    if (busStopCodeList.length === 0) {
        return [];
    }

    return await busStops.find({ BusStopCode: { $in: busStopCodeList.map(String) } }).toArray();
}

async function deleteBusStops(busStopCodeList) {
    if (arguments.length > 1) {
        throw new Error("deleteBusStops accepts at most 1 argument");
    }

    await initDBIfNecessary();
    if (!client) {
        throw new Error("Database not connected");
    }

    if (!busStops) {
        throw new Error("Bus stops collection not initialized");
    }

    const hasList = busStopCodeList !== undefined && busStopCodeList !== null;

    if (!hasList) {
        const result = await busStops.deleteMany({});
        return { deletedCount: result.deletedCount };
    }

    if (!Array.isArray(busStopCodeList)) {
        throw new Error("busStopCodeList must be an array");
    }

    if (busStopCodeList.length === 0) {
        return { deletedCount: 0 };
    }

    const result = await busStops.deleteMany({ BusStopCode: { $in: busStopCodeList.map(String) } });
    return { deletedCount: result.deletedCount };
}

module.exports = {
    insertBusStops,
    getBusStops,
    deleteBusStops
};