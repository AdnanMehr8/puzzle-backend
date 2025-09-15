const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const logger = require('../utils/logger');

const router = express.Router();

// Stripe webhook endpoint
router.post('/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    logger.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    // Handle the event
    switch (event.type) {
      case 'payment_intent.succeeded':
        await handlePaymentIntentSucceeded(event.data.object);
        break;
      
      case 'payment_intent.payment_failed':
        await handlePaymentIntentFailed(event.data.object);
        break;
      
      case 'charge.dispute.created':
        await handleChargeDispute(event.data.object);
        break;
      
      default:
        logger.info(`Unhandled event type: ${event.type}`);
    }

    res.json({ received: true });
  } catch (error) {
    logger.error('Webhook processing error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// Handle successful payment
async function handlePaymentIntentSucceeded(paymentIntent) {
  try {
    const transaction = await Transaction.findOne({
      'paymentMethod.details.paymentIntentId': paymentIntent.id
    });

    if (!transaction) {
      logger.warn(`No transaction found for payment intent: ${paymentIntent.id}`);
      return;
    }

    if (transaction.status === 'completed') {
      logger.info(`Transaction ${transaction.transactionId} already completed`);
      return;
    }

    // Update user balance
    const user = await User.findById(transaction.toUserId);
    if (user) {
      await user.updateBalance(transaction.amount.usd);
    }

    // Mark transaction as completed
    await transaction.markCompleted(null, paymentIntent.id);

    logger.info(`Payment completed for transaction: ${transaction.transactionId}`);
  } catch (error) {
    logger.error('Error handling payment success:', error);
  }
}

// Handle failed payment
async function handlePaymentIntentFailed(paymentIntent) {
  try {
    const transaction = await Transaction.findOne({
      'paymentMethod.details.paymentIntentId': paymentIntent.id
    });

    if (!transaction) {
      logger.warn(`No transaction found for failed payment intent: ${paymentIntent.id}`);
      return;
    }

    // Mark transaction as failed
    transaction.status = 'failed';
    transaction.failureReason = paymentIntent.last_payment_error?.message || 'Payment failed';
    await transaction.save();

    logger.info(`Payment failed for transaction: ${transaction.transactionId}`);
  } catch (error) {
    logger.error('Error handling payment failure:', error);
  }
}

// Handle charge dispute
async function handleChargeDispute(dispute) {
  try {
    const transaction = await Transaction.findOne({
      blockchainTxHash: dispute.charge
    });

    if (transaction) {
      // Mark transaction as disputed
      transaction.status = 'disputed';
      transaction.disputeId = dispute.id;
      await transaction.save();

      logger.warn(`Dispute created for transaction: ${transaction.transactionId}`);
    }
  } catch (error) {
    logger.error('Error handling charge dispute:', error);
  }
}

module.exports = router;
