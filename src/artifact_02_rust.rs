use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};

declare_id!("Summ1tPass111111111111111111111111111111111");

#[program]
pub mod summit_pass {
    use super::*;

    /// Initializes a new summit event with ticketing tiers and escrow storage
    pub fn initialize_event(
        ctx: Context<InitializeEvent>,
        event_id: u64,
        ticket_price_lamports: u64,
        max_capacity: u32,
        event_end_timestamp: i64,
    ) -> Result<()> {
        require!(max_capacity > 0, SummitPassError::InvalidCapacity);
        require!(
            event_end_timestamp > Clock::get()?.unix_timestamp,
            SummitPassError::InvalidEventTimestamp
        );

        let event = &mut ctx.accounts.event;
        event.authority = ctx.accounts.authority.key();
        event.event_id = event_id;
        event.ticket_price_lamports = ticket_price_lamports;
        event.max_capacity = max_capacity;
        event.tickets_sold = 0;
        event.check_ins_count = 0;
        event.event_end_timestamp = event_end_timestamp;
        event.bump = ctx.bumps.event;
        event.vault_bump = ctx.bumps.vault;

        emit!(EventCreated {
            event_id,
            authority: event.authority,
            ticket_price_lamports,
            max_capacity,
        });

        Ok(())
    }

