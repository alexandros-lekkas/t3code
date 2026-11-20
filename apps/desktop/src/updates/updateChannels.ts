// Preview builds share nightly branding but ship without an update feed.
const PRERELEASE_VERSION_PATTERN = /^[^-+]+-(?:nightly|preview)\.\d{8}\.\d+$/;

export function isNightlyDesktopVersion(version: string): boolean {
  return PRERELEASE_VERSION_PATTERN.test(version);
}

/** Fork builds (alexandros-lekkas/t3code) carry the Nightly name of the builds they replace. */
export function isBoatForkDesktopVersion(version: string): boolean {
  return /^[^-+]+-boat\.\d+$/.test(version);
}
