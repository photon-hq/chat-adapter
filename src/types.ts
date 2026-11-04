import type { Logger } from "chat";

export interface PhotonAdapterConfig {
  /** Project API key (`pho_sk_...`). Defaults to `PHOTON_API_KEY`. */
  apiKey?: string;
  /** Photon API origin. Defaults to `PHOTON_API_URL`, then https://api.photon.codes. */
  baseUrl?: string;
  logger?: Logger;
  /** Photon project ID. Defaults to `PHOTON_PROJECT_ID`. */
  projectId?: string;
  /** Bot name matched for @-mentions in group Spaces. Defaults to "photon". */
  userName?: string;
  /** Webhook destination signing secret (`whsec_...`). Defaults to `PHOTON_WEBHOOK_SECRET`. */
  webhookSecret?: string;
}

/** A Chat SDK thread is one Photon Space, spoken in by one of the project's Agent Users. */
export interface PhotonThreadId {
  agentUserId: string;
  spaceId: string;
  /** Photon Space kind, such as "direct" or "group". */
  spaceKind: string;
}

export interface PhotonUser {
  handle: string;
  id: string;
  kind: string;
  platform: string;
  [key: string]: unknown;
}

export interface PhotonSpace {
  id: string;
  kind: string;
  participantIds: string[];
  platform: string;
  [key: string]: unknown;
}

export interface PhotonContent {
  type: string;
  [key: string]: unknown;
}

/** A Photon Message as the API and webhooks return it. */
export interface PhotonMessage {
  content: PhotonContent;
  createdAt: string;
  id: string;
  parentMessageId?: string;
  platform: string;
  receivedBy?: PhotonUser;
  sentBy: PhotonUser;
  space: PhotonSpace;
  status: string;
  timestamps: Record<string, string | undefined>;
  [key: string]: unknown;
}

/** A Photon event envelope, as webhooks and the websocket deliver it. */
export interface PhotonEvent {
  data?: { object?: PhotonMessage };
  id?: string;
  type?: string;
}

export interface PhotonAttachment {
  contentType: string;
  filename?: string;
  id: string;
  sizeBytes: number;
}
