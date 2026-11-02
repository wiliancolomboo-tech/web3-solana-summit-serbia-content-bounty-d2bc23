# Configure Solana CLI to Devnet
solana config set --url https://api.devnet.solana.com

# Airdrop SOL for deployment fees
solana airdrop 2

# Deploy
anchor deploy --provider.cluster Devnet