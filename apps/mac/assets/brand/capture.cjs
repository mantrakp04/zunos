// Captures the mascot stills in sources/ from the app's own renderer (bot-avatars, src/preview/IconLab.tsx),
// in WebKit at 2x with a transparent background. Needs Metro on port 8090 (`bun run start` in apps/mac) and
// Playwright with its WebKit, e.g.:
//   cd /tmp && npm i playwright && npx playwright install webkit
//   NODE_PATH=/tmp/node_modules node apps/mac/assets/brand/capture.cjs
const path = require("path");
const { webkit } = require("playwright");

const SOURCES = path.join(__dirname, "sources");
const PAGE = "http://localhost:8090/_expo/@dom/IconLab.tsx?file=file://" +
  path.resolve(__dirname, "../../src/preview/IconLab.tsx");
const SHOTS = [
  // the plush mascot with its sound arcs: app icon, logo mark, splash
  ["mascot.png", { size: 700, shading: "fabric", arcs: 1 }],
  // flat colours for the 16 and 32 px icons, where fur turns to mush
  ["mascot-flat.png", { size: 700, shading: "flat", arcs: 1 }],
];

(async () => {
  const browser = await webkit.launch();
  for (const [name, q] of SHOTS) {
    const page = await browser.newPage({ viewport: { width: 2200, height: 1400 }, deviceScaleFactor: 2 });
    page.on("pageerror", (e) => console.error("page error:", e.message));
    await page.goto(PAGE + "&" + new URLSearchParams(Object.entries(q).map(([k, v]) => [k, String(v)])));
    // fabric bakes its pile on idle time; give it a moment
    await page.waitForTimeout(6000);
    // the DOM root and the theme paint backgrounds; clear every one behind the art
    await page.evaluate(() => {
      for (let el = document.getElementById("art"); el; el = el.parentElement) el.style.setProperty("background", "transparent", "important");
    });
    await page.locator("#art").screenshot({ path: path.join(SOURCES, name), omitBackground: true });
    await page.close();
    console.log("captured", name);
  }
  await browser.close();
})();
