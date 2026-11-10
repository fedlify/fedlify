/**
 * The human sign-off for a participant site. Connectivity and the installed kit are checked live when a run starts, so
 * they are deliberately not part of this: a site that is offline when its staff save the form is still signed off.
 * Kept free of server-only imports so client pages can use it too.
 */
export type SiteSignoffInput = {
  dependenciesVerified?: boolean | null;
  policyAccepted?: boolean | null;
};

export function siteSignedOff(check: SiteSignoffInput | null | undefined): boolean {
  return Boolean(check?.dependenciesVerified && check?.policyAccepted);
}
