import JSZip from "jszip";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

export type ArchiveFileMap = Record<string, string | Buffer>;

export async function zipFiles(files: ArchiveFileMap): Promise<Buffer> {
  const zip = new JSZip();
  for (const [path, body] of Object.entries(files)) {
    zip.file(path, body);
  }
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
}

async function addDirectory(zip: JSZip, directory: string, prefix: string) {
  const entries = await readdir(directory);
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry);
    const relativePath = prefix ? `${prefix}/${entry}` : entry;
    const info = await stat(absolutePath);
    if (info.isDirectory()) {
      await addDirectory(zip, absolutePath, relativePath);
    } else if (info.isFile()) {
      zip.file(relativePath, await readFile(absolutePath));
    }
  }
}

export async function zipDirectory(directory: string, prefix = ""): Promise<Buffer> {
  const zip = new JSZip();
  await addDirectory(zip, directory, prefix.replace(/^\/+|\/+$/g, ""));
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
}

export async function directoryToArchiveMap(directory: string, prefix = ""): Promise<ArchiveFileMap> {
  const files: ArchiveFileMap = {};
  const normalizedPrefix = prefix.replace(/^\/+|\/+$/g, "");
  async function collect(currentDirectory: string, currentPrefix: string) {
    const entries = await readdir(currentDirectory);
    for (const entry of entries) {
      const absolutePath = path.join(currentDirectory, entry);
      const relativePath = currentPrefix ? `${currentPrefix}/${entry}` : entry;
      const info = await stat(absolutePath);
      if (info.isDirectory()) {
        await collect(absolutePath, relativePath);
      } else if (info.isFile()) {
        files[relativePath] = await readFile(absolutePath);
      }
    }
  }
  await collect(directory, normalizedPrefix);
  return files;
}
