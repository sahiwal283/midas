/**
 * `?batch=1` on a receipt upload means "more files are coming — do not run the
 * auto-approve/auto-push check yet".
 *
 * Without it, uploading several photos to a pending expense pushes to Zoho as
 * soon as the first one completes the expense, and the remaining photos land
 * after the push and never reach Zoho. The client sets the flag on every
 * upload of a batch except the last.
 *
 * Absent means false, so every existing caller keeps today's behaviour.
 * Parsed as a pure function so the condition is covered without a request.
 */
export function isBatchedUpload(raw: unknown): boolean {
  return raw === '1' || raw === 'true';
}
