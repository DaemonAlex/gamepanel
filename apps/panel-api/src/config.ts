// Panel settings from the environment (an env file next to docker compose, never in git).

export interface PanelConfig {
  databaseUrl: string;
  // Encrypts node tokens at rest. Changing it makes stored tokens unreadable.
  appSecret: string;
  host: string;
  port: number;
  // Built web app to serve, if any.
  webDist: string | null;
  // Cookies marked Secure. True behind the Cloudflare tunnel (https).
  cookieSecure: boolean;
  // Server hostnames are <id>.<domain>, e.g. mc.daemonscripts.com.
  serverDomain: string;
}

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env = process.env): PanelConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  const appSecret = env.APP_SECRET ?? "";
  if (appSecret.length < 32) throw new Error("APP_SECRET must be at least 32 characters");
  return {
    databaseUrl,
    appSecret,
    host: env.PANEL_HOST ?? "0.0.0.0",
    port: Number(env.PANEL_PORT ?? "3000"),
    webDist: env.WEB_DIST ?? null,
    cookieSecure: env.COOKIE_SECURE !== "false",
    serverDomain: env.SERVER_DOMAIN ?? "mc.daemonscripts.com",
  };
}
