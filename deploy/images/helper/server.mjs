// Entry point. Binds loopback unless it runs inside our container (where compose publishes the port on 127.0.0.1 only).
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHelperApp } from "./app.mjs";
import { checkBindAddress } from "./security.mjs";

const env = process.env;
const port = Number(env.FEDLIFY_HELPER_LISTEN_PORT ?? 8765);
const publicPort = Number(env.FEDLIFY_HELPER_PUBLIC_PORT ?? port);
const bind = env.FEDLIFY_HELPER_BIND ?? (env.FEDLIFY_HELPER_CONTAINER === "1" ? "0.0.0.0" : "127.0.0.1");
const verdict = checkBindAddress(bind, env);
if (!verdict.ok) {
  console.error(`fedlify-helper: ${verdict.reason}`);
  process.exit(2);
}
if (verdict.warning) console.error(`fedlify-helper: ${verdict.warning}`);

const queueDir = env.FEDLIFY_QUEUE_DIR ?? "/queue";
const app = createHelperApp({
  encPath: env.FEDLIFY_KIT_FILE ?? "/in/kit.zip.age",
  kitParent: env.FEDLIFY_KIT_PARENT ?? "/kit",
  queueDir,
  dataDir: env.FEDLIFY_DATA_PATH ?? "/data",
  publicPort
});
for (const sub of ["requests", "results", "out"]) await mkdir(path.join(queueDir, sub), { recursive: true, mode: 0o700 });
// The one-time link goes to a 0600 file for the launcher to read and delete. It is not logged and not in the environment.
const tmp = path.join(queueDir, ".helper-link.tmp");
await writeFile(tmp, `${app.linkUrl()}\n`, { mode: 0o600 });
await rename(tmp, path.join(queueDir, "helper-link"));
app.server.listen(port, bind, () => console.log(`fedlify-helper: listening on ${bind}:${port} (published port ${publicPort}). Open the link printed by start-helper.`));
