const { connect } = require("../configs/database");
let { client } = require("../configs/database");

let collection = null;

async function initDBIfNecessary() {
    if (!client) {
        client = await connect();
    }
    if (!collection) {
        collection = client.db(process.env.MONGODB_DBNAME).collection("MRTStations");
    }
}

async function saveMrtStations(geojson) {
    await initDBIfNecessary();
    await collection.deleteMany({});
    await collection.insertOne({ geojson });
    return { ok: true };
}

async function getMrtStations() {
    await initDBIfNecessary();
    const doc = await collection.findOne({});
    return doc ? doc.geojson : null;
}

module.exports = { saveMrtStations, getMrtStations };
