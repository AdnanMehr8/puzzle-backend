const {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction
} = require('@solana/web3.js');
const bs58 = require('bs58');
const User = require('../models/User');
const TransactionModel = require('../models/Transaction');

class SolanaService {
  constructor() {
    this.connection = new Connection(
      process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
      'confirmed'
    );

    // Platform wallet for receiving payments
    this.platformWallet = null;

    if (process.env.SOLANA_PLATFORM_PRIVATE_KEY &&
      process.env.SOLANA_PLATFORM_PRIVATE_KEY !== 'your_solana_platform_wallet_private_key_base58_encoded') {
      try {
        // this.platformWallet = Keypair.fromSecretKey(bs58.decode(process.env.SOLANA_PLATFORM_PRIVATE_KEY));
        this.platformWallet = Keypair.fromSecretKey(bs58.default.decode(process.env.SOLANA_PLATFORM_PRIVATE_KEY));
        console.log('Solana platform wallet configured successfully');
      } catch (error) {
        console.error('Invalid Solana platform private key format:', error.message);
        console.warn('Solana platform wallet not configured due to invalid private key');
      }
    } else {
      console.warn('Solana platform wallet not configured - please set SOLANA_PLATFORM_PRIVATE_KEY environment variable');
    }
  }

  // Get SOL to USD exchange rate
  async getSolToUsdRate() {
    try {
      // In production, you'd use a real price API like CoinGecko
      const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
      const data = await response.json();
      return data.solana.usd;
    } catch (error) {
      console.error('Error fetching SOL price:', error);
      // Fallback price if API fails
      return 100; // $100 per SOL as fallback
    }
  }

  // Convert USD to SOL
  async usdToSol(usdAmount) {
    const solPrice = await this.getSolToUsdRate();
    return usdAmount / solPrice;
  }

  // Convert SOL to USD
  async solToUsd(solAmount) {
    const solPrice = await this.getSolToUsdRate();
    return solAmount * solPrice;
  }

  // Validate Solana wallet address
  validateWalletAddress(address) {
    try {
      new PublicKey(address);
      return true;
    } catch (error) {
      return false;
    }
  }

  // Add Solana wallet to user's payment methods
  async addWallet(userId, walletAddress) {
    try {
      if (!this.validateWalletAddress(walletAddress)) {
        throw new Error('Invalid Solana wallet address');
      }

      const user = await User.findById(userId);
      if (!user) {
        throw new Error('User not found');
      }

      // Check if wallet already exists
      const existingWallet = user.paymentMethods.find(
        method => method.type === 'solana' && method.details.address === walletAddress
      );

      if (existingWallet) {
        throw new Error('Wallet already added');
      }

      // Get wallet balance to verify it exists
      const publicKey = new PublicKey(walletAddress);
      const balance = await this.connection.getBalance(publicKey);

      const walletData = {
        address: walletAddress,
        balance: balance / LAMPORTS_PER_SOL,
        verified: true,
        addedAt: new Date()
      };

      await user.addPaymentMethod('solana', walletData);

      return walletData;

    } catch (error) {
      console.error('Solana add wallet error:', error);
      throw new Error(`Failed to add Solana wallet: ${error.message}`);
    }
  }

  // Remove Solana wallet from user's payment methods
  async removeWallet(userId, walletAddress) {
    try {
      const user = await User.findById(userId);
      if (!user) {
        throw new Error('User not found');
      }

      const methodIndex = user.paymentMethods.findIndex(
        method => method.type === 'solana' && method.details.address === walletAddress
      );

      if (methodIndex === -1) {
        throw new Error('Wallet not found');
      }

      await user.removePaymentMethod(user.paymentMethods[methodIndex].id);

      return true;

    } catch (error) {
      console.error('Solana remove wallet error:', error);
      throw new Error(`Failed to remove Solana wallet: ${error.message}`);
    }
  }

  // Create deposit transaction (user sends SOL to platform wallet)
  async createDepositTransaction(userId, usdAmount) {
    try {
      if (!this.platformWallet) {
        throw new Error('Solana platform wallet not configured');
      }

      const user = await User.findById(userId);
      if (!user) {
        throw new Error('User not found');
      }

      // Convert USD to SOL
      const solAmount = await this.usdToSol(usdAmount);
      const solPrice = await this.getSolToUsdRate();

      // Create pending transaction
      const transaction = TransactionModel.createDeposit(
        userId,
        usdAmount,
        {
          type: 'solana',
          details: {
            solAmount,
            solPrice,
            platformWallet: this.platformWallet.publicKey.toString(),
            expectedAmount: solAmount
          }
        },
        null // No external transaction ID yet
      );

      await transaction.save();

      return {
        transaction,
        depositInfo: {
          platformWallet: this.platformWallet.publicKey.toString(),
          solAmount,
          usdAmount,
          solPrice,
          transactionId: transaction.transactionId,
          expiresAt: new Date(Date.now() + 30 * 60 * 1000) // 30 minutes
        }
      };

    } catch (error) {
      console.error('Solana create deposit error:', error);
      throw new Error(`Failed to create deposit transaction: ${error.message}`);
    }
  }

