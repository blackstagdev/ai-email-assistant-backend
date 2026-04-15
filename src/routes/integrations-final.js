const { Router, Response } = require('express');
const { AuthRequest, authMiddleware } = require('../middleware/auth');
const { query } = require('../db');
const { ClickUpService } = require('../services/ClickUpService');
const { GoHighLevelService } = require('../services/GoHighLevelService');
const { QuickBooksService } = require('../services/QuickBooksService');
const { GoogleAdsService, MetaAdsService, GoogleAnalyticsService } = require('../services/AdsAnalyticsService');
const { z } = require('zod');

const router = Router();
router.use(authMiddleware);

// ==================== CLICKUP ROUTES ====================

// GET /api/integrations/clickup/connect - Get ClickUp OAuth URL
router.get('/clickup/connect', async (req, res) => {
  try {
    const clientId = process.env.CLICKUP_CLIENT_ID;
    const redirectUri = process.env.CLICKUP_REDIRECT_URI || 'http://localhost:3000/api/integrations/clickup/callback';

    const authUrl = `https://app.clickup.com/api?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}`;

    res.json({ authUrl });
  } catch (error) {
    console.error('Error generating ClickUp auth URL:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/integrations/clickup/callback - ClickUp OAuth callback
router.get('/clickup/callback', async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) {
      return res.status(400).json({ error: 'No code provided' });
    }

    const tokens = await ClickUpService.exchangeCodeForTokens(code);
    const userId = req.user!.userId;

    // Get teams
    const teams = await ClickUpService.getTeams(tokens.access_token);
    const teamId = teams[0]?.id;

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
      [userId, 'clickup', true, tokens.access_token, JSON.stringify({ team_id: teamId })]
    );

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    res.redirect(`${frontendUrl}/settings/integrations?success=clickup`);
  } catch (error) {
    console.error('Error in ClickUp callback:', error);
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    res.redirect(`${frontendUrl}/settings/integrations?error=clickup`);
  }
});

