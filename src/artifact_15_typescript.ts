import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SerbiaEngine } from "../target/types/serbia_engine";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";

describe("serbia_engine QA Verification Matrix", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SerbiaEngine as Program<SerbiaEngine>;

  const marketAuthority = Keypair.generate();
  const traderAlice = Keypair.generate(); // Buyer (Maker)
  const traderBob = Keypair.generate();   // Seller (Taker)
  const crankKeeper = Keypair.generate();

  let baseMint: PublicKey;
  let quoteMint: PublicKey;
  let marketPda: PublicKey;
  let orderbookPda: PublicKey;
  let baseVaultPda: PublicKey;
  let quoteVaultPda: PublicKey;

  let aliceQuoteAccount: PublicKey;
  let aliceBaseAccount: PublicKey;
  let bobBaseAccount: PublicKey;
  let bobQuoteAccount: PublicKey;

  const marketId = new anchor.BN(9942);
  const feeBps = 20; // 0.20%

  before(async () => {
    // Airdrop SOL
    for (const kp of [marketAuthority, traderAlice, traderBob, crankKeeper]) {
      const sig = await provider.connection.requestAirdrop(
        kp.publicKey,
        10 * anchor.web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);
    }

    // Initialize Base & Quote Mints
    baseMint = await createMint(
      provider.connection,
      marketAuthority,
      marketAuthority.publicKey,
      null,
      6
    );
    quoteMint = await createMint(
      provider.connection,
      marketAuthority,
      marketAuthority.publicKey,
      null,
      6
    );

    // Derive PDAs
    [marketPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("market"), marketId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    [orderbookPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("orderbook"), marketPda.toBuffer()],
      program.programId
    );

    [baseVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), marketPda.toBuffer(), baseMint.toBuffer()],
      program.programId
    );

    [quoteVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), marketPda.toBuffer(), quoteMint.toBuffer()],
      program.programId
    );

    // Create User Token Accounts
    aliceQuoteAccount = await createAccount(
      provider.connection,
      traderAlice,
      quoteMint,
      traderAlice.publicKey
    );
    aliceBaseAccount = await createAccount(
      provider.connection,
      traderAlice,
      baseMint,
      traderAlice.publicKey
    );
    bobBaseAccount = await createAccount(
      provider.connection,
      traderBob,
      baseMint,
      traderBob.publicKey
    );
    bobQuoteAccount = await createAccount(
      provider.connection,
      traderBob,
      quoteMint,
      traderBob.publicKey
    );

    // Mint test collateral (1,000 Quote to Alice, 10 Base to Bob)
    await mintTo(
      provider.connection,
      marketAuthority,
      quoteMint,
      aliceQuoteAccount,
      marketAuthority,
      1_000_000_000 // 1,000.000000 Quote
    );
    await mintTo(
      provider.connection,
      marketAuthority,
      baseMint,
      bobBaseAccount,
      marketAuthority,
      10_000_000 // 10.000000 Base
    );
  });

  it("1. Initializes Market and Zero-Copy OrderBook PDA with dual vaults", async () => {
    const tx = await program.methods
      .initializeMarket(marketId, feeBps)
      .accounts({
        authority: marketAuthority.publicKey,
        baseMint,
        quoteMint,
        market: marketPda,
        orderbook: orderbookPda,
        baseVault: baseVaultPda,
        quoteVault: quoteVaultPda,
        systemProgram: SystemProgram.programId,
        tokenProgram: anchor.spl.token.TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([marketAuthority])
      .rpc();

    const marketState = await program.account.market.fetch(marketPda);
    expect(marketState.marketId.toNumber()).to.equal(9942);
    expect(marketState.feeBps).to.equal(20);
    expect(marketState.guardStatus).to.equal(0); // Unlocked
  });

  it("2. Escrows Quote token and registers Limit Bid in Zero-Copy book", async () => {
    const priceScaled = new anchor.BN(50_000_000); // 50.00 Quote per Base
    const qtyLots = new anchor.BN(2_000_000);       // 2 Base units

    await program.methods
      .placeOrder(0, priceScaled, qtyLots) // Side 0 = Bid
      .accounts({
        owner: traderAlice.publicKey,
        market: marketPda,
        orderbook: orderbookPda,
        userTokenAccount: aliceQuoteAccount,
        baseVault: baseVaultPda,
        quoteVault: quoteVaultPda,
        tokenProgram: anchor.spl.token.TOKEN_PROGRAM_ID,
      })
      .signers([traderAlice])
      .rpc();

    // Alice escrows 2 * 50 = 100 Quote tokens
    const vaultBal = await getAccount(provider.connection, quoteVaultPda);
    expect(Number(vaultBal.amount)).to.equal(100_000_000);
  });

  it("3. Escrows Base token and registers Limit Ask crossing the spread", async () => {
    const priceScaled = new anchor.BN(50_000_000); // 50.00 Quote per Base
    const qtyLots = new anchor.BN(2_000_000);       // 2 Base units

    await program.methods
      .placeOrder(1, priceScaled, qtyLots) // Side 1 = Ask
      .accounts({
        owner: traderBob.publicKey,
        market: marketPda,
        orderbook: orderbookPda,
        userTokenAccount: bobBaseAccount,
        baseVault: baseVaultPda,
        quoteVault: quoteVaultPda,
        tokenProgram: anchor.spl.token.TOKEN_PROGRAM_ID,
      })
      .signers([traderBob])
      .rpc();

    // Bob escrows 2 Base tokens into base vault
    const baseVaultBal = await getAccount(provider.connection, baseVaultPda);
    expect(Number(baseVaultBal.amount)).to.equal(2_000_000);
  });

  it("4. Executes deterministic crank matching with fee deduction", async () => {
    const maxIterations = 10;

    await program.methods
      .matchOrders(maxIterations)
      .accounts({
        crankAuthority: crankKeeper.publicKey,
        market: marketPda,
        orderbook: orderbookPda,
        makerTokenAccount: aliceBaseAccount,
        takerTokenAccount: bobQuoteAccount,
        baseVault: baseVaultPda,
        quoteVault: quoteVaultPda,
        tokenProgram: anchor.spl.token.TOKEN_PROGRAM_ID,
      })
      .signers([crankKeeper])
      .rpc();

    // Assert settlement:
    // Alice receives 2 Base tokens
    const aliceBaseBal = await getAccount(provider.connection, aliceBaseAccount);
    expect(Number(aliceBaseBal.amount)).to.equal(2_000_000);

    // Bob receives Quote tokens net of fee: 100 * (1 - 0.0020) = 99.80 Quote
    const bobQuoteBal = await getAccount(provider.connection, bobQuoteAccount);
    expect(Number(bobQuoteBal.amount)).to.equal(99_800_000);

    // Residual fee remains accrued in quote vault = 0.20 Quote (200,000 units)
    const quoteVaultBal = await getAccount(provider.connection, quoteVaultPda);
    expect(Number(quoteVaultBal.amount)).to.equal(200_000);
  });

  it("5. Rejects unauthorized order cancellation", async () => {
    // Place fresh bid
    const priceScaled = new anchor.BN(45_000_000);
    const qtyLots = new anchor.BN(1_000_000);

    await program.methods
      .placeOrder(0, priceScaled, qtyLots)
      .accounts({
        owner: traderAlice.publicKey,
        market: marketPda,
        orderbook: orderbookPda,
        userTokenAccount: aliceQuoteAccount,
        baseVault: baseVaultPda,
        quoteVault: quoteVaultPda,
        tokenProgram: anchor.spl.token.TOKEN_PROGRAM_ID,
      })
      .signers([traderAlice])
      .rpc();

    // Attacker attempts to cancel Alice's order
    try {
      const bogusOrderId = new anchor.BN(1);
      await program.methods
        .cancelOrder(bogusOrderId, 0)
        .accounts({
          owner: traderBob.publicKey, // Unauthorized signer
          market: marketPda,
          orderbook: orderbookPda,
          userRefundAccount: bobQuoteAccount,
          baseVault: baseVaultPda,
          quoteVault: quoteVaultPda,
          tokenProgram: anchor.spl.token.TOKEN_PROGRAM_ID,
        })
        .signers([traderBob])
        .rpc();
      expect.fail("Expected cancellation to fail with OrderNotFound or Unauthorized");
    } catch (err: any) {
      expect(err.toString()).to.include("OrderNotFound");
    }
  });
});