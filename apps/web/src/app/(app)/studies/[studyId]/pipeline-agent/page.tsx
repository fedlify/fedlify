import { redirect } from "next/navigation";

/**
 * Legacy pipeline agent, retired. Pipelines are now built in study projects
 * (/studies/[id]/projects) with accept-gated assistant proposals.
 * Old bookmarks and links land there; the old mode/templateId query is dropped.
 */
export default async function PipelineAgentRedirect({ params }: { params: Promise<{ studyId: string }> }) {
  const { studyId } = await params;
  redirect(`/studies/${encodeURIComponent(studyId)}/projects`);
}
