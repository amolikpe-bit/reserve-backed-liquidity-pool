//! Krater pool: a two-token constant-product pool that holds its reserves as real
//! NEP-141 balances on its own account.
//!
//! The LP share token is NEP-141 on this account (minted and burned by the pool),
//! so share accounting, transfers and NEP-145 registration come from the standard
//! implementation rather than a bespoke ledger. The pool has no owner, no pause and
//! no upgrade path; `new` is the only configuration call.

pub mod events;
pub mod ft_receiver;
pub mod pool;
pub mod shares;

use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{env, near, AccountId, Gas, PanicOnDefault};
use near_sdk_contract_tools::ft::{ContractMetadata, FungibleToken, Nep148Controller};

/// Basis-point denominator. A fee of `swap_fee_bps` is taken from the input side
/// of every swap and stays in the reserve it arrived in.
pub const BPS: u128 = 10_000;

/// Machine-readable description of this pool, served from the repository.
pub const SPEC_URI: &str = "https://raw.githubusercontent.com/nirholas/near-krater/main/manifest.json";

/// Gas reserved for a single token view (`ft_index` or `ft_balance_of`) inside the
/// reserve-sync chain.
pub const GAS_FOR_TOKEN_VIEW: Gas = Gas::from_tgas(5);

/// Gas reserved for a private sync callback.
pub const GAS_FOR_SYNC_CALLBACK: Gas = Gas::from_tgas(8);

/// Gas reserved for the fill / share-mint / withdraw-settle call scheduled after a sync.
pub const GAS_FOR_FILL: Gas = Gas::from_tgas(15);

/// A swap accepted by the pool and waiting for fresh balances.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct PendingSwap {
    pub sender_id: AccountId,
    pub token_in: AccountId,
    pub amount: u128,
    pub min_out: u128,
}

/// An `add_liquidity` call accepted by the pool and waiting for fresh balances.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct PendingAddLiquidity {
    pub owner_id: AccountId,
    pub amount_a: u128,
    pub amount_b: u128,
    pub min_shares: u128,
}

/// A `withdraw` call accepted by the pool and waiting for fresh balances.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct PendingWithdraw {
    pub owner_id: AccountId,
    pub shares: u128,
}

/// The pool's state.
///
/// `reserve_a` / `reserve_b` are the cached tradeable reserves: the pool's
/// NEP-141 balances minus the nominal value of all deposited-but-not-added
/// credits. They are refreshed by the permissionless sync chain and by every
/// swap, so views read the cache and settlement reads fresh balances.
///
/// `deposits` and `owed` hold credit shares (nominal = shares * index / ONE) and
/// failed payouts respectively, keyed by (account, token).
#[derive(FungibleToken, PanicOnDefault)]
#[near(contract_state)]
pub struct Contract {
    /// First token of the pair; bound once by `new`.
    pub token_a: AccountId,
    /// Second token of the pair; bound once by `new`.
    pub token_b: AccountId,
    /// Swap fee in basis points, taken from the input side; immutable after init.
    pub swap_fee_bps: u32,
    /// Cached tradeable reserve of `token_a`.
    pub reserve_a: u128,
    /// Cached tradeable reserve of `token_b`.
    pub reserve_b: u128,
    /// Token index of `token_a` at the last sync (ONE = 1e18).
    pub index_a: u128,
    /// Token index of `token_b` at the last sync (ONE = 1e18).
    pub index_b: u128,
    /// Credit shares held for `token_a`, across all accounts. Never tradeable.
    pub total_credit_shares_a: u128,
    /// Credit shares held for `token_b`, across all accounts. Never tradeable.
    pub total_credit_shares_b: u128,
    /// (account, token) -> credit shares. Written by deposits, spent by `add_liquidity`.
    pub deposits: LookupMap<(AccountId, AccountId), u128>,
    /// (account, token) -> failed payout, claimable via `claim_owed`.
    pub owed: LookupMap<(AccountId, AccountId), u128>,
    /// The single swap allowed to wait for a reserve sync.
    pub pending_swap: Option<PendingSwap>,
    /// The single liquidity add allowed to wait for a reserve sync.
    pub pending_add_liquidity: Option<PendingAddLiquidity>,
    /// The single withdrawal allowed to wait for a reserve sync.
    pub pending_withdraw: Option<PendingWithdraw>,
    /// Set while a swap's output transfer is outstanding, so no second fill can run.
    pub fill_in_flight: bool,
    /// `token_a` decimals from NEP-148, cached at its first deposit. The minimum
    /// credit deposit is 10^(decimals-3) base units (0.001 whole token, floor 1),
    /// which bounds the storage cost of attacker-chosen credit keys; caching the
    /// decimals keeps that rule off the per-receipt cross-contract view.
    pub token_decimals_a: Option<u8>,
    /// `token_b` decimals from NEP-148, cached at its first deposit (same rule).
    pub token_decimals_b: Option<u8>,
}

