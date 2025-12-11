import express from "express";
import cors from "cors";
import { google } from "googleapis";
import { Client as NotionClient } from "@notionhq/client";
import { tool } from "@langchain/core/tools";
import { ChatFireworks } from "@langchain/community/chat_models/fireworks";
import { AgentExecutor, createToolCallingAgent } from "langchain/agents";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import * as z from "zod";
import dotenv from "dotenv";

dotenv.config({ override: true });

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "50mb" }));

// -------------------- Clients & Auth --------------------
const notion = new NotionClient({ auth: process.env.NOTION_API_KEY });

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

const conversationAttachments = new Map();
let tokens = null;
const conversationHistories = new Map();

function ensureAuthenticated() {
  if (!tokens) throw new Error("Not authenticated with Google. Visit /auth/google");
}

function getGmail() {
  oauth2Client.setCredentials(tokens);
  return google.gmail({ version: "v1", auth: oauth2Client });
}

function getCalendar() {
  oauth2Client.setCredentials(tokens);
  return google.calendar({ version: "v3", auth: oauth2Client });
}

function getSheets() {
  oauth2Client.setCredentials(tokens);
  return google.sheets({ version: "v4", auth: oauth2Client });
}

function getDocs() {
  oauth2Client.setCredentials(tokens);
  return google.docs({ version: "v1", auth: oauth2Client });
}

