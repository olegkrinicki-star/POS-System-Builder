import { Router, type IRouter } from "express";
import healthRouter from "./health";
import posRouter from "./pos";

const router: IRouter = Router();

router.use(healthRouter);
router.use(posRouter);

export default router;
