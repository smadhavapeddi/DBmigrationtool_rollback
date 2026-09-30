function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Small renderer for "## Heading" + fenced code block text, matching the
// .output h2 / .output pre styles already defined in style.css.
function renderPlanText(text) {
  const lines = text.split("\n");
  let html = "";
  let inCode = false;
  let codeBuf = [];
  const flushCode = () => {
    if (codeBuf.length) {
      html += `<pre><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`;
      codeBuf = [];
    }
  };
  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      inCode ? (flushCode(), (inCode = false)) : (inCode = true);
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      continue;
    }
    if (line.trim().startsWith("## ")) html += `<h2>${escapeHtml(line.trim().slice(3))}</h2>`;
    else if (line.trim()) html += `<p>${escapeHtml(line)}</p>`;
  }
  flushCode();
  return html || escapeHtml(text);
}

// ---------- Step 1: AI plan ----------

async function loadConfig() {
  try {
    const res = await fetch("/api/config");
    const cfg = await res.json();
    document.getElementById("endpoint-badge").textContent = `${cfg.baseUrl}  ·  text: ${cfg.textModel}`;
  } catch {
    document.getElementById("endpoint-badge").textContent = "Could not load endpoint config.";
  }
}

async function loadTargetEngines() {
  const select = document.getElementById("plan-target-engine");
  try {
    const res = await fetch("/api/target-engines");
    const { engines } = await res.json();
    select.innerHTML = "";
    engines.forEach((engine) => {
      const opt = document.createElement("option");
      opt.value = engine;
      opt.textContent = engine;
      if (engine === "PostgreSQL") opt.selected = true;
      select.appendChild(opt);
    });
  } catch {
    select.innerHTML = '<option value="PostgreSQL">PostgreSQL</option>';
  }
}

const planBtn = document.getElementById("plan-btn");
const planOutput = document.getElementById("plan-output");
const planMeta = document.getElementById("plan-meta");

planBtn.addEventListener("click", async () => {
  const sourceEngine = document.getElementById("plan-source-engine").value;
  const schema = document.getElementById("plan-schema").value.trim();
  const targetEngine = document.getElementById("plan-target-engine").value;
  const clusterName = document.getElementById("cluster-name").value.trim();
  const region = document.getElementById("region").value.trim();
  const nodeSize = document.getElementById("node-size").value.trim();

  if (!schema) {
    planOutput.textContent = "Paste a source schema or data description first.";
    return;
  }
  planBtn.disabled = true;
  planOutput.textContent = "Calling /v1/chat/completions…";
  planMeta.textContent = "";
  try {
    const res = await fetch("/api/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceEngine, schema, targetEngine, clusterName, region, nodeSize }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    if (!data.text) throw new Error("Server returned an empty response.");
    planOutput.innerHTML = renderPlanText(data.text);
    planMeta.textContent = `model: ${data.model} · endpoint: ${data.endpoint} · tokens: ${data.usage?.total_tokens ?? "n/a"}`;
  } catch (err) {
    planOutput.textContent = `Error: ${err.message}`;
  } finally {
    planBtn.disabled = false;
  }
});

// ---------- Step 2: live migration ----------

function readConnConfig(prefix) {
  return {
    engine: document.getElementById(`${prefix}-engine`).value,
    host: document.getElementById(`${prefix}-host`).value.trim(),
    port: document.getElementById(`${prefix}-port`).value.trim(),
    ssl: document.getElementById(`${prefix}-ssl`).value === "true",
    user: document.getElementById(`${prefix}-user`).value.trim(),
    password: document.getElementById(`${prefix}-password`).value,
    database: document.getElementById(`${prefix}-database`).value.trim(),
    uri: document.getElementById(`${prefix}-uri`).value.trim() || undefined,
  };
}

const testBtn = document.getElementById("test-btn");
const testOutput = document.getElementById("test-output");
const tablePicker = document.getElementById("table-picker");
const tableList = document.getElementById("table-list");
const runBtn = document.getElementById("run-btn");
const runLog = document.getElementById("run-log");

testBtn.addEventListener("click", async () => {
  const source = readConnConfig("src");
  const destination = readConnConfig("dst");

  if (source.engine !== destination.engine) {
    testOutput.textContent = `Source (${source.engine}) and destination (${destination.engine}) must be the same engine for live migration.`;
    tablePicker.hidden = true;
    return;
  }

  testBtn.disabled = true;
  testOutput.textContent = "Testing both connections…";
  tablePicker.hidden = true;

  try {
    const [srcRes, dstRes] = await Promise.all([
      fetch("/api/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(source),
      }).then((r) => r.json()),
      fetch("/api/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(destination),
      }).then((r) => r.json()),
    ]);

    const lines = [];
    lines.push(srcRes.ok ? `✔ Source connected — found ${srcRes.tables.length} table(s)/collection(s).` : `✘ Source failed: ${srcRes.error}`);
    if (!srcRes.ok && srcRes.hint) lines.push(`  → ${srcRes.hint}`);
    lines.push(dstRes.ok ? `✔ Destination connected — found ${dstRes.tables.length} table(s)/collection(s).` : `✘ Destination failed: ${dstRes.error}`);
    if (!dstRes.ok && dstRes.hint) lines.push(`  → ${dstRes.hint}`);
    testOutput.textContent = lines.join("\n");

    if (srcRes.ok && dstRes.ok) {
      renderTablePicker(srcRes.tables);
      tablePicker.hidden = false;
    }
  } catch (err) {
    testOutput.textContent = `Error: ${err.message}`;
  } finally {
    testBtn.disabled = false;
  }
});

