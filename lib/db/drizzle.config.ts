import { defineConfig } from "drizzle-kit";
import path from "path";
import { fileURLToPath } from "url";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

const configDir = path.dirname(fileURLToPath(import.meta.url));
// drizzle-kit ищет схему через glob, который на Windows ломается на абсолютных
// путях с обратными слэшами — нормализуем разделители к "/".
const schemaPath = path.join(configDir, "src", "schema", "index.ts").split(path.sep).join("/");

export default defineConfig({
  schema: schemaPath,
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
