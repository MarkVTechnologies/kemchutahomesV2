import { escapeHtml } from "./escapeHtml.js";
import { Resend } from "resend";

// Lazy-init Resend client (shared across all functions) — constructing this
// eagerly at module load time meant any module that merely imports this file
// (e.g. adminController.js, purely to call sendAdminPasswordResetEmail from
// one handler) would crash on import in any environment missing
// RESEND_API_KEY, taking down every other handler in that file too —
// including ones with nothing to do with email, like login. Matches the
// already-correct lazy pattern in utils/notifications.js.
let _resend = null;
function getResend() {
  if (_resend) return _resend;
  if (!process.env.RESEND_API_KEY) return null;
  _resend = new Resend(process.env.RESEND_API_KEY);
  return _resend;
}

/**
 * Send Elevated Welcome Email
 * @param {Object} userData - Contains email and firstName
 * @returns {Promise<Object>} - Returns success status and message ID
 */
export const sendWelcomeEmail = async ({ email, firstName }) => {
  console.log(`--- Initiating Email Sequence for: ${email} ---`);

  try {
    const loginUrl = "https://kemchutahomesltd.com/login";

    const resend = getResend();
    if (!resend) {
      console.warn("⚠️  RESEND_API_KEY not set — email skipped");
      return { success: false, reason: "RESEND_API_KEY missing" };
    }

    const { data, error } = await resend.emails.send({
      from: "Kemchuta Homes <notifications@kemchutahomesltd.com>",
      to: email,
      subject: "Welcome to Kemchuta Homes - Let's Build Your Legacy 🏡",
      html: `
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            body { font-family: 'Inter', Arial, sans-serif; background-color: #f5f5f5; margin: 0; padding: 0; -webkit-font-smoothing: antialiased; }
            .wrapper { width: 100%; table-layout: fixed; background-color: #f5f5f5; padding-bottom: 40px; }
            .main { background-color: #ffffff; width: 100%; max-width: 600px; margin: 0 auto; border-radius: 12px; overflow: hidden; margin-top: 20px; box-shadow: 0 10px 30px rgba(0,0,0,0.05); }
            .header { background-color: #700CEB; padding: 50px 20px; text-align: center; }
            .header h1 { color: #ffffff; margin: 0; font-size: 26px; font-weight: 800; letter-spacing: -0.5px; text-transform: uppercase; }
            .content { padding: 40px 35px; color: #262626; line-height: 1.7; }
            .content h2 { color: #000000; font-size: 22px; margin-top: 0; font-weight: 700; }
            .content p { font-size: 16px; color: #525252; }
            .btn-wrapper { text-align: center; margin: 35px 0; }
            .btn { background-color: #700CEB; color: #ffffff !important; padding: 16px 36px; text-decoration: none; border-radius: 8px; font-weight: 700; font-size: 16px; display: inline-block; box-shadow: 0 4px 12px rgba(112, 12, 235, 0.25); }
            .footer { background-color: #171717; padding: 30px; text-align: center; color: #a3a3a3; font-size: 13px; }
            .footer a { color: #bd80f8; text-decoration: none; font-weight: 600; }
            .footer p { margin: 8px 0; }
            .divider { height: 1px; background-color: #404040; margin: 20px auto; width: 80%; }
          </style>
        </head>
        <body>
          <div class="wrapper">
            <div class="main">
              <div class="header">
                <h1>Kemchuta Homes</h1>
              </div>
              <div class="content">
                <h2>Welcome aboard, ${escapeHtml(firstName)}! 👋</h2>
                <p>We're thrilled to have you join our network of professional realtors. At Kemchuta Homes, we provide you with the tools and platform to scale your real estate career to new heights.</p>
                <p>Your account is now fully active. You can log in to your personalized dashboard to access property listings, track your earnings, and manage your referrals.</p>
                <div class="btn-wrapper">
                  <a href="${loginUrl}" class="btn">Launch Your Dashboard</a>
                </div>
                <p>Stay tuned for updates on new properties and exclusive realtor training sessions.</p>
                <p style="margin-bottom: 0;">Best Regards,</p>
                <p style="margin-top: 0; color: #700CEB; font-weight: 700;">The Kemchuta Homes Team</p>
              </div>
              <div class="footer">
                <p>Connect with us</p>
                <p>
                  <a href="https://kemchutahomesltd.com/">Website</a> &nbsp;|&nbsp;
                  <a href="#">Instagram</a> &nbsp;|&nbsp;
                  <a href="#">Support</a>
                </p>
                <div class="divider"></div>
                <p>&copy; 2026 Kemchuta Homes. Empowering Realtors.</p>
                <p>Lekki, Lagos, Nigeria</p>
              </div>
            </div>
          </div>
        </body>
        </html>
      `,
    });

    if (error) {
      throw new Error(error.message);
    }

    console.log(`✅ SUCCESS: Welcome email sent to ${email}`);
    console.log(`Message ID: ${data.id}`);

    return { success: true, messageId: data.id };
  } catch (err) {
    console.error("❌ MAILER ERROR:");
    console.error(`Status: Failed to deliver to ${email}`);
    console.error(`Reason: ${err.message}`);
    console.error(`Full Error:`, err);

    return { success: false, error: err.message };
  }
};

