import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { SummitPass } from "../target/types/summit_pass";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";

describe("summit_pass protocol integration & security test matrix", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SummitPass as Program<SummitPass>;

  const organizer = Keypair.generate();
  const attendee = Keypair.generate();
  const ephemeralScanner = Keypair.generate();
  const maliciousAttacker = Keypair.generate();

  const eventId = new BN(101);
  const ticketPrice = new BN(0.25 * LAMPORTS_PER_SOL);
  const maxCapacity = 2;

  let eventPda: PublicKey;
  let vaultPda: PublicKey;
  let ticketPda: PublicKey;
  let sessionPda: PublicKey;

  before(async () => {
    // Fund test wallets
    const airdropSigners = [organizer, attendee, maliciousAttacker];
    for (const signer of airdropSigners) {
      const sig = await provider.connection.requestAirdrop(signer.publicKey, 10 * LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig, "confirmed");
    }

    // Derive PDA addresses
    [eventPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("event"), organizer.publicKey.toBuffer(), eventId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), eventPda.toBuffer()],
      program.programId
    );

    [ticketPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("ticket"), eventPda.toBuffer(), attendee.publicKey.toBuffer()],
      program.programId
    );

    [sessionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("session"), eventPda.toBuffer(), attendee.publicKey.toBuffer()],
      program.programId
    );
  });

  it("1. Initializes the Summit Event with Escrow Vault", async () => {
    const futureEndTime = new BN(Math.floor(Date.now() / 1000) + 86400); // +24 hours

    await program.methods
      .initializeEvent(eventId, ticketPrice, maxCapacity, futureEndTime)
      .accounts({
        event: eventPda,
        vault: vaultPda,
        authority: organizer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([organizer])
      .rpc();

    const eventAccount = await program.account.eventState.fetch(eventPda);
    expect(eventAccount.authority.toBase58()).to.equal(organizer.publicKey.toBase58());
    expect(eventAccount.ticketPriceLamports.toNumber()).to.equal(ticketPrice.toNumber());
    expect(eventAccount.maxCapacity).to.equal(maxCapacity);
    expect(eventAccount.ticketsSold).to.equal(0);
  });

  it("2. Attendees purchase a summit ticket, funding the Vault PDA", async () => {
    const vaultBalBefore = await provider.connection.getBalance(vaultPda);

    await program.methods
      .purchaseTicket()
      .accounts({
        event: eventPda,
        ticket: ticketPda,
        vault: vaultPda,
        attendee: attendee.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([attendee])
      .rpc();

    const vaultBalAfter = await provider.connection.getBalance(vaultPda);
    expect(vaultBalAfter - vaultBalBefore).to.equal(ticketPrice.toNumber());

    const ticketAccount = await program.account.ticketState.fetch(ticketPda);
    expect(ticketAccount.attendee.toBase58()).to.equal(attendee.publicKey.toBase58());
    expect(ticketAccount.isCheckedIn).to.be.false;
  });

  it("3. Attendee delegates an Ephemeral Session Key for kiosk check-in", async () => {
    const validUntil = new BN(Math.floor(Date.now() / 1000) + 3600); // +1 hour

    await program.methods
      .authorizeSessionSigner(validUntil)
      .accounts({
        event: eventPda,
        ticket: ticketPda,
        session: sessionPda,
        ephemeralSigner: ephemeralScanner.publicKey,
        attendee: attendee.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([attendee])
      .rpc();

    const sessionAccount = await program.account.sessionSignerState.fetch(sessionPda);
    expect(sessionAccount.ephemeralSigner.toBase58()).to.equal(ephemeralScanner.publicKey.toBase58());
    expect(sessionAccount.attendee.toBase58()).to.equal(attendee.publicKey.toBase58());
  });

  it("4. Venue Door Kiosk executes gasless verification via Ephemeral Signer", async () => {
    await program.methods
      .verifyAndCheckIn()
      .accounts({
        event: eventPda,
        ticket: ticketPda,
        session: sessionPda,
        ephemeralSigner: ephemeralScanner.publicKey,
      })
      .signers([ephemeralScanner])
      .rpc();

    const ticketAccount = await program.account.ticketState.fetch(ticketPda);
    const eventAccount = await program.account.eventState.fetch(eventPda);

    expect(ticketAccount.isCheckedIn).to.be.true;
    expect(ticketAccount.checkInTimestamp.toNumber()).to.be.greaterThan(0);
    expect(eventAccount.checkInsCount).to.equal(1);
  });

  it("5. Security Guard: Prevents double check-in replay attack", async () => {
    try {
      await program.methods
        .verifyAndCheckIn()
        .accounts({
          event: eventPda,
          ticket: ticketPda,
          session: sessionPda,
          ephemeralSigner: ephemeralScanner.publicKey,
        })
        .signers([ephemeralScanner])
        .rpc();
      expect.fail("Should have failed with AlreadyCheckedIn");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("AlreadyCheckedIn");
    }
  });

  it("6. Security Guard: Rejects malicious attacker attempting to withdraw event proceeds", async () => {
    try {
      await program.methods
        .withdrawProceeds()
        .accounts({
          event: eventPda,
          vault: vaultPda,
          authority: maliciousAttacker.publicKey,
        })
        .signers([maliciousAttacker])
        .rpc();
      expect.fail("Should have failed with unauthorized error");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("UnauthorizedAuthority");
    }
  });

  it("7. Authority withdraws proceeds safely without violating rent-exemption", async () => {
    const orgBalBefore = await provider.connection.getBalance(organizer.publicKey);

    await program.methods
      .withdrawProceeds()
      .accounts({
        event: eventPda,
        vault: vaultPda,
        authority: organizer.publicKey,
      })
      .signers([organizer])
      .rpc();

    const orgBalAfter = await provider.connection.getBalance(organizer.publicKey);
    expect(orgBalAfter).to.be.greaterThan(orgBalBefore);

    const remainingVaultBal = await provider.connection.getBalance(vaultPda);
    const rentExemptMin = await provider.connection.getMinimumBalanceForRentExemption(0);
    expect(remainingVaultBal).to.equal(rentExemptMin);
  });
});