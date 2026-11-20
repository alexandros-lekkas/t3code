// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
// Fork (alexandros-lekkas/t3code): signs the unsigned macOS build with one self-signed identity, so
// every release has the same designated requirement and macOS keeps its privacy grants (Screen
// Recording, Accessibility) across updates. No hardened runtime and no entitlements, so the app
// runs exactly like the ad-hoc builds did. Runs as afterPack, because electron-builder skips its
// own signing (and afterSign) for `identity: null`.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { sign } from "@electron/osx-sign";

interface AfterPackContext {
  readonly appOutDir: string;
  readonly electronPlatformName: string;
  readonly packager: { readonly appInfo: { readonly productFilename: string } };
}

const prepareServerCompileCache: (context: AfterPackContext) => Promise<void> =
  NodeModule.createRequire(import.meta.url)("./prepare-server-compile-cache.cjs");

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

/** Signs `app` inside out with `identity` (a SHA-1 hash or name) and fails unless it took. */
export async function selfSignMacApp(input: {
  readonly app: string;
  readonly identity: string;
  readonly keychain?: string | undefined;
}): Promise<string> {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-self-sign-"));
  try {
    const entitlements = NodePath.join(dir, "none.plist");
    await NodeFSP.writeFile(
      entitlements,
      '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict/></plist>\n',
    );
    await sign({
      app: input.app,
      identity: input.identity,
      // A self-signed certificate is never "valid" to `security find-identity -v`.
      identityValidation: false,
      ...(input.keychain ? { keychain: input.keychain } : {}),
      platform: "darwin",
      type: "distribution",
      preAutoEntitlements: false,
      batchCodesignCalls: true,
      optionsForFile: () => ({ hardenedRuntime: false, timestamp: "none", entitlements }),
    });
  } finally {
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
  await execFile("codesign", ["--verify", "--deep", "--strict", input.app]);
  const { stdout, stderr } = await execFile("codesign", ["-d", "-r-", input.app]);
  const output = `${stdout}\n${stderr}`;
  const requirement = output.split("\n").find((line) => line.startsWith("designated => "));
  if (!requirement?.includes("certificate leaf = H")) {
    throw new Error(`Self-signing left no certificate-based requirement: ${output}`);
  }
  return requirement;
}

export default async function afterPack(context: AfterPackContext): Promise<void> {
  await prepareServerCompileCache(context);
  const identity = process.env.T3CODE_MAC_SELF_SIGN_IDENTITY;
  if (context.electronPlatformName !== "darwin" || !identity) {
    throw new Error("The self-signing hook needs a macOS build and T3CODE_MAC_SELF_SIGN_IDENTITY");
  }
  const app = NodePath.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const requirement = await selfSignMacApp({
    app,
    identity,
    keychain: process.env.T3CODE_MAC_SELF_SIGN_KEYCHAIN,
  });
  console.log(`[mac-self-sign] ${requirement}`);
}
