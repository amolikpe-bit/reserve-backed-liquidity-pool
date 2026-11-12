//! Krater pool: a two-token constant-product pool that holds its reserves as real
//! NEP-141 balances on its own account.
//!
//! The LP share token is NEP-141 on this account (minted and burned by the pool),
//! so share accounting, transfers and NEP-145 registration come from the standard
//! implementation rather than a bespoke ledger. The pool has no owner, no pause and
//! no upgrade path; `new` is the only configuration call.
//!
//! All value enters through NEP-141: a holder calls `ft_transfer_call` on a pair
//! token, the token calls `ft_on_transfer` here, and the pool answers with the
//! unused amount. A swap and a deposit both read the token's index in a receipt
//! callback before touching the cache, because a rebase lands between the transfer
//! and the pool's next execution. Settlement is therefore always async:
//!
//! ```text
//! ft_transfer_call -> ft_on_transfer -> pending slot -> sync chain -> self-call
//! ```
//!
//! The sync chain (`ft_index`, `ft_balance_of`, twice) is the only way the cached
//! reserves move; only the chain tagged `allow_fill` dispatches the settlement, so
//! a permissionless `sync_reserves` can never settle another account's call.

pub mod events;
pub mod ft_receiver;
pub mod pool;
pub mod shares;

#[cfg(test)]
mod unit_tests;

use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{
    assert_one_yocto, env, ext_contract, near, AccountId, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError,
};
use near_sdk_contract_tools::ft::{
    ContractMetadata, FungibleToken, Nep141Burn, Nep141Controller, Nep141Mint, Nep145Controller,
    Nep148Controller,
};

use crate::events::PoolEvent;
use crate::ft_receiver::FtMetadata;
use crate::shares::MINIMUM_SHARES;

/// Borrow an account as the reference type the NEP-141/NEP-145 controllers take.
///
/// `AccountId` implements both `AsRef<str>` and `AsRef<AccountIdRef>`, so writing
/// `.as_ref()` directly at a generic call site is ambiguous. This helper pins the
/// intended target.
pub(crate) fn account_ref(account_id: &AccountId) -> &near_sdk::AccountIdRef {
    account_id.as_ref()
}

/// Basis-point denominator. A fee of `swap_fee_bps` is taken from the input side
/// of every swap and stays in the reserve it arrived in.
pub const BPS: u128 = 10_000;

/// Machine-readable description of this pool, served from the repository.
pub const SPEC_URI: &str = "https://raw.githubusercontent.com/nirholas/near-krater/main/manifest.json";

/// The one yoctoNEAR NEP-141 requires on `ft_transfer`, and the deposit that makes
/// an entry point a signed, non-delegable call rather than a plain function call.
pub const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

/// Gas reserved for a single token view (`ft_index` or `ft_balance_of`) inside the
/// reserve-sync chain.
pub const GAS_FOR_TOKEN_VIEW: Gas = Gas::from_tgas(5);

/// Gas reserved for a callback that schedules no further call.
pub const GAS_FOR_SYNC_CALLBACK: Gas = Gas::from_tgas(8);

/// Gas reserved for one pair-token `ft_transfer` (`ft_transfer` needs the deposit
/// plus enough execution gas for a rebasing or taxing ledger).
pub const GAS_FOR_FT_TRANSFER: Gas = Gas::from_tgas(10);

/// Gas attached to the self-call that fills a swap or mints shares after a sync.
///
/// Both settle from freshly synced reserves in one receipt and make no external
/// call that this receipt has to fund before its own dispatch.
pub const GAS_FOR_FILL: Gas = Gas::from_tgas(25);

/// Gas attached to the self-call that settles a withdrawal after a sync.
///
/// Higher than [`GAS_FOR_FILL`] because one settle receipt creates both payout
/// legs (two `ft_transfer` actions plus their two callbacks).
pub const GAS_FOR_SETTLE: Gas = Gas::from_tgas(45);

