export type TaskStatus =
  | "queued"
  | "searching"
  | "needs_source"
  | "needs_selection"
  | "downloading"
  | "staged"
  | "delivering"
  | "delivery_unknown"
  | "delivered"
  | "failed"
  | "cancelled";

export interface BookRequest {
  query: string;
  author?: string;
  language?: string;
  preferredFormat?: "epub" | "pdf";
}

export interface BookIdentifiers {
  isbn10?: string[];
  isbn13?: string[];
  openLibraryWorkKeys?: string[];
  googleVolumeIds?: string[];
}

export interface BookTitleVariant {
  title: string;
  language?: string;
  source: "request" | "openlibrary" | "google-books";
}

export interface BookIdentity {
  canonicalTitle: string;
  authors: string[];
  titles: BookTitleVariant[];
  identifiers: BookIdentifiers;
}

export interface BookSearchContext {
  request: BookRequest;
  preferredLanguage: string;
  identity: BookIdentity;
  queryVariants: string[];
}

export interface BookCandidate {
  id: string;
  title: string;
  author?: string;
  language?: string;
  format: string;
  sizeBytes?: number;
  source: string;
  sourceRef: string;
  identifiers?: BookIdentifiers;
  editionKey?: string;
  sourceQuality?: number;
  score?: number;
}

export interface DeliveryReceipt {
  provider: string;
  acceptedAt: string;
  messageId?: string;
  threadId?: string;
}

export interface TaskRecord {
  id: string;
  status: TaskStatus;
  request: BookRequest;
  candidates?: BookCandidate[];
  selectedCandidate?: BookCandidate;
  storageKey?: string;
  deliveryReceipt?: DeliveryReceipt;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface BookTaskQueueMessage {
  kind?: "book";
  taskId: string;
}

export interface TelegramImageQueueMessage {
  kind: "telegram_image";
  chatId: string;
  userId: string;
  sourceMessageId: number;
  fileId: string;
  caption?: string;
  declaredSizeBytes?: number;
  mimeType?: string;
}

export type TaskQueueMessage = BookTaskQueueMessage | TelegramImageQueueMessage;

export interface SourceAdapter {
  name: string;
  search(context: BookSearchContext): Promise<BookCandidate[]>;
  download(
    candidate: BookCandidate,
    options?: { maxBytes?: number },
  ): Promise<{
    body: ReadableStream<Uint8Array>;
    contentType: string;
    sizeBytes?: number;
  }>;
}

export interface DeliveryAdapter {
  name: string;
  deliver(input: {
    task: TaskRecord;
    object: R2ObjectBody;
    kindleEmail: string;
  }): Promise<DeliveryReceipt>;
}

export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  TASK_QUEUE: Queue<TaskQueueMessage>;
  AI: Ai;
  API_TOKEN: string;
  KINDLE_EMAIL?: string;
  APP_ENV?: string;
  TEMP_OBJECT_TTL_HOURS?: string;
  MAX_CLOUD_FILE_BYTES?: string;
  MAX_TELEGRAM_IMAGE_BYTES?: string;
  GMAIL_CLIENT_ID?: string;
  GMAIL_CLIENT_SECRET?: string;
  GMAIL_REFRESH_TOKEN?: string;
  GMAIL_FROM_EMAIL?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  TELEGRAM_ALLOWED_USER_IDS?: string;
  ZLIBRARY_EMAIL?: string;
  ZLIBRARY_PASSWORD?: string;
  ZLIBRARY_REMIX_USERID?: string;
  ZLIBRARY_REMIX_USERKEY?: string;
  ZLIBRARY_DOMAIN?: string;
  // Free Tier Guard
  FREE_TIER_GUARD_ENABLED?: string;
  MAX_MONTHLY_TASKS?: string;
  MAX_MONTHLY_AI_IMAGES?: string;
  MAX_MONTHLY_SOURCE_REQUESTS?: string;
  MAX_MONTHLY_R2_PUTS?: string;
  MAX_MONTHLY_DELIVERIES?: string;
}
