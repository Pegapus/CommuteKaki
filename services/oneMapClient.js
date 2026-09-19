'use strict';

const BASE_URL = 'https://www.onemap.gov.sg/api/public/routingsvc/route';
const cache = new Map();
const queue = [];
let activeRequests = 0;
let nextRequestAt = 0;

async function limited(task) {
    if (activeRequests >= 2) await new Promise(resolve => queue.push(resolve));
    else activeRequests++;
    try {
        const wait = Math.max(0, nextRequestAt - Date.now());
        nextRequestAt = Date.now() + wait + 350;
        if (wait) await new Promise(resolve => setTimeout(resolve, wait));
        return await task();
    } finally {
        const next = queue.shift();
        if (next) next();
        else activeRequests--;
    }
}

async function readResponse(response) {
    const text = await response.text();
    if (!text) return {};
    try { return JSON.parse(text); }
    catch { return { error: text.slice(0, 300) }; }
}

async function requestOneMapRoute({ token, start, end, date, time, mode, maxWalkDistance, numItineraries = 3 }) {
    const params = new URLSearchParams({
        start, end, routeType: 'pt', mode: String(mode).toLowerCase(), date, time,
        numItineraries: String(numItineraries)
    });
    if (maxWalkDistance) params.set('maxWalkDistance', String(maxWalkDistance));
    const key = params.toString();
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.promise;

    const entry = { expiresAt: Date.now() + 2 * 60 * 1000 };
    entry.promise = limited(async () => {
        const send = () => fetch(`${BASE_URL}?${params}`, {
            headers: { Authorization: token }, signal: AbortSignal.timeout(12000)
        });
        let response = await send();
        if (response.status === 429) {
            const retryAfter = response.headers.get('retry-after');
            const delayMs = /^\d+$/.test(retryAfter || '') ? Number(retryAfter) * 1000 : 1000;
            if (delayMs <= 3000) {
                await new Promise(resolve => setTimeout(resolve, Math.max(1000, delayMs)));
                response = await send();
            }
        }
        if (response.status === 404) return null;
        const data = await readResponse(response);
        if (!response.ok || data.error) {
            const error = new Error(data.error || data.message || `OneMap returned HTTP ${response.status}.`);
            error.status = response.status;
            throw error;
        }
        return data;
    }).catch(error => {
        if (cache.get(key) === entry) cache.delete(key);
        throw error;
    });
    cache.set(key, entry);
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    return entry.promise;
}

module.exports = { requestOneMapRoute };
