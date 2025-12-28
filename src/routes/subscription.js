const express = require('express');
const { body, validationResult } = require('express-validator');
const stripe = require('../config/stripe');
const User = require('../models/User');
const { auth } = require('../middleware/auth');

const router = express.Router();

// Get subscription status
router.get('/status', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);

    let subscription = null;
    if (user.stripeSubscriptionId) {
      try {
        subscription = await stripe.subscriptions.retrieve(user.stripeSubscriptionId);
      } catch (e) {
        console.error('Error fetching subscription:', e);
      }
    }

    res.json({
      isPremium: user.isPremium,
      subscription: subscription ? {
        id: subscription.id,
        status: subscription.status,
        currentPeriodEnd: new Date(subscription.current_period_end * 1000),
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
        plan: subscription.items.data[0]?.price?.id
      } : null,
      features: {
        customStatusSlots: user.isPremium ? 7 : 2,
        customNotificationSlots: user.isPremium ? 7 : 2,
        customStatusUsed: user.customStatuses.length,
        customNotificationUsed: user.customNotifications.length
      }
    });
  } catch (error) {
    console.error('Get subscription status error:', error);
    res.status(500).json({ error: 'Failed to get subscription status' });
  }
});

// Get available plans
router.get('/plans', auth, async (req, res) => {
  try {
    const plans = [
      {
        id: 'monthly',
        priceId: process.env.STRIPE_PRICE_MONTHLY || 'price_monthly',
        name: 'Premium Monthly',
        price: 4.99,
        currency: 'usd',
        interval: 'month',
        features: [
          '5 additional custom statuses',
          '5 additional custom notifications',
          'Priority support',
          'Early access to new features'
        ]
      },
      {
        id: 'yearly',
        priceId: process.env.STRIPE_PRICE_YEARLY || 'price_yearly',
        name: 'Premium Yearly',
        price: 39.99,
        currency: 'usd',
        interval: 'year',
        savings: '33%',
        features: [
          '5 additional custom statuses',
          '5 additional custom notifications',
          'Priority support',
          'Early access to new features'
        ]
      }
    ];

    res.json({ plans });
  } catch (error) {
    console.error('Get plans error:', error);
    res.status(500).json({ error: 'Failed to get plans' });
  }
});

// Create checkout session
router.post('/create-checkout', auth, [
  body('priceId').exists(),
  body('successUrl').optional().isURL(),
  body('cancelUrl').optional().isURL()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { priceId, successUrl, cancelUrl } = req.body;
    const user = await User.findById(req.user._id);

    // Create or retrieve Stripe customer
    let customerId = user.stripeCustomerId;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        phone: user.phone,
        name: user.name,
        metadata: {
          userId: user._id.toString()
        }
      });
      customerId = customer.id;
      user.stripeCustomerId = customerId;
      await user.save();
    }

    // Create checkout session
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [
        {
          price: priceId,
          quantity: 1
        }
      ],
      mode: 'subscription',
      success_url: successUrl || `${process.env.APP_URL || 'https://couple-app.com'}/subscription/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: cancelUrl || `${process.env.APP_URL || 'https://couple-app.com'}/subscription/cancel`,
      metadata: {
        userId: user._id.toString()
      }
    });

    res.json({
      sessionId: session.id,
      url: session.url
    });
  } catch (error) {
    console.error('Create checkout error:', error);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// Create customer portal session (for managing subscription)
router.post('/customer-portal', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);

    if (!user.stripeCustomerId) {
      return res.status(400).json({ error: 'No subscription found' });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: req.body.returnUrl || `${process.env.APP_URL || 'https://couple-app.com'}/settings`
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error('Customer portal error:', error);
    res.status(500).json({ error: 'Failed to create portal session' });
  }
});

// Cancel subscription
router.post('/cancel', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);

    if (!user.stripeSubscriptionId) {
      return res.status(400).json({ error: 'No active subscription' });
    }

    // Cancel at period end (user keeps premium until end of billing period)
    const subscription = await stripe.subscriptions.update(user.stripeSubscriptionId, {
      cancel_at_period_end: true
    });

    res.json({
      message: 'Subscription will be cancelled at the end of the billing period',
      cancelAt: new Date(subscription.current_period_end * 1000)
    });
  } catch (error) {
    console.error('Cancel subscription error:', error);
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
});

// Resume cancelled subscription
router.post('/resume', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);

    if (!user.stripeSubscriptionId) {
      return res.status(400).json({ error: 'No subscription found' });
    }

    const subscription = await stripe.subscriptions.update(user.stripeSubscriptionId, {
      cancel_at_period_end: false
    });

    res.json({
      message: 'Subscription resumed',
      subscription: {
        status: subscription.status,
        currentPeriodEnd: new Date(subscription.current_period_end * 1000)
      }
    });
  } catch (error) {
    console.error('Resume subscription error:', error);
    res.status(500).json({ error: 'Failed to resume subscription' });
  }
});

// Stripe webhook handler
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId = session.metadata?.userId;

        if (userId && session.subscription) {
          await User.findByIdAndUpdate(userId, {
            isPremium: true,
            stripeSubscriptionId: session.subscription
          });
          console.log(`User ${userId} upgraded to premium`);
        }
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        const user = await User.findOne({ stripeSubscriptionId: subscription.id });

        if (user) {
          const isPremium = subscription.status === 'active' || subscription.status === 'trialing';
          await User.findByIdAndUpdate(user._id, { isPremium });
          console.log(`User ${user._id} subscription updated: ${subscription.status}`);
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const user = await User.findOne({ stripeSubscriptionId: subscription.id });

        if (user) {
          await User.findByIdAndUpdate(user._id, {
            isPremium: false,
            stripeSubscriptionId: null
          });
          console.log(`User ${user._id} subscription cancelled`);
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const user = await User.findOne({ stripeCustomerId: invoice.customer });

        if (user) {
          console.log(`Payment failed for user ${user._id}`);
          // Could send notification to user about failed payment
        }
        break;
      }

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    res.json({ received: true });
  } catch (error) {
    console.error('Webhook processing error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

module.exports = router;
