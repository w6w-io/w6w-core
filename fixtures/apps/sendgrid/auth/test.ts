/**
 * Connect-time credential check. Required by the Auth RFC. Not exercised by
 * invoke() in this slice; declared so the app is spec-complete.
 */
export default () => ({ ok: true });
