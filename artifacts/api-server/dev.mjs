// Cross-platform `dev` entry point.
//
// The previous script used bash-style `export NODE_ENV=development && ...`,
// which fails in Windows shells (`export` is not a command there). Running the
// bundle with NODE_ENV=development keeps the pretty pino transport, and the
// process.env mutation below propagates to the build and the server.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const artifactDir = path.dirname(fileURLToPath(import.meta.url));
const env = { ...process.env, NODE_ENV: "development" };

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: artifactDir,
      env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${path.basename(args.at(-1) ?? "")} exited with ${signal ?? code}`));
    });
  });
}

try {
  await run([path.join(artifactDir, "build.mjs")]);
  await run(["--enable-source-maps", path.join(artifactDir, "dist", "index.mjs")]);
} catch (error) {
  console.error(error);
  process.exit(1);
}
