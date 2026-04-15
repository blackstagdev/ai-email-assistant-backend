const axios = require('axios');
const { query } = require('../db');
const { ContactService } = require('./ContactService');



class GoHighLevelService {
  private static readonly BASE_URL = 'https://services.leadconnectorhq.com';

  // Get GHL API client
  private static getClient(accessToken) {
    return axios.create({
      baseURL: this.BASE_URL,
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Version': '2021-07-28',
      },
    });
  }

  // Get stored GHL credentials
  private static async getConfig(userId) {
    const result = await query(
      `SELECT access_token, metadata FROM platform_integrations 
       WHERE user_id = $1 AND platform = 'gohighlevel' AND is_connected = true`,
      [userId]
    );

    if (result.rows.length === 0) {
      throw new Error('GoHighLevel not connected');
    }

    return {
      accessToken: result.rows[0].access_token,
      locationId: result.rows[0].metadata?.location_id,
    };
  }

  // Exchange OAuth code for tokens
  static async exchangeCodeForTokens(code) {
    const clientId = process.env.GHL_CLIENT_ID;
    const clientSecret = process.env.GHL_CLIENT_SECRET;

    const response = await axios.post('https://services.leadconnectorhq.com/oauth/token', {
      client_id,
      client_secret,
      grant_type: 'authorization_code',
      code,
    });

    return response.data;
  }

  // Sync contacts from GHL
  static async syncContacts(userId) {
    const config = await this.getConfig(userId);
    const client = this.getClient(config.accessToken);

    let skip = 0;
    const limit = 100;
    let hasMore = true;

    while (hasMore) {
      const response = await client.get('/contacts/', {
        params: {
          locationId: config.locationId,
          limit,
          skip,
        },
      });

      const contacts = response.data.contacts || [];

      for (const ghlContact of contacts) {
        try {
          const email = ghlContact.email;
          if (!email) continue;

          // Find or create contact
          const contact = await ContactService.findOrCreateByEmail(
            userId,
            email,
            {
              firstName: ghlContact.firstName,
              lastName: ghlContact.lastName,
              phone: ghlContact.phone,
              company: ghlContact.companyName,
              tags: ghlContact.tags || [],
            }
          );

          // Link GHL identity
          await ContactService.linkPlatformIdentity(
            contact.id,
            'gohighlevel',
            ghlContact.id,
            {
              email,
              rawData: {
                source: ghlContact.source,
                type: ghlContact.type,
                dateAdded: ghlContact.dateAdded,
              },
            }
          );

          // Update contact metadata
          await query(
            `UPDATE contacts 
             SET custom_fields = jsonb_set(
               COALESCE(custom_fields, '{}'::jsonb),
               '{gohighlevel}',
               $1::jsonb
             ),
             relationship_type = COALESCE(relationship_type, $2)
             WHERE id = $3`,
            [
              JSON.stringify({
                contact_id: ghlContact.id,
                source: ghlContact.source,
                type: ghlContact.type,
              }),
              ghlContact.type || 'lead',
              contact.id,
            ]
          );
        } catch (error) {
          console.error('Error syncing GHL contact:', ghlContact.id, error);
        }
      }

      hasMore = contacts.length === limit;
      skip += limit;
    }
  }

  // Sync opportunities/deals
  static async syncOpportunities(userId) {
    const config = await this.getConfig(userId);
    const client = this.getClient(config.accessToken);

    const response = await client.get('/opportunities/', {
      params: {
        location_id: config.locationId,
      },
    });

    const opportunities = response.data.opportunities || [];

    for (const opp of opportunities) {
      try {
        if (!opp.contact?.email) continue;

        // Find contact
        const contact = await ContactService.findOrCreateByEmail(
          userId,
          opp.contact.email
        );

        // Store(
          `INSERT INTO financial_data (
            contact_id, user_id, platform, invoice_id,
            invoice_date, amount, payment_status
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (platform, invoice_id)
          DO UPDATE SET
            amount = EXCLUDED.amount,
            payment_status = EXCLUDED.payment_status,
            updated_at = CURRENT_TIMESTAMP`,
          [
            contact.id,
            userId,
            'gohighlevel',
            opp.id,
            new Date(opp.createdAt),
            parseFloat(opp.monetaryValue || 0),
            opp.status === 'won' ? 'paid' : 'pending',
          ]
        );

        // Update contact revenue if won
        if (opp.status === 'won') {
          await ContactService.updateFinancials(
            contact.id,
            parseFloat(opp.monetaryValue || 0)
          );
        }
      } catch (error) {
        console.error('Error syncing GHL opportunity:', opp.id, error);
      }
    }
  }

  // Sync conversations
  static async syncConversations(userId) {
    const config = await this.getConfig(userId);
    const client = this.getClient(config.accessToken);

    const response = await client.get('/conversations/', {
      params: {
        locationId: config.locationId,
      },
    });

    const conversations = response.data.conversations || [];

    for (const conversation of conversations) {
      try {
        if (!conversation.contactId) continue;

        // Get contact details
        const contactResponse = await client.get(`/contacts/${conversation.contactId}`, {
          params: { locationId: config.locationId },
        });
        
        const ghlContact = contactResponse.data.contact;
        if (!ghlContact?.email) continue;

        const contact = await ContactService.findOrCreateByEmail(
          userId,
          ghlContact.email
        );

        // Get messages in conversation
        const messagesResponse = await client.get(`/conversations/${conversation.id}/messages`);
        const messages = messagesResponse.data.messages || [];

        for (const message of messages) {
          await query(
            `INSERT INTO interactions (
              contact_id, user_id, platform, interaction_type, direction,
              content, occurred_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT DO NOTHING`,
            [
              contact.id,
              userId,
              'gohighlevel',
              message.type || 'message',
              message.direction,
              message.body,
              new Date(message.dateAdded),
            ]
          );
        }

        await ContactService.touchContact(contact.id);
      } catch (error) {
        console.error('Error syncing GHL conversation:', conversation.id, error);
      }
    }
  }

  // Create contact in GHL
  static async createContact(
    userId,
    contactData) {
    const config = await this.getConfig(userId);
    const client = this.getClient(config.accessToken);

    const response = await client.post('/contacts/', {
      ...contactData,
      locationId: config.locationId,
    });

    return response.data.contact;
  }

  // Send SMS via GHL
  static async sendSMS(
    userId,
    contactId,
    message) {
    const config = await this.getConfig(userId);
    const client = this.getClient(config.accessToken);

    const response = await client.post('/conversations/messages', {
      type: 'SMS',
      contactId,
      message,
    });

    return response.data;
  }

  // Create opportunity/deal
  static async createOpportunity(
    userId,
    opportunityData) {
    const config = await this.getConfig(userId);
    const client = this.getClient(config.accessToken);

    const response = await client.post('/opportunities/', {
      ...opportunityData,
      location_id: config.locationId,
    });

    return response.data.opportunity;
  }
}


module.exports = { GoHighLevelService };
