import { loadFont } from "@remotion/fonts";
import { staticFile } from "remotion";

// Fonts ship in public/fonts so a render never depends on a font service.
export const INTER = "Inter";
export const MONO = "JetBrains Mono";

const faces: [string, string, string][] = [
  [INTER, "inter-latin-400-normal.woff2", "400"],
  [INTER, "inter-latin-500-normal.woff2", "500"],
  [INTER, "inter-latin-600-normal.woff2", "600"],
  [INTER, "inter-latin-700-normal.woff2", "700"],
  [MONO, "jetbrains-mono-latin-400-normal.woff2", "400"],
  [MONO, "jetbrains-mono-latin-500-normal.woff2", "500"],
  [MONO, "jetbrains-mono-latin-700-normal.woff2", "700"],
];

for (const [family, file, weight] of faces) {
  loadFont({ family, url: staticFile(`fonts/${file}`), weight });
}