// -------------------- FIXED: Simple Email Builder (Plain Text/HTML Only) --------------------
function createSimpleEmail(to, subject, body, cc = [], bcc = []) {
  const CRLF = "\r\n";

  const isHtml = /<[a-z][\s\S]*>/i.test(body);
  const contentType = isHtml ? "text/html; charset=UTF-8" : "text/plain; charset=UTF-8";

  const messageParts = [
    `From: ${process.env.GMAIL_USER}`,
    `To: ${to}`,
    cc.length > 0 ? `Cc: ${cc.join(", ")}` : "",
    bcc.length > 0 ? `Bcc: ${bcc.join(", ")}` : "",
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    `Content-Type: ${contentType}; charset="UTF-8"`,
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(body, "utf-8").toString("base64") // ✅ ENCODE BODY IN BASE64
  ].filter(Boolean);

  return Buffer.from(messageParts.join(CRLF))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// -------------------- FIXED: Email with Attachments --------------------
function createEmailWithAttachments(to, subject, body, cc = [], bcc = [], attachments = []) {
  const boundary = `boundary_${Date.now()}`;
  const CRLF = "\r\n";

  function wrapBase64(str) {
    return str.match(/.{1,76}/g)?.join(CRLF) || str;
  }

  // Headers
    let headers = [
      `From: ${process.env.GMAIL_USER}`,
      `To: ${to}`,
      cc.length > 0 ? `Cc: ${cc.join(", ")}` : "",
      bcc.length > 0 ? `Bcc: ${bcc.join(", ")}` : "",
      `Subject: ${subject}`,
      "MIME-Version: 1.0",
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
    ].filter(Boolean).join(CRLF);


  // Body part
  const isHtml = /<[a-z][\s\S]*>/i.test(body);
  const bodyContentType = isHtml ? "text/html; charset=UTF-8" : "text/plain; charset=UTF-8";
  
  let bodyPart =
  `--${boundary}${CRLF}` +
  `Content-Type: ${bodyContentType}; charset="UTF-8"${CRLF}` +
  `Content-Transfer-Encoding: base64${CRLF}${CRLF}` +
  Buffer.from(body, "utf-8").toString("base64") + CRLF;

  // Attachment parts
  let attachmentParts = "";
  for (const att of attachments) {
    const cleanData = att.data.replace(/^data:[^;]+;base64,/, "");
    attachmentParts +=
      `--${boundary}${CRLF}` +
      `Content-Type: ${att.type}; name="${att.name}"${CRLF}` +
      `Content-Disposition: attachment; filename="${att.name}"${CRLF}` +
      `Content-Transfer-Encoding: base64${CRLF}${CRLF}` +
      `${wrapBase64(cleanData)}${CRLF}${CRLF}`;
  }

  const finalMessage = 
    headers + CRLF + CRLF +
    bodyPart +
    attachmentParts +
    `--${boundary}--`;

  return Buffer.from(finalMessage)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}



// -------------------- Gmail Tools --------------------
const sendEmailTool = tool(
  async ({ to, subject, body, cc, bcc, attachments }) => {
    try {
      ensureAuthenticated();
      const gmail = getGmail();

      let finalAttachments = attachments || [];
      for (let [sessionId, sessionAttachments] of conversationAttachments.entries()) {
        if (sessionAttachments && sessionAttachments.length > 0) {
          finalAttachments = sessionAttachments;
          break;
        }
      }

      const ccList = cc ? cc.split(',').map(e => e.trim()) : [];
      const bccList = bcc ? bcc.split(',').map(e => e.trim()) : [];

      let raw;
      if (finalAttachments && finalAttachments.length > 0) {
        raw = createEmailWithAttachments(to, subject, body, ccList, bccList, finalAttachments);
      } else {
        raw = createSimpleEmail(to, subject, body, ccList, bccList);
      }
      console.log(Buffer.from(raw, "base64").toString());

      await gmail.users.messages.send({
        userId: "me",
        requestBody: { raw },
      });

      return `✅ Email sent successfully to ${to}${finalAttachments.length > 0 ? ` with ${finalAttachments.length} attachment(s)` : ''}`;
    } catch (err) {
      return `❌ Error sending email: ${err.message}`;
    }
  },
  {
    name: "send_email",
    description: "Send an email via Gmail. ALWAYS ask for to, subject, and body if not provided.",
    schema: z.object({
      to: z.string().describe("Recipient email address"),
      subject: z.string().describe("Email subject"),
      body: z.string().describe("Email body content (supports HTML)"),
      cc: z.string().optional().describe("CC recipients (comma-separated)"),
      bcc: z.string().optional().describe("BCC recipients (comma-separated)"),
      attachments: z.array(z.object({
        name: z.string(),
        type: z.string(),
        data: z.string(),
        size: z.number()
      })).optional()
    }),
  }
);

const draftEmailTool = tool(
  async ({ to, subject, body, cc, bcc, attachments }) => {
    try {
      ensureAuthenticated();
      const gmail = getGmail();

      let finalAttachments = attachments || [];
      for (let [sessionId, sessionAttachments] of conversationAttachments.entries()) {
        if (sessionAttachments && sessionAttachments.length > 0) {
          finalAttachments = sessionAttachments;
          break;
        }
      }

      const ccList = cc ? cc.split(',').map(e => e.trim()) : [];
      const bccList = bcc ? bcc.split(',').map(e => e.trim()) : [];

      let raw;
      if (finalAttachments && finalAttachments.length > 0) {
        raw = createEmailWithAttachments(to, subject, body, ccList, bccList, finalAttachments);
      } else {
        raw = createSimpleEmail(to, subject, body, ccList, bccList);
      }
       
      const draft = await gmail.users.drafts.create({
        userId: "me",
        requestBody: { message: { raw } },
      });

      return `✅ Draft created successfully (ID: ${draft.data.id})${finalAttachments.length > 0 ? ` with ${finalAttachments.length} attachment(s)` : ''}`;
    } catch (err) {
      return `❌ Error creating draft: ${err.message}`;
    }
  },
  {
    name: "draft_email",
    description: "Create an email draft in Gmail without sending it.",
    schema: z.object({
      to: z.string(),
      subject: z.string(),
      body: z.string(),
      cc: z.string().optional(),
      bcc: z.string().optional(),
      attachments: z.array(z.object({
        name: z.string(),
        type: z.string(),
        data: z.string(),
        size: z.number()
      })).optional()
    }),
  }
);

const listEmailsTool = tool(
  async ({ maxResults = 10, query = "" }) => {
    try {
      ensureAuthenticated();
      const gmail = getGmail();
      const resp = await gmail.users.messages.list({
        userId: "me",
        maxResults: Math.min(maxResults, 50),
        q: query,
      });

      const msgs = resp.data.messages || [];
      if (msgs.length === 0) return `No emails found.`;

      const previews = await Promise.all(
        msgs.slice(0, maxResults).map(async (m) => {
          const detail = await gmail.users.messages.get({
            userId: "me",
            id: m.id,
            format: "metadata",
            metadataHeaders: ["From", "Subject", "Date"],
          });
          const headers = detail.data.payload?.headers || [];
          return {
            id: m.id,
            from: headers.find((h) => h.name === "From")?.value || "Unknown",
            subject: headers.find((h) => h.name === "Subject")?.value || "No Subject",
            date: headers.find((h) => h.name === "Date")?.value || "",
            snippet: detail.data.snippet || "",
            unread: detail.data.labelIds?.includes("UNREAD") || false,
          };
        })
      );

      return `Found ${previews.length} emails:\n\n${JSON.stringify(previews, null, 2)}`;
    } catch (err) {
      return `❌ Error listing emails: ${err.message}`;
    }
  },
  {
    name: "list_emails",
    description: "List recent emails from Gmail inbox.",
    schema: z.object({
      maxResults: z.number().optional().default(10),
      query: z.string().optional(),
    }),
  }
);

const readEmailTool = tool(
  async ({ emailId }) => {
    try {
      ensureAuthenticated();
      const gmail = getGmail();
      const resp = await gmail.users.messages.get({
        userId: "me",
        id: emailId,
        format: "full",
      });

      const headers = resp.data.payload?.headers || [];
      const from = headers.find((h) => h.name === "From")?.value || "Unknown";
      const subject = headers.find((h) => h.name === "Subject")?.value || "No Subject";
      const date = headers.find((h) => h.name === "Date")?.value || "";

      let body = "";
      
      function extractBody(payload) {
        if (payload.body?.data) {
          return Buffer.from(payload.body.data, "base64").toString();
        }
        if (payload.parts) {
          for (const part of payload.parts) {
            if (part.mimeType === "text/html" || part.mimeType === "text/plain") {
              if (part.body?.data) {
                return Buffer.from(part.body.data, "base64").toString();
              }
            }
            if (part.parts) {
              const nested = extractBody(part);
              if (nested) return nested;
            }
          }
        }
        return "";
      }

      body = extractBody(resp.data.payload);

      return `From: ${from}\nSubject: ${subject}\nDate: ${date}\n\nBody:\n${body}`;
    } catch (err) {
      return `❌ Error reading email: ${err.message}`;
    }
  },
  {
    name: "read_email",
    description: "Read full email content by ID.",
    schema: z.object({ emailId: z.string() }),
  }
);

const searchEmailsTool = tool(
  async ({ query, maxResults = 5 }) => {
    try {
      ensureAuthenticated();
      const gmail = getGmail();
      const resp = await gmail.users.messages.list({
        userId: "me",
        q: query,
        maxResults,
      });

      const msgs = resp.data.messages || [];
      if (msgs.length === 0) return `No emails found matching "${query}"`;

      const results = await Promise.all(
        msgs.map(async (m) => {
          const detail = await gmail.users.messages.get({
            userId: "me",
            id: m.id,
            format: "metadata",
            metadataHeaders: ["From", "Subject"],
          });
          const headers = detail.data.payload?.headers || [];
          return {
            id: m.id,
            from: headers.find((h) => h.name === "From")?.value,
            subject: headers.find((h) => h.name === "Subject")?.value,
          };
        })
      );

      return `Found ${results.length} emails:\n${JSON.stringify(results, null, 2)}`;
    } catch (err) {
      return `❌ Error searching emails: ${err.message}`;
    }
  },
  {
    name: "search_emails",
    description: "Search Gmail using query syntax.",
    schema: z.object({
      query: z.string(),
      maxResults: z.number().optional().default(5),
    }),
  }
);

const deleteEmailTool = tool(
  async ({ emailId }) => {
    try {
      ensureAuthenticated();
      const gmail = getGmail();
      await gmail.users.messages.trash({ userId: "me", id: emailId });
      return `✅ Email moved to trash`;
    } catch (err) {
      return `❌ Error: ${err.message}`;
    }
  },
  {
    name: "delete_email",
    description: "Move an email to trash.",
    schema: z.object({ emailId: z.string() }),
  }
);

// -------------------- Calendar Tools --------------------
const listCalendarEventsTool = tool(
  async ({ maxResults = 10, timeMin, timeMax }) => {
    try {
      ensureAuthenticated();
      const calendar = getCalendar();

      const resp = await calendar.events.list({
        calendarId: "primary",
        timeMin: timeMin || new Date().toISOString(),
        timeMax,
        maxResults: Math.min(maxResults, 250),
        singleEvents: true,
        orderBy: "startTime",
      });

      const events = resp.data.items || [];
      return events.length > 0 
        ? `Found ${events.length} events:\n${JSON.stringify(events, null, 2)}`
        : "No upcoming events found.";
    } catch (err) {
      return `❌ Error listing events: ${err.message}`;
    }
  },
  {
    name: "list_calendar_events",
    description: "List upcoming calendar events.",
    schema: z.object({
      maxResults: z.number().optional().default(10),
      timeMin: z.string().optional(),
      timeMax: z.string().optional(),
    }),
  }
);

const createCalendarEventTool = tool(
  async ({ summary, description = "", startTime, endTime, attendees, location = "" }) => {
    try {
      ensureAuthenticated();
      const calendar = getCalendar();

      const attendeesList = attendees
        ? attendees.split(",").map((e) => ({ email: e.trim() }))
        : [];

      const event = {
        summary,
        description,
        location,
        start: { dateTime: new Date(startTime).toISOString() },
        end: { dateTime: new Date(endTime).toISOString() },
        attendees: attendeesList,
      };

      const created = await calendar.events.insert({
        calendarId: "primary",
        resource: event,
        sendUpdates: "all",
      });

      return `✅ Event "${summary}" created for ${new Date(startTime).toLocaleString()}`;
    } catch (err) {
      return `❌ Error creating event: ${err.message}`;
    }
  },
  {
    name: "create_calendar_event",
    description: "Create a new calendar event. ALWAYS ask for summary, startTime, endTime if not provided.",
    schema: z.object({
      summary: z.string(),
      description: z.string().optional(),
      startTime: z.string(),
      endTime: z.string(),
      attendees: z.string().optional(),
      location: z.string().optional(),
    }),
  }
);

const updateCalendarEventTool = tool(
  async ({ eventId, summary, description, startTime, endTime, location }) => {
    try {
      ensureAuthenticated();
      const calendar = getCalendar();

      const existing = await calendar.events.get({ calendarId: "primary", eventId });
      const resource = existing.data;

      if (summary) resource.summary = summary;
      if (description) resource.description = description;
      if (location) resource.location = location;
      if (startTime) resource.start = { dateTime: new Date(startTime).toISOString() };
      if (endTime) resource.end = { dateTime: new Date(endTime).toISOString() };

      await calendar.events.update({
        calendarId: "primary",
        eventId,
        resource,
      });

      return `✅ Event updated successfully`;
    } catch (err) {
      return `❌ Error updating event: ${err.message}`;
    }
  },
  {
    name: "update_calendar_event",
    description: "Update an existing calendar event.",
    schema: z.object({
      eventId: z.string(),
      summary: z.string().optional(),
      description: z.string().optional(),
      startTime: z.string().optional(),
      endTime: z.string().optional(),
      location: z.string().optional(),
    }),
  }
);

const deleteCalendarEventTool = tool(
  async ({ eventId }) => {
    try {
      ensureAuthenticated();
      const calendar = getCalendar();
      await calendar.events.delete({ calendarId: "primary", eventId });
      return `✅ Event deleted successfully`;
    } catch (err) {
      return `❌ Error deleting event: ${err.message}`;
    }
  },
  {
    name: "delete_calendar_event",
    description: "Delete a calendar event.",
    schema: z.object({
      eventId: z.string(),
    }),
  }
);

const searchCalendarEventsTool = tool(
  async ({ query }) => {
    try {
      ensureAuthenticated();
      const calendar = getCalendar();

      const resp = await calendar.events.list({
        calendarId: "primary",
        q: query,
        singleEvents: true,
        orderBy: "startTime",
      });

      const events = resp.data.items || [];
      return events.length > 0
        ? `Found ${events.length} events:\n${JSON.stringify(events, null, 2)}`
        : `No events found matching "${query}"`;
    } catch (err) {
      return `❌ Error: ${err.message}`;
    }
  },
  {
    name: "search_calendar_events",
    description: "Search calendar events by keyword.",
    schema: z.object({
      query: z.string(),
    }),
  }
);

const addAttendeesToEventTool = tool(
  async ({ eventId, attendees }) => {
    try {
      ensureAuthenticated();
      const calendar = getCalendar();

      const existing = await calendar.events.get({ calendarId: "primary", eventId });
      const resource = existing.data;

      const newAttendees = attendees.split(",").map((e) => ({ email: e.trim() }));
      resource.attendees = [...(resource.attendees || []), ...newAttendees];

      await calendar.events.update({
        calendarId: "primary",
        eventId,
        resource,
        sendUpdates: "all",
      });

      return `✅ Added ${newAttendees.length} attendees`;
    } catch (err) {
      return `❌ Error: ${err.message}`;
    }
  },
  {
    name: "add_attendees_to_event",
    description: "Add attendees to an existing event.",
    schema: z.object({
      eventId: z.string(),
      attendees: z.string(),
    }),
  }
);

// -------------------- Sheets Tools --------------------
const createSheetTool = tool(
  async ({ title }) => {
    try {
      ensureAuthenticated();
      const sheets = getSheets();
      const response = await sheets.spreadsheets.create({
        requestBody: { properties: { title } }
      });
      return `✅ Spreadsheet created: ${response.data.spreadsheetUrl}`;
    } catch (err) {
      return `❌ Error: ${err.message}`;
    }
  },
  {
    name: "create_spreadsheet",
    description: "Create a new Google Spreadsheet",
    schema: z.object({ title: z.string() })
  }
);

const readSheetTool = tool(
  async ({ spreadsheetId, range }) => {
    try {
      ensureAuthenticated();
      const sheets = getSheets();
      const response = await sheets.spreadsheets.values.get({ spreadsheetId, range });
      return `✅ Data: ${JSON.stringify(response.data.values)}`;
    } catch (err) {
      return `❌ Error: ${err.message}`;
    }
  },
  {
    name: "read_sheet",
    description: "Read data from Google Sheet",
    schema: z.object({
      spreadsheetId: z.string(),
      range: z.string()
    })
  }
);

const writeSheetTool = tool(
  async ({ spreadsheetId, range, values }) => {
    try {
      ensureAuthenticated();
      const sheets = getSheets();
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values }
      });
      return `✅ Data written to ${range}`;
    } catch (err) {
      return `❌ Error: ${err.message}`;
    }
  },
  {
    name: "write_sheet",
    description: "Write data to Google Sheet",
    schema: z.object({
      spreadsheetId: z.string(),
      range: z.string(),
      values: z.array(z.array(z.string()))
    })
  }
);

