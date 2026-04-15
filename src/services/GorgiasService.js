const axios = require('axios');
const { query } = require('../db');
const { ContactService } = require('./ContactService');
const { AIService } = require('./AIService');



class GorgiasService {
  // Get Gorgias API client
  private static getClient(config) {
    const auth = Buffer.from(`${config.email}:${config.apiKey}`).toString('base64');
    
    return axios.create({
      baseURL: `https://${config.domain}.gorgias.com/api`,
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
    });
  }

  // Get stored Gorgias credentials
  private static async getConfig(userId) {
    const result = await query(
      `SELECT metadata FROM platform_integrations 
       WHERE user_id = $1 AND platform = 'gorgias' AND is_connected = true`,
      [userId]
    );

    if (result.rows.length === 0) {
      throw new Error('Gorgias not connected');
    }

    const metadata = result.rows[0].metadata;
    return {
      domain: metadata.domain,
      email: metadata.email,
      apiKey: metadata.api_key,
    };
  }

  // Sync tickets from Gorgias
  static async syncTickets(
    userId,
    options?: Date; limit?: number } = {}
  ) {
    const config = await this.getConfig(userId);
    const client = this.getClient(config);

    const { sinceDate, limit = 100 } = options;

    let params = { limit };
    
    if (sinceDate) {
      params.updated_datetime = `>${sinceDate.toISOString()}`;
    }

    let cursor = null;
    let hasMore = true;

    while (hasMore) {
      if (cursor) {
        params.cursor = cursor;
      }

      const response = await client.get('/tickets', { params });
      const tickets = response.data.data;

      for (const ticket of tickets) {
        try {
          // Get customer email from ticket
          const customerEmail = ticket.customer?.email;
          if (!customerEmail) continue;

          // Find or create contact
          const contact = await ContactService.findOrCreateByEmail(
            userId,
            customerEmail,
            {
              firstName: ticket.customer?.firstname,
              lastName: ticket.customer?.lastname,
            }
          );

          // Link Gorgias identity
          await ContactService.linkPlatformIdentity(
            contact.id,
            'gorgias',
            ticket.customer.id.toString(),
            {
              email: customerEmail,
              rawData: ticket.customer,
            }
          );

          // Calculate resolution time
          let resolutionTimeHours = null;
          if (ticket.closed_datetime) {
            const created = new Date(ticket.created_datetime);
            const closed = new Date(ticket.closed_datetime);
            resolutionTimeHours = (closed.getTime() - created.getTime()) / (1000 * 60 * 60);
          }

          // Get satisfaction score from ticket meta
          const satisfactionScore = ticket.satisfaction_score?.score || null;

          // Store ticket
          await query(
            `INSERT INTO support_tickets (
              contact_id, user_id, platform, ticket_id,
              subject, status, priority, category,
              resolution_time_hours, satisfaction_score,
              created_at, resolved_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            ON CONFLICT (platform, ticket_id)
            DO UPDATE SET
              status = EXCLUDED.status,
              priority = EXCLUDED.priority,
              resolution_time_hours = EXCLUDED.resolution_time_hours,
              satisfaction_score = EXCLUDED.satisfaction_score,
              resolved_at = EXCLUDED.resolved_at,
              updated_at = CURRENT_TIMESTAMP`,
            [
              contact.id,
              userId,
              'gorgias',
              ticket.id.toString(),
              ticket.subject || 'No subject',
              ticket.status || 'open',
              ticket.priority || 'normal',
              ticket.channel || 'email',
              resolutionTimeHours,
              satisfactionScore,
              new Date(ticket.created_datetime),
              ticket.closed_datetime ? new Date(ticket.closed_datetime) : null,
            ]
          );

          // Store ticket messages as interactions
          if (ticket.messages && ticket.messages.length > 0) {
            for (const message of ticket.messages) {
              // Analyze message with AI
              const analysis = await AIService.analyzeEmail(message.body_text || message.body_html || '');

              await query(
                `INSERT INTO interactions (
                  contact_id, user_id, platform, interaction_type, direction,
                  subject, content, sentiment, occurred_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                ON CONFLICT DO NOTHING`,
                [
                  contact.id,
                  userId,
                  'gorgias',
                  'support_message',
                  message.source.type === 'customer' ? 'inbound' : 'outbound',
                  ticket.subject || 'Support ticket',
                  message.body_text || message.body_html,
                  analysis.sentiment,
                  new Date(message.created_datetime),
                ]
              );
            }
          }

          // Update last contact date
          await ContactService.touchContact(contact.id);
        } catch (error) {
          console.error('Error syncing Gorgias ticket:', ticket.id, error);
        }
      }

      // Check for more pages
      cursor = response.data.meta?.next_cursor;
      hasMore = !!cursor && tickets.length > 0;
    }
  }

  // Get single ticket
  static async getTicket(userId, ticketId) {
    const config = await this.getConfig(userId);
    const client = this.getClient(config);

    const response = await client.get(`/tickets/${ticketId}`);
    return response.data;
  }

  // Get ticket messages
  static async getTicketMessages(userId, ticketId) {
    const config = await this.getConfig(userId);
    const client = this.getClient(config);

    const response = await client.get(`/tickets/${ticketId}/messages`);
    return response.data.data;
  }

  // Send message to ticket
  static async sendTicketMessage(
    userId,
    ticketId,
    message) {
    const config = await this.getConfig(userId);
    const client = this.getClient(config);

    const payload = {
      message: {
        body_text: message,
        channel: 'api',
      },
    };

    const response = await client.post(`/tickets/${ticketId}/messages`, payload);
    return response.data;
  }

  // Update ticket status
  static async updateTicketStatus(
    userId,
    ticketId,
    status'open' | 'closed' | 'pending'
  ) {
    const config = await this.getConfig(userId);
    const client = this.getClient(config);

    const payload = { status };

    const response = await client.put(`/tickets/${ticketId}`, payload);
    return response.data;
  }

  // Create Gorgias webhook
  static async createWebhook(
    userId,
    event,
    callbackUrl) {
    const config = await this.getConfig(userId);
    const client = this.getClient(config);

    const webhook = {
      url: callbackUrl,
      events: [event],
      actions: [],
    };

    const response = await client.post('/integrations/webhooks', webhook);
    return response.data;
  }

  // Setup recommended webhooks
  static async setupWebhooks(userId, baseUrl) {
    const events = [
      'ticket-created',
      'ticket-updated',
      'ticket-message-created',
    ];

    for (const event of events) {
      try {
        await this.createWebhook(
          userId,
          event,
          `${baseUrl}/api/webhooks/gorgias/${event}`
        );
      } catch (error) {
        console.error(`Error creating webhook for ${event}:`, error);
      }
    }
  }

  // Get customer satisfaction metrics
  static async getSatisfactionMetrics(userId) {
    const result = await query(
      `SELECT 
        COUNT(*) as total_tickets,
        AVG(satisfaction_score) as avg_satisfaction,
        COUNT(CASE WHEN satisfaction_score >= 4 THEN 1 END) as positive_count,
        COUNT(CASE WHEN satisfaction_score <= 2 THEN 1 END) as negative_count
       FROM support_tickets
       WHERE user_id = $1 AND platform = 'gorgias' AND satisfaction_score IS NOT NULL`,
      [userId]
    );

    return result.rows[0];
  }
}


module.exports = { GorgiasService };
