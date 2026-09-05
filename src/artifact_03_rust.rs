use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions as ix_sysvar;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("Be1g2SrvHvy8eYx9C4WqY7wXFk1bHqB7dGzQkL9vP3m");

pub const MAX_TELEMETRY_SAMPLES: usize = 32;
pub const DISCRIMINATOR_LENGTH: usize = 8;
pub const ED25519_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    0x03, 0xa8, 0x8c, 0x27, 0x05, 0x4f, 0x8a, 0x7f, 
    0x08, 0x58, 0x1f, 0x7d, 0x6e, 0x22, 0xa5, 0x88, 
    0xb3, 0x12, 0x71, 0x3f, 0x67, 0xd2, 0x48, 0x44, 
    0x96, 0x93, 0x70, 0x98, 0x5a, 0x1e, 0xd0, 0x54,
]); // Ed25519SigVerify111111111111111111111111111

#[program]
pub mod belgradum_engine {
    use super::*;

    pub fn initialize_engine(
        ctx: Context<InitializeEngine>,
        settlement_window_slots: u64,
        reward_per_sample: u64,
    ) -> Result<()> {
        require!(settlement_window_slots >= 100, BelgradumError::InvalidWindowSize);
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.reward_mint = ctx.accounts.reward_mint.key();
        config.settlement_window_slots = settlement_window_slots;
        config.reward_per_sample = reward_per_sample;
        config.total_nodes_registered = 0;
        config.bump = ctx.bumps.config;
        config.escrow_bump = ctx.bumps.escrow_vault;
        Ok(())
    }

    pub fn register_node(
        ctx: Context<RegisterNode>,
        hardware_id: [u8; 16],
        device_type: u8,
    ) -> Result<()> {
        let node = &mut ctx.accounts.node_registry;
        node.node_authority = ctx.accounts.node_authority.key();
        node.hardware_id = hardware_id;
        node.device_type = device_type;
        node.total_samples_submitted = 0;
        node.last_submission_slot = Clock::get()?.slot;
        node.active_buffer_epoch = Clock::get()?.slot / ctx.accounts.config.settlement_window_slots;
        node.bump = ctx.bumps.node_registry;

        let config = &mut ctx.accounts.config;
        config.total_nodes_registered = config.total_nodes_registered
            .checked_add(1)
            .ok_or(BelgradumError::NumericalOverflow)?;

        emit!(NodeRegisteredEvent {
            node: node.key(),
            hardware_id,
            authority: ctx.accounts.node_authority.key(),
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    pub fn ingest_telemetry_batch(
        ctx: Context<IngestTelemetryBatch>,
        epoch_index: u64,
        metrics_batch: [TelemetrySample; 8],
    ) -> Result<()> {
        let current_slot = Clock::get()?.slot;
        let expected_epoch = current_slot / ctx.accounts.config.settlement_window_slots;
        require_eq!(epoch_index, expected_epoch, BelgradumError::StaleEpochSubmission);

        // Security Guard: Introspect prior instruction for hardware Ed25519 signature
        verify_ed25519_precompile(&ctx.accounts.instruction_sysvar.to_account_info())?;

        let mut buffer = ctx.accounts.telemetry_buffer.load_mut()?;
        if buffer.sample_count == 0 {
            buffer.node = ctx.accounts.node_registry.key();
            buffer.epoch_index = epoch_index;
            buffer.creation_slot = current_slot;
        }

        let current_count = buffer.sample_count as usize;
        require!(
            current_count + metrics_batch.len() <= MAX_TELEMETRY_SAMPLES,
            BelgradumError::TelemetryBufferOverflow
        );

        for (i, sample) in metrics_batch.iter().enumerate() {
            require!(sample.metric_value > 0, BelgradumError::InvalidSampleData);
            buffer.samples[current_count + i] = *sample;
        }

        buffer.sample_count = (current_count + metrics_batch.len()) as u32;

        let node = &mut ctx.accounts.node_registry;
        node.total_samples_submitted = node.total_samples_submitted
            .checked_add(metrics_batch.len() as u64)
            .ok_or(BelgradumError::NumericalOverflow)?;
        node.last_submission_slot = current_slot;

        emit!(BatchIngestedEvent {
            node: node.key(),
            epoch_index,
            samples_ingested: metrics_batch.len() as u8,
            current_total: buffer.sample_count,
        });

        Ok(())
    }

    pub fn settle_epoch_and_reclaim(
        ctx: Context<SettleEpochAndReclaim>,
        target_epoch: u64,
    ) -> Result<()> {
        let current_slot = Clock::get()?.slot;
        let active_epoch = current_slot / ctx.accounts.config.settlement_window_slots;
        require!(active_epoch > target_epoch, BelgradumError::EpochStillActive);

        let buffer = ctx.accounts.telemetry_buffer.load()?;
        require_eq!(buffer.epoch_index, target_epoch, BelgradumError::EpochMismatch);
        let sample_count = buffer.sample_count as u64;

        let total_reward = sample_count
            .checked_mul(ctx.accounts.config.reward_per_sample)
            .ok_or(BelgradumError::NumericalOverflow)?;

        drop(buffer);

        if total_reward > 0 {
            let config_key = ctx.accounts.config.key();
            let signer_seeds: &[&[&[u8]]] = &[&[
                b"escrow",
                config_key.as_ref(),
                &[ctx.accounts.config.escrow_bump],
            ]];

            let cpi_accounts = Transfer {
                from: ctx.accounts.escrow_vault.to_account_info(),
                to: ctx.accounts.node_token_account.to_account_info(),
                authority: ctx.accounts.escrow_vault.to_account_info(),
            };
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                cpi_accounts,
                signer_seeds,
            );
            token::transfer(cpi_ctx, total_reward)?;
        }

        // Close buffer account and reclaim rent lamports to keeper/node operator
        let dest_starting_lamports = ctx.accounts.reclaim_recipient.lamports();
        let buffer_info = ctx.accounts.telemetry_buffer.to_account_info();
        **ctx.accounts.reclaim_recipient.lamports.borrow_mut() = dest_starting_lamports
            .checked_add(buffer_info.lamports())
            .ok_or(BelgradumError::NumericalOverflow)?;
        **buffer_info.lamports.borrow_mut() = 0;

        let mut buffer_data = buffer_info.try_borrow_mut_data()?;
        buffer_data.fill(0);

        emit!(EpochSettledEvent {
            node: ctx.accounts.node_registry.key(),
            epoch_index: target_epoch,
            samples_settled: sample_count,
            reward_distributed: total_reward,
            reclaimed_lamports: dest_starting_lamports,
        });

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// Instructions & Context Account Structs
// -----------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializeEngine<'info> {
    #[account(
        init,
        payer = admin,
        space = DISCRIMINATOR_LENGTH + EngineConfig::INIT_SPACE,
        seeds = [b"engine_config", admin.key().as_ref()],
        bump
    )]
    pub config: Account<'info, EngineConfig>,

    pub reward_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = admin,
        seeds = [b"escrow", config.key().as_ref()],
        bump,
        token::mint = reward_mint,
        token::authority = escrow_vault
    )]
    pub escrow_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(hardware_id: [u8; 16])]
