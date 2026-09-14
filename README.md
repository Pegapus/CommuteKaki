# Smart Commuter Companion App

Map of Singapore MRT stations. Click a station to see which bus services connect it — via LTA's bridging/free boarding-and-alighting points — to another MRT station.

## How it works

LTA publishes a "Bridging/Free Boarding Points of Destination Station" sheet: for each MRT station, a list of nearby bus stop codes that count as a free boarding/alighting point during a bus bridging service (e.g. an MRT disruption). It's a single list per station, not separate boarding/alighting sheets — the same stops serve as the boarding end for a trip in one direction and the alighting end in the other.

At startup the server:
1. Fetches that sheet (Google Sheets export, `BRIDGING_POINTS_SHEET_ID`) and groups its bus stop codes by MRT station.
2. Loads every LTA bus route's stop sequence (`LTADatamallBusRoutes`, fetched via `npm run fetch-bus-routes`).
3. For every bus service/direction, walks its stop sequence and finds every pair of MRT stations whose free-boarding stops that service passes — in order. That pair becomes a connection: "board service 965 at stop 45009 near Admiralty, alight at stop 65009 near Buangkok."

The result is cached in memory and served as one JSON graph (`/api/mrt-connections`); the map (`/api/mrt-stations`, MRT-only — the sheet doesn't cover LRT) renders a dot per station, coloured blue if it has at least one known connection. Clicking a dot looks up that station in the graph and lists every reachable destination station with its connecting service numbers.

## Known data gaps

- LTA's `TrainStation` geospatial layer includes a handful of depot/substation footprints tagged the same as real stations (e.g. "Bishan Depot"), and a few not-yet-opened stations (e.g. "Bukit Brown"). These render as grey dots with no connections — expected, not a bug.
- A few sheet station names don't have station geometry yet (Keppel, Cantonment, Prince Edward Road — all future Circle Line stations at time of writing).
- Some bridging points don't intersect any current in-service bus route's stop sequence, so a handful of sheet stations show zero connections — the free-boarding point exists, but no ordinary bus already links it to another station's free-boarding point today.

Check server startup logs for the exact unmatched lists — they're printed once when `/api/mrt-connections` is first requested.

## Setup

```bash
npm install
```

Copy `.env.example` to `.env` and fill in `MONGODB_URI`, `MONGODB_DBNAME`, `MAPBOX_API_KEY`, `LTA_DATAMALL_KEY`, `FRONT_END_URL`, and `BRIDGING_POINTS_SHEET_ID`.

Populate the database:

```bash
npm run fetch-mrt-stations
npm run fetch-bus-routes
```

Run the app:

```bash
npm run server
```

Then open `http://localhost:3000`.

## Project structure

```text
.
├── index.js                        # Express server, bridging-sheet parsing, connection graph builder, API routes
├── configs/database.js             # MongoDB connection singleton
├── models/
│   ├── MRTStations.js              # Single-document GeoJSON FeatureCollection store
│   └── LTADatamallBusRoutes.js     # Bus route stop-sequence store
├── scripts/
│   ├── fetchLTADatamallDataset.js  # Shared paginated LTA Datamall fetcher
│   ├── fetchLTABusRoutes.js
│   └── fetchLTATrainStations.js    # Downloads + parses LTA's station shapefile (SVY21 → WGS84)
├── views/main.ejs                  # Mapbox GL map + station detail panel (all client JS inline)
└── public/css/styles.css
```

## API

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/mrt-stations` | MRT station GeoJSON (polygons), filtered to `TYP_CD_DES === 'MRT'` |
| `GET` | `/api/mrt-connections` | Station-to-station connection graph, keyed by normalized station name |

## Refreshing data

Re-run `npm run refresh-all-data` (or the two fetch scripts individually) and restart the server — the connection graph is only rebuilt once per process, on first request after startup.
