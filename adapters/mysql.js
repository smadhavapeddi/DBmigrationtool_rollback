// MySQL adapter — real connections via the `mysql2/promise` driver.
// Same uniform interface as adapters/postgres.js.

import mysql from "mysql2/promise";

export const engine = "mysql";

export async function connect(cfg) {
  const conn = cfg.uri
    ? await mysql.createConnection(cfg.uri)
    : await mysql.createConnection({
        host: cfg.host,
        port: Number(cfg.port || 3306),
        user: cfg.user,
        password: cfg.password,
        database: cfg.database,
        ssl: cfg.ssl ? { rejectUnauthorized: false } : undefined,
        connectTimeout: 15000,
      });
  return conn;
}

export async function disconnect(conn) {
  await conn.end();
}

function q(id) {
  return "`" + String(id).replace(/`/g, "``") + "`";
}

export async function listTables(conn) {
  const [rows] = await conn.query(
    `SELECT TABLE_NAME AS name FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'
     ORDER BY TABLE_NAME`
  );
  const out = [];
  for (const r of rows) {
    const [cnt] = await conn.query(`SELECT COUNT(*) AS c FROM ${q(r.name)}`);
    out.push({ name: r.name, count: Number(cnt[0].c) });
  }
  return out;
}

async function getColumns(conn, table) {
  const [rows] = await conn.query(
    `SELECT COLUMN_NAME AS column_name, COLUMN_TYPE AS column_type
     FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ?
     ORDER BY ORDINAL_POSITION`,
    [table]
  );
  return rows;
}

export async function migrateOne(sourceConn, destConn, table, onProgress) {
  const columns = await getColumns(sourceConn, table);
  if (!columns.length) throw new Error(`Table "${table}" has no columns (does it exist in the source?)`);
  const colNames = columns.map((c) => c.column_name);

  // MySQL's information_schema.COLUMN_TYPE already gives a full DDL type
  // string (e.g. "varchar(255)", "int(11)", "datetime"), so we reuse it
  // directly instead of hand-mapping types.
  const colDefs = columns.map((c) => `${q(c.column_name)} ${c.column_type}`).join(", ");
  await destConn.query(`CREATE TABLE IF NOT EXISTS ${q(table)} (${colDefs})`);

  const [cntRows] = await sourceConn.query(`SELECT COUNT(*) AS c FROM ${q(table)}`);
  const total = Number(cntRows[0].c);

  const batchSize = 500;
  let offset = 0;
  let copied = 0;

  while (true) {
    const [rows] = await sourceConn.query(
      `SELECT ${colNames.map(q).join(", ")} FROM ${q(table)} LIMIT ${batchSize} OFFSET ${offset}`
    );
    if (!rows.length) break;

    const rowPlaceholder = `(${colNames.map(() => "?").join(", ")})`;
    const placeholders = rows.map(() => rowPlaceholder).join(", ");
    const values = rows.flatMap((row) => colNames.map((c) => row[c]));

    await destConn.query(
      `INSERT INTO ${q(table)} (${colNames.map(q).join(", ")}) VALUES ${placeholders}`,
      values
    );

    copied += rows.length;
    onProgress(copied, total);
    offset += rows.length;
    if (rows.length < batchSize) break;
  }

  return { copied, total };
}
