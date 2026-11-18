/**
 * The slice of `node:fs/promises` this package uses, attached with `// @ts-types` (see
 * `./path.d.ts` for why). Runtime behaviour is Node's and Deno's own module.
 */
export interface Stats {
  size: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}
export interface Dirent {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}
export function lstat(path: string): Promise<Stats>;
export function stat(path: string): Promise<Stats>;
export function readFile(path: string): Promise<Uint8Array>;
export function readFile(path: string, encoding: "utf8" | "utf-8"): Promise<string>;
export function readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>;
export function realpath(path: string): Promise<string>;
export function mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined>;
export function mkdtemp(prefix: string): Promise<string>;
export function writeFile(path: string, data: string | Uint8Array): Promise<void>;
export function rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