/**
 * Send Password Reset Email
 * @param {Object} params - Contains email, firstName, and resetUrl
 * @returns {Promise<Object>} - Returns success status and message ID
 */
export const sendPasswordResetEmail = async ({
  email,
  firstName,
  resetUrl,
}) => {
  console.log(`--- Initiating Password Reset Email for: ${email} ---`);

  try {
    const resend = getResend();
    if (!resend) {
      console.warn("⚠️  RESEND_API_KEY not set — email skipped");
      return { success: false, reason: "RESEND_API_KEY missing" };
    }

    const { data, error } = await resend.emails.send({
      from: "Kemchuta Homes <notifications@kemchutahomesltd.com>",
      to: email,
      subject: "Reset Your Kemchuta Homes Password 🔐",
      html: `
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            body { font-family: 'Inter', Arial, sans-serif; background-color: #f5f5f5; margin: 0; padding: 0; -webkit-font-smoothing: antialiased; }
            .wrapper { width: 100%; table-layout: fixed; background-color: #f5f5f5; padding-bottom: 40px; }
            .main { background-color: #ffffff; width: 100%; max-width: 600px; margin: 0 auto; border-radius: 12px; overflow: hidden; margin-top: 20px; box-shadow: 0 10px 30px rgba(0,0,0,0.05); }
            .header { background-color: #700CEB; padding: 50px 20px; text-align: center; }
            .header h1 { color: #ffffff; margin: 0; font-size: 26px; font-weight: 800; letter-spacing: -0.5px; text-transform: uppercase; }
            .content { padding: 40px 35px; color: #262626; line-height: 1.7; }
            .content h2 { color: #000000; font-size: 22px; margin-top: 0; font-weight: 700; }
            .content p { font-size: 16px; color: #525252; }
            .btn-wrapper { text-align: center; margin: 35px 0; }
            .btn { background-color: #700CEB; color: #ffffff !important; padding: 16px 36px; text-decoration: none; border-radius: 8px; font-weight: 700; font-size: 16px; display: inline-block; box-shadow: 0 4px 12px rgba(112, 12, 235, 0.25); }
            .warning-box { background-color: #fef3c7; border-left: 4px solid #f59e0b; border-radius: 6px; padding: 14px 18px; margin: 24px 0; }
            .warning-box p { font-size: 14px; color: #92400e; margin: 0; }
            .footer { background-color: #171717; padding: 30px; text-align: center; color: #a3a3a3; font-size: 13px; }
            .footer a { color: #bd80f8; text-decoration: none; font-weight: 600; }
            .footer p { margin: 8px 0; }
            .divider { height: 1px; background-color: #404040; margin: 20px auto; width: 80%; }
          </style>
        </head>
        <body>
          <div class="wrapper">
            <div class="main">
              <div class="header">
                <h1>Kemchuta Homes</h1>
              </div>
              <div class="content">
                <h2>Password Reset Request 🔐</h2>
                <p>Hi ${escapeHtml(firstName)},</p>
                <p>We received a request to reset the password for your Kemchuta Homes account. Click the button below to choose a new password.</p>
                <div class="btn-wrapper">
                  <a href="${resetUrl}" class="btn">Reset My Password</a>
                </div>
                <div class="warning-box">
                  <p>⏰ <strong>This link expires in 1 hour.</strong> If you didn't request a password reset, you can safely ignore this email — your password will remain unchanged.</p>
                </div>
                <p>For security, never share this link with anyone. Our team will never ask for it.</p>
                <p style="margin-bottom: 0;">Best Regards,</p>
                <p style="margin-top: 0; color: #700CEB; font-weight: 700;">The Kemchuta Homes Team</p>
              </div>
              <div class="footer">
                <p>Connect with us</p>
                <p>
                  <a href="https://kemchutahomesltd.com/">Website</a> &nbsp;|&nbsp;
                  <a href="#">Instagram</a> &nbsp;|&nbsp;
                  <a href="#">Support</a>
                </p>
                <div class="divider"></div>
                <p>&copy; 2026 Kemchuta Homes. Empowering Realtors.</p>
                <p>Lekki, Lagos, Nigeria</p>
              </div>
            </div>
          </div>
        </body>
        </html>
      `,
    });

    if (error) {
      throw new Error(error.message);
    }

    console.log(`✅ SUCCESS: Password reset email sent to ${email}`);
    console.log(`Message ID: ${data.id}`);

    return { success: true, messageId: data.id };
  } catch (err) {
    console.error("❌ RESET EMAIL ERROR:");
    console.error(`Status: Failed to deliver to ${email}`);
    console.error(`Reason: ${err.message}`);
    console.error(`Full Error:`, err);

    return { success: false, error: err.message };
  }
};

