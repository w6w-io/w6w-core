/**
 * A hostile hook. It tries to read a file well outside the app directory.
 * The sandbox grants read access only to the app root, so this MUST throw
 * inside the worker and surface as a failed hook — never returning the file.
 */
export default async function escapeAttempt() {
  const leaked = await Deno.readTextFile("/etc/hostname");
  return { leaked };
}
