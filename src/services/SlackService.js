const axios = require('axios');
const { query } = require('../db');
const { ContactService } = require('./ContactService');



class SlackService {
  static BASE_URL = 'https://slack.com/api';

  // Get Slack API client
  static getClient(token) {
    return axios.create({
      baseURL: this.BASE_URL,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });
  }

  // Get stored Slack credentials
  static async getConfig(userId) {
    const result = await query(
      `SELECT access_token, metadata FROM platform_integrations 
       WHERE user_id = $1 AND platform = 'slack' AND is_connected = true`,
      [userId]
    );

    if (result.rows.length === 0) {
      throw new Error('Slack not connected');
    }

    return {
      accessToken: result.rows[0].access_token,
      botToken: result.rows[0].metadata?.bot_token,
    };
  }

  // Exchange OAuth code for tokens
  static async exchangeCodeForTokens(code) {
    const clientId = process.env.SLACK_CLIENT_ID;
    const clientSecret = process.env.SLACK_CLIENT_SECRET;
    const redirectUri = process.env.SLACK_REDIRECT_URI || 'http://localhost:3000/api/integrations/slack/callback';

    const response = await axios.post(`${this.BASE_URL}/oauth.v2.access`, null, {
      params: {
        client_id,
        client_secret,
        code,
        redirect_uri,
      },
    });

    return response.data;
  }

  // Get workspace users
  static async getUsers(userId) {
    const config = await this.getConfig(userId);
    const client = this.getClient(config.accessToken);

    const response = await client.get('/users.list');
    return response.data.members || [];
  }

  // Get direct messages with external contacts
  static async getConversations(userId) {
    const config = await this.getConfig(userId);
    const client = this.getClient(config.accessToken);

    const response = await client.get('/conversations.list', {
      params: {
        types: 'im,mpim', // Direct messages
        limit: 1000,
      },
    });

    return response.data.channels || [];
  }

  // Get messages from a conversation
  static async getConversationHistory(
    userId,
    channelId,
    options =  {}
  ) {
    const config = await this.getConfig(userId);
    const client = this.getClient(config.accessToken);

    const response = await client.get('/conversations.history', {
      params: {
        channel,
        limit: 1000,
        ...options,
      },
    });

    return response.data.messages || [];
  }

  // Sync Slack messages
  static async syncMessages(
    userId,
    options =  {}
  ) {
    const config = await this.getConfig(userId);
    const client = this.getClient(config.accessToken);

    // Get all conversations
    const conversations = await this.getConversations(userId);

    for (const conversation of conversations) {
      try {
        const messages = await this.getConversationHistory(
          userId,
          conversation.id,
          { oldest: options.sinceTimestamp }
        );

        for (const message of messages) {
          // Skip bot messages
          if (message.bot_id) continue;

          // Get user info
          const userResponse = await client.get('/users.info', {
            params: { user: message.user },
          });

          const user = userResponse.data.user;
          const email = user.profile?.email;

          if (!email) continue;

          // Find or create contact
          const contact = await ContactService.findOrCreateByEmail(
            userId,
            email,
            {
              firstName: user.real_name?.split(' ')[0],
              lastName: user.real_name?.split(' ').slice(1).join(' '),
            }
          );

          // Link Slack identity
          await ContactService.linkPlatformIdentity(
            contact.id,
            'slack',
            user.id,
            {
              email,
              username: user.name,
              rawData: {
                real_name: user.real_name,
                display_name: user.profile?.display_name,
                title: user.profile?.title,
              },
            }
          );

          // Store message as interaction
          await query(
            `INSERT INTO interactions (
              contact_id, user_id, platform, interaction_type,
              content, occurred_at
            ) VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT DO NOTHING`,
            [
              contact.id,
              userId,
              'slack',
              'message',
              message.text,
              new Date(parseFloat(message.ts) * 1000),
            ]
          );

          // Update last contact date
          await ContactService.touchContact(contact.id);
        }
      } catch (error) {
        console.error('Error syncing Slack conversation:', conversation.id, error);
      }
    }
  }

  // Send message to Slack channel/user
  static async sendMessage(
    userId,
    channel,
    text) {
    const config = await this.getConfig(userId);
    const client = this.getClient(config.botToken || config.accessToken);

    const response = await client.post('/chat.postMessage', {
      channel,
      text,
    });

    return response.data;
  }

  // Search messages
  static async searchMessages(userId, query) {
    const config = await this.getConfig(userId);
    const client = this.getClient(config.accessToken);

    const response = await client.get('/search.messages', {
      params,
    });

    return response.data.messages?.matches || [];
  }

  // Get user by email
  static async getUserByEmail(userId, email) {
    const config = await this.getConfig(userId);
    const client = this.getClient(config.accessToken);

    const response = await client.get('/users.lookupByEmail', {
      params,
    });

    return response.data.user;
  }

  // Create reminder about contact
  static async createReminder(
    userId,
    text,
    time) {
    const config = await this.getConfig(userId);
    const client = this.getClient(config.accessToken);

    const response = await client.post('/reminders.add', {
      text,
      time,
    });

    return response.data;
  }
}


module.exports = { SlackService };