function renderTablePicker(tables) {
  tableList.innerHTML = "";
  tables.forEach((t) => {
    const row = document.createElement("div");
    row.className = "table-row";
    row.innerHTML = `
      <input type="checkbox" class="table-check" value="${t.name}" checked />
      <span>${t.name}</span>
      <span class="count">${t.count} row(s)</span>
      <div class="progress-bar" data-table="${t.name}"><div></div></div>
    `;
    tableList.appendChild(row);
  });
}

function appendLog(html) {
  runLog.hidden = false;
  const line = document.createElement("div");
  line.innerHTML = html;
  runLog.appendChild(line);
  runLog.scrollTop = runLog.scrollHeight;
}

function setProgress(table, copied, total) {
  const bar = tableList.querySelector(`.progress-bar[data-table="${CSS.escape(table)}"] > div`);
  if (bar && total > 0) bar.style.width = `${Math.min(100, Math.round((copied / total) * 100))}%`;
}

runBtn.addEventListener("click", async () => {
  const selected = Array.from(document.querySelectorAll(".table-check:checked")).map((el) => el.value);
  if (!selected.length) {
    appendLog(`<span class="log-error">Select at least one table/collection first.</span>`);
    return;
  }

  const source = readConnConfig("src");
  const destination = readConnConfig("dst");

  runLog.innerHTML = "";
  runLog.hidden = false;
  runBtn.disabled = true;
  appendLog("Starting migration…");

  try {
    const res = await fetch("/api/migrate-run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source, destination, tables: selected }),
    });

    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Request failed with status ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop(); // keep the last, possibly-incomplete line
      for (const line of lines) {
        if (!line.trim()) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.type === "log") appendLog(escapeHtml(event.message));
        else if (event.type === "progress") {
          setProgress(event.table, event.copied, event.total);
        } else if (event.type === "error") {
          appendLog(`<span class="log-error">✘ ${escapeHtml(event.table)}: ${escapeHtml(event.message)}</span>`);
        } else if (event.type === "fatal") {
          appendLog(`<span class="log-error">✘ Fatal: ${escapeHtml(event.message)}</span>`);
        } else if (event.type === "done") {
          appendLog(`<span class="log-done">✔ ${escapeHtml(event.message)}</span>`);
        }
      }
    }
  } catch (err) {
    appendLog(`<span class="log-error">Error: ${escapeHtml(err.message)}</span>`);
  } finally {
    runBtn.disabled = false;
  }
});

// ---------- Dump, restore & rollback plan (client-side only, no credentials sent) ----------

const DEFAULT_PORTS = { postgresql: "5432", mysql: "3306", mongodb: "27017" };
const DEFAULT_DEST_PORT = "25060"; // typical DigitalOcean Managed Database port

function fieldOrPlaceholder(value, placeholder) {
  return value && value.trim() ? value.trim() : placeholder;
}

function connSummary(cfg, isDest, engine) {
  if (cfg.uri) {
    return {
      host: "<from-your-connection-URI>",
      port: "<from-your-connection-URI>",
      user: "<from-your-connection-URI>",
      database: "<from-your-connection-URI>",
      usedUri: true,
    };
  }
  return {
    host: fieldOrPlaceholder(cfg.host, "<host>"),
    port: fieldOrPlaceholder(cfg.port, isDest ? DEFAULT_DEST_PORT : DEFAULT_PORTS[engine]),
    user: fieldOrPlaceholder(cfg.user, isDest ? "doadmin" : "<user>"),
    database: fieldOrPlaceholder(cfg.database, isDest ? "defaultdb" : "<database>"),
    usedUri: false,
  };
}

