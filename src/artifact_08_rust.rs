use anchor_lang::prelude::*;
use crate::state::SessionRegistry;
use crate::errors::SummitPulseError;

#[derive(Accounts)]
#[instruction(summit_id: String)]
pub struct InitializeSession<'info> {
    #[account(
        init,
        payer = authority,
        space = SessionRegistry::LEN,
        seeds = [b"session", summit_id.as_bytes()],
        bump
    )]
    pub session: Account<'info, SessionRegistry>,

    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: Target speaker address validated strictly via Pubkey pass-through
    pub speaker: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<InitializeSession>,
    summit_id: String,
    session_title: String,
    speaker: Pubkey,
    dispute_window_slots: u64,
) -> Result<()> {
    require!(summit_id.len() <= SessionRegistry::MAX_SUMMIT_ID_LEN, SummitPulseError::SummitIdTooLong);
    require!(session_title.len() <= SessionRegistry::MAX_TITLE_LEN, SummitPulseError::TitleTooLong);

    let session = &mut ctx.accounts.session;
    session.authority = ctx.accounts.authority.key();
    session.speaker = speaker;
    session.summit_id = summit_id;
    session.session_title = session_title;
    session.total_questions = 0;
    session.cumulative_lamports_routed = 0;
    session.dispute_window_slots = dispute_window_slots;
    session.is_active = true;
    session.bump = ctx.bumps.session;

    Ok(())
}