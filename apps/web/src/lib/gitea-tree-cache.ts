import { listGiteaTreePaths } from "@/lib/gitea";

type Tree = Awaited<ReturnType<typeof listGiteaTreePaths>>;
const cache = new Map<string, Tree>();

/** A commit's tree never changes, so clicking through files re-reads nothing from Gitea. Callers check access before any lookup. */
export async function cachedTree(repo: { owner: string; repo: string }, ref: string): Promise<Tree> {
  const key = `${repo.owner}/${repo.repo}@${ref}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const tree = await listGiteaTreePaths({ ...repo, ref });
  if (cache.size >= 50) cache.delete(cache.keys().next().value as string);
  cache.set(key, tree);
  return tree;
}

export function clearTreeCache() {
  cache.clear();
}