function buildPostgresPlan(src, dst, destHasData) {
  const s = connSummary(src, false, "postgresql");
  const d = connSummary(dst, true, "postgresql");
  const uriNote = s.usedUri || d.usedUri
    ? "\nYou entered a connection URI directly for one or both sides — swap the placeholders below for the host/port/user/database from that URI (skip re-typing the password into these commands).\n"
    : "";

  const restoreFlags = destHasData
    ? "--no-owner --no-privileges"
    : "--no-owner --no-privileges --clean --if-exists";

  return `## Step 0 — Safety Backup of the Destination
Recommended even if you believe the destination is empty — it's cheap insurance.
${uriNote}
\`\`\`bash
pg_dump -h ${d.host} -p ${d.port} -U ${d.user} -d ${d.database} \\
  --format=custom --file=pre_migration_backup_$(date +%Y%m%d_%H%M%S).dump
# you'll be prompted for the destination password
\`\`\`

## Step 1 — Dump the Source
\`\`\`bash
pg_dump -h ${s.host} -p ${s.port} -U ${s.user} -d ${s.database} \\
  --format=custom --file=source_dump.dump
# you'll be prompted for the source password
\`\`\`

## Step 2 — Restore Into the Destination
\`\`\`bash
pg_restore -h ${d.host} -p ${d.port} -U ${d.user} -d ${d.database} \\
  ${restoreFlags} source_dump.dump
# you'll be prompted for the destination password
\`\`\`
${destHasData ? "The destination already has data, so `--clean` was left out — target a specific schema/table with `-n`/`-t` if you only want to restore part of the dump, to avoid touching unrelated existing objects." : "`--clean --if-exists` makes this safely re-runnable since the destination started empty."}

## Step 3 — Verify
\`\`\`bash
psql "host=${d.host} port=${d.port} user=${d.user} dbname=${d.database} sslmode=require" -c "\\dt"
psql "host=${d.host} port=${d.port} user=${d.user} dbname=${d.database} sslmode=require" -c "SELECT COUNT(*) FROM <table_name>;"
\`\`\`
Compare each table's row count against the same query run on the source.

## Rollback
${destHasData
  ? `Restore the destination from the Step 0 backup, which reverts it to its pre-migration state:
\`\`\`bash
pg_restore -h ${d.host} -p ${d.port} -U ${d.user} -d ${d.database} \\
  --clean --if-exists --no-owner --no-privileges pre_migration_backup_<TIMESTAMP>.dump
\`\`\``
  : `Since the destination was empty, roll back by dropping what was just migrated:
\`\`\`bash
psql "host=${d.host} port=${d.port} user=${d.user} dbname=${d.database} sslmode=require" \\
  -c "DROP TABLE IF EXISTS <table1>, <table2> CASCADE;"
\`\`\`
Or, to fully reset the database:
\`\`\`bash
dropdb -h ${d.host} -p ${d.port} -U ${d.user} ${d.database} --if-exists
createdb -h ${d.host} -p ${d.port} -U ${d.user} ${d.database}
\`\`\``}
Keep the source untouched and live until you've verified the destination — don't cut traffic over until Step 3 checks out.`;
}

function buildMysqlPlan(src, dst, destHasData) {
  const s = connSummary(src, false, "mysql");
  const d = connSummary(dst, true, "mysql");
  const uriNote = s.usedUri || d.usedUri
    ? "\nYou entered a connection URI directly for one or both sides — swap the placeholders below for the host/port/user/database from that URI.\n"
    : "";

  return `## Step 0 — Safety Backup of the Destination
Recommended even if you believe the destination is empty — it's cheap insurance.
${uriNote}
\`\`\`bash
mysqldump -h ${d.host} -P ${d.port} -u ${d.user} -p --ssl-mode=REQUIRED \\
  --single-transaction --routines --triggers \\
  ${d.database} > pre_migration_backup_$(date +%Y%m%d_%H%M%S).sql
# you'll be prompted for the destination password
\`\`\`

## Step 1 — Dump the Source
\`\`\`bash
mysqldump -h ${s.host} -P ${s.port} -u ${s.user} -p \\
  --single-transaction --routines --triggers --set-gtid-purged=OFF \\
  ${s.database} > source_dump.sql
# you'll be prompted for the source password
\`\`\`

## Step 2 — Restore Into the Destination
\`\`\`bash
mysql -h ${d.host} -P ${d.port} -u ${d.user} -p --ssl-mode=REQUIRED ${d.database} < source_dump.sql
# you'll be prompted for the destination password
\`\`\`
${destHasData ? "The destination already has data — review `source_dump.sql` for `DROP TABLE`/`CREATE TABLE` statements that could clobber existing tables with the same names before running this." : ""}

## Step 3 — Verify
\`\`\`bash
mysql -h ${d.host} -P ${d.port} -u ${d.user} -p --ssl-mode=REQUIRED ${d.database} \\
  -e "SHOW TABLES; SELECT COUNT(*) FROM <table_name>;"
\`\`\`
Compare each table's row count against the same query run on the source.

## Rollback
${destHasData
  ? `Restore the destination from the Step 0 backup, which reverts it to its pre-migration state:
