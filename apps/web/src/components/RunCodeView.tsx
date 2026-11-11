"use client";

import { Alert, Button, Space, Typography } from "antd";
import { useState } from "react";
import { Details } from "@/components/Details";
import { FileTree } from "@/components/FileTree";

export type CodeView = {
  commit: string;
  /** False when the run has no commit of its own and the pipeline version's commit is shown instead. */
  commitRecordedOnRun: boolean;
  imageDigest: string | null;
  siteDigests: Array<{ site: string; imageDigest: string | null }> | null;
  treeTruncated: boolean;
  commitUrl: string | null;
  pipelineVersion: string;
  parent: { version: string; commit: string } | null;
  files: Array<{ path: string; status: "added" | "modified" | "unchanged" | "unknown" }>;
  deletedPaths: string[];
  file: { path: string; content: string | null; truncated: boolean; parentContentMissing: boolean; diff: { lines: Array<{ kind: string; text: string }>; added: number; removed: number; tooLarge: boolean } | null } | null;
};

const notRecorded = <Typography.Text type="secondary">Not recorded</Typography.Text>;
const mono = { wordBreak: "break-all" as const };

/** Read-only code at the run's commit: commit, digests, tree, file or diff, and every state the code route reports. */
export function RunCodeView({ view, onSelect }: { view: CodeView; onSelect: (path: string) => void }) {
  const [showDiff, setShowDiff] = useState(true);
  const changed = view.files.filter((f) => f.status === "added" || f.status === "modified").map((f) => f.path);
  return (
    <div>
      <Space wrap style={{ marginBottom: 8 }}>
        <span>Code for pipeline version {view.pipelineVersion}</span>
        {!view.commitRecordedOnRun ? <Typography.Text type="warning">Not recorded on this run: this is the code of pipeline version {view.pipelineVersion}, which may differ from what ran.</Typography.Text> : null}
        {view.commitUrl ? <a href={view.commitUrl} target="_blank" rel="noreferrer">Open repository</a> : null}
        <span>{view.parent ? `Compared with pipeline version ${view.parent.version}` : "No earlier version to compare with"}</span>
      </Space>
      {/* On the Code tab the commit and digests are what the person came to see: shown open, in place. */}
      <Details
        inline
        defaultOpen
        items={[
          { label: "Commit", value: <code style={mono}>{view.commit}</code>, copyText: view.commit },
          ...(view.parent ? [{ label: "Compared with commit", value: <code style={mono}>{view.parent.commit}</code> }] : []),
          { label: "Code version (image digest)", value: view.imageDigest ? <code style={mono}>{view.imageDigest}</code> : notRecorded },
          ...(view.siteDigests ?? []).map((sd) => ({
            label: `Site ${sd.site} reported`,
            value: sd.imageDigest ? <code style={mono}>{sd.imageDigest}</code> : <Typography.Text type="secondary">Not reported</Typography.Text>
          }))
        ]}
      />
      {view.treeTruncated ? (
        <Alert type="warning" showIcon style={{ marginBottom: 8 }} message="The file list is incomplete" description="The repository has more files than could be listed at once. Files marked added, modified or removed may be wrong for files that are not listed. Open the repository for the full list." />
      ) : null}
      {view.deletedPaths.length ? <Typography.Paragraph type="secondary">Removed since the previous version: {view.deletedPaths.join(", ")}</Typography.Paragraph> : null}
      <div data-testid="code-layout" style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-start" }}>
        <div style={{ flex: "1 1 240px", maxWidth: 360, minWidth: 0 }}>
          <FileTree paths={view.files.map((f) => f.path)} selectedPath={view.file?.path ?? null} modifiedPaths={changed} onSelect={onSelect} />
        </div>
        <div style={{ flex: "3 1 360px", minWidth: 0 }}>
          {view.file ? (
            <>
              <Space style={{ marginBottom: 8 }}>
                <strong>{view.file.path}</strong>
                {view.file.diff ? <Button size="small" onClick={() => setShowDiff(!showDiff)}>{showDiff ? "Show file" : "Show diff"}</Button> : null}
              </Space>
              {view.file.parentContentMissing ? <Alert type="warning" showIcon style={{ marginBottom: 8 }} message="No diff: the previous version of this file could not be read" description="The file is shown as it was at this run's commit." /> : null}
              {showDiff && view.file.diff ? (
                view.file.diff.tooLarge ? <Alert type="info" message="File too large to compare here. Open it in the repository." /> : view.file.diff.lines.length === 0 ? <Typography.Text type="secondary">No changes against the previous version.</Typography.Text> : (
                  <pre style={{ overflow: "auto", maxHeight: 520 }}>
                    {view.file.diff.lines.map((l) => `${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "} ${l.text}`).join("\n")}
                  </pre>
                )
              ) : view.file.content === null ? <Alert type="info" message="This file has no inline text content." /> : (
                <pre style={{ overflow: "auto", maxHeight: 520 }}>{view.file.content}{view.file.truncated ? "\n[truncated]" : ""}</pre>
              )}
            </>
          ) : <Typography.Text type="secondary">Select a file. Files marked M are new or changed since the previous version.</Typography.Text>}
        </div>
      </div>
    </div>
  );
}
