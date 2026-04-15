const axios = require('axios');
const { query } = require('../db');
const { ContactService } = require('./ContactService');

class MicrosoftService {
  static GRAPH_API_BASE = 'https://graph.microsoft.com/v1.0';
  static AUTH_BASE = 'https://login.microsoftonline.com';

  // Get authorization URL for OAuth flow
  static getAuthorizationUrl(state) {
    const clientId = process.env.AZURE_CLIENT_ID;
    const redirectUri = process.env.AZURE_REDIRECT_URI;
    const tenantId = process.env.AZURE_TENANT_ID || 'common';

    const scopes = [
      'offline_access',
      'User.Read',
      'Mail.Read',
      'Mail.ReadWrite',
      'Mail.Send',
      'Contacts.Read',
      'Calendars.Read',
      'Files.Read.All',
      'Files.ReadWrite.All',
    ].join(' ');

    const params = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: scopes,
      state: state,
      response_mode: 'query',
    });

    return `${this.AUTH_BASE}/${tenantId}/oauth2/v2.0/authorize?${params}`;
  }

  // Exchange authorization code for tokens
  static async exchangeCodeForTokens(code) {
    const clientId = process.env.AZURE_CLIENT_ID;
    const clientSecret = process.env.AZURE_CLIENT_SECRET;
    const redirectUri = process.env.AZURE_REDIRECT_URI;
    const tenantId = process.env.AZURE_TENANT_ID || 'common';

    const params = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code: code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });

    const response = await axios.post(
      `${this.AUTH_BASE}/${tenantId}/oauth2/v2.0/token`,
      params.toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }
    );

    const expiresAt = new Date();
    expiresAt.setSeconds(expiresAt.getSeconds() + response.data.expires_in);

    return {
      accessToken: response.data.access_token,
      refreshToken: response.data.refresh_token,
      expiresAt: expiresAt,
    };
  }

  // Refresh access token
  static async refreshAccessToken(refreshToken) {
    const clientId = process.env.AZURE_CLIENT_ID;
    const clientSecret = process.env.AZURE_CLIENT_SECRET;
    const tenantId = process.env.AZURE_TENANT_ID || 'common';

    const params = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });

    const response = await axios.post(
      `${this.AUTH_BASE}/${tenantId}/oauth2/v2.0/token`,
      params.toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }
    );

    const expiresAt = new Date();
    expiresAt.setSeconds(expiresAt.getSeconds() + response.data.expires_in);

    return {
      accessToken: response.data.access_token,
      refreshToken: response.data.refresh_token,
      expiresAt: expiresAt,
    };
  }

  // Get valid access token (refresh if needed)
  static async getValidAccessToken(userId) {
    const result = await query(
      `SELECT access_token, refresh_token, token_expires_at 
       FROM platform_integrations 
       WHERE user_id = $1 AND platform = 'microsoft' AND is_connected = true`,
      [userId]
    );

    if (result.rows.length === 0) {
      throw new Error('Microsoft integration not connected');
    }

    const integration = result.rows[0];
    const expiresAt = new Date(integration.token_expires_at);

    // If token expires in less than 5 minutes, refresh it
    if (expiresAt.getTime() - Date.now() < 5 * 60 * 1000) {
      const tokens = await this.refreshAccessToken(integration.refresh_token);
      
      // Update tokens in database
      await query(
        `UPDATE platform_integrations 
         SET access_token = $1, refresh_token = $2, token_expires_at = $3, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $4 AND platform = 'microsoft'`,
        [tokens.accessToken, tokens.refreshToken, tokens.expiresAt, userId]
      );

      return tokens.accessToken;
    }

    return integration.access_token;
  }

  // Sync emails from Outlook
  static async syncEmails(userId, options = {}) {
    const accessToken = await this.getValidAccessToken(userId);
    const { sinceDate = null, maxResults = 50 } = options;

    let url = `${this.GRAPH_API_BASE}/me/messages?$top=${maxResults}&$orderby=receivedDateTime DESC`;
    
    if (sinceDate) {
      const isoDate = sinceDate.toISOString();
      url += `&$filter=receivedDateTime ge ${isoDate}`;
    }

    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    const emails = response.data.value;

    for (const email of emails) {
      try {
        // Extract sender information
        const senderEmail = email.from?.emailAddress?.address;
        const senderName = email.from?.emailAddress?.name;

        if (!senderEmail) continue;

        // Find or create contact
        const nameParts = senderName?.split(' ') || [];
        const contact = await ContactService.findOrCreateByEmail(userId, senderEmail, {
          firstName: nameParts[0],
          lastName: nameParts.slice(1).join(' '),
        });

        // Link Microsoft identity
        await ContactService.linkPlatformIdentity(
          contact.id,
          'microsoft',
          email.from.emailAddress.address,
          {
            email: senderEmail,
            username: senderName,
            rawData: email.from,
          }
        );

        // Store email interaction
        await query(
          `INSERT INTO interactions (
            contact_id, user_id, platform, interaction_type, direction,
            subject, content, occurred_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT DO NOTHING`,
          [
            contact.id,
            userId,
            'microsoft',
            'email',
            'inbound',
            email.subject,
            email.bodyPreview || email.body?.content,
            new Date(email.receivedDateTime),
          ]
        );

        // Update last contact date
        await ContactService.touchContact(contact.id);

      } catch (error) {
        console.error('Error processing email:', email.id, error);
      }
    }
  }

  // Get user's Outlook profile
  static async getUserProfile(userId) {
    const accessToken = await this.getValidAccessToken(userId);

    const response = await axios.get(`${this.GRAPH_API_BASE}/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    return response.data;
  }

  // Send email via Outlook
  static async sendEmail(userId, to, subject, body, options = {}) {
    const accessToken = await this.getValidAccessToken(userId);

    const message = {
      subject: subject,
      body: {
        contentType: 'HTML',
        content: body,
      },
      toRecipients: to.map(email => ({
        emailAddress: { address: email },
      })),
      ccRecipients: (options.cc || []).map(email => ({
        emailAddress: { address: email },
      })),
      bccRecipients: (options.bcc || []).map(email => ({
        emailAddress: { address: email },
      })),
    };

    await axios.post(
      `${this.GRAPH_API_BASE}/me/sendMail`,
      { message: message, saveToSentItems: true },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      }
    );
  }

  // List OneDrive files
  static async listOneDriveFiles(userId, folderId = null) {
    const accessToken = await this.getValidAccessToken(userId);

    const url = folderId
      ? `${this.GRAPH_API_BASE}/me/drive/items/${folderId}/children`
      : `${this.GRAPH_API_BASE}/me/drive/root/children`;

    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    return response.data.value;
  }

  // Search OneDrive files
  static async searchOneDriveFiles(userId, searchQuery) {
    const accessToken = await this.getValidAccessToken(userId);

    const response = await axios.get(
      `${this.GRAPH_API_BASE}/me/drive/root/search(q='${encodeURIComponent(searchQuery)}')`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );

    return response.data.value;
  }

  // Get file download URL
  static async getFileDownloadUrl(userId, fileId) {
    const accessToken = await this.getValidAccessToken(userId);

    const response = await axios.get(
      `${this.GRAPH_API_BASE}/me/drive/items/${fileId}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );

    return response.data['@microsoft.graph.downloadUrl'];
  }

  // Create webhook subscription for new emails
  static async createEmailWebhook(userId, callbackUrl) {
    const accessToken = await this.getValidAccessToken(userId);

    const subscription = {
      changeType: 'created',
      notificationUrl: callbackUrl,
      resource: '/me/messages',
      expirationDateTime: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
      clientState: 'secretClientValue',
    };

    const response = await axios.post(
      `${this.GRAPH_API_BASE}/subscriptions`,
      subscription,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      }
    );

    return response.data;
  }
}

module.exports = { MicrosoftService };