import express, { type Express } from "express";
import cors from "cors";
import { existsSync } from "node:fs";
import path from "node:path";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

// За прокси (Caddy, Replit, nginx) нужен доверенный X-Forwarded-For, иначе в
// req.ip попадёт адрес прокси и лимит попыток входа заблокирует всех сразу.
const trustProxy = process.env.TRUST_PROXY?.trim();
if (trustProxy) {
  app.set("trust proxy", Number(trustProxy) || 1);
}

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
// CORS_ORIGIN — URL фронтенда на отдельном домене (Render Static Site).
// Без переменной поведение прежнее: открытый CORS без credentials (один сервис отдаёт и API, и интерфейс).
const corsOrigin = process.env.CORS_ORIGIN?.trim();
app.use(
  cors(
    corsOrigin
      ? { origin: corsOrigin, credentials: true }
      : {},
  ),
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

// В продакшене один сервис отдаёт и API, и собранный интерфейс: телефону нужен
// один адрес, а cookie сессии уже ограничена путём /api.
// `pnpm --filter run start` выполняется из каталога пакета, поэтому путь к
// собранному фронтенду ищем и от корня, и от artifacts/api-server.
const staticCandidates = [
  process.env.STATIC_DIR?.trim() || "",
  path.resolve(process.cwd(), "artifacts/maradi-pos/dist/public"),
  path.resolve(process.cwd(), "../maradi-pos/dist/public"),
].filter(Boolean);
const staticDir =
  staticCandidates.find((dir) => existsSync(path.join(dir, "index.html"))) ??
  staticCandidates[0]!;
const indexHtml = path.join(staticDir, "index.html");

if (existsSync(indexHtml)) {
  app.use(
    express.static(staticDir, {
      index: false,
      setHeaders(res, filePath) {
        if (filePath.endsWith("index.html")) {
          res.setHeader("Cache-Control", "no-store");
        } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        }
      },
    }),
  );
  // SPA-фолбэк: любой GET вне /api отдаёт index.html (роутинг на клиенте).
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api") || !req.accepts("html")) {
      next();
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(indexHtml);
  });
  logger.info({ staticDir }, "Serving built frontend");
} else {
  logger.info({ staticDir }, "Built frontend not found — serving API only");
}

export default app;
