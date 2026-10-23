/** Masked preview for the settings page and logs, e.g. `sk-a…9xQ (51)`. Safe for client bundles. */
export function maskValue(value: string): string {
  if (value.length <= 6) return `${value.slice(0, 1)}***`;
  const head = value.slice(0, Math.min(4, Math.floor(value.length / 4)));
  const tail = value.slice(-Math.min(3, Math.floor(value.length / 6)));
  return `${head}…${tail} (${value.length})`;
}
