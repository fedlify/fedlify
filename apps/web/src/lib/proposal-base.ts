type FileWithPath = { path: string };

/**
 * Adds each file's content at the proposal's base commit, so a decided proposal still shows what it changed once the
 * saved code has moved on. Returns the files unchanged, with baseUnavailable set, if any file cannot be read.
 */
export async function attachBaseContent<T extends FileWithPath>(files: T[], read: (path: string) => Promise<string | null>): Promise<{ files: Array<T & { originalContent?: string }>; baseUnavailable: boolean }> {
  try {
    const originals = await Promise.all(files.map((file) => read(file.path)));
    // A file absent at the base commit was created by the proposal, so its original is empty.
    return { files: files.map((file, index) => ({ ...file, originalContent: originals[index] ?? "" })), baseUnavailable: false };
  } catch {
    return { files, baseUnavailable: true };
  }
}
