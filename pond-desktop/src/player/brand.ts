/**
 * Spotify's official full logo, as its design guidelines require beside Spotify content: the files are
 * Spotify's own, unaltered (`Full_Logo_Black_RGB.svg` and `Full_Logo_White_RGB.svg` from
 * https://developer.spotify.com/images/guidelines/design/2024-spotify-full-logo.zip), served from
 * `public/brand/spotify/`. Black on light grounds, white on dark ones; green is for pure black or white
 * only, which neither of the app's grounds is. At least 70px wide: at 21px tall it is 77.
 */
export const SPOTIFY_LOGO = {
  onLight: "/brand/spotify/Full_Logo_Black_RGB.svg",
  onDark: "/brand/spotify/Full_Logo_White_RGB.svg",
} as const;

/** The player page is always on a light ground. */
export const SPOTIFY_LOGO_URL: string = SPOTIFY_LOGO.onLight;