// -------------------- Docs Tools --------------------
const createDocTool = tool(
  async ({ title }) => {
    try {
      ensureAuthenticated();
      const docs = getDocs();
      const response = await docs.documents.create({ requestBody: { title } });
      return `✅ Document created: https://docs.google.com/document/d/${response.data.documentId}`;
    } catch (err) {
      return `❌ Error: ${err.message}`;
    }
  },
  {
    name: "create_document",
    description: "Create a new Google Doc",
    schema: z.object({ title: z.string() })
  }
);

const readDocTool = tool(
  async ({ documentId }) => {
    try {
      ensureAuthenticated();
      const docs = getDocs();
      const response = await docs.documents.get({ documentId });
      const content = response.data.body.content
        .map(el => el.paragraph?.elements?.map(e => e.textRun?.content).join(''))
        .filter(Boolean)
        .join('');
      return `✅ Content: ${content.substring(0, 500)}...`;
    } catch (err) {
      return `❌ Error: ${err.message}`;
    }
  },
  {
    name: "read_document",
    description: "Read Google Doc content",
    schema: z.object({ documentId: z.string() })
  }
);

const writeDocTool = tool(
  async ({ documentId, text, index = 1 }) => {
    try {
      ensureAuthenticated();
      const docs = getDocs();
      await docs.documents.batchUpdate({
        documentId,
        requestBody: {
          requests: [{ insertText: { location: { index }, text } }]
        }
      });
      return `✅ Text inserted into document`;
    } catch (err) {
      return `❌ Error: ${err.message}`;
    }
  },
  {
    name: "write_document",
    description: "Write text to Google Doc",
    schema: z.object({
      documentId: z.string(),
      text: z.string(),
      index: z.number().optional()
    })
  }
);

