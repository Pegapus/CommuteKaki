const { ObjectId } = require("mongodb");
const { connect } = require("../configs/database");
let { client } = require("../configs/database");

let busServices = null;

async function initDBIfNecessary() {
    if (!client) {
        client = await connect();
    }

    if (!busServices) {
        busServices = client.db(process.env.MONGODB_DBNAME).collection("LTADatamallBusServices");
    }
}

async function insertBusServices(busServicesList) {
    await initDBIfNecessary();
    if (!client) {
        throw new Error("Database not connected");
    }

    if (!busServices) {
        throw new Error("Bus services collection not initialized");
    }

    if (!Array.isArray(busServicesList)) {
        throw new Error("busServicesList must be an array");
    }

    if (busServicesList.length === 0) {
        return { insertedCount: 0, insertedIds: [] };
    }

    const result = await busServices.insertMany(busServicesList, { ordered: false });
    return {
        insertedCount: result.insertedCount,
        insertedIds: Object.values(result.insertedIds),
    };
}

async function getBusServices(serviceNo, direction) {
    if (arguments.length > 2) {
        throw new Error("getBusServices accepts at most 2 arguments");
    }

    await initDBIfNecessary();
    if (!client) {
        throw new Error("Database not connected");
    }

    if (!busServices) {
        throw new Error("Bus services collection not initialized");
    }

    const hasServiceNo = serviceNo !== undefined && serviceNo !== null;
    const hasDirection = direction !== undefined && direction !== null;

    if (!hasServiceNo && !hasDirection) {
        return await busServices.find({}).toArray();
    }

    const query = {};
    if (hasServiceNo) {
        query.ServiceNo = String(serviceNo);
    }
    if (hasDirection) {
        query.Direction = String(direction);
    }

    return await busServices.find(query).toArray();
}

async function deleteBusServices(serviceNo, direction) {
    if (arguments.length > 2) {
        throw new Error("deleteBusServices accepts at most 2 arguments");
    }

    await initDBIfNecessary();
    if (!client) {
        throw new Error("Database not connected");
    }

    if (!busServices) {
        throw new Error("Bus services collection not initialized");
    }

    const hasServiceNo = serviceNo !== undefined && serviceNo !== null;
    const hasDirection = direction !== undefined && direction !== null;

    const query = {};
    if (hasServiceNo) {
        query.ServiceNo = String(serviceNo);
    }
    if (hasDirection) {
        query.Direction = String(direction);
    }

    const result = await busServices.deleteMany(query);
    return {
        deletedCount: result.deletedCount,
    };
}

module.exports = {
    insertBusServices,
    getBusServices,
    deleteBusServices
};