    /// Purchases a ticket directly from the event inventory with deterministic PDA derivation
    pub fn purchase_ticket(ctx: Context<PurchaseTicket>) -> Result<()> {
        let event = &mut ctx.accounts.event;
        require!(
            event.tickets_sold < event.max_capacity,
            SummitPassError::SoldOut
        );
        require!(
            Clock::get()?.unix_timestamp < event.event_end_timestamp,
            SummitPassError::EventConcluded
        );

        // CPI transfer to PDA-governed vault
        if event.ticket_price_lamports > 0 {
            let cpi_context = CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.attendee.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                },
            );
            transfer(cpi_context, event.ticket_price_lamports)?;
        }

        let ticket = &mut ctx.accounts.ticket;
        ticket.event = event.key();
        ticket.attendee = ctx.accounts.attendee.key();
        ticket.purchase_timestamp = Clock::get()?.unix_timestamp;
        ticket.is_checked_in = false;
        ticket.check_in_timestamp = 0;
        ticket.bump = ctx.bumps.ticket;

        event.tickets_sold = event
            .tickets_sold
            .checked_add(1)
            .ok_or(SummitPassError::ArithmeticOverflow)?;

        emit!(TicketPurchased {
            event: event.key(),
            attendee: ticket.attendee,
            price: event.ticket_price_lamports,
        });

        Ok(())
    }

    /// Authorizes a delegated ephemeral session key for frictionless door entry
    pub fn authorize_session_signer(
        ctx: Context<AuthorizeSessionSigner>,
        valid_until: i64,
    ) -> Result<()> {
        require!(
            valid_until > Clock::get()?.unix_timestamp,
            SummitPassError::InvalidSessionDuration
        );

        let session = &mut ctx.accounts.session;
        session.event = ctx.accounts.event.key();
        session.attendee = ctx.accounts.attendee.key();
        session.ephemeral_signer = ctx.accounts.ephemeral_signer.key();
        session.valid_until = valid_until;
        session.bump = ctx.bumps.session;

        emit!(SessionAuthorized {
            event: session.event,
            attendee: session.attendee,
            ephemeral_signer: session.ephemeral_signer,
            valid_until,
        });

        Ok(())
    }

    /// Verifies and executes sub-second attendee check-in via delegated session key
    pub fn verify_and_check_in(ctx: Context<VerifyAndCheckIn>) -> Result<()> {
        let current_time = Clock::get()?.unix_timestamp;
        let session = &ctx.accounts.session;
        let ticket = &mut ctx.accounts.ticket;
        let event = &mut ctx.accounts.event;

        // Session authorization checks
        require!(
            session.ephemeral_signer == ctx.accounts.ephemeral_signer.key(),
            SummitPassError::UnauthorizedSessionKey
        );
        require!(
            current_time <= session.valid_until,
            SummitPassError::SessionExpired
        );

        // Ticket state checks
        require!(!ticket.is_checked_in, SummitPassError::AlreadyCheckedIn);
        require!(
            ticket.attendee == session.attendee,
            SummitPassError::TicketOwnerMismatch
        );

        // Mark checked-in
        ticket.is_checked_in = true;
        ticket.check_in_timestamp = current_time;

        event.check_ins_count = event
            .check_ins_count
            .checked_add(1)
            .ok_or(SummitPassError::ArithmeticOverflow)?;

        emit!(AttendeeCheckedIn {
            event: event.key(),
            attendee: ticket.attendee,
            timestamp: current_time,
        });

        Ok(())
    }

    /// Withdraws accumulated ticket proceeds from the vault PDA to the event authority
    pub fn withdraw_proceeds(ctx: Context<WithdrawProceeds>) -> Result<()> {
        let event = &ctx.accounts.event;
        let vault = &ctx.accounts.vault;
        let rent_exempt_reserve = Rent::get()?.minimum_balance(0);
        let vault_lamports = vault.to_account_info().lamports();

        require!(
            vault_lamports > rent_exempt_reserve,
            SummitPassError::InsufficientProceeds
        );

        let withdrawable_amount = vault_lamports
            .checked_sub(rent_exempt_reserve)
            .ok_or(SummitPassError::ArithmeticOverflow)?;

        **vault.to_account_info().try_borrow_mut_lamports()? = rent_exempt_reserve;
        **ctx.accounts.authority.to_account_info().try_borrow_mut_lamports()? = ctx
            .accounts
            .authority
            .to_account_info()
            .lamports()
            .checked_add(withdrawable_amount)
            .ok_or(SummitPassError::ArithmeticOverflow)?;

        emit!(ProceedsWithdrawn {
            event: event.key(),
            recipient: ctx.accounts.authority.key(),
            amount: withdrawable_amount,
        });

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// ACCOUNT CONTEXTS
// -----------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(event_id: u64)]
pub struct InitializeEvent<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + EventState::LEN,
        seeds = [b"event", authority.key().as_ref(), &event_id.to_le_bytes()],
        bump
    )]
    pub event: Account<'info, EventState>,

    /// CHECK: Vault PDA derived deterministically to hold native lamports securely
    #[account(
        mut,
        seeds = [b"vault", event.key().as_ref()],
        bump
    )]
    pub vault: AccountInfo<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PurchaseTicket<'info> {
    #[account(
        mut,
        seeds = [b"event", event.authority.as_ref(), &event.event_id.to_le_bytes()],
        bump = event.bump
    )]
    pub event: Account<'info, EventState>,

    #[account(
        init,
        payer = attendee,
        space = 8 + TicketState::LEN,
        seeds = [b"ticket", event.key().as_ref(), attendee.key().as_ref()],
        bump
    )]
    pub ticket: Account<'info, TicketState>,

    /// CHECK: Validated by PDA seed matching event.key()
    #[account(
        mut,
        seeds = [b"vault", event.key().as_ref()],
        bump = event.vault_bump
    )]
    pub vault: AccountInfo<'info>,

    #[account(mut)]
    pub attendee: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AuthorizeSessionSigner<'info> {
    #[account(
        seeds = [b"event", event.authority.as_ref(), &event.event_id.to_le_bytes()],
        bump = event.bump
    )]
    pub event: Account<'info, EventState>,

    #[account(
        seeds = [b"ticket", event.key().as_ref(), attendee.key().as_ref()],
        bump = ticket.bump
    )]
    pub ticket: Account<'info, TicketState>,

    #[account(
        init_if_needed,
        payer = attendee,
        space = 8 + SessionSignerState::LEN,
        seeds = [b"session", event.key().as_ref(), attendee.key().as_ref()],
        bump
    )]
    pub session: Account<'info, SessionSignerState>,

    /// CHECK: Arbitrary ephemeral public key authorized to trigger check-in
    pub ephemeral_signer: AccountInfo<'info>,

    #[account(mut)]
    pub attendee: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct VerifyAndCheckIn<'info> {
    #[account(
        mut,
        seeds = [b"event", event.authority.as_ref(), &event.event_id.to_le_bytes()],
        bump = event.bump
    )]
    pub event: Account<'info, EventState>,

    #[account(
        mut,
        seeds = [b"ticket", event.key().as_ref(), session.attendee.as_ref()],
        bump = ticket.bump
    )]
    pub ticket: Account<'info, TicketState>,

    #[account(
        seeds = [b"session", event.key().as_ref(), session.attendee.as_ref()],
        bump = session.bump
    )]
    pub session: Account<'info, SessionSignerState>,

    pub ephemeral_signer: Signer<'info>,
}

