// Unipile API types — covers what the LinkedIn channel needs:
// account hosting, invitations, messaging, and webhooks. WhatsApp /
// Instagram / email types from the wider Unipile surface are out of scope.
//
// Many fields are vendor-specific and evolve; the [key: string]: unknown
// escape hatch on the larger objects keeps strict TS happy without
// committing us to a brittle full mirror of Unipile's payloads.

// ===== ACCOUNTS =====

export interface UnipileAccount {
  id: string;
  type: string;             // 'LINKEDIN' | 'GMAIL' | 'WHATSAPP' | …
  name?: string;
  status?: string;          // 'OK' | 'CREDENTIALS' | 'DISCONNECTED' | …
  created_at?: string;
  [key: string]: unknown;
}

export interface UnipileAccountListResponse {
  items: UnipileAccount[];
  cursor?: string;
}

// ===== HOSTED AUTH =====
//
// The hosted-auth flow generates a one-time URL the client visits to
// connect their LinkedIn account. On success Unipile fires an
// account_status webhook (event=connected) containing the new account_id;
// our callback route persists it on clients.unipile_account_id.

export interface UnipileHostedAuthLinkRequest {
  type: "create" | "reconnect";
  expiresOn: string;                            // ISO 8601
  providers: "LINKEDIN" | "*" | string[];
  api_url?: string;                             // org's Unipile DSN
  notify_url?: string;                          // webhook for status events
  success_redirect_url?: string;
  failure_redirect_url?: string;
  name?: string;                                // tag for the session
}

export interface UnipileHostedAuthLinkResponse {
  url: string;
  expiresOn?: string;
}

// ===== INVITATIONS (LinkedIn connection requests) =====

export interface UnipileSendInvitationRequest {
  account_id: string;
  provider_id: string;        // LinkedIn user id of the recipient
  message?: string;           // optional 1-line note, ~300 char limit
}

export interface UnipileSendInvitationResponse {
  invitation_id: string;
  status?: string;
}

// ===== CHATS & MESSAGES =====

export interface UnipileStartChatRequest {
  account_id: string;
  attendees_ids: string[];                  // recipient provider_ids
  text: string;
  options?: {
    linkedin?: {
      api?: "classic" | "recruiter" | "sales_navigator";
      inmail?: boolean;
      subject?: string;                     // required for InMail
    };
  };
}

export interface UnipileStartChatResponse {
  chat_id: string;
  message_id: string;
}

export interface UnipileSendMessageRequest {
  chat_id: string;
  text: string;
}

export interface UnipileSendMessageResponse {
  message_id: string;
}

export interface UnipileChat {
  id: string;
  account_id: string;
  attendees: Array<{ provider_id: string; name?: string }>;
  last_message?: UnipileMessage;
  unread_count?: number;
  created_at?: string;
  [key: string]: unknown;
}

export interface UnipileChatListResponse {
  items: UnipileChat[];
  cursor?: string;
}

export interface UnipileMessage {
  id: string;
  chat_id: string;
  account_id?: string;
  sender_id?: string;
  is_sender?: boolean;
  text?: string;
  attachments?: unknown[];
  timestamp?: string;
  [key: string]: unknown;
}

export interface UnipileMessageListResponse {
  items: UnipileMessage[];
  cursor?: string;
}

// ===== WEBHOOKS =====

export type UnipileWebhookSource =
  | "messaging"        // inbound DMs / InMails / etc.
  | "users"            // invitation status changes
  | "account_status";  // disconnect / re-auth events

export interface UnipileWebhookCreateRequest {
  source: UnipileWebhookSource;
  request_url: string;
  name?: string;
  account_ids?: string[];                       // optional account scoping
  events?: string[];                            // optional event-type filter
  headers?: Array<{ key: string; value: string }>;
}

export interface UnipileWebhookResponse {
  webhook_id: string;
}

// Decoded payloads — what the webhook handler in commit #5 cares about.

export interface UnipileMessagingEvent {
  source: "messaging";
  event: "message_received" | "message_read";
  account_id: string;
  chat_id: string;
  message_id: string;
  sender_id: string;
  text?: string;
  timestamp: string;
}

export interface UnipileUsersEvent {
  source: "users";
  event: "invitation_accepted" | "invitation_pending" | "invitation_withdrawn";
  account_id: string;
  invitation_id: string;
  provider_id: string;
  timestamp: string;
}

export interface UnipileAccountStatusEvent {
  source: "account_status";
  event: "connected" | "disconnected" | "credentials_invalid";
  account_id: string;
  timestamp: string;
}

export type UnipileWebhookEvent =
  | UnipileMessagingEvent
  | UnipileUsersEvent
  | UnipileAccountStatusEvent;
