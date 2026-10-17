/**
 * Per-address rate limiting for the two routes that are worth guessing at.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT THIS ADDS THAT THE ACCOUNT LOCK DOES NOT
 *
 * Accounts already lock briefly after repeated failed sign-ins, and that is the
 * right guard against somebody attacking one account. It is no guard at all
 * against the attack that is actually run: one or two attempts against each of
 * ten thousand addresses, which trips no account's lock because no account sees
 * more than two attempts. The two guards are for different attacks and neither
 * replaces the other.
 *
 * Sign-up is limited for a different reason again — an unlimited sign-up form is
 * a way to send mail from somebody else's domain, and an unlimited sign-up form
 * on a product with a free plan is a way to fill a database.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY IT COUNTS ADDRESSES AND NOT EMAILS
 *
 * Counting by submitted email is the version that looks tidier and defends
 * nothing: the attacker chooses the email, so they choose their own bucket. The
 * address is the thing they have fewer of.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE SHARP EDGE: WHERE THE ADDRESS COMES FROM
 *
 * Behind a proxy the socket address is the proxy's, so every visitor shares one
 * bucket and the first few people to sign in lock everybody else out. The fix is
 * to read `X-Forwarded-For` — but anybody can send that header, so reading it
 * when there is no proxy in front means an attacker picks their own bucket and
 * the limit is decoration.
 *
 * So it is read only when `TRUST_PROXY=1` is set, and the deployment note says
 * to set it if and only if something is terminating TLS in front. There is no
 * way to work this out at runtime: a header that is present either came from
 * your load balancer or from the client, and the request looks identical.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT IT IS NOT
 *
 * In-memory, and therefore per process. Two instances behind a balancer give an
 * attacker twice the budget, and a restart clears it. That is a real limitation
 * and it is written in the handover rather than hidden here: the alternative is
 * a shared store, which is a dependency this product does not have and should
 * not acquire for this.
 *
 * It is also not a defence against a distributed attempt from many addresses.
 * Nothing at this layer is. What it stops is the cheap version, which is the
 * version that actually gets run.
 */

/**
 * The limits.
 *
 * Deliberately generous. A limit tight enough to catch a determined attacker is
 * a limit that fires on an office behind one address, and a product that locks
 * out a whole company at 9am has chosen the wrong failure. These numbers stop
 * automated spraying and should never be reached by a person who has forgotten
 * their password.
 */
export const LIMITS = Object.freeze({
  'sign-in': Object.freeze({ attempts: 20, windowMs: 5 * 60_000 }),
  'sign-up': Object.freeze({ attempts: 10, windowMs: 60 * 60_000 }),
  // A reset request is the one form here that makes this product send mail to
  // an address somebody else chose, so an unlimited one is a way to post a
  // stranger's inbox full of our name and to spend our sending reputation
  // doing it. Ten an hour from one network is far more than a person who has
  // forgotten a password will ever need, and far less than a useful flood.
  'password-reset': Object.freeze({ attempts: 10, windowMs: 60 * 60_000 }),
});

/** Never hold more than this many addresses. Beyond it, the oldest are dropped. */
const MAX_KEYS = 20_000;

/**
 * Which address a request counts against.
 *
 * `X-Forwarded-For` is a list appended to by each hop, and the ONLY entry worth
 * reading is the last one — the address the hop you trust saw. Reading the first
 * entry is the classic mistake: it is the one the client wrote, so it is the one
 * an attacker controls.
 */
export function addressFor(req, { trustProxy = false } = {}) {
  if (trustProxy) {
    const forwarded = req.headers?.['x-forwarded-for'];
    if (forwarded) {
      const hops = String(forwarded).split(',').map((s) => s.trim()).filter(Boolean);
      if (hops.length) return hops[hops.length - 1];
    }
  }
  return req.socket?.remoteAddress ?? 'unknown';
}

export function createThrottle({ now = () => Date.now(), limits = LIMITS } = {}) {
  /** key → array of attempt times, oldest first. */
  const hits = new Map();

  /**
   * Record an attempt and say whether it is allowed.
   *
   * Counting happens on the attempt rather than on the failure, because a
   * successful guess is still an attempt and an attacker who finds a password on
   * try nineteen should not get a fresh twenty.
   */
  function check(bucket, address) {
    const limit = limits[bucket];
    if (!limit) throw new Error(`no rate limit defined for "${bucket}"`);

    const at = now();
    const key = `${bucket}:${address}`;
    const since = at - limit.windowMs;

    // Expired attempts are dropped on read rather than swept, so there is no
    // timer to leak and nothing to stop.
    const recent = (hits.get(key) ?? []).filter((t) => t > since);

    if (recent.length >= limit.attempts) {
      hits.set(key, recent);
      const retryAfter = Math.max(1, Math.ceil((recent[0] + limit.windowMs - at) / 1000));
      return { allowed: false, retryAfter, remaining: 0 };
    }

    recent.push(at);
    hits.set(key, recent);
    evict();
    return { allowed: true, retryAfter: 0, remaining: limit.attempts - recent.length };
  }

  /**
   * Forget an address's attempts.
   *
   * Called after a successful sign-in, so that somebody who got it right on the
   * third try is not nineteen attempts closer to being locked out for the rest
   * of the window.
   */
  function clear(bucket, address) {
    hits.delete(`${bucket}:${address}`);
  }

  /**
   * Keep the map bounded.
   *
   * Map preserves insertion order, so the first keys are the least recently
   * created. Dropping those under memory pressure means an attacker filling the
   * map with fresh addresses evicts their own earlier entries before they evict
   * a legitimate user's — the opposite is what would make this a liability.
   */
  function evict() {
    if (hits.size <= MAX_KEYS) return;
    const excess = hits.size - MAX_KEYS;
    let dropped = 0;
    for (const key of hits.keys()) {
      hits.delete(key);
      if (++dropped >= excess) break;
    }
  }

  return { check, clear, size: () => hits.size };
}

/**
 * What a throttled person is told.
 *
 * It says what happened and when to come back, and nothing about whether the
 * address they typed exists — the sign-in form's whole design is that it reveals
 * nothing either way, and a rate-limit message is an easy place to undo that.
 */
export const throttleSays = (retryAfter) => {
  const minutes = Math.ceil(retryAfter / 60);
  return 'Too many attempts from this network. Try again in '
    + (minutes <= 1 ? 'a minute' : `${minutes} minutes`)
    + '. Nothing is wrong with the account.';
};
