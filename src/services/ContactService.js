const { query } = require('../db');
const { v4 as uuidv4 } = require('uuid');







class ContactService {
  // Find or create contact by email
  static async findOrCreateByEmail(
    userId,
    email,
    additionalData?: CreateContactInput
  ) {
    // Try to find existing contact
    const existing = await query(
      'SELECT * FROM contacts WHERE user_id = $1 AND email = $2',
      [userId, email]
    );

    if (existing.rows.length > 0) {
      return existing.rows[0];
    }

    // Create new contact
    return this.createContact(userId, { email, ...additionalData });
  }

  // Create new contact
  static async createContact(
    userId,
    data) {
    const result = await query(
      `INSERT INTO contacts (
        user_id, email, phone, first_name, last_name, company, job_title,
        relationship_type, tags, custom_fields, first_contact_date, last_contact_date
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      RETURNING *`,
      [
        userId,
        data.email || null,
        data.phone || null,
        data.firstName || null,
        data.lastName || null,
        data.company || null,
        data.jobTitle || null,
        data.relationshipType || 'unknown',
        data.tags || [],
        JSON.stringify(data.customFields || {}),
      ]
    );

    return result.rows[0];
  }

  // Get all contacts for user with pagination
  static async getContactsByUser(
    userId,
    options?: number;
      offset?: number;
      search?: string;
      relationshipType?: string;
    } = {}
  ) {
    const { limit = 50, offset = 0, search, relationshipType } = options;

    let whereClause = 'WHERE user_id = $1';
    const params = [userId];
    let paramIndex = 2;

    if (search) {
      whereClause += ` AND (
        email ILIKE $${paramIndex} OR
        first_name ILIKE $${paramIndex} OR
        last_name ILIKE $${paramIndex} OR
        company ILIKE $${paramIndex}
      )`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    if (relationshipType) {
      whereClause += ` AND relationship_type = $${paramIndex}`;
      params.push(relationshipType);
      paramIndex++;
    }

    // Get total count
    const countResult = await query(
      `SELECT COUNT(*) FROM contacts ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0].count);

    // Get contacts
    const result = await query(
      `SELECT * FROM contacts ${whereClause}
       ORDER BY last_contact_date DESC NULLS LAST
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, limit, offset]
    );

    return {
      contacts: result.rows,
      total,
    };
  }

  // Get single contact by ID
  static async getContactById(userId, contactId) {
    const result = await query(
      'SELECT * FROM contacts WHERE id = $1 AND user_id = $2',
      [contactId, userId]
    );

    return result.rows[0] || null;
  }

  // Update contact
  static async updateContact(
    userId,
    contactId,
    data) {
    const updates = [];
    const params = [];
    let paramIndex = 1;

    // Build dynamic update query
    Object.entries(data).forEach(([key, value]) => {
      if (value !== undefined) {
        const snakeKey = key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
        updates.push(`${snakeKey} = $${paramIndex}`);
        params.push(value);
        paramIndex++;
      }
    });

    if (updates.length === 0) {
      return this.getContactById(userId, contactId);
    }

    updates.push(`updated_at = CURRENT_TIMESTAMP`);
    params.push(contactId, userId);

    const result = await query(
      `UPDATE contacts SET ${updates.join(', ')}
       WHERE id = $${paramIndex} AND user_id = $${paramIndex + 1}
       RETURNING *`,
      params
    );

    return result.rows[0] || null;
  }

  // Delete contact
  static async deleteContact(userId, contactId) {
    const result = await query(
      'DELETE FROM contacts WHERE id = $1 AND user_id = $2',
      [contactId, userId]
    );

    return result.rowCount > 0;
  }

  // Link platform identity to contact
  static async linkPlatformIdentity(
    contactId,
    platform,
    platformId,
    platformData?: string;
      username?: string;
      profileUrl?: string;
      rawData?: any;
    }
  ) {
    await query(
      `INSERT INTO platform_identities (
        contact_id, platform, platform_id, platform_email, 
        platform_username, profile_url, raw_data
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (platform, platform_id) 
      DO UPDATE SET 
        platform_email = EXCLUDED.platform_email,
        platform_username = EXCLUDED.platform_username,
        profile_url = EXCLUDED.profile_url,
        raw_data = EXCLUDED.raw_data,
        last_synced_at = CURRENT_TIMESTAMP`,
      [
        contactId,
        platform,
        platformId,
        platformData.email || null,
        platformData.username || null,
        platformData.profileUrl || null,
        JSON.stringify(platformData.rawData || {}),
      ]
    );
  }

  // Get contact's platform identities
  static async getPlatformIdentities(contactId) {
    const result = await query(
      'SELECT * FROM platform_identities WHERE contact_id = $1',
      [contactId]
    );

    return result.rows;
  }

  // Update contact revenue and LTV
  static async updateFinancials(
    contactId,
    additionalRevenue) {
    await query(
      `UPDATE contacts 
       SET total_revenue = total_revenue + $1,
           customer_lifetime_value = total_revenue + $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [additionalRevenue, contactId]
    );
  }

  // Update last contact date
  static async touchContact(contactId) {
    await query(
      `UPDATE contacts 
       SET last_contact_date = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [contactId]
    );
  }

  // Search contacts by multiple criteria with fuzzy matching
  static async searchContacts(
    userId,
    searchTerm) {
    const result = await query(
      `SELECT *, 
        CASE 
          WHEN email ILIKE $2 THEN 100
          WHEN (first_name || ' ' || last_name) ILIKE $2 THEN 90
          WHEN company ILIKE $2 THEN 80
          ELSE 50
        END as relevance_score
       FROM contacts 
       WHERE user_id = $1 
       AND (
         email ILIKE $2 OR
         first_name ILIKE $2 OR
         last_name ILIKE $2 OR
         company ILIKE $2 OR
         phone ILIKE $2
       )
       ORDER BY relevance_score DESC, last_contact_date DESC NULLS LAST
       LIMIT 20`,
      [userId, `%${searchTerm}%`]
    );

    return result.rows;
  }
}


module.exports = { ContactService };
