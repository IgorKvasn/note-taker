import type { RootConfig } from "./ipc";

/** Whether `candidate` is `ancestor` itself or nested anywhere under it. */
export function isDescendantPath(candidate: string, ancestor: string): boolean {
  return candidate === ancestor || candidate.startsWith(`${ancestor}/`);
}

/** Derives a root's display label from the last segment of its folder path. */
export function rootLabel(root: RootConfig): string {
  const normalized = root.path.replace(/\/+$/, "");
  const lastSegment = normalized.split("/").pop();
  return lastSegment && lastSegment.length > 0 ? lastSegment : root.path;
}
