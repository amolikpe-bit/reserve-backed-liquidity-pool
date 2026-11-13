#!/usr/bin/env node
// Krater demo: deposit credits, add liquidity, quote, swap, rebase, sync, withdraw.
//
// Default (RPC_URL unset): boots a near-sandbox chain, deploys the built wasm, and
// runs the whole loop with zero-funds accounts. Set RPC_URL to run against a live
// network instead, in which case KRATER_CONTRACT, REBASING_ACCOUNT, TAXED_ACCOUNT,
// DEMO_ACCOUNT and KRATER_PRIVATE_KEY must all be set and the contracts must
// already be deployed and initialised (scripts/deploy.sh does that).
//
// Build first: cargo near build non-reproducible-wasm. Override the wasm paths
// with POOL_WASM and MOCK_FT_WASM.

import assert from "node:assert/strict";
import {
  attachRpc,
  bootSandbox,
  callRaw as call,
  register,
  kraterEvents,
  view,
  GAS_ADD_LIQUIDITY,
  GAS_CREDIT,
  GAS_PAYOUT,
  GAS_SYNC,
  GAS_WITHDRAW,
  ONE,
  RPC_URL,
  TOKEN_SCALE,
} from "./lib/harness.js";

const SWAP_IN = 10n * ONE;


async function main() {
  const chain = RPC_URL ? await attachRpc() : await bootSandbox();
  const { provider, poolId, rebasingId, taxedId, alice, pool } = chain;

  try {
    // Registration first: receiving a NEP-141 balance or a share requires a
    // storage deposit on the contract that will hold it.
    for (const contractId of [rebasingId, taxedId, poolId]) {
      await register(alice, contractId, alice.accountId);
    }

    if (chain.mode === "sandbox") {
      // The pool must be registered on both fixtures before it can hold them.
      for (const tokenId of [rebasingId, taxedId]) {
        await register(pool, tokenId, poolId);
      }
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
        { gas: GAS_CREDIT, deposit: "1" },
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
      { gas: GAS_ADD_LIQUIDITY, deposit: "1" },
    );

    const reservesAfterAdd = await view(provider, poolId, "get_reserves");
    const quoteBefore = await view(provider, poolId, "get_quote", {
      token_in: taxedId,
      amount_in: SWAP_IN.toString(),
    });

    // Swap: the pool syncs fresh balances, then fills.
    const swapOutcome = await call(
      alice,
      taxedId,
      "ft_transfer_call",
      {
        receiver_id: poolId,
        amount: SWAP_IN.toString(),
        msg: JSON.stringify({ Swap: { min_out: "0" } }),
      },
      { gas: GAS_CREDIT, deposit: "1" },
    );

    const reservesAfterSwap = await view(provider, poolId, "get_reserves");

    // Rebase the input reserve up by ten percent and sync. Views are cache-based,
    // so the quote moves only after the sync.
    await call(alice, rebasingId, "rebase", { factor_bps: 11_000 }, { gas: 30 });
    await call(alice, poolId, "sync_reserves", {}, { gas: GAS_SYNC });
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
      gas: GAS_WITHDRAW,
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
          gas: GAS_PAYOUT,
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
          { gas: GAS_PAYOUT, deposit: "1" },
        );
      }
    }

    assert(
      BigInt(quoteBefore) > 0n,
      "the quote before the rebase is zero; add_liquidity left the reserves empty",
    );
    const deltaBps = ((BigInt(quoteAfter) - BigInt(quoteBefore)) * 10_000n) / BigInt(quoteBefore);

    // The demo only counts if value moved: shares were minted, the swap changed
    // a cached reserve, and the pool emitted its own Swap event.
    const swapEvents = kraterEvents(swapOutcome).filter((event) => event.event === "swap");
    assert(shares > 0n, `add_liquidity minted no LP shares to ${alice.accountId}`);
    assert(
      BigInt(reservesAfterSwap[0]) !== BigInt(reservesAfterAdd[0]) ||
        BigInt(reservesAfterSwap[1]) !== BigInt(reservesAfterAdd[1]),
      `the swap left both reserves unchanged at ${reservesAfterAdd.join(" / ")}`,
    );
    assert(swapEvents.length > 0, `no krater Swap event in the swap outcome from ${poolId}`);

    const finalBalances = {
      rebasing: await view(provider, rebasingId, "ft_balance_of", { account_id: alice.accountId }),
      taxed: await view(provider, taxedId, "ft_balance_of", { account_id: alice.accountId }),
    };

    console.log(`krater demo ok (${chain.mode}): ${poolId}`);
    console.log(`  reserves   after add   ${reservesAfterAdd.join(" / ")}`);
    console.log(`             after swap  ${reservesAfterSwap.join(" / ")}`);
    console.log(`             after +10%  ${reservesAfterRebase.join(" / ")}`);
    console.log(`  shares     ${shares} minted, ${withdrawShares} burned`);
    console.log(
      `  quote      ${SWAP_IN} taxed -> ${quoteBefore} then ${quoteAfter} rebasing (${deltaBps} bps)`,
    );
    console.log(`  swap       ${swapEvents.length} krater Swap event(s)`);
    console.log(`  alice      ${finalBalances.rebasing} rebasing, ${finalBalances.taxed} taxed`);
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
