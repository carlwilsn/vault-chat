// A sign-in the API refuses, told apart from a bad moment.
//
// Carl pasted a token that had been captured mid-chunk and every turn came back
// "401 OAuth access token is invalid" — the raw API error, in his chat, over and
// over. A token the API will not take is not a failure to retry or to show: it
// is the sign-in being gone, and the only thing the app can say about it is the
// one state it already has for that ("Sign in with Claude").
//
// This is the whole of the judgement, in one place, because it decides whether
// Carl's chat stops asking: a 500 or a dropped connection must NOT read as a
// refused sign-in, or a blip would sign him out.

/** What the chat says instead of the API's own words, once the token is refused. */
export const SIGN_IN_AGAIN = "⚠️ Claude would not take this box's sign-in. Sign in with Claude again in Settings — nothing else was wrong with the turn.";

/**
 * Is this error the sign-in being refused?
 *
 * Deliberately narrow: an authentication error named as one, by status or by
 * type. Anything vaguer (a 500, a timeout, a dropped socket, a model id the
 * subscription cannot run) is a bad moment and is left alone.
 */
export function authRefused(text: unknown): boolean {
  const s = typeof text === "string" ? text : text == null ? "" : String((text as { message?: unknown }).message ?? text);
  if (!s) return false;
  // The API's own shapes: a 401/403 with a status in the text, its error type,
  // and the sentences the runtime prints for a credential it cannot use.
  return (
    /\b(401|403)\b/.test(s) ||
    /authentication_error|permission_error|invalid[_ ]api[_ ]key|invalid x-api-key|invalid bearer token/i.test(s) ||
    /oauth (access )?token (is invalid|has expired|is expired)/i.test(s) ||
    /(please )?(run|try) ['`"]?claude (auth )?login/i.test(s) ||
    /credentials? (are|is) (invalid|expired)/i.test(s)
  );
}
