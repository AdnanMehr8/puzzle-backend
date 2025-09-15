const bitcoin = require('bitcoinjs-lib');
const ecc = require('tiny-secp256k1');
const ECPairFactory = require('ecpair');
const axios = require('axios');
const User = require('../models/User');
const TransactionModel = require('../models/Transaction');

// Initialize bitcoinjs-lib with tiny-secp256k1
bitcoin.initEccLib(ecc);

// Initialize ECPair with secp256k1 implementation
const ECPair = ECPairFactory.ECPairFactory(ecc);

class BitcoinService {
  constructor() {
    this.network = process.env.BITCOIN_NETWORK === 'mainnet' 
      ? bitcoin.networks.bitcoin 
      : bitcoin.networks.testnet;
    
    // Platform wallet for receiving payments
    this.platformWallet = null;
    
    if (process.env.BITCOIN_PLATFORM_PRIVATE_KEY && 
        process.env.BITCOIN_PLATFORM_PRIVATE_KEY !== 'your_bitcoin_platform_wallet_private_key_wif_format') {
      try {
        this.platformWallet = ECPair.fromWIF(process.env.BITCOIN_PLATFORM_PRIVATE_KEY, this.network);
        console.log('Bitcoin platform wallet configured successfully');
      } catch (error) {
        console.error('Invalid Bitcoin platform private key format:', error.message);
        console.warn('Bitcoin platform wallet not configured due to invalid private key');
      }
    } else {
      console.warn('Bitcoin platform wallet not configured - please set BITCOIN_PLATFORM_PRIVATE_KEY environment variable');
    }

    // API endpoints for blockchain data
    this.apiBaseUrl = process.env.BITCOIN_NETWORK === 'mainnet'
      ? 'https://blockstream.info/api'
      : 'https://blockstream.info/testnet/api';
  }

  // Get BTC to USD exchange rate
  async getBtcToUsdRate() {
    try {
      // In production, you'd use a real price API like CoinGecko
      const response = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd');
      return response.data.bitcoin.usd;
    } catch (error) {
      console.error('Error fetching BTC price:', error);
      // Fallback price if API fails
      return 50000; // $50,000 per BTC as fallback
    }
  }

  // Convert USD to BTC
  async usdToBtc(usdAmount) {
    const btcPrice = await this.getBtcToUsdRate();
    return usdAmount / btcPrice;
  }

  // Convert BTC to USD
  async btcToUsd(btcAmount) {
    const btcPrice = await this.getBtcToUsdRate();
    return btcAmount * btcPrice;
  }

  // Convert satoshis to BTC
  satoshisToBtc(satoshis) {
    return satoshis / 100000000; // 1 BTC = 100,000,000 satoshis
  }

  // Convert BTC to satoshis
  btcToSatoshis(btc) {
    return Math.floor(btc * 100000000);
  }

  // Validate Bitcoin address
  validateAddress(address) {
    try {
      bitcoin.address.toOutputScript(address, this.network);
      return true;
    } catch (error) {
      return false;
    }
  }

  // Generate Bitcoin address from public key
  getAddressFromKeyPair(keyPair) {
    const { address } = bitcoin.payments.p2pkh({ 
      pubkey: keyPair.publicKey, 
      network: this.network 
    });
    return address;
  }

  // Get platform wallet address
  getPlatformAddress() {
    if (!this.platformWallet) {
      throw new Error('Platform wallet not configured');
    }
    return this.getAddressFromKeyPair(this.platformWallet);
  }

  // Add Bitcoin wallet to user's payment methods
  async addWallet(userId, walletAddress) {
    try {
      if (!this.validateAddress(walletAddress)) {
        throw new Error('Invalid Bitcoin wallet address');
      }

      const user = await User.findById(userId);
      if (!user) {
        throw new Error('User not found');
      }

      // Check if wallet already exists
      const existingWallet = user.paymentMethods.find(
        method => method.type === 'bitcoin' && method.details.address === walletAddress
      );

      if (existingWallet) {
        throw new Error('Wallet already added');
      }

      // Get wallet balance to verify it exists
      const balance = await this.getAddressBalance(walletAddress);

      const walletData = {
        address: walletAddress,
        balance: this.satoshisToBtc(balance),
        verified: true,
        addedAt: new Date()
      };

      await user.addPaymentMethod('bitcoin', walletData);

      return walletData;

    } catch (error) {
      console.error('Bitcoin add wallet error:', error);
      throw new Error(`Failed to add Bitcoin wallet: ${error.message}`);
    }
  }

