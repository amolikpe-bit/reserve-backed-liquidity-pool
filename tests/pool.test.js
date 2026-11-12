// Surface and flow tests for the Krater pool, on a near-kit sandbox.
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
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { after, before, describe, test } from "node:test";
import {
  Account,
  JsonRpcProvider,
  KeyPair,
  actions,
  nearToYocto,
  teraToGas,
} from "near-api-js";
import { Sandbox } from "near-kit/sandbox";

const POOL_WASM = process.env.POOL_WASM ?? "target/near/krater_pool/krater_pool.wasm";
const MOCK_FT_WASM =
  process.env.MOCK_FT_WASM ?? "target/near/krater_mock_ft/krater_mock_ft.wasm";
const SPEC_URI = "https://raw.githubusercontent.com/nirholas/near-krater/main/manifest.json";
const TAGS = ["curve", "rebasing", "fee-on-transfer", "custom-curve", "no-admin"];
const E18 = 10n ** 18n;
const FUND = 1_000n * E18;
const SEED = 200n * E18;

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

const GAS = (tgas) => teraToGas(String(tgas));

async function readWasm(path) {
  assert.ok(existsSync(path), `missing wasm at ${path}; run "cargo near build" first`);
  return new Uint8Array(await readFile(path));
}

function call(account, contractId, methodName, args, { gas = 60, deposit = "0" } = {}) {
  return account.callFunction({
    contractId,
    methodName,
    args,
    gas: GAS(gas),
    deposit,
    waitUntil: "FINAL",
  });
}

function view(contractId, method, args = {}) {
  return provider.callFunction({ contractId, method, args });
}

function toYocto(near) {
  return nearToYocto(String(near).trim().replace(/\s*NEAR$/i, ""));
}

async function createAccount(root, accountId, nearAmount) {
  const keyPair = KeyPair.fromRandom("ED25519");
  await root.signAndSendTransaction({
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

function callRaw(account, contractId, methodName, args, { gas = 60, deposit = "0" } = {}) {
  return account.callFunctionRaw({
    contractId,
    methodName,
    args,
    gas: GAS(gas),
    deposit,
    waitUntil: "FINAL",
  });
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

function logsOf(outcome) {
  const logs = [];
  for (const receipt of outcome.receipts_outcome ?? []) {
    logs.push(...(receipt.outcome.logs ?? []));
  }
  logs.push(...(outcome.transaction_outcome?.outcome?.logs ?? []));
  return logs;
}

function eventsOf(outcome) {
  return logsOf(outcome)
    .filter((line) => line.startsWith("EVENT_JSON:"))
    .map((line) => JSON.parse(line.slice("EVENT_JSON:".length)));
}

before(async () => {
  manifest = JSON.parse(await readFile("manifest.json", "utf8"));
  const [poolWasm, mockWasm] = await Promise.all([readWasm(POOL_WASM), readWasm(MOCK_FT_WASM)]);

  sandbox = await Sandbox.start();
  provider = new JsonRpcProvider({ url: sandbox.rpcUrl });
  const root = new Account(sandbox.rootAccount.id, provider, sandbox.rootAccount.secretKey);
  const suffix = sandbox.rootAccount.id;

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

  await deploy(pool, poolId, poolWasm);
  await deploy(rebasing, rebasingId, mockWasm);
  await deploy(taxed, taxedId, mockWasm);
  await deploy(equalPair, equalPairId, poolWasm);
  await deploy(badFee, badFeeId, poolWasm);

  await call(pool, poolId, "new", {
    token_a: rebasingId,
    token_b: taxedId,
    swap_fee_bps: 30,
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
  if (sandbox) {
    await sandbox.stop();
  }
});

test("the metadata views match the shipped manifest", async () => {
  assert.equal(await view(poolId, "pool_name"), manifest.name);
  assert.equal(await view(poolId, "pool_version"), manifest.version);
  assert.equal(await view(poolId, "spec_uri"), SPEC_URI);
  assert.deepEqual(await view(poolId, "pool_tags"), manifest.tags);
});

test("LP shares are NEP-148 with 18 decimals", async () => {
  const metadata = await view(poolId, "ft_metadata");
  assert.equal(metadata.spec, "ft-1.0.0");
  assert.equal(metadata.decimals, 18);
  assert.equal(metadata.name, "Krater test LP");
  assert.equal(metadata.symbol, "K-TEST");
});

test("new refuses an equal pair", async () => {
  await assert.rejects(
    call(equalPair, equalPair.accountId, "new", {
      token_a: rebasingId,
      token_b: rebasingId,
      swap_fee_bps: 30,
      share_name: "Bad LP",
      share_symbol: "BAD",
    }, { gas: 100 }),
    /InvalidPair/,
  );
});

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

test("the reserve cache starts empty", async () => {
  assert.deepEqual(await view(poolId, "get_reserves"), ["0", "0"]);
});

test("a quote on empty reserves panics rather than returning zero", async () => {
  await assert.rejects(
    view(poolId, "get_quote", { token_in: rebasingId, amount_in: "1000" }),
    /NoReserves/,
  );
});

test("a quote refuses a token outside the pair", async () => {
  await assert.rejects(
    view(poolId, "get_quote", { token_in: "not-a-pair-token.test.near", amount_in: "1000" }),
    /UnknownToken/,
  );
});

test("the pool advertises the five manifest tags", async () => {
  const tags = await view(poolId, "pool_tags");
  assert.equal(tags.length, 5);
  assert.deepEqual(tags, TAGS);
});

describe("W2 flows", () => {
  before(async () => {
    const root = new Account(sandbox.rootAccount.id, provider, sandbox.rootAccount.secretKey);
    aliceId = `alice.${sandbox.rootAccount.id}`;
    bobId = `bob.${sandbox.rootAccount.id}`;
    carolId = `carol.${sandbox.rootAccount.id}`;
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
