'use strict';

function normalizePlaces(query, results) {
    const postal = /^\d{6}$/.test(query) ? query : null;
    const stationQuery = /\b(?:mrt|lrt)\b/i.test(query);
    const seen = new Set();
    return results.filter(result => !postal || result.POSTAL === postal)
        .map(result => ({
            name: result.ADDRESS || result.SEARCHVAL,
            lat: Number.parseFloat(result.LATITUDE),
            lon: Number.parseFloat(result.LONGITUDE),
            building: result.BUILDING || '',
            postal: result.POSTAL || '',
            source: 'OneMap'
        }))
        .filter(place => place.name && Number.isFinite(place.lat) && Number.isFinite(place.lon)
            && place.lat >= 1.15 && place.lat <= 1.5 && place.lon >= 103.55 && place.lon <= 104.15)
        .filter(place => {
            const key = `${place.name}|${place.lat}|${place.lon}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .sort((a, b) => {
            if (!stationQuery || /\bexit\b/i.test(query)) return 0;
            const rank = place => /\b(?:MRT|LRT) STATION\b/i.test(place.building || place.name)
                ? (/\bEXIT\b/i.test(place.name) ? 1 : 0) : 2;
            return rank(a) - rank(b);
        }).slice(0, 6);
}

function createPlaceSearch(fetchImpl = fetch) {
    const cache = new Map();
    return async function searchPlaces(query) {
        query = String(query || '').trim().replace(/\s+/g, ' ');
        if (query.length < 2 || query.length > 120) return [];
        const key = query.toLowerCase();
        const cached = cache.get(key);
        if (cached && cached.expires > Date.now()) return cached.promise;
        const entry = { expires: Date.now() + 5 * 60 * 1000 };
        entry.promise = (async () => {
            const params = new URLSearchParams({ searchVal: query, returnGeom: 'Y', getAddrDetails: 'Y', pageNum: '1' });
            const response = await fetchImpl(`https://www.onemap.gov.sg/api/common/elastic/search?${params}`, {
                signal: AbortSignal.timeout(10000)
            });
            if (!response.ok) throw new Error('Place search unavailable. Try again or select a point on the map.');
            const data = await response.json();
            if (!Array.isArray(data.results)) throw new Error('Invalid place search response. Please try again.');
            return normalizePlaces(query, data.results);
        })().catch(error => {
            if (cache.get(key) === entry) cache.delete(key);
            throw error;
        });
        cache.set(key, entry);
        if (cache.size > 200) cache.delete(cache.keys().next().value);
        return entry.promise;
    };
}

module.exports = { searchPlaces: createPlaceSearch(), createPlaceSearch, normalizePlaces };
