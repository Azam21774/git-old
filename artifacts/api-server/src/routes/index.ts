import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import automationRouter from "./automation";
import { requireLicenseSession } from "../lib/license-auth";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(
  "/automation",
  requireLicenseSession,
);
router.use(automationRouter);

export default router;
