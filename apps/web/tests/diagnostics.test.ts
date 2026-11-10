import { describe, expect, it } from "vitest";
import {
  boundDiagnostics,
  DIAGNOSTICS_LIMITS,
  diagnosticsRelevant,
  firstErrorLines,
  headMovedPast,
  looksLikeDataRow,
  redactText,
  sanitizeLog,
  sanitizeMessage,
  selectFailedPod,
  selectFailedStep,
  selectSteps,
  summarizeFailures,
  type DiagnosticsContext
} from "@/lib/diagnostics";
import { buildAgentInput, buildContextPack, PROJECT_AGENT_SYSTEM_PROMPT } from "@/lib/project-context";

const WF = "fedlify-publish-abc-x1";

describe("redaction", () => {
  it("removes credentials, addresses, emails and personal paths", () => {
    const text = [
      "git clone https://bot:hunter2pass@gitea.example.org/a/b.git",
      "GITEA_TOKEN=abcd1234efgh5678",
      "Authorization: Bearer abcdefghijklmnop1234",
      "connect to 10.20.30.40:8002 failed",
      "contact jane.doe@hospital.org",
      "File /Users/jane/work/client.py line 3",
      "key sk-abcdefghijklmnopqrstuvwxyz"
    ].join("\n");
    const out = redactText(text);
    expect(out).not.toMatch(/hunter2pass|abcd1234efgh5678|abcdefghijklmnop1234|10\.20\.30\.40|jane\.doe|\/jane\/|sk-abcdef/);
    expect(out).toContain("[address]");
    expect(out).toContain("/Users/[user]/work/client.py");
  });

  it("keeps loopback addresses and strips ANSI and control characters", () => {
    const out = redactText("\u001b[31mERROR\u001b[0m listening on 127.0.0.1\u0007");
    expect(out).toBe("ERROR listening on 127.0.0.1");
  });

  it("redacts a private key block even when it spans lines", () => {
    const out = sanitizeLog("a\n-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\nMIIEdef\n-----END RSA PRIVATE KEY-----\nb").text;
    expect(out).not.toContain("MIIE");
  });

  it("removes rows that look like tabular data", () => {
    expect(looksLikeDataRow("12,5.5,0,1,88,2024-01-02")).toBe(true);
    expect(looksLikeDataRow("ValueError: bad shape (3, 4)")).toBe(false);
    const { text, notes } = sanitizeLog("starting\n12,5.5,0,1,88,3.2\nValueError: x");
    expect(text).toBe("starting\n[data-like row removed]\nValueError: x");
    expect(notes[0]).toMatch(/1 data-like/);
  });
});

