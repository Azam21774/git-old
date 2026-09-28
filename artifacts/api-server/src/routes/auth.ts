import {
  Router,
  type IRouter,
} from "express";
import {
  activateLicense,
  getValidSession,
  LicenseAuthError,
  loginSession,
  logoutSession,
  toPublicLicenseUser,
} from "../lib/license-auth";

const router: IRouter = Router();

router.get(
  "/auth/session",
  async (request, response, next) => {
    try {
      const session =
        await getValidSession(request);

      if (!session) {
        response.json({
          authenticated: false,
        });

        return;
      }

      response.json({
        authenticated: true,
        user: toPublicLicenseUser(session),
      });
    } catch (error) {
      if (
        error instanceof LicenseAuthError
      ) {
        if (error.status === 401) {
          logoutSession(request, response);

          response.json({
            authenticated: false,
            error: error.message,
          });

          return;
        }

        response
          .status(error.status)
          .json({ error: error.message });

        return;
      }

      next(error);
    }
  },
);

router.post(
  "/auth/login",
  async (request, response, next) => {
    try {
      const username = String(
        request.body?.username ?? "",
      ).trim();
      const activationKey = String(
        request.body?.activationKey ?? "",
      ).trim();

      if (!username || !activationKey) {
        response.status(400).json({
          error:
            "Username and activation key are required.",
        });

        return;
      }

      const session = await activateLicense(
        username,
        activationKey,
      );

      loginSession(
        request,
        response,
        session,
      );

      response.json({
        authenticated: true,
        user: toPublicLicenseUser(session),
      });
    } catch (error) {
      if (
        error instanceof LicenseAuthError
      ) {
        response
          .status(error.status)
          .json({ error: error.message });

        return;
      }

      next(error);
    }
  },
);

router.post(
  "/auth/logout",
  (request, response) => {
    logoutSession(request, response);

    response.json({
      authenticated: false,
    });
  },
);

export default router;