/**
 * Send Admin Password Reset Email
 * @param {Object} params - Contains email and resetUrl
 * @returns {Promise<Object>} - Returns success status and message ID
 */
export const sendAdminPasswordResetEmail = async ({ email, resetUrl }) => {
  console.log(`--- Initiating Admin Password Reset Email for: ${email} ---`);

  try {
    const resend = getResend();
    if (!resend) {
      console.warn("⚠️  RESEND_API_KEY not set — email skipped");
      return { success: false, reason: "RESEND_API_KEY missing" };
    }

    const { data, error } = await resend.emails.send({
      from: "Kemchuta Homes <notifications@kemchutahomesltd.com>",
      to: email,
      subject: "Admin Password Reset - Kemchuta Homes 🔐",
      html: `
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            body { font-family: 'Inter', Arial, sans-serif; background-color: #f5f5f5; margin: 0; padding: 0; }
            .wrapper { width: 100%; background-color: #f5f5f5; padding-bottom: 40px; }
            .main { background-color: #ffffff; width: 100%; max-width: 600px; margin: 20px auto 0; border-radius: 12px; overflow: hidden; box-shadow: 0 10px 30px rgba(0,0,0,0.05); }
            .header { background-color: #700CEB; padding: 50px 20px; text-align: center; }
            .header h1 { color: #fff; margin: 0; font-size: 26px; font-weight: 800; letter-spacing: -0.5px; text-transform: uppercase; }
            .badge { display: inline-block; background: rgba(255,255,255,0.2); color: #fff; font-size: 12px; font-weight: 700; padding: 4px 12px; border-radius: 20px; margin-top: 10px; letter-spacing: 1px; }
            .content { padding: 40px 35px; color: #262626; line-height: 1.7; }
            .content h2 { color: #000; font-size: 22px; margin-top: 0; font-weight: 700; }
            .content p { font-size: 16px; color: #525252; }
            .btn-wrapper { text-align: center; margin: 35px 0; }
            .btn { background-color: #700CEB; color: #fff !important; padding: 16px 36px; text-decoration: none; border-radius: 8px; font-weight: 700; font-size: 16px; display: inline-block; box-shadow: 0 4px 12px rgba(112,12,235,0.25); }
            .warning-box { background-color: #fef3c7; border-left: 4px solid #f59e0b; border-radius: 6px; padding: 14px 18px; margin: 24px 0; }
            .warning-box p { font-size: 14px; color: #92400e; margin: 0; }
            .footer { background-color: #171717; padding: 30px; text-align: center; color: #a3a3a3; font-size: 13px; }
            .footer a { color: #bd80f8; text-decoration: none; font-weight: 600; }
            .footer p { margin: 8px 0; }
            .divider { height: 1px; background-color: #404040; margin: 20px auto; width: 80%; }
          </style>
        </head>
        <body>
          <div class="wrapper">
            <div class="main">
              <div class="header">
                <h1>Kemchuta Homes</h1>
                <span class="badge">ADMIN PORTAL</span>
              </div>
              <div class="content">
                <h2>Admin Password Reset 🔐</h2>
                <p>Hi Admin,</p>
                <p>We received a request to reset the password for the admin account associated with <strong>${email}</strong>. Click the button below to set a new password.</p>
                <div class="btn-wrapper">
                  <a href="${resetUrl}" class="btn">Reset Admin Password</a>
                </div>
                <div class="warning-box">
                  <p>⏰ <strong>This link expires in 1 hour.</strong> If you didn't request this reset, please secure your account immediately and ignore this email.</p>
                </div>
                <p>For security, never share this link with anyone.</p>
                <p style="margin-bottom: 0;">Best Regards,</p>
                <p style="margin-top: 0; color: #700CEB; font-weight: 700;">The Kemchuta Homes System</p>
              </div>
              <div class="footer">
                <p>
                  <a href="https://kemchutahomesltd.com/">Website</a> &nbsp;|&nbsp;
                  <a href="#">Support</a>
                </p>
                <div class="divider"></div>
                <p>&copy; 2026 Kemchuta Homes. All rights reserved.</p>
                <p>Lekki, Lagos, Nigeria</p>
              </div>
            </div>
          </div>
        </body>
        </html>
      `,
    });

    if (error) throw new Error(error.message);

    console.log(`✅ SUCCESS: Admin reset email sent to ${email}`);
    console.log(`Message ID: ${data.id}`);

    return { success: true, messageId: data.id };
  } catch (err) {
    console.error("❌ ADMIN RESET EMAIL ERROR:", err.message);
    return { success: false, error: err.message };
  }
};

