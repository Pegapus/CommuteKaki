'use strict';

const https = require('https');
const dotenv = require('dotenv');

dotenv.config();

const BASE_URL = 'https://datamall2.mytransport.sg';
const PAGE_SIZE = 500;

function getAccountKey() {
    return process.env.LTA_DATAMALL_KEY || process.env.LTA_ACCOUNT_KEY;
}

function httpsGetJson(url, headers, redirectsLeft = 3) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers }, res => {
            const statusCode = res.statusCode || 0;

            if ([301, 302, 303, 307, 308].includes(statusCode) && res.headers.location && redirectsLeft > 0) {
                const nextUrl = new URL(res.headers.location, url).toString();
                res.resume();
                return resolve(httpsGetJson(nextUrl, headers, redirectsLeft - 1));
            }

            let raw = '';
            res.setEncoding('utf8');
            res.on('data', chunk => {
                raw += chunk;
            });

            res.on('end', () => {
                if (statusCode < 200 || statusCode >= 300) {
                    return reject(new Error(`HTTP ${statusCode}: ${raw.slice(0, 300)}`));
                }

                try {
                    resolve(JSON.parse(raw));
                } catch (error) {
                    reject(new Error(`Invalid JSON response: ${error.message}`));
                }
            });
        }).on('error', reject);
    });
}

async function fetchLTADatamallDataset({ endpoint, datasetName }) {
    const accountKey = getAccountKey();
    if (!accountKey) {
        throw new Error('Missing LTA_DATAMALL_KEY (or LTA_ACCOUNT_KEY) in environment.');
    }

    const headers = {
        AccountKey: accountKey,
        accept: 'application/json'
    };

    const records = [];
    let skip = 0;

    while (true) {
        const separator = endpoint.includes('?') ? '&' : '?';
        const requestUrl = `${BASE_URL}/ltaodataservice/${endpoint}${separator}$skip=${skip}`;
        console.log(`Fetching ${datasetName}: ${requestUrl}`);

        const payload = await httpsGetJson(requestUrl, headers);
        const page = Array.isArray(payload.value) ? payload.value : [];

        if (page.length === 0) {
            break;
        }

        records.push(...page);
        console.log(`  Retrieved ${page.length} records (total: ${records.length})`);

        if (page.length < PAGE_SIZE) {
            break;
        }

        skip += PAGE_SIZE;
    }

    console.log(`Fetched ${records.length} ${datasetName} records.`);
    return records;
}

module.exports = {
    fetchLTADatamallDataset
};