// -------------------- Notion Tools --------------------
const createNotionDatabaseTool = tool(
  async ({ title, properties }) => {
    try {
      const parent = { type: "page_id", page_id: process.env.NOTION_PARENT_PAGE_ID };
      const dbProperties = {};
      if (properties && properties.length > 0) {
        properties.forEach(prop => {
          dbProperties[prop.name] = { [prop.type]: {} };
        });
      } else {
        dbProperties["Name"] = { title: {} };
      }
      const response = await notion.databases.create({
        parent,
        title: [{ type: "text", text: { content: title } }],
        properties: dbProperties
      });
      return `✅ Notion database "${title}" created successfully (ID: ${response.id})`;
    } catch (err) {
      return `❌ Error: ${err.message}`;
    }
  },
  {
    name: "create_notion_database",
    description: "Create a new Notion database",
    schema: z.object({
      title: z.string(),
      properties: z.array(z.object({
        name: z.string(),
        type: z.enum(["title", "rich_text", "number", "select", "date", "checkbox"])
      })).optional()
    })
  }
);

const searchNotionTool = tool(
  async ({ query }) => {
    try {
      const resp = await notion.search({
        query,
        filter: { property: "object", value: "page" },
      });
      const results = resp.results.map((p) => ({
        id: p.id,
        title: p.properties?.Name?.title?.[0]?.plain_text || "Untitled",
        url: p.url,
      }));
      return results.length > 0
        ? `Found ${results.length} pages:\n${JSON.stringify(results, null, 2)}`
        : `No pages found matching "${query}"`;
    } catch (err) {
      return `❌ Error: ${err.message}`;
    }
  },
  {
    name: "search_notion",
    description: "Search Notion pages",
    schema: z.object({ query: z.string() }),
  }
);

