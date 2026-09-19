'use strict';

const LEVEL_SCORE = { l: 0, m: 1, h: 2, unknown: 3 };
const RAIL_MODES = new Set(['SUBWAY', 'RAIL', 'TRAIN', 'TRAM', 'MONORAIL']);

function metric(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : Number.POSITIVE_INFINITY;
}

function normalizeStationName(name) {
    return String(name || '').toUpperCase()
        .replace(/\b(?:MRT|LRT)\s+STATION\b/g, '')
        .replace(/\s+/g, ' ').trim();
}

function itinerarySignature(itinerary) {
    return (itinerary.legs || []).map(leg => [
        String(leg.mode || '').toUpperCase(),
        leg.route || leg.routeShortName || leg.routeLongName || '',
        leg.from?.stopCode || leg.from?.stopId || leg.from?.name || '',
        leg.to?.stopCode || leg.to?.stopId || leg.to?.name || ''
    ].map(value => String(value).trim().toUpperCase()).join(':')).join('|') ||
        `EMPTY:${itinerary.duration}:${itinerary.walkDistance}:${itinerary.transfers}`;
}

function dominates(left, right) {
    return metric(left.duration) <= metric(right.duration) &&
        metric(left.walkDistance) <= metric(right.walkDistance) &&
        metric(left.transfers) <= metric(right.transfers);
}

function mergeProfileResults(profileResults) {
    const routesBySignature = new Map();
    for (const { profile, itineraries = [] } of profileResults) {
        for (const itinerary of itineraries) {
            const signature = itinerarySignature(itinerary);
            const variants = routesBySignature.get(signature) || [];
            const existing = variants.find(route => dominates(route, itinerary));
            if (existing) {
                existing.sourceProfiles = [...new Set([...(existing.sourceProfiles || []), profile])];
                continue;
            }
            const replaced = variants.filter(route => dominates(itinerary, route));
            routesBySignature.set(signature, [
                ...variants.filter(route => !replaced.includes(route)),
                { ...itinerary, sourceProfiles: [...new Set([profile, ...replaced.flatMap(route => route.sourceProfiles || [])])] }
            ]);
        }
    }
    return [...routesBySignature.values()].flat().map((route, id) => ({ ...route, id }));
}

function describeCrowd(itinerary, crowdDensity = {}) {
    const stations = [];
    let hasUnmeasuredLeg = false;
    for (const leg of itinerary.legs || []) {
        const mode = String(leg.mode || '').toUpperCase();
        if (mode === 'BUS') hasUnmeasuredLeg = true;
        if (!RAIL_MODES.has(mode)) continue;
        const name = normalizeStationName(leg.from?.name);
        if (!name || stations.some(station => station.name === name)) continue;
        const level = String(crowdDensity[name] || '').toLowerCase();
        stations.push({ name, level: level in LEVEL_SCORE && level !== 'unknown' ? level : 'unknown' });
    }
    const known = stations.filter(station => station.level !== 'unknown');
    const level = known.length
        ? known.reduce((worst, station) => LEVEL_SCORE[station.level] > LEVEL_SCORE[worst] ? station.level : worst, known[0].level)
        : 'unknown';
    const complete = stations.length > 0 && known.length === stations.length && !hasUnmeasuredLeg;
    return { level, complete, stations, hasUnmeasuredLeg };
}

function annotateCrowd(itineraries, crowdDensity) {
    return itineraries.map(itinerary => ({ ...itinerary, crowd: describeCrowd(itinerary, crowdDensity) }));
}

function normalizePreferences(input = {}) {
    const preference = ['fastest', 'crowd', 'transfers', 'walking'].includes(input.preference) ? input.preference : 'fastest';
    const maxCrowd = ['any', 'l', 'm'].includes(input.maxCrowd) ? input.maxCrowd : 'any';
    const maxTransfers = ['any', '0', '1', '2'].includes(String(input.maxTransfers)) ? String(input.maxTransfers) : 'any';
    const maxWalk = ['any', '500', '1000', '2000'].includes(String(input.maxWalk)) ? String(input.maxWalk) : 'any';
    return { preference, maxCrowd, maxTransfers, maxWalk, includeUnknown: input.includeUnknown === true || input.includeUnknown === 'true' };
}

function filterAndRank(itineraries, rawPreferences = {}) {
    const preferences = normalizePreferences(rawPreferences);
    const filtered = itineraries.filter(itinerary => {
        if (preferences.maxTransfers !== 'any' && metric(itinerary.transfers) > Number(preferences.maxTransfers)) return false;
        if (preferences.maxWalk !== 'any' && metric(itinerary.walkDistance) > Number(preferences.maxWalk)) return false;
        if (preferences.maxCrowd !== 'any') {
            const crowd = itinerary.crowd || { level: 'unknown', complete: false };
            if (crowd.level !== 'unknown' && LEVEL_SCORE[crowd.level] > LEVEL_SCORE[preferences.maxCrowd]) return false;
            if (!crowd.complete && !preferences.includeUnknown) return false;
        }
        return true;
    });
    const compareMetric = (a, b, field) => metric(a[field]) - metric(b[field]);
    filtered.sort((a, b) => {
        let difference = 0;
        if (preferences.preference === 'crowd') {
            const score = route => route.crowd?.complete ? LEVEL_SCORE[route.crowd.level] : route.crowd?.level === 'unknown' ? 4 : 3;
            difference = score(a) - score(b);
        } else if (preferences.preference === 'transfers') difference = compareMetric(a, b, 'transfers');
        else if (preferences.preference === 'walking') difference = compareMetric(a, b, 'walkDistance');
        return difference || compareMetric(a, b, 'duration') || compareMetric(a, b, 'walkDistance') || a.id - b.id;
    });
    return filtered;
}

function buildProfiles(rawPreferences = {}) {
    const preferences = normalizePreferences(rawPreferences);
    const walkingCap = preferences.maxWalk === 'any' ? 2000 : Number(preferences.maxWalk);
    const distances = [500, 1000, 2000].filter(distance => distance <= walkingCap);
    const modes = preferences.preference === 'crowd'
        ? ['rail', 'transit', 'bus']
        : preferences.preference === 'transfers' ? ['rail', 'bus', 'transit'] : ['transit', 'rail', 'bus'];
    return distances.flatMap(maxWalkDistance => modes.map(mode => ({
        name: `${mode}-walk-${maxWalkDistance}`, mode, maxWalkDistance
    })));
}

module.exports = {
    annotateCrowd,
    buildProfiles,
    describeCrowd,
    filterAndRank,
    mergeProfileResults,
    normalizePreferences,
    normalizeStationName
};
