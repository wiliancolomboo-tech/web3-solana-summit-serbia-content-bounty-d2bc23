import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SummitEngine } from "../target/types/summit_engine";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Ed25519Program,
  Transaction,
  sendAndConfirmTransaction
} from "@solana/web3.js";
import {
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  createInitializeMintInstruction,
  createInitializeNonTransferableMintInstruction,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  getAccount
} from "@solana/spl-token";
import { expect } from "chai";
import * as nacl from "tweetnacl";

describe("SummitEngine Comprehensive QA Suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SummitEngine as Program<SummitEngine>;
  const summitId = "BELGRADE_2025";
  const maxCapacity = 500;
  const grantAmount = new anchor.BN(50_000_000); // 0.05 SOL

  const organizer = Keypair.generate();
  const gatekeeper = Keypair.generate();
  const attendee = Keypair.generate();
  const ticketMint = Keypair.generate();

  let summitConfigPda: PublicKey;
  let vaultPda: PublicKey;
  let ticketRecordPda: PublicKey;
  let attendeeAta: PublicKey;

  before(async () => {
    // Fund test wallets from local validator
    for (const kp of [organizer, attendee]) {
      const sig = await provider.connection.requestAirdrop(kp.publicKey, 5 * anchor.web3.LAMPORTS_PER_SOL);
      const { blockhash, lastValidBlockHeight } = await provider.connection.getLatestBlockhash();
      await provider.connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight });
    }

    [summitConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("summit"), Buffer.from(summitId)],
      program.programId
    );

    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), Buffer.from(summitId)],
      program.programId
    );

    [ticketRecordPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("ticket"), Buffer.from(summitId), attendee.publicKey.toBuffer()],
      program.programId
    );

    attendeeAta = getAssociatedTokenAddressSync(
      ticketMint.publicKey,
      attendee.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
  });

  it("1. [POSITIVE] Initializes Summit Engine & Token-2022 Mint with Soulbound extensions", async () => {
    await program.methods
      .initializeSummit(summitId, gatekeeper.publicKey, maxCapacity, grantAmount)
      .accounts({
        authority: organizer.publicKey,
        summitConfig: summitConfigPda,
        vault: vaultPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([organizer])
      .rpc();

    // Fund the grant vault with 1 SOL
    const fundTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: organizer.publicKey,
        toPubkey: vaultPda,
        lamports: 1 * anchor.web3.LAMPORTS_PER_SOL,
      })
    );
    await sendAndConfirmTransaction(provider.connection, fundTx, [organizer]);

    // Build Token-2022 Non-Transferable Soulbound Mint
    const mintSpace = 164; // Base mint (82) + non-transferable extension
    const rentLamports = await provider.connection.getMinimumBalanceForRentExemption(mintSpace);

    const setupMintTx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: organizer.publicKey,
        newAccountPubkey: ticketMint.publicKey,
        space: mintSpace,
        lamports: rentLamports,
        programId: TOKEN_2022_PROGRAM_ID,
      }),
      createInitializeNonTransferableMintInstruction(
        ticketMint.publicKey,
        TOKEN_2022_PROGRAM_ID
      ),
      createInitializeMintInstruction(
        ticketMint.publicKey,
        0,
        summitConfigPda, // Program PDA is mint authority
        null,
        TOKEN_2022_PROGRAM_ID
      )
    );
    await sendAndConfirmTransaction(provider.connection, setupMintTx, [organizer, ticketMint]);

    const configAccount = await program.account.summitConfig.fetch(summitConfigPda);
    expect(configAccount.gatekeeper.toBase58()).to.equal(gatekeeper.publicKey.toBase58());
    expect(configAccount.totalRegistered).to.equal(0);
  });

  it("2. [POSITIVE] Registers Attendee & issues Non-Transferable Credential", async () => {
    const nonce = new anchor.BN(1337);

    // Create Attendee ATA for Token-2022
    const createAtaTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        attendee.publicKey,
        attendeeAta,
        attendee.publicKey,
        ticketMint.publicKey,
        TOKEN_2022_PROGRAM_ID
      )
    );
    await sendAndConfirmTransaction(provider.connection, createAtaTx, [attendee]);

    await program.methods
      .registerTicket(summitId, nonce)
      .accounts({
        attendee: attendee.publicKey,
        summitConfig: summitConfigPda,
        ticketRecord: ticketRecordPda,
        ticketMint: ticketMint.publicKey,
        attendeeTokenAccount: attendeeAta,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([attendee])
      .rpc();

    const record = await program.account.ticketRecord.fetch(ticketRecordPda);
    expect(record.attendee.toBase58()).to.equal(attendee.publicKey.toBase58());
    expect(record.checkedIn).to.be.false;

    const tokenAcc = await getAccount(provider.connection, attendeeAta, "confirmed", TOKEN_2022_PROGRAM_ID);
    expect(Number(tokenAcc.amount)).to.equal(1);
  });

  it("3. [NEGATIVE] Rejects attendance verification if Ed25519 instruction is missing", async () => {
    let failed = false;
    try {
      await program.methods
        .verifyAttendance(summitId, new anchor.BN(1337))
        .accounts({
          attendee: attendee.publicKey,
          summitConfig: summitConfigPda,
          ticketRecord: ticketRecordPda,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .signers([attendee])
        .rpc();
    } catch (err: any) {
      failed = true;
      expect(err.toString()).to.include("MissingGatekeeperSignature");
    }
    expect(failed).to.be.true;
  });

  it("4. [POSITIVE] Verifies physical presence with atomic Ed25519 gatekeeper proof", async () => {
    const nonce = new anchor.BN(1337);
    const nonceBuf = Buffer.alloc(8);
    nonceBuf.writeBigUInt64LE(BigInt(1337));
    const challengePayload = Buffer.concat([attendee.publicKey.toBuffer(), nonceBuf]);

    // Physical Gatekeeper creates Ed25519 signature
    const signature = nacl.sign.detached(challengePayload, gatekeeper.secretKey);

    const ed25519Instruction = Ed25519Program.createInstructionWithPublicKey({
      publicKey: gatekeeper.publicKey.toBytes(),
      message: challengePayload,
      signature: signature,
    });

    const verifyInstruction = await program.methods
      .verifyAttendance(summitId, nonce)
      .accounts({
        attendee: attendee.publicKey,
        summitConfig: summitConfigPda,
        ticketRecord: ticketRecordPda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

    const tx = new Transaction().add(ed25519Instruction).add(verifyInstruction);
    await sendAndConfirmTransaction(provider.connection, tx, [attendee]);

    const record = await program.account.ticketRecord.fetch(ticketRecordPda);
    expect(record.checkedIn).to.be.true;
  });

  it("5. [POSITIVE] Disburses instant micro-grant to verified attendee", async () => {
    const balanceBefore = await provider.connection.getBalance(attendee.publicKey);

    await program.methods
      .claimWorkshopGrant(summitId)
      .accounts({
        attendee: attendee.publicKey,
        summitConfig: summitConfigPda,
        ticketRecord: ticketRecordPda,
        vault: vaultPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([attendee])
      .rpc();

    const balanceAfter = await provider.connection.getBalance(attendee.publicKey);
    expect(balanceAfter - balanceBefore).to.be.greaterThan(45_000_000); // 0.05 SOL minus tx fee

    const record = await program.account.ticketRecord.fetch(ticketRecordPda);
    expect(record.grantClaimed).to.be.true;
  });

  it("6. [SECURITY] Prevents double-claiming of micro-grants", async () => {
    let failed = false;
    try {
      await program.methods
        .claimWorkshopGrant(summitId)
        .accounts({
          attendee: attendee.publicKey,
          summitConfig: summitConfigPda,
          ticketRecord: ticketRecordPda,
          vault: vaultPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([attendee])
        .rpc();
    } catch (err: any) {
      failed = true;
      expect(err.toString()).to.include("GrantAlreadyClaimed");
    }
    expect(failed).to.be.true;
  });
});