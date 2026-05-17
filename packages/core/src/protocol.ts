import type { Protocol, ProtocolEndpoint } from "./types";

/**
 * Compute the HTTP auth headers to send to the upstream for a given protocol
 * and endpoint configuration. The endpoint may specify an `authHeader` override
 * (header name or, for OpenAI-style, a Bearer prefix).
 */
export function buildAuthHeaders(
  endpoint: ProtocolEndpoint,
  protocol: Protocol,
  apiKey: string,
): Record<string, string> {
  const override = endpoint.authHeader?.trim();

  if (override) {
    const lower = override.toLowerCase();
    if (lower === "x-api-key") return { "x-api-key": apiKey };
    if (lower === "x-goog-api-key") return { "x-goog-api-key": apiKey };
    if (lower === "authorization" || lower === "bearer") {
      return { Authorization: `Bearer ${apiKey}` };
    }
    // Treat anything else as a custom prefix on the Authorization header
    return { Authorization: `${override} ${apiKey}` };
  }

  // Defaults per protocol
  if (protocol === "gemini") return { "x-goog-api-key": apiKey };
  return { Authorization: `Bearer ${apiKey}` };
}

interface ErrorPayload {
  message: string;
  /** Best-effort HTTP status; used by Gemini error payload */
  status: number;
}

/**
 * Produce an error response body matching the dialect of the originating
 * protocol so that strict client SDKs can parse it.
 */
export function buildProtocolErrorBody(
  protocol: Protocol,
  payload: ErrorPayload,
): unknown {
  if (protocol === "anthropic") {
    return {
      type: "error",
      error: {
        type: "api_error",
        message: payload.message,
      },
    };
  }
  if (protocol === "gemini") {
    return {
      error: {
        code: payload.status,
        message: payload.message,
        status: geminiStatusName(payload.status),
      },
    };
  }
  // openai
  return {
    error: {
      message: payload.message,
      type: "upstream_error",
      code: null,
    },
  };
}

function geminiStatusName(status: number): string {
  switch (status) {
    case 400:
      return "INVALID_ARGUMENT";
    case 401:
      return "UNAUTHENTICATED";
    case 403:
      return "PERMISSION_DENIED";
    case 404:
      return "NOT_FOUND";
    case 429:
      return "RESOURCE_EXHAUSTED";
    case 502:
      return "UNAVAILABLE";
    case 503:
      return "UNAVAILABLE";
    case 504:
      return "DEADLINE_EXCEEDED";
    default:
      return "INTERNAL";
  }
}
