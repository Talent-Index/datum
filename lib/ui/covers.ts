/**
 * Stand-in photographs for builds that have no listing image and no
 * evidence preview yet. They are illustrations of Kenyan residential
 * sites, not that build's own photographs.
 */
const COVERS = new Set(["willow-park-a", "ruiru-plot-12", "kitengela-3br", "nyeri-bungalow"]);

export function coverSrc(projectId: string | null | undefined): string {
  if (projectId && COVERS.has(projectId)) return `/covers/${projectId}.jpg`;
  return "/covers/default.jpg";
}
