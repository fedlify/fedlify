import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkRepoFiles, isSensitiveFilePath, redactSecrets, REQUIRED_FILES, type RepoFile } from "@/lib/repo-checks";

const pipeline = JSON.stringify({
  packageType: "fedlify-study-pipeline",
  entrypoint: "client.py",
  dataContract: { label: "died", features: ["age"] }
});

function validRepo(): RepoFile[] {
  return [
    ...REQUIRED_FILES.map((path) => ({ path, content: "x" })),
    { path: "fedlify-pipeline.json", content: pipeline },
    { path: "job/app/config/config_fed_client.conf", content: 'args = "/opt/fedlify/code/client.py"' },
    { path: "requirements.txt", content: "numpy==1.26.4  # pinned\n\n" }
  ];
}

const withFile = (path: string, content: string) => [...validRepo().filter((file) => file.path !== path), { path, content }];
const errorsOf = (files: RepoFile[], id: string) => checkRepoFiles(files).checks.find((check) => check.id === id)!.errors;

describe("checkRepoFiles", () => {
  it("passes a valid repo and labels unit tests as not run", () => {
    const report = checkRepoFiles(validRepo());
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
    const notRun = report.checks.filter((check) => check.status === "not_run").map((check) => check.id);
    expect(notRun).toEqual(["python-syntax", "unit-tests"]);
    expect(report.notice).toMatch(/unit tests/i);
  });

  it("reports missing required files", () => {
    const files = validRepo().filter((file) => file.path !== "client.py");
    expect(errorsOf(files, "layout")).toEqual(["missing required file: client.py"]);
  });

  it("rejects data-like files but not README or the pipeline file", () => {
    const files = [...validRepo(), { path: "data/train.csv", content: "a,b" }, { path: "src/patients_loader.py", content: "pass" }];
    expect(errorsOf(files, "data-files")).toHaveLength(2);
    expect(errorsOf([...validRepo(), { path: "README.md", content: "patients" }], "data-files")).toEqual([]);
  });

  it("detects credentials without echoing them", () => {
    const secret = "sk-abcdefghijklmnopqrstuvwxyz123456";
    const errors = errorsOf(withFile("config.py", `KEY = "${secret}"`), "secrets");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("config.py");
    expect(errors[0]).not.toContain(secret);
    expect(errorsOf(withFile(".env", 'password = "hunter2hunter2"'), "secrets")).toHaveLength(1);
    expect(errorsOf(withFile("notes.py", 'password = "short"'), "secrets")).toEqual([]);
  });

  it("enforces packageType, entrypoint and data contract", () => {
    const bad = JSON.stringify({ packageType: "other", entrypoint: "missing.py", dataContract: { label: "y", features: [] } });
    const errors = errorsOf(withFile("fedlify-pipeline.json", bad), "contract");
    expect(errors).toHaveLength(3);
    expect(errorsOf(withFile("fedlify-pipeline.json", "{nope"), "contract")[0]).toMatch(/not valid JSON/);
    expect(errorsOf(withFile("fedlify-pipeline.json", "[]"), "contract")[0]).toMatch(/JSON object/);
  });

  it("requires the baked-in launcher path", () => {
    expect(errorsOf(withFile("job/app/config/config_fed_client.conf", "args = client.py"), "launcher")).toHaveLength(1);
  });

  it("requires pinned requirements", () => {
    const errors = errorsOf(withFile("requirements.txt", "numpy\nscipy>=1.0\n-r other.txt\ngit+https://x/y.git\nok==1.0.0"), "requirements");
    expect(errors).toHaveLength(4);
    expect(errors[0]).toContain("requirements.txt:1");
  });

  it("rejects an oversized repository", () => {
    const big = { path: "big.txt", content: "a".repeat(21 * 1024 * 1024) };
    expect(errorsOf([...validRepo(), big], "layout")[0]).toMatch(/limit/);
  });
});

describe("redactSecrets", () => {
  it("removes credential-like strings", () => {
    const out = redactSecrets('token = "abcdefghijkl"\nAKIAABCDEFGHIJKLMNOP\nplain text');
    expect(out).not.toContain("abcdefghijkl");
    expect(out).not.toContain("AKIAABCDEFGHIJKLMNOP");
    expect(out).toContain("plain text");
  });
});

describe("hardening", () => {
  it("redacts unquoted and URL credentials and bearer tokens", () => {
    const text = [
      "PASSWORD=hunter2hunter2",
      "DATABASE_URL=postgres://u:pw12345678@h/db",
      "Authorization: Bearer abcdefghijklmnop1234",
      "plain=ok"
    ].join("\n");
    const out = redactSecrets(text);
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("pw12345678");
    expect(out).not.toContain("abcdefghijklmnop1234");
    expect(out).toContain("plain=ok");
  });

  it("flags secret-like files", () => {
    expect(isSensitiveFilePath("config/.env.local")).toBe(true);
    expect(isSensitiveFilePath("certs/server.pem")).toBe(true);
    expect(isSensitiveFilePath("client.py")).toBe(false);
  });

  it("keeps empty files and reports unreadable ones", () => {
    const files = validRepo().map((f) => (f.path === "job/meta.conf" ? { ...f, content: "" } : f));
    expect(checkRepoFiles(files).checks.find((c) => c.id === "layout")?.status).toBe("pass");
    const report = checkRepoFiles([...files, { path: "big.bin", content: "", unreadable: true }]);
    expect(report.checks.find((c) => c.id === "layout")?.errors.join()).toContain("big.bin");
  });

  it("splits requirements like Python splitlines", () => {
    const files = [...validRepo().filter((f) => f.path !== "requirements.txt"), { path: "requirements.txt", content: "a==1\rgit+https://x" }];
    expect(checkRepoFiles(files).checks.find((c) => c.id === "requirements")?.errors[0]).toContain("requirements.txt:2");
  });
});

describe("feature contract check", () => {
  const withFeatures = (features: string[]) =>
    withFile("fedlify-pipeline.json", JSON.stringify({ packageType: "fedlify-study-pipeline", entrypoint: "client.py", dataContract: { label: "died", features } }));

  it("rejects identifier and offset-like features", () => {
    const errors = errorsOf(withFeatures(["age", "patientunitstayid", "PatientHealthSystemStayID", "uniquepid", "labresultoffset"]), "contract");
    expect(errors).toHaveLength(4);
    expect(errors.join("\n")).toContain("feature patientunitstayid is an identifier");
  });

  it("accepts ordinary features", () => {
    expect(errorsOf(withFeatures(["age", "creatinine", "heartrate"]), "contract")).toEqual([]);
  });

  it("the starter contract has 25 features, none leaky, and passes", () => {
    const text = readFileSync(resolve(__dirname, "../../../templates/fedlify-starter/fedlify-pipeline.json"), "utf8");
    const features: string[] = JSON.parse(text).dataContract.features;
    expect(features).toHaveLength(25);
    expect(features).not.toContain("sao2_periodic");
    expect(features).not.toContain("temperature_periodic");
    expect(errorsOf(withFile("fedlify-pipeline.json", text), "contract")).toEqual([]);
  });
});
