/**
 * Redaction helpers.
 *
 * Everything the server echoes back to a client — a command line, an
 * error message — may carry secrets (passwords, tokens, keys) or
 * addresses that the MCP surface deliberately never exposes.  The
 * helpers in this module mask those parts *before* the text leaves the
 * process, so a monitoring view can show "what was run" without
 * publishing the credentials that were used to run it.
 *
 * The rules are intentionally conservative: a secret is only masked
 * when it is recognisable as one.  Host names inside a command are
 * kept — they are part of the command the caller asked for — while IP
 * addresses are masked because they identify the managed host and
 * routinely leak into transport error messages.
 */

/** Keywords whose value is a secret. */
const SECRET_KEYWORDS = [
    "pass(?:word|wd|phrase)?",
    "pwd",
    "secret",
    "token",
    "api[_-]?key",
    "access[_-]?key",
    "private[_-]?key",
    "credential",
    "auth(?:orization)?",
    "session[_-]?id",
].join("|");

/** `password=secret`, `token: secret`, `passwd "secret"`, … */
const SECRET_ASSIGNMENT_RE = new RegExp(
    `((?<![\\w-])(?:${SECRET_KEYWORDS})\\s*[=:]\\s*)` +
        `(?!Bearer\\b|Basic\\b|Token\\b)("[^"]*"|'[^']*'|[^\\s]+)`,
    "gi",
);

/** `--password secret`, `--token=secret`, … */
const SECRET_FLAG_RE = new RegExp(
    `(--(?:${SECRET_KEYWORDS}))(?:=|\\s+)("[^"]*"|'[^']*'|[^\\s]+)`,
    "gi",
);

/**
 * Short flags that carry a secret as an *attached* value — the
 * `mysql -pS3cret` shape.  The value has to follow the flag directly,
 * so `curl -k https://…` (flag, space, argument) is left alone.
 */
const SECRET_SHORT_FLAG_RE = /(?<![\w-])-(p|k)([^\s\-/][^\s]*)/g;

/** `scheme://user:password@host` */
const URL_CREDENTIALS_RE = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]*:)([^\s@/]+)(@)/gi;

/**
 * `Authorization: Bearer <token>` and friends.  It runs *before* the
 * assignment rule so that the scheme name is not mistaken for the
 * value of the header.
 */
const AUTH_SCHEME_RE = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{6,}/gi;

/** A PEM-encoded private key. */
const PRIVATE_KEY_RE =
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

/** IPv4 literals — e.g. in `connect ECONNREFUSED 10.0.0.5:2222`. */
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

/**
 * IPv6 literals.
 *
 * A candidate has to consist of hex digits and colons only, has to
 * carry at least two colons *and* at least one hex letter.  That keeps
 * ordinary time stamps (`12:30:45`) and short tokens (`a:b`) intact
 * while the real addresses (`2001:db8::1:443`) are masked.
 */
const IPV6_RE =
    /\b(?=[0-9a-fA-F:]*[a-fA-F])(?=[0-9a-fA-F:]*:[0-9a-fA-F:]*:)[0-9a-fA-F:]{3,}\b/g;

/** The loopback address in its short and long spellings. */
const IPV6_LOOPBACK_RE = /(?<![\w:])(?:0:){7}0:1(?![\w:])/g;
const IPV6_LOOPBACK_SHORT_RE = /(?<![\w:])::1(?![\w:])/g;

export interface RedactOptions {
    /** Mask IP addresses. Default `true`. */
    maskAddresses?: boolean;
    /** Collapse every whitespace run into a single space. Default `true`. */
    compact?: boolean;
}

/**
 * Mask the secrets (and optionally the addresses) of a free-text
 * value.
 */
export function redactText(
    text: string | null | undefined,
    options: RedactOptions = {},
): string {
    const { maskAddresses = true, compact = true } = options;
    if (!text) return "";
    let out = String(text);
    out = out.replace(PRIVATE_KEY_RE, "***");
    out = out.replace(AUTH_SCHEME_RE, "$1 ***");
    out = out.replace(SECRET_ASSIGNMENT_RE, "$1***");
    out = out.replace(SECRET_FLAG_RE, "$1=***");
    out = out.replace(SECRET_SHORT_FLAG_RE, "-$1***");
    out = out.replace(URL_CREDENTIALS_RE, "$1***$3");
    if (maskAddresses) {
        out = out.replace(IPV4_RE, "***");
        out = out.replace(IPV6_RE, "***");
        out = out.replace(IPV6_LOOPBACK_RE, "***");
        out = out.replace(IPV6_LOOPBACK_SHORT_RE, "***");
    }
    if (compact) {
        out = out.replace(/\s+/g, " ").trim();
    }
    return out;
}

/**
 * Shorten `text` to `max` characters, marking the cut with an
 * ellipsis.
 */
export function truncate(text: string, max: number): string {
    if (max <= 0) return "";
    if (text.length <= max) return text;
    if (max === 1) return "…";
    return `${text.slice(0, max - 1)}…`;
}

/** Escape a literal for use inside a regular expression. */
function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Mask the literals that belong to one host — its address and its user
 * name.  The generic rules only catch IP addresses; a host stored under
 * a DNS name (or a user name in a command like `ssh deploy@host`) would
 * otherwise slip through.
 */
export function redactHostLiterals(
    text: string,
    literals: Array<string | null | undefined>,
): string {
    let out = text;
    for (const literal of literals) {
        const value = (literal ?? "").trim();
        // Very short values would match far too much text.
        if (value.length < 3) continue;
        out = out.replace(new RegExp(escapeRegExp(value), "g"), "***");
    }
    return out;
}

/**
 * Redact a command line and shorten it to `maxLength` characters so it
 * fits into a table cell.
 */
export function redactCommand(command: string | null | undefined, maxLength = 80): string {
    return truncate(redactText(command), maxLength);
}
