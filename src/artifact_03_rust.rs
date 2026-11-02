use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount};

declare_id!("Summ1tMeshSerb1a111111111111111111111111111");

#[program]
pub mod summit_mesh {
    use super::*;

    /// Initializes a new summit event instance with maximum allowed workshop stages.
    pub fn initialize_summit(
        ctx: Context<InitializeSummit>,
        summit_id: String,
        total_workshops: u8,
        transferability_locked: bool,
    ) -> Result<()> {
        require!(summit_id.len() <= 32, SummitError::SummitIdTooLong);
        require!(total_workshops <= 64, SummitError::ExceedsMaxWorkshops);

        let summit = &mut ctx.accounts.summit_state;
        summit.admin = ctx.accounts.admin.key();
        summit.summit_id = summit_id;
        summit.total_workshops = total_workshops;
        summit.transferability_locked = transferability_locked;
        summit.total_attendees = 0;
        summit.bump = ctx.bumps.summit_state;

        emit!(SummitInitializedEvent {
            summit_id: summit.summit_id.clone(),
            admin: summit.admin,
            total_workshops,
        });

        Ok(())
    }

    /// Delegates an ephemeral session key (e.g., local storage key) for frictionless venue check-in.
    pub fn delegate_session(
        ctx: Context<DelegateSession>,
        session_signer: Pubkey,
        duration_seconds: i64,
    ) -> Result<()> {
        require!(duration_seconds > 0, SummitError::InvalidDuration);
        require!(duration_seconds <= 86400, SummitError::DurationExceedsCap); // Max 24 hours

        let clock = Clock::get()?;
        let session = &mut ctx.accounts.session_record;
        
        session.attendee = ctx.accounts.attendee.key();
        session.session_signer = session_signer;
        session.valid_until = clock.unix_timestamp.checked_add(duration_seconds).ok_or(SummitError::ArithmeticOverflow)?;
        session.bump = ctx.bumps.session_record;

        emit!(SessionDelegatedEvent {
            attendee: session.attendee,
            session_signer,
            valid_until: session.valid_until,
        });

        Ok(())
    }

    /// Initializes attendee profile prior to workshop participation.
    pub fn initialize_attendee(ctx: Context<InitializeAttendee>) -> Result<()> {
        let attendee_record = &mut ctx.accounts.attendee_record;
        attendee_record.attendee = ctx.accounts.attendee.key();
        attendee_record.attendance_mask = 0;
        attendee_record.accumulated_xp = 0;
        attendee_record.bump = ctx.bumps.attendee_record;

        let summit = &mut ctx.accounts.summit_state;
        summit.total_attendees = summit.total_attendees.checked_add(1).ok_or(SummitError::ArithmeticOverflow)?;

        Ok(())
    }

    /// Records workshop attendance via either direct wallet signature OR valid ephemeral session signer.
    pub fn record_workshop_attendance(
        ctx: Context<RecordWorkshopAttendance>,
        workshop_id: u8,
        xp_points: u32,
    ) -> Result<()> {
        let summit = &ctx.accounts.summit_state;
        require!(workshop_id < summit.total_workshops, SummitError::InvalidWorkshopId);

        let clock = Clock::get()?;

        // Verify session authorization if the caller is an ephemeral key
        if ctx.accounts.caller.key() != ctx.accounts.attendee_record.attendee {
            let session = ctx.accounts.session_record.as_ref().ok_or(SummitError::MissingSessionAccount)?;
            require_keys_eq!(session.session_signer, ctx.accounts.caller.key(), SummitError::UnauthorizedSigner);
            require_keys_eq!(session.attendee, ctx.accounts.attendee_record.attendee, SummitError::SessionAttendeeMismatch);
            require!(clock.unix_timestamp <= session.valid_until, SummitError::SessionExpired);
        }

        let attendee_record = &mut ctx.accounts.attendee_record;
        let workshop_bit: u64 = 1u64.checked_shl(workshop_id as u32).ok_or(SummitError::ArithmeticOverflow)?;

        // Ensure idempotency: verify workshop has not already been marked
        require!(
            (attendee_record.attendance_mask & workshop_bit) == 0,
            SummitError::WorkshopAlreadyAttended
        );

        // Update attendance bitmask and accumulate points
        attendee_record.attendance_mask |= workshop_bit;
        attendee_record.accumulated_xp = attendee_record
            .accumulated_xp
            .checked_add(xp_points)
            .ok_or(SummitError::ArithmeticOverflow)?;

        emit!(WorkshopAttendedEvent {
            attendee: attendee_record.attendee,
            workshop_id,
            xp_points,
            current_mask: attendee_record.attendance_mask,
            new_total_xp: attendee_record.accumulated_xp,
        });

        Ok(())
    }