const listNotionDatabasesTool = tool(
  async () => {
    try {
      const resp = await notion.search({
        filter: { property: "object", value: "database" },
      });
      const results = resp.results.map((d) => ({
        id: d.id,
        title: d.title?.[0]?.plain_text || "Untitled",
      }));
      return results.length > 0
        ? `Found ${results.length} databases:\n${JSON.stringify(results, null, 2)}`
        : "No databases found";
    } catch (err) {
      return `❌ Error: ${err.message}`;
    }
  },
  {
    name: "list_notion_databases",
    description: "List all Notion databases",
    schema: z.object({}),
  }
);

const createNotionPageTool = tool(
  async ({ databaseId, title, content }) => {
    try {
      const children = content
        ? [{ object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content } }] } }]
        : [];
      const resp = await notion.pages.create({
        parent: { database_id: databaseId },
        properties: { Name: { title: [{ text: { content: title } }] } },
        children,
      });
      return `✅ Page "${title}" created (ID: ${resp.id})`;
    } catch (err) {
      return `❌ Error: ${err.message}`;
    }
  },
  {
    name: "create_notion_page",
    description: "Create a page in Notion database",
    schema: z.object({
      databaseId: z.string(),
      title: z.string(),
      content: z.string().optional(),
    }),
  }
);

