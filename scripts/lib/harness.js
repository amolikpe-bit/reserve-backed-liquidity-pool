import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
  Account,
  JsonRpcProvider,
  KeyPair,
  actions,
  nearToYocto,
  teraToGas,
} from "near-api-js";
import { Sandbox, DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY } from "near-sandbox";

// Wave-3 teardown guard. Node's --test-force-exit skips after() hooks, so a
// sandbox child can survive the runner. Register each sandbox and kill its
// child synchronously on process exit or on a termination signal.
const liveSandboxes = new Set();

function killLiveSandboxes() {
  for (const sandbox of liveSandboxes) {
    try {
      sandbox.childProcess?.kill("SIGKILL");
    } catch {
      // The child already exited; nothing is left to stop.
    }
  }
  liveSandboxes.clear();
}

process.once("exit", killLiveSandboxes);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    killLiveSandboxes();
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
}

export const ONE = 10n ** 18n;
export const TOKEN_SCALE = 1_000n * ONE;
export const POOL_WASM = process.env.POOL_WASM ?? "target/near/krater_pool/krater_pool.wasm";
export const MOCK_FT_WASM =
  process.env.MOCK_FT_WASM ?? "target/near/krater_mock_ft/krater_mock_ft.wasm";
export const RPC_URL = process.env.RPC_URL;
const gasCache = new Map();

export const GAS = (tgas) => {
  let value = gasCache.get(tgas);
  if (value === undefined) {
    value = teraToGas(String(tgas));
    gasCache.set(tgas, value);
  }
  return value;
};

// Client gas budgets in Tgas. The pool's reserve-sync chain is static gas
// (callbacks 90/80/70/60, 25 to fill, 45 to settle), so each attachment funds
// the whole chain it starts; one function call may attach up to 1000 Tgas.
export const GAS_CREDIT = 200;
export const GAS_ADD_LIQUIDITY = 300;
export const GAS_WITHDRAW = 300;
export const GAS_SYNC = 100;
export const GAS_PAYOUT = 100;

