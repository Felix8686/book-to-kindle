export type TaskStatus =
  | "queued"
  | "searching"
  | "needs_source"
  | "needs_selection"
  | "downloading"
  | "staged"
  | "delivering"
  | "delivered"
  | "failed";

export interface BookRequest {
  query: string;
  author?: string;
  language?: string;
  preferredFormat?: "epub" | "pdf";
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
  score?: number;
}

export interface TaskRecord {
  id: string;
  status: TaskStatus;
  request: BookRequest;
  selectedCandidate?: BookCandidate;
  storageKey?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskQueueMessage {
  taskId: string;
}

export interface SourceAdapter {
  name: string;
  search(request: BookRequest): Promise<BookCandidate[]>;
  download(candidate: BookCandidate): Promise<{
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
  }): Promise<void>;
}

export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  TASK_QUEUE: Queue<TaskQueueMessage>;
  API_TOKEN: string;
  KINDLE_EMAIL?: string;
  APP_ENV?: string;
  TEMP_OBJECT_TTL_HOURS?: string;
}