/// Headroom a syncing receipt keeps beside a dispatched settlement.
///
/// The receipt that dispatches still has to write its own state and build the
/// self-call's promise batch, so a settlement is only scheduled when the gas left
/// covers its static budget plus this much. A chain that cannot afford it refunds
/// instead of leaving the flow in a slot no later call would drain.
pub const GAS_DISPATCH_HEADROOM: Gas = Gas::from_tgas(2);

/// Static gas for each hop of the four-callback reserve-sync chain.
///
/// Each callback is given exactly what it must reserve for the next view call
/// plus the next callback, with a small execution margin. Static gas is
/// predictable; distributing unused gas by weight was halving the budget at
/// every hop in the sandbox, so the chain never reached its settlement. The
/// descending budget is the remaining chain: 90 -> 80 -> 70 -> 60 Tgas.
pub const GAS_FOR_ON_INDEX_A: Gas = Gas::from_tgas(90);
pub const GAS_FOR_ON_BALANCE_A: Gas = Gas::from_tgas(80);
pub const GAS_FOR_ON_INDEX_B: Gas = Gas::from_tgas(70);
pub const GAS_FOR_ON_BALANCE_B: Gas = Gas::from_tgas(60);

/// Static gas for the deposit and credit-withdrawal callbacks.
pub const GAS_FOR_DEPOSIT_INDEX: Gas = Gas::from_tgas(40);
pub const GAS_FOR_DEPOSIT_METADATA: Gas = Gas::from_tgas(25);
pub const GAS_FOR_WITHDRAW_INDEX: Gas = Gas::from_tgas(40);

/// Storage the pool registers for itself on its own share ledger.
///
/// The first successful add mints [`MINIMUM_SHARES`] to the pool account, and
/// contract-tools charges a receiver's storage balance for the account entry it
/// writes, refusing an unregistered receiver outright. The NEAR is already on
/// this account (the deployer funds it), so the registration only records it; the
/// amount covers the pool's single share-ledger entry with a wide margin.
pub const POOL_STORAGE_DEPOSIT: NearToken = NearToken::from_millinear(10);

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

/// The pair-token surface the pool calls, and nothing else.
///
/// Both accounts are bound at init, so every hop of every chain talks to a token
/// chosen once, and no caller can redirect a hop.
#[ext_contract(ext_ft)]
pub trait ExtFt {
    /// Current scaling index of the token, `ONE` when it does not rebase.
    fn ft_index(&self) -> U128;
    /// NEP-141 balance of `account_id`, in base units.
    fn ft_balance_of(&self, account_id: AccountId) -> U128;
    /// NEP-141 transfer. Every call attaches exactly [`ONE_YOCTO`].
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
    /// NEP-148 metadata; the pool keeps only `decimals`.
    fn ft_metadata(&self) -> FtMetadata;
}

/// Pay `amount` of `token` from the pool to `receiver`, with the one yoctoNEAR
/// NEP-141 requires.
pub(crate) fn token_transfer(token: &AccountId, receiver: &AccountId, amount: u128) -> Promise {
    ext_ft::ext(token.clone())
        .with_static_gas(GAS_FOR_FT_TRANSFER)
        .with_attached_deposit(ONE_YOCTO)
        .ft_transfer(receiver.clone(), U128(amount), None)
}

/// Gas this receipt still has: prepaid gas minus what its execution has burned.
pub(crate) fn remaining_gas() -> u64 {
    env::prepaid_gas()
        .as_gas()
        .saturating_sub(env::used_gas().as_gas())
}

/// Index reported by a token, with the documented fallback.
///
/// A token that fails the view or reports zero is treated as unscaled (`ONE`) and
/// the reason is logged: no callback panics on a failed read, because a panic would
/// abandon the slot the chain was settling.
pub(crate) fn resolve_index(result: Result<U128, PromiseError>, what: &str) -> u128 {
    match result {
        Ok(index) if index.0 != 0 => index.0,
        Ok(_) => {
            env::log_str(&format!("{what} is zero; assuming ONE"));
            shares::ONE
        }
        Err(err) => {
            env::log_str(&format!("{what} unavailable ({err:?}); assuming ONE"));
            shares::ONE
        }
    }
}

