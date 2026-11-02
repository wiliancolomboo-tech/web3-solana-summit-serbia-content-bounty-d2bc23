# 1. Clone and enter the repository
git clone https://github.com/solana-summit-serbia/summitforge-engine.git
cd summitforge-engine

# 2. Install TypeScript QA dependencies
yarn install

# 3. Synchronize program keys and build the Anchor binary
anchor keys sync
anchor build