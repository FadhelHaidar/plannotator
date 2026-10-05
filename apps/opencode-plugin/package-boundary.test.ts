import { describe, expect, test } from "bun:test";
import packageJson from "./package.json";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

describe("OpenCode package entrypoints", () => {
  test("keeps V1 on main and exposes V2 from the package root", () => {
    expect(packageJson.main).toBe("dist/index.js");
    // OpenCode 1 checks ./server before main, so that subpath must remain absent.
    expect(packageJson.exports).toEqual({
      ".": "./dist/server.js",
    });
  });

  test("ships the plannotator knowledge skill and installs it where OpenCode scans", () => {
    // #1377 install reach: postinstall wrote only commands/*.md, so npm-plugin
    // users never received the CLI reference. Three things have to line up or
    // it silently stops shipping: the build must copy it into the package,
    // `files` must include it, and postinstall must place it under the config
    // dir OpenCode scans (`{skill,skills}/**/SKILL.md` under xdgConfig/opencode).
    expect(packageJson.files).toContain("skills");
    expect(packageJson.scripts["build:skill"]).toContain(
      "cp -R ../skills/core/plannotator skills/plannotator",
    );
    // The build must actually run that step, not merely define it.
    expect(packageJson.scripts.build).toContain("bun run build:skill");
    expect(packageJson.scripts.postinstall).toContain(
      "${XDG_CONFIG_HOME:-$HOME/.config}/opencode/skills/plannotator",
    );
    expect(packageJson.scripts.postinstall).toContain(
      "./skills/plannotator/SKILL.md",
    );
  });

  // `bun install` in this monorepo runs workspace postinstalls, which used to
  // copy the stubs into the DEVELOPER's real ~/.config/opencode/commands.
  // Failure caught: the script writing anywhere when it is not an installed
  // package, or no longer writing when it is one.
  test.skipIf(process.platform === "win32")("postinstall writes only from an installed package", () => {
    const root = mkdtempSync(path.join(tmpdir(), "plannotator-oc-postinstall-"));
    try {
      const layOut = (dir: string) => {
        mkdirSync(path.join(dir, "commands"), { recursive: true });
        mkdirSync(path.join(dir, "skills", "plannotator"), { recursive: true });
        writeFileSync(path.join(dir, "commands", "plannotator-review.md"), "stub\n");
        writeFileSync(path.join(dir, "skills", "plannotator", "SKILL.md"), "skill\n");
      };
      const run = (cwd: string, config: string) => {
        const result = spawnSync("sh", ["-c", packageJson.scripts.postinstall], {
          cwd,
          // A sandboxed config dir; HOME too, in case the fallback is taken.
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: path.join(root, "home"), XDG_CONFIG_HOME: config },
          encoding: "utf-8",
        });
        expect(result.status).toBe(0);
      };

      const workspace = path.join(root, "repo", "apps", "opencode-plugin");
      layOut(workspace);
      const workspaceConfig = path.join(root, "workspace-config");
      run(workspace, workspaceConfig);
      expect(existsSync(workspaceConfig)).toBe(false);

      const installed = path.join(root, "prefix", "node_modules", "@plannotator", "opencode");
      layOut(installed);
      const installedConfig = path.join(root, "installed-config");
      run(installed, installedConfig);
      expect(existsSync(path.join(installedConfig, "opencode", "commands", "plannotator-review.md"))).toBe(true);
      expect(existsSync(path.join(installedConfig, "opencode", "skills", "plannotator", "SKILL.md"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
