import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const images = path.resolve(__dirname, "../../../deploy/images");
const read = (rel: string) => readFileSync(path.join(images, rel), "utf8");

describe("GPU and multi-arch image files", () => {
  it("CPU base image is unchanged and stays the default", () => {
    const cpu = read("nvflare/Dockerfile");
    expect(cpu).toContain("FROM python:3.10-slim");
    expect(cpu).not.toMatch(/cuda|nvidia/i);
  });

  it("the CUDA flavour is a separate file, with the same runtime layout and a CUDA base", () => {
    const cuda = read("nvflare/Dockerfile.cuda");
    expect(cuda).toMatch(/^ARG CUDA_IMAGE=nvidia\/cuda:12\.4\.1-runtime-ubuntu22\.04$/m);
    expect(cuda).toContain("NOT BUILT OR TESTED");
    expect(cuda).toContain('nvflare==${NVFLARE_VERSION}');
    // Everything the aggregator and clients rely on is copied exactly as in the CPU image.
    const copies = (text: string) => text.split("\n").filter((l) => l.startsWith("COPY ")).sort();
    expect(copies(cuda)).toEqual(copies(read("nvflare/Dockerfile")));
    expect(cuda).toContain('ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/fedlify-start"]');
    expect(cuda).toContain("USER fedlify");
  });

  it("the multi-arch script builds both platforms, refuses to --load, and verifies each before anything claims arm64", () => {
    const script = read("build-multiarch.sh");
    execFileSync("bash", ["-n", path.join(images, "build-multiarch.sh")]);
    expect(script).toContain('PLATFORMS="linux/amd64,linux/arm64"');
    expect(script).toContain("NOT RUN");
    expect(script).toContain("UNVERIFIED");
    expect(script).toMatch(/Build-time cost/);
    expect(script).toContain("imagetools inspect");
    expect(script).toContain('--platform "$p"');
    expect(script).toContain("FEDLIFY_STUDY_IMAGE_ARCHES");
    expect(script).toContain("cannot be loaded");
  });

  it("the helper image drops privileges and installs from a lockfile without running install scripts", () => {
    const dockerfile = read("helper/Dockerfile");
    expect(dockerfile).toContain("npm ci --omit=dev --ignore-scripts");
    expect(dockerfile).toContain("USER node");
    expect(dockerfile).toContain("WITHOUT a login");
    const lock = JSON.parse(read("helper/package-lock.json"));
    expect(lock.packages["node_modules/age-encryption"].version).toBe("0.3.1");
    expect(lock.packages["node_modules/jszip"].version).toBe("3.10.1");
  });
});
