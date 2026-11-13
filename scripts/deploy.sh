#!/usr/bin/env bash
# Deploy krater to a NEAR network, initialise it, register the accounts that will
# hold its LP shares, and then lock the pool account by deleting every access key.
#
# Required tools: cargo-near (0.23.0), near-cli-rs (0.31.1), wasm-opt (binaryen),
# and a funded signer in the OS keychain. Nothing is read from a private key file:
# near-cli-rs signs with the keychain entry for the account in each command.
#
# Environment (all optional, defaults in parentheses):
#   KRATER_ACCOUNT   (krater.testnet)             the pool account
#   REBASING_ACCOUNT (rebasing.krater.testnet)    rebasing fixture token
#   TAXED_ACCOUNT    (taxed.krater.testnet)       tax-on-transfer fixture token
#   DEMO_ACCOUNTS    (alice.krater.testnet bob.krater.testnet)  space separated
#   NEAR_NETWORK     (testnet)
#   SWAP_FEE_BPS     (30)
#   SHARE_NAME       (Krater LP)
#   SHARE_SYMBOL     (K-LP)
#   FUND_AMOUNT      (10 NEAR)  per created subaccount
#   STORAGE_DEPOSIT  (0.01 NEAR) per NEP-145 registration
#   INIT_GAS         (300 Tgas, near-cli prepaid gas for each `new` call)
#
# Gas: INIT_GAS (300 Tgas) is a near-cli-rs prepaid-gas value, not a protocol
# ceiling. A function call may attach up to 1000 Tgas and a transaction up to
# 1 PGas; every prepaid-gas value below stays inside that envelope, and the pool's
# static chain (callbacks 90/80/70/60 Tgas, 25 to fill, 45 to settle) is budgeted
# from the gas the caller attaches.
#
# Build: `cargo near build non-reproducible-wasm` and
# `cargo near deploy build-non-reproducible-wasm` produce and ship the local wasm.
# The default reproducible variants run Docker against committed source (their
# deploy variant also needs it pushed), so they are not part of this script: a
# reproducible deployment is W4 work and uses the image pinned in
# contracts/pool/Cargo.toml.
# Re-running against an already-initialised pool fails at the init call on purpose:
# `new` runs once.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

KRATER_ACCOUNT="${KRATER_ACCOUNT:-krater.testnet}"
REBASING_ACCOUNT="${REBASING_ACCOUNT:-rebasing.krater.testnet}"
TAXED_ACCOUNT="${TAXED_ACCOUNT:-taxed.krater.testnet}"
DEMO_ACCOUNTS="${DEMO_ACCOUNTS:-alice.krater.testnet bob.krater.testnet}"
NEAR_NETWORK="${NEAR_NETWORK:-testnet}"
SWAP_FEE_BPS="${SWAP_FEE_BPS:-30}"
SHARE_NAME="${SHARE_NAME:-Krater LP}"
SHARE_SYMBOL="${SHARE_SYMBOL:-K-LP}"
FUND_AMOUNT="${FUND_AMOUNT:-10 NEAR}"
STORAGE_DEPOSIT="${STORAGE_DEPOSIT:-0.01 NEAR}"
INIT_GAS="${INIT_GAS:-300 Tgas}"

case "$SWAP_FEE_BPS" in
  *[!0-9]* | "")
    printf 'error: SWAP_FEE_BPS must be a whole number\n' >&2
    exit 1
    ;;
esac

# 300 Tgas is a near-cli-rs value, not a ceiling: a call may attach up to 1000
# Tgas, so anything larger than that is a mistake rather than a bigger budget.
init_tgas="${INIT_GAS%%[!0-9]*}"
if [ -z "$init_tgas" ] || [ "$init_tgas" -lt 1 ] || [ "$init_tgas" -gt 1000 ]; then
  printf 'error: INIT_GAS must be 1..1000 Tgas, not %s\n' "$INIT_GAS" >&2
  exit 1
fi

WORK_DIR="$(mktemp -d)"
cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

account_exists() {
  near account view-account-summary "$1" network-config "$NEAR_NETWORK" now >/dev/null 2>&1
}

# A top-level name is created through the testnet faucet service, which also
# generates and stores a key. On mainnet the account must already exist and be
# funded; the script will not create it.
create_pool_account() {
  if account_exists "$KRATER_ACCOUNT"; then
    printf 'account %s already exists\n' "$KRATER_ACCOUNT"
    return
  fi
  if [ "$NEAR_NETWORK" != "testnet" ]; then
    printf 'error: %s does not exist; create and fund it before deploying to %s\n' \
      "$KRATER_ACCOUNT" "$NEAR_NETWORK" >&2
    exit 1
  fi
  near account create-account sponsor-by-faucet-service "$KRATER_ACCOUNT" \
    autogenerate-new-keypair save-to-keychain \
    network-config "$NEAR_NETWORK" create
}

# Subaccounts are created and funded by their parent, so the keychain must hold a
# full-access key for the parent account as well as for the signer's own account.
create_subaccount() {
  local account_id="$1"
  if account_exists "$account_id"; then
    printf 'account %s already exists\n' "$account_id"
    return
  fi
  local parent="${account_id#*.}"
  near account create-account fund-myself "$account_id" "$FUND_AMOUNT" \
    autogenerate-new-keypair save-to-keychain \
    sign-as "$parent" \
    network-config "$NEAR_NETWORK" sign-with-keychain send
}

