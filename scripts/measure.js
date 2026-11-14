#!/usr/bin/env node
// Krater numbers: measure gas for the six settlement paths and the rebase quote
// delta, then write bench.json.
//
// Gas for one call is what the chain actually charged: the transaction's own
// gas_burnt plus the gas_burnt of every receipt it produced. The RPC response has
// no total field, so the sum is the number.
//
// Default (RPC_URL unset): boots a near-sandbox chain, deploys the built wasm, and
// measures with zero-funds accounts.
//
// Live network: set RPC_URL, KRATER_CONTRACT, REBASING_ACCOUNT, TAXED_ACCOUNT,
// DEMO_ACCOUNT, KRATER_PRIVATE_KEY, CAROL_ACCOUNT and CAROL_PRIVATE_KEY. Carol is
// the account that receives shares without being registered on the token, which
// is how the owed balance behind claim_owed is produced. The contracts must
// already be deployed and initialised.
//
// Build first: cargo near build non-reproducible-wasm. Override the wasm paths
// with POOL_WASM and MOCK_FT_WASM. The measured values replace estimates; nothing
// here is asserted in advance.

import { writeFile } from "node:fs/promises";
import {
  attachRpc,
  balances,
  bootSandbox,
  callRaw as call,
  kraterEvents,
  stopSandbox,
  register,
  view,
  GAS,
  GAS_ADD_LIQUIDITY,
  GAS_CREDIT,
  GAS_PAYOUT,
  GAS_SYNC,
  GAS_WITHDRAW,
  ONE,
  RPC_URL,
  TOKEN_SCALE,
} from "./lib/harness.js";

const TEN = 10n * ONE;

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


