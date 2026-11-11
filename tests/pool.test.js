// W1 surface tests for the Krater pool, on a near-kit sandbox.
//
// These cover what the scaffold promises: the metadata views match the shipped
// manifest, the share token is NEP-148 with 18 decimals, `new` refuses an equal
// pair and an out-of-range fee, the reserve cache starts empty, and a quote
// refuses an empty pool or an unknown token. Flow behaviour (swaps, liquidity,
// refunds) is covered once those methods exist.
//
// Build first: cargo near build. Override the wasm paths with POOL_WASM and
// MOCK_FT_WASM. Run with: node --test tests/pool.test.js

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import {
  Account,
  JsonRpcProvider,
  KeyPair,
  actions,
  nearToYocto,
  teraToGas,
} from "near-api-js";
import { Sandbox } from "near-kit/sandbox";

const POOL_WASM = process.env.POOL_WASM ?? "target/near/krater_pool.wasm";
const MOCK_FT_WASM = process.env.MOCK_FT_WASM ?? "target/near/krater_mock_ft.wasm";
const SPEC_URI = "https://raw.githubusercontent.com/nirholas/near-krater/main/manifest.json";
const TAGS = ["curve", "rebasing", "fee-on-transfer", "custom-curve", "no-admin"];

let sandbox;
let provider;
let pool;
let equalPair;
let badFee;
let poolId;
let rebasingId;
let taxedId;
let manifest;

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
