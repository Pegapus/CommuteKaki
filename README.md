# Smart Commuter Companion App

Map of Singapore MRT stations. Click a station to see which bus services connect it — via LTA's bridging/free boarding-and-alighting points — to another MRT station.

## How it works

LTA publishes a "Bridging/Free Boarding Points of Destination Station" sheet: for each MRT station, a list of nearby bus stop codes that count as a free boarding/alighting point during a bus bridging service (e.g. an MRT disruption). It's a single list per station, not separate boarding/alighting sheets — the same stops serve as the boarding end for a trip in one direction and the alighting end in the other.

At startup the server:
1. Fetches that sheet (Google Sheets export, `BRIDGING_POINTS_SHEET_ID`) and groups its bus stop codes by MRT station.
2. Loads every LTA bus route's stop sequence (`LTADatamallBusRoutes`, fetched via `npm run fetch-bus-routes`).
3. For every bus service/direction, walks its stop sequence and finds every pair of MRT stations whose free-boarding stops that service passes — in order. That pair becomes a connection: "board service 965 at stop 45009 near Admiralty, alight at stop 65009 near Buangkok."

The result is cached in memory and served as one JSON graph (`/api/mrt-connections`); the map (`/api/mrt-stations`, MRT-only — the sheet doesn't cover LRT) renders a dot per station, coloured blue if it has at least one known connection. Clicking a dot lists the station's free-boarding points one by one, each labelled with its bus stop code and name (e.g. "Boarding point 45009 Admiralty Stn"); under each boarding point it lists every reachable destination station, with the connecting service numbers and how many stops that service takes between the boarding point and the alighting point near the destination station.

The MRT stations layer can be toggled on/off from the "Layers" panel (bottom-right of the map). Standard Mapbox zoom in/out and "find my location" controls sit at the top-right of the map.

Bus stops are never shown on their own — there's no "show all bus stops" layer. They only appear while a bus route is drawn (see below), and only the stops that specific service/direction actually calls at, clickable for the stop's code/description.

The search bar at the top of the panel matches as you type against both MRT station names (`/api/mrt-stations`) and bus service numbers (`/api/bus-services`, one result per direction — e.g. searching "159" offers "159 Sengkang Int → Toa Payoh Int" and "159 Toa Payoh Int → Sengkang Int" separately). Picking a station result does the same thing as clicking its dot (flies to it, opens its boarding points); picking a bus service result draws that specific direction's route, same as clicking a service chip.

Clicking a service number chip draws that bus service's route (in that specific direction) on the map — the full road-aligned path, a red dot for each bus stop that direction actually calls at, and a green "S"/red "E" marker for the route's start/end terminus, with a banner reading e.g. "Bus Service 159, Sengkang Int → Toa Payoh Int" (the terminus names are the first/last stop's full `Description`, unmodified). Nothing is pre-computed: the first time a service/direction is clicked, the server (`GET /api/route-geometry`) snaps each of its stops to the road network via the Mapbox Map Matching API, then routes between the snapped points via the Mapbox Directions API, and returns the resulting line plus the ordered stop list — ported from Bus-Routing-Visualisation-Project's `generateRouteGeometriesMAPBOX.js`, but run live per request instead of as a batch job. The result is cached in memory (server-side, and again client-side) so re-clicking the same service/direction is instant; a failed lookup (unknown service, or Mapbox error) shows the error inline instead of drawing nothing. Clearing the route (the banner's ×) removes the line and its stops together.

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
npm run fetch-bus-stops
npm run fetch-bus-services
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
│   ├── LTADatamallBusRoutes.js     # Bus route stop-sequence store
│   ├── LTADatamallBusStops.js      # Bus stop code/location/description store
│   └── LTADatamallBusServices.js   # Bus service/operator/routing info store
├── scripts/
│   ├── fetchLTADatamallDataset.js  # Shared paginated LTA Datamall fetcher
│   ├── fetchLTABusRoutes.js
│   ├── fetchLTABusStops.js
│   ├── fetchLTABusServices.js
│   └── fetchLTATrainStations.js    # Downloads + parses LTA's station shapefile (SVY21 → WGS84)
├── views/main.ejs                  # Mapbox GL map + station detail panel (all client JS inline)
└── public/css/styles.css
```

## API

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/mrt-stations` | MRT station GeoJSON (polygons), filtered to `TYP_CD_DES === 'MRT'` |
| `GET` | `/api/mrt-connections` | Station-to-station connection graph, keyed by normalized station name |
| `GET` | `/api/bus-stops` | All LTA bus stops (code, location, description, road name) — used to label search results, not rendered as a map layer |
| `GET` | `/api/bus-services` | All LTA bus services (service no., direction, operator, routing info) |
| `GET` | `/api/route-geometry?serviceNo=&direction=` | Computes (or returns the cached) `{ coordinates, startName, endName, stops }` for one service/direction, live via Mapbox — `stops` is the ordered list of bus stops that direction calls at |

## Refreshing data

Re-run `npm run refresh-all-data` (or the two fetch scripts individually) and restart the server — the connection graph is only rebuilt once per process, on first request after startup.
