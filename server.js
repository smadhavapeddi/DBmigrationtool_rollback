// DigitalOcean Managed Database — Live Migration Tool.
//
// Two capabilities:
//   1. AI migration plan — DO Serverless Inference (text-to-text /v1/chat/completions)
//      generates a plan, commands, cutover/validation, and rollback notes.
//   2. Real live migration — actually connects to a source database and a
//      destination (a DigitalOcean Managed Database) and copies schema + data,
//      streaming progress to the UI. Supports PostgreSQL, MySQL, and MongoDB,
//      same engine on both sides (see adapters/).

import "dotenv/config";
import express from "express";
import OpenAI from "openai";
import * as pgAdapter from "./adapters/postgres.js";
import * as mysqlAdapter from "./adapters/mysql.js";
import * as mongoAdapter from "./adapters/mongo.js";

const MODEL_ACCESS_KEY = process.env.MODEL_ACCESS_KEY;
const TEXT_MODEL = process.env.TEXT_MODEL || "deepseek-4-flash";
const PORT = process.env.PORT || 8080;
const BASE_URL = "https://inference.do-ai.run/v1";

if (!MODEL_ACCESS_KEY) {
  console.error(
    "Missing MODEL_ACCESS_KEY. Copy .env.example to .env and add your key.\n" +
      "Docs: https://docs.digitalocean.com/products/inference/how-to/manage-model-access-keys/"
  );
  process.exit(1);
}

const client = new OpenAI({ baseURL: BASE_URL, apiKey: MODEL_ACCESS_KEY });
const adapters = { postgresql: pgAdapter, mysql: mysqlAdapter, mongodb: mongoAdapter };

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static("public"));

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.get("/api/config", (_req, res) => {
  res.json({ baseUrl: BASE_URL, textModel: TEXT_MODEL });
});

// All engines DigitalOcean Managed Databases supports (for the AI plan step).
const ALL_TARGET_ENGINES = ["PostgreSQL", "MySQL", "MongoDB", "Kafka", "Valkey (Redis-compatible)", "OpenSearch"];

app.get("/api/target-engines", (_req, res) => res.json({ engines: ALL_TARGET_ENGINES }));

// ---------------------------------------------------------------------------
// Step 1: AI-generated migration plan (text-to-text endpoint)
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a senior database engineer specializing in migrating databases INTO
DigitalOcean Managed Databases. You know these DigitalOcean-specific facts and must apply them:

- Supported target engines: PostgreSQL, MySQL, MongoDB, Kafka, Valkey (Redis-compatible), OpenSearch.
- Every cluster requires TLS/SSL for connections (sslmode=require for Postgres/MySQL-style clients);
  there is no unencrypted connection option.
- Default credentials pattern: user "doadmin", default database "defaultdb" (Postgres/MySQL), unless
  the user says otherwise.
- Clusters are deployed inside a VPC; the "Trusted Sources" firewall setting must allow the
  migrating host/app before it can connect.
- Automated daily backups with point-in-time recovery exist once data lands, but that does not
  replace a pre-cutover backup of the source.

Given a source engine, source schema/data description, target DO Managed Database engine, and
optional cluster details (name, region, node size), produce exactly these sections:

1. "## Migration Plan" — a short numbered plan (4-8 steps) covering pre-checks, schema migration,
   data load approach (dump/restore, CDC, or engine-native tool), cutover, and validation.
2. "## Commands" — one fenced code block (bash) with concrete example commands using the right
   native tool for the engines involved (pg_dump/pg_restore + psql, mysqldump/mysql, mongodump/
   mongorestore, kafka MirrorMaker/console tools, redis-cli/valkey-cli, etc.), including
   sslmode=require or --ssl flags and doadmin/defaultdb placeholders where relevant.
3. "## Cutover & Validation" — 2-4 sentences on how to confirm the migration succeeded (row counts,
   checksums, smoke queries) and how to cut traffic over with minimal downtime.
4. "## Rollback" — how to revert if something goes wrong (keep source live until validated, snapshot
   before destructive steps, etc.).