// Measure one path, refusing to report a number for a run that reverted or that
// burnt more than the client attached to it.
async function measured(label, outcomePromise, attachedTgas) {
  const outcome = await outcomePromise;
  if (outcome?.status && typeof outcome.status === "object" && outcome.status.Failure) {
    throw new Error(`${label} reverted: ${JSON.stringify(outcome.status.Failure)}`);
  }
  const burnt = gasBurnt(outcome);
  const attached = GAS(attachedTgas);
  if (burnt > attached) {
    throw new Error(
      `${label} burnt ${toTgas(burnt).toFixed(3)} Tgas, above the ${attachedTgas} Tgas attached`,
    );
  }
  return { outcome, burnt };
}
async function main() {
  const chain = RPC_URL
    ? await attachRpc({ requireCarol: true })
    : await bootSandbox({
        shareName: "Krater Bench LP",
        shareSymbol: "K-LP-bench",
        withCarol: true,
      });
  const { provider, poolId, rebasingId, taxedId, alice, carol, payer, pool } = chain;

  try {
    await Promise.all([
      (async () => {
        for (const contractId of [rebasingId, taxedId, poolId]) {
          await register(alice, contractId, alice.accountId);
        }
      })(),
      // Carol is registered on the pool (so she can receive shares) but
      // deliberately not on the tokens: her first payout fails and lands in owed.
      register(carol, poolId, carol.accountId),
      chain.mode === "sandbox"
        ? (async () => {
            for (const tokenId of [rebasingId, taxedId]) {
              await register(pool, tokenId, poolId);
            }
          })()
        : Promise.resolve(),
    ]);

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
        { gas: GAS_CREDIT, deposit: "1" },
      );
    }

    const credits = await view(provider, poolId, "get_deposits", {
      account_id: alice.accountId,
    });

    const gas = {};
    gas.add_liquidity = (
      await measured(
        "add_liquidity",
        call(
          alice,
          poolId,
          "add_liquidity",
          { amounts: credits, min_shares: "1" },
          { gas: GAS_ADD_LIQUIDITY, deposit: "1" },
        ),
        GAS_ADD_LIQUIDITY,
      )
    ).burnt;

    const [preReserves, quoteBefore] = await Promise.all([
      view(provider, poolId, "get_reserves"),
      view(provider, poolId, "get_quote", {
        token_in: taxedId,
        amount_in: TEN.toString(),
      }),
    ]);

    // +10% on the first token, then the permissionless sync, then the same quote.
    await call(alice, rebasingId, "rebase", { factor_bps: 11_000 }, { gas: 30 });
    gas.sync_reserves = (
      await measured(
        "sync_reserves",
        call(alice, poolId, "sync_reserves", {}, { gas: GAS_SYNC }),
        GAS_SYNC,
      )
    ).burnt;

    const [syncReserves, quoteAfter, shareBalanceRaw] = await Promise.all([
      view(provider, poolId, "get_reserves"),
      view(provider, poolId, "get_quote", {
        token_in: taxedId,
        amount_in: TEN.toString(),
      }),
      view(provider, poolId, "ft_balance_of", { account_id: alice.accountId }),
    ]);

    // Withdraw a fixed share slice and record what each leg paid. The rebasing
    // leg is the one whose reserve grew.
    const shareBalance = BigInt(shareBalanceRaw);
    const slice = shareBalance / 10n;
    const preExit = await balances(provider, [rebasingId, taxedId], alice.accountId);
    gas.withdraw = (
      await measured(
        "withdraw",
        call(alice, poolId, "withdraw", { shares: slice.toString() }, {
          gas: GAS_WITHDRAW,
          deposit: "1",
        }),
        GAS_WITHDRAW,
      )
    ).burnt;
    const postExit = await balances(provider, [rebasingId, taxedId], alice.accountId);

    const swapResult = await measured(
      "swap",
      call(
        alice,
        taxedId,
        "ft_transfer_call",
        {
          receiver_id: poolId,
          amount: TEN.toString(),
          msg: JSON.stringify({ Swap: { min_out: "0" } }),
        },
        { gas: GAS_CREDIT, deposit: "1" },
      ),
      GAS_CREDIT,
    );
    gas.swap = swapResult.burnt;
    const swapEvents = kraterEvents(swapResult.outcome).filter((event) => event.event === "swap");
    if (swapEvents.length === 0) {
      throw new Error(
        "the swap receipt tree has no krater Swap event; it refunded instead of filling",
      );
    }
    // Deposit fresh credits, then pay them back out through withdraw_deposit.
    await call(
      alice,
      rebasingId,
      "ft_transfer_call",
      { receiver_id: poolId, amount: TEN.toString(), msg: "" },
      { gas: GAS_CREDIT, deposit: "1" },
    );
    const freshCredits = await view(provider, poolId, "get_deposits", {
      account_id: alice.accountId,
    });
    if (BigInt(freshCredits[0]) === 0n) {
      throw new Error("deposit did not credit token A; cannot measure withdraw_deposit");
    }
    gas.withdraw_deposit = (
      await measured(
        "withdraw_deposit",
        call(
          alice,
          poolId,
          "withdraw_deposit",
          { token: rebasingId, amount: freshCredits[0] },
          { gas: GAS_PAYOUT, deposit: "1" },
        ),
        GAS_PAYOUT,
      )
    ).burnt;

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
      gas: GAS_WITHDRAW,
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
    gas.claim_owed = (
      await measured(
        "claim_owed",
        call(carol, poolId, "claim_owed", { token: rebasingId }, {
          gas: GAS_PAYOUT,
          deposit: "1",
        }),
        GAS_PAYOUT,
      )
    ).burnt;
    if (BigInt(backlog[1]) > 0n) {
      await register(carol, taxedId, carol.accountId);
      await call(carol, poolId, "claim_owed", { token: taxedId }, {
        gas: GAS_PAYOUT,
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
        before: preReserves,
        afterSync: syncReserves,
      },
      shareValue: {
        sliceShares: slice.toString(),
        paidOut: {
          a: (postExit.a - preExit.a).toString(),
          b: (postExit.b - preExit.b).toString(),
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
    await stopSandbox(chain.sandbox);
  }
}

main().catch((error) => {
  console.error(`krater measure failed: ${error.message}`);
  if (error.cause) {
    console.error(`cause: ${error.cause.message ?? error.cause}`);
  }
  process.exitCode = 1;
});
