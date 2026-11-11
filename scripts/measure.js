#!/usr/bin/env node
// Krater numbers: measure gas for the six settlement paths and the rebase quote
// delta, then write bench.json.
//
// Gas for one call is what the chain actually charged: the transaction's own
// gas_burnt plus the gas_burnt of every receipt it produced. The RPC response has
// no total field, so the sum is the number.
//
// Default (RPC_URL unset): boots a near-kit sandbox, deploys the built wasm, and
// measures with zero-funds accounts.
//
// Live network: set RPC_URL, KRATER_CONTRACT, REBASING_ACCOUNT, TAXED_ACCOUNT,
// DEMO_ACCOUNT, KRATER_PRIVATE_KEY, CAROL_ACCOUNT and CAROL_PRIVATE_KEY. Carol is
// the account that receives shares without being registered on the token, which
// is how the owed balance behind claim_owed is produced. The contracts must
// already be deployed and initialised.
//
// Build first: cargo near build. Override the wasm paths with POOL_WASM and
// MOCK_FT_WASM. The measured values replace estimates; nothing here is asserted in
// advance.

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
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
const TEN = 10n * ONE;
const TOKEN_SCALE = 1_000n * ONE;

const POOL_WASM = process.env.POOL_WASM ?? "target/near/krater_pool.wasm";
const MOCK_FT_WASM = process.env.MOCK_FT_WASM ?? "target/near/krater_mock_ft.wasm";
const RPC_URL = process.env.RPC_URL;
const GAS = (tgas) => teraToGas(String(tgas));

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is required when RPC_URL is set; unset RPC_URL to measure in a sandbox instead`,
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

// Gas accounting needs the raw execution outcome, not the decoded return value.
function call(account, contractId, methodName, args, { gas = 60, deposit = "0" } = {}) {
  return account.callFunctionRaw({
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
  const carolId = `carol.${suffix}`;

  const pool = await createAccount(provider, root, poolId, "20 NEAR");
  const rebasing = await createAccount(provider, root, rebasingId, "20 NEAR");
  const taxed = await createAccount(provider, root, taxedId, "20 NEAR");
  const alice = await createAccount(provider, root, aliceId, "20 NEAR");
  const carol = await createAccount(provider, root, carolId, "20 NEAR");

  await deploy(pool, poolId, poolWasm);
  await deploy(rebasing, rebasingId, mockWasm);
  await deploy(taxed, taxedId, mockWasm);

  await call(pool, poolId, "new", {
    token_a: rebasingId,
    token_b: taxedId,
    swap_fee_bps: 30,
    share_name: "Krater Bench LP",
    share_symbol: "K-LP-bench",
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
    payer: root,
  };
}

async function attachRpc() {
  const provider = new JsonRpcProvider({ url: RPC_URL });
  const poolId = requireEnv("KRATER_CONTRACT");
  const rebasingId = requireEnv("REBASING_ACCOUNT");
  const taxedId = requireEnv("TAXED_ACCOUNT");
  const alice = new Account(
    requireEnv("DEMO_ACCOUNT"),
    provider,
    requireEnv("KRATER_PRIVATE_KEY"),
  );
  const carol = new Account(
    requireEnv("CAROL_ACCOUNT"),
    provider,
    requireEnv("CAROL_PRIVATE_KEY"),
  );

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

function gasBurnt(outcome) {
  if (!outcome || !outcome.transaction_outcome || !outcome.transaction_outcome.outcome) {
    throw new Error(
      "execution outcome has no transaction_outcome; near-api-js did not return a final execution outcome",
    );
  }
  let total = BigInt(outcome.transaction_outcome.outcome.gas_burnt);
  for (const receipt of outcome.receipts_outcome ?? []) {
    total += BigInt(receipt.outcome.gas_burnt);
  }
  return total;
}

const toTgas = (yocto) => Number(yocto) / 1e12;

async function balances(provider, tokenIds, accountId) {
  const [a, b] = await Promise.all(
    tokenIds.map((token) => view(provider, token, "ft_balance_of", { account_id: accountId })),
  );
  return { a: BigInt(a), b: BigInt(b) };
}

async function main() {
  const chain = RPC_URL ? await attachRpc() : await bootSandbox();
  const { provider, poolId, rebasingId, taxedId, alice, carol, payer } = chain;

  try {
    for (const contractId of [rebasingId, taxedId, poolId]) {
      await register(alice, contractId, alice.accountId);
    }
    // Carol is registered on the pool (so she can receive shares) but
    // deliberately not on the tokens: her first payout fails and lands in owed.
    await register(carol, poolId, carol.accountId);

    for (const tokenId of [rebasingId, taxedId]) {
      await call(
        alice,
        tokenId,
        "mint",
        { receiver_id: alice.accountId, amount: (10n * TOKEN_SCALE).toString() },
        { gas: 30 },
      );
    }

    for (const tokenId of [rebasingId, taxedId]) {
      await call(
        alice,
        tokenId,
        "ft_transfer_call",
        { receiver_id: poolId, amount: (2n * TOKEN_SCALE).toString(), msg: "" },
        { gas: 60, deposit: "1" },
      );
    }

    const credits = await view(provider, poolId, "get_deposits", {
      account_id: alice.accountId,
    });

    const gas = {};
    gas.add_liquidity = gasBurnt(
      await call(
        alice,
        poolId,
        "add_liquidity",
        { amounts: credits, min_shares: "1" },
        { gas: 100, deposit: "1" },
      ),
    );

    const reservesBefore = await view(provider, poolId, "get_reserves");
    const quoteBefore = await view(provider, poolId, "get_quote", {
      token_in: taxedId,
      amount_in: TEN.toString(),
    });

    // +10% on the first token, then the permissionless sync, then the same quote.
    await call(alice, rebasingId, "rebase", { factor_bps: 11_000 }, { gas: 30 });
    gas.sync_reserves = gasBurnt(await call(alice, poolId, "sync_reserves", {}, { gas: 25 }));

    const reservesAfterSync = await view(provider, poolId, "get_reserves");
    const quoteAfter = await view(provider, poolId, "get_quote", {
      token_in: taxedId,
      amount_in: TEN.toString(),
    });

    // Withdraw a fixed share slice and record what each leg paid. The rebasing
    // leg is the one whose reserve grew.
    const shareBalance = BigInt(
      await view(provider, poolId, "ft_balance_of", { account_id: alice.accountId }),
    );
    const slice = shareBalance / 10n;
    const beforeWithdraw = await balances(provider, [rebasingId, taxedId], alice.accountId);
    gas.withdraw = gasBurnt(
      await call(alice, poolId, "withdraw", { shares: slice.toString() }, {
        gas: 100,
        deposit: "1",
      }),
    );
    const afterWithdraw = await balances(provider, [rebasingId, taxedId], alice.accountId);

    gas.swap = gasBurnt(
      await call(
        alice,
        taxedId,
        "ft_transfer_call",
        {
          receiver_id: poolId,
          amount: TEN.toString(),
          msg: JSON.stringify({ Swap: { min_out: "0" } }),
        },
        { gas: 60, deposit: "1" },
      ),
    );

    // Deposit fresh credits, then pay them back out through withdraw_deposit.
    await call(
      alice,
      rebasingId,
      "ft_transfer_call",
      { receiver_id: poolId, amount: TEN.toString(), msg: "" },
      { gas: 60, deposit: "1" },
    );
    const freshCredits = await view(provider, poolId, "get_deposits", {
      account_id: alice.accountId,
    });
    if (BigInt(freshCredits[0]) === 0n) {
      throw new Error("deposit did not credit token A; cannot measure withdraw_deposit");
    }
    gas.withdraw_deposit = gasBurnt(
      await call(
        alice,
        poolId,
        "withdraw_deposit",
        { token: rebasingId, amount: freshCredits[0] },
        { gas: 60, deposit: "1" },
      ),
    );

    // Move shares to carol, who is registered on the pool but not on the tokens.
    // Carol's withdrawal burns shares, both payout legs fail, and the callback
    // records the amount in owed. Then carol registers on token A and claims it.
    const carolShares = shareBalance / 20n;
    if (carolShares === 0n) {
      throw new Error("no shares left to move to carol; cannot measure claim_owed");
    }
    await call(
      alice,
      poolId,
      "ft_transfer",
      { receiver_id: carol.accountId, amount: carolShares.toString() },
      { gas: 30, deposit: "1" },
    );
    await call(carol, poolId, "withdraw", { shares: carolShares.toString() }, {
      gas: 100,
      deposit: "1",
    });

    const backlog = await view(provider, poolId, "get_payout_backlog", {
      account_id: carol.accountId,
    });
    if (BigInt(backlog[0]) === 0n) {
      throw new Error(
        "expected token A's payout to fail for an unregistered receiver and land in owed, but the backlog is empty",
      );
    }

    await register(carol, rebasingId, carol.accountId);
    gas.claim_owed = gasBurnt(
      await call(carol, poolId, "claim_owed", { token: rebasingId }, {
        gas: 30,
        deposit: "1",
      }),
    );
    if (BigInt(backlog[1]) > 0n) {
      await register(carol, taxedId, carol.accountId);
      await call(carol, poolId, "claim_owed", { token: taxedId }, {
        gas: 30,
        deposit: "1",
      });
    }

    const quoteBeforeValue = BigInt(quoteBefore);
    if (quoteBeforeValue === 0n) {
      throw new Error("quote before the rebase is zero; reserves were not funded");
    }
    const deltaBps = ((BigInt(quoteAfter) - quoteBeforeValue) * 10_000n) / quoteBeforeValue;

    const bench = {
      measuredAt: new Date().toISOString(),
      mode: chain.mode,
      network: chain.network,
      pool: poolId,
      tokens: { a: rebasingId, b: taxedId },
      gas: Object.fromEntries(
        Object.entries(gas).map(([label, yocto]) => [
          label,
          { yocto: yocto.toString(), tgas: toTgas(yocto).toFixed(3) },
        ]),
      ),
      quote: {
        tokenIn: taxedId,
        amountIn: TEN.toString(),
        before: quoteBefore,
        afterRebase: quoteAfter,
        deltaBps: deltaBps.toString(),
        deltaPercent: (Number(deltaBps) / 100).toFixed(2),
        rebaseFactorBps: 11_000,
      },
      reserves: {
        before: reservesBefore,
        afterSync: reservesAfterSync,
      },
      shareValue: {
        sliceShares: slice.toString(),
        paidOut: {
          a: (afterWithdraw.a - beforeWithdraw.a).toString(),
          b: (afterWithdraw.b - beforeWithdraw.b).toString(),
        },
      },
      gasFormula: "transaction_outcome.outcome.gas_burnt + sum(receipts_outcome[].outcome.gas_burnt)",
      payer: payer.accountId,
    };

    const path = process.env.BENCH_PATH ?? "bench.json";
    await writeFile(path, `${JSON.stringify(bench, null, 2)}\n`, "utf8");

    for (const [label, value] of Object.entries(bench.gas)) {
      console.log(`${label.padEnd(18)} ${value.tgas} Tgas`);
    }
    console.log(
      `rebase +10% quote delta  ${bench.quote.deltaPercent}% (${bench.quote.before} -> ${bench.quote.afterRebase})`,
    );
    console.log(`wrote ${path}`);
  } finally {
    if (chain.sandbox) {
      await chain.sandbox.stop();
    }
  }
}

main().catch((error) => {
  console.error(`krater measure failed: ${error.message}`);
  if (error.cause) {
    console.error(`cause: ${error.cause.message ?? error.cause}`);
  }
  process.exitCode = 1;
});
