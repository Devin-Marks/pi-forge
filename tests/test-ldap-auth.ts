/**
 * LDAP auth unit coverage without a live LDAP server.
 *
 * Imports the compiled ldap-auth module after pinning LDAP_* env and injects
 * a fake LDAP client factory. This covers filter escaping, service-account
 * search, memberOf authorization, and user-bind credential verification.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");

let failures = 0;
function assert(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const dataDir = await mkdtemp(join(tmpdir(), "pi-forge-ldap-auth-"));
process.env.NODE_ENV = "test";
process.env.FORGE_DATA_DIR = dataDir;
process.env.WORKSPACE_PATH = join(dataDir, "workspace");
process.env.LDAP_ENABLED = "true";
process.env.LDAP_URL = "ldaps://ldap.example.test";
process.env.LDAP_BIND_DN = "cn=pi-forge,ou=svc,dc=example,dc=test";
process.env.LDAP_BIND_PASSWORD = "service-secret";
process.env.LDAP_BASE_DN = "ou=people,dc=example,dc=test";
process.env.LDAP_REQUIRED_GROUP_DN = "cn=pi-forge-users,ou=groups,dc=example,dc=test";
delete process.env.UI_PASSWORD;
delete process.env.API_KEY;

interface SearchCall {
  baseDn: string;
  filter?: unknown;
  attributes?: string[];
  sizeLimit?: number;
}

class FakeLdapClient {
  readonly searchEntries: Record<string, unknown>[];
  readonly userPassword: string;
  readonly binds: { dn: string; password: string | undefined }[] = [];
  readonly searches: SearchCall[] = [];
  unbound = false;

  constructor(searchEntries: Record<string, unknown>[], userPassword = "user-secret") {
    this.searchEntries = searchEntries;
    this.userPassword = userPassword;
  }

  async bind(dn: string, password?: string): Promise<void> {
    this.binds.push({ dn, password });
    if (dn === process.env.LDAP_BIND_DN && password === process.env.LDAP_BIND_PASSWORD) return;
    if (dn === "uid=alice,ou=people,dc=example,dc=test" && password === this.userPassword) return;
    throw new Error("invalid credentials");
  }

  async search(
    baseDn: string,
    options?: SearchCall,
  ): Promise<{ searchEntries: Record<string, unknown>[] }> {
    this.searches.push({ baseDn, ...options });
    return { searchEntries: this.searchEntries };
  }

  async unbind(): Promise<void> {
    this.unbound = true;
  }
}

try {
  const ldapModule = (await import(resolve(repoRoot, "packages/server/dist/ldap-auth.js"))) as {
    escapeLdapFilterValue: (value: string) => string;
    renderUserFilter: (template: string, username: string) => string;
    verifyLdapLogin: (
      username: string,
      password: string,
      factory: () => FakeLdapClient,
    ) => Promise<{ ok: boolean; error?: string }>;
  };

  assert(
    "LDAP filter values are escaped per RFC4515",
    ldapModule.escapeLdapFilterValue("a*b(c)d\\e\u0000") === "a\\2ab\\28c\\29d\\5ce\\00",
  );
  assert(
    "user filter substitutes escaped username",
    ldapModule.renderUserFilter("(uid={{username}})", "a*)") === "(uid=a\\2a\\29)",
  );

  const allowed = new FakeLdapClient([
    {
      dn: "uid=alice,ou=people,dc=example,dc=test",
      memberOf: ["cn=pi-forge-users,ou=groups,dc=example,dc=test"],
    },
  ]);
  const ok = await ldapModule.verifyLdapLogin("alice", "user-secret", () => allowed);
  assert("valid service bind, memberOf, and user bind succeeds", ok.ok === true, ok.error);
  assert("service account bind happened first", allowed.binds[0]?.dn === process.env.LDAP_BIND_DN);
  assert(
    "user DN bind happened after search",
    allowed.binds[1]?.dn === "uid=alice,ou=people,dc=example,dc=test",
  );
  assert(
    "search used configured base DN",
    allowed.searches[0]?.baseDn === process.env.LDAP_BASE_DN,
  );
  assert(
    "search requested memberOf",
    allowed.searches[0]?.attributes?.includes("memberOf") === true,
  );
  assert("LDAP client unbound after success", allowed.unbound === true);

  const denied = new FakeLdapClient([
    {
      dn: "uid=alice,ou=people,dc=example,dc=test",
      memberOf: ["cn=other,ou=groups,dc=example,dc=test"],
    },
  ]);
  const groupFail = await ldapModule.verifyLdapLogin("alice", "user-secret", () => denied);
  assert(
    "missing required memberOf group is rejected",
    groupFail.ok === false && groupFail.error === "group_required",
  );
  assert("LDAP client unbound after group failure", denied.unbound === true);

  const wrongPw = new FakeLdapClient([
    {
      dn: "uid=alice,ou=people,dc=example,dc=test",
      memberOf: ["cn=pi-forge-users,ou=groups,dc=example,dc=test"],
    },
  ]);
  const bad = await ldapModule.verifyLdapLogin("alice", "wrong", () => wrongPw);
  assert(
    "wrong user password is rejected",
    bad.ok === false && bad.error === "invalid_credentials",
  );

  const none = new FakeLdapClient([]);
  const notFound = await ldapModule.verifyLdapLogin("nobody", "user-secret", () => none);
  assert(
    "missing LDAP user is rejected",
    notFound.ok === false && notFound.error === "user_not_found",
  );
} finally {
  await rm(dataDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.log(`\n[test-ldap-auth] FAIL — ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\n[test-ldap-auth] PASS");