export function requireEnv(name, hint) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required when RPC_URL is set; ${hint}`);
  }
  return value;
}

export async function readWasm(path) {
  if (!existsSync(path)) {
    throw new Error(
      `missing wasm at ${path}; run "cargo near build non-reproducible-wasm" ` +
        "first, or set POOL_WASM/MOCK_FT_WASM",
    );
  }
  return new Uint8Array(await readFile(path));
}

export function call(account, contractId, methodName, args, { gas = 60, deposit = "0" } = {}) {
  return account.callFunction({
    contractId,
    methodName,
    args,
    gas: GAS(gas),
    deposit,
    waitUntil: "FINAL",
  });
}

export function callRaw(account, contractId, methodName, args, { gas = 60, deposit = "0" } = {}) {
  return account.callFunctionRaw({
    contractId,
    methodName,
    args,
    gas: GAS(gas),
    deposit,
    waitUntil: "FINAL",
  });
}

export function view(provider, contractId, method, args = {}) {
  return provider.callFunction({ contractId, method, args });
}

export function logsOf(outcome) {
  const logs = [];
  for (const receipt of outcome.receipts_outcome ?? []) {
    logs.push(...(receipt.outcome?.logs ?? []));
  }
  logs.push(...(outcome.transaction_outcome?.outcome?.logs ?? []));
  return logs;
}

export function kraterEvents(outcome) {
  return logsOf(outcome)
    .filter((line) => line.startsWith("EVENT_JSON:"))
    .map((line) => JSON.parse(line.slice("EVENT_JSON:".length)))
    .filter((event) => event.standard === "krater");
}

const NEAR_SUFFIX = /\s*NEAR$/i;
const yoctoCache = new Map();

export function toYocto(near) {
  const key = String(near);
  let value = yoctoCache.get(key);
  if (value === undefined) {
    value = nearToYocto(key.trim().replace(NEAR_SUFFIX, ""));
    yoctoCache.set(key, value);
  }
  return value;
}

// Near-zero recompute instrumentation: distinct inputs cached, not total calls.
export const recomputeCounters = () => ({ gas: gasCache.size, yocto: yoctoCache.size });

export async function createAccount(provider, payer, accountId, nearAmount) {
  const keyPair = KeyPair.fromRandom("ED25519");
  await payer.signAndSendTransaction({
    receiverId: accountId,
    actions: [
      actions.createAccount(),
      actions.transfer(toYocto(nearAmount)),
      actions.addFullAccessKey(keyPair.getPublicKey()),
    ],
  });
  return new Account(accountId, provider, keyPair.toString());
}

export async function deploy(account, contractId, wasm) {
  await account.signAndSendTransaction({
    receiverId: contractId,
    actions: [actions.deployContract(wasm)],
  });
}

export async function register(payer, contractId, accountId) {
  await call(
    payer,
    contractId,
    "storage_deposit",
    { account_id: accountId },
    { gas: 30, deposit: nearToYocto("0.02") },
  );
}

export async function bootSandbox({
  shareName = "Krater Demo LP",
  shareSymbol = "K-LP-demo",
  withCarol = false,
} = {}) {
  const sandbox = await Sandbox.start({});
  liveSandboxes.add(sandbox);
  const provider = new JsonRpcProvider({ url: sandbox.rpcUrl });
  const root = new Account(DEFAULT_ACCOUNT_ID, provider, DEFAULT_PRIVATE_KEY);
  const suffix = DEFAULT_ACCOUNT_ID;

  const [poolWasm, mockWasm] = await Promise.all([readWasm(POOL_WASM), readWasm(MOCK_FT_WASM)]);

  const poolId = `pool.${suffix}`;
  const rebasingId = `rebasing.${suffix}`;
  const taxedId = `taxed.${suffix}`;
  const aliceId = `alice.${suffix}`;

  const pool = await createAccount(provider, root, poolId, "20 NEAR");
  const rebasing = await createAccount(provider, root, rebasingId, "20 NEAR");
  const taxed = await createAccount(provider, root, taxedId, "20 NEAR");
  const alice = await createAccount(provider, root, aliceId, "20 NEAR");
  const carol = withCarol
    ? await createAccount(provider, root, `carol.${suffix}`, "20 NEAR")
    : undefined;

  await deploy(pool, poolId, poolWasm);
  await deploy(rebasing, rebasingId, mockWasm);
  await deploy(taxed, taxedId, mockWasm);

  await call(pool, poolId, "new", {
    token_a: rebasingId,
    token_b: taxedId,
    swap_fee_bps: 30,
    share_name: shareName,
    share_symbol: shareSymbol,
  }, { gas: 100 });
  await call(rebasing, rebasingId, "new", {
    name: "Krater Rebasing Fixture",
    symbol: "kREB",
  }, { gas: 30 });
  await call(taxed, taxedId, "new", {
    name: "Krater Taxed Fixture",
    symbol: "kTAX",
  }, { gas: 30 });

  return {
    mode: "sandbox",
    network: "sandbox",
    sandbox,
    provider,
    poolId,
    rebasingId,
    taxedId,
    alice,
    carol,
    pool,
    payer: root,
  };
}

export async function attachRpc({ requireCarol = false } = {}) {
  const provider = new JsonRpcProvider({ url: RPC_URL });
  const poolId = requireEnv("KRATER_CONTRACT", "unset RPC_URL to run the sandbox instead");
  const rebasingId = requireEnv("REBASING_ACCOUNT", "unset RPC_URL to run the sandbox instead");
  const taxedId = requireEnv("TAXED_ACCOUNT", "unset RPC_URL to run the sandbox instead");
  const alice = new Account(
    requireEnv("DEMO_ACCOUNT", "unset RPC_URL to run the sandbox instead"),
    provider,
    requireEnv("KRATER_PRIVATE_KEY", "unset RPC_URL to run the sandbox instead"),
  );
  const carol = requireCarol
    ? new Account(
        requireEnv("CAROL_ACCOUNT", "unset RPC_URL to measure in a sandbox instead"),
        provider,
        requireEnv("CAROL_PRIVATE_KEY", "unset RPC_URL to measure in a sandbox instead"),
      )
    : undefined;

  try {
    await view(provider, poolId, "pool_name");
  } catch (error) {
    throw new Error(
      `no krater pool answered at ${poolId}; deploy it with scripts/deploy.sh first`,
      { cause: error },
    );
  }

  return {
    mode: "rpc",
    network: RPC_URL,
    sandbox: null,
    provider,
    poolId,
    rebasingId,
    taxedId,
    alice,
    carol,
    payer: alice,
  };
}
