import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SummitMesh } from "../target/types/summit_mesh";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";

describe("SummitMesh Technical QA Matrix", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SummitMesh as Program<SummitMesh>;
  const admin = provider.wallet as anchor.Wallet;

  const summitId = "BELGRADE-2025";
  const totalWorkshops = 32;

  let summitStatePda: PublicKey;
  let summitBump: number;

  const attendee = Keypair.generate();
  const ephemeralSession = Keypair.generate();
  let attendeeRecordPda: PublicKey;
  let sessionRecordPda: PublicKey;

  before(async () => {
    // Airdrop SOL to test wallets
    const sig1 = await provider.connection.requestAirdrop(attendee.publicKey, 5 * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig1);

    const sig2 = await provider.connection.requestAirdrop(ephemeralSession.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig2);

    [summitStatePda, summitBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("summit"), Buffer.from(summitId)],
      program.programId
    );

    [attendeeRecordPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("attendee"), summitStatePda.toBuffer(), attendee.publicKey.toBuffer()],
      program.programId
    );

    [sessionRecordPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("session"), summitStatePda.toBuffer(), attendee.publicKey.toBuffer()],
      program.programId
    );
  });

  it("1. Initializes the Solana Summit Serbia State Record", async () => {
    const tx = await program.methods
      .initializeSummit(summitId, totalWorkshops, true)
      .accounts({
        summitState: summitStatePda,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const state = await program.account.summitState.fetch(summitStatePda);
    expect(state.summitId).to.equal(summitId);
    expect(state.admin.toBase58()).to.equal(admin.publicKey.toBase58());
    expect(state.totalWorkshops).to.equal(totalWorkshops);
    expect(state.transferabilityLocked).to.be.true;
    expect(state.totalAttendees.toNumber()).to.equal(0);
  });

  it("2. Registers an Attendee and Initializes Credential Bitmask", async () => {
    await program.methods
      .initializeAttendee()
      .accounts({
        summitState: summitStatePda,
        attendeeRecord: attendeeRecordPda,
        attendee: attendee.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([attendee])
      .rpc();

    const record = await program.account.attendeeRecord.fetch(attendeeRecordPda);
    expect(record.attendee.toBase58()).to.equal(attendee.publicKey.toBase58());
    expect(record.attendanceMask.toNumber()).to.equal(0);
    expect(record.accumulatedXp).to.equal(0);
  });

  it("3. Delegates a 4-Hour Ephemeral Session Key to Mobile Device", async () => {
    const fourHoursInSeconds = new anchor.BN(4 * 3600);

    await program.methods
      .delegateSession(ephemeralSession.publicKey, fourHoursInSeconds)
      .accounts({
        sessionRecord: sessionRecordPda,
        summitState: summitStatePda,
        attendee: attendee.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([attendee])
      .rpc();

    const session = await program.account.sessionRecord.fetch(sessionRecordPda);
    expect(session.sessionSigner.toBase58()).to.equal(ephemeralSession.publicKey.toBase58());
    expect(session.attendee.toBase58()).to.equal(attendee.publicKey.toBase58());
  });

  it("4. Ephemeral Key Check-In at Workshop #0 (Frictionless Execution)", async () => {
    const workshopId = 0;
    const xpPoints = 250;

    await program.methods
      .recordWorkshopAttendance(workshopId, xpPoints)
      .accounts({
        summitState: summitStatePda,
        attendeeRecord: attendeeRecordPda,
        caller: ephemeralSession.publicKey,
        sessionRecord: sessionRecordPda,
      })
      .signers([ephemeralSession])
      .rpc();

    const record = await program.account.attendeeRecord.fetch(attendeeRecordPda);
    // Bit 0 must be set (mask == 1)
    expect(record.attendanceMask.toNumber()).to.equal(1);
    expect(record.accumulatedXp).to.equal(250);
  });

  it("5. Rejects Double-Claim / Re-attendance on Same Workshop", async () => {
    let failed = false;
    try {
      await program.methods
        .recordWorkshopAttendance(0, 250)
        .accounts({
          summitState: summitStatePda,
          attendeeRecord: attendeeRecordPda,
          caller: ephemeralSession.publicKey,
          sessionRecord: sessionRecordPda,
        })
        .signers([ephemeralSession])
        .rpc();
    } catch (err: any) {
      failed = true;
      expect(err.error.errorCode.code).to.equal("WorkshopAlreadyAttended");
    }
    expect(failed).to.be.true;
  });

  it("6. Workshop #7 Check-In Correctly Sets Bitmask Position (1 << 7)", async () => {
    const workshopId = 7;
    const xpPoints = 500;

    await program.methods
      .recordWorkshopAttendance(workshopId, xpPoints)
      .accounts({
        summitState: summitStatePda,
        attendeeRecord: attendeeRecordPda,
        caller: ephemeralSession.publicKey,
        sessionRecord: sessionRecordPda,
      })
      .signers([ephemeralSession])
      .rpc();

    const record = await program.account.attendeeRecord.fetch(attendeeRecordPda);
    // Mask: 1 (workshop 0) + (1 << 7 = 128) = 129
    expect(record.attendanceMask.toNumber()).to.equal(129);
    expect(record.accumulatedXp).to.equal(750);
  });

  it("7. Unauthorized Third Party Key is Rejected", async () => {
    const rogueKeypair = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(rogueKeypair.publicKey, anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig);

    let failed = false;
    try {
      await program.methods
        .recordWorkshopAttendance(3, 100)
        .accounts({
          summitState: summitStatePda,
          attendeeRecord: attendeeRecordPda,
          caller: rogueKeypair.publicKey,
          sessionRecord: sessionRecordPda,
        })
        .signers([rogueKeypair])
        .rpc();
    } catch (err: any) {
      failed = true;
      expect(err.error.errorCode.code).to.equal("UnauthorizedSigner");
    }
    expect(failed).to.be.true;
  });
});