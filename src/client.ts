/**
 * Zulip REST API client using native fetch.
 *
 * Auth: HTTP Basic with bot email + API key.
 * Docs: https://zulip.com/api/
 */

export interface ZulipClientConfig {
  botEmail: string;
  botApiKey: string;
  site: string; // e.g. https://your-org.zulipchat.com
}

export interface ZulipMessage {
  id: number;
  sender_id: number;
  sender_email: string;
  sender_full_name: string;
  type: "private" | "stream" | "direct";
  display_recipient: any; // array of user objects for DMs, string for streams
  subject: string; // topic name for stream messages
  stream_id?: number;
  content: string;
  timestamp: number;
}

export interface ZulipEvent {
  type: string;
  id: number;
  message?: ZulipMessage;
}

export interface RegisterQueueResponse {
  queue_id: string;
  last_event_id: number;
  event_queue_longpoll_timeout_seconds?: number;
}

export interface GetEventsResponse {
  events: ZulipEvent[];
  result: string;
  msg?: string;
}

export interface SendMessageResponse {
  id: number;
  result: string;
  msg?: string;
}

export interface GetMessagesResponse {
  result: string;
  msg?: string;
  messages: ZulipMessage[];
  found_anchor: boolean;
  found_oldest: boolean;
  found_newest: boolean;
}

export class ZulipClient {
  private authHeader: string;
  private baseUrl: string;

