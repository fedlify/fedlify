"use client";

import { Alert, Typography } from "antd";
import { useState } from "react";
import { SitesTable } from "@/components/SitesTable";
import { SiteModal } from "./StudyFormModals";

/** The study's Sites page: the one Sites table, plus the Add site form and the one-time site access code. */
export function SitesSection({
  studyId,
  onChanged,
}: {
  studyId: string;
  onChanged: () => void | Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const [accessCode, setAccessCode] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const changed = async () => {
    setRefresh((value) => value + 1);
    await onChanged();
  };

  return (
    <div className="fedlify-section-stack">
      {accessCode ? (
        <Alert
          type="success"
          showIcon
          message="Site access code (shown once)"
          description={
            <div>
              <p style={{ margin: 0 }}>
                Give this code to the person setting up the site&apos;s
                computer. You will not see it again, so keep it private.
              </p>
              <Typography.Text code copyable={{ text: accessCode }}>
                {accessCode}
              </Typography.Text>
            </div>
          }
        />
      ) : null}
      <SitesTable
        studyId={studyId}
        onRegister={() => setAdding(true)}
        onInvited={changed}
        refreshKey={refresh}
      />
      <SiteModal
        open={adding}
        studyId={studyId}
        onClose={() => setAdding(false)}
        onSaved={changed}
        onAdded={setAccessCode}
      />
    </div>
  );
}
