const Stripe = require('stripe');
const User = require('../models/User');
const Transaction = require('../models/Transaction');

class StripeService {
  constructor() {
    this.stripe = null;
  }

  // Lazy initialize Stripe client when first needed
  getClient() {
    if (!this.stripe) {
      const key = process.env.STRIPE_SECRET_KEY;
      if (!key) {
        throw new Error('Stripe is not configured. Missing STRIPE_SECRET_KEY');
      }
      this.stripe = Stripe(key);
    }
    return this.stripe;
  }

  // Create payment intent for wallet deposit
  async createPaymentIntent(userId, amount, currency = 'usd') {
    try {
      const user = await User.findById(userId);
      if (!user) {
        throw new Error('User not found');
      }

      // Minimum amount is $1
      if (amount < 1) {
        throw new Error('Minimum deposit amount is $1');
      }

      // Maximum amount is $10,000
      if (amount > 10000) {
        throw new Error('Maximum deposit amount is $10,000');
      }

      const paymentIntent = await this.getClient().paymentIntents.create({
        amount: Math.round(amount * 100), // Convert to cents
        currency: currency.toLowerCase(),
        customer: user.stripeCustomerId || undefined,
        metadata: {
          userId: userId.toString(),
          type: 'wallet_deposit',
          originalAmount: amount.toString()
        },
        automatic_payment_methods: {
          enabled: true,
        },
        description: `Wallet deposit for ${user.profile.firstName} ${user.profile.lastName}`,
      });

      // Create pending transaction
      const transaction = Transaction.createDeposit(
        userId,
        amount,
        {
          type: 'stripe',
          details: {
            paymentIntentId: paymentIntent.id,
            currency: currency
          }
        },
        paymentIntent.id
      );

      await transaction.save();

      return {
        paymentIntent,
        transaction,
        clientSecret: paymentIntent.client_secret
      };

    } catch (error) {
      console.error('Stripe create payment intent error:', error);
      throw new Error(`Failed to create payment intent: ${error.message}`);
    }
  }

  // Confirm payment and update user balance
  async confirmPayment(paymentIntentId) {
    try {
      const paymentIntent = await this.getClient().paymentIntents.retrieve(paymentIntentId);
      
      if (paymentIntent.status !== 'succeeded') {
        throw new Error('Payment not successful');
      }

      const userId = paymentIntent.metadata.userId;
      const amount = parseFloat(paymentIntent.metadata.originalAmount);

      // Find the transaction
      const transaction = await Transaction.findOne({
        externalTransactionId: paymentIntentId,
        type: 'deposit'
      });

      if (!transaction) {
        throw new Error('Transaction not found');
      }

      if (transaction.status === 'completed') {
        return { transaction, alreadyProcessed: true };
      }

      // Update user balance
      const user = await User.findById(userId);
      await user.updateBalance(amount);

      // Mark transaction as completed
      await transaction.markCompleted(paymentIntentId);

      return { transaction, user, alreadyProcessed: false };

    } catch (error) {
      console.error('Stripe confirm payment error:', error);
      throw new Error(`Failed to confirm payment: ${error.message}`);
    }
  }

  // Create customer for user
  async createCustomer(userId) {
    try {
      const user = await User.findById(userId);
      if (!user) {
        throw new Error('User not found');
      }

      if (user.stripeCustomerId) {
        return user.stripeCustomerId;
      }

      const customer = await this.getClient().customers.create({
        email: user.email,
        name: `${user.profile.firstName} ${user.profile.lastName}`,
        metadata: {
          userId: userId.toString()
        }
      });

      // Save customer ID to user
      user.stripeCustomerId = customer.id;
      await user.save();

      return customer.id;

    } catch (error) {
      console.error('Stripe create customer error:', error);
      throw new Error(`Failed to create customer: ${error.message}`);
    }
  }

  // Add payment method to customer
  async addPaymentMethod(userId, paymentMethodId) {
    try {
      const user = await User.findById(userId);
      if (!user) {
        throw new Error('User not found');
      }

      // Ensure customer exists
      const customerId = user.stripeCustomerId || await this.createCustomer(userId);

      // Attach payment method to customer
      await this.getClient().paymentMethods.attach(paymentMethodId, {
        customer: customerId,
      });

      // Get payment method details
      const paymentMethod = await this.getClient().paymentMethods.retrieve(paymentMethodId);

      // Add to user's payment methods
      const paymentMethodData = {
        type: 'stripe',
        details: {
          id: paymentMethod.id,
          type: paymentMethod.type,
          card: paymentMethod.card ? {
            brand: paymentMethod.card.brand,
            last4: paymentMethod.card.last4,
            expMonth: paymentMethod.card.exp_month,
            expYear: paymentMethod.card.exp_year
          } : null
        }
      };

      await user.addPaymentMethod('stripe', paymentMethodData.details);

      return paymentMethodData;

    } catch (error) {
      console.error('Stripe add payment method error:', error);
      throw new Error(`Failed to add payment method: ${error.message}`);
    }
  }

