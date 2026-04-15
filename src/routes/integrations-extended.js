const { Router, Response } = require('express');
const { AuthRequest, authMiddleware } = require('../middleware/auth');
const { query } = require('../db');
const { ShopifyService } = require('../services/ShopifyService');
const { GorgiasService } = require('../services/GorgiasService');
const { ShipStationService } = require('../services/ShipStationService');
const { SlackService } = require('../services/SlackService');
const { z } = require('zod');

const router = Router();
router.use(authMiddleware);

// ==================== SHOPIFY ROUTES ====================

// POST /api/integrations/shopify/connect - Connect Shopify store
router.post('/shopify/connect', async (req, res) => {
  try {
    const userId = req.user!.userId;
    const schema = z.object({
      shopDomain: z.string(),
      accessToken: z.string(),
    });

    const { shopDomain, accessToken } = schema.parse(req.body);

    // Store integration
    await query(
      `INSERT INTO platform_integrations (
        user_id, platform, is_connected, metadata
      ) VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_id, platform)
      DO UPDATE SET
        is_connected = true,
        metadata = EXCLUDED.metadata,
        updated_at = CURRENT_TIMESTAMP`,
      [
        userId,
        'shopify',
        true,
        JSON.stringify({ shop_domain, access_token: accessToken }),
      ]
    );

    res.json({ message: 'Shopify connected successfully' });
  } catch (error) {
    console.error('Error connecting Shopify:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/integrations/shopify/sync - Sync Shopify data
router.post('/shopify/sync', async (req, res) => {
  try {
    const userId = req.user!.userId;

    // Sync customers and orders
    await Promise.all([
      ShopifyService.syncCustomers(userId),
      ShopifyService.syncOrders(userId),
    ]);

    // Update last sync timestamp
    await query(
      `UPDATE platform_integrations 
       SET last_sync_at = CURRENT_TIMESTAMP 
       WHERE user_id = $1 AND platform = 'shopify'`,
      [userId]
    );

    res.json({ message: 'Shopify sync completed' });
  } catch (error) {
    console.error('Error syncing Shopify:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==================== GORGIAS ROUTES ====================

// POST /api/integrations/gorgias/connect - Connect Gorgias
router.post('/gorgias/connect', async (req, res) => {
  try {
    const userId = req.user!.userId;
    const schema = z.object({
      domain: z.string(),
      email: z.string().email(),
      apiKey: z.string(),
    });

    const { domain, email, apiKey } = schema.parse(req.body);

    // Store integration
    await query(
      `INSERT INTO platform_integrations (
        user_id, platform, is_connected, metadata
      ) VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_id, platform)
      DO UPDATE SET
        is_connected = true,
        metadata = EXCLUDED.metadata,
        updated_at = CURRENT_TIMESTAMP`,
      [
        userId,
        'gorgias',
        true,
        JSON.stringify({ domain, email, api_key: apiKey }),
      ]
    );

    res.json({ message: 'Gorgias connected successfully' });
  } catch (error) {
    console.error('Error connecting Gorgias:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/integrations/gorgias/sync - Sync Gorgias tickets
router.post('/gorgias/sync', async (req, res) => {
  try {
    const userId = req.user!.userId;

    // Sync tickets from last 30 days
    const sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - 30);

    await GorgiasService.syncTickets(userId, { sinceDate });

    // Update last sync timestamp
    await query(
      `UPDATE platform_integrations 
       SET last_sync_at = CURRENT_TIMESTAMP 
       WHERE user_id = $1 AND platform = 'gorgias'`,
      [userId]
    );

    res.json({ message: 'Gorgias sync completed' });
  } catch (error) {
    console.error('Error syncing Gorgias:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/integrations/gorgias/satisfaction - Get satisfaction metrics
router.get('/gorgias/satisfaction', async (req, res) => {
  try {
    const userId = req.user!.userId;
    const metrics = await GorgiasService.getSatisfactionMetrics(userId);
    res.json(metrics);
  } catch (error) {
    console.error('Error fetching satisfaction metrics:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==================== SHIPSTATION ROUTES ====================

// POST /api/integrations/shipstation/connect - Connect ShipStation
router.post('/shipstation/connect', async (req, res) => {
  try {
    const userId = req.user!.userId;
    const schema = z.object({
      apiKey: z.string(),
      apiSecret: z.string(),
    });

    const { apiKey, apiSecret } = schema.parse(req.body);

    // Store integration
    await query(
      `INSERT INTO platform_integrations (
        user_id, platform, is_connected, metadata
      ) VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_id, platform)
      DO UPDATE SET
        is_connected = true,
        metadata = EXCLUDED.metadata,
        updated_at = CURRENT_TIMESTAMP`,
      [
        userId,
        'shipstation',
        true,
        JSON.stringify({ api_key, api_secret: apiSecret }),
      ]
    );

    res.json({ message: 'ShipStation connected successfully' });
  } catch (error) {
    console.error('Error connecting ShipStation:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/integrations/shipstation/sync - Sync ShipStation shipments
router.post('/shipstation/sync', async (req, res) => {
  try {
    const userId = req.user!.userId;

    // Sync shipments from last 30 days
    const sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - 30);

    await ShipStationService.syncShipments(userId, { sinceDate });

    // Update last sync timestamp
    await query(
      `UPDATE platform_integrations 
       SET last_sync_at = CURRENT_TIMESTAMP 
       WHERE user_id = $1 AND platform = 'shipstation'`,
      [userId]
    );

    res.json({ message: 'ShipStation sync completed' });
  } catch (error) {
    console.error('Error syncing ShipStation:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/integrations/shipstation/tracking/:orderNumber - Get tracking info
router.get('/shipstation/tracking/:orderNumber', async (req, res) => {
  try {
    const userId = req.user!.userId;
    const { orderNumber } = req.params;

    const shipment = await ShipStationService.getShipmentByOrder(userId, orderNumber);
    res.json({ shipment });
  } catch (error) {
    console.error('Error fetching tracking:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==================== SLACK ROUTES ====================

// GET /api/integrations/slack/connect - Get Slack OAuth URL
router.get('/slack/connect', async (req, res) => {
  try {
    const clientId = process.env.SLACK_CLIENT_ID;
    const redirectUri = process.env.SLACK_REDIRECT_URI || 'http://localhost:3000/api/integrations/slack/callback';
    const scopes = [
      'channels:history',
      'channels:read',
      'chat:write',
      'im:history',
      'im:read',
      'users:read',
      'users:read.email',
    ].join(',');

    const authUrl = `https://slack.com/oauth/v2/authorize?client_id=${clientId}&scope=${scopes}&redirect_uri=${encodeURIComponent(redirectUri)}`;

    res.json({ authUrl });
  } catch (error) {
    console.error('Error generating Slack auth URL:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/integrations/slack/callback - Slack OAuth callback
router.get('/slack/callback', async (req, res) => {
  try {
    const { code, state } = req.query;

    if (!code) {
      return res.status(400).json({ error: 'No code provided' });
    }

    // Exchange code for tokens
    const tokens = await SlackService.exchangeCodeForTokens(code);

    // Get user ID from state (you'd need to implement state management)
    const userId = req.user!.userId;

    // Store integration
    await query(
      `INSERT INTO platform_integrations (
        user_id, platform, is_connected, access_token, metadata
      ) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (user_id, platform)
      DO UPDATE SET
        is_connected = true,
        access_token = EXCLUDED.access_token,
        metadata = EXCLUDED.metadata,
        updated_at = CURRENT_TIMESTAMP`,
      [
        userId,
        'slack',
        true,
        tokens.access_token,
        JSON.stringify({
          bot_token: tokens.bot_user_id,
          team_id: tokens.team.id,
          team_name: tokens.team.name,
        }),
      ]
    );

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    res.redirect(`${frontendUrl}/settings/integrations?success=slack`);
  } catch (error) {
    console.error('Error in Slack callback:', error);
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    res.redirect(`${frontendUrl}/settings/integrations?error=slack`);
  }
});

// POST /api/integrations/slack/sync - Sync Slack messages
router.post('/slack/sync', async (req, res) => {
  try {
    const userId = req.user!.userId;

    await SlackService.syncMessages(userId);

    // Update last sync timestamp
    await query(
      `UPDATE platform_integrations 
       SET last_sync_at = CURRENT_TIMESTAMP 
       WHERE user_id = $1 AND platform = 'slack'`,
      [userId]
    );

    res.json({ message: 'Slack sync completed' });
  } catch (error) {
    console.error('Error syncing Slack:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/integrations/slack/send - Send Slack message
router.post('/slack/send', async (req, res) => {
  try {
    const userId = req.user!.userId;
    const schema = z.object({
      channel: z.string(),
      text: z.string(),
    });

    const { channel, text } = schema.parse(req.body);

    const result = await SlackService.sendMessage(userId, channel, text);
    res.json(result);
  } catch (error) {
    console.error('Error sending Slack message:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
