// Surface and flow tests for the Krater pool, on a near-sandbox chain.
//
// W1 covers what the scaffold promises: the metadata views match the shipped
// manifest, the share token is NEP-148 with 18 decimals, `new` refuses an equal
// pair and an out-of-range fee, and a quote refuses an empty pool or an unknown
// token.
//
// W2 covers the async flows end to end: deposits credited through
// `ft_transfer_call`, `add_liquidity` minting shares from those credits, the
// quote view, a swap that syncs fresh reserves before it fills, a rebase priced
// by `sync_reserves`, a pro-rata withdrawal, an `owed` fallback cleared by
// `claim_owed`, and the full refund of an unknown message.
//
// Build first: cargo near build. Override the wasm paths with POOL_WASM and
// MOCK_FT_WASM. Run with: node --test tests/pool.test.js

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, describe, test } from "node:test";
import { Account, JsonRpcProvider, actions } from "near-api-js";
import { Sandbox, DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY } from "near-sandbox";
import {
  call,
  callRaw,
  createAccount as createHarnessAccount,
  deploy,
  logsOf,
  readWasm,
  toYocto,
  view as harnessView,
  GAS,
  POOL_WASM,
  MOCK_FT_WASM,
  ONE as E18,
  TOKEN_SCALE as FUND,
} from "../scripts/lib/harness.js";
const SPEC_URI = "https://raw.githubusercontent.com/nirholas/near-krater/main/manifest.json";
const TAGS = ["curve", "rebasing", "fee-on-transfer", "custom-curve", "no-admin"];
const SEED = 200n * E18;

// Origin constants (the origin's hook test suite): 30 bps swap fee, 200 bps
// transfer tax, and a seeded loop shape instead of the origin's coverage fuzz.
const FEE_BPS = 30;
const TRANSFER_TAX_BPS = 200;
const FUZZ_ITERATIONS = 8;
const FUZZ_SEED = 0xC0FFEE;

let sandbox;
let provider;
let pool;
let equalPair;
let badFee;
let poolId;
let rebasingId;
let taxedId;
let manifest;
let alice;
let bob;
let carol;
let aliceId;
let bobId;
let carolId;
let dave;
let daveId;

// Every `EVENT_JSON:` payload the suite observes, keyed by event name. The
// envelope test at the end asserts the full NEP-297 shape for each variant.
const seenEvents = new Map();



function view(contractId, method, args = {}) {
  return harnessView(provider, contractId, method, args).catch((error) => {
    throw new Error(`view ${contractId}.${method} ${JSON.stringify(args)}: ${error.message}`);
  });
}

function createAccount(root, accountId, nearAmount) {
  return createHarnessAccount(provider, root, accountId, nearAmount);
}



// A flow may end with a token leg the pool handles in a callback. The outer
// call succeeds and the failed leg is expected, so keep the final status
// instead of throwing; the caller asserts the resulting `owed` state.
function callExpectingFailedLeg(
  account,
  contractId,
  methodName,
  args,
  { gas = 60, deposit = "1" } = {},
) {
  return account.signAndSendTransaction({
    receiverId: contractId,
    actions: [actions.functionCall(methodName, args, BigInt(GAS(gas)), BigInt(deposit))],
    waitUntil: "FINAL",
    throwOnFailure: false,
  });
}


function eventsOf(outcome) {
  const events = logsOf(outcome)
    .filter((line) => line.startsWith("EVENT_JSON:"))
    .map((line) => JSON.parse(line.slice("EVENT_JSON:".length)));

  for (const event of events) {
    assert.equal(typeof event.standard, "string", "EVENT_JSON standard is missing");
    assert.equal(typeof event.version, "string", "EVENT_JSON version is missing");
    assert.equal(typeof event.event, "string", "EVENT_JSON event name is missing");
    assert.ok(
      Object.prototype.hasOwnProperty.call(event, "data"),
      `EVENT_JSON ${event.event} data is missing`,
    );
    if (event.standard === "krater") {
      seenEvents.set(event.event, event);
    }
  }

  return events;
}

function successValue(outcome) {
  const encoded = outcome.status?.SuccessValue;
  assert.equal(
    typeof encoded,
    "string",
    `call did not return a success value: ${JSON.stringify(outcome.status)}`,
  );
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  return decoded === "" ? null : JSON.parse(decoded);
}

function kraterEventOf(outcome, eventName) {
  return eventsOf(outcome).find(
    (event) => event.standard === "krater" && event.event === eventName,
  );
}

// NEP-141 events carry an array of records; every `ft_transfer` leg of a flow
// is flattened so a test can assert on the amount and the receiver.
function ftTransfersOf(outcome) {
  return eventsOf(outcome)
    .filter((event) => event.event === "ft_transfer")
    .flatMap((event) => (Array.isArray(event.data) ? event.data : [event.data]));
}

function ceilDiv(numerator, denominator) {
  return (numerator + denominator - 1n) / denominator;
}

// The two fuzz rows use the origin seed and a 32-bit LCG so every run derives
// the same inputs; there is no coverage-guided fuzzing on the sandbox.
function nextSeed(seed) {
  return (seed * 1664525n + 1013904223n) % 4_294_967_296n;
}

// Return every nominal credit the account still holds. `withdraw_deposit`
// pays at the current index, so this also drains rounding dust left by an add.
async function clearCredits(account, accountId) {
  const [creditA, creditB] = (await view(poolId, "get_deposits", { account_id: accountId }))
    .map(BigInt);
  if (creditA > 0n) {
    await call(account, poolId, "withdraw_deposit", {
      token: rebasingId,
      amount: creditA.toString(),
    }, { gas: 100, deposit: "1" });
  }
  if (creditB > 0n) {
    await call(account, poolId, "withdraw_deposit", {
      token: taxedId,
      amount: creditB.toString(),
    }, { gas: 100, deposit: "1" });
  }
}

before(async () => {
  manifest = JSON.parse(await readFile("manifest.json", "utf8"));
  const [poolWasm, mockWasm] = await Promise.all([readWasm(POOL_WASM), readWasm(MOCK_FT_WASM)]);

  sandbox = await Sandbox.start({});
  provider = new JsonRpcProvider({ url: sandbox.rpcUrl });
  const root = new Account(DEFAULT_ACCOUNT_ID, provider, DEFAULT_PRIVATE_KEY);
  const suffix = DEFAULT_ACCOUNT_ID;

  poolId = `pool.${suffix}`;
  rebasingId = `rebasing.${suffix}`;
  taxedId = `taxed.${suffix}`;
  const equalPairId = `equal-pair.${suffix}`;
  const badFeeId = `bad-fee.${suffix}`;

  pool = await createAccount(root, poolId, "20 NEAR");
  const rebasing = await createAccount(root, rebasingId, "20 NEAR");
  const taxed = await createAccount(root, taxedId, "20 NEAR");
  equalPair = await createAccount(root, equalPairId, "20 NEAR");
  badFee = await createAccount(root, badFeeId, "20 NEAR");

  await Promise.all([
    deploy(pool, poolId, poolWasm),
    deploy(rebasing, rebasingId, mockWasm),
    deploy(taxed, taxedId, mockWasm),
    deploy(equalPair, equalPairId, poolWasm),
    deploy(badFee, badFeeId, poolWasm),
  ]);

  await call(pool, poolId, "new", {
    token_a: rebasingId,
    token_b: taxedId,
    swap_fee_bps: FEE_BPS,
    share_name: "Krater test LP",
    share_symbol: "K-TEST",
  }, { gas: 100 });
  await call(rebasing, rebasingId, "new", {
    name: "Krater Rebasing Fixture",
    symbol: "kREB",
  }, { gas: 30 });
  await call(taxed, taxedId, "new", {
    name: "Krater Taxed Fixture",
    symbol: "kTAX",
  }, { gas: 30 });
});

after(async () => {
  const active = sandbox;
  if (!active) return;
  await Promise.race([
    active.tearDown().catch(() => {}),
    new Promise((resolve) => {
      const timer = setTimeout(resolve, 15_000);
      timer.unref();
    }),
  ]);
  active.childProcess?.kill("SIGKILL");
});

// origin: test_metadata.
test("the metadata views match the shipped manifest", async () => {
  assert.equal(await view(poolId, "pool_name"), manifest.name);
  assert.equal(await view(poolId, "pool_version"), manifest.version);
  assert.equal(await view(poolId, "spec_uri"), SPEC_URI);
  assert.deepEqual(await view(poolId, "pool_tags"), manifest.tags);
});

