import { createHash, randomBytes } from "node:crypto";
import os from "node:os";
import type {
  Request,
  RequestHandler,
  Response,
} from "express";

const LICENSE_SITE_URL =
  process.env.LICENSE_SITE_URL ??
  "https://license.bolt.host/";
const SESSION_COOKIE = "automation_license_session";
const VALIDATION_INTERVAL_MS = 60_000;

type JsonRecord = Record<string, unknown>;

type LicenseSession = {
  id: string;
  username: string;
  expiresAt: string;
  deviceId: string;
  activation: JsonRecord;
  lastValidatedAt: number;
};

type LicenseConfig = {
  baseUrl: string;
  apiKey: string;
  loadedAt: number;
};

const sessions = new Map<string, LicenseSession>();
let cachedLicenseConfig: LicenseConfig | null = null;

export class LicenseAuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function getCookie(
  request: Request,
  name: string,
) {
  const value = request.cookies?.[name];

  return typeof value === "string"
    ? value
    : undefined;
}

function setSessionCookie(
  request: Request,
  response: Response,
  session: LicenseSession,
) {
  const expires = new Date(session.expiresAt);
  const forwardedProtocol =
    request.headers[
      "x-forwarded-proto"
    ];
  const secure =
    request.secure ||
    (typeof forwardedProtocol === "string" &&
      forwardedProtocol
        .split(",")[0]
        .trim() === "https");

  response.cookie(
    SESSION_COOKIE,
    session.id,
    {
      httpOnly: true,
      sameSite: "strict",
      secure,
      path: "/",
      expires,
    },
  );
}

export function clearSessionCookie(
  request: Request,
  response: Response,
) {
  const forwardedProtocol =
    request.headers[
      "x-forwarded-proto"
    ];
  const secure =
    request.secure ||
    (typeof forwardedProtocol === "string" &&
      forwardedProtocol
        .split(",")[0]
        .trim() === "https");

  response.clearCookie(
    SESSION_COOKIE,
    {
      httpOnly: true,
      sameSite: "strict",
      secure,
      path: "/",
    },
  );
}

function findValue(
  value: unknown,
  keys: Set<string>,
): unknown {
  if (
    !value ||
    typeof value !== "object"
  ) {
    return undefined;
  }

  for (const [key, child] of Object.entries(
    value,
  )) {
    if (
      keys.has(key.toLowerCase()) &&
      child !== null &&
      child !== ""
    ) {
      return child;
    }
  }

  for (const child of Object.values(value)) {
    const result = findValue(child, keys);

    if (result !== undefined) {
      return result;
    }
  }

  return undefined;
}

function extractExpiresAt(
  payload: JsonRecord,
  fallback?: string,
) {
  const raw =
    findValue(
      payload,
      new Set([
        "expiresat",
        "expires_at",
        "expiration",
        "expirationdate",
        "expiry",
        "expirydate",
      ]),
    ) ?? fallback;

  const date = new Date(
    typeof raw === "number"
      ? raw
      : String(raw ?? ""),
  );

  if (Number.isNaN(date.getTime())) {
    throw new LicenseAuthError(
      "License service did not return a valid expiration date.",
      502,
    );
  }

  if (date.getTime() <= Date.now()) {
    throw new LicenseAuthError(
      "This activation key has expired.",
      401,
    );
  }

  return date.toISOString();
}

function extractUsername(
  payload: JsonRecord,
  fallback: string,
) {
  const raw = findValue(
    payload,
    new Set([
      "username",
      "user_name",
      "name",
    ]),
  );

  return String(raw ?? fallback).trim();
}

function buildValidationPayload(
  activation: JsonRecord,
  session: Pick<
    LicenseSession,
    "username" | "deviceId"
  >,
) {
  const activationToken = findValue(
    activation,
    new Set([
      "activationtoken",
      "activation_token",
      "token",
    ]),
  );
  const activationId = findValue(
    activation,
    new Set([
      "activationid",
      "activation_id",
      "id",
    ]),
  );

  return {
    ...activation,
    username: session.username,
    deviceId: session.deviceId,
    ...(activationToken !== undefined
      ? {
          activationToken,
          activation_token: activationToken,
          token: activationToken,
        }
      : {}),
    ...(activationId !== undefined
      ? {
          activationId,
          activation_id: activationId,
        }
      : {}),
  };
}

function createDeviceId() {
  const machineIdentity = [
    os.hostname(),
    os.userInfo().username,
    os.platform(),
    os.arch(),
  ].join("|");

  return createHash("sha256")
    .update(machineIdentity)
    .digest("hex");
}

