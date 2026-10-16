import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import ts from "typescript";

/**
 * Small helpers for the static security tests (Milestone 11 S4): list source files and read
 * them as TypeScript syntax trees, so a check looks at code, not at comments or strings.
 */
export const ROOT = resolve(".");
export const SRC = join(ROOT, "src");

/** Repo-relative path with forward slashes ("src/app/(app)/queue/actions.ts"). */
export const rel = (file: string) => relative(ROOT, file).split(sep).join("/");

/**
 * Every file a build could run: TypeScript and JavaScript alike. tsconfig has `allowJs` and Next
 * serves route.js / page.jsx / a "use server" .js file by default, so a scan that read only
 * .ts / .tsx could be skipped by writing the file in JS (M11 review finding 3).
 */
export const SOURCE_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const DECLARATION_FILE = /\.d\.[mc]?ts$/;

/** Every source file (see SOURCE_FILE) under `dir` (default src/), as absolute paths. */
export function sourceFiles(dir: string = SRC): string[] {
  return (readdirSync(dir, { recursive: true, withFileTypes: true }) as import("node:fs").Dirent[])
    .filter((d) => d.isFile() && SOURCE_FILE.test(d.name) && !DECLARATION_FILE.test(d.name))
    .map((d) => join(d.parentPath, d.name))
    .sort();
}

/** How TypeScript should read a file, by its extension (JS files may hold JSX too). */
export function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.[mc]?js$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/** A syntax tree from text, for the self-tests' fixtures; the name picks TS or JS. */
export function parseText(file: string, code: string): ts.SourceFile {
  return ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, scriptKind(file));
}

export function parse(file: string): ts.SourceFile {
  return parseText(file, readFileSync(file, "utf8"));
}

/**
 * Files (absolute path → text) read as one program, for TypeScript's own scope rules: which
 * declaration an identifier really means (`checker.getSymbolAtLocation`), so a check can't be
 * fooled by a same-named outer `const`. No lib and no module resolution: names are bound, not
 * type-checked, which keeps it cheap enough for the whole of src.
 */
export function bindFiles(files: Map<string, string>): {
  program: ts.Program;
  checker: ts.TypeChecker;
} {
  const options: ts.CompilerOptions = {
    allowJs: true,
    noLib: true,
    noResolve: true,
    noEmit: true,
    types: [],
    jsx: ts.JsxEmit.Preserve,
    target: ts.ScriptTarget.Latest,
  };
  const host: ts.CompilerHost = {
    getSourceFile: (name) => {
      const text = files.get(name);
      return text === undefined ? undefined : parseText(name, text);
    },
    getDefaultLibFileName: () => join(ROOT, "__no_lib__.d.ts"),
    writeFile: () => {},
    getCurrentDirectory: () => ROOT,
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (f) => files.has(f),
    readFile: (f) => files.get(f),
  };
  const program = ts.createProgram([...files.keys()], options, host);
  return { program, checker: program.getTypeChecker() };
}

export type FnLike =
  ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration;

export function isFnLike(n: ts.Node): n is FnLike {
  return (
    ts.isFunctionDeclaration(n) ||
    ts.isFunctionExpression(n) ||
    ts.isArrowFunction(n) ||
    ts.isMethodDeclaration(n)
  );
}

/** True when a statement list starts with the "use server" directive. */
export function startsWithUseServer(statements: ts.NodeArray<ts.Statement> | undefined): boolean {
  const first = statements?.[0];
  return (
    !!first &&
    ts.isExpressionStatement(first) &&
    ts.isStringLiteral(first.expression) &&
    first.expression.text === "use server"
  );
}

/** The awaited expressions in a function body, in source order, not entering nested functions. */
export function awaitsIn(fn: FnLike): ts.AwaitExpression[] {
  const out: ts.AwaitExpression[] = [];
  const visit = (n: ts.Node) => {
    if (n !== fn && isFnLike(n)) return;
    if (ts.isAwaitExpression(n)) out.push(n);
    ts.forEachChild(n, visit);
  };
  if (fn.body) ts.forEachChild(fn.body, visit);
  return out;
}

/** "requireOwner" for `await requireOwner()`, "cookies" for `(await cookies()).x`, else null. */
export function calleeName(e: ts.AwaitExpression): string | null {
  let x: ts.Expression = e.expression;
  while (ts.isParenthesizedExpression(x)) x = x.expression;
  if (!ts.isCallExpression(x)) return null;
  const c = x.expression;
  if (ts.isIdentifier(c)) return c.text;
  if (ts.isPropertyAccessExpression(c)) return c.getText();
  return null;
}

/** Exported functions of a module: `export async function f` and `export const f = async () =>`. */
export function exportedFunctions(sf: ts.SourceFile): { name: string; fn: FnLike }[] {
  const out: { name: string; fn: FnLike }[] = [];
  const exported = (n: ts.Node) =>
    ts.canHaveModifiers(n) &&
    (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name && exported(st)) {
      out.push({ name: st.name.text, fn: st });
    } else if (ts.isVariableStatement(st) && exported(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer && isFnLike(d.initializer)) {
          out.push({ name: d.name.text, fn: d.initializer });
        }
      }
    }
  }
  return out;
}

/**
 * Exports that `exportedFunctions` doesn't read as a function: `export { f }`, `export … from`,
 * `export default`, `export const f = wrap(…)` and the like. Type-only exports are fine (they
 * vanish at build). In a "use server" file each of these is still a callable action, so the
 * security scan lists them instead of skipping them.
 */
export function otherExports(sf: ts.SourceFile): string[] {
  const out: string[] = [];
  const mods = (n: ts.Node) => (ts.canHaveModifiers(n) ? (ts.getModifiers(n) ?? []) : []);
  const has = (n: ts.Node, k: ts.SyntaxKind) => mods(n).some((m) => m.kind === k);
  for (const st of sf.statements) {
    if (ts.isExportDeclaration(st)) {
      if (!st.isTypeOnly) out.push(st.getText());
    } else if (ts.isExportAssignment(st)) {
      out.push(st.getText());
    } else if (ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)) {
      continue;
    } else if (has(st, ts.SyntaxKind.DefaultKeyword)) {
      out.push(st.getText().split("\n")[0]!);
    } else if (!has(st, ts.SyntaxKind.ExportKeyword)) {
      continue;
    } else if (ts.isFunctionDeclaration(st) && st.name) {
      continue;
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations)
        if (!(ts.isIdentifier(d.name) && d.initializer && isFnLike(d.initializer)))
          out.push(`export ${d.name.getText()}`);
    } else {
      out.push(st.getText().split("\n")[0]!);
    }
  }
  return out;
}

/** Top-level, non-exported function declarations by name (helpers like `askFor`). */
export function localFunctions(sf: ts.SourceFile): Map<string, FnLike> {
  const out = new Map<string, FnLike>();
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name) out.set(st.name.text, st);
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer && isFnLike(d.initializer)) {
          out.set(d.name.text, d.initializer);
        }
      }
    }
  }
  return out;
}

/** Every node in a tree, depth-first in source order. */
export function walk(root: ts.Node, visit: (n: ts.Node) => void) {
  const go = (n: ts.Node) => {
    visit(n);
    ts.forEachChild(n, go);
  };
  go(root);
}

export { ts };
