/**
 * `pnpm exec tsx tests/e2e/fakes/main.ts` — Playwright starts this next to the app
 * (playwright.config.ts). Port: E2E_FAKES_PORT, else PORT + 1 (3301 locally, 3101 in CI).
 */
import { startFakes } from "./server";

const port = Number(process.env.E2E_FAKES_PORT ?? Number(process.env.PORT ?? 3100) + 1);

startFakes(port).then(
  ({ url }) => console.log(`e2e fakes listening on ${url}`),
  (err: Error) => {
    console.error("e2e fakes failed to start", err.name);
    process.exit(1);
  },
);