#[near]
impl Contract {
    /// Bind the pair and the share metadata, once.
    ///
    /// The pool also registers itself on its own share ledger here: the first
    /// successful `add_liquidity` mints the locked [`MINIMUM_SHARES`] to this
    /// account, and the share ledger refuses to mint to an unregistered receiver.
    ///
    /// # Panics
    /// - `InvalidPair` if both token identifiers are equal.
    /// - `InvalidFee` if `swap_fee_bps` is 10_000 or more (a fee at or above the
    ///   whole trade is not a fee).
    /// - `StorageDepositError` if the self-registration is rejected, which can only
    ///   happen if the storage bounds were configured to exclude the pool.
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
            .deposit_to_storage_account(account_ref(&env::current_account_id()), POOL_STORAGE_DEPOSIT)
            .unwrap_or_else(|_| env::panic_str("StorageDepositError"));

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

    /// Add liquidity from credits already held by the caller.
    ///
    /// Exactly one yoctoNEAR; the amounts are nominal and must both be non-zero.
    /// The call stores one pending slot and schedules the sync chain tagged
    /// `allow_fill`, so `mint_shares` prices the add against fresh reserves in a
    /// later receipt — the credits are not debited here.
    ///
    /// # Panics
    /// - `AmountTooSmall` if either amount is zero.
    /// - `InvalidAmounts` if `amounts` does not have exactly two entries.
    /// - `Busy` if a swap, add, withdrawal or payout is already in flight.
    #[payable]
    pub fn add_liquidity(&mut self, amounts: Vec<U128>, min_shares: U128) -> Promise {
        assert_one_yocto();
        if amounts.len() != 2 {
            env::panic_str("InvalidAmounts");
        }
        let (amount_a, amount_b) = (amounts[0].0, amounts[1].0);
        if amount_a == 0 || amount_b == 0 {
            env::panic_str("AmountTooSmall");
        }
        if self.is_busy() {
            env::panic_str("Busy");
        }

        self.pending_add_liquidity = Some(PendingAddLiquidity {
            owner_id: env::predecessor_account_id(),
            amount_a,
            amount_b,
            min_shares: min_shares.0,
        });

        self.index_hop_a(true)
    }

    /// Mint LP shares for the credits an `add_liquidity` call reserved.
    ///
    /// Runs behind a tag-true sync, so the ratios use fresh reserves. Credits are
    /// debited in this receipt, together with the mint, so every failure path is
    /// atomic: a failure emits `AddLiquidityFailed` and leaves the credits intact.
    #[private]
    pub fn mint_shares(&mut self) {
        let Some(add) = self.pending_add_liquidity.take() else {
            return;
        };
        let plan = match self.plan_add(&add) {
            Ok(plan) => plan,
            Err(reason) => {
                self.fail_add_liquidity(&add.owner_id, reason);
                return;
            }
        };

        // `mint` charges the receiver's storage balance and panics outright for
        // an unregistered receiver. Checked here, where the failure can be
        // reported and the credits refunded instead of reverting the receipt.
        let pool_id = env::current_account_id();
        if Nep145Controller::get_storage_balance(self, account_ref(&plan.owner)).is_err()
            || Nep145Controller::get_storage_balance(self, account_ref(&pool_id)).is_err()
        {
            self.fail_add_liquidity(&plan.owner, "ReceiverNotRegistered");
            return;
        }

        self.sub_credit(&plan.owner, &plan.token_a, plan.credit_a);
        self.sub_credit(&plan.owner, &plan.token_b, plan.credit_b);
        self.add_reserve(&plan.token_a, plan.nominal_a);
        self.add_reserve(&plan.token_b, plan.nominal_b);

        if plan.first {
            // The first add locks MINIMUM_SHARES to the pool itself, so the share
            // supply can never be driven to zero.
            if let Err(err) = self.mint(&Nep141Mint::new(MINIMUM_SHARES, account_ref(&pool_id))) {
                env::log_str(&format!("locked share mint failed: {err:?}"));
                self.restore_add(&plan);
                self.fail_add_liquidity(&plan.owner, "DepositError");
                return;
            }
        }

        if let Err(err) = self.mint(&Nep141Mint::new(plan.shares, account_ref(&plan.owner))) {
            env::log_str(&format!("share mint failed: {err:?}"));
            if plan.first {
                // Undo the lock so the failed add leaves no supply behind. A burn
                // of shares this receipt just minted cannot fail; a panic here
                // would revert the whole receipt, which is the correct fallback.
                self.burn(&Nep141Burn::new(MINIMUM_SHARES, account_ref(&pool_id)))
                    .unwrap_or_else(|_| env::panic_str("WithdrawError"));
            }
            self.restore_add(&plan);
            self.fail_add_liquidity(&plan.owner, "DepositError");
            return;
        }

        if plan.nominal_a > 0 {
            PoolEvent::CreditSpent {
                account_id: plan.owner.clone(),
                token: plan.token_a.clone(),
                amount: U128(plan.nominal_a),
            }
            .emit();
        }
        if plan.nominal_b > 0 {
            PoolEvent::CreditSpent {
                account_id: plan.owner.clone(),
                token: plan.token_b.clone(),
                amount: U128(plan.nominal_b),
            }
            .emit();
        }
        PoolEvent::Deposit {
            who: plan.owner.clone(),
            amount_a: U128(plan.nominal_a),
            amount_b: U128(plan.nominal_b),
            shares: U128(plan.shares),
        }
        .emit();
    }