/**
 * Send Admin Invite Email — sent when a superadmin invites someone to the
 * admin portal (or the initial superadmin seed script runs). Links to the
 * account-setup flow (POST /api/admin/setup-account), not the password
 * reset flow, though the underlying token mechanism is shared.
 * @param {Object} params - Contains email, firstName, setupUrl, invitedByEmail
 * @returns {Promise<Object>} - Returns success status and message ID
 */
export const sendAdminInviteEmail = async ({
  email,
  firstName,
  setupUrl,
  invitedByEmail,
}) => {
  console.log(`--- Initiating Admin Invite Email for: ${email} ---`);

  try {
    const resend = getResend();
    if (!resend) {
      console.warn("⚠️  RESEND_API_KEY not set — email skipped");
      return { success: false, reason: "RESEND_API_KEY missing" };
    }

    const { data, error } = await resend.emails.send({
      from: "Kemchuta Homes <notifications@kemchutahomesltd.com>",
      to: email,
      subject: "You've Been Invited to Kemchuta Homes Admin Portal 🎉",
      html: `
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            body { font-family: 'Inter', Arial, sans-serif; background-color: #f5f5f5; margin: 0; padding: 0; }
            .wrapper { width: 100%; background-color: #f5f5f5; padding-bottom: 40px; }
            .main { background-color: #ffffff; width: 100%; max-width: 600px; margin: 20px auto 0; border-radius: 12px; overflow: hidden; box-shadow: 0 10px 30px rgba(0,0,0,0.05); }
            .header { background-color: #700CEB; padding: 50px 20px; text-align: center; }
            .header h1 { color: #fff; margin: 0; font-size: 26px; font-weight: 800; letter-spacing: -0.5px; text-transform: uppercase; }
            .badge { display: inline-block; background: rgba(255,255,255,0.2); color: #fff; font-size: 12px; font-weight: 700; padding: 4px 12px; border-radius: 20px; margin-top: 10px; letter-spacing: 1px; }
            .content { padding: 40px 35px; color: #262626; line-height: 1.7; }
            .content h2 { color: #000; font-size: 22px; margin-top: 0; font-weight: 700; }
            .content p { font-size: 16px; color: #525252; }
            .btn-wrapper { text-align: center; margin: 35px 0; }
            .btn { background-color: #700CEB; color: #fff !important; padding: 16px 36px; text-decoration: none; border-radius: 8px; font-weight: 700; font-size: 16px; display: inline-block; box-shadow: 0 4px 12px rgba(112,12,235,0.25); }
            .warning-box { background-color: #fef3c7; border-left: 4px solid #f59e0b; border-radius: 6px; padding: 14px 18px; margin: 24px 0; }
            .warning-box p { font-size: 14px; color: #92400e; margin: 0; }
            .footer { background-color: #171717; padding: 30px; text-align: center; color: #a3a3a3; font-size: 13px; }
            .footer a { color: #bd80f8; text-decoration: none; font-weight: 600; }
            .footer p { margin: 8px 0; }
            .divider { height: 1px; background-color: #404040; margin: 20px auto; width: 80%; }
          </style>
        </head>
        <body>
          <div class="wrapper">
            <div class="main">
              <div class="header">
                <h1>Kemchuta Homes</h1>
                <span class="badge">ADMIN PORTAL</span>
              </div>
              <div class="content">
                <h2>You're Invited! 🎉</h2>
                <p>Hi ${escapeHtml(firstName || "there")},</p>
                <p><strong>${escapeHtml(invitedByEmail)}</strong> has invited you to join the Kemchuta Homes admin portal. Click the button below to set up your password and activate your account.</p>
                <div class="btn-wrapper">
                  <a href="${setupUrl}" class="btn">Set Up My Account</a>
                </div>
                <div class="warning-box">
                  <p>⏰ <strong>This link expires in 7 days.</strong> If you weren't expecting this invite, you can safely ignore this email.</p>
                </div>
                <p>For security, never share this link with anyone.</p>
                <p style="margin-bottom: 0;">Best Regards,</p>
                <p style="margin-top: 0; color: #700CEB; font-weight: 700;">The Kemchuta Homes Team</p>
              </div>
              <div class="footer">
                <p>
                  <a href="https://kemchutahomesltd.com/">Website</a> &nbsp;|&nbsp;
                  <a href="#">Support</a>
                </p>
                <div class="divider"></div>
                <p>&copy; 2026 Kemchuta Homes. All rights reserved.</p>
                <p>Lekki, Lagos, Nigeria</p>
              </div>
            </div>
          </div>
        </body>
        </html>
      `,
    });

    if (error) throw new Error(error.message);

    console.log(`✅ SUCCESS: Admin invite email sent to ${email}`);
    console.log(`Message ID: ${data.id}`);

    return { success: true, messageId: data.id };
  } catch (err) {
    console.error("❌ ADMIN INVITE EMAIL ERROR:", err.message);
    return { success: false, error: err.message };
  }
};

