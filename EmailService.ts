import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Service to handle sending emails.
 * Uses SMTP configuration from environment variables.
 */
class EmailService {
  private transporter: nodemailer.Transporter | null = null;

  constructor() {
    this.init();
  }

  private init() {
    const host = process.env.EMAIL_HOST;
    const port = parseInt(process.env.EMAIL_PORT || '587');
    const user = process.env.EMAIL_USER;
    const pass = process.env.EMAIL_PASS;

    if (!host || !user || !pass) {
      console.warn("Email service not fully configured. Set EMAIL_HOST, EMAIL_USER, and EMAIL_PASS in .env");
      return;
    }

    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: {
        user,
        pass,
      },
    });
  }

  /**
   * Sends an email.
   */
  async sendEmail(to: string, subject: string, text: string, html?: string) {
    if (!this.transporter) {
      console.log("------------------------------------------");
      console.log("[MOCK EMAIL SENT]");
      console.log(`To: ${to}`);
      console.log(`Subject: ${subject}`);
      console.log(`Content: ${text}`);
      console.log("------------------------------------------");
      return;
    }

    const from = process.env.EMAIL_FROM || '"SNACK.inc" <noreply@snack.com>';
    console.log(`[AUTOMATION] Dispatching purchase confirmation to: ${to}`);

    try {
      await this.transporter.sendMail({
        from,
        to,
        subject,
        text,
        html,
      });
      console.log(`Email sent successfully to ${to}`);
    } catch (error) {
      console.error(`Failed to send email to ${to}:`, error);
      throw error;
    }
  }

  /**
   * Sends a purchase confirmation email.
   */
   async sendPurchaseConfirmation(userEmail: string, botName: string, licenseKey: string, amount?: number, date?: string, currency: string = 'USD', paidTo: string = "SNACK.inc") {
    const subject = `Purchase Confirmation: ${botName}`;
    const displayDate = date ? new Date(date).toLocaleString() : new Date().toLocaleString();
    const displayAmount = amount ? `${amount.toFixed(2)} ${currency}` : 'Verified';
    
    const text = `Success! You have purchased lifetime access to ${botName}.\n\n` +
      `Transaction Details:\n` +
      `- Amount Paid: ${displayAmount}\n` +
      `- Paid To: ${paidTo}\n` +
      `- Date: ${displayDate}\n` +
      `- Status: PAID & VERIFIED\n\n` +
      `Your license key: ${licenseKey}\n\n` +
      `Access Steps:\n` +
      `1. Log in to your SNACK.inc dashboard at ${process.env.APP_URL || 'our website'}.\n` +
      `2. Navigate to the 'Module Vault' section.\n` +
      `3. Locate ${botName} and click 'Initialize'.\n` +
      `4. Enter your License Key to unlock file access.\n` +
      `5. Once initialized, click 'Download Assets' or 'Open Interface' to access your files.`;

    const html = `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #1a1a1a; background: #0a0a0a; color: #ffffff;">
        <h1 style="color: #00f5ff; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 5px;">SNACK.inc</h1>
        <p style="font-size: 10px; color: #666; margin-top: 0;">OFFICIAL PURCHASE RECEIPT & ACCESS DEED</p>
        
        <div style="margin: 20px 0; padding: 15px; background: #111; border: 1px solid #333;">
          <p style="margin: 5px 0; font-size: 12px;"><span style="color: #666;">TRANSACTION_ID:</span> <span style="font-family: monospace;">${Math.random().toString(36).substring(7).toUpperCase()}</span></p>
          <p style="margin: 5px 0; font-size: 12px;"><span style="color: #666;">PAID_TO:</span> <span style="color: #00f5ff;">${paidTo}</span></p>
          <p style="margin: 5px 0; font-size: 12px;"><span style="color: #666;">AMOUNT_PAID:</span> <span style="color: #00f5ff;">${displayAmount}</span></p>
          <p style="margin: 5px 0; font-size: 12px;"><span style="color: #666;">TIMESTAMP:</span> <span>${displayDate}</span></p>
          <p style="margin: 5px 0; font-size: 12px;"><span style="color: #666;">STATUS:</span> <span style="color: #00ff00;">PAID_AND_VERIFIED</span></p>
        </div>

        <p>Access granted to <strong>${botName}</strong>. Your license key is secured below.</p>
        
        <div style="background: #111; padding: 20px; border-radius: 4px; border: 1px solid #00f5ff50; margin: 20px 0; text-align: center;">
          <p style="margin: 0; font-size: 12px; color: #666; text-transform: uppercase;">License Key:</p>
          <p style="margin: 5px 0 0; font-family: monospace; font-size: 28px; color: #00f5ff; letter-spacing: 3px;">${licenseKey}</p>
        </div>

        <div style="margin: 30px 0; padding: 20px; background: #ffffff05; border-left: 3px solid #00f5ff;">
          <h3 style="color: #00f5ff; font-size: 14px; margin-top: 0; text-transform: uppercase;">UPLINK PROTOCOL (Access Steps):</h3>
          <ol style="font-size: 13px; color: #ccc; padding-left: 20px; line-height: 1.6;">
            <li>Log in to the <strong>SNACK.inc</strong> platform.</li>
            <li>Navigate to the <strong>Module Vault</strong> (your secure repository).</li>
            <li>Locate the <strong>${botName}</strong> module card.</li>
            <li>Click <strong>"Initialize Module"</strong> and paste your License Key.</li>
            <li>Upon validation, a <strong>"Download Files"</strong> link will appear.</li>
            <li>Execute the download to retrieve your acquired assets.</li>
          </ol>
        </div>

        <p style="font-size: 14px; color: #888;">Direct access for registered users: <a href="${process.env.APP_URL || '#'}/vault" style="color: #00f5ff; text-decoration: none;">SNACK_VAULT_UPLINK</a></p>
        <hr style="border: 0; border-top: 1px solid #333; margin: 30px 0;" />
        <p style="font-size: 10px; color: #444; text-align: center;">SYSTEM_GENERATED_RECEIPT | SECURITY_LEVEL: ALPHA</p>
      </div>
    `;
    return this.sendEmail(userEmail, subject, text, html);
  }

  /**
   * Sends a subscription confirmation email.
   */
   async sendSubscriptionConfirmation(userEmail: string, botName: string, licenseKey: string, amount?: number, date?: string, currency: string = 'USD', paidTo: string = "SNACK.inc") {
    const subject = `Subscription Activated: ${botName}`;
    const displayDate = date ? new Date(date).toLocaleString() : new Date().toLocaleString();
    const displayAmount = amount ? `${amount.toFixed(2)} ${currency}` : 'Verified';

    const text = `Success! Your subscription for ${botName} is now active.\n\n` +
      `Subscription Details:\n` +
      `- Initial Amount: ${displayAmount}\n` +
      `- Paid To: ${paidTo}\n` +
      `- Activation Date: ${displayDate}\n` +
      `- Status: ACTIVE & VERIFIED\n\n` +
      `Your access key: ${licenseKey}\n\n` +
      `Access Steps:\n` +
      `1. Log in to your SNACK.inc dashboard.\n` +
      `2. Navigate to the 'Module Vault' section.\n` +
      `3. Initialize ${botName} using your Access Key.\n` +
      `4. Access files and live updates directly from the module interface.`;

    const html = `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #1a1a1a; background: #0a0a0a; color: #ffffff;">
        <h1 style="color: #00f5ff; text-transform: uppercase; letter-spacing: 2px;">SNACK.inc</h1>
        <p style="font-size: 10px; color: #666; margin-top: 0;">SUBSCRIPTION PULSE CONFIRMED</p>

        <div style="margin: 20px 0; padding: 15px; background: #111; border: 1px solid #333;">
          <p style="margin: 5px 0; font-size: 12px;"><span style="color: #666;">SUBSCRIPTION_ID:</span> <span style="font-family: monospace;">${Math.random().toString(36).substring(7).toUpperCase()}</span></p>
          <p style="margin: 5px 0; font-size: 12px;"><span style="color: #666;">PAID_TO:</span> <span style="color: #00f5ff;">${paidTo}</span></p>
          <p style="margin: 5px 0; font-size: 12px;"><span style="color: #666;">AMOUNT:</span> <span style="color: #00f5ff;">${displayAmount}/mo</span></p>
          <p style="margin: 5px 0; font-size: 12px;"><span style="color: #666;">ACTIVATION_TIME:</span> <span>${displayDate}</span></p>
          <p style="margin: 5px 0; font-size: 12px;"><span style="color: #666;">STATUS:</span> <span style="color: #00ff00;">ACTIVE_INTERNAL_UPLINK</span></p>
        </div>

        <p><strong>${botName}</strong> is now online in your cluster.</p>

        <div style="background: #111; padding: 20px; border-radius: 4px; border: 1px solid #00f5ff50; margin: 20px 0; text-align: center;">
          <p style="margin: 0; font-size: 12px; color: #666; text-transform: uppercase;">Access Key:</p>
          <p style="margin: 5px 0 0; font-family: monospace; font-size: 28px; color: #00f5ff; letter-spacing: 3px;">${licenseKey}</p>
        </div>

        <div style="margin: 30px 0; padding: 20px; background: #ffffff05; border-left: 3px solid #00f5ff;">
          <h3 style="color: #00f5ff; font-size: 14px; margin-top: 0; text-transform: uppercase;">CORE DEPLOYMENT (Steps):</h3>
          <ol style="font-size: 13px; color: #ccc; padding-left: 20px; line-height: 1.6;">
            <li>Access the <strong>SNACK.inc</strong> dashboard.</li>
            <li>Go to <strong>Module Vault</strong>.</li>
            <li>Input the Access Key above into the <strong>${botName}</strong> initialization field.</li>
            <li>Files and operational tools are now unlocked for your account.</li>
          </ol>
        </div>

        <p style="font-size: 14px; color: #888;">Manage your recurring access in settings: <a href="${process.env.APP_URL || '#'}/profile" style="color: #00f5ff; text-decoration: none;">BILLING_CORE</a></p>
        <hr style="border: 0; border-top: 1px solid #333; margin: 30px 0;" />
        <p style="font-size: 10px; color: #444; text-align: center;">SUBSCRIPTION_DAEMON_LOG | SECURITY: VERIFIED</p>
      </div>
    `;
    return this.sendEmail(userEmail, subject, text, html);
  }

  /**
   * Sends a critical system alert.
   */
   async sendCriticalAlert(error: string, context: string) {
    const adminEmail = process.env.ADMIN_EMAIL;
    if (!adminEmail) return;

    try {
      const subject = `CRITICAL ALERT: System Failure Detected`;
      const text = `A critical error occurred: ${error}\nContext: ${context}\nTimestamp: ${new Date().toISOString()}`;
      const html = `
        <div style="font-family: monospace; padding: 20px; background: #000; color: #ff3333; border: 2px solid #ff3333;">
          <h1 style="border-bottom: 2px solid #ff3333; padding-bottom: 10px;">[SYSTEM_CRITICAL_FAILURE]</h1>
          <p><strong>TIMESTAMP:</strong> ${new Date().toISOString()}</p>
          <p><strong>ERROR:</strong> ${error}</p>
          <p><strong>CONTEXT:</strong> ${context}</p>
          <div style="margin-top: 30px; border-top: 1px solid #333; font-size: 10px; color: #666;">
            ALERT_DAEMON_ID: 0x44_ALPHA
          </div>
        </div>
      `;
      return await this.sendEmail(adminEmail, subject, text, html);
    } catch (e) {
      console.error("FAILED_TO_SEND_CRITICAL_ALERT", e);
    }
  }

  /**
   * Sends a bug report notification to admin.
   */
  async sendBugReport(userEmail: string, severity: string, description: string) {
    const adminEmail = process.env.ADMIN_EMAIL;
    if (!adminEmail) return;

    const subject = `[BUG REPORT] ${severity.toUpperCase()} SEVERITY`;
    const text = `New bug report from ${userEmail}\nSeverity: ${severity}\nDescription: ${description}`;
    const html = `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #000; border: 1px solid #ff9900; color: #fff;">
        <h2 style="color: #ff9900; border-bottom: 1px solid #333; padding-bottom: 10px;">BUG_REPORT_INCOMING</h2>
        <p><strong>REPORTER:</strong> ${userEmail}</p>
        <p><strong>SEVERITY:</strong> <span style="color: ${severity === 'critical' ? '#ff3333' : '#ff9900'}">${severity.toUpperCase()}</span></p>
        <div style="background: #111; padding: 15px; border-left: 4px solid #ff9900; margin: 20px 0;">
          <p style="margin: 0; font-family: monospace;">${description}</p>
        </div>
        <p style="font-size: 10px; color: #666;">Generated by SNACK.inc Ticketing Daemon</p>
      </div>
    `;
    return this.sendEmail(adminEmail, subject, text, html);
  }

  /**
   * Sends a contact form inquiry to admin.
   */
  async sendContactInquiry(name: string, email: string, subject: string, message: string) {
    const adminEmail = process.env.ADMIN_EMAIL;
    if (!adminEmail) return;

    const emailSubject = `[CONTACT INQUIRY] ${subject}`;
    const text = `New contact inquiry from ${name} (${email})\nSubject: ${subject}\nMessage: ${message}`;
    const html = `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #000; border: 1px solid #00f5ff; color: #fff;">
        <h2 style="color: #00f5ff; border-bottom: 1px solid #333; padding-bottom: 10px;">CONTACT_INQUIRY</h2>
        <p><strong>NAME:</strong> ${name}</p>
        <p><strong>EMAIL:</strong> ${email}</p>
        <p><strong>SUBJECT:</strong> ${subject}</p>
        <div style="background: #111; padding: 15px; border-left: 4px solid #00f5ff; margin: 20px 0;">
          <p style="margin: 0; font-family: monospace;">${message}</p>
        </div>
        <p style="font-size: 10px; color: #666;">Generated by SNACK.inc Communications Terminal</p>
      </div>
    `;
    return this.sendEmail(adminEmail, emailSubject, text, html);
  }

  /**
   * Checks if the transporter is healthy.
   */
  async checkHealth(): Promise<boolean> {
    if (!this.transporter) return false;
    try {
      await this.transporter.verify();
      return true;
    } catch (error) {
      return false;
    }
  }
}

export const emailService = new EmailService();