    /// Burn LP shares and send both pro-rata legs.
    ///
    /// Exactly one yoctoNEAR. The call stores one pending slot and schedules the
    /// sync chain tagged `allow_fill`; `settle_withdraw` burns and pays out in the
    /// callback receipt, from fresh reserves.
    ///
    /// # Panics
    /// - `AmountTooSmall` if `shares` is zero.
    /// - `Busy` if a swap, add, withdrawal or payout is already in flight.
    #[payable]
    pub fn withdraw(&mut self, shares: U128) -> Promise {
        assert_one_yocto();
        if shares.0 == 0 {
            env::panic_str("AmountTooSmall");
        }
        if self.is_busy() {
            env::panic_str("Busy");
        }

        self.pending_withdraw = Some(PendingWithdraw {
            owner_id: env::predecessor_account_id(),
            shares: shares.0,
        });

        self.index_hop_a(true)
    }

    /// Burn the pending withdrawal's shares and pay both legs.
    ///
    /// Reserves were just synced, so the pro-rata amounts use fresh balances. A leg
    /// that rounds to zero is skipped: a zero-amount `ft_transfer` panics in the
    /// reference FT. Every rejection logs and returns: the slot was already taken,
    /// so a panic here would revert the take and leave the pool permanently busy.
    #[private]
    pub fn settle_withdraw(&mut self) {
        let Some(pending) = self.pending_withdraw.take() else {
            return;
        };
        let supply = Nep141Controller::total_supply(self);
        if supply == 0 || pending.shares > supply {
            // Nobody can hold more than the supply, and the burn below would say
            // the same; returning here keeps the pro-rata products in range and
            // leaves the slot drained.
            env::log_str("withdraw rejected: shares exceed supply");
            return;
        }

        let amount_a = shares::proportional_amount(pending.shares, self.reserve_a, supply);
        let amount_b = shares::proportional_amount(pending.shares, self.reserve_b, supply);
        if amount_a == 0 && amount_b == 0 {
            env::log_str("withdraw rejected: both legs round to zero");
            return;
        }

        if let Err(err) = self.burn(&Nep141Burn::new(pending.shares, account_ref(&pending.owner_id))) {
            env::log_str(&format!("share burn failed: {err:?}"));
            return;
        }

        let token_a = self.token_a.clone();
        let token_b = self.token_b.clone();
        self.sub_reserve(&token_a, amount_a);
        self.sub_reserve(&token_b, amount_b);

        PoolEvent::Withdraw {
            who: pending.owner_id.clone(),
            amount_a: U128(amount_a),
            amount_b: U128(amount_b),
            shares: U128(pending.shares),
        }
        .emit();

        if amount_a > 0 {
            token_transfer(&token_a, &pending.owner_id, amount_a)
                .then(
                    Contract::ext_self()
                        .with_static_gas(GAS_FOR_SYNC_CALLBACK)
                        .withdraw_callback(
                            pending.owner_id.clone(),
                            token_a.clone(),
                            U128(amount_a),
                        ),
                )
                .detach();
        }
        if amount_b > 0 {
            token_transfer(&token_b, &pending.owner_id, amount_b)
                .then(
                    Contract::ext_self()
                        .with_static_gas(GAS_FOR_SYNC_CALLBACK)
                        .withdraw_callback(pending.owner_id.clone(), token_b, U128(amount_b)),
                )
                .detach();
        }
    }

