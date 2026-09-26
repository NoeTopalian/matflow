/**
 * One sentence for a save that did not go through, said inside the dialog so
 * the person knows what happened and what to do, with their input kept.
 *
 * Customer simulation, 26 Sep 2026 (F-10, F-11): Add member after the session
 * had expired, and Record payment when the request was dropped, both stayed
 * open and said nothing. The four cases a dialog can be in are distinguished
 * here; the caller passes what it knows. Pure; client-safe.
 */
import { describeApiError } from "@/lib/api-field-errors";

export type SaveFailureKind = "signed_out" | "forbidden" | "invalid" | "unreachable" | "server";

export type SaveFailure = { kind: SaveFailureKind; message: string };

/**
 * @param status  HTTP status, or 0 when the request never got an answer.
 * @param body    parsed JSON body if any.
 * @param action  the button's label, e.g. "Add Member", quoted back in the sentence.
 * @param opts.idempotent  true when a retry with the same request cannot record
 *                          the same thing twice (the payment route dedupes on
 *                          requestId). Changes the unknown-outcome wording.
 */
export function describeSaveFailure(
  status: number,
  body: unknown,
  action: string,
  opts: { idempotent?: boolean } = {},
): SaveFailure {
  if (status === 401) {
    return {
      kind: "signed_out",
      message: `Your session has expired. Open MatFlow in a new tab and sign in, then press ${action} again — what you typed is kept here.`,
    };
  }
  if (status === 403) {
    const b = body as { error?: unknown } | null;
    const why = typeof b?.error === "string" && b.error ? ` (${b.error})` : "";
    return { kind: "forbidden", message: `Your role can't do this${why}. Ask the owner.` };
  }
  if (status === 0) {
    return {
      kind: "unreachable",
      message: opts.idempotent
        ? `Couldn't reach MatFlow, so we don't know whether it went through. Press ${action} again — the same one is never recorded twice.`
        : `Couldn't reach MatFlow. Nothing was saved — check the connection and press ${action} again.`,
    };
  }
  if (status >= 400 && status < 500) {
    return { kind: "invalid", message: describeApiError(body) };
  }
  return {
    kind: "server",
    message: opts.idempotent
      ? `MatFlow couldn't complete this. Press ${action} again — the same one is never recorded twice. If it keeps failing, note it down and tell the owner.`
      : `MatFlow couldn't complete this and nothing was saved. Try ${action} again; if it keeps failing, tell the owner.`,
  };
}
