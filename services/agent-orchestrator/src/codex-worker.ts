import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Codex } from "@openai/codex-sdk";
import { hash, signedWorkItemSchema, verifySignature } from "./contracts.js";

const exec = promisify(execFile);

export async function executeCodexWorkItem(raw: unknown, sourceRepository: string) {
  const workItem = signedWorkItemSchema.parse(raw);
  if (workItem.role !== "CODEX_WORKER") throw new Error("Codex endpoint accepts CODEX_WORKER contracts only.");
  if (!verifySignature(workItem.signedPayload, workItem.signature)) throw new Error("Invalid signed work-item contract.");
  if (!process.env.FEDLIFY_CODEX_SOURCE_ALLOWLIST?.split(":").includes(sourceRepository)) {
    throw new Error("Source repository is not in FEDLIFY_CODEX_SOURCE_ALLOWLIST.");
  }

  const root = await mkdtemp(join(tmpdir(), "fedlify-codex-"));
  const clone = join(root, "repo");
  try {
    await exec("git", ["clone", "--no-hardlinks", "--", sourceRepository, clone], { timeout: 60_000 });
    const codex = new Codex();
    const thread = codex.startThread({
      model: process.env.FEDLIFY_CODEX_MODEL ?? "gpt-5.6-terra",
      modelReasoningEffort: "medium",
      sandboxMode: "workspace-write",
      workingDirectory: clone,
      skipGitRepoCheck: false,
      networkAccessEnabled: false,
      approvalPolicy: "never"
    });
    const prompt = `Implement only this signed task: ${workItem.purpose}\nInput: ${JSON.stringify(workItem.input)}\nDo not access credentials, network services, or runtime systems. Do not commit or push.`;
    const result = await thread.run(prompt);
    const { stdout: patch } = await exec("git", ["-C", clone, "diff", "--binary", "--no-ext-diff"], { maxBuffer: 25 * 1024 * 1024 });
    const { stdout: status } = await exec("git", ["-C", clone, "status", "--porcelain=v1"]);
    return {
      proposal: { patch, status: status.trim().split("\n").filter(Boolean), finalResponse: result.finalResponse },
      execution: { workItemId: workItem.id, role: "CODEX_WORKER", model: process.env.FEDLIFY_CODEX_MODEL ?? "gpt-5.6-terra", promptHash: hash(prompt), outputHash: hash(patch), usage: result.usage }
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
