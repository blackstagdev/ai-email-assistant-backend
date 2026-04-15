const { Router, Response } = require('express');
const { AuthRequest, authMiddleware } = require('../middleware/auth');
const { query } = require('../db');
const { MicrosoftService } = require('../services/MicrosoftService');
const { v44 } = require('uuid');

const router = Router();

// Apply auth middleware to all routes
router.use(authMiddleware);

// GET /api/integrations - List all integrations and their connection status
router.get('/', async (req, res) => {
  try {
    const userId = req.user!.userId;

    const result = await query(
      `SELECT platform, is_connected, platform_username, last_sync_at, created_at, updated_at
       FROM platform_integrations 
       WHERE user_id = $1
       ORDER BY platform`,
      [userId]
    );

    // List of all available platforms
    const availablePlatforms = [
      'microsoft',
      'shopify',
      'gorgias',
      'shipstation',
      'slack',
      'clickup',
      'gohighlevel',
      'meta',
      'google_ads',
      'google_analytics',
      'quickbooks',
    ];

    const integrations = availablePlatforms.map(platform => {
      const existing = result.rows.find(r => r.platform === platform);
      return {
        platform,
        isConnected: existing?.is_connected || false,
        platformUsername: existing?.platform_username || null,
        lastSyncAt: existing?.last_sync_at || null,
        connectedAt: existing?.created_at || null,
      };
    });

    res.json({ integrations });
  } catch (error) {
    console.error('Error fetching integrations:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Microsoft 365 OAuth Flow
// GET /api/integrations/microsoft/connect - Initiate OAuth
router.get('/microsoft/connect', async (req, res) => {
  try {
    const userId = req.user!.userId;
    const state = uuidv4(); // Used to prevent CSRF

    // Store state temporarily (in production, use Redis)
    // For now, we'll include userId in state
    const stateData = Buffer.from(JSON.stringify({ userId, timestamp: Date.now() })).toString('base64');

    const authUrl = MicrosoftService.getAuthorizationUrl(stateData);

    res.json({ authUrl });
  } catch (error) {
    console.error('Error initiating Microsoft OAuth:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/integrations/microsoft/callback - OAuth callback
router.get('/microsoft/callback', async (req, res) => {
  try {
    const { code, state, error } = req.query;

    if (error) {
      return res.status(400).json({ error: `OAuth error: ${error}` });
    }

    if (!code || !state) {
      return res.status(400).json({ error: 'Missing code or state' });
    }

    // Decode state to get userId
    const stateData = JSON.parse(Buffer.from(state, 'base64').toString());
    const userId = stateData.userId;

    // Exchange code for tokens
    const tokens = await MicrosoftService.exchangeCodeForTokens(code);

    // Get user profile
    const profile = await axios.get('https://graph.microsoft.com/v1.0/me', {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });

    // Store integration
    await query(
      `INSERT INTO platform_integrations (
        user_id, platform, is_connected, access_token, refresh_token, 
        token_expires_at, platform_user_id, platform_username
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (user_id, platform) 
      DO UPDATE SET 
        is_connected = true,
        access_token = EXCLUDED.access_token,
        refresh_token = EXCLUDED.refresh_token,
        token_expires_at = EXCLUDED.token_expires_at,
        platform_user_id = EXCLUDED.platform_user_id,
        platform_username = EXCLUDED.platform_username,
        updated_at = CURRENT_TIMESTAMP`,
      [
        userId,
        'microsoft',
        true,
        tokens.accessToken,
        tokens.refreshToken,
        tokens.expiresAt,
        profile.data.id,
        profile.data.userPrincipalName,
      ]
    );

    // Redirect to frontend success page
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    res.redirect(`${frontendUrl}/settings/integrations?success=microsoft`);
  } catch (error) {
    console.error('Error in Microsoft OAuth callback:', error);
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    res.redirect(`${frontendUrl}/settings/integrations?error=microsoft`);
  }
});

// Import axios for the callback
const axios = require('axios');

// POST /api/integrations/microsoft/sync - Manually trigger sync
router.post('/microsoft/sync', async (req, res) => {
  try {
    const userId = req.user!.userId;

    // Trigger email sync (last 7 days)
    const sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - 7);

    await MicrosoftService.syncEmails(userId, { sinceDate, maxResults: 100 });

    // Update last sync timestamp
    await query(
      `UPDATE platform_integrations 
       SET last_sync_at = CURRENT_TIMESTAMP 
       WHERE user_id = $1 AND platform = 'microsoft'`,
      [userId]
    );

    res.json({ message: 'Sync started successfully' });
  } catch (error) {
    console.error('Error syncing Microsoft data:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/integrations/:platform - Disconnect integration
router.delete('/:platform', async (req, res) => {
  try {
    const userId = req.user!.userId;
    const { platform } = req.params;

    await query(
      `UPDATE platform_integrations 
       SET is_connected = false, access_token = NULL, refresh_token = NULL
       WHERE user_id = $1 AND platform = $2`,
      [userId, platform]
    );

    res.json({ message: `${platform} disconnected successfully` });
  } catch (error) {
    console.error('Error disconnecting integration:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/integrations/microsoft/onedrive/files - List OneDrive files
router.get('/microsoft/onedrive/files', async (req, res) => {
  try {
    const userId = req.user!.userId;
    const { folderId } = req.query;

    const files = await MicrosoftService.listOneDriveFiles(
      userId,
      folderId);

    res.json({ files });
  } catch (error) {
    console.error('Error listing OneDrive files:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/integrations/microsoft/onedrive/search - Search OneDrive files
router.get('/microsoft/onedrive/search', async (req, res) => {
  try {
    const userId = req.user!.userId;
    const { q } = req.query;

    if (!q || typeof q !== 'string') {
      return res.status(400).json({ error: 'Search query required' });
    }

    const files = await MicrosoftService.searchOneDriveFiles(userId, q);

    res.json({ files });
  } catch (error) {
    console.error('Error searching OneDrive files:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
