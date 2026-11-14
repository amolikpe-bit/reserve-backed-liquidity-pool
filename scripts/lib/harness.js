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

// Guard against an orphaned sandbox child. Node's --test-force-exit skips
// after() hooks, so a sandbox child can survive the runner. Register each
// sandbox and kill its child on process exit or on a termination signal.
const sandboxes = new Set();

function killSandboxes() {
  for (const sandbox of sandboxes) {
    try {
      sandbox.childProcess?.kill("SIGKILL");
    } catch {
      // The child already exited; nothing is left to stop.
    }
  }
  sandboxes.clear();
}

export async function startSandbox() {
  const sandbox = await Sandbox.start({});
  sandboxes.add(sandbox);
  return sandbox;
}

export async function stopSandbox(sandbox) {
  if (!sandbox) return;
  await Promise.race([
    sandbox.tearDown().catch(() => {}),
    new Promise((resolve) => {
      const timer = setTimeout(resolve, 5_000);
      timer.unref();
    }),
  ]);
  try {
    sandbox.childProcess?.kill("SIGKILL");
  } catch {
    // Already exited.
  }
  sandboxes.delete(sandbox);
}

process.once("exit", killSandboxes);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    killSandboxes();
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

export function parseEvents(outcome, seenEvents) {
  const events = logsOf(outcome)
    .filter((line) => line.startsWith("EVENT_JSON:"))
    .map((line) => JSON.parse(line.slice("EVENT_JSON:".length)));
  if (seenEvents) {
    for (const event of events) {
      if (event.standard === "krater") seenEvents.set(event.event, event);
    }
  }
  return events;
}

export function kraterEvents(outcome) {
  return parseEvents(outcome).filter((event) => event.standard === "krater");
}

export function ftTransfers(outcome) {
  return parseEvents(outcome)
    .filter((event) => event.event === "ft_transfer")
    .flatMap((event) => (Array.isArray(event.data) ? event.data : [event.data]));
}

export async function balances(provider, tokenIds, accountId) {
  const [a, b] = await Promise.all(
    tokenIds.map((token) => view(provider, token, "ft_balance_of", { account_id: accountId })),
  );
  return { a: BigInt(a), b: BigInt(b) };
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
export const cacheCounts = () => ({ gas: gasCache.size, yocto: yoctoCache.size });

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

export async function createAccounts(provider, payer, specs) {
  if (specs.length <= 1) {
    const out = [];
    for (const [id, amt] of specs) out.push(await createAccount(provider, payer, id, amt));
    return out;
  }
  const keys = specs.map(() => KeyPair.fromRandom("ED25519"));
  await payer.signAndSendTransaction({
    receiverId: payer.accountId,
    actions: keys.map((kp) => actions.addFullAccessKey(kp.getPublicKey())),
  });
  return Promise.all(
    specs.map(([id, amt], i) =>
      createAccount(provider, new Account(payer.accountId, provider, keys[i].toString()), id, amt),
    ),
  );
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
    { gas: 30, deposit: toYocto("0.02") },
  );
}

export async function bootSandbox({
  shareName = "Krater Demo LP",
  shareSymbol = "K-LP-demo",
  withCarol = false,
} = {}) {
  const sandbox = await startSandbox();
  const provider = new JsonRpcProvider({ url: sandbox.rpcUrl });
  const root = new Account(DEFAULT_ACCOUNT_ID, provider, DEFAULT_PRIVATE_KEY);
  const suffix = DEFAULT_ACCOUNT_ID;

  const [poolWasm, mockWasm] = await Promise.all([readWasm(POOL_WASM), readWasm(MOCK_FT_WASM)]);

  const poolId = `pool.${suffix}`;
  const rebasingId = `rebasing.${suffix}`;
  const taxedId = `taxed.${suffix}`;
  const aliceId = `alice.${suffix}`;

  const specs = [
    [poolId, "20 NEAR"],
    [rebasingId, "20 NEAR"],
    [taxedId, "20 NEAR"],
    [aliceId, "20 NEAR"],
  ];
  if (withCarol) specs.push([`carol.${suffix}`, "20 NEAR"]);
  const [pool, rebasing, taxed, alice, carol] = await createAccounts(provider, root, specs);

  await Promise.all([
    deploy(pool, poolId, poolWasm),
    deploy(rebasing, rebasingId, mockWasm),
    deploy(taxed, taxedId, mockWasm),
  ]);

  await Promise.all([
    call(pool, poolId, "new", {
      token_a: rebasingId,
      token_b: taxedId,
      swap_fee_bps: 30,
      share_name: shareName,
      share_symbol: shareSymbol,
    }, { gas: 100 }),
    call(rebasing, rebasingId, "new", {
      name: "Krater Rebasing Fixture",
      symbol: "kREB",
    }, { gas: 30 }),
    call(taxed, taxedId, "new", {
      name: "Krater Taxed Fixture",
      symbol: "kTAX",
    }, { gas: 30 }),
  ]);
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
