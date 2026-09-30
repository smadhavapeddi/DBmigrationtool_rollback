// MongoDB adapter — real connections via the `mongodb` driver.
// Same uniform interface as adapters/postgres.js and adapters/mysql.js,
// but connect() returns { client, db } instead of a bare connection.

import { MongoClient } from "mongodb";

export const engine = "mongodb";

function buildUri(cfg) {
  const auth = cfg.user ? `${encodeURIComponent(cfg.user)}:${encodeURIComponent(cfg.password)}@` : "";
  const params = cfg.ssl ? "?tls=true" : "";
  return `mongodb://${auth}${cfg.host}:${cfg.port || 27017}/${cfg.database}${params}`;
}

export async function connect(cfg) {
  const uri = cfg.uri || buildUri(cfg);
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
  await client.connect();
  const db = client.db(cfg.database || undefined);
  return { client, db };
}

export async function disconnect(handle) {
  await handle.client.close();
}

export async function listTables(handle) {
  const cols = await handle.db.listCollections().toArray();
  const out = [];
  for (const c of cols) {
    const count = await handle.db.collection(c.name).countDocuments();
    out.push({ name: c.name, count });
  }
  return out;
}

export async function migrateOne(sourceHandle, destHandle, name, onProgress) {
  const total = await sourceHandle.db.collection(name).countDocuments();
  const cursor = sourceHandle.db.collection(name).find({});
  const batchSize = 500;
  let batch = [];
  let copied = 0;

  const flush = async () => {
    if (!batch.length) return;
    await destHandle.db.collection(name).insertMany(batch, { ordered: false });
    copied += batch.length;
    onProgress(copied, total);
    batch = [];
  };

  for await (const doc of cursor) {
    batch.push(doc);
    if (batch.length >= batchSize) await flush();
  }
  await flush();

  return { copied, total };
}