  constructor(private config: ZulipClientConfig) {
    // Zulip uses HTTP Basic: base64(email:apiKey)
    const credentials = Buffer.from(
      `${config.botEmail}:${config.botApiKey}`
    ).toString("base64");
    this.authHeader = `Basic ${credentials}`;
    this.baseUrl = config.site.replace(/\/+$/, "");
  }

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, any>
  ): Promise<T> {
    let url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: this.authHeader,
    };
    const opts: RequestInit = { method, headers };

    if (body) {
      const params = this.encodeParams(body, method === "GET");
      if (method === "GET") {
        const qs = params.toString();
        if (qs) url += (url.includes("?") ? "&" : "?") + qs;
      } else {
        headers["Content-Type"] = "application/x-www-form-urlencoded";
        opts.body = params.toString();
      }
    }

    return this.doFetch<T>(url, opts);
  }

  /** Encode params for Zulip's form-urlencoded API. GET uses String(), POST uses JSON for non-strings. */
  private encodeParams(body: Record<string, any>, asGet: boolean): URLSearchParams {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(body)) {
      if (value === undefined) continue;
      params.set(key, asGet ? String(value) : (typeof value === "string" ? value : JSON.stringify(value)));
    }
    return params;
  }

  private async doFetch<T>(url: string, opts: RequestInit): Promise<T> {
    const resp = await fetch(url, opts);
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(
        `Zulip API error: ${resp.status} ${resp.statusText} - ${text}`
      );
    }
    return resp.json() as Promise<T>;
  }

  /**
   * Register an event queue for long-polling.
   * If streamNames are provided, listens to DMs + those streams.
   * Otherwise, DMs only.
   * https://zulip.com/api/register-queue
   */
  async registerQueue(streamNames?: string[]): Promise<RegisterQueueResponse> {
    if (streamNames && streamNames.length > 0) {
      // Listen to all messages (DMs + streams) — we filter in the handler
      return this.request<RegisterQueueResponse>("POST", "/api/v1/register", {
        event_types: ["message"],
      });
    }
    return this.request<RegisterQueueResponse>("POST", "/api/v1/register", {
      event_types: ["message"],
      narrow: [["is", "dm"]], // Only DM events
    });
  }

  /**
   * Long-poll for events from the queue.
   * https://zulip.com/api/get-events
   */
  async getEvents(
    queueId: string,
    lastEventId: number
  ): Promise<GetEventsResponse> {
    return this.request<GetEventsResponse>("GET", "/api/v1/events", {
      queue_id: queueId,
      last_event_id: lastEventId,
    });
  }

  /**
   * Send a direct message.
   * https://zulip.com/api/send-message
   */
  async sendDirectMessage(
    to: string | string[],
    content: string
  ): Promise<SendMessageResponse> {
    const recipients = Array.isArray(to) ? to : [to];
    return this.request<SendMessageResponse>("POST", "/api/v1/messages", {
      type: "direct",
      to: recipients,
      content,
    });
  }

  /**
   * Delete an event queue (cleanup).
   */
  async deleteQueue(queueId: string): Promise<void> {
    await this.request("DELETE", "/api/v1/events", {
      queue_id: queueId,
    }).catch(() => {});
  }

  /**
   * Send a message to a stream/topic.
   * https://zulip.com/api/send-message
   */
  async sendStreamMessage(
    stream: string,
    topic: string,
    content: string
  ): Promise<SendMessageResponse> {
    return this.request<SendMessageResponse>("POST", "/api/v1/messages", {
      type: "stream",
      to: stream,
      topic,
      content,
    });
  }

  /**
   * Subscribe the bot to streams.
   * https://zulip.com/api/subscribe
   */
  async subscribeToStreams(
    streams: Array<{ name: string }>
  ): Promise<{ subscribed: Record<string, string[]>; already_subscribed: Record<string, string[]> }> {
    return this.request("POST", "/api/v1/users/me/subscriptions", {
      subscriptions: streams,
    });
  }

  /**
   * Get subscribed streams.
   * https://zulip.com/api/get-subscriptions
   */
  async getSubscriptions(): Promise<{ subscriptions: Array<{ name: string; stream_id: number }> }> {
    return this.request("GET", "/api/v1/users/me/subscriptions");
  }

  /**
   * Fetch recent messages matching a narrow.
   * https://zulip.com/api/get-messages
   */
  async getMessages(opts: {
    narrow: Array<{ operator: string; operand: string }>;
    anchor?: string | number;
    numBefore?: number;
    numAfter?: number;
    applyMarkdown?: boolean;
  }): Promise<GetMessagesResponse> {
    return this.request<GetMessagesResponse>("GET", "/api/v1/messages", {
      narrow: JSON.stringify(opts.narrow),
      anchor: opts.anchor ?? "newest",
      num_before: opts.numBefore ?? 20,
      num_after: opts.numAfter ?? 0,
      apply_markdown: opts.applyMarkdown ?? false,
    });
  }

  /**
   * Fetch recent messages from a stream+topic.
   */
  async getStreamTopicHistory(
    stream: string,
    topic: string,
    numBefore = 20
  ): Promise<ZulipMessage[]> {
    const resp = await this.getMessages({
      narrow: [
        { operator: "channel", operand: stream },
        { operator: "topic", operand: topic },
      ],
      numBefore,
    });
    return resp.messages;
  }

  /**
   * Fetch recent DM messages with a specific user.
   */
  async getDmHistory(
    userEmail: string,
    numBefore = 20
  ): Promise<ZulipMessage[]> {
    const resp = await this.getMessages({
      narrow: [{ operator: "dm", operand: userEmail }],
      numBefore,
    });
    return resp.messages;
  }

  /**
   * Update a message (content, topic, or both).
   * https://zulip.com/api/update-message
   */
  async updateMessage(
    messageId: number,
    opts: { content?: string; topic?: string; propagateMode?: "change_one" | "change_later" | "change_all" }
  ): Promise<{ result: string; msg?: string }> {
    const body: Record<string, any> = {};
    if (opts.content !== undefined) body.content = opts.content;
    if (opts.topic !== undefined) body.topic = opts.topic;
    if (opts.propagateMode) body.propagate_mode = opts.propagateMode;
    return this.request("PATCH", `/api/v1/messages/${messageId}`, body);
  }

  /**
   * Resolve a topic by prepending "✔ " to the topic name.
   * Requires a message ID from that topic. Uses propagate_mode=change_all
   * to rename the topic across all messages.
   */
  async resolveTopic(messageId: number, currentTopic: string): Promise<void> {
    if (currentTopic.startsWith("✔ ")) return; // already resolved
    await this.updateMessage(messageId, {
      topic: `✔ ${currentTopic}`,
      propagateMode: "change_all",
    });
  }

  /**
   * Unresolve a topic by removing the "✔ " prefix.
   */
  async unresolveTopic(messageId: number, currentTopic: string): Promise<void> {
    if (!currentTopic.startsWith("✔ ")) return; // not resolved
    await this.updateMessage(messageId, {
      topic: currentTopic.slice(2),
      propagateMode: "change_all",
    });
  }

  /**
   * Get the bot's own user profile.
   */
  async getOwnUser(): Promise<{
    user_id: number;
    email: string;
    full_name: string;
  }> {
    return this.request("GET", "/api/v1/users/me");
  }
}