#[derive(Accounts)]
pub struct WithdrawProceeds<'info> {
    #[account(
        has_one = authority @ SummitPassError::UnauthorizedAuthority,
        seeds = [b"event", authority.key().as_ref(), &event.event_id.to_le_bytes()],
        bump = event.bump
    )]
    pub event: Account<'info, EventState>,

    /// CHECK: Vault PDA verified via seeds
    #[account(
        mut,
        seeds = [b"vault", event.key().as_ref()],
        bump = event.vault_bump
    )]
    pub vault: AccountInfo<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,
}

// -----------------------------------------------------------------------------
// STATE SCHEMAS
// -----------------------------------------------------------------------------

#[account]
pub struct EventState {
    pub authority: Pubkey,          // 32
    pub event_id: u64,              // 8
    pub ticket_price_lamports: u64, // 8
    pub max_capacity: u32,          // 4
    pub tickets_sold: u32,          // 4
    pub check_ins_count: u32,       // 4
    pub event_end_timestamp: i64,   // 8
    pub bump: u8,                   // 1
    pub vault_bump: u8,             // 1
}

impl EventState {
    pub const LEN: usize = 32 + 8 + 8 + 4 + 4 + 4 + 8 + 1 + 1;
}

#[account]
pub struct TicketState {
    pub event: Pubkey,              // 32
    pub attendee: Pubkey,           // 32
    pub purchase_timestamp: i64,    // 8
    pub check_in_timestamp: i64,    // 8
    pub is_checked_in: bool,        // 1
    pub bump: u8,                   // 1
}

impl TicketState {
    pub const LEN: usize = 32 + 32 + 8 + 8 + 1 + 1;
}

#[account]
pub struct SessionSignerState {
    pub event: Pubkey,              // 32
    pub attendee: Pubkey,           // 32
    pub ephemeral_signer: Pubkey,   // 32
    pub valid_until: i64,           // 8
    pub bump: u8,                   // 1
}

impl SessionSignerState {
    pub const LEN: usize = 32 + 32 + 32 + 8 + 1;
}

// -----------------------------------------------------------------------------
// EVENTS & ERRORS
// -----------------------------------------------------------------------------

#[event]
pub struct EventCreated {
    pub event_id: u64,
    pub authority: Pubkey,
    pub ticket_price_lamports: u64,
    pub max_capacity: u32,
}

#[event]
pub struct TicketPurchased {
    pub event: Pubkey,
    pub attendee: Pubkey,
    pub price: u64,
}

#[event]
pub struct SessionAuthorized {
    pub event: Pubkey,
    pub attendee: Pubkey,
    pub ephemeral_signer: Pubkey,
    pub valid_until: i64,
}

#[event]
pub struct AttendeeCheckedIn {
    pub event: Pubkey,
    pub attendee: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct ProceedsWithdrawn {
    pub event: Pubkey,
    pub recipient: Pubkey,
    pub amount: u64,
}

#[error_code]
pub enum SummitPassError {
    #[msg("Capacity must be greater than zero.")]
    InvalidCapacity,
    #[msg("Event end timestamp must be set in the future.")]
    InvalidEventTimestamp,
    #[msg("Event has reached maximum ticket capacity.")]
    SoldOut,
    #[msg("Event has already concluded.")]
    EventConcluded,
    #[msg("Session validity window must be in the future.")]
    InvalidSessionDuration,
    #[msg("Signer does not match the registered ephemeral session key.")]
    UnauthorizedSessionKey,
    #[msg("Ephemeral session key has expired.")]
    SessionExpired,
    #[msg("Attendee ticket has already been checked in.")]
    AlreadyCheckedIn,
    #[msg("Ticket does not belong to the session owner.")]
    TicketOwnerMismatch,
    #[msg("Signer is not authorized to withdraw event proceeds.")]
    UnauthorizedAuthority,
    #[msg("No withdrawable balance remaining above rent-exempt threshold.")]
    InsufficientProceeds,
    #[msg("Arithmetic operation resulted in an overflow or underflow.")]
    ArithmeticOverflow,
}