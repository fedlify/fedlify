"use client";

import { Empty, Table } from "antd";
import type { TableProps } from "antd";
import type { ReactNode } from "react";

type RecordTableProps<T extends object> = Omit<TableProps<T>, "size" | "scroll" | "locale"> & {
  /** Shown when there are no rows. */
  emptyText?: ReactNode;
};

/** The one table for record pages (Sites, Results, Audit): compact, horizontally scrollable, consistent empty state. */
export function RecordTable<T extends object>({ emptyText, className, ...props }: RecordTableProps<T>) {
  return (
    <Table<T>
      size="small"
      scroll={{ x: "max-content" }}
      className={["fedlify-record-table", className].filter(Boolean).join(" ")}
      locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyText ?? "No records"} /> }}
      {...props}
    />
  );
}