pub struct RegisterNode<'info> {
    #[account(
        mut,
        seeds = [b"engine_config", config.admin.as_ref()],
        bump = config.bump
    )]
    pub config: Account<'info, EngineConfig>,

    #[account(
        init,
        payer = node_authority,
        space = DISCRIMINATOR_LENGTH + NodeRegistry::INIT_SPACE,
        seeds = [b"node", config.key().as_ref(), node_authority.key().as_ref()],
        bump
    )]
    pub node_registry: Account<'info, NodeRegistry>,

    #[account(mut)]
    pub node_authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(epoch_index: u64)]
pub struct IngestTelemetryBatch<'info> {
    #[account(
        seeds = [b"engine_config", config.admin.as_ref()],
        bump = config.bump
    )]
    pub config: Account<'info, EngineConfig>,

    #[account(
        mut,
        seeds = [b"node", config.key().as_ref(), node_authority.key().as_ref()],
        bump = node_registry.bump,
        has_one = node_authority @ BelgradumError::UnauthorizedNodeAuthority
    )]
    pub node_registry: Account<'info, NodeRegistry>,

    #[account(
        init_if_needed,
        payer = node_authority,
        space = DISCRIMINATOR_LENGTH + std::mem::size_of::<TelemetryBuffer>(),
        seeds = [b"buffer", node_registry.key().as_ref(), epoch_index.to_le_bytes().as_ref()],
        bump
    )]
    pub telemetry_buffer: AccountLoader<'info, TelemetryBuffer>,

    #[account(mut)]
    pub node_authority: Signer<'info>,

    /// CHECK: Instructions sysvar for ed25519 introspection
    #[account(address = ix_sysvar::ID @ BelgradumError::InvalidInstructionSysvar)]
    pub instruction_sysvar: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(target_epoch: u64)]
pub struct SettleEpochAndReclaim<'info> {
    #[account(
        seeds = [b"engine_config", config.admin.as_ref()],
        bump = config.bump
    )]
    pub config: Account<'info, EngineConfig>,

    #[account(
        mut,
        seeds = [b"node", config.key().as_ref(), node_registry.node_authority.as_ref()],
        bump = node_registry.bump
    )]
    pub node_registry: Account<'info, NodeRegistry>,

    #[account(
        mut,
        seeds = [b"buffer", node_registry.key().as_ref(), target_epoch.to_le_bytes().as_ref()],
        bump
    )]
    pub telemetry_buffer: AccountLoader<'info, TelemetryBuffer>,

    #[account(
        mut,
        seeds = [b"escrow", config.key().as_ref()],
        bump = config.escrow_bump
    )]
    pub escrow_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = node_token_account.owner == node_registry.node_authority @ BelgradumError::InvalidTokenDestination
    )]
    pub node_token_account: Account<'info, TokenAccount>,

    /// CHECK: Recipient of the reclaimed buffer account storage rent
    #[account(mut)]
    pub reclaim_recipient: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}