async function getLicenseConfig() {
  const configuredBaseUrl =
    process.env.LICENSE_API_BASE_URL?.trim();
  const configuredApiKey =
    process.env.LICENSE_API_ANON_KEY?.trim();

  if (
    configuredBaseUrl &&
    configuredApiKey
  ) {
    return {
      baseUrl: configuredBaseUrl.replace(
        /\/$/,
        "",
      ),
      apiKey: configuredApiKey,
      loadedAt: Date.now(),
    };
  }

  if (
    cachedLicenseConfig &&
    Date.now() -
      cachedLicenseConfig.loadedAt <
      10 * 60_000
  ) {
    return cachedLicenseConfig;
  }

  let html: string;

  try {
    const response = await fetch(
      LICENSE_SITE_URL,
      {
        signal: AbortSignal.timeout(10_000),
      },
    );

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}`,
      );
    }

    html = await response.text();
  } catch {
    throw new LicenseAuthError(
      "Unable to reach the activation service.",
      503,
    );
  }

  const baseUrl =
    html.match(
      /const API_BASE = ['"]([^'"]+)['"]/,
    )?.[1];
  const apiKey =
    html.match(
      /const API_KEY = ['"]([^'"]+)['"]/,
    )?.[1];

  if (!baseUrl || !apiKey) {
    throw new LicenseAuthError(
      "Activation service configuration is unavailable.",
      503,
    );
  }

  cachedLicenseConfig = {
    baseUrl: baseUrl.replace(/\/$/, ""),
    apiKey,
    loadedAt: Date.now(),
  };

  return cachedLicenseConfig;
}

async function callLicenseApi(
  route: string,
  body: JsonRecord,
) {
  const config = await getLicenseConfig();

  let response: globalThis.Response;

  try {
    response = await fetch(
      `${config.baseUrl}${route}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: config.apiKey,
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      },
    );
  } catch {
    throw new LicenseAuthError(
      "Unable to reach the activation service.",
      503,
    );
  }

  const payload = (await response
    .json()
    .catch(() => ({}))) as JsonRecord;

  if (!response.ok) {
    const message =
      typeof payload.error === "string"
        ? payload.error
        : typeof payload.message === "string"
          ? payload.message
          : "Activation failed.";

    throw new LicenseAuthError(
      message,
      response.status === 401 ||
        response.status === 403
        ? 401
        : response.status >= 500
          ? 503
          : 400,
    );
  }

  return payload;
}

function getSessionFromRequest(
  request: Request,
) {
  const sessionId = getCookie(
    request,
    SESSION_COOKIE,
  );

  return sessionId
    ? sessions.get(sessionId) ?? null
    : null;
}

function removeSession(
  request: Request,
) {
  const sessionId = getCookie(
    request,
    SESSION_COOKIE,
  );

  if (sessionId) {
    sessions.delete(sessionId);
  }
}

async function validateSession(
  session: LicenseSession,
) {
  if (
    new Date(session.expiresAt).getTime() <=
    Date.now()
  ) {
    sessions.delete(session.id);

    throw new LicenseAuthError(
      "Your activation key has expired.",
      401,
    );
  }

  if (
    Date.now() -
      session.lastValidatedAt <
    VALIDATION_INTERVAL_MS
  ) {
    return session;
  }

  const payload = await callLicenseApi(
    "/api/license/validate",
    buildValidationPayload(
      session.activation,
      session,
    ),
  );

  session.expiresAt = extractExpiresAt(
    payload,
    session.expiresAt,
  );
  session.activation = {
    ...session.activation,
    ...payload,
  };
  session.lastValidatedAt = Date.now();

  return session;
}

export async function activateLicense(
  username: string,
  activationKey: string,
) {
  const deviceId = createDeviceId();
  const payload = await callLicenseApi(
    "/api/license/activate",
    {
      username,
      licenseKey: activationKey,
      deviceId,
    },
  );
  const expiresAt = extractExpiresAt(
    payload,
  );
  const session: LicenseSession = {
    id: randomBytes(32).toString("hex"),
    username: extractUsername(
      payload,
      username,
    ),
    expiresAt,
    deviceId,
    activation: payload,
    lastValidatedAt: Date.now(),
  };

  sessions.set(session.id, session);

  return session;
}

export async function getValidSession(
  request: Request,
) {
  const session = getSessionFromRequest(
    request,
  );

  if (!session) {
    return null;
  }

  return await validateSession(session);
}

export function toPublicLicenseUser(
  session: LicenseSession,
) {
  return {
    username: session.username,
    expiresAt: session.expiresAt,
  };
}

export function loginSession(
  request: Request,
  response: Response,
  session: LicenseSession,
) {
  setSessionCookie(
    request,
    response,
    session,
  );
}

export function logoutSession(
  request: Request,
  response: Response,
) {
  removeSession(request);
  clearSessionCookie(request, response);
}

export const requireLicenseSession: RequestHandler =
  async (request, response, next) => {
    try {
      const session =
        await getValidSession(request);

      if (!session) {
        clearSessionCookie(
          request,
          response,
        );

        response.status(401).json({
          error:
            "A valid activation is required.",
        });

        return;
      }

      next();
    } catch (error) {
      if (
        error instanceof LicenseAuthError
      ) {
        if (error.status === 401) {
          logoutSession(request, response);
        }

        response
          .status(error.status)
          .json({ error: error.message });

        return;
      }

      next(error);
    }
  };