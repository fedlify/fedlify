/**
 * POST /api/v1/studies/[studyId]/pipeline/quick-deploy  (retired)
 *
 * The one-shot "approve for deployment" path came from the legacy pipeline agent.
 * Pipelines are now built and published from study projects, where every change
 * is accepted by a person before it is saved or published.
 */

import { problem } from "@/lib/json";

export async function POST() {
  return problem(
    410,
    "Quick deploy has been retired. Open the study's Projects page to edit your pipeline and use Publish there.",
    "gone"
  );
}
