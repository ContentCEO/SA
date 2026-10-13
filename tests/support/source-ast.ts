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

/** Every .ts / .tsx file under `dir` (default src/), as absolute paths. */
export function sourceFiles(dir: string = SRC): string[] {
  return (readdirSync(dir, { recursive: true, withFileTypes: true }) as import("node:fs").Dirent[])
    .filter((d) => d.isFile() && /\.(ts|tsx)$/.test(d.name) && !d.name.endsWith(".d.ts"))
    .map((d) => join(d.parentPath, d.name))
    .sort();
}

export function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
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
