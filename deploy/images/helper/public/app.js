// Browser side of the helper. Holds no secret: the passphrase and token live in a password field until submit, are
// cleared immediately, and are never written to storage, the URL or the page. Text from the server goes in with textContent only.
const $ = (id) => document.getElementById(id);
const post = (url, body) =>
  fetch(url, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-fedlify-helper": "1" }, body: JSON.stringify(body) });
const get = (url) => fetch(url, { credentials: "same-origin" });

function show(name) {
  for (const s of document.querySelectorAll("main > section")) s.hidden = s.id !== `screen-${name}`;
  for (const b of document.querySelectorAll("#steps button")) b.classList.toggle("active", b.dataset.screen === name);
}
for (const b of document.querySelectorAll("#steps button")) b.addEventListener("click", () => show(b.dataset.screen));

function li(text, cls) {
  const el = document.createElement("li");
  el.textContent = text;
  if (cls) el.className = cls;
  return el;
}

async function runCommand(command, onWait) {
  const res = await post("/api/run", { command });
  const body = await res.json();
  if (!res.ok) return { exit: 1, output: body.message || body.error || "Could not start the command." };
  for (let i = 0; i < 600; i++) {
    const r = await (await get(`/api/result/${body.id}`)).json();
    if (r.done) return r;
    if (onWait) onWait(i);
    await new Promise((ok) => setTimeout(ok, 1000));
  }
  return { exit: 1, output: "Timed out waiting for the command." };
}

$("unlock-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const field = $("passphrase");
  const passphrase = field.value;
  field.value = "";
  $("unlock-msg").textContent = "Unlocking (this takes a few seconds)...";
  const res = await post("/api/unlock", { passphrase });
  const body = await res.json();
  $("unlock-msg").textContent = res.ok ? "Unlocked. Save your site token, then run the checks." : body.message || "Could not unlock.";
});

$("token-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const field = $("site-token");
  const token = field.value;
  field.value = "";
  const res = await post("/api/token", { token });
  const body = await res.json();
  $("unlock-msg").textContent = res.ok ? "Token saved on this computer." : body.message || "Could not save the token.";
});

$("run-preflight").addEventListener("click", async () => {
  const list = $("check-list");
  list.replaceChildren();
  $("check-msg").textContent = "Running checks...";
  const r = await runCommand("preflight");
  try {
    const report = JSON.parse(r.output);
    for (const c of report.checks) list.append(li(`${c.id}: ${c.detail}`, c.status));
    $("check-msg").textContent = report.ok ? "All required checks passed." : `${report.failed} required check(s) failed. Fix those, then run again.`;
  } catch {
    $("check-msg").textContent = r.output || "No result.";
  }
});

$("load-data").addEventListener("click", async () => {
  const out = $("data-out");
  out.replaceChildren();
  const data = await (await get("/api/data")).json();
  if (!data.present) return void (out.textContent = "The data folder was not found.");
  if (data.flagged?.length) out.append(li(`Remove before use: ${data.flagged.map((f) => `${f.column} (${f.problem.replace("_", " ")})`).join(", ")}`, "fail"));
  for (const f of data.files) {
    const h = document.createElement("h3");
    h.textContent = f.error ? `${f.file}: ${f.error}` : `${f.file}: ${f.rows} rows, ${f.columns.length} columns`;
    out.append(h);
    if (!f.columns) continue;
    const table = document.createElement("table");
    const head = table.insertRow();
    for (const t of ["Column", "Type", "Missing", "Type problems"]) head.insertCell().textContent = t;
    for (const c of f.columns) {
      const row = table.insertRow();
      row.insertCell().textContent = c.name;
      row.insertCell().textContent = c.categories ? `${c.type}: ${c.categories.map((x) => `${x.label} ${x.count}`).join(", ")}` : c.type;
      row.insertCell().textContent = String(c.missing);
      row.insertCell().textContent = String(c.typeErrors);
    }
    out.append(table);
  }
});

async function refreshStatus() {
  const r = await runCommand("status");
  try {
    const s = JSON.parse(r.output);
    $("status-line").textContent = `${s.status}${s.status === "CONNECTED" ? "" : ": " + s.container + " / " + s.health}`;
    $("run-out").textContent = `Last heartbeat: ${s.lastHeartbeat}\nData files: ${s.csvCount}\nGPU(s): ${s.gpuCount}`;
  } catch {
    $("status-line").textContent = "No status yet";
    $("run-out").textContent = r.output;
  }
}
$("do-status").addEventListener("click", refreshStatus);
for (const [id, command] of [["do-start", "start"], ["do-stop", "stop"]]) {
  $(id).addEventListener("click", async () => {
    $("status-line").textContent = `${command === "start" ? "Starting" : "Stopping"}... (the first start downloads the study image)`;
    const r = await runCommand(command);
    $("run-out").textContent = r.output;
    await refreshStatus();
  });
}

async function listBundles() {
  const { bundles } = await (await get("/api/bundles")).json();
  const list = $("bundle-list");
  list.replaceChildren();
  for (const b of bundles) {
    const item = document.createElement("li");
    const a = document.createElement("a");
    a.href = `/api/bundle/${encodeURIComponent(b.name)}`;
    a.textContent = `${b.name} (${b.bytes} bytes)`;
    const view = document.createElement("button");
    view.textContent = "Read contents";
    view.addEventListener("click", async () => {
      const { files } = await (await get(`/api/bundle/${encodeURIComponent(b.name)}/files`)).json();
      let text = "";
      for (const f of files) text += `=== ${f}\n${(await (await get(`/api/bundle/${encodeURIComponent(b.name)}/file?name=${encodeURIComponent(f)}`)).json()).text}\n`;
      $("bundle-view").textContent = text;
    });
    item.append(a, " ", view);
    list.append(item);
  }
}
$("make-bundle").addEventListener("click", async () => {
  await runCommand($("with-logs").checked ? "support-bundle-logs" : "support-bundle");
  await listBundles();
});
listBundles().catch(() => {});
