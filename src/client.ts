import { randomUUID } from "node:crypto";

import { AdapterError } from "@chat-adapter/shared";
import type { FileUpload } from "chat";
import { NotImplementedError } from "chat";
import { lookup } from "mime-types";

import { NAME } from "./constants";
import type { PhotonAttachment } from "./types";

export interface PhotonApiOptions {
  apiKey: string;
  /** API origin, without a trailing slash. */
  baseUrl: string;
  projectId: string;
}

interface RequestOptions {
  body?: Blob;
  contentType?: string;
  idempotent?: boolean;
  json?: unknown;
}

/** Calls one project's Photon API, turning its errors into Chat SDK errors. */
export class PhotonClient {
  readonly options: PhotonApiOptions;

  constructor(options: PhotonApiOptions) {
    this.options = options;
  }

  async request(
    method: string,
    path: string,
    feature: string,
    init: RequestOptions = {}
  ): Promise<Response> {
    const { apiKey, baseUrl, projectId } = this.options;
    const headers = new Headers({ authorization: `Bearer ${apiKey}` });
    if (init.json !== undefined) {
      headers.set("content-type", "application/json");
    }
    if (init.contentType) {
      headers.set("content-type", init.contentType);
    }
    if (init.idempotent) {
      headers.set("idempotency-key", randomUUID());
    }
    const response = await fetch(`${baseUrl}/v1/projects/${projectId}${path}`, {
      method,
      headers,
      body: init.json === undefined ? init.body : JSON.stringify(init.json),
    });
    if (response.ok) {
      return response;
    }

    const problem = (await response.json().catch(() => ({}))) as {
      code?: string;
      detail?: string;
      title?: string;
    };
    const detail = problem.detail ?? problem.title ?? response.statusText;
    if (
      problem.code === "UNSUPPORTED_CONTENT" ||
      problem.code === "OPERATION_UNAVAILABLE"
    ) {
      throw new NotImplementedError(`${feature}: ${detail}`, feature);
    }
    throw new AdapterError(
      `${feature} failed with ${response.status}${problem.code ? ` ${problem.code}` : ""}: ${detail}`,
      NAME,
      problem.code
    );
  }

  /** Uploads a file as the two-part multipart/related body Photon expects and returns its attachment ID. */
  async upload(file: FileUpload): Promise<string> {
    const bytes = new Uint8Array(
      file.data instanceof Blob ? await file.data.arrayBuffer() : file.data
    );
    const contentType = (
      file.mimeType ||
      lookup(file.filename) ||
      "application/octet-stream"
    )
      .split(";")[0]
      ?.trim() as string;
    const boundary = `photon-${randomUUID()}`;
    const metadata = JSON.stringify({
      contentType,
      sizeBytes: bytes.byteLength,
      filename: file.filename,
    });
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n${metadata}\r\n`,
      `--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`,
      bytes,
      `\r\n--${boundary}--\r\n`,
    ]);
    const response = await this.request("POST", "/attachments", "postMessage", {
      body,
      contentType: `multipart/related; boundary=${boundary}`,
      idempotent: true,
    });
    return ((await response.json()) as PhotonAttachment).id;
  }

  async download(attachmentId: string): Promise<Buffer> {
    const response = await this.request(
      "GET",
      `/attachments/${attachmentId}/content`,
      "fetchAttachment"
    );
    return Buffer.from(await response.arrayBuffer());
  }
}