  // Remove Bitcoin wallet from user's payment methods
  async removeWallet(userId, walletAddress) {
    try {
      const user = await User.findById(userId);
      if (!user) {
        throw new Error('User not found');
      }

      const methodIndex = user.paymentMethods.findIndex(
        method => method.type === 'bitcoin' && method.details.address === this.getPlatformAddress()
      );

      if (methodIndex === -1) {
        throw new Error('Wallet not found');
      }

      await user.removePaymentMethod(user.paymentMethods[methodIndex].id);

      return true;

    } catch (error) {
      console.error('Bitcoin remove wallet error:', error);
      throw new Error(`Failed to remove Bitcoin wallet: ${error.message}`);
    }
  }

  // Get address balance from blockchain API
  async getAddressBalance(address) {
    try {
      const response = await axios.get(`${this.apiBaseUrl}/address/${address}`);
      return response.data.chain_stats.funded_txo_sum - response.data.chain_stats.spent_txo_sum;
    } catch (error) {
      console.error('Error fetching address balance:', error);
      return 0;
    }
  }

  // Get address UTXOs
  async getAddressUtxos(address) {
    try {
      const response = await axios.get(`${this.apiBaseUrl}/address/${address}/utxo`);
      return response.data;
    } catch (error) {
      console.error('Error fetching UTXOs:', error);
      return [];
    }
  }

