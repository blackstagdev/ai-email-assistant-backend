const axios = require('axios');
const { query } = require('../db');
const { ContactService } = require('./ContactService');

// ==================== GOOGLE ADS SERVICE ====================



class GoogleAdsService {
  private static readonly API_VERSION = 'v15';
  private static readonly BASE_URL = `https://googleads.googleapis.com/${this.API_VERSION}`;

  // Get stored Google Ads credentials
  private static async getConfig(userId) {
    const result = await query(
      `SELECT access_token, refresh_token, metadata 
       FROM platform_integrations 
       WHERE user_id = $1 AND platform = 'google_ads' AND is_connected = true`,
      [userId]
    );

    if (result.rows.length === 0) {
      throw new Error('Google Ads not connected');
    }

    return {
      accessToken: result.rows[0].access_token,
      refreshToken: result.rows[0].refresh_token,
      customerId: result.rows[0].metadata?.customer_id,
      developerToken: process.env.GOOGLE_ADS_DEVELOPER_TOKEN || '',
    };
  }

  // Get Google Ads API client
  private static getClient(config) {
    return axios.create({
      baseURL: this.BASE_URL,
      headers: {
        'Authorization': `Bearer ${config.accessToken}`,
        'developer-token': config.developerToken,
        'Content-Type': 'application/json',
      },
    });
  }

  // Sync conversion data (leads from ads)
  static async syncConversions(userId) {
    const config = await this.getConfig(userId);
    const client = this.getClient(config);

    // Query for conversions with customer info
    const queryStr = `
      SELECT
        click_view.gclid,
        metrics.conversions,
        metrics.conversions_value,
        campaign.name,
        ad_group.name,
        segments.conversion_action_name,
        segments.date,
        customer.id
      FROM click_view
      WHERE segments.date DURING LAST_30_DAYS
      AND metrics.conversions > 0
    `;

    try {
      const response = await client.post(
        `/customers/${config.customerId}/googleAds:search`,
        { query: queryStr }
      );

      const results = response.data.results || [];

      for (const result of results) {
        // Note: Google Ads doesn't directly provide email
        // You'd need to match GCLID with your own conversion tracking
        // This is a simplified version showing the structure

        const gclid = result.clickView?.gclid;
        const campaignName = result.campaign?.name;
        const conversionValue = parseFloat(result.metrics?.conversionsValue || 0);
        const date = result.segments?.date;

        // Store attribution data (would need to link to actual contact via your tracking)
        await query(
          `INSERT INTO analytics_events (user_id, event_type, event_data, occurred_at)
           VALUES ($1, $2, $3, $4)`,
          [
            userId,
            'google_ads_conversion',
            JSON.stringify({
              gclid,
              campaign,
              conversion_value,
              conversion_action: result.segments?.conversionActionName,
            }),
            new Date(date),
          ]
        );
      }
    } catch (error) {
      console.error('Error syncing Google Ads conversions:', error);
      throw error;
    }
  }

  // Get campaign performance
  static async getCampaignPerformance(userId) {
    const config = await this.getConfig(userId);
    const client = this.getClient(config);

    const queryStr = `
      SELECT
        campaign.id,
        campaign.name,
        campaign.status,
        metrics.impressions,
        metrics.clicks,
        metrics.cost_micros,
        metrics.conversions,
        metrics.conversions_value
      FROM campaign
      WHERE segments.date DURING LAST_30_DAYS
    `;

    const response = await client.post(
      `/customers/${config.customerId}/googleAds:search`,
      { query: queryStr }
    );

    return response.data.results || [];
  }
}

// ==================== META ADS SERVICE ====================



class MetaAdsService {
  private static readonly BASE_URL = 'https://graph.facebook.com/v18.0';

  // Get stored Meta Ads credentials
  private static async getConfig(userId) {
    const result = await query(
      `SELECT access_token, metadata 
       FROM platform_integrations 
       WHERE user_id = $1 AND platform = 'meta' AND is_connected = true`,
      [userId]
    );

    if (result.rows.length === 0) {
      throw new Error('Meta Ads not connected');
    }

    return {
      accessToken: result.rows[0].access_token,
      adAccountId: result.rows[0].metadata?.ad_account_id,
    };
  }

  // Get Meta API client
  private static getClient(accessToken) {
    return axios.create({
      baseURL: this.BASE_URL,
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    });
  }

