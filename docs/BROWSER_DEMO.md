# Browser demo on Vercel

This deployment needs no Supabase, API server, database account, or application secrets.
It runs SQLite through WebAssembly in the browser, reusing the existing feature routes,
validation, calculations, and transaction rules. Records and document bytes save to
IndexedDB after each successful request. A lock coordinates tabs on the same origin.
Failed requests and failed storage writes roll back the in-memory workspace.

Each browser and origin has its own workspace. Clearing site storage removes it.
Use a current browser that supports IndexedDB and Web Locks, served over HTTPS.
Open demo access replaces sign-in; accounts and live provider connections require
the hosted backend. Equipment telemetry is a sample snapshot, not a live feed.
Use illustrative data only. This deployment does not provide team authentication,
device synchronization, server backups, or continuously running ingestion.

## Run and build

Use Node.js 24 for the build-time sample-data generator:

```sh
npm ci
npm run dev:demo
# or build and serve the static result
npm run build:demo
npm run preview --workspace=web
```

The generator creates a fresh temporary database, seeds only the built-in sample
workspace and mock telemetry, removes encrypted mock credentials, and bundles
the feature handlers with browser adapters. It never reads an existing local database.
Generated files under `web/public/demo` are ignored by Git and rebuilt on deployment.
The regular `npm run build` and backend deployment remain available.

## Existing Vercel project

1. In **Settings → Git**, connect `MantisSupportLabs/factory`.
2. Use production branch `clone-factory-ai` (the repository's default branch).
3. Set **Root Directory** to the repository root (leave blank).
4. Set **Node.js Version** to `24.x`.
5. Build command: `npm run build:demo`. Output directory: `web/dist`.
   Install command: `npm ci`. Framework: Vite. These are also in `vercel.json`.
6. Deploy the production branch. If the project requires Vercel sign-in, adjust
   **Deployment Protection** for your intended demo audience.

No Vercel environment variables are needed: the demo build command sets
`VITE_BROWSER_DEMO=true`. Connecting or attaching the project does not by itself
deploy the workspace. A Git deployment or CLI deployment must upload the new code.

The banner provides **Export demo**, **Import demo** (records and attachment bytes), and **Reset
sample data** (with confirmation). The Business export section also provides
readable tenant records; it does not include attachment bytes.
