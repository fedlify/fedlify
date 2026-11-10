"use client";

import { CheckCircleOutlined, CloseOutlined, FullscreenExitOutlined, FullscreenOutlined, LeftOutlined, RightOutlined } from "@ant-design/icons";
import { Alert, Button, Checkbox, Segmented, Tag, Tooltip, Typography } from "antd";
import { useEffect, useState, type ReactNode } from "react";
import { SCAN_NOTICE, type ProposalFileSummary, type ProposalStatus } from "@/lib/agent-proposal-client";

export type DiffViewOptions = { sideBySide: boolean; changesOnly: boolean };

type ReviewProposal = { title: string; status: ProposalStatus; files: ProposalFileSummary[]; accepted: Record<string, boolean>; busy: boolean };

type Props = {
  proposal: ReviewProposal;
  currentPath: string;
  stale: boolean;
  filesUnknown: boolean;
  filesLoading: boolean;
  onSelect: (path: string) => void;
  onToggle?: (path: string, accepted: boolean) => void;
  onAccept?: () => void;
  onReject?: () => void;
  onClose?: () => void;
  renderDiff: (file: ProposalFileSummary, view: DiffViewOptions) => ReactNode;
};

const PREFS_KEY = "fedlify.proposalReview.view";
type Prefs = DiffViewOptions & { expanded: boolean };
// Review is a focused task, so it opens full width until the person chooses otherwise.
const DEFAULT_PREFS: Prefs = { expanded: true, sideBySide: true, changesOnly: true };

