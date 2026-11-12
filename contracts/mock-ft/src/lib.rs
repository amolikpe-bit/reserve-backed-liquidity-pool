//! Test-only NEP-141 fixture for the krater pool.
//!
//! One binary covers the two token behaviours the pool is built for:
//! - **Rebasing**: balances are reported as `shares * index / ONE`, and
//!   `rebase(factor_bps)` moves the index, so every holder's balance changes
//!   without anyone transacting. This is the behaviour that makes a pool's
//!   reserve grow or shrink with no swap.
//! - **Fee on transfer**: `set_fee(bps)` takes a cut from every transfer and
//!   burns it, so a recipient is credited the net amount, not the amount the
//!   sender asked to move.
//!   `ft_transfer_call` reports the NET credited amount to the receiver, which
//!   is what the pool quotes from: a taxed token must not make the pool quote
//!   from the gross transfer.
//!
//! There is no owner and no access control on the mutators, on purpose: these
//! contracts exist so a test or a demo can move the index and the fee directly.
//! They are not a template for a production token.
//!
//! The share ledger is [`FungibleToken`], the NEP-141 reference ledger over a
//! legacy `LookupMap`, so registration is the usual NEP-145 flow: an account
//! calls `storage_deposit` once, and only then can it hold shares. The transfer
//! surface is written by hand because a tax-on-transfer token must report a
//! different amount than the one the sender asked to move, while the generated
//! `ft_transfer_call` always reports the gross amount.

use near_contract_standards::fungible_token::events::{FtBurn, FtMint, FtTransfer};
use near_contract_standards::fungible_token::metadata::{
    FungibleTokenMetadata, FT_METADATA_SPEC,
};
use near_contract_standards::fungible_token::receiver::ext_ft_receiver;
use near_contract_standards::fungible_token::FungibleToken;
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};
use near_sdk::json_types::U128;
use near_sdk::{
    assert_one_yocto, env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError,
};
use primitive_types::U256;

/// Basis-point denominator.
pub const BPS: u128 = 10_000;

/// Fixed-point one, and the index a fresh token starts at.
pub const ONE: u128 = 1_000_000_000_000_000_000;

/// NEP-148 decimals. Fixture choice: matches the pool's 18-decimal share units.
const DECIMALS: u8 = 18;

/// Gas reserved for `ft_resolve_transfer`, which `ft_transfer_call` chains after
/// the receiver's `ft_on_transfer`.
///
/// 5 Tgas is the NEP-141 reference reservation. The receiver call is given the
/// rest of the prepaid gas minus a small execution margin as static gas, because
/// distributing unused gas by weight lost about half the budget at every hop in
/// the sandbox and the pool's four-callback sync never reached its settlement.
const GAS_FOR_RESOLVE: Gas = Gas::from_tgas(5);

/// Gas kept by `ft_transfer_call` itself for the fee transfer and ledger writes.
const GAS_FOR_TOKEN_EXEC: Gas = Gas::from_tgas(5);

/// A rebasing, optionally tax-on-transfer, NEP-141 fixture.
#[derive(PanicOnDefault)]
#[near(contract_state)]
pub struct Contract {
    token: FungibleToken,
    name: String,
    symbol: String,
    decimals: u8,
    index: u128,
    fee_bps: u32,
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

/// Convert a nominal amount into shares at `index`, rounding up.
///
/// A transfer debits the sender by the ceiling and never credits the receiver
/// more shares than that debit, so the share ledger stays exact when `index`
/// is not ONE.
fn shares_ceil(amount: u128, index: u128) -> u128 {
    if index == 0 {
        env::panic_str("InvalidIndex");
    }
    narrow(
        (U256::from(amount) * U256::from(ONE) + U256::from(index) - U256::from(1u128))
            / U256::from(index),
    )
}

impl Contract {
    /// Shares held by a registered account.
    ///
    /// # Panics
    /// Panics if `account_id` never called `storage_deposit`: an unregistered
    /// NEP-141 receiver has nowhere to put the shares.
    fn registered_shares(&self, account_id: &AccountId) -> u128 {
        self.token
            .accounts
            .get(account_id)
            .unwrap_or_else(|| env::panic_str(&format!("The account {account_id} is not registered")))
    }

    /// Move `amount` nominal from `sender` to `receiver`, burning the fee.
    ///
    /// The sender loses `ceil(amount * ONE / index)` shares and the receiver
    /// gains that same count minus the fee rounded up to whole shares, so a
    /// zero-fee transfer never burns a share just because the index does not
    /// divide the amount. The returned value is the receiver's actual balance
    /// delta, which is exactly what `ft_on_transfer` must forward.
    fn transfer_with_fee(
        &mut self,
        sender: &AccountId,
        receiver: &AccountId,
        amount: u128,
        memo: Option<&str>,
    ) -> u128 {
        require!(sender != receiver, "Sender and receiver should be different");

        let index = self.index;
        let fee = narrow(U256::from(amount) * U256::from(self.fee_bps as u128) / U256::from(BPS));

        let delta_shares = shares_ceil(amount, index);
        let fee_shares = shares_ceil(fee, index);
        // The fee is part of the amount, so its rounded-up share count can
        // never exceed the rounded-up debit.
        let net_shares = delta_shares
            .checked_sub(fee_shares)
            .unwrap_or_else(|| env::panic_str("Fee exceeds transfer"));
        let credited = nominal(net_shares, index);
        let burned = nominal(fee_shares, index);

        let sender_shares = self.registered_shares(sender);
        let receiver_shares = self.registered_shares(receiver);
        let remaining = sender_shares
            .checked_sub(delta_shares)
            .unwrap_or_else(|| env::panic_str("The account doesn't have enough balance"));
        let new_receiver_shares = receiver_shares
            .checked_add(net_shares)
            .unwrap_or_else(|| env::panic_str("Balance overflow"));
        self.token.accounts.insert(sender, &remaining);
        self.token.accounts.insert(receiver, &new_receiver_shares);
        self.token.total_supply = self
            .token
            .total_supply
            .checked_sub(fee_shares)
            .unwrap_or_else(|| env::panic_str("Total supply underflow"));

        FtTransfer {
            old_owner_id: sender,
            new_owner_id: receiver,
            amount: U128(credited),
            memo,
        }
        .emit();
        if fee_shares > 0 {
            FtBurn { owner_id: sender, amount: U128(burned), memo: None }.emit();
        }

        credited
    }
}

#[near]
impl Contract {
    /// Create a fixture token at index ONE with no transfer fee.
    #[init]
    pub fn new(name: String, symbol: String) -> Self {
        Self {
            token: FungibleToken::new(b"ft".to_vec()),
            name,
            symbol,
            decimals: DECIMALS,
            index: ONE,
            fee_bps: 0,
        }
    }

