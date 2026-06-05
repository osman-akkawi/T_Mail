const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const globals = read("src/styles/globals.css");
const gmail = read("src/styles/gmail.css");
const app = read("src/App.tsx");
const topbar = read("src/components/TopBar.tsx");
const telegram = read("src/telegram.ts");
const compose = read("src/components/ComposeModal.tsx");
const emailViewer = read("src/components/EmailViewer.tsx");
const settings = read("src/pages/Settings.tsx");
const assistant = read("src/pages/Assistant.tsx");

assert.match(globals, /:root\[data-theme="light"\]/, "light theme variables exist");
assert.match(globals, /--tm-text-2:\s*#c6d2e8/i, "dark secondary text has stronger contrast");
assert.match(app, /THEME_STORAGE_KEY/, "theme preference is persisted");
assert.match(app, /document\.documentElement\.dataset\.theme/, "theme is applied to document root");
assert.match(app, /forceTelegramLaunch/, "production browser opens force Telegram launch");
assert.match(app, /VITE_TELEGRAM_BOT_LINK/, "Telegram bot button uses the bot link");
assert.match(app, /VITE_ALLOW_STANDALONE_WEB/, "standalone web login requires explicit env opt-in");
assert.match(app, /canUseCodeLogin/, "public browser login keeps Telegram OTP available");
assert.match(app, /Email \/ T-Mail address/, "login form accepts a T-Mail email address for Telegram OTP");
assert.match(telegram, /isAvailable\(\)/, "Telegram shell can be detected without initData");
assert.match(topbar, /theme-toggle-btn/, "theme toggle is visible in topbar");
assert.match(topbar, /search-submit-btn/, "search form has an accessible submit button");
assert.match(gmail, /\.theme-toggle-btn/, "theme toggle has styles");
assert.match(gmail, /@media \(max-width: 900px\)[\s\S]*\.app-shell[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)/, "mobile shell keeps main content full width");
assert.doesNotMatch(emailViewer, /dangerouslySetInnerHTML/, "email body avoids raw HTML injection");
assert.doesNotMatch(compose, /Dictate Email/, "compose no longer exposes voice dictation");
assert.doesNotMatch(compose, /SpeechRecognition/, "compose avoids browser speech APIs");
assert.match(compose, /compose-from-line/, "compose shows the primary sender identity");
assert.match(assistant, /Mail Butler/, "assistant page exists");
assert.match(gmail, /\.assistant-grid/, "assistant page has layout styles");

console.log("PASS ui-smoke-test: 20/20 assertions passed");
