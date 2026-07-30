/** Whether `candidate` is `ancestor` itself or nested anywhere under it. */
export function isDescendantPath(candidate: string, ancestor: string): boolean {
  return candidate === ancestor || candidate.startsWith(`${ancestor}/`);
}