export function ProposalReviewView({ proposal, currentPath, stale, filesUnknown, filesLoading, onSelect, onToggle, onAccept, onReject, onClose, renderDiff }: Props) {
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(PREFS_KEY);
      if (saved) setPrefs({ ...DEFAULT_PREFS, ...(JSON.parse(saved) as Partial<Prefs>) });
    } catch { /* storage unavailable or malformed */ }
  }, []);

  function changePrefs(change: Partial<Prefs>) {
    setPrefs((current) => {
      const next = { ...current, ...change };
      try { window.localStorage.setItem(PREFS_KEY, JSON.stringify(next)); } catch { /* storage unavailable */ }
      return next;
    });
  }

  const { files, accepted, busy } = proposal;
  const index = Math.max(0, files.findIndex((file) => file.path === currentPath));
  const current = files[index];
  const selectedCount = files.filter((file) => accepted[file.path]).length;
  const totals = files.reduce((sum, file) => ({ added: sum.added + file.added, removed: sum.removed + file.removed }), { added: 0, removed: 0 });
  const tag = stale ? (proposal.status === "PROPOSED" ? (filesUnknown ? "Loading" : "Stale") : proposal.status.toLowerCase()) : "Proposed by assistant";

  return (
    <div className={["fedlify-proposal-review", prefs.expanded ? "is-expanded" : ""].join(" ")} role="group" aria-label="Review assistant proposal" data-testid="proposal-review">
      <header className="fedlify-proposal-review-head">
        <div className="fedlify-proposal-review-title">
          <Typography.Text strong ellipsis={{ tooltip: proposal.title }}>{proposal.title}</Typography.Text>
          <Tag color={stale ? "orange" : "purple"}>{tag}</Tag>
          <span className="fedlify-proposal-counts"><span className="is-add">+{totals.added}</span> <span className="is-del">-{totals.removed}</span></span>
        </div>
        <div className="fedlify-proposal-review-tools">
          <Segmented size="small" value={prefs.changesOnly ? "changes" : "full"} onChange={(value) => changePrefs({ changesOnly: value === "changes" })} options={[{ label: "Changes only", value: "changes" }, { label: "Full file", value: "full" }]} aria-label="How much of the file to show" />
          <Segmented size="small" value={prefs.sideBySide ? "split" : "inline"} onChange={(value) => changePrefs({ sideBySide: value === "split" })} options={[{ label: "Side by side", value: "split" }, { label: "Inline", value: "inline" }]} aria-label="Diff layout" />
          <Tooltip title={prefs.expanded ? "Exit full width" : "Full width"}>
            <Button size="small" type="text" icon={prefs.expanded ? <FullscreenExitOutlined /> : <FullscreenOutlined />} onClick={() => changePrefs({ expanded: !prefs.expanded })} aria-label={prefs.expanded ? "Exit full width" : "Full width"} aria-pressed={prefs.expanded} data-testid="proposal-review-expand" />
          </Tooltip>
          <Tooltip title="Close review">
            <Button size="small" type="text" icon={<CloseOutlined />} onClick={() => onClose?.()} aria-label="Close review" />
          </Tooltip>
        </div>
      </header>

      {filesUnknown ? <Alert banner type="info" message={filesLoading ? "Loading current files…" : "The current files could not be loaded, so this change cannot be reviewed yet."} /> : null}
      {stale && proposal.status === "PROPOSED" && !filesUnknown ? <Alert banner type="warning" message="The saved code changed after this proposal was written. Close this review and ask the assistant again so the change applies to the latest commit." /> : null}

      <div className="fedlify-proposal-review-body">
        <nav className="fedlify-proposal-review-files" aria-label="Files in this proposal">
          <div className="fedlify-proposal-review-files-head">{`${selectedCount} of ${files.length} file${files.length === 1 ? "" : "s"} selected`}</div>
          <ul>
            {files.map((file) => {
              const isAccepted = Boolean(accepted[file.path]);
              return (
                <li key={file.path} className={[file.path === current?.path ? "is-selected" : "", isAccepted ? "" : "is-skipped"].join(" ")}>
                  <Checkbox checked={isAccepted} disabled={stale || busy} onChange={(event) => onToggle?.(file.path, event.target.checked)} aria-label={`Include ${file.path} in the commit`} />
                  <button type="button" onClick={() => onSelect(file.path)} title={file.path} aria-current={file.path === current?.path ? "true" : undefined}>
                    <span className="fedlify-proposal-path">{file.path}</span>
                    <span className="fedlify-proposal-counts">
                      <span className="is-add">+{file.added}</span> <span className="is-del">-{file.removed}</span>
                      {file.action !== "update" ? <em> {file.action}</em> : null}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        <section className="fedlify-proposal-review-diff" aria-label={current ? `Changes in ${current.path}` : "Changes"}>
          {current ? (
            <>
              <div className="fedlify-proposal-review-filebar">
                <code title={current.path}>{current.path}</code>
                <span className="fedlify-muted">{`File ${index + 1} of ${files.length}`}</span>
                <Button size="small" icon={<LeftOutlined />} disabled={index === 0} onClick={() => onSelect(files[index - 1].path)} aria-label="Previous file" />
                <Button size="small" icon={<RightOutlined />} disabled={index === files.length - 1} onClick={() => onSelect(files[index + 1].path)} aria-label="Next file" />
                <Segmented size="small" value={accepted[current.path] ? "accept" : "reject"} disabled={stale || busy} aria-label={`Decision for ${current.path}`} options={[{ label: "Accept", value: "accept" }, { label: "Reject", value: "reject" }]} onChange={(value) => onToggle?.(current.path, value === "accept")} />
              </div>
              <div className="fedlify-proposal-review-editor">{renderDiff(current, { sideBySide: prefs.sideBySide, changesOnly: prefs.changesOnly })}</div>
            </>
          ) : null}
        </section>
      </div>

      <footer className="fedlify-proposal-review-foot">
        <Typography.Text className="fedlify-muted">{SCAN_NOTICE}</Typography.Text>
        <div className="fedlify-proposal-review-actions">
          <Button danger disabled={busy || !["PROPOSED", "STALE"].includes(proposal.status)} onClick={() => onReject?.()}>Reject proposal</Button>
          <Button type="primary" icon={<CheckCircleOutlined />} loading={busy} disabled={stale || selectedCount === 0} onClick={() => onAccept?.()}>
            {`Commit ${selectedCount} selected file${selectedCount === 1 ? "" : "s"}`}
          </Button>
        </div>
      </footer>
    </div>
  );
}
