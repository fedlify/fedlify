import { describe, expect, it } from "vitest";
import { attachBaseContent } from "@/lib/proposal-base";

describe("attachBaseContent", () => {
  it("adds the base content and treats a missing file as empty", async () => {
    const result = await attachBaseContent([{ path: "a.py" }, { path: "new.py" }], async (path) => (path === "a.py" ? "old" : null));
    expect(result).toEqual({ baseUnavailable: false, files: [{ path: "a.py", originalContent: "old" }, { path: "new.py", originalContent: "" }] });
  });
  it("reports the failure instead of showing a wrong original", async () => {
    const files = [{ path: "a.py" }];
    const result = await attachBaseContent(files, async () => { throw new Error("gitea down"); });
    expect(result).toEqual({ baseUnavailable: true, files });
  });
});