Be concise and concrete. Do not add commentary outside those four sections.`;

app.post("/api/plan", async (req, res) => {
  const sourceEngine = (req.body?.sourceEngine || "").trim();
  const schema = (req.body?.schema || "").trim();
  const targetEngine = (req.body?.targetEngine || "").trim();
  const clusterName = (req.body?.clusterName || "").trim();
  const region = (req.body?.region || "").trim();
  const nodeSize = (req.body?.nodeSize || "").trim();

  if (!schema) return res.status(400).json({ error: "schema/data description is required" });
  if (!sourceEngine || !targetEngine) {
    return res.status(400).json({ error: "sourceEngine and targetEngine are required" });
  }

  const clusterDetails = [
    clusterName ? `Cluster name: ${clusterName}` : null,
    region ? `Region: ${region}` : null,
    nodeSize ? `Node size: ${nodeSize}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const userPrompt = [
    `Source engine: ${sourceEngine}`,
    `Target: DigitalOcean Managed Database — ${targetEngine}`,
    clusterDetails || `Cluster details: not specified — use placeholder values.`,
    ``,
    `Source schema / data description:`,
    "```",
    schema,
    "```",
  ].join("\n");

  try {
    const completion = await client.chat.completions.create({
      model: TEXT_MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      max_completion_tokens: 1500,
      temperature: 0.3,
    });
    const choice = completion.choices?.[0];
    const content = choice?.message?.content;

    if (!content) {
      console.error("plan: empty completion", { finish_reason: choice?.finish_reason, usage: completion.usage });
      return res.status(502).json({
        error: `Model returned no text (finish_reason: ${choice?.finish_reason ?? "unknown"}). Try again.`,
      });
    }

    res.json({
      text: content,
      model: completion.model,
      usage: completion.usage,
      endpoint: `${BASE_URL}/chat/completions`,
    });
  } catch (err) {
    console.error("plan error:", err.message || err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

// ---------------------------------------------------------------------------
// Step 2: Real live migration — test connections, then run
// ---------------------------------------------------------------------------

// Heuristic hints for common causes of "timeout expired" when this app itself
// runs on App Platform: DO Managed Database Trusted Sources firewalls, and
// private-vs-public hostnames that only resolve/route inside a specific VPC.
function connectionHint(cfg, err) {
  const msg = (err.message || String(err)).toLowerCase();
  const host = (cfg.host || cfg.uri || "").toLowerCase();
  const looksLikeDoManagedDb = host.includes("ondigitalocean.com") || host.includes("db.ondigitalocean.com");
  const isTimeout = msg.includes("timeout");

  if (isTimeout && looksLikeDoManagedDb) {
    return (
      "This looks like a DigitalOcean Managed Database host. A silent timeout (not a fast " +
      "\"connection refused\") from App Platform usually means the connecting app isn't allowed " +
      "in yet: check the cluster's Settings → Trusted Sources and add this App Platform app, " +
      "or confirm you're using the public hostname if the app isn't in the same VPC as a " +
      "private-hostname cluster."
    );
  }
  if (isTimeout) {
    return (
      "A silent timeout (as opposed to a quick refusal) usually means a firewall or network " +
      "path is dropping the connection rather than rejecting it — check the source database's " +
      "firewall/security group allows connections from wherever this app is running, and that " +
      "the host/port are correct."
    );
  }
  return null;
}

app.post("/api/test-connection", async (req, res) => {
  const { engine, ...cfg } = req.body || {};
  const adapter = adapters[engine];
  if (!adapter) return res.status(400).json({ error: `Unsupported live engine: ${engine}` });

  let handle;
  try {
    handle = await adapter.connect(cfg);
    const tables = await adapter.listTables(handle);
    res.json({ ok: true, tables });
  } catch (err) {
    res.json({ ok: false, error: err.message || String(err), hint: connectionHint(cfg, err) });
  } finally {
    if (handle) {
      try {
        await adapter.disconnect(handle);
      } catch {
        /* ignore */
      }
    }
  }
});

// Streams newline-delimited JSON progress events as the migration runs.
// Credentials travel only in the POST body (never in a URL/query string) and
// are held in memory for the duration of this request only.
app.post("/api/migrate-run", async (req, res) => {
  const { source, destination, tables } = req.body || {};

  if (!source?.engine || !destination?.engine) {
    return res.status(400).json({ error: "source.engine and destination.engine are required" });
  }
  if (source.engine !== destination.engine) {
    return res.status(400).json({
      error: `Live execution requires the same engine on both sides (got ${source.engine} → ${destination.engine}).`,
    });
  }
  const adapter = adapters[source.engine];
  if (!adapter) return res.status(400).json({ error: `Unsupported live engine: ${source.engine}` });
  if (!Array.isArray(tables) || !tables.length) {
    return res.status(400).json({ error: "select at least one table/collection to migrate" });
  }

  res.writeHead(200, {
    "Content-Type": "application/x-ndjson",
    "Transfer-Encoding": "chunked",
    "Cache-Control": "no-cache",
  });
  const emit = (event) => res.write(JSON.stringify(event) + "\n");

  let sourceHandle, destHandle;
  try {
    emit({ type: "log", message: "Connecting to source…" });
    sourceHandle = await adapter.connect(source);
    emit({ type: "log", message: "Connected to source." });

    emit({ type: "log", message: "Connecting to destination (DigitalOcean Managed Database)…" });
    destHandle = await adapter.connect(destination);
    emit({ type: "log", message: "Connected to destination." });

    let totalCopied = 0;
    for (const table of tables) {
      emit({ type: "log", message: `Migrating "${table}"…` });
      try {
        const result = await adapter.migrateOne(sourceHandle, destHandle, table, (copied, total) => {
          emit({ type: "progress", table, copied, total });
        });
        totalCopied += result.copied;
        emit({ type: "log", message: `Finished "${table}": ${result.copied}/${result.total} rows/documents.` });
      } catch (err) {
        emit({ type: "error", table, message: err.message || String(err) });
      }
    }
    emit({
      type: "done",
      message: `Migration complete. ${totalCopied} row(s)/document(s) copied across ${tables.length} table(s)/collection(s).`,
    });
  } catch (err) {
    emit({ type: "fatal", message: err.message || String(err) });
  } finally {
    if (sourceHandle) {
      try {
        await adapter.disconnect(sourceHandle);
      } catch {
        /* ignore */
      }
    }
    if (destHandle) {
      try {
        await adapter.disconnect(destHandle);
      } catch {
        /* ignore */
      }
    }
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`DO Managed Database Live Migration Tool listening on :${PORT}`);
  console.log(`Text model: ${TEXT_MODEL} | Base: ${BASE_URL}`);
});
