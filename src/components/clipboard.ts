/** Thin wrapper around the Clipboard API, kept swappable and mockable in tests. */
export async function copyToClipboard(text: string): Promise<void> {
  return navigator.clipboard.writeText(text);
}