    /// Record a payout leg the token refused.
    ///
    /// The tokens never left the pool, so the amount goes back into that reserve
    /// and is also recorded as owed: the swap/withdraw that produced it already
    /// emitted its event and must not be blocked by the receiver's registration.
    #[private]
    pub fn withdraw_callback(
        &mut self,
        #[callback_result] r: Result<(), PromiseError>,
        who: AccountId,
        token: AccountId,
        amount: U128,
    ) {
        if let Err(err) = r {
            env::log_str(&format!("withdraw leg failed: {err:?}"));
            self.add_owed(&who, &token, amount.0);
            self.add_reserve(&token, amount.0);
        }
    }

    /// Claim a payout that a token refused earlier.
    ///
    /// Exactly one yoctoNEAR. The owed amount is debited (and the reserve with it,
    /// because the failed tokens were counted there) and sent in one transfer.
    ///
    /// # Panics
    /// - `UnknownToken` if `token` is not one of the pair tokens.
    /// - `AmountTooSmall` if nothing is owed in `token`.
    #[payable]
    pub fn claim_owed(&mut self, token: AccountId) -> Promise {
        assert_one_yocto();
        if !self.is_pair_token(&token) {
            env::panic_str("UnknownToken");
        }
        let who = env::predecessor_account_id();
        let amount = self.take_owed(&who, &token);
        if amount == 0 {
            env::panic_str("AmountTooSmall");
        }
        self.sub_reserve(&token, amount);

        token_transfer(&token, &who, amount).then(
            Contract::ext_self()
                .with_static_gas(GAS_FOR_SYNC_CALLBACK)
                .owed_restore_callback(who, token, U128(amount)),
        )
    }

    /// Re-record a claimed payout whose transfer failed.
    #[private]
    pub fn owed_restore_callback(
        &mut self,
        #[callback_result] r: Result<(), PromiseError>,
        who: AccountId,
        token: AccountId,
        amount: U128,
    ) {
        if let Err(err) = r {
            env::log_str(&format!("owed payout failed: {err:?}"));
            self.add_owed(&who, &token, amount.0);
            self.add_reserve(&token, amount.0);
        }
    }
}

/// What an `add_liquidity` call will spend, resolved against fresh reserves.
///
/// Pure data: `plan_add` computes it, `mint_shares` executes it and
/// `restore_add` undoes the debit when the mint is refused.
struct AddPlan {
    owner: AccountId,
    token_a: AccountId,
    token_b: AccountId,
    /// Credit shares debited from the owner for each leg.
    credit_a: u128,
    credit_b: u128,
    /// Nominal value those credits add to each reserve.
    nominal_a: u128,
    nominal_b: u128,
    /// Shares minted to the owner.
    shares: u128,
    /// The supply was empty, so this add locks `MINIMUM_SHARES` to the pool.
    first: bool,
}

impl Contract {
    /// Whether `token` is one of the tokens bound at init.
    pub(crate) fn is_pair_token(&self, token: &AccountId) -> bool {
        token == &self.token_a || token == &self.token_b
    }

