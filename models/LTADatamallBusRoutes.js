const { connect } = require("../configs/database");
let { client } = require("../configs/database");

let busRoutes = null;

async function initDBIfNecessary() {
    if (!client) {
        client = await connect();
    }

    if (!busRoutes) {
        busRoutes = client.db(process.env.MONGODB_DBNAME).collection("LTADatamallBusRoutes");
    }
}

async function insertBusRoutes(busRoutesList) {
    await initDBIfNecessary();

    if (!Array.isArray(busRoutesList)) {
        throw new Error("busRoutesList must be an array");
    }

    if (busRoutesList.length === 0) {
        return { insertedCount: 0, insertedIds: [] };
    }

    const result = await busRoutes.insertMany(busRoutesList, { ordered: false });
    return {
        insertedCount: result.insertedCount,
        insertedIds: Object.values(result.insertedIds),
    };
}

async function getBusRoutes() {
    await initDBIfNecessary();
    return await busRoutes.find({}).toArray();
}

async function deleteBusRoutes() {
    await initDBIfNecessary();
    const result = await busRoutes.deleteMany({});
    return { deletedCount: result.deletedCount };
}

module.exports = {
    insertBusRoutes,
    getBusRoutes,
    deleteBusRoutes
};