// origin: test_metadata (the NEP-148 share record half).
test("LP shares are NEP-148 with 18 decimals", async () => {
  const metadata = await view(poolId, "ft_metadata");
  assert.equal(metadata.spec, "ft-1.0.0");
  assert.equal(metadata.decimals, 18);
  assert.equal(metadata.name, "Krater test LP");
  assert.equal(metadata.symbol, "K-TEST");
});

// origin: test_theHookBindsToOnePoolOnly (the pair is bound once).
test("new refuses an equal pair", async () => {
  await assert.rejects(
    call(equalPair, equalPair.accountId, "new", {
      token_a: rebasingId,
      token_b: rebasingId,
      swap_fee_bps: FEE_BPS,
      share_name: "Bad LP",
      share_symbol: "BAD",
    }, { gas: 100 }),
    /InvalidPair/,
  );
});

// origin: test_theHookBindsToOnePoolOnly (init-time validation, no setter).
test("new refuses a fee at or above the whole trade", async () => {
  await assert.rejects(
    call(badFee, badFee.accountId, "new", {
      token_a: rebasingId,
      token_b: taxedId,
      swap_fee_bps: 10_000,
      share_name: "Bad LP",
      share_symbol: "BAD",
    }, { gas: 100 }),
    /InvalidFee/,
  );
});

// origin: test_theReserveIsTheHooksOwnBalance (empty fixture).
test("the reserve cache starts empty", async () => {
  assert.deepEqual(await view(poolId, "get_reserves"), ["0", "0"]);
});

// origin: test_aRebaseNeedsNobodyToNoticeIt (a pool without a price refuses).
test("a quote on empty reserves panics rather than returning zero", async () => {
  await assert.rejects(
    view(poolId, "get_quote", { token_in: rebasingId, amount_in: "1000" }),
    /NoReserves/,
  );
});

// origin: test_thePoolsOwnLiquidityPathIsClosed (no foreign-token path).
test("a quote refuses a token outside the pair", async () => {
  await assert.rejects(
    view(poolId, "get_quote", { token_in: "not-a-pair-token.test.near", amount_in: "1000" }),
    /UnknownToken/,
  );
});

// origin: test_metadata.
test("the pool advertises the five manifest tags", async () => {
  const tags = await view(poolId, "pool_tags");
  assert.equal(tags.length, 5);
  assert.deepEqual(tags, TAGS);
});