  // Remove payment method
  async removePaymentMethod(userId, paymentMethodId) {
    try {
      const user = await User.findById(userId);
      if (!user) {
        throw new Error('User not found');
      }

      // Detach from Stripe
      await this.getClient().paymentMethods.detach(paymentMethodId);

      // Find and remove from user's payment methods
      const methodIndex = user.paymentMethods.findIndex(
        method => method.type === 'stripe' && method.details.id === paymentMethodId
      );

      if (methodIndex === -1) {
        throw new Error('Payment method not found');
      }

      await user.removePaymentMethod(user.paymentMethods[methodIndex].id);

      return true;

    } catch (error) {
      console.error('Stripe remove payment method error:', error);
      throw new Error(`Failed to remove payment method: ${error.message}`);
    }
  }

  // Process withdrawal to bank account or card
  async processWithdrawal(userId, amount, paymentMethodId) {
    try {
      const user = await User.findById(userId);
      if (!user) {
        throw new Error('User not found');
      }

      // Check minimum withdrawal amount
      if (amount < 10) {
        throw new Error('Minimum withdrawal amount is $10');
      }

      // Check user balance (including withdrawal fee)
      const withdrawalFee = 2.50;
      const totalDeduction = amount + withdrawalFee;

      if (user.wallet.balance < totalDeduction) {
        throw new Error(`Insufficient balance. You need $${totalDeduction} (amount: $${amount} + fee: $${withdrawalFee})`);
      }

      // Create transfer to user's payment method
      // Note: This is a simplified version. In production, you'd need to:
      // 1. Verify the payment method belongs to the user
      // 2. Handle different payment method types (bank account vs card)
      // 3. Implement proper error handling for failed transfers

      const transfer = await this.getClient().transfers.create({
        amount: Math.round(amount * 100), // Convert to cents
        currency: 'usd',
        destination: paymentMethodId, // This would be a connected account ID in practice
        metadata: {
          userId: userId.toString(),
          type: 'withdrawal',
          originalAmount: amount.toString()
        }
      });

      // Deduct from user balance
      await user.updateBalance(-totalDeduction);

      // Create withdrawal transaction
      const transaction = Transaction.createWithdrawal(
        userId,
        amount,
        {
          type: 'stripe',
          details: {
            transferId: transfer.id,
            paymentMethodId
          }
        }
      );

      transaction.status = 'completed';
      transaction.processedAt = new Date();
      transaction.externalTransactionId = transfer.id;
      await transaction.save();

      return { transaction, transfer };

    } catch (error) {
      console.error('Stripe withdrawal error:', error);
      throw new Error(`Failed to process withdrawal: ${error.message}`);
    }
  }

  // Handle webhook events
  async handleWebhook(event) {
    try {
      switch (event.type) {
        case 'payment_intent.succeeded':
          await this.handlePaymentIntentSucceeded(event.data.object);
          break;
        
        case 'payment_intent.payment_failed':
          await this.handlePaymentIntentFailed(event.data.object);
          break;
        
        case 'customer.created':
          console.log('Customer created:', event.data.object.id);
          break;
        
        case 'payment_method.attached':
          console.log('Payment method attached:', event.data.object.id);
          break;
        
        default:
          console.log(`Unhandled event type: ${event.type}`);
      }

      return { received: true };

    } catch (error) {
      console.error('Stripe webhook error:', error);
      throw error;
    }
  }

  // Handle successful payment intent
  async handlePaymentIntentSucceeded(paymentIntent) {
    try {
      const { transaction } = await this.confirmPayment(paymentIntent.id);
      console.log('Payment confirmed via webhook:', transaction.transactionId);
    } catch (error) {
      console.error('Error handling payment intent succeeded:', error);
    }
  }

  // Handle failed payment intent
  async handlePaymentIntentFailed(paymentIntent) {
    try {
      const transaction = await Transaction.findOne({
        externalTransactionId: paymentIntent.id,
        type: 'deposit'
      });

      if (transaction && transaction.status === 'pending') {
        await transaction.markFailed(paymentIntent.last_payment_error?.message || 'Payment failed');
        console.log('Payment marked as failed:', transaction.transactionId);
      }
    } catch (error) {
      console.error('Error handling payment intent failed:', error);
    }
  }

  // Verify webhook signature
  verifyWebhookSignature(payload, signature) {
    try {
      return this.getClient().webhooks.constructEvent(
        payload,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (error) {
      console.error('Webhook signature verification failed:', error);
      throw new Error('Invalid webhook signature');
    }
  }
}

module.exports = new StripeService();