  // Create deposit transaction (user sends BTC to platform wallet)
  async createDepositTransaction(userId, usdAmount) {
    try {
      if (!this.platformWallet) {
        throw new Error('Bitcoin platform wallet not configured');
      }

      const user = await User.findById(userId);
      if (!user) {
        throw new Error('User not found');
      }

      // Convert USD to BTC
      const btcAmount = await this.usdToBtc(usdAmount);
      const btcPrice = await this.getBtcToUsdRate();
      const platformAddress = this.getPlatformAddress();

      // Create pending transaction
      const transaction = TransactionModel.createDeposit(
        userId,
        usdAmount,
        {
          type: 'bitcoin',
          details: {
            btcAmount,
            btcPrice,
            platformWallet: platformAddress,
            expectedAmount: btcAmount
          }
        },
        null // No external transaction ID yet
      );

      await transaction.save();

      return {
        transaction,
        depositInfo: {
          platformWallet: platformAddress,
          btcAmount,
          usdAmount,
          btcPrice,
          transactionId: transaction.transactionId,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000) // 1 hour
        }
      };

    } catch (error) {
      console.error('Bitcoin create deposit error:', error);
      throw new Error(`Failed to create deposit transaction: ${error.message}`);
    }
  }

  // Verify and confirm deposit (check if BTC was received)
  async confirmDeposit(transactionId, txHash) {
    try {
      const transaction = await TransactionModel.findOne({
        transactionId,
        type: 'deposit',
        'paymentMethod.type': 'bitcoin'
      });

      if (!transaction) {
        throw new Error('Transaction not found');
      }

      if (transaction.status === 'completed') {
        return { transaction, alreadyProcessed: true };
      }

      // Verify the transaction on Bitcoin blockchain
      const txInfo = await this.getTransaction(txHash);

      if (!txInfo) {
        throw new Error('Transaction not found on blockchain');
      }

      // Verify the transaction details
      const platformAddress = this.getPlatformAddress();
      const expectedAmount = this.btcToSatoshis(transaction.paymentMethod.details.expectedAmount);

      // Check if transaction was to our platform wallet
      let receivedAmount = 0;
      for (const output of txInfo.vout) {
        if (output.scriptpubkey_address === platformAddress) {
          receivedAmount += output.value;
        }
      }

      if (receivedAmount === 0) {
        throw new Error('Transaction not sent to platform wallet');
      }

      // Allow 5% tolerance for amount differences due to price fluctuations
      const tolerance = expectedAmount * 0.05;
      if (Math.abs(receivedAmount - expectedAmount) > tolerance) {
        throw new Error(`Amount mismatch. Expected: ${expectedAmount} satoshis, Received: ${receivedAmount} satoshis`);
      }

      // Update user balance
      const user = await User.findById(transaction.toUserId);
      await user.updateBalance(transaction.amount.usd);

      // Mark transaction as completed
      await transaction.markCompleted(null, txHash);

      return { transaction, user, alreadyProcessed: false };

    } catch (error) {
      console.error('Bitcoin confirm deposit error:', error);
      throw new Error(`Failed to confirm deposit: ${error.message}`);
    }
  }

  // Get transaction details from blockchain API
  async getTransaction(txHash) {
    try {
      const response = await axios.get(`${this.apiBaseUrl}/tx/${txHash}`);
      return response.data;
    } catch (error) {
      console.error('Error fetching transaction:', error);
      return null;
    }
  }

  // Process withdrawal (send BTC from platform wallet to user wallet)
  async processWithdrawal(userId, usdAmount, userWalletAddress) {
    try {
      if (!this.platformWallet) {
        throw new Error('Bitcoin platform wallet not configured');
      }

      const user = await User.findById(userId);
      if (!user) {
        throw new Error('User not found');
      }

      // Check minimum withdrawal
      if (usdAmount < 25) {
        throw new Error('Minimum withdrawal amount is $25');
      }

      // Check user balance (including withdrawal fee)
      const withdrawalFee = 5.00; // Higher fee for Bitcoin due to network fees
      const totalDeduction = usdAmount + withdrawalFee;

      if (user.wallet.balance < totalDeduction) {
        throw new Error(`Insufficient balance. You need $${totalDeduction} (amount: $${usdAmount} + fee: $${withdrawalFee})`);
      }

      // Validate user wallet address
      if (!this.validateAddress(userWalletAddress)) {
        throw new Error('Invalid user wallet address');
      }

      // Convert USD to BTC
      const btcAmount = await this.usdToBtc(usdAmount);
      const btcPrice = await this.getBtcToUsdRate();
      const satoshisAmount = this.btcToSatoshis(btcAmount);

      // Get platform wallet address and UTXOs
      const platformAddress = this.getPlatformAddress();
      const utxos = await this.getAddressUtxos(platformAddress);

      if (utxos.length === 0) {
        throw new Error('No UTXOs available in platform wallet');
      }

      // Calculate total available balance
      const totalBalance = utxos.reduce((sum, utxo) => sum + utxo.value, 0);
      const networkFee = 10000; // 0.0001 BTC network fee (adjust based on network conditions)

      if (totalBalance < satoshisAmount + networkFee) {
        throw new Error('Insufficient platform wallet balance for withdrawal');
      }

      // Create Bitcoin transaction
      const psbt = new bitcoin.Psbt({ network: this.network });

      // Add inputs (UTXOs)
      let inputAmount = 0;
      for (const utxo of utxos) {
        if (inputAmount >= satoshisAmount + networkFee) break;
        
        psbt.addInput({
          hash: utxo.txid,
          index: utxo.vout,
          witnessUtxo: {
            script: bitcoin.address.toOutputScript(platformAddress, this.network),
            value: utxo.value,
          },
        });
        inputAmount += utxo.value;
      }

      // Add output to user wallet
      psbt.addOutput({
        address: userWalletAddress,
        value: satoshisAmount,
      });

      // Add change output if necessary
      const change = inputAmount - satoshisAmount - networkFee;
      if (change > 546) { // Dust threshold
        psbt.addOutput({
          address: platformAddress,
          value: change,
        });
      }

      // Sign transaction
      psbt.signAllInputs(this.platformWallet);
      psbt.finalizeAllInputs();

      // Extract and broadcast transaction
      const tx = psbt.extractTransaction();
      const txHex = tx.toHex();
      const txHash = await this.broadcastTransaction(txHex);

      // Deduct from user balance
      await user.updateBalance(-totalDeduction);

      // Create withdrawal transaction record
      const transaction = TransactionModel.createWithdrawal(
        userId,
        usdAmount,
        {
          type: 'bitcoin',
          details: {
            userWallet: userWalletAddress,
            btcAmount,
            btcPrice,
            txHash,
            networkFee: this.satoshisToBtc(networkFee)
          }
        }
      );

      transaction.status = 'completed';
      transaction.processedAt = new Date();
      transaction.blockchainTxHash = txHash;
      await transaction.save();

      return { transaction, txHash, btcAmount };

    } catch (error) {
      console.error('Bitcoin withdrawal error:', error);
      throw new Error(`Failed to process withdrawal: ${error.message}`);
    }
  }

  // Broadcast transaction to network
  async broadcastTransaction(txHex) {
    try {
      const response = await axios.post(`${this.apiBaseUrl}/tx`, txHex, {
        headers: { 'Content-Type': 'text/plain' }
      });
      return response.data;
    } catch (error) {
      console.error('Error broadcasting transaction:', error);
      throw new Error('Failed to broadcast transaction');
    }
  }

  // Get wallet balance
  async getWalletBalance(walletAddress) {
    try {
      if (!this.validateAddress(walletAddress)) {
        throw new Error('Invalid wallet address');
      }

      const balanceSatoshis = await this.getAddressBalance(walletAddress);
      const btcBalance = this.satoshisToBtc(balanceSatoshis);
      const usdBalance = await this.btcToUsd(btcBalance);

      return {
        btc: btcBalance,
        usd: usdBalance,
        satoshis: balanceSatoshis
      };

    } catch (error) {
      console.error('Bitcoin get balance error:', error);
      throw new Error(`Failed to get wallet balance: ${error.message}`);
    }
  }

  // Monitor platform wallet for incoming transactions
  async monitorDeposits() {
    if (!this.platformWallet) {
      console.warn('Platform wallet not configured, skipping deposit monitoring');
      return;
    }

    try {
      const platformAddress = this.getPlatformAddress();
      
      // Get recent transactions for platform wallet
      const response = await axios.get(`${this.apiBaseUrl}/address/${platformAddress}/txs`);
      const transactions = response.data.slice(0, 10); // Last 10 transactions

      for (const tx of transactions) {
        try {
          await this.processIncomingTransaction(tx);
        } catch (error) {
          console.error('Error processing transaction:', error);
        }
      }

    } catch (error) {
      console.error('Error monitoring deposits:', error);
    }
  }

  // Process incoming transaction
  async processIncomingTransaction(txInfo) {
    try {
      const platformAddress = this.getPlatformAddress();
      
      // Check if this transaction has outputs to our platform wallet
      let receivedAmount = 0;
      for (const output of txInfo.vout) {
        if (output.scriptpubkey_address === platformAddress) {
          receivedAmount += output.value;
        }
      }

      if (receivedAmount === 0) return;

      // Convert to BTC and USD
      const btcAmount = this.satoshisToBtc(receivedAmount);
      const usdAmount = await this.btcToUsd(btcAmount);

      // Look for pending deposit transactions that match this amount
      const pendingTransactions = await TransactionModel.find({
        type: 'deposit',
        'paymentMethod.type': 'bitcoin',
        status: 'pending'
      });

      for (const transaction of pendingTransactions) {
        const expectedAmount = this.btcToSatoshis(transaction.paymentMethod.details.expectedAmount);
        const tolerance = expectedAmount * 0.05; // 5% tolerance

        if (Math.abs(receivedAmount - expectedAmount) <= tolerance) {
          // Found matching transaction
          await this.confirmDeposit(transaction.transactionId, txInfo.txid);
          console.log(`Auto-confirmed Bitcoin deposit: ${transaction.transactionId}`);
          break;
        }
      }

    } catch (error) {
      console.error('Error processing incoming Bitcoin transaction:', error);
    }
  }

  // Get transaction history for a wallet
  async getTransactionHistory(walletAddress, limit = 10) {
    try {
      if (!this.validateAddress(walletAddress)) {
        throw new Error('Invalid wallet address');
      }

      const response = await axios.get(`${this.apiBaseUrl}/address/${walletAddress}/txs`);
      const transactions = response.data.slice(0, limit);

      return transactions.map(tx => ({
        txid: tx.txid,
        blockHeight: tx.status.block_height,
        blockTime: tx.status.block_time,
        fee: tx.fee,
        size: tx.size,
        weight: tx.weight,
        inputs: tx.vin.length,
        outputs: tx.vout.length,
        confirmed: tx.status.confirmed
      }));

    } catch (error) {
      console.error('Bitcoin get transaction history error:', error);
      throw new Error(`Failed to get transaction history: ${error.message}`);
    }
  }

  // Estimate network fee
  async estimateNetworkFee() {
    try {
      const response = await axios.get(`${this.apiBaseUrl}/fee-estimates`);
      const feeRates = response.data;
      
      // Use fee rate for confirmation within 6 blocks (about 1 hour)
      const feeRate = feeRates['6'] || 10; // fallback to 10 sat/vB
      
      // Estimate transaction size (typical P2PKH transaction)
      const estimatedSize = 250; // bytes
      const estimatedFee = feeRate * estimatedSize;
      
      return {
        feeRate,
        estimatedSize,
        estimatedFee,
        estimatedFeeUsd: await this.btcToUsd(this.satoshisToBtc(estimatedFee))
      };

    } catch (error) {
      console.error('Error estimating network fee:', error);
      return {
        feeRate: 10,
        estimatedSize: 250,
        estimatedFee: 2500,
        estimatedFeeUsd: 1.25
      };
    }
  }
}

module.exports = new BitcoinService();