    /// The other token of the pair.
    ///
    /// # Panics
    /// `UnknownToken` if `token` is not one of the pair tokens.
    pub(crate) fn other_token(&self, token: &AccountId) -> AccountId {
        if token == &self.token_a {
            self.token_b.clone()
        } else if token == &self.token_b {
            self.token_a.clone()
        } else {
            env::panic_str("UnknownToken")
        }
    }

    /// Cached tradeable reserve of `token`.
    ///
    /// # Panics
    /// `UnknownToken` if `token` is not one of the pair tokens.
    pub(crate) fn reserve_of(&self, token: &AccountId) -> u128 {
        if token == &self.token_a {
            self.reserve_a
        } else if token == &self.token_b {
            self.reserve_b
        } else {
            env::panic_str("UnknownToken")
        }
    }

    /// Overwrite the cached tradeable reserve of `token`.
    ///
    /// # Panics
    /// `UnknownToken` if `token` is not one of the pair tokens.
    pub(crate) fn set_reserve(&mut self, token: &AccountId, value: u128) {
        if token == &self.token_a {
            self.reserve_a = value;
        } else if token == &self.token_b {
            self.reserve_b = value;
        } else {
            env::panic_str("UnknownToken");
        }
    }

    /// Raise the cached reserve of `token` by `delta`.
    ///
    /// The cache is a quote hint that the next sync overwrites, so adjustments
    /// saturate instead of panicking: a failure path has to be able to record its
    /// debt rather than revert the receipt that discovered it.
    pub(crate) fn add_reserve(&mut self, token: &AccountId, delta: u128) {
        let value = self.reserve_of(token).saturating_add(delta);
        self.set_reserve(token, value);
    }

    /// Lower the cached reserve of `token` by `delta`, saturating at zero.
    pub(crate) fn sub_reserve(&mut self, token: &AccountId, delta: u128) {
        let value = self.reserve_of(token).saturating_sub(delta);
        self.set_reserve(token, value);
    }

    /// Cached NEP-148 decimals of `token`, if a deposit has read them.
    pub(crate) fn decimals_of(&self, token: &AccountId) -> Option<u8> {
        if token == &self.token_a {
            self.token_decimals_a
        } else if token == &self.token_b {
            self.token_decimals_b
        } else {
            env::panic_str("UnknownToken")
        }
    }

    /// Cache NEP-148 decimals for `token`.
    pub(crate) fn set_decimals(&mut self, token: &AccountId, decimals: u8) {
        if token == &self.token_a {
            self.token_decimals_a = Some(decimals);
        } else if token == &self.token_b {
            self.token_decimals_b = Some(decimals);
        } else {
            env::panic_str("UnknownToken");
        }
    }

    /// Credit shares held for `token` across all accounts.
    pub(crate) fn total_credit_shares(&self, token: &AccountId) -> u128 {
        if token == &self.token_a {
            self.total_credit_shares_a
        } else if token == &self.token_b {
            self.total_credit_shares_b
        } else {
            env::panic_str("UnknownToken")
        }
    }

    /// Overwrite the credit-share total for `token`.
    pub(crate) fn set_total_credit_shares(&mut self, token: &AccountId, value: u128) {
        if token == &self.token_a {
            self.total_credit_shares_a = value;
        } else if token == &self.token_b {
            self.total_credit_shares_b = value;
        } else {
            env::panic_str("UnknownToken");
        }
    }

    /// Credit shares held for `account_id` in `token`.
    pub(crate) fn credit_of(&self, account_id: &AccountId, token: &AccountId) -> u128 {
        self.deposits
            .get(&(account_id.clone(), token.clone()))
            .copied()
            .unwrap_or(0)
    }

    /// Overwrite the credit shares held for `account_id` in `token`.
    pub(crate) fn set_credit(&mut self, account_id: &AccountId, token: &AccountId, value: u128) {
        self.deposits
            .insert((account_id.clone(), token.clone()), value);
    }