// -----------------------------------------------------------------------------
// State Layouts (Zero-Copy & Standard)
// -----------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct EngineConfig {
    pub admin: Pubkey,
    pub reward_mint: Pubkey,
    pub settlement_window_slots: u64,
    pub reward_per_sample: u64,
    pub total_nodes_registered: u64,
    pub bump: u8,
    pub escrow_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct NodeRegistry {
    pub node_authority: Pubkey,
    pub hardware_id: [u8; 16],
    pub total_samples_submitted: u64,
    pub last_submission_slot: u64,
    pub active_buffer_epoch: u64,
    pub device_type: u8,
    pub bump: u8,
}

#[account(zero_copy)]
#[repr(C)]
pub struct TelemetryBuffer {
    pub node: Pubkey,                // 32 bytes
    pub epoch_index: u64,            // 8 bytes
    pub creation_slot: u64,          // 8 bytes
    pub sample_count: u32,           // 4 bytes
    pub _padding: [u8; 4],           // 4 bytes (8-byte alignment alignment)
    pub samples: [TelemetrySample; 32], // 32 * 32 bytes = 1024 bytes
}

#[zero_copy]
#[repr(C)]
#[derive(Default, PartialEq, Debug)]
pub struct TelemetrySample {
    pub timestamp: i64,       // 8 bytes
    pub metric_value: u64,    // 8 bytes (e.g. wattage, micro-voltage)
    pub variance_index: u32,  // 4 bytes
    pub error_flags: u32,     // 4 bytes
    pub reserved: [u8; 8],    // 8 bytes
}

// -----------------------------------------------------------------------------
// Security Checks & Syscall Introspection
// -----------------------------------------------------------------------------

pub fn verify_ed25519_precompile(sysvar_account_info: &AccountInfo) -> Result<()> {
    let current_instruction_index = ix_sysvar::load_current_index_checked(sysvar_account_info)?;
    require!(current_instruction_index > 0, BelgradumError::MissingSignatureVerification);

    let prior_instruction = ix_sysvar::load_instruction_at_checked(
        (current_instruction_index - 1) as usize,
        sysvar_account_info,
    )?;

    require_keys_eq!(
        prior_instruction.program_id,
        ED25519_PROGRAM_ID,
        BelgradumError::MissingSignatureVerification
    );

    // Ensure instruction contains expected header structure
    require!(
        prior_instruction.data.len() >= 16,
        BelgradumError::MalformedSignatureVerification
    );

    Ok(())
}

// -----------------------------------------------------------------------------
// Error Codes & Events
// -----------------------------------------------------------------------------

#[error_code]
pub enum BelgradumError {
    #[msg("Settlement window must be at least 100 slots")]
    InvalidWindowSize,
    #[msg("Numerical overflow detected during math operation")]
    NumericalOverflow,
    #[msg("Submitted epoch does not match current chain slot window")]
    StaleEpochSubmission,
    #[msg("Missing required Ed25519 signature verification prior instruction")]
    MissingSignatureVerification,
    #[msg("Telemetry buffer is completely full for current epoch")]
    TelemetryBufferOverflow,
    #[msg("Sample metric value cannot be zero")]
    InvalidSampleData,
    #[msg("Epoch window is still active; cannot trigger keeper settlement")]
    EpochStillActive,
    #[msg("Buffer epoch index does not match requested settlement epoch")]
    EpochMismatch,
    #[msg("Signer does not match registered authority for node")]
    UnauthorizedNodeAuthority,
    #[msg("Provided instruction sysvar is invalid")]
    InvalidInstructionSysvar,
    #[msg("Destination token account does not belong to node authority")]
    InvalidTokenDestination,
    #[msg("Malformed Ed25519 verification payload")]
    MalformedSignatureVerification,
}

#[event]
pub struct NodeRegisteredEvent {
    pub node: Pubkey,
    pub hardware_id: [u8; 16],
    pub authority: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct BatchIngestedEvent {
    pub node: Pubkey,
    pub epoch_index: u64,
    pub samples_ingested: u8,
    pub current_total: u32,
}

#[event]
pub struct EpochSettledEvent {
    pub node: Pubkey,
    pub epoch_index: u64,
    pub samples_settled: u64,
    pub reward_distributed: u64,
    pub reclaimed_lamports: u64,
}