const axios = require('axios');
const { query } = require('../db');
const { ContactService } = require('./ContactService');



class ShipStationService {
  private static readonly BASE_URL = 'https://ssapi.shipstation.com';

  // Get ShipStation API client
  private static getClient(config) {
    const auth = Buffer.from(`${config.apiKey}:${config.apiSecret}`).toString('base64');
    
    return axios.create({
      baseURL: this.BASE_URL,
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
    });
  }

  // Get stored ShipStation credentials
  private static async getConfig(userId) {
    const result = await query(
      `SELECT metadata FROM platform_integrations 
       WHERE user_id = $1 AND platform = 'shipstation' AND is_connected = true`,
      [userId]
    );

    if (result.rows.length === 0) {
      throw new Error('ShipStation not connected');
    }

    const metadata = result.rows[0].metadata;
    return {
      apiKey: metadata.api_key,
      apiSecret: metadata.api_secret,
    };
  }

  // Sync shipments from ShipStation
  static async syncShipments(
    userId,
    options: { sinceDate?: Date } = {}
  ) {
    const config = await this.getConfig(userId);
    const client = this.getClient(config);

    let page = 1;
    const pageSize = 500;
    let hasMore = true;

    while (hasMore) {
      const params = {
        page,
        pageSize,
        sortBy: 'ModifyDate',
        sortDir: 'DESC',
      };

      if (options.sinceDate) {
        params.modifyDateStart = options.sinceDate.toISOString();
      }

      const response = await client.get('/shipments', { params });
      const shipments = response.data.shipments;

      for (const shipment of shipments) {
        try {
          const customerEmail = shipment.shipTo?.email;
          if (!customerEmail) continue;

          // Find or create contact
          const contact = await ContactService.findOrCreateByEmail(
            userId,
            customerEmail,
            {
              firstName: shipment.shipTo?.name?.split(' ')[0],
              lastName: shipment.shipTo?.name?.split(' ').slice(1).join(' '),
              phone: shipment.shipTo?.phone,
            }
          );

          // Update commerce data with shipping info
          await query(
            `UPDATE commerce_data
             SET custom_fields = jsonb_set(
               COALESCE(custom_fields, '{}'::jsonb),
               '{shipstation}',
               $1::jsonb
             )
             WHERE platform_order_id = $2 AND platform = 'shopify'`,
            [
              JSON.stringify({
                shipment_id: shipment.shipmentId,
                tracking_number: shipment.trackingNumber,
                carrier: shipment.carrierCode,
                service: shipment.serviceCode,
                ship_date: shipment.shipDate,
                delivery_date: shipment.deliveryDate,
                status: shipment.voided ? 'voided' : 'shipped',
              }),
              shipment.orderNumber,
            ]
          );

          // Store shipping event(
            `INSERT INTO interactions (
              contact_id, user_id, platform, interaction_type,
              subject, content, occurred_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT DO NOTHING`,
            [
              contact.id,
              userId,
              'shipstation',
              'shipment',
              `Order ${shipment.orderNumber} shipped`,
              `Shipped via ${shipment.carrierCode} - Tracking: ${shipment.trackingNumber}`,
              new Date(shipment.shipDate),
            ]
          );
        } catch (error) {
          console.error('Error syncing ShipStation shipment:', shipment.shipmentId, error);
        }
      }

      hasMore = shipments.length === pageSize;
      page++;
    }
  }

  // Get shipment by order number
  static async getShipmentByOrder(userId, orderNumber) {
    const config = await this.getConfig(userId);
    const client = this.getClient(config);

    const response = await client.get('/shipments', {
      params: { orderNumber },
    });

    return response.data.shipments[0] || null;
  }

  // Get tracking information
  static async getTracking(userId, trackingNumber) {
    const config = await this.getConfig(userId);
    const client = this.getClient(config);

    // ShipStation doesn't have direct tracking endpoint, but we can get shipment info
    const response = await client.get('/shipments', {
      params: { trackingNumber },
    });

    return response.data.shipments[0] || null;
  }

  // Create shipment label
  static async createShipmentLabel(
    userId,
    shipmentData) {
    const config = await this.getConfig(userId);
    const client = this.getClient(config);

    const response = await client.post('/shipments/createlabel', shipmentData);
    return response.data;
  }

  // Subscribe to ShipStation webhooks
  static async subscribeToWebhook(
    userId,
    event,
    callbackUrl) {
    const config = await this.getConfig(userId);
    const client = this.getClient(config);

    const webhook = {
      target_url,
      event,
      store_id, // null subscribes to all stores
      friendly_name: `AI Assistant - ${event}`,
    };

    const response = await client.post('/webhooks/subscribe', webhook);
    return response.data;
  }

  // Setup recommended webhooks
  static async setupWebhooks(userId, baseUrl) {
    const events = [
      'ORDER_NOTIFY',      // New order
      'ITEM_ORDER_NOTIFY', // Order item changed
      'SHIP_NOTIFY',       // Order shipped
    ];

    for (const event of events) {
      try {
        await this.subscribeToWebhook(
          userId,
          event,
          `${baseUrl}/api/webhooks/shipstation/${event.toLowerCase()}`
        );
      } catch (error) {
        console.error(`Error creating webhook for ${event}:`, error);
      }
    }
  }
}


module.exports = { ShipStationService };
