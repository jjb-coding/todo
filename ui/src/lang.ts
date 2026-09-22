// ============================================================================
//  Localisation — every user-facing label in the settings UI is routed
//  through this so real translations can be wired in later without touching
//  any call site. For now it's the identity function: the key itself is
//  shown, which doubles as a live preview of what every translation key
//  will need to cover.
// ============================================================================

export function localise(key: string): string {
  return key;
}
