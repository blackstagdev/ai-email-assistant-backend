const axios = require('axios');
const { query } = require('../db');
const { ContactService } = require('./ContactService');



class ShopifyService {
  private static readonly API_VERSION = '2024-01';

  // Get Shopify API client
  private static getClient(config) {
    return axios.create({
      baseURL: `https://${config.shopDomain}/admin/api/${this.API_VERSION}`,
      headers: {
        'X-Shopify-Access-Token': config.accessToken,
        'Content-Type': 'application/json',
      },
    });
  }

  // Get stored Shopify credentials
  private static async getConfig(userId) {
    const result = await query(
      `SELECT metadata FROM platform_integrations 
       WHERE user_id = $1 AND platform = 'shopify' AND is_connected = true`,
      [userId]
    );

    if (result.rows.length === 0) {
      throw new Error('Shopify not connected');
    }

    const metadata = result.rows[0].metadata;
    return {
      shopDomain: metadata.shop_domain,
      accessToken: metadata.access_token,
    };
  }

  // Sync customers from Shopify
  static async syncCustomers(userId, options: { sinceDate?: Date } = {}) {
    const config = await this.getConfig(userId);
    const client = this.getClient(config);

    let hasNextPage = true;
    let pageInfo = null;

    while (hasNextPage) {
      const params = { limit: 250 };
      
      if (options.sinceDate) {
        params.updated_at_min = options.sinceDate.toISOString();
      }
      
      if (pageInfo) {
        params.page_info = pageInfo;
      }

      const response = await client.get('/customers.json', { params });
      const customers = response.data.customers;

      for (const customer of customers) {
        try {
          // Find or create contact
          const contact = await ContactService.findOrCreateByEmail(userId, customer.email, {
            firstName: customer.first_name,
            lastName: customer.last_name,
            phone: customer.phone,
            tags: customer.tags ? customer.tags.split(',').map((t) => t.trim()) : [],
          });

          // Link Shopify identity
          await ContactService.linkPlatformIdentity(
            contact.id,
            'shopify',
            customer.id.toString(),
            {
              email: customer.email,
              rawData: {
                verified_email: customer.verified_email,
                accepts_marketing: customer.accepts_marketing,
                marketing_opt_in_level: customer.marketing_opt_in_level,
                created_at: customer.created_at,
              },
            }
          );

          // Update contact metadata
          await query(
            `UPDATE contacts 
             SET custom_fields = jsonb_set(
               COALESCE(custom_fields, '{}'::jsonb),
               '{shopify}',
               $1::jsonb
             )
             WHERE id = $2`,
            [
              JSON.stringify({
                customer_id: customer.id,
                accepts_marketing: customer.accepts_marketing,
                total_spent: customer.total_spent,
                orders_count: customer.orders_count,
              }),
              contact.id,
            ]
          );
        } catch (error) {
          console.error('Error syncing Shopify customer:', customer.id, error);
        }
      }

      // Check for next page
      const linkHeader = response.headers.link;
      hasNextPage = linkHeader && linkHeader.includes('rel="next"');
      
      if (hasNextPage) {
        const match = linkHeader.match(/page_info=([^&>]+)/);
        pageInfo = match ? match[1] : null;
      }
    }
  }

  // Sync orders from Shopify
  static async syncOrders(userId, options: { sinceDate?: Date } = {}) {
    const config = await this.getConfig(userId);
    const client = this.getClient(config);

    let hasNextPage = true;
    let pageInfo = null;

    while (hasNextPage) {
      const params = { limit: 250, status: 'any' };
      
      if (options.sinceDate) {
        params.updated_at_min = options.sinceDate.toISOString();
      }
      
      if (pageInfo) {
        params.page_info = pageInfo;
      }

      const response = await client.get('/orders.json', { params });
      const orders = response.data.orders;

      for (const order of orders) {
        try {
          if (!order.email) continue;

          // Find contact by email
          const contact = await ContactService.findOrCreateByEmail(userId, order.email, {
            firstName: order.customer?.first_name,
            lastName: order.customer?.last_name,
            phone: order.customer?.phone,
          });

          // Store order
          await query(
            `INSERT INTO commerce_data (
              contact_id, user_id, platform, platform_order_id,
              order_date, order_total, items, fulfillment_status, payment_status,
              shipping_address
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            ON CONFLICT (platform, platform_order_id)
            DO UPDATE SET
              order_total = EXCLUDED.order_total,
              fulfillment_status = EXCLUDED.fulfillment_status,
              payment_status = EXCLUDED.payment_status,
              updated_at = CURRENT_TIMESTAMP`,
            [
              contact.id,
              userId,
              'shopify',
              order.id.toString(),
              new Date(order.created_at),
              parseFloat(order.total_price),
              JSON.stringify(
                order.line_items.map((item) => ({
                  name: item.name,
                  quantity: item.quantity,
                  price: item.price,
                  sku: item.sku,
                }))
              ),
              order.fulfillment_status || 'unfulfilled',
              order.financial_status || 'pending',
              JSON.stringify(order.shipping_address),
            ]
          );

          // Update contact revenue
          await ContactService.updateFinancials(contact.id, parseFloat(order.total_price));

          // Update last contact date
          await ContactService.touchContact(contact.id);
        } catch (error) {
          console.error('Error syncing Shopify order:', order.id, error);
        }
      }

      // Check for next page
      const linkHeader = response.headers.link;
      hasNextPage = linkHeader && linkHeader.includes('rel="next"');
      
      if (hasNextPage) {
        const match = linkHeader.match(/page_info=([^&>]+)/);
        pageInfo = match ? match[1] : null;
      }
    }
  }

  // Get single customer
  static async getCustomer(userId, customerId) {
    const config = await this.getConfig(userId);
    const client = this.getClient(config);

    const response = await client.get(`/customers/${customerId}.json`);
    return response.data.customer;
  }

  // Get customer orders
  static async getCustomerOrders(userId, customerId) {
    const config = await this.getConfig(userId);
    const client = this.getClient(config);

    const response = await client.get(`/customers/${customerId}/orders.json`);
    return response.data.orders;
  }

  // Create Shopify webhook
  static async createWebhook(
    userId,
    topic,
    callbackUrl) {
    const config = await this.getConfig(userId);
    const client = this.getClient(config);

    const webhook = {
      webhook: {
        topic,
        address,
        format: 'json',
      },
    };

    const response = await client.post('/webhooks.json', webhook);
    return response.data.webhook;
  }

  // Setup recommended webhooks
  static async setupWebhooks(userId, baseUrl) {
    const webhooks = [
      'customers/create',
      'customers/update',
      'orders/create',
      'orders/updated',
      'orders/fulfilled',
    ];

    for (const topic of webhooks) {
      try {
        await this.createWebhook(
          userId,
          topic,
          `${baseUrl}/api/webhooks/shopify/${topic.replace('/', '-')}`
        );
      } catch (error) {
        console.error(`Error creating webhook for ${topic}:`, error);
      }
    }
  }
}


module.exports = { ShopifyService };
