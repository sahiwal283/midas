/**
 * Hand-off slot for a photo captured from the bottom-nav camera button.
 *
 * Mobile browsers only open the camera from a file input activated
 * synchronously inside a user gesture — a programmatic click after
 * navigation is silently blocked. So the nav owns the input and passes the
 * captured file here for ExpenseNew to consume on mount.
 */
let pending: File | null = null;

export function setPendingCapture(file: File): void {
  pending = file;
}

/** Returns the captured file once, then clears the slot. */
export function takePendingCapture(): File | null {
  const file = pending;
  pending = null;
  return file;
}