describe("bounding", () => {
  it("keeps only the last lines and characters of a log", () => {
    const raw = Array.from({ length: 500 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n");
    const { text, notes } = sanitizeLog(raw);
    const lines = text.split("\n");
    expect(lines.length).toBeLessThanOrEqual(DIAGNOSTICS_LIMITS.logLines);
    expect(text.length).toBeLessThanOrEqual(DIAGNOSTICS_LIMITS.logChars);
    expect(lines[lines.length - 1]).toContain("line 499");
    expect(notes.length).toBeGreaterThan(0);
  });

  it("truncates a very long line and a very long message", () => {
    expect(sanitizeLog("y".repeat(5000)).text.length).toBeLessThan(DIAGNOSTICS_LIMITS.lineChars + 40);
    expect(sanitizeMessage("z".repeat(900), 100)).toBe(`${"z".repeat(100)} [truncated]`);
  });

  it("redacts before cutting so a secret at the cap boundary cannot survive", () => {
    const secret = "sk-" + "a".repeat(40);
    const out = sanitizeMessage(`${"p".repeat(90)} ${secret}`, 100);
    expect(out).not.toMatch(/sk-a{5}/);
  });

  it("boundDiagnostics re-redacts and caps everything it is given", () => {
    const big: DiagnosticsContext = {
      publish: {
        id: "r1", version: "v2", commit: "abc", headCommit: null, headMoved: null, status: "FAILED", summary: "token=supersecretvalue1", workflowPhase: "Failed",
        steps: Array.from({ length: 40 }, (_, i) => ({ step: `s${i}`, phase: "Succeeded", message: "", seconds: 1 })),
        failedStep: "build-image",
        firstErrorLines: Array.from({ length: 30 }, (_, i) => `err ${i} 192.168.1.5`),
        logTail: Array.from({ length: 400 }, (_, i) => `l${i} password=hunter2hunter2`).join("\n"),
        logNote: null
      },
      aggregator: null,
      run: { id: "j", status: "FAILED", nvflareJobId: null, submittedAt: null, completedAt: null, events: Array.from({ length: 50 }, () => ({ type: "FAILED", site: null, message: "boom a@b.org", at: "t" })) },
      sites: Array.from({ length: 60 }, (_, i) => ({ code: `S${i}`, name: "n", participation: "INVITED", observedStatus: null, observedAt: null, connected: false, provisioned: true, kitReleased: false, kitMatchesLiveImage: null })),
      notes: [],
      siteSideNote: "x"
    };
    const out = boundDiagnostics(big);
    const json = JSON.stringify(out);
    expect(json).not.toMatch(/supersecretvalue1|hunter2hunter2|192\.168\.1\.5|a@b\.org/);
    expect(out.publish!.steps).toHaveLength(DIAGNOSTICS_LIMITS.steps);
    expect(out.publish!.firstErrorLines).toHaveLength(DIAGNOSTICS_LIMITS.firstErrorLines);
    expect(out.publish!.logTail!.length).toBeLessThanOrEqual(DIAGNOSTICS_LIMITS.logChars);
    expect(out.run!.events).toHaveLength(DIAGNOSTICS_LIMITS.events);
    expect(out.sites).toHaveLength(DIAGNOSTICS_LIMITS.sites);
    expect(boundDiagnostics(out)).toEqual(out);
  });
});

describe("error line selection", () => {
  it("starts at the first error and keeps a traceback header plus its tail", () => {
    const log = ["ok step", "Traceback (most recent call last):", ...Array.from({ length: 20 }, (_, i) => `  File "x.py", line ${i}`), "ValueError: label column missing"].join("\n");
    const lines = firstErrorLines(log, 6);
    expect(lines).toHaveLength(6);
    expect(lines[0]).toMatch(/^Traceback/);
    expect(lines[lines.length - 1]).toBe("ValueError: label column missing");
  });

  it("falls back to the last lines when nothing looks like an error", () => {
    expect(firstErrorLines("a\nb\nc\nd", 2)).toEqual(["c", "d"]);
    expect(firstErrorLines("")).toEqual([]);
  });
});

describe("step selection", () => {
  const nodes = [
    { name: WF, displayName: WF, type: "Steps", phase: "Failed" },
    { name: `${WF}[1].build-image`, displayName: "build-image", type: "Pod", phase: "Failed", message: "Error (exit code 1)", startedAt: "2026-11-04T10:02:00Z", finishedAt: "2026-11-04T10:05:00Z" },
    { name: `${WF}[0].clone-validate`, displayName: "clone-validate", type: "Pod", phase: "Succeeded", startedAt: "2026-11-04T10:00:00Z", finishedAt: "2026-11-04T10:01:30Z" },
    { name: `${WF}[2].provision-kits`, displayName: "provision-kits", type: "Pod", phase: "Failed", message: "later fallout", startedAt: "2026-11-04T10:06:00Z" },
    { name: `${WF}.onExit[0].callback`, displayName: "callback", type: "Pod", phase: "Failed", startedAt: "2026-11-04T10:07:00Z" }
  ];

  it("lists pod steps in start order and leaves out the exit handler and container nodes", () => {
    const steps = selectSteps(nodes, WF);
    expect(steps.map((s) => s.step)).toEqual(["clone-validate", "build-image", "provision-kits"]);
    expect(steps[0].seconds).toBe(90);
  });

  it("picks the earliest failed step, not the exit handler or later fallout", () => {
    expect(selectFailedStep(selectSteps(nodes, WF))?.step).toBe("build-image");
  });

  it("returns null when no step failed", () => {
    expect(selectFailedStep(selectSteps(nodes.filter((n) => n.phase === "Succeeded" || n.type !== "Pod"), WF))).toBeNull();
  });

  it("finds the newest pod of the failed step, preferring a Failed one", () => {
    const pod = (name: string, step: string, created: string, phase: string) => ({
      metadata: { name, creationTimestamp: created, annotations: { "workflows.argoproj.io/node-name": `${WF}[1].${step}` } },
      status: { phase }
    });
    const pods = [pod("p-old", "build-image", "2026-11-04T10:02:00Z", "Failed"), pod("p-new", "build-image", "2026-11-04T10:03:00Z", "Failed"), pod("p-other", "clone-validate", "2026-11-04T10:04:00Z", "Failed")];
    expect(selectFailedPod(pods, "build-image", WF)).toBe("p-new");
    expect(selectFailedPod(pods, "missing", WF)).toBeNull();
  });
});

describe("relevance and summaries", () => {
  it("loads diagnostics only for questions about publish, runs or sites, or when flagged", () => {
    expect(diagnosticsRelevant("Why did publish fail?")).toBe(true);
    expect(diagnosticsRelevant("Why is site B not connected?")).toBe(true);
    expect(diagnosticsRelevant("Explain client.py")).toBe(false);
    expect(diagnosticsRelevant("Explain client.py", true)).toBe(true);
  });

  it("summarises a failed publish and a failed run, and nothing for healthy ones", () => {
    const base: DiagnosticsContext = {
      publish: { id: "r1", version: "v2", commit: null, headCommit: null, headMoved: null, status: "FAILED", summary: "Publish Failed", workflowPhase: "Failed", steps: [], failedStep: "build-image", firstErrorLines: ["error: x"], logTail: null, logNote: null },
      aggregator: null,
      run: { id: "j1", status: "FAILED", nvflareJobId: null, submittedAt: null, completedAt: null, events: [{ type: "FAILED", site: "site-a", message: "client died", at: "t" }] },
      sites: [], notes: [], siteSideNote: ""
    };
    const out = summarizeFailures(base);
    expect(out.map((f) => f.key)).toEqual(["publish:r1", "run:j1"]);
    expect(out[0].title).toBe("Publishing v2 failed");
    expect(out[1].lines).toEqual(["site-a: client died"]);
    expect(out[0]).toMatchObject({ commit: null, headCommit: null, headMoved: null });
    const moved = summarizeFailures({ ...base, publish: { ...base.publish!, commit: "aaaaaaaaaaaa", headCommit: "bbbbbbbbbbbb", headMoved: true } });
    expect(moved[0]).toMatchObject({ commit: "aaaaaaaaaaaa", headCommit: "bbbbbbbbbbbb", headMoved: true });
    expect(summarizeFailures({ ...base, publish: { ...base.publish!, status: "PASSED" }, run: { ...base.run!, status: "COMPLETED" } })).toEqual([]);
  });
});

describe("assistant context", () => {
  const diag: DiagnosticsContext = {
    publish: { id: "r1", version: "v2", commit: null, headCommit: null, headMoved: null, status: "FAILED", summary: null, workflowPhase: "Failed", steps: [], failedStep: "clone-validate", firstErrorLines: ["ValueError: x"], logTail: "ValueError: x", logNote: null },
    aggregator: null, run: null, sites: [], notes: [], siteSideNote: "x"
  };
  const input = { study: { title: "t" }, requirementResponses: [], sites: [], files: [], commit: "abc" };

  it("includes bounded diagnostics in the serialised pack only when given", () => {
    expect(buildContextPack(input).pack.diagnostics).toBeNull();
    const built = buildContextPack({ ...input, diagnostics: diag });
    expect(built.text).toContain("clone-validate");
    expect(built.text).toContain("fedlify-runner.sh logs");
  });

  it("tells the model that site-side tracebacks are invisible and the operator must read the runner logs", () => {
    expect(PROJECT_AGENT_SYSTEM_PROMPT).toMatch(/Site-side tracebacks are NOT visible/);
    expect(PROJECT_AGENT_SYSTEM_PROMPT).toContain("./fedlify-runner.sh logs");
    const messages = buildAgentInput({ context: buildContextPack({ ...input, diagnostics: diag }), history: [], message: "why?" });
    expect(messages[1].content).toContain("<project_context>");
  });
});

describe("redaction of network details and message payloads", () => {
  it("redacts host names, FQDNs, internal service names, URLs and IPv6", () => {
    for (const input of [
      "connect to fl-site-3.hospital.example.org failed",
      "Connection refused: aggregator.fedlify.svc.cluster.local:8002",
      "GET https://internal-host/path failed",
      "host=gateway:8002 refused",
      "peer 2001:db8::1 reset",
      "peer fe80:0:0:0:1:2:3:4 reset"
    ]) {
      const out = redactText(input);
      expect(out).not.toMatch(/hospital|example|fedlify|internal-host|gateway|2001|fe80/);
    }
    expect(redactText("bind 127.0.0.1:8002 and ::1")).toContain("127.0.0.1");
  });
  it("leaves file names, modules, times and versions alone", () => {
    expect(redactText("File client.py, line 4 in torch.nn.functional at 12:34:56")).toBe("File client.py, line 4 in torch.nn.functional at 12:34:56");
    expect(redactText("nvflare==2.4.1.2 installed")).toBe("nvflare==2.4.1.2 installed");
    expect(redactText("peer 10.1.2.3:8002 down")).toBe("peer [address] down");
    expect(redactText("999.1.1.1")).toBe("999.1.1.1");
  });
  it("drops quoted values and long numbers from exception messages", () => {
    const out = redactText("ValueError: bad value 'John Smith' for patient 12345678");
    expect(out).toBe("ValueError: bad value [value] for patient [number]");
  });
  it("only triggers diagnostics on status phrasing", () => {
    expect(diagnosticsRelevant("add error handling to the loader")).toBe(false);
    expect(diagnosticsRelevant("log the loss each round")).toBe(false);
    expect(diagnosticsRelevant("Why did the run fail?")).toBe(true);
    expect(diagnosticsRelevant("publish failed, why?")).toBe(true);
  });
});

describe("first error lines ignore Argo executor noise", () => {
  it("returns the step's own failure", () => {
    const log = ['time=2026-11-04T09:01:27Z level=INFO msg="waiting for signals" argo=true', "1 problem(s) found.", "FAIL model.py does not compile: line 82: invalid syntax", 'time=2026-11-04T09:01:27Z level=INFO msg="sub-process exited" argo=true error="exit status 1"', "Error: exit status 1"].join("\n");
    const lines = firstErrorLines(log);
    expect(lines.join(" ")).toContain("model.py does not compile");
    expect(lines.join(" ")).not.toContain("argo=true");
  });
});

describe("headMovedPast", () => {
  it("compares the failed commit with the saved head, tolerating abbreviations, and is null when unknown", () => {
    expect(headMovedPast("0123456789ab", "0123456789abcdef0123")).toBe(false);
    expect(headMovedPast("0123456789ab", "fedcba987654")).toBe(true);
    expect(headMovedPast(null, "fedcba987654")).toBeNull();
    expect(headMovedPast("0123456789ab", undefined)).toBeNull();
    expect(headMovedPast("abc", "abcdef0")).toBeNull();
  });
});