  // Verify and confirm deposit (check if SOL was received)
  async confirmDeposit(transactionId, txHash) {
    try {
      const transaction = await TransactionModel.findOne({
        transactionId,
        type: 'deposit',
        'paymentMethod.type': 'solana'
      });

      if (!transaction) {
        throw new Error('Transaction not found');
      }

      if (transaction.status === 'completed') {
        return { transaction, alreadyProcessed: true };
      }

      // Verify the transaction on Solana blockchain
      const txInfo = await this.connection.getTransaction(txHash, {
        commitment: 'confirmed'
      });

      if (!txInfo) {
        throw new Error('Transaction not found on blockchain');
      }

      // Verify the transaction details
      const platformWallet = this.platformWallet.publicKey.toString();
      const expectedAmount = transaction.paymentMethod.details.expectedAmount;

      // Check if transaction was to our platform wallet
      const instruction = txInfo.transaction.message.instructions[0];
      const accounts = txInfo.transaction.message.accountKeys;

      const toAccount = accounts[instruction.accounts[1]].toString();
      const transferAmount = instruction.data ?
        SystemProgram.decodeTransfer(instruction).lamports / LAMPORTS_PER_SOL : 0;

      if (toAccount !== platformWallet) {
        throw new Error('Transaction not sent to platform wallet');
      }

      // Allow 5% tolerance for amount differences due to price fluctuations
      const tolerance = expectedAmount * 0.05;
      if (Math.abs(transferAmount - expectedAmount) > tolerance) {
        throw new Error(`Amount mismatch. Expected: ${expectedAmount} SOL, Received: ${transferAmount} SOL`);
      }

      // Update user balance
      const user = await User.findById(transaction.toUserId);
      await user.updateBalance(transaction.amount.usd);

      // Mark transaction as completed
      await transaction.markCompleted(null, txHash);

      return { transaction, user, alreadyProcessed: false };

    } catch (error) {
      console.error('Solana confirm deposit error:', error);
      throw new Error(`Failed to confirm deposit: ${error.message}`);
    }
  }