#[near]
impl Contract {
    /// Bind the pair and the share metadata, once.
    ///
    /// # Panics
    /// - `InvalidPair` if both token identifiers are equal.
    /// - `InvalidFee` if `swap_fee_bps` is 10_000 or more (a fee at or above the
    ///   whole trade is not a fee).
    #[init]
    pub fn new(
        token_a: AccountId,
        token_b: AccountId,
        swap_fee_bps: u32,
        share_name: String,
        share_symbol: String,
    ) -> Self {
        if token_a == token_b {
            env::panic_str("InvalidPair");
        }
        if swap_fee_bps >= 10_000 {
            env::panic_str("InvalidFee");
        }

        let mut contract = Self {
            token_a,
            token_b,
            swap_fee_bps,
            reserve_a: 0,
            reserve_b: 0,
            index_a: shares::ONE,
            index_b: shares::ONE,
            total_credit_shares_a: 0,
            total_credit_shares_b: 0,
            deposits: LookupMap::new(b"d".to_vec()),
            owed: LookupMap::new(b"o".to_vec()),
            pending_swap: None,
            pending_add_liquidity: None,
            pending_withdraw: None,
            fill_in_flight: false,
            token_decimals_a: None,
            token_decimals_b: None,
        };

        contract.set_metadata(&ContractMetadata::new(share_name, share_symbol, 18));

        contract
    }

    /// Pool name, as recorded in the manifest.
    pub fn pool_name(&self) -> String {
        "krater".to_string()
    }

    /// Pool version, as recorded in the manifest.
    pub fn pool_version(&self) -> String {
        "1.0.0".to_string()
    }

    /// URL of the machine-readable manifest served from the repository.
    pub fn spec_uri(&self) -> String {
        SPEC_URI.to_string()
    }

    /// The pool's tags: a constant-product curve over tokens that rebase or tax
    /// transfers, with no admin surface.
    pub fn pool_tags(&self) -> Vec<String> {
        ["curve", "rebasing", "fee-on-transfer", "custom-curve", "no-admin"]
            .iter()
            .map(|tag| (*tag).to_string())
            .collect()
    }

    /// Nominal credit balances for `account_id`, in `[token_a, token_b]` order.
    ///
    /// A credit is scaled by its token's cached index, so a rebase between the
    /// deposit and the read does not change the nominal value. Tokens outside the
    /// pair are never credited, so they have no entry.
    pub fn get_deposits(&self, account_id: AccountId) -> Vec<U128> {
        vec![
            U128(shares::credit_nominal(
                self.deposits
                    .get(&(account_id.clone(), self.token_a.clone()))
                    .copied()
                    .unwrap_or(0),
                self.index_a,
            )),
            U128(shares::credit_nominal(
                self.deposits
                    .get(&(account_id, self.token_b.clone()))
                    .copied()
                    .unwrap_or(0),
                self.index_b,
            )),
        ]
    }

    /// Failed payouts still owed to `account_id`, in `[token_a, token_b]` order.
    /// Claim them with `claim_owed`.
    pub fn get_payout_backlog(&self, account_id: AccountId) -> Vec<U128> {
        vec![
            U128(self
                .owed
                .get(&(account_id.clone(), self.token_a.clone()))
                .copied()
                .unwrap_or(0)),
            U128(
                self.owed
                    .get(&(account_id, self.token_b.clone()))
                    .copied()
                    .unwrap_or(0),
            ),
        ]
    }
}
