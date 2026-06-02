import type { FastifyPluginAsync } from "fastify";
import { config, authEnabled } from "../config.js";
import {
  extractBearer,
  generateToken,
  passwordConfigured,
  persistPassword,
  verifyPasswordWithSource,
  verifyToken,
} from "../auth.js";
import { verifyLdapLogin } from "../ldap-auth.js";
import { errorSchema } from "./_schemas.js";

interface LoginBody {
  username?: string;
  password: string;
}

interface ChangePasswordBody {
  currentPassword: string;
  newPassword: string;
}

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 1024;

export const authRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    "/auth/status",
    {
      config: { public: true },
      schema: {
        description: "Returns whether auth is required to call protected routes.",
        tags: ["auth"],
        security: [],
        response: {
          200: {
            type: "object",
            required: ["authEnabled", "ldapEnabled"],
            properties: {
              authEnabled: { type: "boolean" },
              ldapEnabled: { type: "boolean" },
            },
          },
        },
      },
    },
    async () => ({ authEnabled: authEnabled(), ldapEnabled: config.auth.ldap.enabled }),
  );

  fastify.post<{ Body: LoginBody }>(
    "/auth/login",
    {
      config: {
        public: true,
        rateLimit: {
          max: config.auth.loginRateLimitMax,
          timeWindow: config.auth.loginRateLimitWindowMs,
        },
      },
      schema: {
        description:
          "Exchange a local admin password or LDAP username/password for a short-lived JWT. " +
          "LDAP is opt-in; username `admin` and password-only requests use local " +
          "UI_PASSWORD / stored-hash auth, while other usernames use LDAP. Returns 401 if the " +
          "credentials are wrong, or 503 if the selected auth backend is not configured.",
        tags: ["auth"],
        security: [],
        body: {
          type: "object",
          required: ["password"],
          additionalProperties: false,
          properties: {
            username: { type: "string", minLength: 1, maxLength: 256 },
            password: { type: "string", minLength: 1, maxLength: MAX_PASSWORD_LENGTH },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["token", "expiresAt", "mustChangePassword"],
            properties: {
              token: { type: "string" },
              expiresAt: { type: "string", format: "date-time" },
              mustChangePassword: { type: "boolean" },
            },
          },
          400: errorSchema,
          401: errorSchema,
          503: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const { username, password } = req.body;
      const loginAsLocalAdmin = username === undefined || username.toLowerCase() === "admin";

      if (config.auth.ldap.enabled && !loginAsLocalAdmin) {
        const result = await verifyLdapLogin(username, password);
        if (result.error === "misconfigured") {
          return reply.code(503).send({
            error: "ldap_not_configured",
            message:
              "LDAP login is enabled but LDAP_URL, LDAP_BIND_DN, " +
              "LDAP_BIND_PASSWORD(_FILE), or LDAP_BASE_DN is missing",
          });
        }
        if (!result.ok) {
          return reply.code(401).send({
            error: "invalid_password",
            message: "the username or password did not match, or the user is not authorized",
          });
        }
        const issued = generateToken({ mustChangePassword: false });
        return { ...issued, mustChangePassword: false };
      }

      if (!passwordConfigured()) {
        return reply.code(503).send({
          error: "ui_password_not_configured",
          message:
            "browser local admin login is disabled (no UI_PASSWORD set and no stored password hash)",
        });
      }
      const result = await verifyPasswordWithSource(password);
      if (!result.ok) {
        return reply.code(401).send({
          error: "invalid_password",
          message: "the password did not match",
        });
      }
      const mustChangePassword = result.source === "env" && config.auth.requirePasswordChange;
      const issued = generateToken({ mustChangePassword });
      return { ...issued, mustChangePassword };
    },
  );

  // Change-password is `public: true` at the route-config level so the
  // global `must_change_password` gate (in index.ts) doesn't refuse a
  // token that was issued specifically to call THIS endpoint. We
  // enforce auth manually inside the handler.
  fastify.post<{ Body: ChangePasswordBody }>(
    "/auth/change-password",
    {
      config: {
        public: true,
        rateLimit: {
          max: config.auth.loginRateLimitMax,
          timeWindow: config.auth.loginRateLimitWindowMs,
        },
      },
      schema: {
        description:
          "Verify the current password, persist a new scrypt hash to " +
          "${FORGE_DATA_DIR}/password-hash, and issue a fresh JWT " +
          "(mustChangePassword=false). Once a stored hash exists the env " +
          "UI_PASSWORD is ignored on subsequent logins. Requires a valid " +
          "JWT (initial-login `mustChangePassword:true` tokens are accepted).",
        tags: ["auth"],
        body: {
          type: "object",
          required: ["currentPassword", "newPassword"],
          additionalProperties: false,
          properties: {
            currentPassword: {
              type: "string",
              minLength: 1,
              maxLength: MAX_PASSWORD_LENGTH,
            },
            newPassword: {
              type: "string",
              minLength: MIN_PASSWORD_LENGTH,
              maxLength: MAX_PASSWORD_LENGTH,
            },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["token", "expiresAt", "mustChangePassword"],
            properties: {
              token: { type: "string" },
              expiresAt: { type: "string", format: "date-time" },
              mustChangePassword: { type: "boolean" },
            },
          },
          400: errorSchema,
          401: errorSchema,
          503: errorSchema,
        },
      },
    },
    async (req, reply) => {
      // Manual auth check — the route is `public: true` so the global
      // hook doesn't run, but we still require a valid JWT here.
      const presented = extractBearer(req.headers.authorization);
      if (presented === undefined || verifyToken(presented) === undefined) {
        return reply.code(401).send({ error: "auth_required" });
      }
      if (!passwordConfigured()) {
        return reply.code(503).send({
          error: "ui_password_not_configured",
          message: "password auth is not configured on this server",
        });
      }
      const { currentPassword, newPassword } = req.body;
      const verify = await verifyPasswordWithSource(currentPassword);
      if (!verify.ok) {
        return reply.code(401).send({
          error: "invalid_password",
          message: "the current password did not match",
        });
      }
      if (currentPassword === newPassword) {
        return reply.code(400).send({
          error: "password_unchanged",
          message: "new password must differ from the current one",
        });
      }
      await persistPassword(newPassword);
      const issued = generateToken({ mustChangePassword: false });
      return { ...issued, mustChangePassword: false };
    },
  );
};
