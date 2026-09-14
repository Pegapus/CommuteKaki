const { MongoClient } = require("mongodb");

let client = null;

async function connect() {
    if (!client) {
        try {
            client = await MongoClient.connect(process.env.MONGODB_URI, {
                serverSelectionTimeoutMS: 5000,
            });
            console.log("Connected to MongoDB successfully.");
        } catch (error) {
            console.error("Database connection failed.");
            client = null;
            throw error;
        }
    }
    return client;
}

async function isDatabaseEmpty() {
    if (!client) {
        await connect();
    }

    if (!client) {
        throw new Error('Database connection unavailable.');
    }

    const collections = await client.db(process.env.MONGODB_DBNAME).listCollections({}, { nameOnly: true }).toArray();

    if (collections.length === 0) return true;

    for (const { name } of collections) {
        const oneDoc = await client.db(process.env.MONGODB_DBNAME).collection(name).findOne({}, { projection: { _id: 1 } });
        if (oneDoc) return false;
    }

    return true;
}

async function disconnect() {
    if (client) {
        await client.close();
        client = null;
    }
}

module.exports = {
    connect,
    client,
    isDatabaseEmpty,
    disconnect
};
