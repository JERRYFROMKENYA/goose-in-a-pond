import { spawn } from "node:child_process";

/** Runs AppleScript source with `argv`, so tests never start osascript. */
export type ScriptRunner = (script: string, args: string[]) => Promise<string>;

export class MusicAppError extends Error {}

/** Music answers in milliseconds; beyond this it is waiting on a dialog nobody is looking at. */
const TIMEOUT_MS = 20_000;

/** What the user can act on, from osascript's stderr. */
export function explainScriptFailure(stderr: string): string {
  if (/-1743|not authori[sz]ed/i.test(stderr)) {
    return "macOS has not allowed Goose In A Pond to control Music. Open System Settings, Privacy & Security, Automation, and switch Music on.";
  }
  if (/-1712|timed out/i.test(stderr)) {
    return "Music did not answer. It may be showing a permission or sign-in window; check for one and try again.";
  }
  if (/-1728|can.t get/i.test(stderr)) {
    return "Music could not find that item. It may have been removed from the library.";
  }
  return stderr.trim() || "the Music app reported an error with no message";
}

/**
 * The script goes in on stdin and user text only ever in `argv`, so nothing a person says can
 * become script source.
 */
export const runAppleScript: ScriptRunner = (script, args) =>
  new Promise((resolve, reject) => {
    const child = spawn("osascript", ["-", ...args], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new MusicAppError(explainScriptFailure("-1712 timed out")));
    }, TIMEOUT_MS);

    child.stdout.on("data", chunk => (stdout += chunk));
    child.stderr.on("data", chunk => (stderr += chunk));

    child.on("error", err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new MusicAppError(`could not start osascript: ${err.message}`));
    });

    child.on("close", code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve(stdout.replace(/\n$/, ""));
      else reject(new MusicAppError(explainScriptFailure(stderr)));
    });

    child.stdin.end(script);
  });
