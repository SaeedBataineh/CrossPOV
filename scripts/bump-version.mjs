// Sets the app version everywhere it lives, e.g. `node scripts/bump-version.mjs 0.2.0`.
// Then commit and push: the build sees a version that hasn't been released
// yet, publishes it, and every installed copy updates itself.
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  console.error("Usage: node scripts/bump-version.mjs <major.minor.patch>");
  process.exit(1);
}

const edit = (file, fn) => writeFileSync(file, fn(readFileSync(file, "utf8")));
const setJsonVersion = (text) => text.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`);

edit("package.json", setJsonVersion);
edit("package-lock.json", (t) => t.replace(/("name": "crosspov",\s*"version": ")[^"]+(")/g, `$1${version}$2`));
edit("src-tauri/tauri.conf.json", setJsonVersion);
edit("src-tauri/Cargo.toml", (t) => t.replace(/^version = "[^"]+"/m, `version = "${version}"`));
edit("src-tauri/Cargo.lock", (t) => t.replace(/(name = "crosspov"\nversion = ")[^"]+(")/, `$1${version}$2`));
console.log(`Version set to ${version}. Commit and push to release it.`);
