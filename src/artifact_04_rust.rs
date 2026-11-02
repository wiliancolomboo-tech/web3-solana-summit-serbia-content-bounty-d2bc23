use anchor_lang::prelude::*;
use anchor_spl::token_2022::{self, TransferChecked};
use anchor_spl::token_interface::{Mint, Token2022, TokenAccount};
use bytemuck::{Pod, Zeroable};

declare_id!("SRB1a11111111111111111111111111111111111111");

pub const MAX_ORDERS_PER_SIDE: usize = 128;
pub const MARKET_SEED: &[u8] = b"market";
pub const ORDERBOOK_SEED: &[u8] = b"orderbook";
pub const VAULT_SEED: &[u8] = b"vault";

#[program]
pub mod solana_summit_engine {
    use super::*;

    pub fn initialize_market(
        ctx: Context<InitializeMarket>,
        market_bump: u8,
        orderbook_bump: u8,
        vault_base_bump: u8,
        vault_quote_bump: u8,
    ) -> Result<()> {
        let market = &mut ctx.accounts.market;
        market.authority = ctx.accounts.authority.key();
        market.base_mint = ctx.accounts.base_mint.key();
        market.quote_mint = ctx.accounts.quote_mint.key();
        market.vault_base = ctx.accounts.vault_base.key();
        market.vault_quote = ctx.accounts.vault_quote.key();
        market.orderbook = ctx.accounts.orderbook.key();
        market.market_bump = market_bump;
        market.orderbook_bump = orderbook_bump;
        market.vault_base_bump = vault_base_bump;
        market.vault_quote_bump = vault_quote_bump;
        market.order_counter = 0;
        market.is_locked = 0;

        let mut orderbook = ctx.accounts.orderbook.load_init()?;
        orderbook.bid_count = 0;
        orderbook.ask_count = 0;
        orderbook._reserved = [0u8; 6];

        msg!("Market initialized successfully for Solana Summit Serbia.");
        Ok(())
    }

    pub fn place_order(
        ctx: Context<PlaceOrder>,
        side: u8, // 0 = Buy (Bid), 1 = Sell (Ask)
        price_in_ticks: u64,
        quantity: u64,
    ) -> Result<()> {
        require!(quantity > 0, EngineError::ZeroQuantity);
        require!(price_in_ticks > 0, EngineError::ZeroPrice);
        require!(side == 0 || side == 1, EngineError::InvalidOrderSide);

        let market = &mut ctx.accounts.market;
        require!(market.is_locked == 0, EngineError::MarketLocked);
        market.is_locked = 1; // Reentrancy barrier

        let market_key = market.key();
        let base_mint_key = market.base_mint;
        let quote_mint_key = market.quote_mint;
        let decimals = if side == 0 {
            ctx.accounts.quote_mint.decimals
        } else {
            ctx.accounts.base_mint.decimals
        };

        // Escrow funds directly into vaults via Token-2022 TransferChecked
        if side == 0 {
            // BID: Escrow (price * qty) in quote currency
            let total_cost = price_in_ticks
                .checked_mul(quantity)
                .ok_or(EngineError::MathOverflow)?;
            
            let cpi_accounts = TransferChecked {
                from: ctx.accounts.user_token_account.to_account_info(),
                mint: ctx.accounts.quote_mint.to_account_info(),
                to: ctx.accounts.vault_quote.to_account_info(),
                authority: ctx.accounts.trader.to_account_info(),
            };
            let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
            token_2022::transfer_checked(cpi_ctx, total_cost, decimals)?;
        } else {
            // ASK: Escrow base tokens
            let cpi_accounts = TransferChecked {
                from: ctx.accounts.user_token_account.to_account_info(),
                mint: ctx.accounts.base_mint.to_account_info(),
                to: ctx.accounts.vault_base.to_account_info(),
                authority: ctx.accounts.trader.to_account_info(),
            };
            let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
            token_2022::transfer_checked(cpi_ctx, quantity, decimals)?;
        }

        // Write directly to Zero-Copy Buffer
        let mut orderbook = ctx.accounts.orderbook.load_mut()?;
        let order_id = market.order_counter;
        market.order_counter = market.order_counter.checked_add(1).ok_or(EngineError::MathOverflow)?;

        let new_order = Order {
            order_id,
            trader: ctx.accounts.trader.key(),
            price: price_in_ticks,
            quantity,
            slot: Clock::get()?.slot,
        };

        if side == 0 {
            // Insert into bids (Sorted Descending)
            let count = orderbook.bid_count as usize;
            require!(count < MAX_ORDERS_PER_SIDE, EngineError::OrderbookFull);
            let mut insert_idx = count;
            for i in 0..count {
                if new_order.price > orderbook.bids[i].price {
                    insert_idx = i;
                    break;
                }
            }
            for i in (insert_idx..count).rev() {
                orderbook.bids[i + 1] = orderbook.bids[i];
            }
            orderbook.bids[insert_idx] = new_order;
            orderbook.bid_count += 1;
        } else {
            // Insert into asks (Sorted Ascending)
            let count = orderbook.ask_count as usize;
            require!(count < MAX_ORDERS_PER_SIDE, EngineError::OrderbookFull);
            let mut insert_idx = count;
            for i in 0..count {
                if new_order.price < orderbook.asks[i].price {
                    insert_idx = i;
                    break;
                }
            }
            for i in (insert_idx..count).rev() {
                orderbook.asks[i + 1] = orderbook.asks[i];
            }
            orderbook.asks[insert_idx] = new_order;
            orderbook.ask_count += 1;
        }

        market.is_locked = 0; // Release lock
        emit!(OrderPlacedEvent {
            order_id,
            trader: ctx.accounts.trader.key(),
            side,
            price: price_in_ticks,
            quantity
        });

        Ok(())
    }

