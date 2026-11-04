import { execFileSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Buildspace's package-stage workflow runs this twice per build: once for the
// staging version and once for the production candidate.
const destination = process.env.PACK_DESTINATION;
const releaseVersion = process.env.RELEASE_VERSION;
if (!(destination && releaseVersion)) {
  throw new Error("PACK_DESTINATION and RELEASE_VERSION are required");
}
const version = `${releaseVersion}${process.env.RELEASE_SUFFIX ?? ""}`;
const original = await readFile("package.json", "utf8");
const manifest = JSON.parse(original);

execFileSync("pnpm", ["build"], { stdio: "inherit" });
try {
  await writeFile(
    "package.json",
    `${JSON.stringify({ ...manifest, version }, null, 2)}\n`
  );
  execFileSync("pnpm", ["pack", "--pack-destination", destination], {
    stdio: "inherit",
  });
} finally {
  await writeFile("package.json", original);
}

// Unpacked under node_modules, so the packed entry resolves its dependencies
// from this checkout.
const archive = join(destination, `photon-ai-chat-adapter-${version}.tgz`);
await mkdir("node_modules/.cache", { recursive: true });
const unpacked = await mkdtemp(resolve("node_modules/.cache/pack-release-"));
try {
  execFileSync("tar", ["-xzf", archive, "-C", unpacked]);
  const root = join(unpacked, "package");
  const packed = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (packed.name !== manifest.name || packed.version !== version) {
    throw new Error(`The archive holds ${packed.name}@${packed.version}`);
  }
  const entry = packed.exports["."];
  await access(join(root, entry.types));
  const { createPhotonAdapter } = await import(
    pathToFileURL(join(root, entry.import)).href
  );
  if (typeof createPhotonAdapter !== "function") {
    throw new Error("The packed build does not export createPhotonAdapter");
  }
} finally {
  await rm(unpacked, { force: true, recursive: true });
}