describe("W2 flows", { concurrency: 1 }, () => {
  before(async () => {
    const root = new Account(DEFAULT_ACCOUNT_ID, provider, DEFAULT_PRIVATE_KEY);
    aliceId = `alice.${DEFAULT_ACCOUNT_ID}`;
    bobId = `bob.${DEFAULT_ACCOUNT_ID}`;
    carolId = `carol.${DEFAULT_ACCOUNT_ID}`;
    alice = await createAccount(root, aliceId, "50 NEAR");
    bob = await createAccount(root, bobId, "50 NEAR");
    carol = await createAccount(root, carolId, "50 NEAR");

    const storage = toYocto("0.02");
    for (const account of [alice, bob, carol]) {
      for (const contractId of [rebasingId, taxedId, poolId]) {
        await call(account, contractId, "storage_deposit", {}, { deposit: storage, gas: 30 });
      }
    }
    // The first mint locks MINIMUM_SHARES to the pool, every token transfer
    // lands on the pool account, and its ledger is keyed by the pool itself.
    await call(pool, poolId, "storage_deposit", { account_id: poolId }, { deposit: storage, gas: 30 });
    await call(pool, rebasingId, "storage_deposit", {}, { deposit: storage, gas: 30 });
    await call(pool, taxedId, "storage_deposit", {}, { deposit: storage, gas: 30 });

    for (const contractId of [rebasingId, taxedId]) {
      for (const [account, accountId] of [[alice, aliceId], [bob, bobId], [carol, carolId]]) {
        await call(account, contractId, "mint", {
          receiver_id: accountId,
          amount: FUND.toString(),
        }, { gas: 30 });
      }
    }
  });

  // origin: ForgeTest.setUp harness (holders funded and registered).
  test("setup: holders are registered and funded on both fixtures", async () => {
    for (const accountId of [aliceId, bobId, carolId]) {
      assert.ok(await view(rebasingId, "storage_balance_of", { account_id: accountId }));
      assert.ok(await view(taxedId, "storage_balance_of", { account_id: accountId }));
      assert.ok(await view(poolId, "storage_balance_of", { account_id: accountId }));
      assert.equal(
        await view(rebasingId, "ft_balance_of", { account_id: accountId }),
        FUND.toString(),
      );
      assert.equal(
        await view(taxedId, "ft_balance_of", { account_id: accountId }),
        FUND.toString(),
      );
    }
    assert.ok(await view(poolId, "storage_balance_of", { account_id: poolId }));
    assert.ok(await view(rebasingId, "storage_balance_of", { account_id: poolId }));
    assert.ok(await view(taxedId, "storage_balance_of", { account_id: poolId }));
  });

  // origin: test_depositMintsSharesAndLocksTheMinimum.
  test("a deposit credits both tokens and add_liquidity mints shares", async () => {
    await call(alice, rebasingId, "ft_transfer_call", {
      receiver_id: poolId,
      amount: SEED.toString(),
      msg: "",
    }, { gas: 200, deposit: "1" });
    await call(alice, taxedId, "ft_transfer_call", {
      receiver_id: poolId,
      amount: SEED.toString(),
      msg: "",
    }, { gas: 200, deposit: "1" });
    assert.deepEqual(
      await view(poolId, "get_deposits", { account_id: aliceId }),
      [SEED.toString(), SEED.toString()],
    );

    const outcome = await callRaw(alice, poolId, "add_liquidity", {
      amounts: [SEED.toString(), SEED.toString()],
      min_shares: "0",
    }, { gas: 300, deposit: "1" });

    assert.deepEqual(await view(poolId, "get_deposits", { account_id: aliceId }), ["0", "0"]);
    const shares = BigInt(await view(poolId, "ft_balance_of", { account_id: aliceId }));
    const supply = BigInt(await view(poolId, "ft_total_supply"));
    assert.equal(supply, SEED);
    assert.equal(shares, SEED - 1_000n, "MINIMUM_SHARES must be locked to the pool");
    assert.ok(supply > shares);

    const [reserveA, reserveB] = (await view(poolId, "get_reserves")).map(BigInt);
    assert.equal(reserveA, SEED);
    assert.equal(reserveB, SEED);

    const depositEvent = eventsOf(outcome).find(
      (event) => event.standard === "krater" && event.event === "deposit",
    );
    assert.ok(depositEvent, "Deposit event missing");
    assert.equal(depositEvent.data.who, aliceId);
    assert.equal(depositEvent.data.amount_a, SEED.toString());
    assert.equal(depositEvent.data.amount_b, SEED.toString());
    assert.equal(depositEvent.data.shares, (SEED - 1_000n).toString());
  });

  // origin: test_aTaxedInputNeedsARouterThatOverSends (quotes the received amount).
  test("get_quote matches the client-side BigInt formula", async () => {
    const [reserveA, reserveB] = (await view(poolId, "get_reserves")).map(BigInt);
    const amountIn = E18;
    const afterFee = amountIn * 9_970n;
    const expected = (afterFee * reserveB) / (reserveA * 10_000n + afterFee);
    const quoted = BigInt(await view(poolId, "get_quote", {
      token_in: rebasingId,
      amount_in: amountIn.toString(),
    }));
    assert.equal(quoted, expected);
    assert.ok(quoted > 0n && quoted < reserveB);
  });

  // origin: test_aTaxedOutputSettlesAtWhatActuallyArrived.
  test("a swap pays the output token and emits Swap", async () => {
    const amountIn = 10n * E18;
    const reservesBefore = (await view(poolId, "get_reserves")).map(BigInt);
    const balanceBefore = BigInt(await view(taxedId, "ft_balance_of", { account_id: aliceId }));

    const outcome = await callRaw(alice, rebasingId, "ft_transfer_call", {
      receiver_id: poolId,
      amount: amountIn.toString(),
      msg: JSON.stringify({ Swap: { min_out: "0" } }),
    }, { gas: 200, deposit: "1" });

    const afterFee = amountIn * 9_970n;
    const expectedOut = (afterFee * reservesBefore[1]) / (reservesBefore[0] * 10_000n + afterFee);

    const balanceAfter = BigInt(await view(taxedId, "ft_balance_of", { account_id: aliceId }));
    assert.equal(balanceAfter - balanceBefore, expectedOut);

    const reservesAfter = (await view(poolId, "get_reserves")).map(BigInt);
    assert.equal(reservesAfter[0], reservesBefore[0] + amountIn);
    assert.equal(reservesAfter[1], reservesBefore[1] - expectedOut);
    assert.ok(reservesAfter[1] < reservesBefore[1]);

    const swapEvent = eventsOf(outcome).find(
      (event) => event.standard === "krater" && event.event === "swap",
    );
    assert.ok(swapEvent, "Swap event missing");
    assert.equal(swapEvent.data.sender, aliceId);
    assert.equal(swapEvent.data.token_in, rebasingId);
    assert.equal(swapEvent.data.amount_in, amountIn.toString());
    assert.equal(swapEvent.data.amount_out_gross, expectedOut.toString());
  });

  // origin: test_aPositiveRebaseIncreasesTheReserves.
  test("a rebase is priced after sync_reserves", async () => {
    const reservesBefore = (await view(poolId, "get_reserves")).map(BigInt);
    const quoteBefore = BigInt(await view(poolId, "get_quote", {
      token_in: taxedId,
      amount_in: E18.toString(),
    }));

    await call(bob, rebasingId, "rebase", { factor_bps: 11_000 }, { gas: 30 });
    const syncOutcome = await callRaw(bob, poolId, "sync_reserves", {}, { gas: 100 });

    const reservesAfter = (await view(poolId, "get_reserves")).map(BigInt);
    const expectedA = (reservesBefore[0] * 11_000n) / 10_000n;
    const delta = reservesAfter[0] > expectedA
      ? reservesAfter[0] - expectedA
      : expectedA - reservesAfter[0];
    assert.ok(reservesAfter[0] > reservesBefore[0], "rebase did not grow reserve A");
    assert.ok(delta <= 1n, `reserve A moved by more than one base unit: ${delta}`);

    const quoteAfter = BigInt(await view(poolId, "get_quote", {
      token_in: taxedId,
      amount_in: E18.toString(),
    }));
    assert.ok(quoteAfter > quoteBefore, "a larger output reserve must improve the quote");

    const syncEvent = eventsOf(syncOutcome).find(
      (event) => event.standard === "krater" && event.event === "reserves_synced",
    );
    assert.ok(syncEvent, "ReservesSynced event missing");
    assert.equal(syncEvent.data.reserve_a, reservesAfter[0].toString());
    assert.equal(syncEvent.data.reserve_b, reservesAfter[1].toString());
    assert.equal(syncEvent.data.index_a, "1100000000000000000");
  });

  // origin: test_withdrawReturnsBothSides / test_aRebaseIsWorthMoreToEveryShare.
  test("withdraw pays both legs and burns shares", async () => {
    const sharesBefore = BigInt(await view(poolId, "ft_balance_of", { account_id: aliceId }));
    const half = sharesBefore / 2n;
    const aBefore = BigInt(await view(rebasingId, "ft_balance_of", { account_id: aliceId }));
    const bBefore = BigInt(await view(taxedId, "ft_balance_of", { account_id: aliceId }));

    const outcome = await callRaw(alice, poolId, "withdraw", { shares: half.toString() },
      { gas: 300, deposit: "1" });

    const sharesAfter = BigInt(await view(poolId, "ft_balance_of", { account_id: aliceId }));
    assert.equal(sharesAfter, sharesBefore - half);
    assert.ok(BigInt(await view(rebasingId, "ft_balance_of", { account_id: aliceId })) > aBefore);
    assert.ok(BigInt(await view(taxedId, "ft_balance_of", { account_id: aliceId })) > bBefore);

    const events = eventsOf(outcome);
    // NEP-141 emits `data` as an array of records; the pool's own events use a
    // single object. Each `.emit()` carries one transfer, so the two legs
    // appear as two array entries across the token receipts.
    const transfers = events
      .filter((event) => event.event === "ft_transfer" && Array.isArray(event.data))
      .flatMap((event) => event.data);
    assert.equal(transfers.length, 2);
    for (const transfer of transfers) {
      assert.equal(typeof transfer.amount, "string");
      assert.notEqual(BigInt(transfer.amount), 0n, "zero-amount transfer emitted");
    }

    const withdrawEvent = events.find(
      (event) => event.standard === "krater" && event.event === "withdraw",
    );
    assert.ok(withdrawEvent, "Withdraw event missing");
    assert.equal(withdrawEvent.data.who, aliceId);
    assert.equal(withdrawEvent.data.shares, half.toString());
    assert.ok(BigInt(withdrawEvent.data.amount_a) > 0n);
    assert.ok(BigInt(withdrawEvent.data.amount_b) > 0n);
  });

  // origin: new-test row (failed payout in backlog; claim_owed clears it).
  test("a failed payout becomes owed and claim_owed clears it", async () => {
    const carried = 1_000_000n;
    // The owed fallback only exists for a receiver the fixture cannot credit:
    // drain carol's token balances and unregister her, so the withdrawal's
    // `ft_transfer` legs fail while the share burn still happens.
    for (const tokenId of [rebasingId, taxedId]) {
      const balance = await view(tokenId, "ft_balance_of", { account_id: carolId });
      await call(carol, tokenId, "ft_transfer", {
        receiver_id: bobId,
        amount: balance,
      }, { gas: 30, deposit: "1" });
      await call(carol, tokenId, "storage_unregister", {}, { gas: 30, deposit: "1" });
      assert.equal(
        await view(tokenId, "storage_balance_of", { account_id: carolId }),
        null,
        "carol must be unregistered on the fixture before the withdrawal",
      );
    }
    await call(alice, poolId, "ft_transfer", {
      receiver_id: carolId,
      amount: carried.toString(),
    }, { gas: 30, deposit: "1" });
    assert.equal(
      BigInt(await view(poolId, "ft_balance_of", { account_id: carolId })),
      carried,
    );

    await callExpectingFailedLeg(carol, poolId, "withdraw", { shares: carried.toString() },
      { gas: 300, deposit: "1" });

    const backlog = (await view(poolId, "get_payout_backlog", { account_id: carolId }))
      .map(BigInt);
    assert.ok(backlog[0] > 0n, "token A payout did not fall back to owed");
    assert.ok(backlog[1] > 0n, "token B payout did not fall back to owed");
    assert.equal(
      BigInt(await view(poolId, "ft_balance_of", { account_id: carolId })),
      0n,
    );

    const storage = toYocto("0.02");
    await call(carol, rebasingId, "storage_deposit", {}, { deposit: storage, gas: 30 });
    await call(carol, taxedId, "storage_deposit", {}, { deposit: storage, gas: 30 });

    const aBefore = BigInt(await view(rebasingId, "ft_balance_of", { account_id: carolId }));
    const bBefore = BigInt(await view(taxedId, "ft_balance_of", { account_id: carolId }));
    await call(carol, poolId, "claim_owed", { token: rebasingId }, { gas: 100, deposit: "1" });
    await call(carol, poolId, "claim_owed", { token: taxedId }, { gas: 100, deposit: "1" });

    assert.deepEqual(await view(poolId, "get_payout_backlog", { account_id: carolId }),
      ["0", "0"]);
    const aDelta =
      BigInt(await view(rebasingId, "ft_balance_of", { account_id: carolId })) - aBefore;
    // The fixture rounds the debit up and credits `nominal(ceil(amount * ONE /
    // index))`, which is the owed amount or one base unit more at index 1.1.
    assert.ok(
      aDelta === backlog[0] || aDelta === backlog[0] + 1n,
      `token A claim credited ${aDelta}, owed ${backlog[0]}`,
    );
    assert.equal(
      BigInt(await view(taxedId, "ft_balance_of", { account_id: carolId })) - bBefore,
      backlog[1],
    );
  });

  // origin: test_exactOutputIsRefusedRatherThanApproximated.
  test("an exact-output message is refunded in full", async () => {
    const amount = 5n * E18;
    // Token B keeps index ONE, so the fixture's floor-rounded refund shares
    // exactly equal the shares it took; the rebasing token would leave a
    // one-base-unit rounding residue in the pool.
    const aliceBefore = BigInt(await view(taxedId, "ft_balance_of", { account_id: aliceId }));
    const poolBefore = BigInt(await view(taxedId, "ft_balance_of", { account_id: poolId }));
    const reservesBefore = await view(poolId, "get_reserves");

    const outcome = await callRaw(alice, taxedId, "ft_transfer_call", {
      receiver_id: poolId,
      amount: amount.toString(),
      msg: JSON.stringify({ ExactOutput: { amount_out: "1" } }),
    }, { gas: 200, deposit: "1" });

    assert.equal(
      BigInt(await view(taxedId, "ft_balance_of", { account_id: aliceId })),
      aliceBefore,
    );
    assert.equal(
      BigInt(await view(taxedId, "ft_balance_of", { account_id: poolId })),
      poolBefore,
    );
    assert.deepEqual(await view(poolId, "get_reserves"), reservesBefore);
    assert.ok(
      !eventsOf(outcome).some(
        (event) => event.standard === "krater" && event.event === "swap",
      ),
      "an exact-output message must not fill a swap",
    );
  });
});

