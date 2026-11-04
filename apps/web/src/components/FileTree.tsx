"use client";

import { DownOutlined, FileTextOutlined, FolderOpenOutlined, FolderOutlined, RightOutlined } from "@ant-design/icons";
import { useMemo, useState } from "react";

type TreeNode = { type: "folder" | "file"; name: string; path: string; children: TreeNode[] };

export function buildPathTree(paths: string[]): TreeNode[] {
  const root: TreeNode = { type: "folder", name: "", path: "", children: [] };
  for (const path of [...paths].sort()) {
    const parts = path.split("/").filter(Boolean);
    let cursor = root;
    parts.forEach((part, index) => {
      const nodePath = parts.slice(0, index + 1).join("/");
      const isFile = index === parts.length - 1;
      let next = cursor.children.find((child) => child.path === nodePath);
      if (!next) {
        next = { type: isFile ? "file" : "folder", name: part, path: nodePath, children: [] };
        cursor.children.push(next);
      }
      cursor = next;
    });
  }
  const order = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "folder" ? -1 : 1));
    nodes.forEach((node) => order(node.children));
  };
  order(root.children);
  return root.children;
}

type FileTreeProps = {
  paths: string[];
  selectedPath: string | null;
  /** Files with unsaved edits, shown with an "M" marker. */
  modifiedPaths?: string[];
  onSelect: (path: string) => void;
};

export function FileTree({ paths, selectedPath, modifiedPaths = [], onSelect }: FileTreeProps) {
  const tree = useMemo(() => buildPathTree(paths), [paths]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const modified = new Set(modifiedPaths);

  function toggle(path: string) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function render(nodes: TreeNode[], depth = 0) {
    return nodes.map((node) => {
      const paddingLeft = 10 + depth * 16;
      if (node.type === "folder") {
        const isCollapsed = collapsed.has(node.path);
        return (
          <div key={node.path} className="fedlify-code-tree-group">
            <button className="fedlify-code-tree-row is-folder" onClick={() => toggle(node.path)} style={{ paddingLeft }} type="button" aria-expanded={!isCollapsed}>
              {isCollapsed ? <RightOutlined /> : <DownOutlined />}
              {isCollapsed ? <FolderOutlined /> : <FolderOpenOutlined />}
              <span>{node.name}</span>
            </button>
            {isCollapsed ? null : render(node.children, depth + 1)}
          </div>
        );
      }
      return (
        <button
          key={node.path}
          className={["fedlify-code-tree-row", node.path === selectedPath ? "is-selected" : ""].filter(Boolean).join(" ")}
          onClick={() => onSelect(node.path)}
          style={{ paddingLeft }}
          type="button"
          aria-current={node.path === selectedPath ? "true" : undefined}
        >
          <span />
          <FileTextOutlined />
          <span>{node.name}</span>
          {modified.has(node.path) ? <span className="fedlify-ws-modified" title="Unsaved edits">M</span> : null}
        </button>
      );
    });
  }

  if (paths.length === 0) return <div className="fedlify-muted fedlify-ws-empty">No files loaded.</div>;
  return (
    <div className="fedlify-code-tree" role="tree" aria-label="Repository files">
      {render(tree)}
    </div>
  );
}
