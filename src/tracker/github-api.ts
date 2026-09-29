import { TrackerError } from "./types.ts";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface GitHubApi {
  /** GraphQL endpoint; the REST base is derived from it. */
  endpoint: string;
  token: string;
  fetchImpl: FetchLike;
}

function rateLimited(response: Response): boolean {
  return response.status === 429 || (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0");
}

export async function graphqlRequest(api: GitHubApi, query: string, variables: Record<string, unknown>, options: { allowNotFound?: boolean } = {}): Promise<unknown> {
  let response: Response;
  try {
    response = await api.fetchImpl(api.endpoint, {
      method: "POST",
      headers: { authorization: `bearer ${api.token}`, "content-type": "application/json", "user-agent": "symphony-copilot" },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new TrackerError("tracker_request", (error as Error).message);
  }
  if (rateLimited(response)) throw new TrackerError("tracker_rate_limited", `HTTP ${response.status}`);
  if (!response.ok) throw new TrackerError("tracker_status", `HTTP ${response.status}`);
  let payload: { data?: unknown; errors?: Array<{ type?: string; message?: string }> };
  try {
    payload = await response.json() as typeof payload;
  } catch (error) {
    throw new TrackerError("tracker_response", `invalid JSON: ${(error as Error).message}`);
  }
  if (payload.errors?.length && !(options.allowNotFound && payload.errors.every((e) => e.type === "NOT_FOUND"))) {
    const limited = payload.errors.some((e) => e.type === "RATE_LIMITED");
    throw new TrackerError(limited ? "tracker_rate_limited" : "tracker_response", payload.errors.map((e) => e.message).join("; "));
  }
  if (payload.data === undefined || payload.data === null) throw new TrackerError("tracker_response", "response without data");
  return payload.data;
}

/** GitHub REST call; `allowMissing` turns a 404 into null. */
export async function restRequest(api: GitHubApi, method: string, path: string, body?: unknown, allowMissing = false): Promise<unknown> {
  const base = api.endpoint.replace(/\/api\/graphql$/, "/api/v3").replace(/\/graphql$/, "");
  let response: Response;
  try {
    response = await api.fetchImpl(`${base}${path}`, {
      method,
      headers: { authorization: `bearer ${api.token}`, accept: "application/vnd.github+json", "content-type": "application/json", "user-agent": "symphony-copilot" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    throw new TrackerError("tracker_request", (error as Error).message);
  }
  if (allowMissing && response.status === 404) return null;
  if (rateLimited(response)) throw new TrackerError("tracker_rate_limited", `HTTP ${response.status}`);
  if (!response.ok) throw new TrackerError("tracker_status", `HTTP ${response.status} for ${method} ${path}`);
  try {
    return await response.json();
  } catch (error) {
    throw new TrackerError("tracker_response", `invalid JSON: ${(error as Error).message}`);
  }
}
