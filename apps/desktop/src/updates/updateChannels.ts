// Preview builds share nightly branding but ship without an update feed.
const PRERELEASE_VERSION_PATTERN = /^[^-+]+-(?:nightly|preview)\.\d{8}\.\d+$/;

export function isNightlyDesktopVersion(version: string): boolean {
  return PRERELEASE_VERSION_PATTERN.test(version);
}

/** Fork builds (alexandros-lekkas/t3code) are named "T3 Code (Lekkas)" but keep the Nightly stage and app identity. */
export function isBoatForkDesktopVersion(version: string): boolean {
  return /^[^-+]+-boat\.\d+$/.test(version);
}
