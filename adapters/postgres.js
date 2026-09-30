// PostgreSQL adapter — real connections via the `pg` driver.
// Uniform interface: connect(cfg) -> handle, disconnect(handle),
// listTables(handle) -> [{name, count}], migrateOne(sourceHandle, destHandle, name, onProgress).

import pg from "pg";

export const engine = "postgresql";

export async function connect(cfg) {
  const client = cfg.uri
    ? new pg.Client({
        connectionString: cfg.uri,
        ssl: cfg.ssl ? { rejectUnauthorized: false } : undefined,
        connectionTimeoutMillis: 15000,
      })
    : new pg.Client({
        host: cfg.host,
        port: Number(cfg.port || 5432),
        user: cfg.user,
        password: cfg.password,
        database: cfg.database,
        ssl: cfg.ssl ? { rejectUnauthorized: false } : undefined,
        connectionTimeoutMillis: 15000,
      });
  await client.connect();
  return client;
}

export async function disconnect(client) {
  await client.end();
}

function q(id) {
  return '"' + String(id).replace(/"/g, '""') + '"';
}

export async function listTables(client) {
  const { rows } = await client.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
     ORDER BY table_name`
  );
  const out = [];
  for (const r of rows) {
    const { rows: cnt } = await client.query(`SELECT COUNT(*)::bigint AS c FROM ${q(r.table_name)}`);
    out.push({ name: r.table_name, count: Number(cnt[0].c) });
  }
  return out;
}

async function getColumns(client, table) {
  const { rows } = await client.query(
    `SELECT column_name, data_type, character_maximum_length, numeric_precision, numeric_scale
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    [table]
  );
  return rows;
}

function mapType(col) {
  switch (col.data_type) {
    case "character varying":
      return col.character_maximum_length ? `VARCHAR(${col.character_maximum_length})` : "TEXT";
    case "character":
      return col.character_maximum_length ? `CHAR(${col.character_maximum_length})` : "TEXT";
    case "text":
      return "TEXT";
    case "integer":
      return "INTEGER";
    case "bigint":
      return "BIGINT";
    case "smallint":
      return "SMALLINT";
    case "numeric":
      return col.numeric_precision
        ? `NUMERIC(${col.numeric_precision}${col.numeric_scale ? "," + col.numeric_scale : ""})`
        : "NUMERIC";
    case "boolean":
      return "BOOLEAN";
    case "timestamp without time zone":
      return "TIMESTAMP";
    case "timestamp with time zone":
      return "TIMESTAMPTZ";
    case "date":
      return "DATE";
    case "double precision":
      return "DOUBLE PRECISION";
    case "real":
      return "REAL";
    case "json":
      return "JSON";
    case "jsonb":
      return "JSONB";
    case "uuid":
      return "UUID";
    default:
      return "TEXT";
  }
}

export async function migrateOne(sourceClient, destClient, table, onProgress) {
  const columns = await getColumns(sourceClient, table);
  if (!columns.length) throw new Error(`Table "${table}" has no columns (does it exist in the source?)`);
  const colNames = columns.map((c) => c.column_name);

  const colDefs = columns.map((c) => `${q(c.column_name)} ${mapType(c)}`).join(", ");
  await destClient.query(`CREATE TABLE IF NOT EXISTS ${q(table)} (${colDefs})`);

  const { rows: cntRows } = await sourceClient.query(`SELECT COUNT(*)::bigint AS c FROM ${q(table)}`);
  const total = Number(cntRows[0].c);

  const batchSize = 500;
  let offset = 0;
  let copied = 0;

  while (true) {
    const { rows } = await sourceClient.query(
      `SELECT ${colNames.map(q).join(", ")} FROM ${q(table)} LIMIT ${batchSize} OFFSET ${offset}`
    );
    if (!rows.length) break;

    const values = [];
    const tuples = rows.map((row, i) => {
      const placeholders = colNames.map((c, j) => {
        values.push(row[c]);
        return `$${i * colNames.length + j + 1}`;
      });
      return `(${placeholders.join(", ")})`;
    });
    await destClient.query(
      `INSERT INTO ${q(table)} (${colNames.map(q).join(", ")}) VALUES ${tuples.join(", ")}`,
      values
    );

    copied += rows.length;
    onProgress(copied, total);
    offset += rows.length;
    if (rows.length < batchSize) break;
  }

  return { copied, total };
}
