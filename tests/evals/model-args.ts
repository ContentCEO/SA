/**
 * Check 48 P2: `pnpm eval --model classify=<id>` (and draft= / voice=) runs the eval set on
 * another model without changing src/config/models.ts. Only ids in `EVAL_MODEL_IDS` are taken,
 * so a typo can't send the set to a model we have no price or capability row for.
 */
import { EVAL_MODEL_IDS, type ModelId, type ModelRole } from "../../src/config/models";

const ROLES: readonly ModelRole[] = ["classify", "draft", "voice"];

export class EvalArgsError extends Error {
  override readonly name = "EvalArgsError";
}

/** Reads every `--model role=id` (or `--model=role=id`) from the arguments. */
export function parseModelArgs(argv: readonly string[]): Partial<Record<ModelRole, ModelId>> {
  const out: Partial<Record<ModelRole, ModelId>> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    let value: string | undefined;
    if (arg === "--model") value = argv[++i];
    else if (arg.startsWith("--model=")) value = arg.slice("--model=".length);
    else continue;
    const m = /^([a-z]+)=(.+)$/.exec(value ?? "");
    if (!m) throw new EvalArgsError(`--model needs role=id, for example classify=<model id>.`);
    const [, role, id] = m as unknown as [string, string, string];
    if (!(ROLES as readonly string[]).includes(role)) {
      throw new EvalArgsError(`Unknown role "${role}". Use one of: ${ROLES.join(", ")}.`);
    }
    if (!(EVAL_MODEL_IDS as readonly string[]).includes(id)) {
      throw new EvalArgsError(
        `Model "${id}" isn't in EVAL_MODEL_IDS (src/config/models.ts): ${EVAL_MODEL_IDS.join(", ")}.`,
      );
    }
    out[role as ModelRole] = id as ModelId;
  }
  return out;
}
