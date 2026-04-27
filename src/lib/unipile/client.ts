import type {
  UnipileAccount,
  UnipileAccountListResponse,
  UnipileChat,
  UnipileChatListResponse,
  UnipileHostedAuthLinkRequest,
  UnipileHostedAuthLinkResponse,
  UnipileMessage,
  UnipileMessageListResponse,
  UnipileSendInvitationRequest,
  UnipileSendInvitationResponse,
  UnipileSendMessageRequest,
  UnipileSendMessageResponse,
  UnipileStartChatRequest,
  UnipileStartChatResponse,
  UnipileWebhookCreateRequest,
  UnipileWebhookResponse,
} from "./types";

// Unipile authenticates with X-API-KEY (not Bearer) and routes traffic via
// a per-workspace DSN that the dashboard assigns at signup
// (e.g. "api7.unipile.com:13779"). Both pieces live on organizations.
//
// Mirrors the InstantlyClient shape: 3-attempt exponential backoff on 429
// or transport errors, JSON Content-Type only when sending a body.

export class UnipileClient {
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string, dsn: string) {
    this.apiKey = apiKey;
    const trimmed = dsn.trim().replace(/\/+$/, "");
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
      this.baseUrl = `${trimmed}/api/v1`;
    } else {
      this.baseUrl = `https://${trimmed}/api/v1`;
    }
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {},
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    let lastError: Error | null = null;

    const baseHeaders: Record<string, string> = {
      "X-API-KEY": this.apiKey,
      accept: "application/json",
    };
    if (options.body !== undefined && options.body !== null) {
      baseHeaders["Content-Type"] = "application/json";
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(url, {
          ...options,
          headers: {
            ...baseHeaders,
            ...options.headers,
          },
        });

        if (response.status === 429) {
          const delay = Math.pow(2, attempt) * 1000;
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        if (!response.ok) {
          const errorBody = await response.text();
          throw new Error(
            `Unipile API error ${response.status}: ${errorBody}`,
          );
        }

        // Some endpoints (DELETE /webhooks/{id}) return empty bodies.
        const text = await response.text();
        return (text ? JSON.parse(text) : {}) as T;
      } catch (error) {
        lastError = error as Error;
        if (attempt < 2) {
          const delay = Math.pow(2, attempt) * 1000;
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError || new Error("Unipile API request failed");
  }

  // ===== ACCOUNTS =====

  async listAccounts(): Promise<UnipileAccountListResponse> {
    return this.request<UnipileAccountListResponse>("/accounts");
  }

  async getAccount(accountId: string): Promise<UnipileAccount> {
    return this.request<UnipileAccount>(
      `/accounts/${encodeURIComponent(accountId)}`,
    );
  }

  // ===== HOSTED AUTH =====

  async createHostedAuthLink(
    request: UnipileHostedAuthLinkRequest,
  ): Promise<UnipileHostedAuthLinkResponse> {
    return this.request<UnipileHostedAuthLinkResponse>(
      "/hosted/accounts/link",
      { method: "POST", body: JSON.stringify(request) },
    );
  }

  // ===== INVITATIONS (connection requests) =====

  async sendInvitation(
    request: UnipileSendInvitationRequest,
  ): Promise<UnipileSendInvitationResponse> {
    return this.request<UnipileSendInvitationResponse>("/users/invite", {
      method: "POST",
      body: JSON.stringify(request),
    });
  }

  // ===== MESSAGING =====

  async sendMessage(
    request: UnipileSendMessageRequest,
  ): Promise<UnipileSendMessageResponse> {
    const { chat_id, ...body } = request;
    return this.request<UnipileSendMessageResponse>(
      `/chats/${encodeURIComponent(chat_id)}/messages`,
      { method: "POST", body: JSON.stringify(body) },
    );
  }

  // For an InMail, set options.linkedin.inmail=true.
  async startNewChat(
    request: UnipileStartChatRequest,
  ): Promise<UnipileStartChatResponse> {
    return this.request<UnipileStartChatResponse>("/chats", {
      method: "POST",
      body: JSON.stringify(request),
    });
  }

  async listChats(
    accountId?: string,
    cursor?: string,
  ): Promise<UnipileChatListResponse> {
    const params = new URLSearchParams();
    if (accountId) params.set("account_id", accountId);
    if (cursor) params.set("cursor", cursor);
    const qs = params.toString();
    return this.request<UnipileChatListResponse>(
      `/chats${qs ? `?${qs}` : ""}`,
    );
  }

  async getChat(chatId: string): Promise<UnipileChat> {
    return this.request<UnipileChat>(`/chats/${encodeURIComponent(chatId)}`);
  }

  async getMessage(messageId: string): Promise<UnipileMessage> {
    return this.request<UnipileMessage>(
      `/messages/${encodeURIComponent(messageId)}`,
    );
  }

  async listMessagesInChat(
    chatId: string,
    cursor?: string,
  ): Promise<UnipileMessageListResponse> {
    const params = new URLSearchParams();
    if (cursor) params.set("cursor", cursor);
    const qs = params.toString();
    return this.request<UnipileMessageListResponse>(
      `/chats/${encodeURIComponent(chatId)}/messages${qs ? `?${qs}` : ""}`,
    );
  }

  // ===== WEBHOOKS =====

  async createWebhook(
    request: UnipileWebhookCreateRequest,
  ): Promise<UnipileWebhookResponse> {
    return this.request<UnipileWebhookResponse>("/webhooks", {
      method: "POST",
      body: JSON.stringify(request),
    });
  }

  async deleteWebhook(webhookId: string): Promise<void> {
    await this.request<unknown>(
      `/webhooks/${encodeURIComponent(webhookId)}`,
      { method: "DELETE" },
    );
  }

  // ===== CONNECTION TEST =====

  async testConnection(): Promise<boolean> {
    try {
      await this.listAccounts();
      return true;
    } catch {
      return false;
    }
  }
}