    pub fn crank_settle<'a, 'b, 'c, 'info>(
        ctx: Context<'a, 'b, 'c, 'info, CrankSettle<'info>>,
        max_matches: u8,
    ) -> Result<()> {
        let market = &mut ctx.accounts.market;
        require!(market.is_locked == 0, EngineError::MarketLocked);
        market.is_locked = 1;

        let mut orderbook = ctx.accounts.orderbook.load_mut()?;
        let mut matches_executed: u8 = 0;

        while orderbook.bid_count > 0 && orderbook.ask_count > 0 && matches_executed < max_matches {
            let best_bid = orderbook.bids[0];
            let best_ask = orderbook.asks[0];

            if best_bid.price >= best_ask.price {
                let match_price = best_ask.price; // Maker-first rule
                let match_quantity = best_bid.quantity.min(best_ask.quantity);

                // Update order amounts
                orderbook.bids[0].quantity -= match_quantity;
                orderbook.asks[0].quantity -= match_quantity;

                // Shift queues if fully matched
                if orderbook.bids[0].quantity == 0 {
                    let count = orderbook.bid_count as usize;
                    for i in 0..(count - 1) {
                        orderbook.bids[i] = orderbook.bids[i + 1];
                    }
                    orderbook.bid_count -= 1;
                }

                if orderbook.asks[0].quantity == 0 {
                    let count = orderbook.ask_count as usize;
                    for i in 0..(count - 1) {
                        orderbook.asks[i] = orderbook.asks[i + 1];
                    }
                    orderbook.ask_count -= 1;
                }

                matches_executed += 1;
                emit!(OrderMatchedEvent {
                    maker_order_id: best_ask.order_id,
                    taker_order_id: best_bid.order_id,
                    match_price,
                    quantity: match_quantity,
                });
            } else {
                break; // No cross spread
            }
        }

        market.is_locked = 0;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// ZERO COPY STRUCTS & ACCOUNTS
// ---------------------------------------------------------------------------

#[account(zero_copy)]
#[derive(Copy)]
#[repr(C)]
pub struct OrderBookState {
    pub bid_count: u16,
    pub ask_count: u16,
    pub _reserved: [u8; 6],
    pub bids: [Order; MAX_ORDERS_PER_SIDE],
    pub asks: [Order; MAX_ORDERS_PER_SIDE],
}

#[derive(Copy, Clone, Pod, Zeroable)]
#[repr(C)]
pub struct Order {
    pub order_id: u64,   // 8 bytes
    pub trader: Pubkey,  // 32 bytes
    pub price: u64,      // 8 bytes
    pub quantity: u64,   // 8 bytes
    pub slot: u64,       // 8 bytes
}

#[account]
#[derive(Default)]
pub struct Market {
    pub authority: Pubkey,
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub vault_base: Pubkey,
    pub vault_quote: Pubkey,
    pub orderbook: Pubkey,
    pub order_counter: u64,
    pub market_bump: u8,
    pub orderbook_bump: u8,
    pub vault_base_bump: u8,
    pub vault_quote_bump: u8,
    pub is_locked: u8,
}

impl Market {
    pub const LEN: usize = 8 + 32*6 + 8 + 1*5 + 7; // Rent padding
}

// ---------------------------------------------------------------------------
// VALIDATION CONTEXTS
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializeMarket<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    pub base_mint: Box<InterfaceAccount<'info, Mint>>,
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        init,
        payer = authority,
        space = Market::LEN,
        seeds = [MARKET_SEED, base_mint.key().as_ref(), quote_mint.key().as_ref()],
        bump
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        init,
        payer = authority,
        space = 8 + std::mem::size_of::<OrderBookState>(),
        seeds = [ORDERBOOK_SEED, market.key().as_ref()],
        bump
    )]
    pub orderbook: AccountLoader<'info, OrderBookState>,

    #[account(
        init,
        payer = authority,
        seeds = [VAULT_SEED, market.key().as_ref(), base_mint.key().as_ref()],
        bump,
        token::mint = base_mint,
        token::authority = vault_base,
        token::token_program = token_program
    )]
    pub vault_base: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init,
        payer = authority,
        seeds = [VAULT_SEED, market.key().as_ref(), quote_mint.key().as_ref()],
        bump,
        token::mint = quote_mint,
        token::authority = vault_quote,
        token::token_program = token_program
    )]
    pub vault_quote: Box<InterfaceAccount<'info, TokenAccount>>,

    pub system_program: Program<'info, System>,
    pub token_program: Interface<'info, Token2022>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct PlaceOrder<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,

    #[account(
        mut,
        has_one = base_mint,
        has_one = quote_mint,
        has_one = vault_base,
        has_one = vault_quote,
        has_one = orderbook,
    )]
    pub market: Account<'info, Market>,

    #[account(mut)]
    pub orderbook: AccountLoader<'info, OrderBookState>,

    pub base_mint: Box<InterfaceAccount<'info, Mint>>,
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut)]
    pub vault_base: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut)]
    pub vault_quote: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut)]
    pub user_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, Token2022>,
}

