"use client";

import type { AccessControlProvider } from "@refinedev/core";

export const accessControlProvider: AccessControlProvider = {
  can: async ({ resource, action }) => {
    const response = await fetch("/api/v1/me", { cache: "no-store" });
    if (!response.ok) return { can: false };

    const data = await response.json();
    const platformRole = data.user?.platformRole;
    const isAuditor = platformRole === "AUDITOR";

    if (platformRole === "PLATFORM_ADMIN") return { can: true };
    if (isAuditor && action !== "delete") return { can: true };
    if (resource === "audit" && !isAuditor) return { can: false };

    return { can: true };
  }
};
