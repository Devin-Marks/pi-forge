import { Client, type Entry, type SearchOptions } from "ldapts";
import { config } from "./config.js";

export interface LdapClientLike {
  bind(dn: string, password?: string): Promise<void>;
  search(baseDn: string, options?: SearchOptions): Promise<{ searchEntries: Entry[] }>;
  unbind(): Promise<void>;
}

export interface LdapLoginResult {
  ok: boolean;
  error?:
    | "disabled"
    | "misconfigured"
    | "invalid_credentials"
    | "user_not_found"
    | "group_required"
    | "ldap_error";
}

export type LdapClientFactory = () => LdapClientLike;

function createLdapClient(): LdapClientLike {
  return new Client({
    url: config.auth.ldap.url ?? "ldap://127.0.0.1:389",
    timeout: config.auth.ldap.timeoutMs,
    connectTimeout: config.auth.ldap.timeoutMs,
    tlsOptions: {
      rejectUnauthorized: config.auth.ldap.tlsRejectUnauthorized,
    },
  });
}

export function ldapConfigured(): boolean {
  const ldap = config.auth.ldap;
  return (
    ldap.enabled &&
    ldap.url !== undefined &&
    ldap.bindDn !== undefined &&
    ldap.bindPassword !== undefined &&
    ldap.baseDn !== undefined
  );
}

export async function verifyLdapLogin(
  username: string,
  password: string,
  factory: LdapClientFactory = createLdapClient,
): Promise<LdapLoginResult> {
  const ldap = config.auth.ldap;
  if (!ldap.enabled) return { ok: false, error: "disabled" };
  if (!ldapConfigured()) {
    console.warn("[ldap] login skipped: LDAP is enabled but required config is missing");
    return { ok: false, error: "misconfigured" };
  }
  if (username.trim().length === 0 || password.length === 0) {
    return { ok: false, error: "invalid_credentials" };
  }

  const client = factory();
  try {
    console.info(
      `[ldap] login attempt: url=${ldap.url}, baseDn=${ldap.baseDn}, username=${username}, tlsRejectUnauthorized=${ldap.tlsRejectUnauthorized}`,
    );
    await client.bind(ldap.bindDn!, ldap.bindPassword);
    const filter = renderUserFilter(ldap.userFilter, username);
    const attributes = [ldap.groupAttribute];
    const result = await client.search(ldap.baseDn!, {
      scope: "sub",
      filter,
      sizeLimit: 2,
      attributes,
    });

    if (result.searchEntries.length !== 1) {
      const error = result.searchEntries.length === 0 ? "user_not_found" : "ldap_error";
      console.warn(
        `[ldap] login failed before user bind: username=${username}, reason=${error}, matches=${result.searchEntries.length}`,
      );
      return { ok: false, error };
    }

    const entry = result.searchEntries[0];
    if (entry === undefined || typeof entry.dn !== "string" || entry.dn.length === 0) {
      console.warn(`[ldap] login failed: username=${username}, reason=missing_user_dn`);
      return { ok: false, error: "ldap_error" };
    }

    if (
      ldap.requiredGroupDn !== undefined &&
      !entryHasGroup(entry, ldap.groupAttribute, ldap.requiredGroupDn)
    ) {
      console.warn(`[ldap] login failed: username=${username}, reason=group_required`);
      return { ok: false, error: "group_required" };
    }

    await client.bind(entry.dn, password);
    console.info(`[ldap] login succeeded: username=${username}`);
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[ldap] login failed: username=${username}, reason=bind_or_search_error, error=${message}`,
    );
    return { ok: false, error: "invalid_credentials" };
  } finally {
    await client.unbind().catch(() => undefined);
  }
}

export function renderUserFilter(template: string, username: string): string {
  return template.replaceAll("{{username}}", escapeLdapFilterValue(username));
}

export function escapeLdapFilterValue(value: string): string {
  let escaped = "";
  for (const ch of value) {
    switch (ch) {
      case "\\":
        escaped += "\\5c";
        break;
      case "*":
        escaped += "\\2a";
        break;
      case "(":
        escaped += "\\28";
        break;
      case ")":
        escaped += "\\29";
        break;
      default:
        escaped += ch.charCodeAt(0) === 0 ? "\\00" : ch;
        break;
    }
  }
  return escaped;
}

function entryHasGroup(entry: Entry, attribute: string, requiredGroupDn: string): boolean {
  const raw = entry[attribute];
  const values = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  return values.some((value) => String(value).toLowerCase() === requiredGroupDn.toLowerCase());
}