/**
 * Send Inspection Notification Email to Admin
 * @param {Object} inspection - Contains estateName, firstName, lastName, email, phone, inspectionDate, persons
 * @returns {Promise<Object>} - Returns success status and message ID
 */
export const sendInspectionNotification = async (inspection) => {
  const {
    estateName,
    firstName,
    lastName,
    email,
    phone,
    inspectionDate,
    persons,
  } = inspection;

  const dateStr = new Date(inspectionDate).toLocaleDateString("en-NG", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  console.log(
    `--- Initiating Inspection Notification for: ${estateName} on ${dateStr} ---`,
  );

  try {
    const resend = getResend();
    if (!resend) {
      console.warn("⚠️  RESEND_API_KEY not set — email skipped");
      return { success: false, reason: "RESEND_API_KEY missing" };
    }

    const { data, error } = await resend.emails.send({
      from: "Kemchuta Homes <notifications@kemchutahomesltd.com>",
      to: [process.env.ADMIN_EMAIL || process.env.EMAIL_USER],
      subject: `New Inspection: ${estateName} — ${dateStr}`,
      html: `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 32px; background: #f9f9fb; border-radius: 12px;">
          <div style="background: linear-gradient(135deg, #3F0C91, #700CEB); padding: 28px 32px; border-radius: 10px; margin-bottom: 28px;">
            <h1 style="color: #fff; margin: 0; font-size: 22px; font-weight: 900; letter-spacing: -0.03em;">New Inspection Booking</h1>
            <p style="color: rgba(255,255,255,0.7); margin: 6px 0 0; font-size: 14px;">${escapeHtml(estateName)}</p>
          </div>
          <table style="width: 100%; border-collapse: collapse;">
            ${[
              ["Client Name", `${firstName} ${lastName}`],
              ["Email", email],
              ["Phone", phone],
              ["Inspection Date", dateStr],
              [
                "Number of Persons",
                `${persons} person${persons > 1 ? "s" : ""}`,
              ],
              ["Estate", estateName],
            ]
              .map(
                ([label, value]) => `
              <tr>
                <td style="padding: 12px 0; border-bottom: 1px solid #eee; font-size: 13px; color: #6b7280; font-weight: 600; width: 40%;">${label}</td>
                <td style="padding: 12px 0; border-bottom: 1px solid #eee; font-size: 14px; color: #0f0a1e; font-weight: 700;">${escapeHtml(value)}</td>
              </tr>
            `,
              )
              .join("")}
          </table>
          <div style="margin-top: 28px; padding: 16px; background: rgba(112,12,235,0.06); border-radius: 8px; border-left: 3px solid #700CEB;">
            <p style="margin: 0; font-size: 13px; color: #700CEB; font-weight: 600;">
              Please confirm this inspection booking with the client at your earliest convenience.
            </p>
          </div>
          <p style="margin-top: 24px; font-size: 12px; color: #9ca3af; text-align: center;">
            Kemchuta Homes Ltd · Automated Notification
          </p>
        </div>
      `,
    });

    if (error) throw new Error(error.message);

    console.log(`✅ SUCCESS: Inspection notification sent for ${estateName}`);
    console.log(`Message ID: ${data.id}`);

    return { success: true, messageId: data.id };
  } catch (err) {
    console.error("❌ INSPECTION NOTIFICATION ERROR:");
    console.error(`Reason: ${err.message}`);
    console.error(`Full Error:`, err);

    return { success: false, error: err.message };
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// ADD THESE TWO FUNCTIONS TO THE BOTTOM OF YOUR EXISTING utils/email.js FILE
// They follow the exact same pattern as sendWelcomeEmail and sendPasswordResetEmail
// ─────────────────────────────────────────────────────────────────────────────

export const sendClientWelcomeEmail = async ({ email, firstName }) => {
  console.log(`--- Client Welcome Email for: ${email} ---`);
  try {
    const portalUrl = "https://kemchutahomesltd.com/client/login";
    const resend = getResend();
    if (!resend) {
      console.warn("⚠️  RESEND_API_KEY not set — email skipped");
      return { success: false, reason: "RESEND_API_KEY missing" };
    }

    const { data, error } = await resend.emails.send({
      from: "Kemchuta Homes <notifications@kemchutahomesltd.com>",
      to: email,
      subject: "Your Kemchuta Homes Client Portal is Ready 🏡",
      html: `
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            body { font-family: 'Inter', Arial, sans-serif; background-color: #f5f5f5; margin: 0; padding: 0; -webkit-font-smoothing: antialiased; }
            .wrapper { width: 100%; table-layout: fixed; background-color: #f5f5f5; padding-bottom: 40px; }
            .main { background-color: #ffffff; width: 100%; max-width: 600px; margin: 0 auto; border-radius: 12px; overflow: hidden; margin-top: 20px; box-shadow: 0 10px 30px rgba(0,0,0,0.05); }
            .header { background: linear-gradient(135deg, #3F0C91, #700CEB); padding: 50px 20px; text-align: center; }
            .header h1 { color: #ffffff; margin: 0; font-size: 26px; font-weight: 800; letter-spacing: -0.5px; text-transform: uppercase; }
            .badge { display: inline-block; background: rgba(255,255,255,0.2); color: #fff; font-size: 12px; font-weight: 700; padding: 4px 14px; border-radius: 20px; margin-top: 10px; letter-spacing: 1px; }
            .content { padding: 40px 35px; color: #262626; line-height: 1.7; }
            .content h2 { color: #000000; font-size: 22px; margin-top: 0; font-weight: 700; }
            .content p { font-size: 16px; color: #525252; }
            .feature-list { list-style: none; padding: 0; margin: 20px 0; }
            .feature-list li { padding: 10px 0; border-bottom: 1px solid #f0f0f0; font-size: 15px; color: #374151; display: flex; align-items: center; gap: 10px; }
            .feature-list li:before { content: "✓"; color: #700CEB; font-weight: 800; font-size: 16px; }
            .btn-wrapper { text-align: center; margin: 35px 0; }
            .btn { background-color: #700CEB; color: #ffffff !important; padding: 16px 36px; text-decoration: none; border-radius: 8px; font-weight: 700; font-size: 16px; display: inline-block; box-shadow: 0 4px 12px rgba(112, 12, 235, 0.25); }
            .footer { background-color: #171717; padding: 30px; text-align: center; color: #a3a3a3; font-size: 13px; }
            .footer a { color: #bd80f8; text-decoration: none; font-weight: 600; }
            .footer p { margin: 8px 0; }
            .divider { height: 1px; background-color: #404040; margin: 20px auto; width: 80%; }
          </style>
        </head>
        <body>
          <div class="wrapper">
            <div class="main">
              <div class="header">
                <h1>Kemchuta Homes</h1>
                <span class="badge">CLIENT PORTAL</span>
              </div>
              <div class="content">
                <h2>Welcome, ${escapeHtml(firstName)}! 👋</h2>
                <p>Your Kemchuta Homes client portal is now active. You have a secure, personal space to manage all aspects of your property journey with us.</p>
                <ul class="feature-list">
                  <li>Track your land subscription status in real-time</li>
                  <li>View and download your documents when they're ready</li>
                  <li>Monitor your scheduled inspections</li>
                  <li>View your payment history and outstanding balance</li>
                </ul>
                <div class="btn-wrapper">
                  <a href="${portalUrl}" class="btn">Access Your Portal</a>
                </div>
                <p>If you have any questions, our support team is always ready to help.</p>
                <p style="margin-bottom: 0;">Best Regards,</p>
                <p style="margin-top: 0; color: #700CEB; font-weight: 700;">The Kemchuta Homes Team</p>
              </div>
              <div class="footer">
                <p>Connect with us</p>
                <p>
                  <a href="https://kemchutahomesltd.com/">Website</a> &nbsp;|&nbsp;
                  <a href="#">Instagram</a> &nbsp;|&nbsp;
                  <a href="#">Support</a>
                </p>
                <div class="divider"></div>
                <p>&copy; 2026 Kemchuta Homes. Building Futures.</p>
                <p>Lekki, Lagos, Nigeria</p>
              </div>
            </div>
          </div>
        </body>
        </html>
      `,
    });

    if (error) throw new Error(error.message);
    console.log(`✅ Client welcome email sent to ${email}`);
    return { success: true, messageId: data.id };
  } catch (err) {
    console.error("❌ CLIENT WELCOME EMAIL ERROR:", err.message);
    return { success: false, error: err.message };
  }
};

export const sendClientPasswordResetEmail = async ({
  email,
  firstName,
  resetUrl,
}) => {
  console.log(`--- Client Password Reset Email for: ${email} ---`);
  try {
    const resend = getResend();
    if (!resend) {
      console.warn("⚠️  RESEND_API_KEY not set — email skipped");
      return { success: false, reason: "RESEND_API_KEY missing" };
    }

    const { data, error } = await resend.emails.send({
      from: "Kemchuta Homes <notifications@kemchutahomesltd.com>",
      to: email,
      subject: "Reset Your Kemchuta Homes Portal Password 🔐",
      html: `
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <style>
            body { font-family: 'Inter', Arial, sans-serif; background-color: #f5f5f5; margin: 0; padding: 0; }
            .wrapper { width: 100%; background-color: #f5f5f5; padding-bottom: 40px; }
            .main { background-color: #ffffff; width: 100%; max-width: 600px; margin: 20px auto 0; border-radius: 12px; overflow: hidden; box-shadow: 0 10px 30px rgba(0,0,0,0.05); }
            .header { background: linear-gradient(135deg, #3F0C91, #700CEB); padding: 50px 20px; text-align: center; }
            .header h1 { color: #fff; margin: 0; font-size: 26px; font-weight: 800; letter-spacing: -0.5px; text-transform: uppercase; }
            .badge { display: inline-block; background: rgba(255,255,255,0.2); color: #fff; font-size: 12px; font-weight: 700; padding: 4px 14px; border-radius: 20px; margin-top: 10px; }
            .content { padding: 40px 35px; color: #262626; line-height: 1.7; }
            .content h2 { color: #000; font-size: 22px; margin-top: 0; font-weight: 700; }
            .content p { font-size: 16px; color: #525252; }
            .btn-wrapper { text-align: center; margin: 35px 0; }
            .btn { background-color: #700CEB; color: #fff !important; padding: 16px 36px; text-decoration: none; border-radius: 8px; font-weight: 700; font-size: 16px; display: inline-block; box-shadow: 0 4px 12px rgba(112,12,235,0.25); }
            .warning-box { background-color: #fef3c7; border-left: 4px solid #f59e0b; border-radius: 6px; padding: 14px 18px; margin: 24px 0; }
            .warning-box p { font-size: 14px; color: #92400e; margin: 0; }
            .footer { background-color: #171717; padding: 30px; text-align: center; color: #a3a3a3; font-size: 13px; }
            .footer a { color: #bd80f8; text-decoration: none; font-weight: 600; }
            .footer p { margin: 8px 0; }
            .divider { height: 1px; background-color: #404040; margin: 20px auto; width: 80%; }
          </style>
        </head>
        <body>
          <div class="wrapper">
            <div class="main">
              <div class="header">
                <h1>Kemchuta Homes</h1>
                <span class="badge">CLIENT PORTAL</span>
              </div>
              <div class="content">
                <h2>Password Reset Request 🔐</h2>
                <p>Hi ${escapeHtml(firstName)},</p>
                <p>We received a request to reset the password for your Kemchuta Homes client portal. Click the button below to set a new password.</p>
                <div class="btn-wrapper">
                  <a href="${resetUrl}" class="btn">Reset My Password</a>
                </div>
                <div class="warning-box">
                  <p>⏰ <strong>This link expires in 1 hour.</strong> If you didn't request this reset, you can safely ignore this email — your password will remain unchanged.</p>
                </div>
                <p>For security, never share this link with anyone.</p>
                <p style="margin-bottom: 0;">Best Regards,</p>
                <p style="margin-top: 0; color: #700CEB; font-weight: 700;">The Kemchuta Homes Team</p>
              </div>
              <div class="footer">
                <p><a href="https://kemchutahomesltd.com/">Website</a> &nbsp;|&nbsp; <a href="#">Support</a></p>
                <div class="divider"></div>
                <p>&copy; 2026 Kemchuta Homes. All rights reserved.</p>
              </div>
            </div>
          </div>
        </body>
        </html>
      `,
    });

    if (error) throw new Error(error.message);
    console.log(`✅ Client reset email sent to ${email}`);
    return { success: true, messageId: data.id };
  } catch (err) {
    console.error("❌ CLIENT RESET EMAIL ERROR:", err.message);
    return { success: false, error: err.message };
  }
};
