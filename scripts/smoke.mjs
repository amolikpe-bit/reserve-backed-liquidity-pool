// Fast deploy-compatibility oracle for one wasm variant. Reuses the existing
// harness (bootSandbox deploys + initializes the pool, then a view is taken).
// Set POOL_WASM / MOCK_FT_WASM to the wasm files under test. Exits explicitly so
// a lingering sandbox child cannot hold the event loop open.
import { bootSandbox, stopSandbox, view } from "./lib/harness.js";

const started = Date.now();
let sandbox;
try {
  const ctx = await bootSandbox();
  sandbox = ctx.sandbox;
  const name = await view(ctx.provider, ctx.poolId, "pool_name");
  const version = await view(ctx.provider, ctx.poolId, "pool_version");
  console.log(`DEPLOY_OK pool_name=${JSON.stringify(name)} pool_version=${JSON.stringify(version)} ms=${Date.now() - started}`);
} catch (error) {
  console.log(`DEPLOY_FAIL ms=${Date.now() - started} error=${String(error?.message ?? error).slice(0, 600)}`);
  process.exitCode = 1;
} finally {
  await stopSandbox(sandbox);
  process.exit(process.exitCode ?? 0);
}