// -------------------- Tools Registry --------------------
const tools = [
  sendEmailTool,
  draftEmailTool,
  listEmailsTool,
  searchEmailsTool,
  deleteEmailTool,
  createSheetTool,
  listCalendarEventsTool,
  createCalendarEventTool,
  updateCalendarEventTool,
  deleteCalendarEventTool,
  searchCalendarEventsTool,
  addAttendeesToEventTool,
  readSheetTool,
  writeSheetTool,
  createDocTool,
  readDocTool,
  writeDocTool,
  searchNotionTool,
  listNotionDatabasesTool,
  createNotionPageTool,
];

// -------------------- Agent --------------------
async function createAgentExecutor() {
  const llm = new ChatFireworks({
  model: "accounts/fireworks/models/kimi-k2-instruct-0905",
  apiKey: process.env.FIREWORKS_API_KEY,

  // SAFE PARAMETERS — no errors
  temperature: 0.6,
  maxTokens: 32768,
  topP: 1,
  topK: 40,
  frequencyPenalty: 0,
  presencePenalty: 0,
});

  const prompt = ChatPromptTemplate.fromMessages([
    ["system", `You are a helpful AI assistant managing Gmail, Calendar, Google Sheets, and Google Docs.

RULES:
1. Always ask for missing required info
2. Be concise and efficient
3. Confirm actions with emoji (e.g., ✅ or ❌)
4. Use appropriate tools for each task`],
    ["placeholder", "{chat_history}"],
    ["human", "{input}"],
    ["placeholder", "{agent_scratchpad}"],
  ]);

  const agent = await createToolCallingAgent({ llm, tools, prompt });

  return new AgentExecutor({ agent, tools, verbose: false, maxIterations: 8 });
}

