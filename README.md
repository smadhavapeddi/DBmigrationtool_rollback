# DigitalOcean Managed Database — Live Migration Tool

A web app with three steps:

1. **AI migration plan** — describe your source database, pick a DigitalOcean Managed
   Database target engine, and get a plan, commands, cutover/validation steps, and rollback
   notes from DigitalOcean Serverless Inference (`/v1/chat/completions`).
2. **Live migration** — actually connect to a real source database and a real destination
   (a DigitalOcean Managed Database), pick which tables/collections to copy, and run the
   migration with a live progress log in the browser.
3. **Dump, restore & rollback plan** — generates the engine-native `pg_dump`/`pg_restore`
   commands (PostgreSQL) or `mysqldump`/`mysql` commands (MySQL) — plus `mongodump`/
   `mongorestore` for MongoDB — from the connection details you entered, along with a rollback
   path depending on whether the destination already had data.

## Supported live engines

PostgreSQL, MySQL, and MongoDB — **source and destination must use the same engine** (e.g.
Postgres → DO Managed PostgreSQL). Cross-engine conversions (e.g. MySQL → DO PostgreSQL) are
covered by the AI plan step only; apply that plan manually with your own tooling.

DigitalOcean Managed Databases also support Kafka, Valkey (Redis-compatible), and OpenSearch —
those show up as AI-plan targets but aren't wired up for live execution or dump/restore
generation in this tool.

## What the live migration actually does

- **PostgreSQL / MySQL**: reads the source table list and column definitions from
  `information_schema`, creates matching tables in the destination (`CREATE TABLE IF NOT
  EXISTS`), and copies rows in batches of 500 via `SELECT ... LIMIT/OFFSET` + batched `INSERT`.
- **MongoDB**: lists source collections, and copies documents in batches of 500 via
  `find()` + `insertMany()`.
- Progress streams to the browser as newline-delimited JSON (NDJSON) over a chunked HTTP
  response — no external job queue needed for a single migration run.

This is a straightforward lift-and-shift for small/medium tables — it does **not** handle
indexes, constraints, foreign keys, sequences/auto-increment continuation, incremental sync,
or very large tables efficiently. For a heavier migration, use the Step 3 dump/restore
commands instead (they preserve indexes, constraints, etc. via the engine's own tooling).

## Security notes

- Credentials are sent once from the browser to this app's own backend (POST body only —
  never in a URL/query string) and held in memory only for the duration of that one request.
  Nothing is written to disk or logged.
- The dump/restore commands in Step 3 never embed a password — each one prompts for it
  interactively.
- Run this locally or behind HTTPS (App Platform provides HTTPS automatically) since
  credentials do travel over the network to reach this server.
- Always test against a non-production destination first, and keep the source live/untouched
  until you've validated the destination.
- DigitalOcean Managed Database clusters require TLS for every connection and only accept
  connections from hosts allowed under **Trusted Sources** in the cluster's firewall settings —
  make sure wherever you run this tool is allowed in first.

## Troubleshooting connection timeouts

If a connection fails with `timeout expired` / `ETIMEDOUT` (as opposed to a fast
`ECONNREFUSED` or a DNS-lookup failure), the packets aren't getting a response at all — that's
almost always a network path or firewall problem, not a bad password:

- **Destination (DO Managed Database)**: add this app to the cluster's **Settings → Trusted
  Sources**, and make sure you're using the right hostname (public vs. private/VPC-only) for
  where this app runs.
- **Source**: confirm it's actually reachable from the public internet (or from wherever this
  app runs) — a database on a private network, on-prem, or `localhost` won't be reachable from
  an app running elsewhere. Check the source's own firewall/security group too.

The app surfaces a `hint` in the UI for timeouts against DO-looking hostnames to point at the
Trusted Sources setting specifically.

## What's inside

- `adapters/postgres.js`, `adapters/mysql.js`, `adapters/mongo.js` — a uniform
  `connect / disconnect / listTables / migrateOne` interface per engine
- `server.js` — Express server: `/api/plan` (AI plan via Serverless Inference),
  `/api/test-connection` (real connection test + table/collection listing),
  `/api/migrate-run` (real migration, streamed as NDJSON)
- `public/` — static frontend: AI plan form, source/destination connection forms, table
  picker with per-table progress bars, a live log panel, and the dump/restore/rollback
  plan generator

## Run locally

```bash
cd do-managed-db-live-migration-tool
npm install
cp .env.example .env
# edit .env and set MODEL_ACCESS_KEY to your DO Serverless Inference key
npm start
```

Open http://localhost:8080.

## Environment variables

| Variable | Description |
|---|---|
| `MODEL_ACCESS_KEY` | Your DO Serverless Inference Model Access Key (for Step 1 only) |
| `TEXT_MODEL` | Chat model slug, e.g. `llama3.3-70b-instruct` |
| `PORT` | Port to listen on (default `8080`) |

## Deploy to App Platform

1. Push this folder to a GitHub repo.
2. Update the `github.repo` field in `.do/app.yaml` to point at that repo.
3. Create the app, then set the real `MODEL_ACCESS_KEY` secret (don't commit it):
   ```bash
   doctl apps create --spec .do/app.yaml
   doctl apps update <app-id> --spec .do/app.yaml
   ```
4. Make sure the App Platform egress can reach both your source database and your
   destination Managed Database cluster (add it to Trusted Sources on the DO side).
