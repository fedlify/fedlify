// Headless decrypt: `docker run --rm -i -v ...:/in:ro -v ...:/work IMAGE decrypt < passphrase-file`.
// The passphrase arrives on stdin, so it is in no argument and no environment variable. Writes only /work/kit.zip.
// Exit codes: 0 ok, 1 wrong passphrase or modified file, 2 usage, 3 empty passphrase.
import { writeFile } from "node:fs/promises";
import { decryptToZip, UnlockError } from "./unlock.mjs";

if (process.argv[2] !== "decrypt") {
  console.error("usage: unlock-cli decrypt   (passphrase on stdin; /in/kit.zip.age -> /work/kit.zip)");
  process.exit(2);
}
let input = "";
for await (const chunk of process.stdin) input += chunk;
const passphrase = input.replace(/[\r\n]+$/, "");
if (!passphrase) {
  console.error("unlock: empty passphrase on stdin.");
  process.exit(3);
}
try {
  const zip = await decryptToZip("/in/kit.zip.age", passphrase);
  await writeFile("/work/kit.zip", zip, { mode: 0o600 });
} catch (error) {
  console.error(error instanceof UnlockError ? `unlock: ${error.message}` : "unlock: failed");
  process.exit(1);
}