// POST /api/integrations/clickup/sync - Sync ClickUp tasks
router.post('/clickup/sync', async (req, res) => {
  try {
    const userId = req.user!.userId;
    await ClickUpService.syncTasks(userId);

    await query(
      `UPDATE platform_integrations SET last_sync_at = CURRENT_TIMESTAMP 
       WHERE user_id = $1 AND platform = 'clickup'`,
      [userId]
    );

    res.json({ message: 'ClickUp sync completed' });
  } catch (error) {
    console.error('Error syncing ClickUp:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==================== GOHIGHLEVEL ROUTES ====================

// GET /api/integrations/gohighlevel/connect - Get GHL OAuth URL
router.get('/gohighlevel/connect', async (req, res) => {
  try {
    const clientId = process.env.GHL_CLIENT_ID;
    const redirectUri = process.env.GHL_REDIRECT_URI || 'http://localhost:3000/api/integrations/gohighlevel/callback';
    
    const authUrl = `https://marketplace.gohighlevel.com/oauth/chooselocation?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=contacts.readonly conversations.readonly opportunities.readonly`;

    res.json({ authUrl });
  } catch (error) {
    console.error('Error generating GHL auth URL:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/integrations/gohighlevel/sync - Sync GHL data
router.post('/gohighlevel/sync', async (req, res) => {
  try {
    const userId = req.user!.userId;

    await Promise.all([
      GoHighLevelService.syncContacts(userId),
      GoHighLevelService.syncOpportunities(userId),
      GoHighLevelService.syncConversations(userId),
    ]);

    await query(
      `UPDATE platform_integrations SET last_sync_at = CURRENT_TIMESTAMP 
       WHERE user_id = $1 AND platform = 'gohighlevel'`,
      [userId]
    );

    res.json({ message: 'GoHighLevel sync completed' });
  } catch (error) {
    console.error('Error syncing GHL:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==================== QUICKBOOKS ROUTES ====================

// GET /api/integrations/quickbooks/connect - Get QuickBooks OAuth URL
router.get('/quickbooks/connect', async (req, res) => {
  try {
    const clientId = process.env.QUICKBOOKS_CLIENT_ID;
    const redirectUri = process.env.QUICKBOOKS_REDIRECT_URI || 'http://localhost:3000/api/integrations/quickbooks/callback';
    const scopes = 'com.intuit.quickbooks.accounting';

    const authUrl = `https://appcenter.intuit.com/connect/oauth2?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${scopes}&state=security_token`;

    res.json({ authUrl });
  } catch (error) {
    console.error('Error generating QuickBooks auth URL:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/integrations/quickbooks/sync - Sync QuickBooks data
router.post('/quickbooks/sync', async (req, res) => {
  try {
    const userId = req.user!.userId;

    await Promise.all([
      QuickBooksService.syncCustomers(userId),
      QuickBooksService.syncInvoices(userId),
      QuickBooksService.syncPayments(userId),
    ]);

    await query(
      `UPDATE platform_integrations SET last_sync_at = CURRENT_TIMESTAMP 
       WHERE user_id = $1 AND platform = 'quickbooks'`,
      [userId]
    );

    res.json({ message: 'QuickBooks sync completed' });
  } catch (error) {
    console.error('Error syncing QuickBooks:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==================== GOOGLE ADS ROUTES ====================

// POST /api/integrations/google-ads/sync - Sync Google Ads conversions
router.post('/google-ads/sync', async (req, res) => {
  try {
    const userId = req.user!.userId;
    await GoogleAdsService.syncConversions(userId);

    await query(
      `UPDATE platform_integrations SET last_sync_at = CURRENT_TIMESTAMP 
       WHERE user_id = $1 AND platform = 'google_ads'`,
      [userId]
    );

    res.json({ message: 'Google Ads sync completed' });
  } catch (error) {
    console.error('Error syncing Google Ads:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/integrations/google-ads/performance - Get campaign performance
router.get('/google-ads/performance', async (req, res) => {
  try {
    const userId = req.user!.userId;
    const performance = await GoogleAdsService.getCampaignPerformance(userId);
    res.json({ campaigns: performance });
  } catch (error) {
    console.error('Error fetching Google Ads performance:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==================== META ADS ROUTES ====================

// POST /api/integrations/meta/sync - Sync Meta Ads leads
router.post('/meta/sync', async (req, res) => {
  try {
    const userId = req.user!.userId;
    await MetaAdsService.syncLeads(userId);

    await query(
      `UPDATE platform_integrations SET last_sync_at = CURRENT_TIMESTAMP 
       WHERE user_id = $1 AND platform = 'meta'`,
      [userId]
    );

    res.json({ message: 'Meta Ads sync completed' });
  } catch (error) {
    console.error('Error syncing Meta Ads:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/integrations/meta/performance - Get campaign performance
router.get('/meta/performance', async (req, res) => {
  try {
    const userId = req.user!.userId;
    const performance = await MetaAdsService.getCampaignPerformance(userId);
    res.json({ campaigns: performance });
  } catch (error) {
    console.error('Error fetching Meta Ads performance:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/integrations/meta/insights - Get account insights
router.get('/meta/insights', async (req, res) => {
  try {
    const userId = req.user!.userId;
    const insights = await MetaAdsService.getAccountInsights(userId);
    res.json(insights);
  } catch (error) {
    console.error('Error fetching Meta insights:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==================== GOOGLE ANALYTICS ROUTES ====================

// POST /api/integrations/google-analytics/sync - Sync GA data
router.post('/google-analytics/sync', async (req, res) => {
  try {
    const userId = req.user!.userId;
    await GoogleAnalyticsService.storeAttributionData(userId);

    await query(
      `UPDATE platform_integrations SET last_sync_at = CURRENT_TIMESTAMP 
       WHERE user_id = $1 AND platform = 'google_analytics'`,
      [userId]
    );

    res.json({ message: 'Google Analytics sync completed' });
  } catch (error) {
    console.error('Error syncing Google Analytics:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/integrations/google-analytics/traffic - Get traffic data
router.get('/google-analytics/traffic', async (req, res) => {
  try {
    const userId = req.user!.userId;
    const traffic = await GoogleAnalyticsService.getTrafficData(userId);
    res.json(traffic);
  } catch (error) {
    console.error('Error fetching GA traffic:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
