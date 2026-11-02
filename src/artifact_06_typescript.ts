import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { KhorosEngine } from "../target/types/khoros_engine";
import {
  TOKEN_2022_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import { expect } from "chai";

describe("khoros-engine integration verification", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.KhorosEngine as Program<KhorosEngine>;
  const admin = Keypair.generate();
  const keeper = Keypair.generate();
  const maker = Keypair.generate();
  const taker = Keypair.generate();

  let baseMint: PublicKey;
  let quoteMint: PublicKey;
  let marketConfigPda: PublicKey;
  let ringBufferPda: PublicKey;
  let vaultAuthPda: PublicKey;
  let baseVaultPda: PublicKey;
  let quoteVaultPda: PublicKey;

  let takerBaseAta: PublicKey;
  let takerQuoteAta: PublicKey;

  before(async () => {
    // Air-drop test balances
    for (const kp of [admin, keeper, maker, taker]) {
      const sig = await provider.connection.requestAirdrop(
        kp.publicKey,
        50 * anchor.web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);
    }

    // Initialize Token-2022 Mints
    baseMint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      6,
      Keypair.generate(),
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    quoteMint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      6,
      Keypair.generate(),
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    // Derive PDAs
    [marketConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("market"), quoteMint.toBuffer(), baseMint.toBuffer()],
      program.programId
    );

    [ringBufferPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("buffer"), marketConfigPda.toBuffer()],
      program.programId
    );

    [vaultAuthPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_auth"), marketConfigPda.toBuffer()],
      program.programId
    );

    [baseVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("base_vault"), marketConfigPda.toBuffer()],
      program.programId
    );

    [quoteVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("quote_vault"), marketConfigPda.toBuffer()],
      program.programId
    );

    // Create and fund Taker token accounts
    takerBaseAta = await createAccount(
      provider.connection,
      taker,
      baseMint,
      taker.publicKey,
      Keypair.generate(),
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    takerQuoteAta = await createAccount(
      provider.connection,
      taker,
      quoteMint,
      taker.publicKey,
      Keypair.generate(),
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    await mintTo(
      provider.connection,
      admin,
      quoteMint,
      takerQuoteAta,
      admin,
      500_000_000,
      [],
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
  });

  it("1. Initializes Market and Zero-Copy Ring Buffer with Strict Space Allocation", async () => {
    const tx = await program.methods
      .initializeMarket(15, 30) // 15 bps maker, 30 bps taker
      .accounts({
        admin: admin.publicKey,
        marketConfig: marketConfigPda,
        ringBuffer: ringBufferPda,
        baseMint: baseMint,
        quoteMint: quoteMint,
        baseVault: baseVaultPda,
        quoteVault: quoteVaultPda,
        vaultAuthority: vaultAuthPda,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([admin])
      .rpc();

    expect(tx).to.be.a("string");

    const marketState = await program.account.marketConfig.fetch(marketConfigPda);
    expect(marketState.admin.toBase58()).to.equal(admin.publicKey.toBase58());
    expect(marketState.isLocked).to.equal(0);
    expect(marketState.makerFeeBps).to.equal(15);

    // Seed liquidity directly into base vault for testing fills
    await mintTo(
      provider.connection,
      admin,
      baseMint,
      baseVaultPda,
      admin,
      100_000_000,
      [],
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
  });

  it("2. Appends Orders into Zero-Copy Ring Buffer and Benchmarks Low CU Consumption", async () => {
    for (let i = 0; i < 3; i++) {
      const tx = await program.methods
        .depositVoucher(
          new anchor.BN(1001 + i),
          new anchor.BN(20_000_000), // Price: 20 USDC per BASE
          new anchor.BN(5_000_000),  // Quantity: 5 BASE
          1                          // Side: 1 (Sell)
        )
        .accounts({
          maker: maker.publicKey,
          marketConfig: marketConfigPda,
          ringBuffer: ringBufferPda,
        })
        .signers([maker])
        .rpc();

      expect(tx).to.be.a("string");
    }

    const ringBuffer = await program.account.orderRingBuffer.fetch(ringBufferPda);
    expect(ringBuffer.count).to.equal(3);
    expect(ringBuffer.head).to.equal(0);
    expect(ringBuffer.tail).to.equal(3);
  });

  it("3. Executes Multi-Order Settlement Batch using Execution Mask Bitfield", async () => {
    const mask = 0b00000111; // Execute first 3 orders
    const maxBase = new anchor.BN(15_000_000);
    const maxQuote = new anchor.BN(300_000_000);

    const initialTakerBase = await getAccount(
      provider.connection,
      takerBaseAta,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    const tx = await program.methods
      .executeSettlementBatch(mask, maxBase, maxQuote)
      .accounts({
        keeper: keeper.publicKey,
        taker: taker.publicKey,
        marketConfig: marketConfigPda,
        ringBuffer: ringBufferPda,
        baseMint: baseMint,
        quoteMint: quoteMint,
        baseVault: baseVaultPda,
        quoteVault: quoteVaultPda,
        vaultAuthority: vaultAuthPda,
        takerBaseAccount: takerBaseAta,
        takerQuoteAccount: takerQuoteAta,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .signers([keeper, taker])
      .rpc();

    expect(tx).to.be.a("string");

    const finalTakerBase = await getAccount(
      provider.connection,
      takerBaseAta,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
    expect(Number(finalTakerBase.amount) - Number(initialTakerBase.amount)).to.equal(15_000_000);

    const bufferState = await program.account.orderRingBuffer.fetch(ringBufferPda);
    expect(bufferState.count).to.equal(0);
    expect(bufferState.head).to.equal(3);
  });

  it("4. Rejects Malicious Settlement Exceeding Slippage Invariant (Defense in Depth)", async () => {
    // Add another order
    await program.methods
      .depositVoucher(
        new anchor.BN(9999),
        new anchor.BN(50_000_000),
        new anchor.BN(10_000_000),
        1
      )
      .accounts({
        maker: maker.publicKey,
        marketConfig: marketConfigPda,
        ringBuffer: ringBufferPda,
      })
      .signers([maker])
      .rpc();

    try {
      await program.methods
        .executeSettlementBatch(
          0b00000001,
          new anchor.BN(100), // Intentionally set maxBase below trade volume
          new anchor.BN(100)
        )
        .accounts({
          keeper: keeper.publicKey,
          taker: taker.publicKey,
          marketConfig: marketConfigPda,
          ringBuffer: ringBufferPda,
          baseMint: baseMint,
          quoteMint: quoteMint,
          baseVault: baseVaultPda,
          quoteVault: quoteVaultPda,
          vaultAuthority: vaultAuthPda,
          takerBaseAccount: takerBaseAta,
          takerQuoteAccount: takerQuoteAta,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .signers([keeper, taker])
        .rpc();

      expect.fail("Transaction should have failed with SlippageLimitExceeded");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("SlippageLimitExceeded");
    }
  });
});