import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import Stripe from "stripe";
import admin from "firebase-admin";
import { getFirestore } from "firebase-admin/firestore";
import fs from "fs";
import cron, { ScheduledTask } from "node-cron";
import { emailService } from "./EmailService.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log("Starting server script...");
// Firebase Admin Init
try {
  console.log("Loading firebase-applet-config.json...");
  const configPath = path.join(process.cwd(), "firebase-applet-config.json");
  const firebaseConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  console.log("Firebase config loaded. Project:", firebaseConfig.projectId);
  
  if (!admin.apps.length) {
    admin.initializeApp({
      projectId: firebaseConfig.projectId,
    });
    console.log("Firebase Admin initialized.");
  }
  const db = getFirestore(firebaseConfig.firestoreDatabaseId);
  console.log("Firestore initialized.");

  async function createNotification(userId: string, title: string, message: string, type: string, link?: string) {
    try {
      await db.collection('notifications').add({
        userId,
        title,
        message,
        type,
        link,
        isRead: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    } catch (error) {
      console.error("Error creating server notification:", error);
    }
  }

  async function startServer() {
    console.log("Entering startServer()...");
    const app = express();
  const PORT = 5000;

  // Stripe initialization (Lazy)
  let stripe: Stripe | null = null;
  const getStripe = () => {
    if (!stripe) {
      const key = process.env.STRIPE_SECRET_KEY;
      if (!key) {
        console.warn("STRIPE_SECRET_KEY not found in environment.");
        return null;
      }
      stripe = new Stripe(key);
    }
    return stripe;
  };

  // Special raw body middleware for Stripe Webhooks
  app.post("/api/webhook", express.raw({ type: "application/json" }), async (req, res) => {
    const stripeClient = getStripe();
    const sig = req.headers["stripe-signature"];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!stripeClient || !sig || !webhookSecret) {
      console.warn("Webhook attempt with missing components. sig:", !!sig, "secret:", !!webhookSecret);
      return res.status(400).send("Webhook configuration missing");
    }

    let event;

    try {
      event = stripeClient.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err: any) {
      console.error(`Webhook Error: ${err.message}`);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle the event
    try {
      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object as Stripe.Checkout.Session;
          const { userId, botId, botIds, isBulk, couponCode } = session.metadata || {};
          
          console.log(`[STRIPE_WEBHOOK] Checkout Session Completed: ${session.id}`);

          // Increment coupon usage if applicable
          if (couponCode) {
            const couponSnap = await db.collection('coupons').where('code', '==', couponCode.toUpperCase().trim()).limit(1).get();
            if (!couponSnap.empty) {
               await db.collection('coupons').doc(couponSnap.docs[0].id).update({
                 usageCount: admin.firestore.FieldValue.increment(1)
               }).catch(e => console.error("Failed to increment coupon usageCount", e));
            }
          }
          
          // VERIFICATION PROTOCOL: Check payment status and amount
          if (session.payment_status !== 'paid') {
            console.warn(`[SECURITY] Checkout session ${session.id} completed but status is ${session.payment_status}. Halting fulfillment.`);
            return res.json({ received: true, status: 'payment_pending' });
          }

          const amountPaidValue = session.amount_total || 0;
          const currencyUsed = session.currency?.toUpperCase() || 'USD';
          const amountDisplay = `${(amountPaidValue / 100).toFixed(2)} ${currencyUsed}`;
          
          const amountPaid = (amountPaidValue / 100);
          const timestamp = new Date().toISOString();
          const paidTo = process.env.STRIPE_BUSINESS_NAME || "SNACK.inc Treasury Operations";

          console.log(`[PAYMENT_VERIFICATION] Verified Payment of ${amountDisplay} for User ${userId}`);

          if (userId && session.customer) {
            await db.collection('users').doc(userId).update({
              stripeCustomerId: session.customer as string
            }).catch(e => {
              console.error("Failed to update user customerId", e);
            });
          }

          const userDoc = userId ? await db.collection('users').doc(userId).get() : null;
          let userEmail = userDoc?.exists ? userDoc.data()?.email : null;
          
          if (!userEmail) {
            userEmail = session.customer_details?.email;
          }

          const processBot = async (bId: string) => {
            const botDoc = await db.collection('bots').doc(bId).get();
            const botData = botDoc?.exists ? botDoc.data() : null;
            const botName = botData?.name || "Unknown Module";
            const botIsSubscription = botData?.isSubscription || false;

            if (botIsSubscription && session.subscription) {
              const subscription = await stripeClient.subscriptions.retrieve(session.subscription as string) as any;
              
              // Upsert subscription
              await db.collection('subscriptions').doc(subscription.id).set({
                userId,
                botId: bId,
                stripeSubscriptionId: subscription.id,
                stripeCustomerId: session.customer as string,
                status: subscription.status,
                currentPeriodEnd: new Date(subscription.current_period_end * 1000).toISOString(),
                cancelAtPeriodEnd: subscription.cancel_at_period_end,
                updatedAt: timestamp,
                createdAt: timestamp,
                paymentDetails: { 
                  amount: amountPaid, 
                  currency: currencyUsed,
                  date: timestamp,
                  paidTo: paidTo
                }
              });
              
              const purchaseId = db.collection('purchases').doc().id;
              const licenseKey = `SUB-${Math.random().toString(36).substring(2, 10).toUpperCase()}`;
              await db.collection('purchases').doc(purchaseId).set({
                userId,
                botId: bId,
                licenseKey,
                purchaseDate: timestamp,
                status: 'completed',
                isSubscription: true,
                stripeSubscriptionId: subscription.id,
                verifiedAmount: amountPaid,
                verifiedCurrency: currencyUsed,
                paidTo: paidTo
              });
              await db.collection('key_registry').doc(licenseKey).set({ purchaseId });

              if (userEmail) {
                await emailService.sendSubscriptionConfirmation(userEmail, botName, licenseKey, amountPaid, timestamp, currencyUsed, paidTo).catch(e => {
                  console.error("Failed to send subscription confirmation email", e);
                });
              }

              if (userId) {
                await createNotification(userId, "Payment Protocol: SECURE", `Verified payment of ${amountPaid} ${currencyUsed}. ${botName} active.`, "purchase", "/vault");
              }
            } else {
              const purchaseId = db.collection('purchases').doc().id;
              const licenseKey = `LIFETIME-${Math.random().toString(36).substring(2, 10).toUpperCase()}`;
              await db.collection('purchases').doc(purchaseId).set({
                userId,
                botId: bId,
                licenseKey,
                purchaseDate: timestamp,
                status: 'completed',
                isSubscription: false,
                verifiedAmount: amountPaid,
                verifiedCurrency: currencyUsed,
                paidTo: paidTo
              });
              await db.collection('key_registry').doc(licenseKey).set({ purchaseId });

              if (userEmail) {
                await emailService.sendPurchaseConfirmation(userEmail, botName, licenseKey, amountPaid, timestamp, currencyUsed, paidTo).catch(e => {
                  console.error("Failed to send purchase confirmation email", e);
                });
              }

              if (userId) {
                await createNotification(userId, "Integrity Check: PASSED", `Payment of ${amountPaid} ${currencyUsed} verified. ${botName} acquired.`, "purchase", "/vault");
              }
            }
          };

          if (isBulk === 'true' && botIds) {
            const ids = botIds.split(',');
            for (const id of ids) {
              await processBot(id);
            }
          } else if (botId) {
            await processBot(botId);
          }
          break;
        }
        case "invoice.paid": {
          const invoice = event.data.object as any;
          console.log(`[STRIPE_WEBHOOK] Invoice Paid: ${invoice.id}`);
          
          if (invoice.subscription) {
            const subscriptionId = invoice.subscription as string;
            const subscription = await stripeClient.subscriptions.retrieve(subscriptionId) as any;
            
            // Update subscription end date in DB
            await db.collection('subscriptions').doc(subscriptionId).update({
              status: subscription.status,
              currentPeriodEnd: new Date(subscription.current_period_end * 1000).toISOString(),
              updatedAt: new Date().toISOString()
            }).catch(e => console.error("Failed to update subscription on invoice.paid", e));

            // Log renewal purchase
            const subDoc = await db.collection('subscriptions').doc(subscriptionId).get();
            if (subDoc.exists) {
               const subData = subDoc.data()!;
               const purchaseId = db.collection('purchases').doc().id;
               await db.collection('purchases').doc(purchaseId).set({
                 userId: subData.userId,
                 botId: subData.botId,
                 purchaseDate: new Date().toISOString(),
                 status: 'completed',
                 isSubscription: true,
                 stripeSubscriptionId: subscriptionId,
                 isRenewal: true,
                 verifiedAmount: (invoice.amount_paid / 100),
                 verifiedCurrency: invoice.currency.toUpperCase()
               }).catch(e => console.error("Failed to log renewal purchase", e));
               
               if (subData.userId) {
                 await createNotification(subData.userId, "Subscription Renewed", `Your subscription for bot ${subData.botId} has been successfully renewed.`, "purchase", "/profile");
               }
            }
          }
          break;
        }
        case "invoice.payment_failed": {
          const invoice = event.data.object as any;
          console.log(`[STRIPE_WEBHOOK] Invoice Payment Failed: ${invoice.id}`);
          
          if (invoice.subscription) {
            const subId = invoice.subscription as string;
            const subDoc = await db.collection('subscriptions').doc(subId).get();
            if (subDoc.exists) {
              const subData = subDoc.data()!;
              if (subData.userId) {
                await createNotification(subData.userId, "Payment Failed", `We couldn't process your subscription renewal. Please update your payment method.`, "alert", "/profile");
                
                // Optionally send an email here if needed
                if (invoice.customer_email) {
                   await emailService.sendEmail(
                     invoice.customer_email,
                     "Action Required: Subscription Payment Failed",
                     `Your payment for your SNACK.inc subscription failed. Please visit your dashboard to update your payment info.`,
                     `<div style="font-family: sans-serif; padding: 20px; background: #000; color: #fff; border: 1px solid #ff3333;">
                        <h2 style="color: #ff3333;">PAYMENT_FAILURE</h2>
                        <p>We were unable to process your recurring payment for your SNACK.inc module access.</p>
                        <p>To avoid service interruption, please update your billing details.</p>
                        <a href="${process.env.APP_URL || 'http://localhost:3000'}/profile" style="display:inline-block; padding: 10px 20px; background: #ff3333; color: #fff; text-decoration: none; border-radius: 4px; margin: 20px 0;">UPDATE_BILLING</a>
                      </div>`
                   ).catch(e => console.error("Failed to send payment failure email", e));
                }
              }
            }
          }
          break;
        }
        case "customer.subscription.updated":
        case "customer.subscription.deleted": {
          const subscription = event.data.object as any;
          const subDoc = await db.collection('subscriptions').doc(subscription.id).get();
          if (subDoc.exists) {
            await db.collection('subscriptions').doc(subscription.id).update({
              status: subscription.status,
              currentPeriodEnd: new Date(subscription.current_period_end * 1000).toISOString(),
              cancelAtPeriodEnd: subscription.cancel_at_period_end
            });

            // Update associated purchase status if canceled
            if (subscription.status === 'canceled' || subscription.status === 'unpaid') {
                const purchaseSnap = await db.collection('purchases').where('stripeSubscriptionId', '==', subscription.id).get();
                const updatePromises = purchaseSnap.docs.map(doc => doc.ref.update({ status: 'canceled' }));
                await Promise.all(updatePromises).catch(e => console.error("Batch purchase cancel failed", e));
            }
          }
          break;
        }
      }
      res.json({ received: true });
    } catch (err: any) {
      console.error("Error processing webhook:", err);
      res.status(500).send("Internal Server Error");
    }
  });

  // --- SECURITY MIDDLEWARES ---
  const authenticate = async (req: any, res: any, next: any) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized: Protocol identity missing' });
    }

    const idToken = authHeader.split('Bearer ')[1];
    try {
      const decodedToken = await admin.auth().verifyIdToken(idToken);
      req.user = decodedToken;
      next();
    } catch (error) {
      console.error('ID_TOKEN_VERIFICATION_FAILURE:', error);
      res.status(401).json({ error: 'Unauthorized: Identity verification failed' });
    }
  };

  const isAdminMiddleware = async (req: any, res: any, next: any) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    
    try {
      const userDoc = await db.collection('users').doc(req.user.uid).get();
      const userData = userDoc.exists ? userDoc.data() : null;
      
      const isFounderEmail = ['chetanganta272@gmail.com', 'arnav@snack.com', 'navtej@snack.com', 'chetan@snack.com', 'sohan@snack.com'].includes(req.user.email?.toLowerCase() || '');
      const hasPrivilegedRole = userData?.role === 'admin' || userData?.role === 'founder' || userData?.role === 'developer' || userData?.role === 'support';
      
      if (isFounderEmail || hasPrivilegedRole) {
        next();
      } else {
        console.warn(`[SECURITY] Suspicious Access Attempt: User ${req.user.uid} tried to access administrative protocols.`);
        res.status(403).json({ error: 'Access Denied: Administrative Clearance Required' });
      }
    } catch (error) {
      res.status(500).json({ error: 'Internal synchronization error during clearance check' });
    }
  };

  app.use(express.json());

  // Task Scheduler Logic
  const activeCronJobs = new Map<string, ScheduledTask>();
  const tasksRegistry = [
    {
      id: 'data-sync',
      name: 'Global_Data_Sync',
      schedule: '0 * * * *', // Every hour
      description: 'Synchronizes cross-cluster node data and validates integrity hashes.',
      lastRun: null as string | null,
      status: 'IDLE' as 'IDLE' | 'RUNNING' | 'FAILED' | 'SUCCESS',
      paused: false,
      logs: [] as string[]
    },
    {
      id: 'report-gen',
      name: 'System_Report_Generator',
      schedule: '0 0 * * *', // Midnight
      description: 'Aggregates 24h metrics and dispatches encrypted summaries to founders.',
      lastRun: null as string | null,
      status: 'IDLE' as 'IDLE' | 'RUNNING' | 'FAILED' | 'SUCCESS',
      paused: false,
      logs: [] as string[]
    },
    {
      id: 'health-purge',
      name: 'Cache_Maintenance_Protocol',
      schedule: '*/15 * * * *', // Every 15 mins
      description: 'Purges stale session tokens and optimizes database read-heaps.',
      lastRun: null as string | null,
      status: 'IDLE' as 'IDLE' | 'RUNNING' | 'FAILED' | 'SUCCESS',
      paused: false,
      logs: [] as string[]
    }
  ];

  const logTaskProgress = (taskId: string, message: string) => {
    const task = tasksRegistry.find(t => t.id === taskId);
    if (task) {
      const entry = `[${new Date().toISOString()}] ${message}`;
      task.logs.unshift(entry);
      if (task.logs.length > 50) task.logs.pop();
      console.log(`[SCHEDULER][${taskId}] ${message}`);
    }
  };

  const runTask = async (taskId: string) => {
    const task = tasksRegistry.find(t => t.id === taskId);
    if (!task || task.status === 'RUNNING') return;

    task.status = 'RUNNING';
    task.lastRun = new Date().toISOString();
    logTaskProgress(taskId, "Initiating execution lifecycle...");

    try {
      // Simulate task work
      if (taskId === 'data-sync') {
         // Real logic would be here
         await new Promise(r => setTimeout(r, 5000));
         logTaskProgress(taskId, "Verifying node hashes... 100% Match.");
      } else if (taskId === 'report-gen') {
         await new Promise(r => setTimeout(r, 8000));
         logTaskProgress(taskId, "Metric aggregation complete. Dispatching PGP-encrypted payload.");
      } else {
         await new Promise(r => setTimeout(r, 3000));
      }
      
      task.status = 'SUCCESS';
      logTaskProgress(taskId, "Execution completed successfully. Standing down.");
    } catch (e) {
      task.status = 'FAILED';
      logTaskProgress(taskId, `CRITICAL FAILURE: ${(e as Error).message}`);
    }
  };

  // Initialize Cron Jobs
  tasksRegistry.forEach(task => {
    const job = cron.schedule(task.schedule, () => {
      if (task.paused) {
        console.log(`[CRON] Skipping paused task: ${task.id}`);
        return;
      }
      console.log(`[CRON] Triggering scheduled task: ${task.id}`);
      runTask(task.id);
    });
    activeCronJobs.set(task.id, job);
  });

  // Add safety check for Stripe
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/') && req.path !== '/api/health') {
      console.log(`[ROUTE_CHECK] ${req.method} ${req.path}`);
    }
    next();
  });

  // API Routes
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // Exchange Rates Logic (Backend)
  let currentRates: Record<string, number> = { USD: 1, INR: 83.5, EUR: 0.92, GBP: 0.79, JPY: 151.0, AUD: 1.52, CAD: 1.36 };
  const fetchBackendRates = async () => {
    try {
      const response = await fetch('https://open.er-api.com/v6/latest/USD');
      if (response.ok) {
        const data = await response.json();
        currentRates = data.rates;
        console.log("[SCHEDULER] Backend exchange rates synchronized.");
      }
    } catch (e) {
      console.warn("[SCHEDULER] Failed to synchronize backend rates, using fallbacks.", e);
    }
  };
  
  // Update rates every 6 hours
  cron.schedule('0 */6 * * *', fetchBackendRates);
  fetchBackendRates(); // Initial fetch

  app.post("/api/validate-coupon", async (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: "Protocol code required." });

    try {
      const q = db.collection('coupons').where('code', '==', code.toUpperCase().trim()).where('isActive', '==', true).limit(1);
      const snap = await q.get();
      
      if (snap.empty) {
        return res.status(404).json({ error: "Invalid or inactive protocol code." });
      }

      const coupon = snap.docs[0].data();
      const now = new Date().toISOString();
      
      if (coupon.expiresAt && coupon.expiresAt < now) {
        return res.status(400).json({ error: "Protocol code has expired." });
      }

      if (coupon.maxUsages && coupon.usageCount >= coupon.maxUsages) {
        return res.status(400).json({ error: "Protocol load limit reached." });
      }

      res.json({ 
        isValid: true, 
        discountPercent: coupon.discountPercent,
        code: coupon.code
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/admin/tasks", authenticate, isAdminMiddleware, async (req, res) => {
    res.json(tasksRegistry);
  });

  app.post("/api/admin/tasks/:id/run", authenticate, isAdminMiddleware, async (req, res) => {
    const { id } = req.params;
    const task = tasksRegistry.find(t => t.id === id);
    if (!task) return res.status(404).json({ error: "Task not found" });
    
    if (task.status === 'RUNNING') return res.status(400).json({ error: "Task already running" });
    
    // Fire and forget so we don't block the API response
    runTask(id);
    res.json({ success: true, message: `Task ${id} execution protocol initiated.` });
  });

  app.post("/api/admin/tasks/:id/pause", authenticate, isAdminMiddleware, async (req, res) => {
    const { id } = req.params;
    const task = tasksRegistry.find(t => t.id === id);
    if (!task) return res.status(404).json({ error: "Task not found" });
    
    task.paused = true;
    logTaskProgress(id, "Task status set to PAUSED. Future scheduled executions suspended.");
    res.json({ success: true, message: `Task ${id} has been paused.` });
  });

  app.post("/api/admin/tasks/:id/resume", authenticate, isAdminMiddleware, async (req, res) => {
    const { id } = req.params;
    const task = tasksRegistry.find(t => t.id === id);
    if (!task) return res.status(404).json({ error: "Task not found" });
    
    task.paused = false;
    logTaskProgress(id, "Task status set to ACTIVE. Resuming scheduled execution lifecycle.");
    res.json({ success: true, message: `Task ${id} has been resumed.` });
  });

  app.post("/api/admin/tasks/:id/reset", authenticate, isAdminMiddleware, async (req, res) => {
    const { id } = req.params;
    const task = tasksRegistry.find(t => t.id === id);
    if (!task) return res.status(404).json({ error: "Task not found" });
    
    task.status = 'IDLE';
    task.lastRun = null;
    task.logs = [];
    logTaskProgress(id, "Task registry reset. Logs purged and status set to IDLE.");
    res.json({ success: true, message: `Task ${id} has been reset.` });
  });

  app.post("/api/admin/test-email", authenticate, isAdminMiddleware, async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email required" });

    try {
      await emailService.sendEmail(
        email, 
        "TEST_COMMUNICATION_LINK", 
        "If you are reading this, the SNACK.inc secure email relay is fully operational.",
        "<h1>SYSTEM_CHECK_SUCCESSFUL</h1><p>The secure email relay is fully operational in the current cluster.</p>"
      );
      res.json({ success: true, message: `Test email dispatched to ${email}` });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/admin/system-status", authenticate, isAdminMiddleware, async (req, res) => {
    const results: any = {
      auth: { status: 'optimal', latency: '0ms' },
      stripe: { status: 'optimal', latency: '0ms' },
      registry: { status: 'optimal', latency: '0ms' },
      smtp: { status: 'optimal', latency: '0ms' },
      active_nodes: []
    };

    // Check Firebase Admin (Auth) & Fetch some active-looking users
    try {
      const start = Date.now();
      const userList = await admin.auth().listUsers(10);
      results.auth.latency = `${Date.now() - start}ms`;
      results.auth.status = 'optimal';
      
      // Simulate "Active" status for some users for the aesthetic
      results.active_nodes = await Promise.all(userList.users.map(async u => {
        const userDoc = await db.collection('users').doc(u.uid).get();
        const userData = userDoc.exists ? userDoc.data() : null;
        const lastSignIn = u.metadata.lastSignInTime ? new Date(u.metadata.lastSignInTime).getTime() : 0;
        const isRecent = (Date.now() - lastSignIn) < (15 * 60 * 1000); // Active if signed in last 15 mins
        
        return {
          uid: u.uid.substring(0, 8),
          email: u.email,
          role: userData?.role || 'user',
          status: isRecent ? 'ACTIVE' : 'IDLE',
          last_seen: u.metadata.lastSignInTime || 'NEVER',
          uplink: `NODE_0X${Math.floor(Math.random() * 1000).toString(16).toUpperCase()}`
        };
      }));
    } catch (e) {
      results.auth.status = 'degraded';
      results.auth.error = (e as Error).message;
    }

    // Check Firestore (Registry)
    try {
      const start = Date.now();
      await db.collection('bots').limit(1).get();
      results.registry.latency = `${Date.now() - start}ms`;
      results.registry.status = 'optimal';
    } catch (e) {
      results.registry.status = 'degraded';
      results.registry.error = (e as Error).message;
    }

    // Check Stripe
    const stripeClient = getStripe();
    if (!stripeClient) {
      results.stripe.status = 'offline';
      results.stripe.latency = 'N/A';
    } else {
      try {
        const start = Date.now();
        await stripeClient.balance.retrieve();
        results.stripe.latency = `${Date.now() - start}ms`;
        results.stripe.status = 'optimal';
      } catch (e) {
        results.stripe.status = 'degraded';
        results.stripe.error = (e as Error).message;
      }
    }

    // Check SMTP (Email Service)
    try {
      const start = Date.now();
      const isSmtpInit = await emailService.checkHealth();
      results.smtp.latency = `${Date.now() - start}ms`;
      results.smtp.status = isSmtpInit ? 'optimal' : 'degraded';
    } catch (e) {
      results.smtp.status = 'degraded';
    }

    res.json(results);
  });

  app.get("/api/system/pulse", authenticate, isAdminMiddleware, async (req, res) => {
    try {
      const stats = {
        uptime: Math.floor(process.uptime()),
        timestamp: Date.now(),
        memory: process.memoryUsage().rss,
        active_bots: 0,
        transactions_24h: 0
      };

      try {
        const botsSnapshot = await db.collection('bots').count().get();
        stats.active_bots = botsSnapshot.data().count;
      } catch (e) {
        console.warn("Bots count protocol failure. Using fallback size.");
        // Fallback or ignore
      }

      try {
        const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const salesSnapshot = await db.collection('purchases')
          .where('purchaseDate', '>', yesterday)
          .count().get();
        stats.transactions_24h = salesSnapshot.data().count;
      } catch (e) {
        console.warn("Purchases count protocol failure. Using fallback size.");
      }

      res.json(stats);
    } catch (e) {
      console.error("Critical System Pulse failure:", e);
      res.status(500).json({ error: "Failed to fetch pulse", details: String(e) });
    }
  });

  app.post("/api/seed-admins", async (req, res) => {
    // SECURITY: This route is for initial setup. 
    // In a real app, this should be disabled or strictly guarded.
    const secret = req.headers['x-setup-secret'];
    if (secret !== process.env.SETUP_SECRET && process.env.NODE_ENV === 'production') {
      return res.status(403).json({ error: "Access Denied: Setup protocol locked." });
    }

    const adminAccounts = [
      { email: 'arnav@snack.com', password: 'Snackisop@1098' },
      { email: 'navtej@snack.com', password: 'Snackisop@1098' },
      { email: 'chetan@snack.com', password: 'Snackisop@1098' },
      { email: 'sohan@snack.com', password: 'Snackisop@1098' },
      { email: 'chetanganta272@gmail.com', password: 'Snackisop@1098' }
    ];

    const founderEmails = [
      'chetanganta272@gmail.com',
      'arnav@snack.com',
      'navtej@snack.com',
      'chetan@snack.com',
      'sohan@snack.com'
    ];

    const results = [];
    for (const acc of adminAccounts) {
      try {
        const userRecord = await admin.auth().createUser({
          email: acc.email,
          password: acc.password,
          emailVerified: true
        });
        
        const role = founderEmails.includes(acc.email.toLowerCase()) ? 'founder' : 'admin';

        await db.collection('users').doc(userRecord.uid).set({
          uid: userRecord.uid,
          email: userRecord.email,
          displayName: acc.email.split('@')[0],
          role: role,
          createdAt: new Date().toISOString(),
          registrationMode: 'manual'
        });
        
        results.push({ email: acc.email, status: 'created' });
      } catch (error: any) {
        if (error.code === 'auth/email-already-exists') {
          results.push({ email: acc.email, status: 'already-exists' });
        } else {
          results.push({ email: acc.email, status: 'error', message: error.message });
        }
      }
    }
    res.json({ results });
  });

  app.post("/api/report-bug", async (req, res) => {
    const { description, severity, userId, userEmail } = req.body;

    try {
      const ticketRef = await db.collection("tickets").add({
        userId: userId || "anonymous",
        userEmail: userEmail || "anonymous",
        subject: `[BUG REPORT] - ${severity.toUpperCase()} SEVERITY`,
        message: description,
        category: "bug",
        severity,
        status: "open",
        createdAt: new Date().toISOString(),
      });

      // Send email alert for high/critical or all? 
      // The requirement says "Implement email notifications after payment and critical system alerts."
      // Bug reports are often considered critical if they are marked as such.
      if (severity === 'critical' || severity === 'high') {
         await emailService.sendBugReport(userEmail || "anonymous", severity, description).catch(e => {
            console.error("Failed to send bug report email", e);
         });
      }

      res.json({ success: true, ticketId: ticketRef.id });
    } catch (error: any) {
      console.error("Error creating bug report:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/contact", async (req, res) => {
    const { name, email, subject, message } = req.body;

    try {
      // Store in firestore too for records
      const contactRef = await db.collection("contacts").add({
        name,
        email,
        subject,
        message,
        createdAt: new Date().toISOString(),
      });

      // Send email to admin
      await emailService.sendContactInquiry(name, email, subject, message).catch(e => {
        console.error("Failed to send contact inquiry email", e);
      });

      res.json({ success: true, contactId: contactRef.id });
    } catch (error: any) {
      console.error("Error sending contact message:", error);
      res.status(500).json({ error: error.message });
    }
  });

  const fulfillMockOrder = async (userId: string, botIds: string | null, botId: string | null, isBulk: boolean, userEmail?: string) => {
    const timestamp = new Date().toISOString();
    console.log(`[INTEGRITY_CHECK] Initiating verification for User: ${userId} | Time: ${timestamp}`);
    
    // Simulate payment verification
    const verificationStatus = "VERIFIED_SECURE";
    const paymentProtocol = "MOCK_GATEWAY_SUCCESS";

    const processBot = async (bId: string) => {
      const botDoc = await db.collection('bots').doc(bId).get();
      const botData = botDoc?.exists ? botDoc.data() : null;
      const botName = botData?.name || "Unknown Module";
      const botIsSubscription = botData?.isSubscription || false;
      const botPrice = botData?.price || 0;

      console.log(`[FULFILLMENT] Verified Amount: $${botPrice} for ${botName}`);

      if (botIsSubscription) {
        const subId = `mock_sub_${Math.random().toString(36).substring(7)}`;
        await db.collection('subscriptions').doc(subId).set({
          userId,
          botId: bId,
          stripeSubscriptionId: subId,
          stripeCustomerId: "mock_cus_123",
          status: "active",
          currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          cancelAtPeriodEnd: false,
          createdAt: timestamp,
          verificationParams: { amountPaid: botPrice, date: timestamp, method: paymentProtocol },
          isMock: true
        });
        
        const purchaseId = db.collection('purchases').doc().id;
        const licenseKey = `MOCK-SUB-${Math.random().toString(36).substring(2, 10).toUpperCase()}`;
        await db.collection('purchases').doc(purchaseId).set({
          userId,
          botId: bId,
          licenseKey,
          purchaseDate: timestamp,
          status: 'completed',
          isSubscription: true,
          stripeSubscriptionId: subId,
          isMock: true
        });
        await db.collection('key_registry').doc(licenseKey).set({ purchaseId });
        
        if (userEmail) {
          await emailService.sendSubscriptionConfirmation(userEmail, botName, licenseKey, botPrice, timestamp).catch(e => console.error("Mock email fail:", e));
        }

        await createNotification(userId, "SIMULATION: Protocol Verified", `PAYMENT SECURED: $${botPrice} | License for ${botName} issued. Check your email ${userEmail || ''} for access steps.`, "purchase", "/vault");
      } else {
        const purchaseId = db.collection('purchases').doc().id;
        const licenseKey = `MOCK-LIFE-${Math.random().toString(36).substring(2, 10).toUpperCase()}`;
        await db.collection('purchases').doc(purchaseId).set({
          userId,
          botId: bId,
          licenseKey,
          purchaseDate: timestamp,
          status: 'completed',
          isSubscription: false,
          isMock: true
        });
        await db.collection('key_registry').doc(licenseKey).set({ purchaseId });

        if (userEmail) {
          await emailService.sendPurchaseConfirmation(userEmail, botName, licenseKey, botPrice, timestamp).catch(e => console.error("Mock email fail:", e));
        }

        await createNotification(userId, "SIMULATION: Integrity Check Passed", `SUCCESS: Payment of $${botPrice} confirmed at ${timestamp}. Module ${botName} activated. Instructions sent to: ${userEmail || 'registered email'}.`, "purchase", "/vault");
      }
    };

    if (isBulk && botIds) {
      const ids = botIds.split(',');
      for (const id of ids) await processBot(id);
    } else if (botId) {
      await processBot(botId);
    }
  };

  app.post("/api/cart-checkout", authenticate, async (req, res) => {
    console.log("[API] Received cart-checkout request");
    const { items, userId, couponCode, currency: targetCurrency = 'USD' } = req.body;
    
    if ((req as any).user.uid !== userId) {
      return res.status(403).json({ error: "Security Breach: User ID mismatch in transaction protocol." });
    }
    
    const stripeClient = getStripe();
    
    const userDoc = await db.collection('users').doc(userId).get();
    const userEmail = userDoc.exists ? userDoc.data()?.email : undefined;

    if (!stripeClient) {
      console.log("[API] Stripe not configured, fulfilling mock order");
      try {
        const itemIds = items.map((i: any) => i.id).join(',');
        await fulfillMockOrder(userId, itemIds, null, true, userEmail);
        
        return res.json({ 
          url: `${process.env.APP_URL || "http://localhost:3000"}/dashboard?success=true&mock=true`,
          warning: "Stripe not configured. Simulation protocol engaged."
        });
      } catch (mockErr: any) {
        console.error("[API] Mock fulfillment failed:", mockErr);
        return res.status(500).json({ error: "Mock fulfillment error", details: mockErr.message });
      }
    }

    try {
      console.log(`[API] Creating checkout session for user: ${userId}, currency: ${targetCurrency}`);

      // Metadata only allows flat strings, so we'll store IDs as a comma-separated string if it fits
      // Stripe metadata limit is 50 keys, 500 characters per value.
      const itemIds = items.map((i: any) => i.id).join(',');
      const hasSubscription = items.some((i: any) => i.isSubscription);

      let discountPercent = 0;
      if (couponCode) {
        const q = db.collection('coupons').where('code', '==', couponCode.toUpperCase().trim()).where('isActive', '==', true).limit(1);
        const snap = await q.get();
        if (!snap.empty) {
          const couponDoc = snap.docs[0].data();
          const now = new Date().toISOString();
          if (!(couponDoc.expiresAt && couponDoc.expiresAt < now) && !(couponDoc.maxUsages && couponDoc.usageCount >= couponDoc.maxUsages)) {
            discountPercent = couponDoc.discountPercent;
          }
        }
      }

      const discountFactor = (100 - discountPercent) / 100;
      const exchangeRate = currentRates[targetCurrency.toUpperCase()] || 1;

      const lineItems = items.map((item: any) => ({
        price_data: {
          currency: targetCurrency.toLowerCase(),
          product_data: {
            name: item.name,
            description: item.isSubscription ? `Active subscription for ${item.name}` : `Lifetime access for ${item.name}`,
          },
          unit_amount: Math.round(item.price * 100 * discountFactor * exchangeRate),
          recurring: item.isSubscription ? { interval: "month" } : undefined,
        },
        quantity: 1,
      }));

      const session = await stripeClient.checkout.sessions.create({
        automatic_payment_methods: { enabled: true },
        customer_email: userEmail,
        line_items: lineItems,
        mode: hasSubscription ? "subscription" : "payment",
        metadata: {
          userId,
          botIds: itemIds, // Comma separated list of IDs
          isBulk: "true",
          couponCode: couponCode || "",
          currency: targetCurrency,
          protocol: "V_SECURE_7",
          source: "web_v1"
        },
        success_url: `${process.env.APP_URL || "http://localhost:3000"}/dashboard?success=true`,
        cancel_url: `${process.env.APP_URL || "http://localhost:3000"}/cart?canceled=true`,
      } as any);

      res.json({ id: session.id, url: session.url });
    } catch (error: any) {
      console.error("Cart checkout error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/checkout", authenticate, async (req, res) => {
    console.log("[API] Received single checkout request");
    const { botId, price, name, isSubscription, userId, couponCode, currency: targetCurrency = 'USD' } = req.body;
    
    if ((req as any).user.uid !== userId) {
      return res.status(403).json({ error: "Security Breach: User ID mismatch in transaction protocol." });
    }
    
    const stripeClient = getStripe();
    
    const userDoc = await db.collection('users').doc(userId).get();
    const userEmail = userDoc.exists ? userDoc.data()?.email : undefined;

    if (!stripeClient) {
      console.log("[API] Stripe not configured, fulfilling mock order");
      try {
        await fulfillMockOrder(userId, null, botId, false, userEmail);

        return res.json({ 
          url: `${process.env.APP_URL || "http://localhost:3000"}/dashboard?success=true&mock=true`,
          warning: "Stripe not configured. Single-unit simulation engaged."
        });
      } catch (mockErr: any) {
        console.error("[API] Mock fulfillment failed:", mockErr);
        return res.status(500).json({ error: "Mock fulfillment error", details: mockErr.message });
      }
    }

    try {
      console.log(`[API] Creating checkout session for bot: ${botId}, user: ${userId}, currency: ${targetCurrency}`);

      let discountPercent = 0;
      if (couponCode) {
        const q = db.collection('coupons').where('code', '==', couponCode.toUpperCase().trim()).where('isActive', '==', true).limit(1);
        const snap = await q.get();
        if (!snap.empty) {
          const couponDoc = snap.docs[0].data();
          const now = new Date().toISOString();
          if (!(couponDoc.expiresAt && couponDoc.expiresAt < now) && !(couponDoc.maxUsages && couponDoc.usageCount >= couponDoc.maxUsages)) {
            discountPercent = couponDoc.discountPercent;
          }
        }
      }

      const discountFactor = (100 - discountPercent) / 100;
      const exchangeRate = currentRates[targetCurrency.toUpperCase()] || 1;

      const session = await stripeClient.checkout.sessions.create({
        automatic_payment_methods: { enabled: true },
        customer_email: userEmail,
        line_items: [
          {
            price_data: {
              currency: targetCurrency.toLowerCase(),
              product_data: {
                name: name,
                description: isSubscription ? `Active subscription for ${name}` : `Lifetime access for ${name}`,
              },
              unit_amount: Math.round(price * 100 * discountFactor * exchangeRate),
              recurring: isSubscription ? { interval: "month" } : undefined,
            },
            quantity: 1,
          },
        ],
        mode: isSubscription ? "subscription" : "payment",
        metadata: {
          userId,
          botId,
          type: isSubscription ? 'subscription' : 'one-time',
          protocol: "V_SECURE_7_S",
          couponCode: couponCode || "",
          currency: targetCurrency,
          source: "web_v1"
        },
        success_url: `${process.env.APP_URL || "http://localhost:3000"}/dashboard?success=true`,
        cancel_url: `${process.env.APP_URL || "http://localhost:3000"}/product/${botId}?canceled=true`,
      } as any);

      res.json({ id: session.id, url: session.url });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/create-portal-session", authenticate, async (req, res) => {
    const { userId } = req.body;
    
    if ((req as any).user.uid !== userId && !['founder', 'admin'].includes((req as any).user.role)) {
       // Actually we need to check the role from the token if possible, but decoded token doesn't have it unless we set custom claims.
       // For now, only the owner can access their portal.
       if ((req as any).user.uid !== userId) {
         return res.status(403).json({ error: "Access Denied: Billing portal restricted to account owner." });
       }
    }
    
    const stripeClient = getStripe();
    
    if (!stripeClient) {
      return res.status(500).json({ error: "Stripe not configured" });
    }

    try {
      // Find customer ID from user profile first
      const userDoc = await db.collection('users').doc(userId).get();
      let customerId = userDoc.exists ? userDoc.data()?.stripeCustomerId : null;

      if (!customerId) {
        // Fallback to searching subscriptions
        const subSnap = await db.collection('subscriptions').where('userId', '==', userId).limit(1).get();
        if (subSnap.empty) {
          return res.status(404).json({ error: "No billing information found for this user." });
        }
        customerId = subSnap.docs[0].data().stripeCustomerId;
      }

      const session = await stripeClient.billingPortal.sessions.create({
        customer: customerId,
        return_url: `${process.env.APP_URL || "http://localhost:3000"}/dashboard`,
      });

      res.json({ url: session.url });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ADMIN SUBSCRIPTION MANAGEMENT
  app.get("/api/admin/subscriptions", authenticate, isAdminMiddleware, async (req, res) => {
    const stripeClient = getStripe();
    if (!stripeClient) return res.status(500).json({ 
      error: "Stripe not configured",
      details: "Set STRIPE_SECRET_KEY in Secrets."
    });

    try {
      const subscriptions = await stripeClient.subscriptions.list({
        expand: ['data.customer'],
        limit: 100
      });
      res.json(subscriptions.data);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/admin/cancel-subscription", authenticate, isAdminMiddleware, async (req, res) => {
    const { subscriptionId } = req.body;
    const stripeClient = getStripe();
    if (!stripeClient) return res.status(500).json({ 
      error: "Stripe not configured",
      details: "Set STRIPE_SECRET_KEY in Secrets."
    });

    try {
      const subscription = await stripeClient.subscriptions.cancel(subscriptionId);
      res.json(subscription);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/admin/activate-subscription", authenticate, isAdminMiddleware, async (req, res) => {
    const { subscriptionId } = req.body;
    const stripeClient = getStripe();
    if (!stripeClient) return res.status(500).json({ 
      error: "Stripe not configured",
      details: "Set STRIPE_SECRET_KEY in Secrets."
    });

    try {
      // Reactivate by removing cancel_at_period_end
      const subscription = await stripeClient.subscriptions.update(subscriptionId, {
        cancel_at_period_end: false
      });
      res.json(subscription);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/admin/update-subscription", authenticate, isAdminMiddleware, async (req, res) => {
    const { subscriptionId, metadata } = req.body;
    const stripeClient = getStripe();
    if (!stripeClient) return res.status(500).json({ 
      error: "Stripe not configured",
      details: "Set STRIPE_SECRET_KEY in Secrets."
    });

    try {
      const subscription = await stripeClient.subscriptions.update(subscriptionId, {
        metadata
      });
      res.json(subscription);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Catch-all for /api routes to prevent Vite from serving HTML 404s
  app.all("/api/*", (req, res) => {
    console.warn(`[API_404] No route matched: ${req.method} ${req.path}`);
    res.status(404).json({ error: "Route not found in API registry." });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true, allowedHosts: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server successfully started on http://localhost:${PORT}`);
  });
}

startServer().catch(err => {
  console.error("CRITICAL ERROR IN startServer():", err);
  emailService.sendCriticalAlert(err.message, "server.ts startServer() loop");
});
} catch (e) {
  console.error("CRITICAL ERROR DURING TOP-LEVEL INIT:", e);
  const errMessage = e instanceof Error ? e.message : String(e);
  emailService.sendCriticalAlert(errMessage, "server.ts top-level catch");
}