    /// Credit `credit_shares` to `account_id` for `token`, and to the global total.
    ///
    /// # Panics
    /// `MathOverflow` if either balance would pass `u128::MAX`, which a real
    /// deposit cannot reach.
    pub(crate) fn add_credit(
        &mut self,
        account_id: &AccountId,
        token: &AccountId,
        credit_shares: u128,
    ) {
        let held = self
            .credit_of(account_id, token)
            .checked_add(credit_shares)
            .unwrap_or_else(|| env::panic_str("MathOverflow"));
        self.set_credit(account_id, token, held);

        let total = self
            .total_credit_shares(token)
            .checked_add(credit_shares)
            .unwrap_or_else(|| env::panic_str("MathOverflow"));
        self.set_total_credit_shares(token, total);
    }

    /// Debit `credit_shares` from `account_id` for `token` and from the global total.
    ///
    /// Every caller checks the credit covers the debit first; the subtraction
    /// saturates as a backstop, because panicking here would strand the slot the
    /// caller is settling.
    pub(crate) fn sub_credit(
        &mut self,
        account_id: &AccountId,
        token: &AccountId,
        credit_shares: u128,
    ) {
        let held = self.credit_of(account_id, token).saturating_sub(credit_shares);
        self.set_credit(account_id, token, held);

        let total = self.total_credit_shares(token).saturating_sub(credit_shares);
        self.set_total_credit_shares(token, total);
    }

    /// Amount a token refused to pay out to `account_id`, claimable later.
    pub(crate) fn owed_of(&self, account_id: &AccountId, token: &AccountId) -> u128 {
        self.owed
            .get(&(account_id.clone(), token.clone()))
            .copied()
            .unwrap_or(0)
    }

    /// Add `amount` to the payout backlog of `account_id` for `token`.
    ///
    /// Saturating: a callback must record the debt it just discovered, not revert.
    pub(crate) fn add_owed(&mut self, account_id: &AccountId, token: &AccountId, amount: u128) {
        let owed = self.owed_of(account_id, token).saturating_add(amount);
        self.owed.insert((account_id.clone(), token.clone()), owed);
    }

    /// Remove and return the payout backlog of `account_id` for `token`.
    pub(crate) fn take_owed(&mut self, account_id: &AccountId, token: &AccountId) -> u128 {
        self.owed
            .remove(&(account_id.clone(), token.clone()))
            .unwrap_or(0)
    }

    /// Return `amount` of `token` to `recipient` with the pool's own transfer, or
    /// record it as owed when this receipt cannot fund even that.
    ///
    /// Every caller is a failure path, so the one thing this must not do is revert
    /// the receipt that is clearing a slot: the fixed transfer budget is only
    /// reserved when what is left covers it, and otherwise the amount becomes a
    /// payout debt that `claim_owed` releases while the pool keeps the tokens.
    ///
    /// Returns `true` when the tokens are on their way out, so the caller can drop
    /// them from the cached reserve; `false` means the pool still holds them and
    /// `claim_owed` deducts them when they are paid.
    pub(crate) fn refund(
        &mut self,
        token: &AccountId,
        recipient: &AccountId,
        amount: u128,
    ) -> bool {
        if amount == 0 {
            return false;
        }
        let budget = GAS_FOR_FT_TRANSFER
            .as_gas()
            .saturating_add(GAS_DISPATCH_HEADROOM.as_gas());
        if remaining_gas() > budget {
            token_transfer(token, recipient, amount)
                .then(
                    Contract::ext_self()
                        .with_static_gas(GAS_FOR_SYNC_CALLBACK)
                        .owed_restore_callback(recipient.clone(), token.clone(), U128(amount)),
                )
                .detach();
            return true;
        }

        env::log_str("refund recorded as owed: this receipt cannot fund the transfer");
        self.add_owed(recipient, token, amount);
        false
    }

    /// Whether a flow slot or a swap payout is in flight.
    ///
    /// One slot at a time: a second swap, add or withdrawal is refused rather than
    /// queued, because a queue would need unbounded state and a second sync could
    /// settle the same slot twice.
    pub(crate) fn is_busy(&self) -> bool {
        self.pending_swap.is_some()
            || self.pending_add_liquidity.is_some()
            || self.pending_withdraw.is_some()
            || self.fill_in_flight
    }

