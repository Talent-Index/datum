import Image from "next/image";

import { coverSrc } from "./covers";

export { coverSrc } from "./covers";

export function ProjectCover({
  projectId,
  alt,
  sizes = "(max-width: 900px) 100vw, 480px",
  priority = false,
}: {
  projectId?: string | null;
  alt: string;
  sizes?: string;
  priority?: boolean;
}) {
  return <Image src={coverSrc(projectId)} alt={alt} fill priority={priority} sizes={sizes} />;
}
