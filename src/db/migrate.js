const pool = require('./index');

const migrations = `
-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgvector";

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  first_name VARCHAR(100),
  last_name VARCHAR(100),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Contacts table (unified contact database)
CREATE TABLE IF NOT EXISTS contacts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  email VARCHAR(255),
  phone VARCHAR(50),
  first_name VARCHAR(100),
  last_name VARCHAR(100),
  company VARCHAR(255),
  job_title VARCHAR(255),
  relationship_type VARCHAR(50), -- customer, lead, colleague, vendor, etc.
  relationship_strength INTEGER DEFAULT 50, -- 0-100
  customer_lifetime_value DECIMAL(12, 2) DEFAULT 0,
  total_revenue DECIMAL(12, 2) DEFAULT 0,
  tags TEXT[],
  custom_fields JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  first_contact_date TIMESTAMP,
  last_contact_date TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_contacts_user_id ON contacts(user_id);
CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email);
CREATE INDEX IF NOT EXISTS idx_contacts_relationship_type ON contacts(relationship_type);

-- Platform identities (links same person across platforms)
CREATE TABLE IF NOT EXISTS platform_identities (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  platform VARCHAR(50) NOT NULL, -- microsoft, shopify, gorgias, etc.
  platform_id VARCHAR(255) NOT NULL,
  platform_email VARCHAR(255),
  platform_username VARCHAR(255),
  profile_url TEXT,
  raw_data JSONB DEFAULT '{}',
  last_synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(platform, platform_id)
);

CREATE INDEX IF NOT EXISTS idx_platform_identities_contact_id ON platform_identities(contact_id);
CREATE INDEX IF NOT EXISTS idx_platform_identities_platform ON platform_identities(platform);

-- Interactions (emails, messages, calls, etc.)
CREATE TABLE IF NOT EXISTS interactions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  platform VARCHAR(50) NOT NULL,
  interaction_type VARCHAR(50) NOT NULL, -- email, message, call, meeting, etc.
  direction VARCHAR(20), -- inbound, outbound
  subject VARCHAR(500),
  content TEXT,
  sentiment VARCHAR(20), -- positive, negative, neutral
  intent VARCHAR(100), -- question, complaint, purchase, etc.
  topics TEXT[],
  action_items JSONB DEFAULT '[]',
  embedding vector(1536), -- for semantic search
  occurred_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_interactions_contact_id ON interactions(contact_id);
CREATE INDEX IF NOT EXISTS idx_interactions_user_id ON interactions(user_id);
CREATE INDEX IF NOT EXISTS idx_interactions_platform ON interactions(platform);
CREATE INDEX IF NOT EXISTS idx_interactions_occurred_at ON interactions(occurred_at DESC);

-- Conversation threads
CREATE TABLE IF NOT EXISTS conversation_threads (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  platform VARCHAR(50) NOT NULL,
  thread_id VARCHAR(255) NOT NULL,
  subject VARCHAR(500),
  message_count INTEGER DEFAULT 0,
  started_at TIMESTAMP NOT NULL,
  last_message_at TIMESTAMP NOT NULL,
  summary TEXT,
  key_points JSONB DEFAULT '[]',
  status VARCHAR(50) DEFAULT 'active', -- active, closed, archived
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(platform, thread_id)
);

CREATE INDEX IF NOT EXISTS idx_threads_contact_id ON conversation_threads(contact_id);
CREATE INDEX IF NOT EXISTS idx_threads_user_id ON conversation_threads(user_id);

-- Commerce data (orders, purchases)
CREATE TABLE IF NOT EXISTS commerce_data (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  platform VARCHAR(50) NOT NULL,
  platform_order_id VARCHAR(255) NOT NULL,
  order_date TIMESTAMP NOT NULL,
  order_total DECIMAL(12, 2) NOT NULL,
  items JSONB DEFAULT '[]',
  fulfillment_status VARCHAR(50),
  payment_status VARCHAR(50),
  shipping_address JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(platform, platform_order_id)
);

CREATE INDEX IF NOT EXISTS idx_commerce_contact_id ON commerce_data(contact_id);
CREATE INDEX IF NOT EXISTS idx_commerce_order_date ON commerce_data(order_date DESC);

-- Support tickets
CREATE TABLE IF NOT EXISTS support_tickets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  platform VARCHAR(50) NOT NULL,
  ticket_id VARCHAR(255) NOT NULL,
  subject VARCHAR(500),
  status VARCHAR(50), -- open, pending, resolved, closed
  priority VARCHAR(50), -- low, medium, high, urgent
  category VARCHAR(100),
  resolution_time_hours DECIMAL(8, 2),
  satisfaction_score INTEGER, -- 1-5
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  resolved_at TIMESTAMP,
  UNIQUE(platform, ticket_id)
);

CREATE INDEX IF NOT EXISTS idx_tickets_contact_id ON support_tickets(contact_id);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON support_tickets(status);

-- Financial data
CREATE TABLE IF NOT EXISTS financial_data (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  platform VARCHAR(50) NOT NULL,
  invoice_id VARCHAR(255) NOT NULL,
  invoice_date TIMESTAMP NOT NULL,
  amount DECIMAL(12, 2) NOT NULL,
  payment_status VARCHAR(50), -- paid, pending, overdue
  payment_date TIMESTAMP,
  balance_due DECIMAL(12, 2) DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(platform, invoice_id)
);

CREATE INDEX IF NOT EXISTS idx_financial_contact_id ON financial_data(contact_id);
CREATE INDEX IF NOT EXISTS idx_financial_status ON financial_data(payment_status);

-- Marketing attribution
CREATE TABLE IF NOT EXISTS marketing_attribution (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  source VARCHAR(100), -- google, facebook, email, etc.
  medium VARCHAR(100), -- cpc, organic, email, etc.
  campaign VARCHAR(255),
  ad_platform VARCHAR(50), -- meta, google_ads
  cost_per_acquisition DECIMAL(10, 2),
  first_touch_date TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_attribution_contact_id ON marketing_attribution(contact_id);
CREATE INDEX IF NOT EXISTS idx_attribution_platform ON marketing_attribution(ad_platform);

-- Tasks and projects
CREATE TABLE IF NOT EXISTS tasks_projects (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  platform VARCHAR(50) NOT NULL,
  platform_task_id VARCHAR(255) NOT NULL,
  title VARCHAR(500),
  description TEXT,
  status VARCHAR(50), -- todo, in_progress, done
  due_date TIMESTAMP,
  project_name VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(platform, platform_task_id)
);

CREATE INDEX IF NOT EXISTS idx_tasks_contact_id ON tasks_projects(contact_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks_projects(status);

-- AI draft emails
CREATE TABLE IF NOT EXISTS draft_emails (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  original_message_id UUID REFERENCES interactions(id),
  subject VARCHAR(500),
  draft_content TEXT NOT NULL,
  user_edits TEXT,
  status VARCHAR(50) DEFAULT 'pending', -- pending, approved, rejected, sent
  user_feedback TEXT,
  context_used JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  approved_at TIMESTAMP,
  sent_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_drafts_user_id ON draft_emails(user_id);
CREATE INDEX IF NOT EXISTS idx_drafts_status ON draft_emails(status);
CREATE INDEX IF NOT EXISTS idx_drafts_created_at ON draft_emails(created_at DESC);

-- Platform integrations (OAuth tokens, connection status)
CREATE TABLE IF NOT EXISTS platform_integrations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  platform VARCHAR(50) NOT NULL,
  is_connected BOOLEAN DEFAULT false,
  access_token TEXT,
  refresh_token TEXT,
  token_expires_at TIMESTAMP,
  scopes TEXT[],
  platform_user_id VARCHAR(255),
  platform_username VARCHAR(255),
  metadata JSONB DEFAULT '{}',
  last_sync_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, platform)
);

CREATE INDEX IF NOT EXISTS idx_integrations_user_id ON platform_integrations(user_id);
CREATE INDEX IF NOT EXISTS idx_integrations_platform ON platform_integrations(platform);

-- Communication patterns
CREATE TABLE IF NOT EXISTS communication_patterns (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  avg_response_time_hours DECIMAL(8, 2),
  typical_email_length VARCHAR(20), -- short, medium, long
  formality_level DECIMAL(3, 2), -- 0.0 to 1.0
  uses_greetings BOOLEAN DEFAULT true,
  uses_signoffs BOOLEAN DEFAULT true,
  common_phrases JSONB DEFAULT '[]',
  preferred_contact_time VARCHAR(50),
  emoji_usage BOOLEAN DEFAULT false,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_patterns_contact_id ON communication_patterns(contact_id);

-- Analytics events (for dashboard)
CREATE TABLE IF NOT EXISTS analytics_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  event_type VARCHAR(100) NOT NULL,
  event_data JSONB DEFAULT '{}',
  occurred_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_analytics_user_id ON analytics_events(user_id);
CREATE INDEX IF NOT EXISTS idx_analytics_occurred_at ON analytics_events(occurred_at DESC);
`;

async function runMigrations() {
  const client = await pool.connect();
  try {
    console.log('Running database migrations...');
    await client.query(migrations);
    console.log('✅ Migrations completed successfully');
  } catch (error) {
    console.error('❌ Migration failed:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Run migrations if this file is executed directly
if (require.main === module) {
  runMigrations()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

module.exports = runMigrations;


module.exports = { runMigrations };
