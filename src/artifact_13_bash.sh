# Set cluster configuration to devnet
solana config set --url https://api.devnet.solana.com

# Fund your devnet deployment wallet
solana airdrop 2

# Deploy program binary
anchor deploy --provider.cluster devnet --program-name hydra_vault