// -------------------- Conversation Handler --------------------
async function handleConversation(sessionId, userMessage, attachments) {
  try {
    if (!conversationHistories.has(sessionId)) {
      conversationHistories.set(sessionId, []);
    }

    if (attachments && attachments.length > 0) {
      conversationAttachments.set(sessionId, attachments);
    }

    const chatHistory = conversationHistories.get(sessionId);
    const executor = await createAgentExecutor();

    const formattedHistory = chatHistory.map((msg) => 
      msg.role === "user" 
        ? ["human", msg.content]
        : ["assistant", msg.content]
    ).flat();

    let inputMessage = userMessage;
    if (attachments && attachments.length > 0) {
      inputMessage += `\n\n[User has attached ${attachments.length} file(s): ${attachments.map(a => `${a.name} (${(a.size/1024).toFixed(1)}KB)`).join(', ')}]`;
    }

    const result = await executor.invoke({
      input: inputMessage,
      chat_history: formattedHistory,
    });

    const assistantOutput = result.output;

    chatHistory.push({ role: "user", content: userMessage });
    chatHistory.push({ role: "assistant", content: assistantOutput });

    if (conversationAttachments.has(sessionId)) {
      conversationAttachments.delete(sessionId);
    }

    return { message: assistantOutput, success: true };
  } catch (err) {
    console.error("Agent error:", err);
    return { message: `Error: ${err.message}`, success: false };
  }
}
// ... handleConversation() ends here ...

// ⬇️ START ADDING FROM HERE ⬇️

app.get("/auth/google", (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: [
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/documents"
    ],
    prompt: "consent"
  });
  res.json({ authUrl });
});

app.get("/auth/google/callback", async (req, res) => {
  try {
    const { tokens: newTokens } = await oauth2Client.getToken(req.query.code);
    tokens = newTokens;
    oauth2Client.setCredentials(tokens);
    res.send("✅ Authenticated! Close this window.");
  } catch (err) {
    res.status(400).send(`❌ Error: ${err.message}`);
  }
});

app.post("/api/gmail/send", async (req, res) => {
  try {
    ensureAuthenticated();
    const { to, subject, body, cc, bcc, attachments } = req.body;
    if (!to || !subject || !body) return res.status(400).json({ error: "Missing fields" });
    const gmail = getGmail();
    const ccList = cc ? (Array.isArray(cc) ? cc : cc.split(",").map(e => e.trim())) : [];
    const bccList = bcc ? (Array.isArray(bcc) ? bcc : bcc.split(",").map(e => e.trim())) : [];
    const raw = attachments?.length 
      ? createEmailWithAttachments(to, subject, body, ccList, bccList, attachments.map(a => ({...a, data: a.data.replace(/^data:[^;]+;base64,/, "")})))
      : createSimpleEmail(to, subject, body, ccList, bccList);
    console.log("RAW EMAIL:\n" + Buffer.from(raw, "base64").toString() + "\n------------------");
    await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/gmail/draft", async (req, res) => {
  try {
    ensureAuthenticated();
    const { to, subject, body, cc, bcc, attachments } = req.body;
    if (!to || !subject || !body) return res.status(400).json({ error: "Missing fields" });
    const gmail = getGmail();
    const ccList = cc ? (Array.isArray(cc) ? cc : cc.split(",").map(e => e.trim())) : [];
    const bccList = bcc ? (Array.isArray(bcc) ? bcc : bcc.split(",").map(e => e.trim())) : [];
    const raw = attachments?.length 
      ? createEmailWithAttachments(to, subject, body, ccList, bccList, attachments.map(a => ({...a, data: a.data.replace(/^data:[^;]+;base64,/, "")})))
      : createSimpleEmail(to, subject, body, ccList, bccList);
    const draft = await gmail.users.drafts.create({ userId: "me", requestBody: { message: { raw } } });
    res.json({ success: true, draftId: draft.data.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/agent/chat", async (req, res) => {
  try {
    const { message, sessionId, attachments } = req.body;
    if (!message) return res.status(400).json({ message: "Message required", success: false });
    if (!tokens) return res.status(401).json({ message: "⚠️ Connect Google account first", success: false });
    const sid = sessionId || `session_${Date.now()}`;
    const result = await handleConversation(sid, message, attachments);
    res.json(result);
  } catch (err) {
    res.status(500).json({ message: err.message, success: false });
  }
});

app.get("/health", (req, res) => res.json({ status: "healthy", authenticated: !!tokens, tools: tools.length }));

app.get("/", (req, res) => res.json({ message: "🤖 AI Agent Hub API", authenticated: !!tokens, tools: tools.length }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 Server on http://localhost:${PORT}\n✅ ${tools.length} tools loaded`));