\`\`\`bash
mysql -h ${d.host} -P ${d.port} -u ${d.user} -p --ssl-mode=REQUIRED ${d.database} < pre_migration_backup_<TIMESTAMP>.sql
\`\`\``
  : `Since the destination was empty, roll back by dropping what was just migrated:
\`\`\`bash
mysql -h ${d.host} -P ${d.port} -u ${d.user} -p --ssl-mode=REQUIRED ${d.database} \\
  -e "DROP TABLE IF EXISTS <table1>, <table2>;"
\`\`\``}
Keep the source untouched and live until you've verified the destination — don't cut traffic over until Step 3 checks out.`;
}

function buildMongoPlan(src, dst, destHasData) {
  const s = connSummary(src, false, "mongodb");
  const d = connSummary(dst, true, "mongodb");
  const uriNote = s.usedUri || d.usedUri
    ? "\nYou entered a connection URI directly for one or both sides — use that URI with --uri= instead of the discrete flags below.\n"
    : "";

  return `## Step 0 — Safety Backup of the Destination
Recommended even if you believe the destination is empty — it's cheap insurance.
${uriNote}
\`\`\`bash
mongodump --host=${d.host} --port=${d.port} --username=${d.user} --authenticationDatabase=admin --ssl \\
  --db=${d.database} --out=pre_migration_backup_$(date +%Y%m%d_%H%M%S)
# you'll be prompted for the destination password
\`\`\`

## Step 1 — Dump the Source
\`\`\`bash
mongodump --host=${s.host} --port=${s.port} --username=${s.user} --db=${s.database} --out=source_dump
# you'll be prompted for the source password
\`\`\`

## Step 2 — Restore Into the Destination
\`\`\`bash
mongorestore --host=${d.host} --port=${d.port} --username=${d.user} --authenticationDatabase=admin --ssl \\
  --nsFrom="${s.database}.*" --nsTo="${d.database}.*" source_dump
# you'll be prompted for the destination password
\`\`\`

## Step 3 — Verify
\`\`\`bash
mongosh --host=${d.host} --port=${d.port} -u ${d.user} --authenticationDatabase=admin --tls \\
  --eval "db.getSiblingDB('${d.database}').getCollectionNames().forEach(c => print(c, db.getSiblingDB('${d.database}').getCollection(c).countDocuments()))"
\`\`\`
Compare each collection's document count against the same command run on the source.

## Rollback
${destHasData
  ? `Restore the destination from the Step 0 backup, which reverts it to its pre-migration state:
\`\`\`bash
mongorestore --host=${d.host} --port=${d.port} --username=${d.user} --authenticationDatabase=admin --ssl \\
  --drop pre_migration_backup_<TIMESTAMP>/${d.database}
\`\`\``
  : `Since the destination was empty, roll back by dropping what was just migrated:
\`\`\`bash
mongosh --host=${d.host} --port=${d.port} -u ${d.user} --authenticationDatabase=admin --tls \\
  --eval "db.getSiblingDB('${d.database}').getCollection('<collection_name>').drop()"
\`\`\``}
Keep the source untouched and live until you've verified the destination — don't cut traffic over until Step 3 checks out.`;
}

const dumpPlanBtn = document.getElementById("dump-plan-btn");
const dumpPlanOutput = document.getElementById("dump-plan-output");

dumpPlanBtn.addEventListener("click", () => {
  const src = readConnConfig("src");
  const dst = readConnConfig("dst");
  const destHasData = document.querySelector('input[name="dest-state"]:checked').value === "has-data";

  if (src.engine !== dst.engine) {
    dumpPlanOutput.textContent = `Source (${src.engine}) and destination (${dst.engine}) must be the same engine to generate matching dump/restore commands.`;
    return;
  }

  let plan;
  if (src.engine === "postgresql") plan = buildPostgresPlan(src, dst, destHasData);
  else if (src.engine === "mysql") plan = buildMysqlPlan(src, dst, destHasData);
  else plan = buildMongoPlan(src, dst, destHasData);

  dumpPlanOutput.innerHTML = renderPlanText(plan);
});

loadConfig();
loadTargetEngines();
