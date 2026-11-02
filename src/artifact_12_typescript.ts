import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { DanubeStream } from "../target/types/danube_stream";
import {
  TOKEN_2022_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { assert, expect } from "chai";

describe("danube_stream test suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.DanubeStream as Program<DanubeStream>;

  const sender = Keypair.generate();
  const recipient = Keypair.generate();
  const keeper = Keypair.generate();
  const feeAdmin = Keypair.generate();

  let mint: PublicKey;
  let senderAta: PublicKey;
  let recipientAta: PublicKey;
  let keeperAta: PublicKey;
  let feeAta: PublicKey;
  let configPda: PublicKey;
  let configBump: number;

  const streamId = new anchor.BN(101);
  const ratePerSecond = new anchor.BN(1_000_000); // 1 Token (6 decimals) per sec
  const duration = 100; // 100 seconds
  const totalDeposit = ratePerSecond.mul(new anchor.BN(duration)); // 100,000,000

  before(async () => {
    // Fund test wallets
    for (const kp of [sender, recipient, keeper, feeAdmin]) {
      const sig = await provider.connection.requestAirdrop(
        kp.publicKey,
        5 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig, "confirmed");
    }

    // Create Token-2022 Mint with 6 decimals
    mint = await createMint(
      provider.connection,
      sender,
      sender.publicKey,
      null,
      6,
      Keypair.generate(),
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    // Create ATAs
    senderAta = await createAccount(
      provider.connection,
      sender,
      mint,
      sender.publicKey,
      Keypair.generate(),
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
    recipientAta = await createAccount(
      provider.connection,
      recipient,
      mint,
      recipient.publicKey,
      Keypair.generate(),
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
    keeperAta = await createAccount(
      provider.connection,
      keeper,
      mint,
      keeper.publicKey,
      Keypair.generate(),
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
    feeAta = await createAccount(
      provider.connection,
      feeAdmin,
      mint,
      feeAdmin.publicKey,
      Keypair.generate(),
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    // Mint tokens to sender
    await mintTo(
      provider.connection,
      sender,
      mint,
      senderAta,
      sender,
      1_000_000_000,
      [],
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    // Derive Config PDA
    [configPda, configBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("danube_config")],
      program.programId
    );
  });

  it("1. Successfully initializes a continuous stream with escrow locking", async () => {
    const now = Math.floor(Date.now() / 1000);
    const startTime = new anchor.BN(now);
    const endTime = new anchor.BN(now + duration);
    const keeperTipBps = 100; // 1%

    const [streamStatePda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("danube_stream"),
        sender.publicKey.toBuffer(),
        recipient.publicKey.toBuffer(),
        streamId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    const [escrowVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("danube_vault"), streamStatePda.toBuffer()],
      program.programId
    );

    await program.methods
      .initializeStream(
        streamId,
        ratePerSecond,
        startTime,
        endTime,
        keeperTipBps
      )
      .accounts({
        sender: sender.publicKey,
        recipient: recipient.publicKey,
        mint: mint,
        senderTokenAccount: senderAta,
        streamState: streamStatePda,
        escrowVault: escrowVaultPda,
        config: configPda,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([sender])
      .rpc();

    const vaultAccount = await getAccount(
      provider.connection,
      escrowVaultPda,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
    assert.equal(vaultAccount.amount.toString(), totalDeposit.toString());

    const state = await program.account.streamState.fetch(streamStatePda);
    assert.equal(state.isActive, true);
    assert.equal(state.depositAmount.toString(), totalDeposit.toString());
    assert.equal(state.withdrawnAmount.toString(), "0");
  });

  it("2. Rejects withdrawal when current time == start time (no accrued balance)", async () => {
    const [streamStatePda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("danube_stream"),
        sender.publicKey.toBuffer(),
        recipient.publicKey.toBuffer(),
        streamId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    const [escrowVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("danube_vault"), streamStatePda.toBuffer()],
      program.programId
    );

    try {
      await program.methods
        .withdrawStream()
        .accounts({
          caller: recipient.publicKey,
          recipient: recipient.publicKey,
          recipientTokenAccount: recipientAta,
          keeperTokenAccount: null,
          protocolFeeAccount: feeAta,
          mint: mint,
          streamState: streamStatePda,
          escrowVault: escrowVaultPda,
          config: configPda,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .signers([recipient])
        .rpc();
      assert.fail("Should have failed with NoFundsAvailableForWithdrawal");
    } catch (err: any) {
      expect(err.message).to.satisfy(
        (m: string) =>
          m.includes("NoFundsAvailableForWithdrawal") ||
          m.includes("StreamNotStarted")
      );
    }
  });

  it("3. Executes stream withdrawal with keeper crank incentive after 5 seconds", async () => {
    // Wait 5 seconds to accrue flow
    await new Promise((resolve) => setTimeout(resolve, 5000));

    const [streamStatePda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("danube_stream"),
        sender.publicKey.toBuffer(),
        recipient.publicKey.toBuffer(),
        streamId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    const [escrowVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("danube_vault"), streamStatePda.toBuffer()],
      program.programId
    );

    await program.methods
      .withdrawStream()
      .accounts({
        caller: keeper.publicKey,
        recipient: recipient.publicKey,
        recipientTokenAccount: recipientAta,
        keeperTokenAccount: keeperAta,
        protocolFeeAccount: feeAta,
        mint: mint,
        streamState: streamStatePda,
        escrowVault: escrowVaultPda,
        config: configPda,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .signers([keeper])
      .rpc();

    const recipientBalance = await getAccount(
      provider.connection,
      recipientAta,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
    const keeperBalance = await getAccount(
      provider.connection,
      keeperAta,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    assert.isAbove(Number(recipientBalance.amount), 0);
    assert.isAbove(Number(keeperBalance.amount), 0);
  });

  it("4. Allows sender to cancel stream, settling accrued funds and reclaiming unspent principal", async () => {
    const [streamStatePda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("danube_stream"),
        sender.publicKey.toBuffer(),
        recipient.publicKey.toBuffer(),
        streamId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    const [escrowVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("danube_vault"), streamStatePda.toBuffer()],
      program.programId
    );

    const senderInitialTokens = (
      await getAccount(
        provider.connection,
        senderAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      )
    ).amount;

    await program.methods
      .cancelAndClose()
      .accounts({
        sender: sender.publicKey,
        recipient: recipient.publicKey,
        senderTokenAccount: senderAta,
        recipientTokenAccount: recipientAta,
        mint: mint,
        streamState: streamStatePda,
        escrowVault: escrowVaultPda,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .signers([sender])
      .rpc();

    // Stream account is closed and lamports refunded
    const nullAccount = await provider.connection.getAccountInfo(
      streamStatePda
    );
    assert.isNull(nullAccount);

    const senderFinalTokens = (
      await getAccount(
        provider.connection,
        senderAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      )
    ).amount;
    assert.isAbove(Number(senderFinalTokens), Number(senderInitialTokens));
  });
});