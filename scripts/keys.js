const { Keypair } = require('@solana/web3.js');
const bs58 = require('bs58');

// Generate a new keypair
const keypair = Keypair.generate();

// Use bs58.default.encode (based on your package version)
const privateKey = bs58.default.encode(keypair.secretKey);
const publicKey = keypair.publicKey.toString();

console.log('=== SOLANA PLATFORM WALLET ===');
console.log('');
console.log('🔐 Private Key (KEEP SECRET!):');
console.log(privateKey);
console.log('');
console.log('📍 Public Key (Wallet Address):');
console.log(publicKey);
console.log('');
console.log('⚠️  IMPORTANT SECURITY NOTES:');
console.log('1. Save the private key in your .env file as SOLANA_PLATFORM_PRIVATE_KEY');
console.log('2. NEVER share the private key with anyone');
console.log('3. NEVER commit the private key to version control');
console.log('4. The public key is safe to share - this is your platform wallet address');
console.log('');
console.log('📝 Add this to your .env file:');
console.log(`SOLANA_PLATFORM_PRIVATE_KEY=${privateKey}`);
console.log('SOLANA_RPC_URL=https://api.devnet.solana.com');
console.log('');
console.log('💰 Fund this wallet with some SOL for transaction fees and withdrawals');
console.log('Devnet Faucet: https://faucet.solana.com/');
console.log('Mainnet: You need to buy/transfer SOL to this address');