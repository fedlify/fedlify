import { describe, expect, it } from "vitest";
import {
  chooseSelectedStudy,
  matchesStudyStatusFilter,
  resolveUnavailableStudyTarget,
  type StudySummary
} from "@/lib/studies";

const studies: StudySummary[] = [
  { id: "archived", title: "Archived", status: "ARCHIVED" },
  { id: "draft", title: "Draft", status: "DRAFT" },
  { id: "active", title: "Active", status: "ACTIVE" }
];

describe("study helpers", () => {
  it("filters active and archived study sets", () => {
    expect(studies.filter((study) => matchesStudyStatusFilter(study, "active")).map((study) => study.id)).toEqual([
      "draft",
      "active"
    ]);
    expect(studies.filter((study) => matchesStudyStatusFilter(study, "archived")).map((study) => study.id)).toEqual([
      "archived"
    ]);
  });

  it("prefers a stored active selected study", () => {
    expect(chooseSelectedStudy(studies, "active")?.id).toBe("active");
  });

  it("falls back to the first non-archived study", () => {
    expect(chooseSelectedStudy(studies, "missing")?.id).toBe("draft");
    expect(chooseSelectedStudy(studies, "archived")?.id).toBe("draft");
  });

  it("falls back to archived only when no active study exists", () => {
    expect(chooseSelectedStudy([studies[0]], null)?.id).toBe("archived");
  });

  it("resolves inaccessible study routes to another selectable study", () => {
    expect(resolveUnavailableStudyTarget(studies, "missing", "pipeline")).toEqual({
      href: "/studies/draft?section=pipeline",
      studyId: "draft"
    });
  });

  it("resolves to study management when no alternate study is selectable", () => {
    expect(resolveUnavailableStudyTarget([studies[1]], "draft", "pipeline")).toEqual({
      href: "/studies/manage",
      studyId: null
    });
    expect(resolveUnavailableStudyTarget([], "draft")).toEqual({
      href: "/studies/manage",
      studyId: null
    });
  });
});