    /// Resolve what `add` would spend at the freshly synced reserves, or the
    /// `AddLiquidityFailed` reason it cannot mint.
    ///
    /// Reads only: no credit is debited until the mint is certain to be attempted.
    fn plan_add(&self, add: &PendingAddLiquidity) -> Result<AddPlan, &'static str> {
        let token_a = self.token_a.clone();
        let token_b = self.token_b.clone();
        let (index_a, index_b) = (self.index_a, self.index_b);
        let credit_a = self.credit_of(&add.owner_id, &token_a);
        let credit_b = self.credit_of(&add.owner_id, &token_b);
        if credit_a < shares::credit_shares_ceil(add.amount_a, index_a)
            || credit_b < shares::credit_shares_ceil(add.amount_b, index_b)
        {
            return Err("InsufficientDeposit");
        }

        let supply = Nep141Controller::total_supply(self);
        let (first, minted, nominal_a, nominal_b) = if supply == 0 {
            // First add: neither reserve has a ratio yet, so the shares are the
            // geometric mean of the two credits and MINIMUM_SHARES stays locked.
            let nominal_a = shares::credit_nominal(credit_a, index_a);
            let nominal_b = shares::credit_nominal(credit_b, index_b);
            let root = shares::initial_shares(nominal_a, nominal_b);
            if root <= MINIMUM_SHARES {
                return Err("InsufficientInitialLiquidity");
            }
            let minted = root - MINIMUM_SHARES;
            if minted < add.min_shares {
                return Err("MinSharesNotMet");
            }
            (true, minted, nominal_a, nominal_b)
        } else {
            // Later adds mint the smaller of the two ratios; a zero-reserve side is
            // unbounded (`u128::MAX`), so it cannot bind.
            let minted = core::cmp::min(
                shares::proportional_shares(add.amount_a, self.reserve_a, supply),
                shares::proportional_shares(add.amount_b, self.reserve_b, supply),
            );
            if minted == u128::MAX {
                // Both reserves are empty: two unbounded sides carry no price.
                return Err("InsufficientInitialLiquidity");
            }
            if minted == 0 {
                return Err("AmountTooSmall");
            }
            if minted < add.min_shares {
                return Err("MinSharesNotMet");
            }
            let nominal_a = core::cmp::min(
                shares::proportional_amount_ceil(minted, self.reserve_a, supply),
                shares::credit_nominal(credit_a, index_a),
            );
            let nominal_b = core::cmp::min(
                shares::proportional_amount_ceil(minted, self.reserve_b, supply),
                shares::credit_nominal(credit_b, index_b),
            );
            (false, minted, nominal_a, nominal_b)
        };

        Ok(AddPlan {
            owner: add.owner_id.clone(),
            token_a,
            token_b,
            credit_a: shares::credit_shares_ceil(nominal_a, index_a).min(credit_a),
            credit_b: shares::credit_shares_ceil(nominal_b, index_b).min(credit_b),
            nominal_a,
            nominal_b,
            shares: minted,
            first,
        })
    }

    /// Undo a plan's debit after the mint was refused, restoring exactly what the
    /// caller held before.
    fn restore_add(&mut self, plan: &AddPlan) {
        self.add_credit(&plan.owner, &plan.token_a, plan.credit_a);
        self.add_credit(&plan.owner, &plan.token_b, plan.credit_b);
        self.sub_reserve(&plan.token_a, plan.nominal_a);
        self.sub_reserve(&plan.token_b, plan.nominal_b);
    }

    /// Emit `AddLiquidityFailed` with the reason the add could not mint.
    fn fail_add_liquidity(&self, account_id: &AccountId, reason: &str) {
        env::log_str(&format!("add_liquidity failed: {reason}"));
        PoolEvent::AddLiquidityFailed {
            account_id: account_id.clone(),
            reason: reason.to_string(),
        }
        .emit();
    }
}