// W3 regression matrix. The origin named these rows in its hook test suite and
// the port's steps 4-9; each test below says
// which behaviour it pins. All flows await FINAL, so the assertions see the
// settlement callbacks, not just the call that scheduled them.
describe("W3 regression matrix", { concurrency: 1 }, () => {
  before(async () => {
    const root = new Account(DEFAULT_ACCOUNT_ID, provider, DEFAULT_PRIVATE_KEY);
    daveId = `dave.${DEFAULT_ACCOUNT_ID}`;
    dave = await createAccount(root, daveId, "50 NEAR");

    const storage = toYocto("0.02");
    for (const contractId of [rebasingId, taxedId, poolId]) {
      await call(dave, contractId, "storage_deposit", {}, { deposit: storage, gas: 30 });
    }
    for (const tokenId of [rebasingId, taxedId]) {
      await call(dave, tokenId, "mint", {
        receiver_id: daveId,
        amount: FUND.toString(),
      }, { gas: 30 });
    }
  });

  // origin: new row `min_out` miss (step 9) and `test_aRebaseNeedsNobodyToNoticeIt`
  // for the settled-refund path.
  test("swap with an unmet min_out refunds the input and does not move reserves", async () => {
    const amount = E18;
    await call(bob, poolId, "sync_reserves", {}, { gas: 100 });
    const reservesBefore = await view(poolId, "get_reserves");
    const aliceBefore = BigInt(await view(taxedId, "ft_balance_of", { account_id: aliceId }));

    // Token B has index ONE and no tax here, so both legs are exact.
    const outcome = await callRaw(alice, taxedId, "ft_transfer_call", {
      receiver_id: poolId,
      amount: amount.toString(),
      msg: JSON.stringify({ Swap: { min_out: (100n * E18).toString() } }),
    }, { gas: 200, deposit: "1" });

    assert.equal(
      BigInt(await view(taxedId, "ft_balance_of", { account_id: aliceId })),
      aliceBefore,
      "a min_out miss must return the whole input",
    );
    assert.deepEqual(await view(poolId, "get_reserves"), reservesBefore);
    const refunds = ftTransfersOf(outcome).filter(
      (transfer) => transfer.new_owner_id === aliceId,
    );
    assert.ok(refunds.length >= 1, "the pool must emit the refund transfer");
    assert.ok(
      !eventsOf(outcome).some(
        (event) => event.standard === "krater" && event.event === "swap",
      ),
      "a refunded swap is not a fill",
    );
  });

  // origin: new row `min_out:0` + dust refunds without `ft_transfer(0)`.
  test("dust swap refunds without a zero ft_transfer", async () => {
    await call(bob, poolId, "sync_reserves", {}, { gas: 100 });
    // The output truncates to zero when r_out * (BPS - fee) < r_in * BPS, i.e.
    // r_out * 9970 < r_in * 10000 for the 30 bps fee. Read the cache first and
    // decide analytically; never probe with a view that panics on zero reserves.
    const [reserveA, reserveB] = (await view(poolId, "get_reserves")).map(BigInt);
    assert.ok(reserveA > 0n && reserveB > 0n, "the dust test needs both reserves");
    const taxedTruncates = reserveA * 9_970n < reserveB * 10_000n;
    const rebasingTruncates = reserveB * 9_970n < reserveA * 10_000n;
    const tokenIn = taxedTruncates ? taxedId : rebasingTruncates ? rebasingId : null;
    assert.ok(
      tokenIn,
      `one direction must truncate (reserves ${reserveA}/${reserveB})`,
    );
    assert.equal(
      await view(poolId, "get_quote", { token_in: tokenIn, amount_in: "1" }),
      "0",
      "the chosen direction quotes zero for one base unit",
    );

    const reservesBefore = await view(poolId, "get_reserves");
    const aliceBefore = BigInt(await view(tokenIn, "ft_balance_of", { account_id: aliceId }));

    const outcome = await callRaw(alice, tokenIn, "ft_transfer_call", {
      receiver_id: poolId,
      amount: "1",
      msg: JSON.stringify({ Swap: { min_out: "0" } }),
    }, { gas: 200, deposit: "1" });

    assert.equal(
      BigInt(await view(tokenIn, "ft_balance_of", { account_id: aliceId })),
      aliceBefore,
      "dust input must be refunded",
    );
    assert.deepEqual(await view(poolId, "get_reserves"), reservesBefore);
    const transfers = ftTransfersOf(outcome);
    assert.ok(
      !transfers.some((transfer) => BigInt(transfer.amount) === 0n),
      "a zero-amount ft_transfer panics the reference FT",
    );
    assert.ok(
      !eventsOf(outcome).some(
        (event) => event.standard === "krater" && event.event === "swap",
      ),
      "a zero-output swap must not emit Swap",
    );
  });

  // origin: new row `swap output-transfer failure refunds input`.
  test("forced output failure refunds the input and restores reserves", async () => {
    // Make the output leg unpayable: drain Alice's rebasing balance and
    // unregister her, so the pool's ft_transfer leg fails.
    const aliceRebasing = BigInt(
      await view(rebasingId, "ft_balance_of", { account_id: aliceId }),
    );
    assert.ok(aliceRebasing > 0n, "alice needs an output balance to drain");
    await call(alice, rebasingId, "ft_transfer", {
      receiver_id: bobId,
      amount: aliceRebasing.toString(),
    }, { gas: 30, deposit: "1" });
    await call(alice, rebasingId, "storage_unregister", {}, { gas: 30, deposit: "1" });
    assert.equal(
      await view(rebasingId, "storage_balance_of", { account_id: aliceId }),
      null,
      "alice must be unregistered before the failed output leg",
    );

    await call(bob, poolId, "sync_reserves", {}, { gas: 100 });
    const reservesBefore = (await view(poolId, "get_reserves")).map(BigInt);
    const inputBefore = BigInt(await view(taxedId, "ft_balance_of", { account_id: aliceId }));
    const amount = E18;

    const outcome = await callRaw(alice, taxedId, "ft_transfer_call", {
      receiver_id: poolId,
      amount: amount.toString(),
      msg: JSON.stringify({ Swap: { min_out: "0" } }),
    }, { gas: 200, deposit: "1" });

    assert.ok(
      !eventsOf(outcome).some(
        (event) => event.standard === "krater" && event.event === "swap",
      ),
      "a failed payout must not emit Swap",
    );
    assert.equal(
      BigInt(await view(taxedId, "ft_balance_of", { account_id: aliceId })),
      inputBefore,
      "a failed output leg refunds the whole input",
    );
    assert.deepEqual(
      (await view(poolId, "get_reserves")).map(BigInt),
      reservesBefore,
      "a failed output leg restores both cached reserves",
    );
    assert.deepEqual(
      (await view(poolId, "get_payout_backlog", { account_id: aliceId })).map(BigInt),
      [0n, 0n],
      "the refund is immediate; the failure leaves no payout debt",
    );

    await call(alice, rebasingId, "storage_deposit", {}, {
      deposit: toYocto("0.02"),
      gas: 30,
    });
  });

  // origin: new row `busy swap refunded`; see C13/RK11 in the W3 doc.
  test("busy swap is refunded", async () => {
    // Self-contained: the forced-output test may have unregistered a sender, so
    // re-register both on both tokens before racing the two swaps.
    for (const account of [alice, bob]) {
      for (const tokenId of [rebasingId, taxedId]) {
        await call(account, tokenId, "storage_deposit", {}, {
          deposit: toYocto("0.02"),
          gas: 30,
        });
      }
    }
    await call(bob, poolId, "sync_reserves", {}, { gas: 100 });
    const amount = E18 / 2n;
    const aliceBefore = BigInt(await view(taxedId, "ft_balance_of", { account_id: aliceId }));
    const bobBefore = BigInt(await view(taxedId, "ft_balance_of", { account_id: bobId }));
    const poolBefore = BigInt(await view(taxedId, "ft_balance_of", { account_id: poolId }));

    // Both transactions are broadcast before either is awaited, so the second
    // ft_on_transfer can land while the first sync chain is pending. The sandbox
    // has no block-level control, so the deterministic assertion is the
    // observable invariant: the pool keeps exactly the input of the swaps that
    // filled, and every sender is either charged once or refunded in full.
    const [aliceOutcome, bobOutcome] = await Promise.all([
      callRaw(alice, taxedId, "ft_transfer_call", {
        receiver_id: poolId,
        amount: amount.toString(),
        msg: JSON.stringify({ Swap: { min_out: "0" } }),
      }, { gas: 200, deposit: "1" }),
      callRaw(bob, taxedId, "ft_transfer_call", {
        receiver_id: poolId,
        amount: amount.toString(),
        msg: JSON.stringify({ Swap: { min_out: "0" } }),
      }, { gas: 200, deposit: "1" }),
    ]);

    const swaps = [...eventsOf(aliceOutcome), ...eventsOf(bobOutcome)].filter(
      (event) => event.standard === "krater" && event.event === "swap",
    );
    assert.ok(swaps.length <= 2, "one swap per sender is the maximum");

    // Zero fills is a valid busy-window outcome: both transfers see the slot and
    // are refunded in full. The invariant assertions below hold either way.
    const executedIn = swaps.reduce((sum, event) => sum + BigInt(event.data.amount_in), 0n);
    const executedOut = swaps.reduce(
      (sum, event) => sum + BigInt(event.data.amount_out_gross),
      0n,
    );
    const aliceSwaps = swaps.filter((event) => event.data.sender === aliceId).length;
    const bobSwaps = swaps.filter((event) => event.data.sender === bobId).length;
    assert.ok(aliceSwaps <= 1 && bobSwaps <= 1, "a sender can fill at most one swap");

    assert.equal(
      BigInt(await view(taxedId, "ft_balance_of", { account_id: poolId })),
      poolBefore + executedIn,
      "the pool keeps the executed inputs only",
    );
    assert.equal(
      BigInt(await view(taxedId, "ft_balance_of", { account_id: aliceId })),
      aliceBefore - BigInt(aliceSwaps) * amount,
      "a refunded swap returns Alice's input in full",
    );
    assert.equal(
      BigInt(await view(taxedId, "ft_balance_of", { account_id: bobId })),
      bobBefore - BigInt(bobSwaps) * amount,
      "a refunded swap returns Bob's input in full",
    );
    // The cache is not authoritative under two concurrent swaps: each sync writes
    // it from its own snapshot. Assert instead that it agrees with a fresh sync.
    await call(bob, poolId, "sync_reserves", {}, { gas: 100 });
    const cacheAfterFirstSync = (await view(poolId, "get_reserves")).map(BigInt);
    await call(bob, poolId, "sync_reserves", {}, { gas: 100 });
    const cacheAfterSecondSync = (await view(poolId, "get_reserves")).map(BigInt);
    assert.deepEqual(
      cacheAfterFirstSync,
      cacheAfterSecondSync,
      "the cached reserves equal a fresh sync",
    );

    for (const [senderId, outcome, filled] of [
      [aliceId, aliceOutcome, aliceSwaps],
      [bobId, bobOutcome, bobSwaps],
    ]) {
      const refunds = ftTransfersOf(outcome).filter(
        (transfer) =>
          transfer.new_owner_id === senderId && BigInt(transfer.amount) === amount,
      );
      assert.equal(
        refunds.length,
        filled === 1 ? 0 : 1,
        filled === 1
          ? `${senderId} filled, so the input stays in the pool`
          : `${senderId} was busy-refunded exactly once`,
      );
    }
  });

  // origin: new row `add_liquidity with insufficient credits fails`.
  test("add_liquidity with insufficient credits fails and leaves credits intact", async () => {
    const depositOutcome = await callRaw(dave, rebasingId, "ft_transfer_call", {
      receiver_id: poolId,
      amount: (5n * E18).toString(),
      msg: "",
    }, { gas: 200, deposit: "1" });
    assert.ok(kraterEventOf(depositOutcome, "credit_added"), "the deposit must be credited");

    const [creditA] = (await view(poolId, "get_deposits", { account_id: daveId })).map(BigInt);
    assert.ok(creditA > 0n);

    const outcome = await callRaw(dave, poolId, "add_liquidity", {
      amounts: [creditA.toString(), "1"],
      min_shares: "0",
    }, { gas: 300, deposit: "1" });

    const failed = kraterEventOf(outcome, "add_liquidity_failed");
    assert.ok(failed, "the add must report why it could not mint");
    assert.equal(failed.data.reason, "InsufficientDeposit");
    assert.deepEqual(
      (await view(poolId, "get_deposits", { account_id: daveId })).map(BigInt),
      [creditA, 0n],
      "a failed add must not debit the credits it checked",
    );
    await clearCredits(dave, daveId);
  });

  // origin: new rows `min_shares` + `test_depositMintsSharesAndLocksTheMinimum`.
  test("min_shares is enforced", async () => {
    for (const tokenId of [rebasingId, taxedId]) {
      await callRaw(dave, tokenId, "ft_transfer_call", {
        receiver_id: poolId,
        amount: (5n * E18).toString(),
        msg: "",
      }, { gas: 200, deposit: "1" });
    }
    const credits = (await view(poolId, "get_deposits", { account_id: daveId })).map(BigInt);
    assert.ok(credits[0] > 0n && credits[1] > 0n);

    const outcome = await callRaw(dave, poolId, "add_liquidity", {
      amounts: [credits[0].toString(), credits[1].toString()],
      min_shares: (1_000n * E18).toString(),
    }, { gas: 300, deposit: "1" });

    const failed = kraterEventOf(outcome, "add_liquidity_failed");
    assert.ok(failed, "the add must report the missed floor");
    assert.equal(failed.data.reason, "MinSharesNotMet");
    assert.deepEqual(
      (await view(poolId, "get_deposits", { account_id: daveId })).map(BigInt),
      credits,
      "a min_shares miss must leave the credits intact",
    );
    await clearCredits(dave, daveId);
  });

  // origin: `AmountTooSmall` vectors (withdraw and deposit side).
  test("zero amount withdraw/add panic", async () => {
    await assert.rejects(
      call(alice, poolId, "withdraw", { shares: "0" }, { gas: 60, deposit: "1" }),
      /AmountTooSmall/,
    );
    await assert.rejects(
      call(alice, poolId, "add_liquidity", {
        amounts: ["0", E18.toString()],
        min_shares: "0",
      }, { gas: 60, deposit: "1" }),
      /AmountTooSmall/,
    );
  });

  // origin: new row `unused deposit credits withdrawable` and the
  // `withdraw_deposit` failure callback in the W3 doc.
  test("withdraw_deposit restores the credit when the payout fails", async () => {
    const amount = 3n * E18;
    await call(dave, taxedId, "mint", {
      receiver_id: daveId,
      amount: amount.toString(),
    }, { gas: 30 });
    const depositOutcome = await callRaw(dave, taxedId, "ft_transfer_call", {
      receiver_id: poolId,
      amount: amount.toString(),
      msg: "",
    }, { gas: 200, deposit: "1" });
    assert.ok(kraterEventOf(depositOutcome, "credit_added"));

    const credits = (await view(poolId, "get_deposits", { account_id: daveId })).map(BigInt);
    assert.equal(credits[1], amount);

    // Drain and unregister so the pool's payout has nowhere to land.
    const wallet = BigInt(await view(taxedId, "ft_balance_of", { account_id: daveId }));
    if (wallet > 0n) {
      await call(dave, taxedId, "ft_transfer", {
        receiver_id: bobId,
        amount: wallet.toString(),
      }, { gas: 30, deposit: "1" });
    }
    await call(dave, taxedId, "storage_unregister", {}, { gas: 30, deposit: "1" });
    const poolBefore = BigInt(await view(taxedId, "ft_balance_of", { account_id: poolId }));

    const outcome = await callExpectingFailedLeg(dave, poolId, "withdraw_deposit", {
      token: taxedId,
      amount: amount.toString(),
    }, { gas: 100, deposit: "1" });
    assert.ok(kraterEventOf(outcome, "credit_withdrawn"), "the debit must be reported");

    assert.deepEqual(
      (await view(poolId, "get_deposits", { account_id: daveId })).map(BigInt),
      credits,
      "a failed payout must restore exactly the debited credit",
    );
    assert.equal(
      BigInt(await view(taxedId, "ft_balance_of", { account_id: daveId })),
      0n,
      "no tokens may arrive from a failed payout",
    );
    assert.equal(
      BigInt(await view(taxedId, "ft_balance_of", { account_id: poolId })),
      poolBefore,
      "the failed payout keeps the pool's tokens",
    );

    await call(dave, taxedId, "storage_deposit", {}, {
      deposit: toYocto("0.02"),
      gas: 30,
    });
  });

  // origin: new row `failed payout in backlog and claim_owed clears it`.
  test("claim_owed restores owed when its payout fails", async () => {
    await clearCredits(dave, daveId);
    for (const tokenId of [rebasingId, taxedId]) {
      await call(dave, tokenId, "mint", {
        receiver_id: daveId,
        amount: (10n * E18).toString(),
      }, { gas: 30 });
    }
    for (const tokenId of [rebasingId, taxedId]) {
      await callRaw(dave, tokenId, "ft_transfer_call", {
        receiver_id: poolId,
        amount: (6n * E18).toString(),
        msg: "",
      }, { gas: 200, deposit: "1" });
    }
    const [creditA, creditB] = (await view(poolId, "get_deposits", { account_id: daveId }))
      .map(BigInt);
    assert.ok(creditA > 0n && creditB > 0n);
    await callRaw(dave, poolId, "add_liquidity", {
      amounts: [creditA.toString(), creditB.toString()],
      min_shares: "0",
    }, { gas: 300, deposit: "1" });
    await clearCredits(dave, daveId);

    const shares = BigInt(await view(poolId, "ft_balance_of", { account_id: daveId }));
    assert.ok(shares > 0n, "the add must mint shares");

    // Leave token A unregistered so the withdrawal's A leg fails and becomes owed.
    const walletA = BigInt(await view(rebasingId, "ft_balance_of", { account_id: daveId }));
    if (walletA > 0n) {
      await call(dave, rebasingId, "ft_transfer", {
        receiver_id: bobId,
        amount: walletA.toString(),
      }, { gas: 30, deposit: "1" });
    }
    await call(dave, rebasingId, "storage_unregister", {}, { gas: 30, deposit: "1" });

    const withdrawOutcome = await callExpectingFailedLeg(dave, poolId, "withdraw", {
      shares: shares.toString(),
    }, { gas: 300, deposit: "1" });
    const withdrawEvent = kraterEventOf(withdrawOutcome, "withdraw");
    assert.ok(withdrawEvent, "the withdrawal settles before the leg fails");
    const owedA = BigInt(withdrawEvent.data.amount_a);
    assert.ok(owedA > 0n, "the A leg must have a non-zero amount");
    assert.equal(
      BigInt(await view(poolId, "ft_balance_of", { account_id: daveId })),
      0n,
      "the shares must burn even when the payout leg fails",
    );
    let backlog = (await view(poolId, "get_payout_backlog", { account_id: daveId })).map(BigInt);
    assert.equal(backlog[0], owedA);
    const reservesBeforeClaim = (await view(poolId, "get_reserves")).map(BigInt);

    // Claim while the payout token is still refused: the callback must put the
    // owed amount and its reserve back.
    await callExpectingFailedLeg(dave, poolId, "claim_owed", {
      token: rebasingId,
    }, { gas: 100, deposit: "1" });
    backlog = (await view(poolId, "get_payout_backlog", { account_id: daveId })).map(BigInt);
    assert.equal(backlog[0], owedA, "a failed claim must restore the backed amount");
    assert.deepEqual(
      (await view(poolId, "get_reserves")).map(BigInt),
      reservesBeforeClaim,
      "a failed claim must restore the reserve it debited",
    );

    await call(dave, rebasingId, "storage_deposit", {}, {
      deposit: toYocto("0.02"),
      gas: 30,
    });
    const balanceBefore = BigInt(
      await view(rebasingId, "ft_balance_of", { account_id: daveId }),
    );
    await call(dave, poolId, "claim_owed", { token: rebasingId }, {
      gas: 100,
      deposit: "1",
    });
    assert.deepEqual(
      (await view(poolId, "get_payout_backlog", { account_id: daveId })).map(BigInt),
      [0n, 0n],
      "a funded claim clears the backlog",
    );
    const paid = BigInt(await view(rebasingId, "ft_balance_of", { account_id: daveId }))
      - balanceBefore;
    const indexA = BigInt(await view(rebasingId, "ft_index"));
    assert.ok(
      paid >= owedA && paid <= owedA + indexA / E18 + 1n,
      `the fixture pays the owed amount plus at most one share-grid step: ${paid} vs ${owedA}`,
    );
  });

  // origin: step 7/8 client contract: every pool action is a signed 1-yocto call.
  test("no-yocto calls are rejected", async () => {
    await assert.rejects(
      call(alice, poolId, "add_liquidity", {
        amounts: ["1", "1"],
        min_shares: "0",
      }, { gas: 60, deposit: "0" }),
      /1 yoctoNEAR/,
    );
    await assert.rejects(
      call(alice, poolId, "withdraw", { shares: "1" }, { gas: 60, deposit: "0" }),
      /1 yoctoNEAR/,
    );
    await assert.rejects(
      call(alice, poolId, "withdraw_deposit", {
        token: taxedId,
        amount: "1",
      }, { gas: 60, deposit: "0" }),
      /1 yoctoNEAR/,
    );
    await assert.rejects(
      call(alice, poolId, "claim_owed", { token: taxedId }, { gas: 60, deposit: "0" }),
      /1 yoctoNEAR/,
    );
  });

  // origin: `test_aDepositIsCreditedOnWhatArrived` (short side) and the
  // `min_credit_deposit = 10^(decimals-3)` rule.
  test("short deposit is refunded", async () => {
    const short = 10n ** 12n; // below 10^(18-3) = 1e15 base units
    const balanceBefore = BigInt(await view(taxedId, "ft_balance_of", { account_id: aliceId }));
    const depositsBefore = await view(poolId, "get_deposits", { account_id: aliceId });

    const outcome = await callRaw(alice, taxedId, "ft_transfer_call", {
      receiver_id: poolId,
      amount: short.toString(),
      msg: "",
    }, { gas: 200, deposit: "1" });

    assert.equal(
      BigInt(await view(taxedId, "ft_balance_of", { account_id: aliceId })),
      balanceBefore,
      "a below-floor deposit must be refunded in full",
    );
    assert.deepEqual(
      await view(poolId, "get_deposits", { account_id: aliceId }),
      depositsBefore,
      "a below-floor deposit must not create a credit",
    );
    assert.ok(
      !eventsOf(outcome).some(
        (event) => event.standard === "krater" && event.event === "credit_added",
      ),
      "a refunded deposit must not emit CreditAdded",
    );
  });

  // origin: `test_aTaxedOutputPaysTheTraderNetOfTheTokensCut`,
  // `test_aTaxedInputNeedsARouterThatOverSends`,
  // `test_aTokenThatChangesItsFeeNeedsNoReconfiguration`.
  test("taxed token reports net", async () => {
    const gross = 10n * E18;
    await call(dave, taxedId, "mint", {
      receiver_id: daveId,
      amount: FUND.toString(),
    }, { gas: 30 });
    const tax = BigInt(TRANSFER_TAX_BPS);
    const net = gross - (gross * tax) / 10_000n;
    await call(dave, taxedId, "set_fee", { bps: TRANSFER_TAX_BPS }, { gas: 30 });
    try {
      const depositsBefore = (await view(poolId, "get_deposits", { account_id: daveId }))
        .map(BigInt);
      const walletBefore = BigInt(await view(taxedId, "ft_balance_of", { account_id: daveId }));
      const poolBefore = BigInt(await view(taxedId, "ft_balance_of", { account_id: poolId }));

      const depositOutcome = await callRaw(dave, taxedId, "ft_transfer_call", {
        receiver_id: poolId,
        amount: gross.toString(),
        msg: "",
      }, { gas: 200, deposit: "1" });
      const added = kraterEventOf(depositOutcome, "credit_added");
      assert.ok(added, "the taxed deposit is still credited");
      assert.equal(added.data.amount, net.toString(), "the credit is the net receipt");
      assert.equal(
        BigInt(await view(taxedId, "ft_balance_of", { account_id: daveId })),
        walletBefore - gross,
        "the sender pays the gross amount",
      );
      assert.equal(
        BigInt(await view(taxedId, "ft_balance_of", { account_id: poolId })),
        poolBefore + net,
        "the pool receives the net amount",
      );
      const credited = (await view(poolId, "get_deposits", { account_id: daveId })).map(BigInt);
      assert.equal(credited[1] - depositsBefore[1], net);

      await call(bob, poolId, "sync_reserves", {}, { gas: 100 });
      const reservesBefore = (await view(poolId, "get_reserves")).map(BigInt);
      const grossSwap = 5n * E18;
      const netSwap = grossSwap - (grossSwap * tax) / 10_000n;
      const swapOutcome = await callRaw(dave, taxedId, "ft_transfer_call", {
        receiver_id: poolId,
        amount: grossSwap.toString(),
        msg: JSON.stringify({ Swap: { min_out: "0" } }),
      }, { gas: 200, deposit: "1" });
      const swapEvent = kraterEventOf(swapOutcome, "swap");
      assert.ok(swapEvent, "the taxed swap fills");
      assert.equal(swapEvent.data.amount_in, netSwap.toString(), "the quote uses the net");
      const reservesAfter = (await view(poolId, "get_reserves")).map(BigInt);
      assert.equal(
        reservesAfter[1],
        reservesBefore[1] + netSwap,
        "the input reserve grows by the net, not the gross",
      );
      assert.notEqual(reservesAfter[1], reservesBefore[1] + grossSwap);
    } finally {
      await call(dave, taxedId, "set_fee", { bps: 0 }, { gas: 30 });
    }

    const leftover = (await view(poolId, "get_deposits", { account_id: daveId })).map(BigInt);
    assert.equal(leftover[1], net, "the taxed credit is still withdrawable at the net");
    await clearCredits(dave, daveId);
  });

  // origin: predecessor allowlist (auth row in the W3 doc).
  test("non-token predecessor is refused", async () => {
    const depositsBefore = await view(poolId, "get_deposits", { account_id: bobId });
    const reservesBefore = await view(poolId, "get_reserves");

    const outcome = await callRaw(alice, poolId, "ft_on_transfer", {
      sender_id: bobId,
      amount: "1000",
      msg: "",
    }, { gas: 60, deposit: "0" });

    assert.equal(successValue(outcome), "1000", "an unknown predecessor refunds the amount");
    assert.deepEqual(
      await view(poolId, "get_deposits", { account_id: bobId }),
      depositsBefore,
      "a direct call must not mint a credit",
    );
    assert.deepEqual(
      await view(poolId, "get_reserves"),
      reservesBefore,
      "a direct call must not move the cache",
    );
  });

  // origin: new row `a swap never pays out credited deposits` (RK11/audit-2).
  test("a swap never pays credited deposits", async () => {
    await clearCredits(alice, aliceId);
    await clearCredits(bob, bobId);
    await clearCredits(dave, daveId);
    const credit = 7n * E18;
    await callRaw(dave, taxedId, "ft_transfer_call", {
      receiver_id: poolId,
      amount: credit.toString(),
      msg: "",
    }, { gas: 200, deposit: "1" });
    const daveCredits = (await view(poolId, "get_deposits", { account_id: daveId })).map(BigInt);
    assert.equal(daveCredits[1], credit);

    await call(bob, poolId, "sync_reserves", {}, { gas: 100 });
    const reservesBefore = (await view(poolId, "get_reserves")).map(BigInt);
    const poolBefore = BigInt(await view(taxedId, "ft_balance_of", { account_id: poolId }));
    assert.equal(
      reservesBefore[1],
      poolBefore - credit,
      "the cached reserve must exclude the credited deposit",
    );

    const bobBefore = BigInt(await view(taxedId, "ft_balance_of", { account_id: bobId }));
    const swapOutcome = await callRaw(bob, rebasingId, "ft_transfer_call", {
      receiver_id: poolId,
      amount: E18.toString(),
      msg: JSON.stringify({ Swap: { min_out: "0" } }),
    }, { gas: 200, deposit: "1" });
    const swapEvent = kraterEventOf(swapOutcome, "swap");
    assert.ok(swapEvent, "the swap fills");
    const amountIn = BigInt(swapEvent.data.amount_in);
    const amountOut = BigInt(swapEvent.data.amount_out_gross);
    assert.ok(amountOut > 0n);

    const reservesAfter = (await view(poolId, "get_reserves")).map(BigInt);
    // Index-scaled fixture shares round by at most one base unit.
    const near = (actual, expected) => actual >= expected - 1n && actual <= expected + 1n;
    assert.ok(near(reservesAfter[0], reservesBefore[0] + amountIn), "input reserve");
    assert.ok(near(reservesAfter[1], reservesBefore[1] - amountOut), "output reserve");
    assert.ok(
      near(
        BigInt(await view(taxedId, "ft_balance_of", { account_id: poolId })),
        reservesAfter[1] + credit,
      ),
      "the credited tokens stay fully backed after the swap",
    );
    assert.ok(
      near(BigInt(await view(taxedId, "ft_balance_of", { account_id: bobId })) - bobBefore, amountOut),
      "the trader receives the quoted output",
    );
    assert.deepEqual(
      (await view(poolId, "get_deposits", { account_id: daveId })).map(BigInt),
      daveCredits,
      "the swap must not consume the credit",
    );

    const daveBefore = BigInt(await view(taxedId, "ft_balance_of", { account_id: daveId }));
    await call(dave, poolId, "withdraw_deposit", {
      token: taxedId,
      amount: credit.toString(),
    }, { gas: 100, deposit: "1" });
    assert.equal(
      BigInt(await view(taxedId, "ft_balance_of", { account_id: daveId })) - daveBefore,
      credit,
      "the untouched credit is still withdrawable",
    );
    assert.deepEqual(
      (await view(poolId, "get_deposits", { account_id: daveId })).map(BigInt),
      [0n, 0n],
    );
  });

  // origin: new row `a rebase between deposit and add rescales credits`.
  test("a rebase between deposit and add does not haircut credits", async () => {
    await clearCredits(dave, daveId);
    const depositA = 8n * E18;
    const depositB = 32n * E18;
    for (const tokenId of [rebasingId, taxedId]) {
      await call(dave, tokenId, "mint", {
        receiver_id: daveId,
        amount: (100n * E18).toString(),
      }, { gas: 30 });
    }
    await callRaw(dave, rebasingId, "ft_transfer_call", {
      receiver_id: poolId,
      amount: depositA.toString(),
      msg: "",
    }, { gas: 200, deposit: "1" });
    await callRaw(dave, taxedId, "ft_transfer_call", {
      receiver_id: poolId,
      amount: depositB.toString(),
      msg: "",
    }, { gas: 200, deposit: "1" });
    const beforeRebase = (await view(poolId, "get_deposits", { account_id: daveId })).map(BigInt);
    assert.ok(beforeRebase[0] > 0n && beforeRebase[1] > 0n);

    await call(bob, rebasingId, "rebase", { factor_bps: 11_000 }, { gas: 30 });
    const syncOutcome = await callRaw(bob, poolId, "sync_reserves", {}, { gas: 100 });
    assert.ok(kraterEventOf(syncOutcome, "reserves_synced"));

    const [creditA, creditB] = (await view(poolId, "get_deposits", { account_id: daveId }))
      .map(BigInt);
    assert.ok(
      creditA > beforeRebase[0],
      "the credit must follow the rebase up instead of keeping its deposit nominal",
    );
    assert.equal(creditB, beforeRebase[1], "the non-rebasing leg is unchanged");

    const [reserveA, reserveB] = (await view(poolId, "get_reserves")).map(BigInt);
    const supply = BigInt(await view(poolId, "ft_total_supply"));
    const shareValueA = (creditA * supply) / reserveA;
    const shareValueB = (creditB * supply) / reserveB;
    assert.ok(shareValueA < shareValueB, "the A side must bind for this vector");
    const expectedShares = shareValueA;
    const staleShares = (beforeRebase[0] * supply) / reserveA;
    assert.ok(
      expectedShares > staleShares,
      "minting from the pre-rebase credit would haircut the deposit",
    );

    const spentA = (() => {
      const ceil = ceilDiv(expectedShares * reserveA, supply);
      return ceil < creditA ? ceil : creditA;
    })();
    const spentB = (() => {
      const ceil = ceilDiv(expectedShares * reserveB, supply);
      return ceil < creditB ? ceil : creditB;
    })();

    const outcome = await callRaw(dave, poolId, "add_liquidity", {
      amounts: [creditA.toString(), creditB.toString()],
      min_shares: "0",
    }, { gas: 300, deposit: "1" });
    const depositEvent = kraterEventOf(outcome, "deposit");
    assert.ok(depositEvent, "the add must mint");
    assert.equal(depositEvent.data.shares, expectedShares.toString());
    assert.equal(depositEvent.data.amount_a, spentA.toString());
    assert.equal(depositEvent.data.amount_b, spentB.toString());

    // Credits are nominal while the ledger is share-denominated, so the
    // remainder may move by at most one share-grid step of the current index.
    const after = (await view(poolId, "get_deposits", { account_id: daveId })).map(BigInt);
    const creditDeltaA = after[0] + spentA - creditA;
    assert.ok(
      creditDeltaA >= -2n && creditDeltaA <= 2n,
      `the rebasing credit may lose at most a share-grid step: ${creditDeltaA}`,
    );
    assert.equal(after[1] + spentB, creditB, "the non-rebasing leg is exact");
    await clearCredits(dave, daveId);
  });

  // origin: fuzz `testFuzz_anInputAlwaysGrowsTheReserveItArrivedIn` — seeded
  // loop, 64 iterations, seed 0xC0FFEE. Slow: one settled swap per iteration.
  test("fuzz: an input always grows the reserve it arrived in", { timeout: 1_200_000 }, async () => {
    await call(bob, poolId, "sync_reserves", {}, { gas: 100 });
    let seed = BigInt(FUZZ_SEED);
    for (let iteration = 0; iteration < FUZZ_ITERATIONS; iteration += 1) {
      seed = nextSeed(seed);
      const directionA = seed % 2n === 0n;
      const amount = ((1n + (seed % 9n)) * E18) / 10n;
      const [beforeA, beforeB] = (await view(poolId, "get_reserves")).map(BigInt);
      const tokenIn = directionA ? rebasingId : taxedId;

      const outcome = await callRaw(bob, tokenIn, "ft_transfer_call", {
        receiver_id: poolId,
        amount: amount.toString(),
        msg: JSON.stringify({ Swap: { min_out: "0" } }),
      }, { gas: 200, deposit: "1" });
      const swapEvent = kraterEventOf(outcome, "swap");
      assert.ok(swapEvent, `iteration ${iteration}: the swap must fill`);
      const amountIn = BigInt(swapEvent.data.amount_in);
      const amountOut = BigInt(swapEvent.data.amount_out_gross);
      assert.ok(amountIn > 0n && amountOut > 0n);

      const [afterA, afterB] = (await view(poolId, "get_reserves")).map(BigInt);
      // The fixture credits `ceil`/floor shares at its index, so the measured
      // reserve delta can differ from the nominal event amount by one base unit.
      const near = (actual, expected) => actual >= expected - 1n && actual <= expected + 1n;
      if (directionA) {
        assert.ok(near(afterA, beforeA + amountIn), `iteration ${iteration}: reserve A`);
        assert.ok(near(afterB, beforeB - amountOut), `iteration ${iteration}: reserve B`);
      } else {
        assert.ok(near(afterB, beforeB + amountIn), `iteration ${iteration}: reserve B`);
        assert.ok(near(afterA, beforeA - amountOut), `iteration ${iteration}: reserve A`);
      }
    }
  });

  // origin: fuzz `testFuzz_sharesTrackWhateverTheReservesBecome` — seeded loop,
  // 64 iterations, seed 0xC0FFEE, rebase factors 5_000-20_000. Slow.
  test("fuzz: shares track whatever the reserves become", { timeout: 1_200_000 }, async () => {
    for (const tokenId of [rebasingId, taxedId]) {
      await call(bob, tokenId, "mint", {
        receiver_id: bobId,
        amount: (20n * E18).toString(),
      }, { gas: 30 });
    }
    for (const tokenId of [rebasingId, taxedId]) {
      await callRaw(bob, tokenId, "ft_transfer_call", {
        receiver_id: poolId,
        amount: (10n * E18).toString(),
        msg: "",
      }, { gas: 200, deposit: "1" });
    }
    const [creditA, creditB] = (await view(poolId, "get_deposits", { account_id: bobId }))
      .map(BigInt);
    assert.ok(creditA > 0n && creditB > 0n);
    await callRaw(bob, poolId, "add_liquidity", {
      amounts: [creditA.toString(), creditB.toString()],
      min_shares: "0",
    }, { gas: 300, deposit: "1" });
    await clearCredits(bob, bobId);
    assert.ok(BigInt(await view(poolId, "ft_balance_of", { account_id: bobId })) > 0n);

    let seed = BigInt(FUZZ_SEED);
    for (let iteration = 0; iteration < FUZZ_ITERATIONS; iteration += 1) {
      seed = nextSeed(seed);
      const factor = 5_000n + (seed % 15_001n);
      await call(bob, rebasingId, "rebase", { factor_bps: Number(factor) }, { gas: 30 });
      await call(bob, poolId, "sync_reserves", {}, { gas: 100 });

      const [reserveA, reserveB] = (await view(poolId, "get_reserves")).map(BigInt);
      const supply = BigInt(await view(poolId, "ft_total_supply"));
      const shares = BigInt(await view(poolId, "ft_balance_of", { account_id: bobId }));
      const slice = shares / 100n;
      assert.ok(slice > 0n, `iteration ${iteration}: no shares left to withdraw`);
      const expectedA = (slice * reserveA) / supply;
      const expectedB = (slice * reserveB) / supply;
      assert.ok(expectedA >= 0n && expectedB >= 0n);
      assert.ok(expectedA + expectedB > 0n, `iteration ${iteration}: both legs round to zero`);
      const indexA = BigInt(await view(rebasingId, "ft_index"));
      const balanceABefore = BigInt(
        await view(rebasingId, "ft_balance_of", { account_id: bobId }),
      );
      const balanceBBefore = BigInt(
        await view(taxedId, "ft_balance_of", { account_id: bobId }),
      );

      const outcome = await callRaw(bob, poolId, "withdraw", {
        shares: slice.toString(),
      }, { gas: 300, deposit: "1" });
      const withdrawEvent = kraterEventOf(outcome, "withdraw");
      assert.ok(withdrawEvent, `iteration ${iteration}: the withdrawal settles`);
      assert.equal(withdrawEvent.data.shares, slice.toString());
      assert.equal(withdrawEvent.data.amount_a, expectedA.toString());
      assert.equal(withdrawEvent.data.amount_b, expectedB.toString());
      assert.equal(
        BigInt(await view(poolId, "ft_balance_of", { account_id: bobId })),
        shares - slice,
        `iteration ${iteration}: shares burn`,
      );
      assert.equal(
        BigInt(await view(poolId, "ft_total_supply")),
        supply - slice,
        `iteration ${iteration}: supply burns`,
      );
      const [afterA, afterB] = (await view(poolId, "get_reserves")).map(BigInt);
      assert.equal(afterA, reserveA - expectedA, `iteration ${iteration}: reserve A slice`);
      assert.equal(afterB, reserveB - expectedB, `iteration ${iteration}: reserve B slice`);

      const paidA = BigInt(await view(rebasingId, "ft_balance_of", { account_id: bobId }))
        - balanceABefore;
      const paidB = BigInt(await view(taxedId, "ft_balance_of", { account_id: bobId }))
        - balanceBBefore;
      assert.ok(paidA >= 0n && paidB >= 0n, "payout legs cannot go negative");
      // The rebasing fixture pays in whole shares, so a non-ONE index can add at
      // most one share's nominal value; token B (index ONE) is exact.
      const shareGrid = indexA / E18 + 1n;
      assert.ok(
        paidA >= expectedA && paidA <= expectedA + shareGrid,
        `iteration ${iteration}: rebasing payout ${paidA} vs ${expectedA}`,
      );
      assert.equal(paidB, expectedB);
    }
  });

  // origin: ST09c row `EVENT_JSON envelope parses` and `ft_metadata` decimals.
  test("EVENT_JSON envelope covers every emitted pool variant", async () => {
    const variants = [
      "swap",
      "deposit",
      "withdraw",
      "reserves_synced",
      "credit_added",
      "credit_spent",
      "credit_withdrawn",
      "add_liquidity_failed",
    ];
    for (const name of variants) {
      const event = seenEvents.get(name);
      assert.ok(event, `the suite never observed a ${name} event`);
      assert.equal(event.standard, "krater");
      assert.equal(event.version, "1.0.0");
      assert.equal(event.event, name);
      assert.equal(typeof event.data, "object");
      assert.ok(event.data !== null && !Array.isArray(event.data), "pool data is one object");
    }

    const metadata = await view(poolId, "ft_metadata");
    assert.equal(metadata.decimals, 18);
    assert.equal(metadata.spec, "ft-1.0.0");
  });
});
