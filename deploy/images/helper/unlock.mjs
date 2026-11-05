// Decrypts kit.zip.age (age passphrase mode) in memory and unpacks it into a private directory. Used by the UI
// (passphrase from a POST body held in memory) and by the headless CLI (passphrase from stdin). It is never an argument
// or an environment variable, and it is never written to disk by this code.
import { chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Decrypter } from "age-encryption";
import JSZip from "jszip";

const MAX_PLAINTEXT = 256 * 1024 * 1024;

export class UnlockError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export async function decryptToZip(encPath, passphrase) {
  if (typeof passphrase !== "string" || passphrase.length < 8 || passphrase.length > 1024) {
    throw new UnlockError("bad_passphrase", "Enter the passphrase you received separately.");
  }
  let encrypted;
  try {
    encrypted = await readFile(encPath);
  } catch {
    throw new UnlockError("no_kit_file", "kit.zip.age was not found next to the helper.");
  }
  try {
    const decrypter = new Decrypter();
    decrypter.addPassphrase(passphrase);
    const plain = await decrypter.decrypt(encrypted);
    if (plain.length > MAX_PLAINTEXT) throw new UnlockError("too_large", "The kit is larger than expected.");
    return Buffer.from(plain);
  } catch (error) {
    if (error instanceof UnlockError) throw error;
    // age authenticates every chunk: a wrong passphrase and a modified file are the same observable failure.
    throw new UnlockError("decrypt_failed", "Wrong passphrase, or the file was modified or damaged. Nothing was written.");
  }
}

function safeEntryName(name) {
  if (!name || name.startsWith("/") || name.includes("\\") || name.includes("\0")) return false;
  return !name.split("/").some((part) => part === ".." || part === "");
}

async function chmodTree(dir) {
  await chmod(dir, 0o700);
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await chmodTree(p);
    else await chmod(p, 0o600);
  }
}

/**
 * Unlock into `<parent>/<dirName>`. The directory appears by one rename after everything was written, with modes
 * 0700 (directories) and 0600 (files, the runner 0700). Any failure removes the staging directory.
 */
export async function unlockKit({ encPath, parent, dirName = "fedlify-site-kit", passphrase }) {
  const target = path.join(parent, dirName);
  const exists = await stat(target).then(() => true, () => false);
  if (exists) throw new UnlockError("exists", "A kit folder already exists. Remove it first if you want to unlock again.");
  const zipBytes = await decryptToZip(encPath, passphrase);
  const stage = await mkdtemp(path.join(parent, ".fedlify-unlock-"));
  try {
    await chmod(stage, 0o700);
    let zip;
    try {
      zip = await JSZip.loadAsync(zipBytes);
    } catch {
      throw new UnlockError("not_a_zip", "The decrypted data is not a valid archive. Nothing was written.");
    }
    const out = path.join(stage, "out");
    await mkdir(out, { mode: 0o700 });
    let total = 0;
    let hasRunner = false;
    for (const entry of Object.values(zip.files)) {
      if (!safeEntryName(entry.name.replace(/\/$/, ""))) throw new UnlockError("unsafe_path", "The archive contains an unsafe path. Nothing was written.");
      const dest = path.join(out, entry.name);
      if (entry.dir) {
        await mkdir(dest, { recursive: true, mode: 0o700 });
        continue;
      }
      const data = await entry.async("nodebuffer");
      total += data.length;
      if (total > MAX_PLAINTEXT) throw new UnlockError("too_large", "The kit is larger than expected.");
      await mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
      await writeFile(dest, data, { mode: 0o600 });
      if (entry.name === "fedlify-runner.sh") hasRunner = true;
    }
    if (!hasRunner) throw new UnlockError("not_a_kit", "This archive is not a Fedlify site kit. Nothing was written.");
    await chmodTree(out);
    await chmod(path.join(out, "fedlify-runner.sh"), 0o700);
    await rename(out, target);
    return { dir: target };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
