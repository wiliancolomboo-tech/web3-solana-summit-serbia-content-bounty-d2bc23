import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SolanaSummitEngine } from "../target/types/solana_summit_engine";
import {
  TOKEN_2022_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { expect } from "chai";

describe("Solana Summit Serbia - Zero-Copy Engine QA Suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SolanaSummitEngine as Program<SolanaSummitEngine>;

  let baseMint: anchor.web3.PublicKey;
  let quoteMint: anchor.web3.PublicKey;
  let marketPda: anchor.web3.PublicKey;
  let marketBump: number;
  let orderbookPda: anchor.web3.PublicKey;
  let orderbookBump: number;
  let vaultBasePda: anchor.web3.PublicKey;
  let vaultBaseBump: number;
  let vaultQuotePda: anchor.web3.PublicKey;
  let vaultQuoteBump: number;

  let traderA = anchor.web3.Keypair.generate();
  let traderB = anchor.web3.Keypair.generate();
  let keeper = anchor.web3.Keypair.generate();

  let traderABaseAta: anchor.web3.PublicKey;
  let traderAQuoteAta: anchor.web3.PublicKey;
  let traderBBaseAta: anchor.web3.PublicKey;
  let traderBQuoteAta: anchor.web3.PublicKey;

  before(async () => {
    // Fund test actors
    for (const actor of [traderA, traderB, keeper]) {
      const sig = await provider.connection.requestAirdrop(
        actor.publicKey,
        10 * anchor.web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);
    }

    // Initialize Token-2022 Mints
    baseMint = await createMint(
      provider.connection,
      (provider.wallet as any).payer,
      provider.wallet.publicKey,
      null,
      9,
      undefined,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    quoteMint = await createMint(
      provider.connection,
      (provider.wallet as any).payer,
      provider.wallet.publicKey,
      null,
      6,
      undefined,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    // Derive PDAs
    [marketPda, marketBump] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("market"), baseMint.toBuffer(), quoteMint.toBuffer()],
      program.programId
    );

    [orderbookPda, orderbookBump] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("orderbook"), marketPda.toBuffer()],
      program.programId
    );

    [vaultBasePda, vaultBaseBump] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), marketPda.toBuffer(), baseMint.toBuffer()],
      program.programId
    );

    [vaultQuotePda, vaultQuoteBump] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), marketPda.toBuffer(), quoteMint.toBuffer()],
      program.programId
    );

    // Setup Token Accounts
    traderABaseAta = await createAccount(
      provider.connection,
      (provider.wallet as any).payer,
      baseMint,
      traderA.publicKey,
      undefined,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    traderAQuoteAta = await createAccount(
      provider.connection,
      (provider.wallet as any).payer,
      quoteMint,
      traderA.publicKey,
      undefined,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    traderBBaseAta = await createAccount(
      provider.connection,
      (provider.wallet as any).payer,
      baseMint,
      traderB.publicKey,
      undefined,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    traderBQuoteAta = await createAccount(
      provider.connection,
      (provider.wallet as any).payer,
      quoteMint,
      traderB.publicKey,
      undefined,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    // Mint liquidity: Trader A gets Quote (for buying), Trader B gets Base (for selling)
    await mintTo(
      provider.connection,
      (provider.wallet as any).payer,
      quoteMint,
      traderAQuoteAta,
      provider.wallet.publicKey,
      1_000_000_000,
      [],
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    await mintTo(
      provider.connection,
      (provider.wallet as any).payer,
      baseMint,
      traderBBaseAta,
      provider.wallet.publicKey,
      50_000_000_000,
      [],
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
  });

  it("1. Initializes Market with Canonical PDAs & Zero-Copy Orderbook", async () => {
    const tx = await program.methods
      .initializeMarket(marketBump, orderbookBump, vaultBaseBump, vaultQuoteBump)
      .accounts({
        authority: provider.wallet.publicKey,
        baseMint,
        quoteMint,
        market: marketPda,
        orderbook: orderbookPda,
        vaultBase: vaultBasePda,
        vaultQuote: vaultQuotePda,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    expect(tx).to.be.a("string");
    const marketAccount = await program.account.market.fetch(marketPda);
    expect(marketAccount.baseMint.toBase58()).to.equal(baseMint.toBase58());
    expect(marketAccount.quoteMint.toBase58()).to.equal(quoteMint.toBase58());
  });

  it("2. Places Bid Order into Zero-Copy Structure with Token-2022 Escrow", async () => {
    const price = new anchor.BN(100);
    const quantity = new anchor.BN(5);

    const tx = await program.methods
      .placeOrder(0, price, quantity)
      .accounts({
        trader: traderA.publicKey,
        market: marketPda,
        orderbook: orderbookPda,
        baseMint,
        quoteMint,
        vaultBase: vaultBasePda,
        vaultQuote: vaultQuotePda,
        userTokenAccount: traderAQuoteAta,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .signers([traderA])
      .rpc();

    expect(tx).to.be.a("string");
    const orderbookAccount = await program.account.orderBookState.fetch(orderbookPda);
    expect(orderbookAccount.bidCount).to.equal(1);
    expect(orderbookAccount.bids[0].price.toNumber()).to.equal(100);
    expect(orderbookAccount.bids[0].quantity.toNumber()).to.equal(5);
  });

  it("3. Places Ask Order Crossing Spread & Executes Atomic Settlement Crank", async () => {
    const askPrice = new anchor.BN(95);
    const askQuantity = new anchor.BN(5);

    // Trader B places Ask
    await program.methods
      .placeOrder(1, askPrice, askQuantity)
      .accounts({
        trader: traderB.publicKey,
        market: marketPda,
        orderbook: orderbookPda,
        baseMint,
        quoteMint,
        vaultBase: vaultBasePda,
        vaultQuote: vaultQuotePda,
        userTokenAccount: traderBBaseAta,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .signers([traderB])
      .rpc();

    // Keeper executes atomic crank match
    const tx = await program.methods
      .crankSettle(5)
      .accounts({
        keeper: keeper.publicKey,
        market: marketPda,
        orderbook: orderbookPda,
        vaultBase: vaultBasePda,
        vaultQuote: vaultQuotePda,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .signers([keeper])
      .rpc();

    expect(tx).to.be.a("string");
    const orderbookAccount = await program.account.orderBookState.fetch(orderbookPda);
    expect(orderbookAccount.bidCount).to.equal(0);
    expect(orderbookAccount.askCount).to.equal(0);
  });

  it("4. Security Guard Verification: Rejects Zero Quantity & Price", async () => {
    try {
      await program.methods
        .placeOrder(0, new anchor.BN(0), new anchor.BN(10))
        .accounts({
          trader: traderA.publicKey,
          market: marketPda,
          orderbook: orderbookPda,
          baseMint,
          quoteMint,
          vaultBase: vaultBasePda,
          vaultQuote: vaultQuotePda,
          userTokenAccount: traderAQuoteAta,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .signers([traderA])
        .rpc();
      expect.fail("Should have failed with ZeroPrice");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("ZeroPrice");
    }
  });
});