const { Queue, Worker, Job } = require('bullmq');
const IORedis = require('ioredis');
const { MicrosoftService } = require('../services/MicrosoftService');
const { ShopifyService } = require('../services/ShopifyService');
const { GorgiasService } = require('../services/GorgiasService');
const { ShipStationService } = require('../services/ShipStationService');
const { SlackService } = require('../services/SlackService');
const { ClickUpService } = require('../services/ClickUpService');
const { GoHighLevelService } = require('../services/GoHighLevelService');
const { QuickBooksService } = require('../services/QuickBooksService');
const { GoogleAdsService, MetaAdsService, GoogleAnalyticsService } = require('../services/AdsAnalyticsService');
const { query } = require('../db');

const connection = new IORedis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  maxRetriesPerRequest: null,
});

// Create job queues
const syncQueue = new Queue('platform-sync', { connection });

// Job types


// Worker to process sync jobs
const syncWorker = new Worker(
  'platform-sync',
  async (job: Job) => {
    const { userId, platform, sinceDate } = job.data;

    console.log(`Processing sync job for user ${userId}, platform: ${platform}`);

    try {
      switch (platform) {
        case 'microsoft':
          await MicrosoftService.syncEmails(userId, {
            sinceDate? new Date(sinceDate) : undefined,
            maxResults: 100,
          });
          break;

        case 'shopify':
          await ShopifyService.syncCustomers(userId, {
            sinceDate? new Date(sinceDate) : undefined,
          });
          await ShopifyService.syncOrders(userId, {
            sinceDate? new Date(sinceDate) : undefined,
          });
          break;

        case 'gorgias':
          await GorgiasService.syncTickets(userId, {
            sinceDate? new Date(sinceDate) : undefined,
          });
          break;

        case 'shipstation':
          await ShipStationService.syncShipments(userId, {
            sinceDate? new Date(sinceDate) : undefined,
          });
          break;

        case 'slack':
          await SlackService.syncMessages(userId, {
            sinceTimestamp: sinceDate ? (new Date(sinceDate).getTime() / 1000).toString() : undefined,
          });
          break;

        case 'clickup':
          await ClickUpService.syncTasks(userId, {
            sinceDate? new Date(sinceDate) : undefined,
          });
          break;

        case 'gohighlevel':
          await GoHighLevelService.syncContacts(userId);
          await GoHighLevelService.syncOpportunities(userId);
          await GoHighLevelService.syncConversations(userId);
          break;

        case 'quickbooks':
          await QuickBooksService.syncCustomers(userId);
          await QuickBooksService.syncInvoices(userId);
          await QuickBooksService.syncPayments(userId);
          break;

        case 'google_ads':
          await GoogleAdsService.syncConversions(userId);
          break;

        case 'meta':
          await MetaAdsService.syncLeads(userId);
          break;

        case 'google_analytics':
          await GoogleAnalyticsService.storeAttributionData(userId);
          break;

        default:
          console.log(`No sync handler for platform: ${platform}`);
      }

      // Update last sync timestamp
      await query(
        `UPDATE platform_integrations 
         SET last_sync_at = CURRENT_TIMESTAMP 
         WHERE user_id = $1 AND platform = $2`,
        [userId, platform]
      );

      console.log(`✅ Completed sync for user ${userId}, platform: ${platform}`);
    } catch (error) {
      console.error(`❌ Sync failed for user ${userId}, platform: ${platform}`, error);
      throw error; // This will mark the job as failed and trigger retry
    }
  },
  {
    connection,
    concurrency: 5, // Process 5 jobs concurrently
    limiter: {
      max: 10, // Max 10 jobs
      duration: 60000, // Per 60 seconds (to respect API rate limits)
    },
  }
);

syncWorker.on('completed', (job) => {
  console.log(`Job ${job.id} completed`);
});

syncWorker.on('failed', (job, err) => {
  console.error(`Job ${job?.id} failed:`, err);
});

// Helper function to schedule a sync job
async function scheduleSyncJob(
  userId,
  platform,
  options?: Date; delay?: number } = {}
) {
  await syncQueue.add(
    'sync',
    {
      userId,
      platform,
      sinceDate: options.sinceDate,
    },
    {
      delay: options.delay || 0,
      attempts: 3, // Retry up to 3 times
      backoff: {
        type: 'exponential',
        delay: 5000, // Start with 5 second delay
      },
    }
  );
}

// Schedule recurring sync for all connected integrations
async function scheduleRecurringSyncs() {
  const result = await query(
    'SELECT DISTINCT user_id, platform FROM platform_integrations WHERE is_connected = true'
  );

  for (const row of result.rows) {
    // Sync from last 24 hours every hour
    const sinceDate = new Date();
    sinceDate.setHours(sinceDate.getHours() - 24);

    await syncQueue.add(
      'sync',
      {
        userId: row.user_id,
        platform: row.platform,
        sinceDate,
      },
      {
        repeat: {
          pattern: '0 * * * *', // Every hour
        },
        jobId: `recurring-${row.user_id}-${row.platform}`, // Prevent duplicates
      }
    );
  }

  console.log('✅ Scheduled recurring syncs for all connected integrations');
}

// Start scheduling recurring syncs when worker starts
scheduleRecurringSyncs().catch(console.error);

export default syncWorker;


module.exports = { syncQueue, scheduleSyncJob, scheduleRecurringSyncs };
