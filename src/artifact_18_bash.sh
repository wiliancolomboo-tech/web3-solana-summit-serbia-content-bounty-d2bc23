# Build the smart contract
anchor build

# Run the complete test suite against localnet
anchor test --skip-local-validator

# Clean up validator process
kill $PID