    /// SPL Token-2022 Transfer Hook target. Prevents transfers if summit badge transferability is locked.
    pub fn execute_transfer_hook(
        ctx: Context<ExecuteTransferHook>,
        _amount: u64,
    ) -> Result<()> {
        let summit = &ctx.accounts.summit_state;

        // If transferability is locked, disallow P2P secondary transfers
        if summit.transferability_locked {
            // Only the summit administrator may perform administrative re-allocations
            let is_admin_signer = ctx.accounts.source_owner.key() == summit.admin;
            require!(is_admin_signer, SummitError::TransfersLockedBySummitPolicy);
        }

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// ACCOUNT CONTEXTS
// -----------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(summit_id: String)]
pub struct InitializeSummit<'info> {
    #[account(
        init,
        payer = admin,
        space = SummitState::LEN,
        seeds = [b"summit", summit_id.as_bytes()],
        bump
    )]
    pub summit_state: Account<'info, SummitState>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DelegateSession<'info> {
    #[account(
        init_if_needed,
        payer = attendee,
        space = SessionRecord::LEN,
        seeds = [b"session", summit_state.key().as_ref(), attendee.key().as_ref()],
        bump
    )]
    pub session_record: Account<'info, SessionRecord>,

    pub summit_state: Account<'info, SummitState>,

    #[account(mut)]
    pub attendee: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitializeAttendee<'info> {
    #[account(
        mut,
        seeds = [b"summit", summit_state.summit_id.as_bytes()],
        bump = summit_state.bump
    )]
    pub summit_state: Account<'info, SummitState>,

    #[account(
        init,
        payer = attendee,
        space = AttendeeRecord::LEN,
        seeds = [b"attendee", summit_state.key().as_ref(), attendee.key().as_ref()],
        bump
    )]
    pub attendee_record: Account<'info, AttendeeRecord>,

    #[account(mut)]
    pub attendee: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RecordWorkshopAttendance<'info> {
    #[account(
        seeds = [b"summit", summit_state.summit_id.as_bytes()],
        bump = summit_state.bump
    )]
    pub summit_state: Account<'info, SummitState>,

    #[account(
        mut,
        seeds = [b"attendee", summit_state.key().as_ref(), attendee_record.attendee.as_ref()],
        bump = attendee_record.bump
    )]
    pub attendee_record: Account<'info, AttendeeRecord>,

    pub caller: Signer<'info>,

    /// Optional session record PDA. Required if caller != attendee_record.attendee.
    #[account(
        seeds = [b"session", summit_state.key().as_ref(), attendee_record.attendee.as_ref()],
        bump = session_record.bump
    )]
    pub session_record: Option<Account<'info, SessionRecord>>,
}

#[derive(Accounts)]
pub struct ExecuteTransferHook<'info> {
    #[account(
        seeds = [b"summit", summit_state.summit_id.as_bytes()],
        bump = summit_state.bump
    )]
    pub summit_state: Account<'info, SummitState>,

    /// The source token account for the transfer.
    pub source_account: InterfaceAccount<'info, TokenAccount>,

    /// The mint of the Summit Badge token.
    pub mint: InterfaceAccount<'info, Mint>,

    /// The destination token account.
    pub destination_account: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: Validated against summit policy / admin identity inside instruction logic
    pub source_owner: UncheckedAccount<'info>,

    /// CHECK: ExtraAccountMetas list PDA for Token-2022 validation
    pub extra_account_metas: UncheckedAccount<'info>,
}

// -----------------------------------------------------------------------------
// STATE SCHEMAS
// -----------------------------------------------------------------------------

#[account]
pub struct SummitState {
    pub admin: Pubkey,            // 32
    pub summit_id: String,        // 4 + 32 = 36
    pub total_workshops: u8,      // 1
    pub transferability_locked: bool, // 1
    pub total_attendees: u64,     // 8
    pub bump: u8,                 // 1
}

impl SummitState {
    pub const LEN: usize = 8 + 32 + 36 + 1 + 1 + 8 + 1 + 32; // Includes 32 bytes margin
}

#[account]
pub struct SessionRecord {
    pub attendee: Pubkey,         // 32
    pub session_signer: Pubkey,   // 32
    pub valid_until: i64,         // 8
    pub bump: u8,                 // 1
}

impl SessionRecord {
    pub const LEN: usize = 8 + 32 + 32 + 8 + 1 + 16;
}

#[account]
pub struct AttendeeRecord {
    pub attendee: Pubkey,         // 32
    pub attendance_mask: u64,     // 8 (up to 64 workshop stages)
    pub accumulated_xp: u32,      // 4
    pub bump: u8,                 // 1
}

impl AttendeeRecord {
    pub const LEN: usize = 8 + 32 + 8 + 4 + 1 + 16;
}

// -----------------------------------------------------------------------------
// EVENTS & ERRORS
// -----------------------------------------------------------------------------

#[event]
pub struct SummitInitializedEvent {
    pub summit_id: String,
    pub admin: Pubkey,
    pub total_workshops: u8,
}

#[event]
pub struct SessionDelegatedEvent {
    pub attendee: Pubkey,
    pub session_signer: Pubkey,
    pub valid_until: i64,
}

#[event]
pub struct WorkshopAttendedEvent {
    pub attendee: Pubkey,
    pub workshop_id: u8,
    pub xp_points: u32,
    pub current_mask: u64,
    pub new_total_xp: u32,
}

#[error_code]
pub enum SummitError {
    #[msg("Summit ID length must be 32 characters or fewer")]
    SummitIdTooLong,
    #[msg("Workshops count cannot exceed 64")]
    ExceedsMaxWorkshops,
    #[msg("Session validity duration must be positive")]
    InvalidDuration,
    #[msg("Session duration exceeds 24-hour ceiling")]
    DurationExceedsCap,
    #[msg("Workshop ID exceeds summit configuration")]
    InvalidWorkshopId,
    #[msg("Caller signature is unauthorized for this attendee session")]
    UnauthorizedSigner,
    #[msg("Ephemeral session has passed its expiration timestamp")]
    SessionExpired,
    #[msg("Missing session record PDA for delegated check-in")]
    MissingSessionAccount,
    #[msg("Session PDA does not match attendee target")]
    SessionAttendeeMismatch,
    #[msg("Workshop attendance has already been recorded for this attendee")]
    WorkshopAlreadyAttended,
    #[msg("Token transfers are strictly locked by summit organizer policy")]
    TransfersLockedBySummitPolicy,
    #[msg("Numerical overflow encountered")]
    ArithmeticOverflow,
}