/**
 * `moduleImports` — every module a piece of ESM source would load: static `import … from "x"`,
 * bare `import "x"`, `export … from "x"` and dynamic `import(…)`. The `bundle_not_self_contained`
 * rule for developer-built JS, where `deno info` (the Deno builder's check) is not available.
 *
 * A small tokenizer, not a parser: it skips comments, string and template literals (with nested
 * `${…}`) and regular-expression literals, so an `import` inside any of those is never counted.
 * `import.meta` is not an import. Runtime-neutral, no dependencies.
 */

/** Keywords after which a `/` starts a regular expression rather than a division. */
const REGEX_AFTER_WORD = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);

type Tok =
  | { t: "word"; v: string; dotBefore: boolean }
  | { t: "str" }
  | { t: "punct"; v: string };

const isIdStart = (c: string) => /[A-Za-z_$\u0080-￿]/.test(c);
const isIdPart = (c: string) => /[A-Za-z0-9_$\u0080-￿\\]/.test(c);

/** Tokenize just enough of `src` to find import forms. */
function tokens(src: string): Tok[] {
  const out: Tok[] = [];
  // Brace stack: `true` marks a `${` opened inside a template literal.
  const braces: boolean[] = [];
  let i = 0;
  const n = src.length;

  const regexAllowed = (): boolean => {
    const last = out[out.length - 1];
    if (last === undefined) return true;
    if (last.t === "str") return false;
    if (last.t === "word") return REGEX_AFTER_WORD.has(last.v) && !last.dotBefore;
    return !(last.v === ")" || last.v === "]" || last.v === "}");
  };

  /** Skip a template literal body starting AFTER the opening backtick (or a closing `}`). */
  const template = () => {
    while (i < n) {
      const c = src[i];
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "`") {
        i++;
        out.push({ t: "str" });
        return;
      }
      if (c === "$" && src[i + 1] === "{") {
        i += 2;
        braces.push(true);
        out.push({ t: "punct", v: "${" });
        return;
      }
      i++;
    }
  };

  while (i < n) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v") {
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n" && src[i] !== "\r") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      while (i < n && src[i] !== c) {
        if (src[i] === "\\") i++;
        i++;
      }
      i++;
      out.push({ t: "str" });
      continue;
    }
    if (c === "`") {
      i++;
      template();
      continue;
    }
    if (c === "/" && regexAllowed()) {
      i++;
      let inClass = false;
      while (i < n) {
        const r = src[i];
        if (r === "\\") {
          i += 2;
          continue;
        }
        if (r === "\n") break;
        if (inClass) {
          if (r === "]") inClass = false;
        } else if (r === "[") inClass = true;
        else if (r === "/") break;
        i++;
      }
      i++;
      while (i < n && isIdPart(src[i])) i++; // flags
      out.push({ t: "str" });
      continue;
    }
    if (isIdStart(c)) {
      const start = i;
      while (i < n && isIdPart(src[i])) i++;
      const prev = out[out.length - 1];
      out.push({
        t: "word",
        v: src.slice(start, i),
        dotBefore: prev?.t === "punct" && (prev.v === "." || prev.v === "?."),
      });
      continue;
    }
    if (c >= "0" && c <= "9") {
      while (i < n && /[0-9A-Za-z_.]/.test(src[i])) i++;
      out.push({ t: "word", v: "0", dotBefore: false });
      continue;
    }
    if (c === "{") {
      braces.push(false);
      out.push({ t: "punct", v: "{" });
      i++;
      continue;
    }
    if (c === "}") {
      i++;
      if (braces.pop() === true) {
        template();
        continue;
      }
      out.push({ t: "punct", v: "}" });
      continue;
    }
    if (c === "?" && src[i + 1] === ".") {
      out.push({ t: "punct", v: "?." });
      i += 2;
      continue;
    }
    if (c === "." && src[i + 1] === "." && src[i + 2] === ".") {
      out.push({ t: "punct", v: "..." });
      i += 3;
      continue;
    }
    out.push({ t: "punct", v: c });
    i++;
  }
  return out;
}

/** Whether the declaration holding the `from` at `k` is an `import …` (already counted). */
function startsWithImport(toks: Tok[], k: number): boolean {
  for (let j = k - 1; j >= 0; j--) {
    const t = toks[j];
    if (t.t === "punct" && t.v === ";") return false;
    if (t.t === "word" && !t.dotBefore && (t.v === "import" || t.v === "export")) {
      return t.v === "import";
    }
  }
  return false;
}

/**
 * Each import form found in `src`, as a short description (`static import`, `dynamic import()`,
 * `export … from`), deduplicated. Empty iff the module loads no other module.
 */
export function moduleImports(src: string): string[] {
  const toks = tokens(src);
  const found = new Set<string>();
  for (let k = 0; k < toks.length; k++) {
    const tok = toks[k];
    if (tok.t !== "word" || tok.dotBefore) continue;
    const next = toks[k + 1];
    if (tok.v === "import") {
      // `import.meta` is not an import; `{ import: … }` is a property key.
      if (next?.t === "punct" && (next.v === "." || next.v === ":")) continue;
      found.add(next?.t === "punct" && next.v === "(" ? "dynamic import()" : "static import");
      continue;
    }
    // `export … from "x"` (`export * from`, `export {a} from`, `export * as ns from`); outside a
    // module declaration `from` followed by a string literal is not valid syntax.
    if (tok.v === "from" && next?.t === "str") {
      const prev = toks[k - 1];
      if (
        prev !== undefined &&
        ((prev.t === "punct" && (prev.v === "}" || prev.v === "*")) || prev.t === "word") &&
        !startsWithImport(toks, k)
      ) {
        found.add("export … from");
      }
    }
  }
  return [...found];
}