  // Sync leads from lead ads
  static async syncLeads(userId) {
    const config = await this.getConfig(userId);
    const client = this.getClient(config.accessToken);

    // Get lead gen forms
    const formsResponse = await client.get(`/act_${config.adAccountId}/leadgen_forms`);
    const forms = formsResponse.data.data || [];

    for (const form of forms) {
      try {
        // Get leads for this form
        const leadsResponse = await client.get(`/${form.id}/leads`, {
          params: {
            fields: 'id,created_time,field_data',
          },
        });

        const leads = leadsResponse.data.data || [];

        for (const lead of leads) {
          // Extract email and name from field_data
          const fieldData = lead.field_data || [];
          const emailField = fieldData.find((f) => f.name === 'email');
          const firstNameField = fieldData.find((f) => f.name === 'first_name');
          const lastNameField = fieldData.find((f) => f.name === 'last_name');
          const phoneField = fieldData.find((f) => f.name === 'phone');

          if (!emailField?.values?.[0]) continue;

          const email = emailField.values[0];

          // Find or create contact
          const contact = await ContactService.findOrCreateByEmail(
            userId,
            email,
            {
              firstName: firstNameField?.values?.[0],
              lastName: lastNameField?.values?.[0],
              phone: phoneField?.values?.[0],
              relationshipType: 'lead',
            }
          );

          // Link Meta identity
          await ContactService.linkPlatformIdentity(
            contact.id,
            'meta',
            lead.id,
            {
              email,
              rawData: {
                form_id: form.id,
                form_name: form.name,
                created_time: lead.created_time,
              },
            }
          );

          // Store marketing attribution
          await query(
            `INSERT INTO marketing_attribution (
              contact_id, user_id, source, medium, ad_platform, first_touch_date
            ) VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT DO NOTHING`,
            [
              contact.id,
              userId,
              'facebook',
              'paid',
              'meta',
              new Date(lead.created_time),
            ]
          );
        }
      } catch (error) {
        console.error('Error syncing Meta leads for form:', form.id, error);
      }
    }
  }

  // Get campaign performance
  static async getCampaignPerformance(userId) {
    const config = await this.getConfig(userId);
    const client = this.getClient(config.accessToken);

    const response = await client.get(`/act_${config.adAccountId}/campaigns`, {
      params: {
        fields: 'id,name,status,objective,insights{spend,impressions,clicks,actions,cost_per_action_type}',
        time_range: JSON.stringify({ since: '30 days ago', until: 'today' }),
      },
    });

    return response.data.data || [];
  }

  // Get ad account insights
  static async getAccountInsights(userId) {
    const config = await this.getConfig(userId);
    const client = this.getClient(config.accessToken);

    const response = await client.get(`/act_${config.adAccountId}/insights`, {
      params: {
        fields: 'spend,impressions,clicks,actions,cost_per_action_type,action_values',
        time_range: JSON.stringify({ since: '30 days ago', until: 'today' }),
        level: 'account',
      },
    });

    return response.data.data?.[0] || {};
  }
}

// ==================== GOOGLE ANALYTICS SERVICE ====================



class GoogleAnalyticsService {
  private static readonly BASE_URL = 'https://analyticsdata.googleapis.com/v1beta';

  // Get stored GA credentials
  private static async getConfig(userId) {
    const result = await query(
      `SELECT access_token, metadata 
       FROM platform_integrations 
       WHERE user_id = $1 AND platform = 'google_analytics' AND is_connected = true`,
      [userId]
    );

    if (result.rows.length === 0) {
      throw new Error('Google Analytics not connected');
    }

    return {
      accessToken: result.rows[0].access_token,
      propertyId: result.rows[0].metadata?.property_id,
    };
  }

  // Get GA API client
  private static getClient(accessToken) {
    return axios.create({
      baseURL: this.BASE_URL,
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });
  }

  // Get traffic and conversion data
  static async getTrafficData(userId) {
    const config = await this.getConfig(userId);
    const client = this.getClient(config.accessToken);

    const reportRequest = {
      dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }],
      dimensions: [
        { name: 'sessionSource' },
        { name: 'sessionMedium' },
        { name: 'sessionCampaignName' },
      ],
      metrics: [
        { name: 'sessions' },
        { name: 'totalUsers' },
        { name: 'conversions' },
        { name: 'totalRevenue' },
      ],
    };

    const response = await client.post(
      `/properties/${config.propertyId}:runReport`,
      reportRequest
    );

    return response.data;
  }

  // Store analytics data for attribution
  static async storeAttributionData(userId) {
    const data = await this.getTrafficData(userId);

    for (const row of data.rows || []) {
      const source = row.dimensionValues[0]?.value;
      const medium = row.dimensionValues[1]?.value;
      const campaign = row.dimensionValues[2]?.value;
      const conversions = parseInt(row.metricValues[2]?.value || 0);
      const revenue = parseFloat(row.metricValues[3]?.value || 0);

      if (conversions > 0) {
        await query(
          `INSERT INTO analytics_events (user_id, event_type, event_data)
           VALUES ($1, $2, $3)`,
          [
            userId,
            'ga_attribution',
            JSON.stringify({
              source,
              medium,
              campaign,
              conversions,
              revenue,
            }),
          ]
        );
      }
    }
  }
}


module.exports = { GoogleAdsService };
