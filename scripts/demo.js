#!/usr/bin/env node
// Krater demo: deposit credits, add liquidity, quote, swap, rebase, sync, withdraw.
//
// Default (RPC_URL unset): boots a near-kit sandbox, deploys the built wasm, and
// runs the whole loop with zero-funds accounts. Set RPC_URL to run against a live
// network instead, in which case KRATER_CONTRACT, REBASING_ACCOUNT, TAXED_ACCOUNT,
// DEMO_ACCOUNT and KRATER_PRIVATE_KEY must all be set and the contracts must
// already be deployed and initialised (scripts/deploy.sh does that).
//
// Build first: cargo near build. Override the wasm paths with POOL_WASM and
// MOCK_FT_WASM.

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
import { Sandbox } from "near-kit/sandbox";

const ONE = 10n ** 18n;
const TOKEN_SCALE = 1_000n * ONE;
const SWAP_IN = 10n * ONE;

const POOL_WASM = process.env.POOL_WASM ?? "target/near/krater_pool.wasm";
const MOCK_FT_WASM = process.env.MOCK_FT_WASM ?? "target/near/krater_mock_ft.wasm";
const RPC_URL = process.env.RPC_URL;
const GAS = (tgas) => teraToGas(String(tgas));

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is required when RPC_URL is set; unset RPC_URL to run the sandbox demo instead`,
    );
  }
  return value;
}

async function readWasm(path) {
  if (!existsSync(path)) {
    throw new Error(
      `missing wasm at ${path}; run "cargo near build" first, or set POOL_WASM/MOCK_FT_WASM`,
    );
  }
  return new Uint8Array(await readFile(path));
}

function call(account, contractId, methodName, args, { gas = 60, deposit = "0" } = {}) {
  return account.callFunction({
    contractId,
    methodName,
    args,
    gas: GAS(gas),
    deposit,
  });
}

function view(provider, contractId, method, args = {}) {
  return provider.callFunction({ contractId, method, args });
}

function toYocto(near) {
  return nearToYocto(String(near).trim().replace(/\s*NEAR$/i, ""));
}

async function createAccount(provider, payer, accountId, nearAmount) {
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

async function deploy(account, contractId, wasm) {
  await account.signAndSendTransaction({
    receiverId: contractId,
    actions: [actions.deployContract(wasm)],
  });
}

async function register(payer, contractId, accountId) {
  await call(
    payer,
    contractId,
    "storage_deposit",
    { account_id: accountId },
    { gas: 30, deposit: nearToYocto("0.02") },
  );
}

async function bootSandbox() {
  const sandbox = await Sandbox.start();
  const provider = new JsonRpcProvider({ url: sandbox.rpcUrl });
  const root = new Account(sandbox.rootAccount.id, provider, sandbox.rootAccount.secretKey);
  const suffix = sandbox.rootAccount.id;

  const [poolWasm, mockWasm] = await Promise.all([readWasm(POOL_WASM), readWasm(MOCK_FT_WASM)]);

  const poolId = `pool.${suffix}`;
  const rebasingId = `rebasing.${suffix}`;
  const taxedId = `taxed.${suffix}`;
  const aliceId = `alice.${suffix}`;

  const pool = await createAccount(provider, root, poolId, "20 NEAR");
  const rebasing = await createAccount(provider, root, rebasingId, "20 NEAR");
  const taxed = await createAccount(provider, root, taxedId, "20 NEAR");
  const alice = await createAccount(provider, root, aliceId, "20 NEAR");

  await deploy(pool, poolId, poolWasm);
  await deploy(rebasing, rebasingId, mockWasm);
  await deploy(taxed, taxedId, mockWasm);

  // The deployer of each contract initialises it.
  await call(pool, poolId, "new", {
    token_a: rebasingId,
    token_b: taxedId,
    swap_fee_bps: 30,
    share_name: "Krater Demo LP",
    share_symbol: "K-LP-demo",
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
    sandbox,
    provider,
    poolId,
    rebasingId,
    taxedId,
    alice,
    deployer: root,
  };
}

async function attachRpc() {
  const provider = new JsonRpcProvider({ url: RPC_URL });
  const poolId = requireEnv("KRATER_CONTRACT");
  const rebasingId = requireEnv("REBASING_ACCOUNT");
  const taxedId = requireEnv("TAXED_ACCOUNT");
  const aliceId = requireEnv("DEMO_ACCOUNT");
  const alice = new Account(aliceId, provider, requireEnv("KRATER_PRIVATE_KEY"));

  try {
    await view(provider, poolId, "pool_name");
  } catch (error) {
    throw new Error(
      `no krater pool answered at ${poolId}; deploy it with scripts/deploy.sh first`,
      { cause: error },
    );
  }

  return { mode: "rpc", sandbox: null, provider, poolId, rebasingId, taxedId, alice, deployer: alice };
}

async function main() {
  const chain = RPC_URL ? await attachRpc() : await bootSandbox();
  const { provider, poolId, rebasingId, taxedId, alice, deployer } = chain;

  try {
    // Registration first: receiving a NEP-141 balance or a share requires a
    // storage deposit on the contract that will hold it.
    for (const contractId of [rebasingId, taxedId, poolId]) {
      await register(alice, contractId, alice.accountId);
    }

    // Fund the demo account from the fixture's free mint.
    for (const tokenId of [rebasingId, taxedId]) {
      await call(
        alice,
        tokenId,
        "mint",
        { receiver_id: alice.accountId, amount: (5n * TOKEN_SCALE).toString() },
        { gas: 30 },
      );
    }

    // Credits: one ft_transfer_call per token, empty message.
    for (const tokenId of [rebasingId, taxedId]) {
      await call(
        alice,
        tokenId,
        "ft_transfer_call",
        { receiver_id: poolId, amount: TOKEN_SCALE.toString(), msg: "" },
        { gas: 60, deposit: "1" },
      );
    }

    const credits = await view(provider, poolId, "get_deposits", {
      account_id: alice.accountId,
    });

    // Add liquidity from the credits the pool just recorded.
    await call(
      alice,
      poolId,
      "add_liquidity",
      { amounts: credits, min_shares: "1" },
      { gas: 100, deposit: "1" },
    );

    const reservesAfterAdd = await view(provider, poolId, "get_reserves");
    const quoteBefore = await view(provider, poolId, "get_quote", {
      token_in: taxedId,
      amount_in: SWAP_IN.toString(),
    });

    // Swap: the pool syncs fresh balances, then fills.
    await call(
      alice,
      taxedId,
      "ft_transfer_call",
      {
        receiver_id: poolId,
        amount: SWAP_IN.toString(),
        msg: JSON.stringify({ Swap: { min_out: "0" } }),
      },
      { gas: 60, deposit: "1" },
    );

    const reservesAfterSwap = await view(provider, poolId, "get_reserves");

    // Rebase the input reserve up by ten percent and sync. Views are cache-based,
    // so the quote moves only after the sync.
    await call(alice, rebasingId, "rebase", { factor_bps: 11_000 }, { gas: 30 });
    await call(alice, poolId, "sync_reserves", {}, { gas: 25 });
    const reservesAfterRebase = await view(provider, poolId, "get_reserves");
    const quoteAfter = await view(provider, poolId, "get_quote", {
      token_in: taxedId,
      amount_in: SWAP_IN.toString(),
    });

    // Withdraw half the shares; the pool syncs before it settles.
    const shares = BigInt(
      await view(provider, poolId, "ft_balance_of", { account_id: alice.accountId }),
    );
    const withdrawShares = shares / 2n;
    if (withdrawShares === 0n) {
      throw new Error("no LP shares to withdraw; add_liquidity did not mint any");
    }
    await call(alice, poolId, "withdraw", { shares: withdrawShares.toString() }, {
      gas: 100,
      deposit: "1",
    });

    // Unused credits and failed payouts are both explicit exits.
    const backlog = await view(provider, poolId, "get_payout_backlog", {
      account_id: alice.accountId,
    });
    const tokens = [rebasingId, taxedId];
    for (const [index, amount] of backlog.entries()) {
      if (BigInt(amount) > 0n) {
        await call(alice, poolId, "claim_owed", { token: tokens[index] }, {
          gas: 30,
          deposit: "1",
        });
      }
    }
    const leftover = await view(provider, poolId, "get_deposits", {
      account_id: alice.accountId,
    });
    for (const [index, amount] of leftover.entries()) {
      if (BigInt(amount) > 0n) {
        await call(
          alice,
          poolId,
          "withdraw_deposit",
          { token: tokens[index], amount },
          { gas: 60, deposit: "1" },
        );
      }
    }

    const quoteDeltaBps =
      quoteBefore === "0"
        ? null
        : ((BigInt(quoteAfter) - BigInt(quoteBefore)) * 10_000n) / BigInt(quoteBefore);
    const report = {
      mode: chain.mode,
      pool: poolId,
      tokens: { a: rebasingId, b: taxedId },
      account: alice.accountId,
      reserves: {
        afterAdd: reservesAfterAdd,
        afterSwap: reservesAfterSwap,
        afterRebase: reservesAfterRebase,
      },
      quote: {
        before: quoteBefore,
        afterRebase: quoteAfter,
        deltaBps: quoteDeltaBps === null ? null : quoteDeltaBps.toString(),
        deltaPercent:
          quoteDeltaBps === null ? null : (Number(quoteDeltaBps) / 100).toFixed(2),
      },
      shares,
      withdrawnShares: withdrawShares.toString(),
      finalBalances: {
        rebasing: await view(provider, rebasingId, "ft_balance_of", { account_id: alice.accountId }),
        taxed: await view(provider, taxedId, "ft_balance_of", { account_id: alice.accountId }),
      },
      deployer: deployer.accountId,
    };

    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (chain.sandbox) {
      await chain.sandbox.stop();
    }
  }
}

main().catch((error) => {
  console.error(`krater demo failed: ${error.message}`);
  if (error.cause) {
    console.error(`cause: ${error.cause.message ?? error.cause}`);
  }
  process.exitCode = 1;
});
