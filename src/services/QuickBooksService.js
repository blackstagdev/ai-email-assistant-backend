const axios = require('axios');
const { query } = require('../db');
const { ContactService } = require('./ContactService');



class QuickBooksService {
  private static readonly BASE_URL = 'https://quickbooks.api.intuit.com/v3/company';
  private static readonly AUTH_URL = 'https://oauth.platform.intuit.com/oauth2/v1';

  // Get QuickBooks API client
  private static getClient(accessToken, realmId) {
    return axios.create({
      baseURL: `${this.BASE_URL}/${realmId}`,
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
    });
  }

  // Get stored QuickBooks credentials
  private static async getConfig(userId) {
    const result = await query(
      `SELECT access_token, refresh_token, metadata, token_expires_at 
       FROM platform_integrations 
       WHERE user_id = $1 AND platform = 'quickbooks' AND is_connected = true`,
      [userId]
    );

    if (result.rows.length === 0) {
      throw new Error('QuickBooks not connected');
    }

    return {
      accessToken: result.rows[0].access_token,
      refreshToken: result.rows[0].refresh_token,
      realmId: result.rows[0].metadata?.realm_id,
      expiresAt: new Date(result.rows[0].token_expires_at),
    };
  }

  // Refresh access token
  private static async refreshAccessToken(userId, refreshToken) {
    const clientId = process.env.QUICKBOOKS_CLIENT_ID;
    const clientSecret = process.env.QUICKBOOKS_CLIENT_SECRET;
    
    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    const response = await axios.post(
      `${this.AUTH_URL}/tokens/bearer`,
      'grant_type=refresh_token&refresh_token=' + refreshToken,
      {
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );

    const expiresAt = new Date();
    expiresAt.setSeconds(expiresAt.getSeconds() + response.data.expires_in);

    // Update tokens
    await query(
      `UPDATE platform_integrations 
       SET access_token = $1, refresh_token = $2, token_expires_at = $3
       WHERE user_id = $4 AND platform = 'quickbooks'`,
      [response.data.access_token, response.data.refresh_token, expiresAt, userId]
    );
  }

  // Get valid access token
  private static async getValidAccessToken(userId) {
    const config = await this.getConfig(userId);

    // Refresh if expired or expires in < 10 minutes
    if (config.expiresAt.getTime() - Date.now() < 10 * 60 * 1000) {
      await this.refreshAccessToken(userId, config.refreshToken);
      const newConfig = await this.getConfig(userId);
      return { token: newConfig.accessToken, realmId: newConfig.realmId };
    }

    return { token: config.accessToken, realmId: config.realmId };
  }

  // Sync customers from QuickBooks
  static async syncCustomers(userId) {
    const { token, realmId } = await this.getValidAccessToken(userId);
    const client = this.getClient(token, realmId);

    let startPosition = 1;
    const maxResults = 1000;
    let hasMore = true;

    while (hasMore) {
      const query = `SELECT * FROM Customer STARTPOSITION ${startPosition} MAXRESULTS ${maxResults}`;
      const response = await client.get('/query', {
        params: { query, minorversion: 65 },
      });

      const customers = response.data.QueryResponse?.Customer || [];

      for (const customer of customers) {
        try {
          const email = customer.PrimaryEmailAddr?.Address;
          if (!email) continue;

          // Find or create contact
          const contact = await ContactService.findOrCreateByEmail(
            userId,
            email,
            {
              firstName: customer.GivenName,
              lastName: customer.FamilyName,
              company: customer.CompanyName,
              phone: customer.PrimaryPhone?.FreeFormNumber,
            }
          );

          // Link QuickBooks identity
          await ContactService.linkPlatformIdentity(
            contact.id,
            'quickbooks',
            customer.Id,
            {
              email,
              rawData: {
                displayName: customer.DisplayName,
                balance: customer.Balance,
                balanceWithJobs: customer.BalanceWithJobs,
              },
            }
          );

          // Update contact metadata
          await query(
            `UPDATE contacts 
             SET custom_fields = jsonb_set(
               COALESCE(custom_fields, '{}'::jsonb),
               '{quickbooks}',
               $1::jsonb
             )
             WHERE id = $2`,
            [
              JSON.stringify({
                customer_id: customer.Id,
                balance: customer.Balance || 0,
              }),
              contact.id,
            ]
          );
        } catch (error) {
          console.error('Error syncing QuickBooks customer:', customer.Id, error);
        }
      }

      hasMore = customers.length === maxResults;
      startPosition += maxResults;
    }
  }

  // Sync invoices
  static async syncInvoices(userId) {
    const { token, realmId } = await this.getValidAccessToken(userId);
    const client = this.getClient(token, realmId);

    let startPosition = 1;
    const maxResults = 1000;
    let hasMore = true;

    while (hasMore) {
      const query = `SELECT * FROM Invoice STARTPOSITION ${startPosition} MAXRESULTS ${maxResults}`;
      const response = await client.get('/query', {
        params: { query, minorversion: 65 },
      });

      const invoices = response.data.QueryResponse?.Invoice || [];

      for (const invoice of invoices) {
        try {
          // Get customer details
          const customerResponse = await client.get(`/customer/${invoice.CustomerRef.value}`);
          const customer = customerResponse.data.Customer;

          const email = customer.PrimaryEmailAddr?.Address;
          if (!email) continue;

          const contact = await ContactService.findOrCreateByEmail(userId, email);

          // Store invoice
          await query(
            `INSERT INTO financial_data (
              contact_id, user_id, platform, invoice_id,
              invoice_date, amount, payment_status, balance_due, payment_date
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            ON CONFLICT (platform, invoice_id)
            DO UPDATE SET
              amount = EXCLUDED.amount,
              payment_status = EXCLUDED.payment_status,
              balance_due = EXCLUDED.balance_due,
              payment_date = EXCLUDED.payment_date,
              updated_at = CURRENT_TIMESTAMP`,
            [
              contact.id,
              userId,
              'quickbooks',
              invoice.Id,
              new Date(invoice.TxnDate),
              parseFloat(invoice.TotalAmt || 0),
              invoice.Balance === 0 ? 'paid' : invoice.Balance < invoice.TotalAmt ? 'partial' : 'pending',
              parseFloat(invoice.Balance || 0),
              invoice.Balance === 0 && invoice.MetaData?.LastUpdatedTime 
                ? new Date(invoice.MetaData.LastUpdatedTime) 
                : null,
            ]
          );

          // Update contact revenue if paid
          if (invoice.Balance === 0) {
            await ContactService.updateFinancials(contact.id, parseFloat(invoice.TotalAmt || 0));
          }
        } catch (error) {
          console.error('Error syncing QuickBooks invoice:', invoice.Id, error);
        }
      }

      hasMore = invoices.length === maxResults;
      startPosition += maxResults;
    }
  }

  // Sync payments
  static async syncPayments(userId) {
    const { token, realmId } = await this.getValidAccessToken(userId);
    const client = this.getClient(token, realmId);

    const query = `SELECT * FROM Payment WHERE TxnDate >= '2024-01-01' MAXRESULTS 1000`;
    const response = await client.get('/query', {
      params: { query, minorversion: 65 },
    });

    const payments = response.data.QueryResponse?.Payment || [];

    for (const payment of payments) {
      try {
        // Get customer details
        const customerResponse = await client.get(`/customer/${payment.CustomerRef.value}`);
        const customer = customerResponse.data.Customer;

        const email = customer.PrimaryEmailAddr?.Address;
        if (!email) continue;

        const contact = await ContactService.findOrCreateByEmail(userId, email);

        // Record payment as interaction
        await query(
          `INSERT INTO interactions (
            contact_id, user_id, platform, interaction_type,
            subject, content, occurred_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT DO NOTHING`,
          [
            contact.id,
            userId,
            'quickbooks',
            'payment',
            `Payment received - $${payment.TotalAmt}`,
            `Payment of $${payment.TotalAmt} via ${payment.PaymentMethodRef?.name || 'Unknown'}`,
            new Date(payment.TxnDate),
          ]
        );
      } catch (error) {
        console.error('Error syncing QuickBooks payment:', payment.Id, error);
      }
    }
  }

  // Create invoice
  static async createInvoice(
    userId,
    invoiceData) {
    const { token, realmId } = await this.getValidAccessToken(userId);
    const client = this.getClient(token, realmId);

    const response = await client.post('/invoice', invoiceData, {
      params: { minorversion: 65 },
    });

    return response.data.Invoice;
  }

  // Get customer balance
  static async getCustomerBalance(
    userId,
    customerId) {
    const { token, realmId } = await this.getValidAccessToken(userId);
    const client = this.getClient(token, realmId);

    const response = await client.get(`/customer/${customerId}`, {
      params: { minorversion: 65 },
    });

    return parseFloat(response.data.Customer.Balance || 0);
  }
}


module.exports = { QuickBooksService };