#[derive(Accounts)]
pub struct CrankSettle<'info> {
    #[account(mut)]
    pub keeper: Signer<'info>,

    #[account(
        mut,
        has_one = vault_base,
        has_one = vault_quote,
        has_one = orderbook
    )]
    pub market: Account<'info, Market>,

    #[account(mut)]
    pub orderbook: AccountLoader<'info, OrderBookState>,

    #[account(mut)]
    pub vault_base: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut)]
    pub vault_quote: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, Token2022>,
}

// ---------------------------------------------------------------------------
// EVENTS & ERRORS
// ---------------------------------------------------------------------------

#[event]
pub struct OrderPlacedEvent {
    pub order_id: u64,
    pub trader: Pubkey,
    pub side: u8,
    pub price: u64,
    pub quantity: u64,
}

#[event]
pub struct OrderMatchedEvent {
    pub maker_order_id: u64,
    pub taker_order_id: u64,
    pub match_price: u64,
    pub quantity: u64,
}

#[error_code]
pub enum EngineError {
    #[msg("Supplied quantity must be greater than zero")]
    ZeroQuantity,
    #[msg("Supplied price must be greater than zero")]
    ZeroPrice,
    #[msg("Invalid order side (0 = Bid, 1 = Ask)")]
    InvalidOrderSide,
    #[msg("Orderbook ring buffer reached max capacity (128)")]
    OrderbookFull,
    #[msg("Arithmetic overflow detected in settlement")]
    MathOverflow,
    #[msg("Market reentrancy lock engaged")]
    MarketLocked,
}