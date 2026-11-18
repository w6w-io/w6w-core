/**
 * The slice of `node:path` this package uses, attached with `// @ts-types`. Core's root
 * `package.json` puts Deno in manual `node_modules` mode, where a plain `node:` import makes the
 * type checker look for `@types/node` in a `node_modules/` that does not exist. Turning that mode
 * off instead (`"nodeModulesDir": "none"`) lets a sandboxed Worker fetch `npm:` packages, so the
 * runtime's npm denial would fail. Runtime behaviour is Node's and Deno's own `node:path`.
 */
export const sep: string;
export function basename(path: string, suffix?: string): string;
export function dirname(path: string): string;
export function extname(path: string): string;
export function isAbsolute(path: string): boolean;
export function join(...paths: string[]): string;
export function normalize(path: string): string;
export function relative(from: string, to: string): string;
export function resolve(...paths: string[]): string;