  // Process withdrawal (send SOL from platform wallet to user wallet)
  async processWithdrawal(userId, usdAmount, userWalletAddress) {
    try {
      if (!this.platformWallet) {
        throw new Error('Solana platform wallet not configured');
      }

      const user = await User.findById(userId);
      if (!user) {
        throw new Error('User not found');
      }

      // Check minimum withdrawal
      if (usdAmount < 10) {
        throw new Error('Minimum withdrawal amount is $10');
      }

      // Check user balance (including withdrawal fee)
      const withdrawalFee = 2.50;
      const totalDeduction = usdAmount + withdrawalFee;

      if (user.wallet.balance < totalDeduction) {
        throw new Error(`Insufficient balance. You need $${totalDeduction} (amount: $${usdAmount} + fee: $${withdrawalFee})`);
      }

      // Validate user wallet address
      if (!this.validateWalletAddress(userWalletAddress)) {
        throw new Error('Invalid user wallet address');
      }

      // Convert USD to SOL
      const solAmount = await this.usdToSol(usdAmount);
      const solPrice = await this.getSolToUsdRate();

      // Check platform wallet balance
      const platformBalance = await this.connection.getBalance(this.platformWallet.publicKey);
      const platformSolBalance = platformBalance / LAMPORTS_PER_SOL;

      if (platformSolBalance < solAmount + 0.01) { // 0.01 SOL for transaction fees
        throw new Error('Insufficient platform wallet balance for withdrawal');
      }

      // Create withdrawal transaction on blockchain
      const userPublicKey = new PublicKey(userWalletAddress);
      const lamports = Math.floor(solAmount * LAMPORTS_PER_SOL);

      const solanaTransaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: this.platformWallet.publicKey,
          toPubkey: userPublicKey,
          lamports
        })
      );

      // Send transaction
      const txHash = await sendAndConfirmTransaction(
        this.connection,
        solanaTransaction,
        [this.platformWallet],
        { commitment: 'confirmed' }
      );

      // Deduct from user balance
      await user.updateBalance(-totalDeduction);

      // Create withdrawal transaction record
      const transaction = TransactionModel.createWithdrawal(
        userId,
        usdAmount,
        {
          type: 'solana',
          details: {
            userWallet: userWalletAddress,
            solAmount,
            solPrice,
            txHash
          }
        }
      );

      transaction.status = 'completed';
      transaction.processedAt = new Date();
      transaction.blockchainTxHash = txHash;
      await transaction.save();

      return { transaction, txHash, solAmount };

    } catch (error) {
      console.error('Solana withdrawal error:', error);
      throw new Error(`Failed to process withdrawal: ${error.message}`);
    }
  }

  // Get wallet balance
  async getWalletBalance(walletAddress) {
    try {
      if (!this.validateWalletAddress(walletAddress)) {
        throw new Error('Invalid wallet address');
      }

      const publicKey = new PublicKey(walletAddress);
      const balance = await this.connection.getBalance(publicKey);
      const solBalance = balance / LAMPORTS_PER_SOL;
      const usdBalance = await this.solToUsd(solBalance);

      return {
        sol: solBalance,
        usd: usdBalance,
        lamports: balance
      };

    } catch (error) {
      console.error('Solana get balance error:', error);
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
      // Get recent transactions for platform wallet
      const signatures = await this.connection.getSignaturesForAddress(
        this.platformWallet.publicKey,
        { limit: 10 }
      );

      for (const sig of signatures) {
        try {
          const txInfo = await this.connection.getTransaction(sig.signature, {
            commitment: 'confirmed'
          });

          if (txInfo && !sig.err) {
            // Check if this is a deposit transaction we're expecting
            await this.processIncomingTransaction(txInfo, sig.signature);
          }
        } catch (error) {
          console.error('Error processing transaction:', error);
        }
      }

    } catch (error) {
      console.error('Error monitoring deposits:', error);
    }
  }

  // Process incoming transaction
  async processIncomingTransaction(txInfo, txHash) {
    try {
      // Extract transfer details
      const instruction = txInfo.transaction.message.instructions[0];
      const accounts = txInfo.transaction.message.accountKeys;

      if (!instruction || accounts.length < 2) return;

      const fromAccount = accounts[instruction.accounts[0]].toString();
      const toAccount = accounts[instruction.accounts[1]].toString();
      const transferAmount = instruction.data ?
        SystemProgram.decodeTransfer(instruction).lamports / LAMPORTS_PER_SOL : 0;

      // Check if this is to our platform wallet
      if (toAccount !== this.platformWallet.publicKey.toString()) return;

      // Look for pending deposit transactions that match this amount
      const solPrice = await this.getSolToUsdRate();
      const usdAmount = transferAmount * solPrice;

      const pendingTransactions = await TransactionModel.find({
        type: 'deposit',
        'paymentMethod.type': 'solana',
        status: 'pending'
      });

      for (const transaction of pendingTransactions) {
        const expectedAmount = transaction.paymentMethod.details.expectedAmount;
        const tolerance = expectedAmount * 0.05; // 5% tolerance

        if (Math.abs(transferAmount - expectedAmount) <= tolerance) {
          // Found matching transaction
          await this.confirmDeposit(transaction.transactionId, txHash);
          console.log(`Auto-confirmed deposit: ${transaction.transactionId}`);
          break;
        }
      }

    } catch (error) {
      console.error('Error processing incoming transaction:', error);
    }
  }

  // Get transaction history for a wallet
  async getTransactionHistory(walletAddress, limit = 10) {
    try {
      if (!this.validateWalletAddress(walletAddress)) {
        throw new Error('Invalid wallet address');
      }

      const publicKey = new PublicKey(walletAddress);
      const signatures = await this.connection.getSignaturesForAddress(
        publicKey,
        { limit }
      );

      const transactions = [];
      for (const sig of signatures) {
        try {
          const txInfo = await this.connection.getTransaction(sig.signature, {
            commitment: 'confirmed'
          });

          if (txInfo) {
            transactions.push({
              signature: sig.signature,
              blockTime: sig.blockTime,
              slot: sig.slot,
              err: sig.err,
              fee: txInfo.meta.fee,
              preBalances: txInfo.meta.preBalances,
              postBalances: txInfo.meta.postBalances
            });
          }
        } catch (error) {
          console.error('Error fetching transaction details:', error);
        }
      }

      return transactions;

    } catch (error) {
      console.error('Solana get transaction history error:', error);
      throw new Error(`Failed to get transaction history: ${error.message}`);
    }
  }
}

module.exports = new SolanaService();
