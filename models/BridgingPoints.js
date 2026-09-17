const { connect } = require("../configs/database");
let { client } = require("../configs/database");

let collection = null;

async function initDBIfNecessary() {
    if (!client) {
        client = await connect();
    }
    if (!collection) {
        collection = client.db(process.env.MONGODB_DBNAME).collection("BridgingPoints");
    }
}

async function saveBridgingPoints(points) {
    await initDBIfNecessary();
    await collection.deleteMany({});
    
    // We expect points to be an array of objects
    if (points && points.length > 0) {
        await collection.insertMany(points);
    }
    return { ok: true };
}

async function getBridgingPoints() {
    await initDBIfNecessary();
    const docs = await collection.find({}).toArray();
    return docs;
}

module.exports = { saveBridgingPoints, getBridgingPoints };