    /// NEP-141 balance, scaled by the current index.
    pub fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        U128(nominal(
            self.token.accounts.get(&account_id).unwrap_or(0),
            self.index,
        ))
    }

    /// NEP-141 total supply, scaled by the current index.
    pub fn ft_total_supply(&self) -> U128 {
        U128(nominal(self.token.total_supply, self.index))
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

    /// Current transfer fee in basis points.
    pub fn fee_bps(&self) -> u32 {
        self.fee_bps
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

    /// Mint `amount` of nominal balance to `receiver_id`, fee-free and
    /// unauthenticated so a test can fund an account exactly.
    ///
    /// Shares are `floor(amount * ONE / index)`; the receiver must have called
    /// `storage_deposit` first, and `internal_deposit` panics otherwise.
    pub fn mint(&mut self, receiver_id: AccountId, amount: U128) {
        let shares = shares_for(amount.0, self.index);
        self.token.internal_deposit(&receiver_id, shares);
        FtMint {
            owner_id: &receiver_id,
            amount: U128(nominal(shares, self.index)),
            memo: None,
        }
        .emit();
    }

    /// NEP-141 transfer: the sender pays the tax, the receiver is credited the
    /// net amount, and the fee is burned.
    #[payable]
    pub fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        assert_one_yocto();
        let sender_id = env::predecessor_account_id();
        self.transfer_with_fee(&sender_id, &receiver_id, amount.0, memo.as_deref());
    }

    /// NEP-141 transfer with a receiver callback.
    ///
    /// The receiver is told the credited amount, which is its exact balance
    /// delta, so the pool stores and quotes from what actually arrived, not from
    /// what the sender sent. The receiver gets weight 1 (all unused gas); the
    /// resolver that follows it is pinned to [`GAS_FOR_RESOLVE`].
    #[payable]
    pub fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> Promise {
        assert_one_yocto();
        let sender_id = env::predecessor_account_id();
        let credited = self.transfer_with_fee(&sender_id, &receiver_id, amount.0, memo.as_deref());
        let receiver_gas = env::prepaid_gas()
            .saturating_sub(GAS_FOR_RESOLVE)
            .saturating_sub(GAS_FOR_TOKEN_EXEC);
        if receiver_gas.as_gas() == 0 {
            env::panic_str("InsufficientGas");
        }
        ext_ft_receiver::ext(receiver_id.clone())
            .with_static_gas(receiver_gas)
            .ft_on_transfer(sender_id.clone(), U128(credited), msg)
            .then(
                Self::ext_self()
                    .with_static_gas(GAS_FOR_RESOLVE)
                    .ft_resolve_transfer(sender_id, receiver_id, U128(credited)),
            )
    }

    /// NEP-141 resolver: return the part of `amount` the receiver did not use.
    ///
    /// `amount` is the credited nominal reported by `ft_transfer_call`, i.e. the
    /// receiver's exact balance delta. A receiver that panicked, or returned
    /// something that is not `U128`, refunds the whole amount. Returns the amount
    /// the receiver kept.
    #[private]
    pub fn ft_resolve_transfer(
        &mut self,
        #[callback_result] result: Result<U128, PromiseError>,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128 {
        let unused = match result {
            Ok(unused) => unused.0.min(amount.0),
            Err(_) => amount.0,
        };

        let index = self.index;
        let receiver_shares = self.token.accounts.get(&receiver_id).unwrap_or(0);
        // The receiver may have spent part of the credit; refund what is left.
        let refund_shares = shares_for(unused, index).min(receiver_shares);
        let refunded = nominal(refund_shares, index);

        if refund_shares > 0 {
            self.token
                .accounts
                .insert(&receiver_id, &(receiver_shares - refund_shares));
            // The sender was registered when the transfer ran. If it
            // unregistered while the call was in flight, restore the shares
            // instead of dropping the refund in a callback.
            let sender_shares = self.token.accounts.get(&sender_id).unwrap_or(0);
            self.token
                .accounts
                .insert(&sender_id, &(sender_shares + refund_shares));
            FtTransfer {
                old_owner_id: &receiver_id,
                new_owner_id: &sender_id,
                amount: U128(refunded),
                memo: Some("refund"),
            }
            .emit();
        }

        U128(amount.0 - refunded)
    }
}

/// NEP-145 registration and storage accounting for the share ledger.
#[near]
impl StorageManagement for Contract {
    #[payable]
    fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        self.token.internal_storage_unregister(force).is_some()
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}
