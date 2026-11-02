# 1. Switch config to Devnet
solana config set --url https://api.devnet.solana.com

# 2. Airdrop devnet SOL
solana airdrop 2

# 3. Deploy Program to Devnet
anchor deploy --provider.cluster devnet

# 4. Execute Mocha End-to-End Suite against Devnet
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com anchor run test