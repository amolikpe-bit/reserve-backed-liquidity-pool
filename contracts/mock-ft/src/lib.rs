//! Test-only NEP-141 fixtures.
//!
//! One binary covers the two token behaviours the pool is built for:
//! - **Rebasing**: balances are reported as `shares * index / ONE`, and
//!   `rebase(factor_bps)` moves the index, so every holder's balance changes
//!   without anyone transacting. This is the behaviour that makes a pool's
//!   reserve grow or shrink with no swap.
//! - **Fee on transfer**: `set_fee(bps)` sets a cut taken from every transfer,
//!   so a recipient is credited less than the sender sent.
//!
//! There is no owner and no access control on the mutators, on purpose: these
//! contracts exist so a test or a demo can move the index and the fee directly.
//! They are not a template for a production token.
//!
//! The transfer surface and NEP-145 storage methods are not part of this
//! contract yet; the pool's flows consume them in the next build stage.

use near_contract_standards::fungible_token::metadata::{
    FungibleTokenMetadata, FT_METADATA_SPEC,
};
use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{env, near, AccountId, PanicOnDefault};
use primitive_types::U256;

/// Basis-point denominator.
pub const BPS: u128 = 10_000;

/// Fixed-point one, and the index a fresh token starts at.
pub const ONE: u128 = 1_000_000_000_000_000_000;

/// NEP-148 decimals. Fixture choice: matches the pool's 18-decimal share units.
const DECIMALS: u8 = 18;

/// A rebasing, optionally tax-on-transfer, NEP-141 fixture.
#[derive(PanicOnDefault)]
#[near(contract_state)]
pub struct Contract {
    name: String,
    symbol: String,
    decimals: u8,
    index: u128,
    fee_bps: u32,
    total_shares: u128,
    shares_of: LookupMap<AccountId, u128>,
}

fn narrow(value: U256) -> u128 {
    if value > U256::from(u128::MAX) {
        env::panic_str("MathOverflow");
    }
    value.as_u128()
}

/// Report a share balance as a nominal balance at `index`.
fn nominal(shares: u128, index: u128) -> u128 {
    narrow(U256::from(shares) * U256::from(index) / U256::from(ONE))
}

/// Convert a nominal amount into shares at `index`, rounding down.
fn shares_for(amount: u128, index: u128) -> u128 {
    if index == 0 {
        env::panic_str("InvalidIndex");
    }
    narrow(U256::from(amount) * U256::from(ONE) / U256::from(index))
}

#[near]
impl Contract {
    /// Create a fixture token at index ONE with no transfer fee.
    #[init]
    pub fn new(name: String, symbol: String) -> Self {
        Self {
            name,
            symbol,
            decimals: DECIMALS,
            index: ONE,
            fee_bps: 0,
            total_shares: 0,
            shares_of: LookupMap::new(b"s".to_vec()),
        }
    }

    /// NEP-141 balance, scaled by the current index.
    pub fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        U128(nominal(
            self.shares_of.get(&account_id).copied().unwrap_or(0),
            self.index,
        ))
    }

    /// NEP-141 total supply, scaled by the current index.
    pub fn ft_total_supply(&self) -> U128 {
        U128(nominal(self.total_shares, self.index))
    }

    /// NEP-148 metadata.
    pub fn ft_metadata(&self) -> FungibleTokenMetadata {
        FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: self.name.clone(),
            symbol: self.symbol.clone(),
            icon: None,
            reference: None,
            reference_hash: None,
            decimals: self.decimals,
        }
    }

    /// The current scaling factor from shares to balances (ONE = 1e18).
    ///
    /// The pool reads this when it syncs reserves, so a deposit credit and a
    /// cached reserve are always expressed at the same index.
    pub fn ft_index(&self) -> U128 {
        U128(self.index)
    }

    /// Move the index by `factor_bps`. 10_000 leaves balances unchanged, 11_000
    /// adds ten percent, 5_000 halves them.
    ///
    /// # Panics
    /// `InvalidIndex` if the new index would be zero; a rebase to zero would erase
    /// every balance and cannot be undone.
    pub fn rebase(&mut self, factor_bps: u32) {
        let next =
            U256::from(self.index) * U256::from(factor_bps as u128) / U256::from(BPS);
        if next == U256::from(0u128) {
            env::panic_str("InvalidIndex");
        }
        self.index = narrow(next);
    }

    /// Set the transfer fee in basis points.
    ///
    /// The fee is stored here and applied by the transfer surface; a test can
    /// change it mid-run to prove the pool needs no reconfiguration when a token
    /// changes its own fee.
    ///
    /// # Panics
    /// `InvalidFee` if `bps` is 10_000 or more.
    pub fn set_fee(&mut self, bps: u32) {
        if bps >= BPS as u32 {
            env::panic_str("InvalidFee");
        }
        self.fee_bps = bps;
    }

    /// Current transfer fee in basis points.
    pub fn fee_bps(&self) -> u32 {
        self.fee_bps
    }

    /// Mint `amount` of nominal balance to `receiver_id`, fee-free and
    /// unauthenticated so a test can fund an account exactly.
    pub fn mint(&mut self, receiver_id: AccountId, amount: U128) {
        let shares = shares_for(amount.0, self.index);
        let balance = self.shares_of.get(&receiver_id).copied().unwrap_or(0);
        self.shares_of.insert(receiver_id, balance + shares);
        self.total_shares += shares;
    }
}
