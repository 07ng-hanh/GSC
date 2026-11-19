import { statSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

function isFile(filePath) {
  return statSync(filePath, { throwIfNoEntry: false })?.isFile() === true;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      const targetBase = path.join(projectRoot, "src", specifier.slice(2));
      const candidates = [
        targetBase,
        `${targetBase}.ts`,
        `${targetBase}.tsx`,
        path.join(targetBase, "index.ts"),
      ];
      for (const candidate of candidates) {
        if (isFile(candidate)) {
          return nextResolve(pathToFileURL(candidate).href, context);
        }
      }
    }

    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      context.parentURL &&
      !path.extname(specifier)
    ) {
      const parentDir = path.dirname(fileURLToPath(context.parentURL));
      const targetBase = path.resolve(parentDir, specifier);
      const candidates = [`${targetBase}.ts`, path.join(targetBase, "index.ts")];
      for (const candidate of candidates) {
        if (isFile(candidate)) {
          return nextResolve(pathToFileURL(candidate).href, context);
        }
      }
    }

    return nextResolve(specifier, context);
  },
});
