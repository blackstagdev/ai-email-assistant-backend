const axios = require('axios');
const { query } = require('../db');
const { ContactService } = require('./ContactService');



class ClickUpService {
  static BASE_URL = 'https://api.clickup.com/api/v2';

  // Get ClickUp API client
  static getClient(accessToken) {
    return axios.create({
      baseURL: this.BASE_URL,
      headers: {
        'Authorization': accessToken,
        'Content-Type': 'application/json',
      },
    });
  }

  // Get stored ClickUp credentials
  static async getConfig(userId) {
    const result = await query(
      `SELECT access_token, metadata FROM platform_integrations 
       WHERE user_id = $1 AND platform = 'clickup' AND is_connected = true`,
      [userId]
    );

    if (result.rows.length === 0) {
      throw new Error('ClickUp not connected');
    }

    return {
      accessToken: result.rows[0].access_token,
      teamId: result.rows[0].metadata?.team_id,
    };
  }

  // Exchange OAuth code for tokens
  static async exchangeCodeForTokens(code) {
    const clientId = process.env.CLICKUP_CLIENT_ID;
    const clientSecret = process.env.CLICKUP_CLIENT_SECRET;

    const response = await axios.post('https://api.clickup.com/api/v2/oauth/token', null, {
      params: {
        client_id,
        client_secret,
        code,
      },
    });

    return response.data;
  }

  // Get authorized teams
  static async getTeams(accessToken) {
    const client = this.getClient(accessToken);
    const response = await client.get('/team');
    return response.data.teams || [];
  }

  // Sync tasks from ClickUp
  static async syncTasks(
    userId,
    options =  {}
  ) {
    const config = await this.getConfig(userId);
    const client = this.getClient(config.accessToken);

    // Get all spaces in team
    const spacesResponse = await client.get(`/team/${config.teamId}/space`);
    const spaces = spacesResponse.data.spaces || [];

    for (const space of spaces) {
      // Get all lists in space
      const listsResponse = await client.get(`/space/${space.id}/list`);
      const lists = listsResponse.data.lists || [];

      for (const list of lists) {
        try {
          // Get tasks in list
          const params = {
            archived,
            subtasks,
          };

          if (options.sinceDate) {
            params.date_updated_gt = options.sinceDate.getTime();
          }

          const tasksResponse = await client.get(`/list/${list.id}/task`, { params });
          const tasks = tasksResponse.data.tasks || [];

          for (const task of tasks) {
            // Extract assignee emails
            for (const assignee of task.assignees || []) {
              const email = assignee.email;
              if (!email) continue;

              // Find or create contact
              const contact = await ContactService.findOrCreateByEmail(
                userId,
                email,
                {
                  firstName: assignee.username?.split(' ')[0],
                  lastName: assignee.username?.split(' ').slice(1).join(' '),
                }
              );

              // Link ClickUp identity
              await ContactService.linkPlatformIdentity(
                contact.id,
                'clickup',
                assignee.id.toString(),
                {
                  email,
                  username: assignee.username,
                  rawData,
                }
              );

              // Store task
              await query(
                `INSERT INTO tasks_projects (
                  contact_id, user_id, platform, platform_task_id,
                  title, description, status, due_date, project_name,
                  created_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                ON CONFLICT (platform, platform_task_id)
                DO UPDATE SET
                  title = EXCLUDED.title,
                  description = EXCLUDED.description,
                  status = EXCLUDED.status,
                  due_date = EXCLUDED.due_date,
                  updated_at = CURRENT_TIMESTAMP`,
                [
                  contact.id,
                  userId,
                  'clickup',
                  task.id,
                  task.name,
                  task.description || task.text_content || null,
                  task.status?.status || 'open',
                  task.due_date ? new Date(parseInt(task.due_date)) : null,
                  `${space.name} / ${list.name}`,
                  new Date(parseInt(task.date_created)),
                ]
              );

              // Store task comments as interactions
              if (task.id) {
                const commentsResponse = await client.get(`/task/${task.id}/comment`);
                const comments = commentsResponse.data.comments || [];

                for (const comment of comments) {
                  if (!comment.user?.email) continue;

                  const commentContact = await ContactService.findOrCreateByEmail(
                    userId,
                    comment.user.email
                  );

                  await query(
                    `INSERT INTO interactions (
                      contact_id, user_id, platform, interaction_type,
                      subject, content, occurred_at
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7)
                    ON CONFLICT DO NOTHING`,
                    [
                      commentContact.id,
                      userId,
                      'clickup',
                      'comment',
                      task.name,
                      comment.comment_text,
                      new Date(parseInt(comment.date)),
                    ]
                  );
                }
              }

              // Update last contact date
              await ContactService.touchContact(contact.id);
            }
          }
        } catch (error) {
          console.error('Error syncing ClickUp list:', list.id, error);
        }
      }
    }
  }

  // Get task by ID
  static async getTask(userId, taskId) {
    const config = await this.getConfig(userId);
    const client = this.getClient(config.accessToken);

    const response = await client.get(`/task/${taskId}`);
    return response.data;
  }

  // Create task
  static async createTask(
    userId,
    listId,
    taskData) {
    const config = await this.getConfig(userId);
    const client = this.getClient(config.accessToken);

    const response = await client.post(`/list/${listId}/task`, taskData);
    return response.data;
  }

  // Update task
  static async updateTask(
    userId,
    taskId,
    updates) {
    const config = await this.getConfig(userId);
    const client = this.getClient(config.accessToken);

    const response = await client.put(`/task/${taskId}`, updates);
    return response.data;
  }

  // Add comment to task
  static async addComment(
    userId,
    taskId,
    comment) {
    const config = await this.getConfig(userId);
    const client = this.getClient(config.accessToken);

    const response = await client.post(`/task/${taskId}/comment`, {
      comment_text,
    });
    return response.data;
  }
}


module.exports = { ClickUpService };