# Build the local variant, then apply the measured second wasm-opt pass to the
# exact artifact that is deployed. The reproducible variant needs Docker plus a
# pushed tree, so it is not part of this script; init stays a separate
# near-cli-rs call so its gas and zero deposit are explicit.
build_contract() {
  local crate_dir="$1" package="$2"
  ( cd "$REPO_ROOT/$crate_dir" && cargo near build non-reproducible-wasm )
  bash "$REPO_ROOT/scripts/optimize-wasm.sh" "$REPO_ROOT/target/near/$package/$package.wasm"
}

deploy_contract() {
  local account_id="$1" wasm="$2"
  near contract deploy "$account_id" use-file "$wasm" without-init-call \
    network-config "$NEAR_NETWORK" sign-with-keychain send
}

call_function() {
  local contract_id="$1" method="$2" args_file="$3" gas="$4" deposit="$5" signer="$6"
  near contract call-function as-transaction "$contract_id" "$method" \
    file-args "$args_file" prepaid-gas "$gas" attached-deposit "$deposit" \
    sign-as "$signer" network-config "$NEAR_NETWORK" sign-with-keychain send
}

# The deployer pays every registration; a registered receiver is what lets the
# token or the share contract credit an account instead of panicking.
register_account() {
  local token="$1" account_id="$2"
  printf '{"account_id": "%s"}\n' "$account_id" >"$WORK_DIR/storage-args.json"
  call_function "$token" storage_deposit "$WORK_DIR/storage-args.json" \
    '30 Tgas' "$STORAGE_DEPOSIT" "$KRATER_ACCOUNT"
}

lock_pool_account() {
  local keys remaining
  mapfile -t keys < <({ near account list-keys "$KRATER_ACCOUNT" \
    network-config "$NEAR_NETWORK" now || true; } |
    grep -oE '(ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]+' | sort -u || true)

  if [ "${#keys[@]}" -eq 0 ]; then
    printf 'error: no access keys on %s; nothing to lock\n' "$KRATER_ACCOUNT" >&2
    exit 1
  fi

  for key in "${keys[@]}"; do
    printf 'deleting access key %s\n' "$key"
    near account delete-keys "$KRATER_ACCOUNT" public-keys "$key" \
      network-config "$NEAR_NETWORK" sign-with-keychain send
  done

  remaining="$({ near account list-keys "$KRATER_ACCOUNT" \
    network-config "$NEAR_NETWORK" now || true; } |
    grep -oE '(ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]+' | wc -l | tr -d ' ' || true)"

  if [ "$remaining" -ne 0 ]; then
    printf 'error: %s still has %s access key(s)\n' "$KRATER_ACCOUNT" "$remaining" >&2
    exit 1
  fi
  printf '%s is locked: no access keys remain, so only its own code can act\n' "$KRATER_ACCOUNT"
}

printf 'network %s, pool %s\n' "$NEAR_NETWORK" "$KRATER_ACCOUNT"

# Build and optimize before touching the network: a compile or wasm-opt failure
# must not come after account creation and faucet funding.
build_contract contracts/pool krater_pool
build_contract contracts/mock-ft krater_mock_ft

create_pool_account
create_subaccount "$REBASING_ACCOUNT"
create_subaccount "$TAXED_ACCOUNT"
for demo in $DEMO_ACCOUNTS; do
  create_subaccount "$demo"
done

deploy_contract "$KRATER_ACCOUNT" "$REPO_ROOT/target/near/krater_pool/krater_pool.wasm"
deploy_contract "$REBASING_ACCOUNT" "$REPO_ROOT/target/near/krater_mock_ft/krater_mock_ft.wasm"
deploy_contract "$TAXED_ACCOUNT" "$REPO_ROOT/target/near/krater_mock_ft/krater_mock_ft.wasm"

cat >"$WORK_DIR/pool-args.json" <<JSON
{
  "token_a": "$REBASING_ACCOUNT",
  "token_b": "$TAXED_ACCOUNT",
  "swap_fee_bps": $SWAP_FEE_BPS,
  "share_name": "$SHARE_NAME",
  "share_symbol": "$SHARE_SYMBOL"
}
JSON

cat >"$WORK_DIR/rebasing-args.json" <<JSON
{"name": "Krater Rebasing Fixture", "symbol": "kREB"}
JSON

cat >"$WORK_DIR/taxed-args.json" <<JSON
{"name": "Krater Taxed Fixture", "symbol": "kTAX"}
JSON

call_function "$KRATER_ACCOUNT" new "$WORK_DIR/pool-args.json" \
  "$INIT_GAS" '0 yoctoNEAR' "$KRATER_ACCOUNT"
call_function "$REBASING_ACCOUNT" new "$WORK_DIR/rebasing-args.json" \
  "$INIT_GAS" '0 yoctoNEAR' "$REBASING_ACCOUNT"
call_function "$TAXED_ACCOUNT" new "$WORK_DIR/taxed-args.json" \
  "$INIT_GAS" '0 yoctoNEAR' "$TAXED_ACCOUNT"

register_account "$REBASING_ACCOUNT" "$KRATER_ACCOUNT"
register_account "$TAXED_ACCOUNT" "$KRATER_ACCOUNT"
register_account "$KRATER_ACCOUNT" "$KRATER_ACCOUNT"
for demo in $DEMO_ACCOUNTS; do
  register_account "$REBASING_ACCOUNT" "$demo"
  register_account "$TAXED_ACCOUNT" "$demo"
  register_account "$KRATER_ACCOUNT" "$demo"
done

lock_pool_account
printf 'deployed: pool %s, fixtures %s and %s\n' \
  "$KRATER_ACCOUNT" "$REBASING_ACCOUNT" "$TAXED_ACCOUNT"
printf 'next: point RPC_URL/KRATER_CONTRACT/KRATER_PRIVATE_KEY at these accounts and run node scripts/demo.js\n'
