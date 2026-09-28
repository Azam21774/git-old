require("dotenv").config();

const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const puppeteer = require("puppeteer");
const speakeasy = require("speakeasy");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({
  limit: Number.POSITIVE_INFINITY
}));

let browser = null;
let page = null;
let chromeProfileDir = null;
let browserDisconnected = false;

const state = {
  running: false,
  paused: false,
  loggedIn: false,
  status: "idle",
  logs: [],
  queuedJobs: []
};

/* =========================================================
   LOG
========================================================= */

function log(message) {
  const line = `[${new Date().toLocaleTimeString()}] ${message}`;

  console.log(line);

  state.logs.push(line);

  if (state.logs.length > 300) {
    state.logs.shift();
  }
}

/* =========================================================
   ACCOUNT FROM DASHBOARD
========================================================= */

function getAccount(value) {
  const email = String(
    value && value.email || ""
  ).trim();

  const password = String(
    value && value.password || ""
  );

  const totp = String(
    value && value.totp || ""
  ).trim();

  if (!email) {
    throw new Error(
      "Account email was not received from the dashboard"
    );
  }

  if (!password) {
    throw new Error(
      "Account password was not received from the dashboard"
    );
  }

  if (!totp) {
    throw new Error(
      "Account 2FA secret was not received from the dashboard"
    );
  }

  return {
    email,
    password,
    totp
  };
}

/* =========================================================
   RANDOM REPOSITORY NAME
   8-12 LOWERCASE LETTERS AND DIGITS
========================================================= */

function generateRepositoryName() {
  const letters = "abcdefghijklmnopqrstuvwxyz";
  const characters = `${letters}0123456789`;
  const length = Math.floor(Math.random() * 5) + 8;
  let name =
    letters[Math.floor(Math.random() * letters.length)];

  for (let i = 1; i < length; i++) {
    name += characters[
      Math.floor(Math.random() * characters.length)
    ];
  }

  return name;
}

/* =========================================================
   TOTP
========================================================= */

function generateOTP(secret) {
  const cleanSecret = String(secret)
    .trim()
    .replace(/\s+/g, "")
    .toUpperCase();

  return speakeasy.totp({
    secret: cleanSecret,
    encoding: "base32",
    algorithm: "sha1",
    digits: 6,
    step: 30
  });
}

/* =========================================================
   DELAY
========================================================= */

function sleep(ms) {
  return new Promise(resolve =>
    setTimeout(resolve, ms)
  );
}

function getTimingValue(
  name,
  fallback,
  maximum = 5000
) {
  const value =
    Number(process.env[name]);

  if (
    !Number.isFinite(value) ||
    value < 0
  ) {
    return fallback;
  }

  return Math.min(value, maximum);
}

function actionPause(multiplier = 1) {
  return waitForResume()
    .then(() =>
      sleep(
        getTimingValue(
          "ACTION_DELAY_MS",
          700
        ) * multiplier
      )
    )
    .then(() => waitForResume());
}

async function waitForResume() {
  while (state.running && state.paused) {
    await sleep(250);
  }
}

async function pauseAwareSleep(durationMs) {
  let remainingMs = Math.max(0, Number(durationMs) || 0);

  while (remainingMs > 0) {
    await waitForResume();

    if (!state.running) {
      return false;
    }

    const sliceMs = Math.min(250, remainingMs);
    await sleep(sliceMs);
    remainingMs -= sliceMs;
  }

  await waitForResume();
  return state.running;
}

async function waitForPageStable(
  timeout = 30000,
  stableFor = 100
) {
  const start = Date.now();
  let lastUrl = "";
  let stableSince = 0;

  while (Date.now() - start < timeout) {
    await waitForResume();

    try {
      const snapshot = await page.evaluate(() => ({
        url: window.location.href,
        readyState: document.readyState
      }));

      const now = Date.now();

      if (
        snapshot.readyState === "interactive" ||
        snapshot.readyState === "complete"
      ) {
        if (snapshot.url !== lastUrl) {
          lastUrl = snapshot.url;
          stableSince = now;
        } else if (now - stableSince >= stableFor) {
          return snapshot.url;
        }
      } else {
        stableSince = 0;
      }
    } catch (error) {
      if (!isNavigationContextError(error)) {
        throw error;
      }

      lastUrl = "";
      stableSince = 0;
    }

    await sleep(50);
  }

  throw new Error(
    "Page did not become stable before the timeout."
  );
}

function isNavigationContextError(error) {
  const message = String(
    error && error.message
      ? error.message
      : error
  ).toLowerCase();

  return (
    message.includes("execution context was destroyed") ||
    message.includes("cannot find context") ||
    message.includes("most likely because of a navigation") ||
    message.includes("execution context is not available") ||
    message.includes("navigating frame was detached") ||
    message.includes("navigation did not reach") ||
    message.includes("frame was detached") ||
    message.includes("page was closed") ||
    message.includes("page has been closed") ||
    message.includes("navigation timeout")
  );
}

function isBrowserLifecycleError(error) {
  const message = String(
    error && error.message
      ? error.message
      : error
  ).toLowerCase();

  return (
    browserDisconnected ||
    message.includes("target closed") ||
    message.includes("browser has disconnected") ||
    message.includes("browser closed") ||
    message.includes("connection closed") ||
    message.includes("session closed") ||
    message.includes("protocol error") ||
    message.includes("websocket") ||
    message.includes("econnreset")
  );
}

function isTemporaryGitHubActionError(error) {
  const message = String(
    error && error.message
      ? error.message
      : error
  )
    .toLowerCase()
    .replace(/[’‘]/g, "'");

  return (
    message.includes(
      "can't perform that action at this time"
    ) ||
    message.includes(
      "cannot perform that action at this time"
    ) ||
    message.includes(
      "you can't perform that action at this time"
    ) ||
    message.includes(
      "you cannot perform that action at this time"
    ) ||
    message.includes(
      "github rejected this request"
    ) ||
    message.includes(
      "request was rejected"
    ) ||
    message.includes(
      "request has been rejected"
    ) ||
    message.includes(
      "rejected this action"
    )
  );
}

function groupNotificationEmails(emails, batchSize = 2) {
  const pairs = [];

  for (
    let index = 0;
    index < emails.length;
    index += batchSize
  ) {
    pairs.push(
      emails.slice(index, index + batchSize)
    );
  }

  return pairs;
}

function getWorkflow(value) {
  const fileName = String(
    value && value.fileName || ""
  ).trim();

  const commitMessage = String(
    value && value.commitMessage || ""
  ).trim();

  const description = String(
    value && value.description || ""
  );

  if (!fileName) {
    throw new Error(
      "Workflow file name was not received from the dashboard"
    );
  }

  if (!commitMessage) {
    throw new Error(
      "Workflow commit message was not received from the dashboard"
    );
  }

  return {
    fileName,
    commitMessage,
    description
  };
}

function getRecipients(value) {
  if (!Array.isArray(value)) {
    throw new Error(
      "Recipients were not received from the dashboard"
    );
  }

  const recipients = [
    ...new Set(
      value
        .map(email =>
          String(email || "")
            .trim()
            .toLowerCase()
        )
        .filter(Boolean)
    )
  ];

  return recipients;
}

function getBatchSize(value) {
  const batchSize = Number(value);

  return batchSize === 1 ? 1 : 2;
}

function getBatchJobs(value, batchSize = 2) {
  if (!Array.isArray(value)) {
    throw new Error(
      "Recipient batches were not received from the dashboard"
    );
  }

  return value.map((job, fallbackIndex) => {
    const recipients = getRecipients(
      job && job.recipients
    );
    const parsedIndex = Number(
      job && job.index
    );

    if (!recipients.length) {
      throw new Error(
        `Recipient batch ${fallbackIndex + 1} is empty`
      );
    }

    return {
      index:
        Number.isInteger(parsedIndex) &&
        parsedIndex >= 0
          ? parsedIndex
          : fallbackIndex,
      recipients
    };
  });
}

function getRepositoryFromUrl(repositoryUrl) {
  let parsedUrl;

  try {
    parsedUrl = new URL(repositoryUrl);
  } catch {
    throw new Error(
      `Invalid repository URL: ${repositoryUrl}`
    );
  }

  const parts =
    parsedUrl.pathname
      .split("/")
      .filter(Boolean);

  if (parts.length < 2) {
    throw new Error(
      `Could not detect username and repository name from URL: ${repositoryUrl}`
    );
  }

  return {
    username: decodeURIComponent(parts[0]),
    repoName: decodeURIComponent(parts[1])
  };
}

async function findButtonByText(
  text,
  timeout = 30000,
  exact = false
) {
  const expectedText =
    String(text).trim().toLowerCase();
  const start = Date.now();

  while (Date.now() - start < timeout) {
    await waitForResume();

    let buttons;

    try {
      buttons = await page.$$("button");
    } catch (error) {
      if (!isNavigationContextError(error)) {
        throw error;
      }

      await sleep(50);
      continue;
    }

    for (const button of buttons) {
      let label = "";

      try {
        label = await button.evaluate(
          element =>
            (
              element.innerText ||
              element.textContent ||
              element.value ||
              ""
            )
              .trim()
              .toLowerCase()
        );
      } catch {}

      if (
        exact
          ? label === expectedText
          : label.includes(expectedText)
      ) {
        return button;
      }

      await button.dispose().catch(() => {});
    }

    await sleep(50);
  }

  throw new Error(
    `Button not found: ${text}`
  );
}

async function findLinkByText(
  text,
  timeout = 30000
) {
  const expectedText =
    String(text).trim().toLowerCase();
  const start = Date.now();

  while (Date.now() - start < timeout) {
    await waitForResume();

    let links;

    try {
      links = await page.$$("a");
    } catch (error) {
      if (!isNavigationContextError(error)) {
        throw error;
      }

      await sleep(50);
      continue;
    }

    for (const link of links) {
      let details = {
        label: "",
        href: ""
      };

      try {
        details = await link.evaluate(
          element => ({
            label: (
              element.innerText ||
              element.textContent ||
              ""
            )
              .trim()
              .toLowerCase(),
            href: element.getAttribute("href") || ""
          })
        );
      } catch {}

      if (
        details.label.includes(expectedText) &&
        details.href.includes("/new/main")
      ) {
        return link;
      }

      await link.dispose().catch(() => {});
    }

    await sleep(50);
  }

  throw new Error(
    `Link not found: ${text}`
  );
}

/* =========================================================
   LAUNCH GOOGLE CHROME
========================================================= */

function getChromeExecutablePath() {
  const configuredPath =
    process.env.CHROME_EXECUTABLE_PATH;

  if (configuredPath) {
    if (!fs.existsSync(configuredPath)) {
      throw new Error(
        `CHROME_EXECUTABLE_PATH does not exist: ${configuredPath}`
      );
    }

    return configuredPath;
  }

  const home =
    process.env.HOME || "";

  const candidates = {
    darwin: [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      path.join(
        home,
        "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      )
    ],
    win32: [
      path.join(
        process.env.PROGRAMFILES || "",
        "Google/Chrome/Application/chrome.exe"
      ),
      path.join(
        process.env["PROGRAMFILES(X86)"] || "",
        "Google/Chrome/Application/chrome.exe"
      ),
      path.join(
        process.env.LOCALAPPDATA || "",
        "Google/Chrome/Application/chrome.exe"
      )
    ],
    linux: [
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/snap/bin/chromium"
    ]
  };

  const platformCandidates =
    candidates[process.platform] || [];

  const executablePath =
    platformCandidates.find(candidate =>
      candidate && fs.existsSync(candidate)
    );

  if (!executablePath) {
    throw new Error(
      "Installed Google Chrome was not found. Set CHROME_EXECUTABLE_PATH if Chrome is installed in a custom location."
    );
  }

  return executablePath;
}

async function cleanupChromeProfile() {
  if (!chromeProfileDir) {
    return;
  }

  const profileDir = chromeProfileDir;

  let lastError = null;

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      await fs.promises.rm(profileDir, {
        recursive: true,
        force: true
      });

      if (chromeProfileDir === profileDir) {
        chromeProfileDir = null;
      }

      return;
    } catch (error) {
      lastError = error;

      if (attempt < 4) {
        await sleep(attempt * 200);
      }
    }
  }

  log(
    `Could not remove temporary Chrome profile after retries: ${lastError.message}`
  );
}

async function launchBrowser() {
  if (browser && browser.connected) {
    /*
     * Start every automation run in a fresh window.
     * This closes only the browser instance launched by
     * this script, not the user's other Chrome windows.
     */
    await browser.close().catch(() => {});
    browser = null;
    page = null;
    await cleanupChromeProfile();
  }

  log("Launching Google Chrome...");

  const executablePath =
    getChromeExecutablePath();

  log(
    `Using installed Google Chrome: ${executablePath}`
  );

  await cleanupChromeProfile();

  chromeProfileDir = fs.mkdtempSync(
    path.join(
      os.tmpdir(),
      "github-automation-chrome-"
    )
  );

  log(
    "Using a fresh temporary Chrome profile for this run"
  );

  try {
    browser = await puppeteer.launch({
      headless: false,
      defaultViewport: null,
      executablePath,
      userDataDir: chromeProfileDir,
      ignoreDefaultArgs: [
        "--enable-automation"
      ],
      /*
       * Send Chrome's own startup diagnostics into the dashboard
       * if Windows closes the process before Puppeteer attaches.
       */
      dumpio: true,

      args: [
        "--start-maximized",
        /*
         * Match the Chrome launch used by the reference automation.
         * Chrome will show its unsupported-flag warning, but this
         * is required to reproduce that browser environment.
         */
        "--no-sandbox",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-mode",
        "--no-service-autorun",
        "--disable-save-password-bubble",
        "--disable-features=PasswordLeakDetection",
        "--disable-blink-features=AutomationControlled",
        "--disable-infobars",
        "--disable-dev-shm-usage",
        "--lang=en-US,en",
        "--window-size=1280,800"
      ]
    });
  } catch (error) {
    await cleanupChromeProfile();

    throw new Error(
      `Google Chrome opened but Puppeteer could not attach to its isolated browser process: ${error.message}`,
      {
        cause: error
      }
    );
  }

  browserDisconnected = false;
  browser.on("disconnected", () => {
    browserDisconnected = true;
    state.loggedIn = false;
    page = null;
    log(
      "Google Chrome disconnected unexpectedly; the current batch will be retried in a fresh window."
    );
  });

  /*
   * ONE PAGE ONLY.
   * Repository flow will stay on this same page.
   */

  const openPages =
    await browser.pages();

  page =
    openPages[0] ||
    await browser.newPage();

  /*
   * Puppeteer normally starts one blank tab. Reuse it
   * instead of opening a second tab with newPage().
   */
  for (const extraPage of openPages.slice(1)) {
    if (extraPage.url() === "about:blank") {
      await extraPage.close();
    }
  }

  log("Google Chrome launched");
}

async function recoverBrowser(account) {
  state.status = "recovering-browser";
  log(
    "Recovering the Google Chrome window and signing in again..."
  );

  if (browser && browser.connected) {
    await browser.close().catch(() => {});
  }

  browser = null;
  page = null;
  await cleanupChromeProfile();
  await launchBrowser();
  await login(account);
}

/* =========================================================
   SAFE SELECTOR WAIT
========================================================= */

async function waitForSelector(selector, timeout = 30000) {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    const remaining = Math.max(
      100,
      timeout - (Date.now() - start)
    );

    try {
      return await page.waitForSelector(selector, {
        visible: true,
        timeout: remaining
      });
    } catch (error) {
      if (!isNavigationContextError(error)) {
        throw error;
      }

      await sleep(50);
    }
  }

  throw new Error(
    `Selector not found: ${selector}`
  );
}

/* =========================================================
   FILL INPUT
========================================================= */

async function fillInput(selector, value) {
  await waitForSelector(selector);

  await page.click(selector);

  /*
   * Select the existing value in the DOM first.
   * This reliably clears defaults such as blank.yml
   * on both macOS and Windows.
   */
  await page.$eval(
    selector,
    element => {
      element.focus();
      element.select();
    }
  );

  await page.keyboard.press("Backspace");

  await page.type(
    selector,
    String(value),
    {
      delay: getTimingValue(
        "TYPE_DELAY_MS",
        0,
        100
      )
    }
  );

}

/* =========================================================
   OTP FILL
   Handles DOM context changing
========================================================= */

async function fillOTP(selector, otp) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.waitForSelector(selector, {
        visible: true,
        timeout: 15000
      });

      await page.click(selector);

      await page.$eval(
        selector,
        element => {
          element.focus();
          element.select();
        }
      );

      await page.keyboard.press("Backspace");

      const baseDelayMs = getTimingValue(
        "OTP_TYPE_DELAY_MS",
        900,
        2000
      );

      for (const digit of String(otp)) {
        await waitForResume();
        await page.keyboard.type(digit);

        const delayCompleted = await pauseAwareSleep(
          baseDelayMs + Math.random() * 400
        );

        if (!delayCompleted) {
          return;
        }
      }

      log("OTP filled");

      return;

    } catch (error) {
      const retryable =
        isNavigationContextError(error) ||
        error.message.includes(
          "DOM.describeNode"
        );

      if (!retryable || attempt === 3) {
        throw error;
      }

      log(
        `OTP field changed, retrying (${attempt}/3)...`
      );

      await sleep(500);
    }
  }
}

/* =========================================================
   FIND OTP FIELD
========================================================= */

async function findOTPSelector() {
  const selectors = [
    'input[autocomplete="one-time-code"]',
    'input[name="otp"]',
    'input[name="code"]',
    'input[name="verification_code"]',
    'input[name="two_factor_authentication_token"]',
    'input[inputmode="numeric"]',
    'input[type="tel"]'
  ];

  const start = Date.now();

  while (Date.now() - start < 15000) {
    for (const selector of selectors) {
      try {
        const exists = await page.$(selector);

        if (!exists) {
          continue;
        }

        const visible =
          await page
            .$eval(
              selector,
              el => {
                const style =
                  window.getComputedStyle(el);

                return (
                  style.display !== "none" &&
                  style.visibility !== "hidden" &&
                  el.offsetParent !== null
                );
              }
            )
            .catch(() => false);

        if (visible) {
          return selector;
        }

      } catch {}
    }

    await sleep(150);
  }

  return null;
}

/* =========================================================
   LOGIN BUTTON
========================================================= */

async function clickLoginButton() {
  const selector =
    'input[type="submit"], button[type="submit"]';

  await waitForSelector(
    selector,
    30000
  );

  await page.click(selector);

  log("Login submitted");
}

/* =========================================================
   OTP SUBMIT
========================================================= */

async function submitOTP() {
  let clicked = false;

  try {
    clicked =
      await page.evaluate(() => {
        const buttons = [
          ...document.querySelectorAll(
            "button, input[type='submit']"
          )
        ];

        const button = buttons.find(el => {
          const text = (
            el.innerText ||
            el.value ||
            ""
          )
            .trim()
            .toLowerCase();

          return (
            text.includes("verify") ||
            text.includes("continue") ||
            text.includes("submit") ||
            text.includes("sign in")
          );
        });

        if (!button) {
          return false;
        }

        /*
         * This click can immediately navigate away.
         * In that case Puppeteer may reject the evaluate
         * promise after the click has already happened.
         */
        button.click();

        return true;
      });
  } catch (error) {
    if (!isNavigationContextError(error)) {
      throw error;
    }

    /*
     * The submit action already started navigation.
     * Do not press Enter again and submit twice.
     */
    clicked = true;
  }

  if (!clicked) {
    try {
      await page.keyboard.press("Enter");
    } catch (error) {
      if (!isNavigationContextError(error)) {
        throw error;
      }
    }
  }

  log("OTP submitted");
}

/* =========================================================
   WAIT FOR LOGIN TO FINISH
========================================================= */

async function waitForLoginComplete() {
  const start = Date.now();

  while (Date.now() - start < 20000) {
    try {
      const url = page.url();

      /*
       * Don't treat the 2FA session URL itself as
       * final login success.
       */

      if (
        url.includes(
          "/sessions/two-factor"
        )
      ) {
        await sleep(400);
        continue;
      }

      if (!url.includes("/login")) {
        return true;
      }

    } catch (error) {
      if (isNavigationContextError(error)) {
        await sleep(300);
        continue;
      }

      throw error;
    }

    await sleep(300);
  }

  return false;
}

/* =========================================================
   LOGIN
========================================================= */

async function login(account) {
  state.status = "login";

  log(
    `Starting account: ${account.email}`
  );

  log("Opening login page...");

  await page.goto(
    "https://github.com/login",
    {
      waitUntil: "domcontentloaded",
      timeout: 60000
    }
  );

  log("Login page opened");
  await actionPause();

  /* EMAIL */

  const emailSelector = "#login_field";

  await waitForSelector(
    emailSelector
  );

  log("Username field detected");

  await fillInput(
    emailSelector,
    account.email
  );

  log("Username filled");
  await actionPause();

  /* PASSWORD */

  const passwordSelector = "#password";

  await waitForSelector(
    passwordSelector
  );

  await fillInput(
    passwordSelector,
    account.password
  );

  log("Current password filled");
  await actionPause();

  /* LOGIN */

  await clickLoginButton();
  await actionPause(1.5);

  /* OTP */

  const otpSelector =
    await findOTPSelector();

  if (!otpSelector) {
    throw new Error(
      "2FA/OTP field not detected"
    );
  }

  log("2FA/OTP field detected");

  /*
   * Match the Python workflow's one-second pause before OTP entry.
   */
  const otpStartDelayCompleted = await pauseAwareSleep(
    getTimingValue(
      "OTP_START_DELAY_MS",
      1000,
      5000
    )
  );

  if (!otpStartDelayCompleted) {
    return;
  }

  const otp =
    generateOTP(
      account.totp
    );

  log("Current TOTP generated");

  /*
   * Don't verify OTP field after typing.
   * Navigation can destroy the DOM context.
   */

  await fillOTP(
    otpSelector,
    otp
  );

  if (!state.running) {
    return;
  }

  await actionPause();
  await submitOTP();
  await waitForPageStable();
  await actionPause(1.5);

  /* LOGIN COMPLETE */

  const success =
    await waitForLoginComplete();

  if (!success) {
    throw new Error(
      `Login could not be confirmed. Current URL: ${page.url()}`
    );
  }

  state.loggedIn = true;
  state.status = "logged-in";

  log(
    `Login completed successfully: ${page.url()}`
  );
}

/* =========================================================
   SAME PAGE NAVIGATION
========================================================= */

async function openSamePage(url) {
  log(`Changing current page URL to: ${url}`);

  let navigationError = null;

  try {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });
  } catch (error) {
    const isNavigationTimeout =
      error.message.includes("Navigation timeout");

    if (
      !isNavigationTimeout &&
      !isNavigationContextError(error)
    ) {
      throw error;
    }

    navigationError = error;
  }

  const expectedPath = new URL(url).pathname;
  const start = Date.now();
  let currentUrl = "";

  while (Date.now() - start < 30000) {
    try {
      await waitForPageStable(5000, 100);
      currentUrl = page.url();

      if (currentUrl.includes(expectedPath)) {
        log(`Current URL: ${currentUrl}`);
        return;
      }
    } catch (error) {
      if (!isNavigationContextError(error)) {
        throw error;
      }
    }

    await sleep(50);
  }

  throw new Error(
    navigationError
      ? `Navigation did not reach ${expectedPath}: ${currentUrl || navigationError.message}`
      : `Navigation did not reach ${expectedPath}: ${currentUrl || "unknown URL"}`
  );
}

/* =========================================================
   CREATE REPOSITORY
   SAME TAB
========================================================= */

async function createRepository() {
  const repoName =
    generateRepositoryName();

  state.status =
    "creating-repository";

  log(
    `Generated repository name: ${repoName}`
  );

  /*
   * SAME PAGE
   */

  await openSamePage(
    "https://github.com/new"
  );

  /* WAIT FOR PAGE */

  const repoSelector =
    '#repository-name-input, input[name="repository[name]"]';

  await waitForSelector(
    repoSelector,
    30000
  );

  log(
    "Repository creation page opened"
  );

  /* NAME */

  await fillInput(
    repoSelector,
    repoName
  );

  log(
    `Repository name filled: ${repoName}`
  );

  /*
   * Match the reference automation:
   * locate the enabled Create button, focus it, then submit with
   * Enter. The button is only clicked as a last-resort fallback
   * if GitHub does not submit from the keyboard event.
   */

  const pageBeforeCreate = page.url();
  const createSelectors = [
    'button[data-testid="create-repository-button"]',
    'button[type="submit"]'
  ];
  const buttonStart = Date.now();
  let createButton = null;

  while (
    Date.now() - buttonStart < 15000
  ) {
    for (const selector of createSelectors) {
      let candidate = null;

      try {
        candidate = await page.$(selector);

        if (!candidate) {
          continue;
        }

        const ready =
          await candidate.evaluate(
            button =>
              !button.disabled &&
              button.getAttribute(
                "aria-disabled"
              ) !== "true"
          );

        if (ready) {
          createButton = candidate;
          break;
        }
      } catch (error) {
        if (!isNavigationContextError(error)) {
          throw error;
        }
      }

      await candidate?.dispose().catch(() => {});
    }

    if (createButton) {
      break;
    }

    await sleep(200);
  }

  if (!createButton) {
    throw new Error(
      "Create Repository button was not found or was not ready"
    );
  }

  await sleep(
    1200 + Math.random() * 1500
  );

  try {
    await createButton.focus();
  } catch (error) {
    await createButton.dispose().catch(() => {});
    throw error;
  }

  await sleep(
    300 + Math.random() * 400
  );

  let submitted = false;

  try {
    [
      /* navigation result is intentionally unused */
    ] = await Promise.all([
      page.waitForNavigation({
        waitUntil: "domcontentloaded",
        timeout: 20000
      }),
      page.keyboard.press("Enter")
    ]);

    submitted = true;
    log(
      "Create Repository submitted with Enter"
    );
  } catch (error) {
    /*
     * GitHub can complete the navigation just after Puppeteer's
     * navigation wait times out. Give that late navigation a
     * short window before using the fallback.
     */

    if (
      String(error.message || "").includes(
        "Navigation timeout"
      )
    ) {
      await sleep(1500);

      const currentUrl = page.url();

      if (
        currentUrl !== pageBeforeCreate &&
        !currentUrl.includes("/new")
      ) {
        submitted = true;
        log(
          "Create Repository submitted with Enter (late navigation)"
        );
      }
    } else if (!isNavigationContextError(error)) {
      log(
        `Enter key failed: ${error.message}`
      );
    }
  }

  if (!submitted) {
    log(
      "Enter key did not submit the repository; using mouse fallback..."
    );

    try {
      await Promise.all([
        page.waitForNavigation({
          waitUntil: "domcontentloaded",
          timeout: 15000
        }),
        createButton.click()
      ]);

      log(
        "Create Repository submitted with mouse fallback"
      );
    } catch (error) {
      const isNavigationTimeout =
        String(error.message || "").includes(
          "Navigation timeout"
        );

      if (
        !isNavigationTimeout &&
        !isNavigationContextError(error)
      ) {
        throw error;
      }
    }
  }

  await createButton.dispose().catch(() => {});
  await sleep(2000);
  await waitForPageStable();

  /*
   * Let GitHub perform its own navigation.
   * We don't force another page.
   */

  const currentUrl = page.url();

  /*
   * Do not report success while GitHub is still on /new.
   * This was previously causing a false success log.
   */
  if (
    currentUrl === pageBeforeCreate ||
    currentUrl.includes("/new")
  ) {
    let formError = "";

    try {
      formError =
        await page.$$eval(
          [
            '[role="alert"]',
            ".flash-error",
            ".js-flash-alert",
            '[data-testid="error-message"]'
          ].join(","),
          nodes =>
            nodes
              .map(node =>
                (node.innerText || node.textContent || "")
                  .trim()
              )
              .filter(Boolean)
              .join(" | ")
        );
    } catch {}

    throw new Error(
      formError
        ? `Repository was not created: ${formError}`
        : "Repository was not created. GitHub stayed on the creation page."
    );
  }

  log(
    `Current URL: ${currentUrl}`
  );

  state.status =
    "repository-created";

  log(
    `Repository flow completed: ${repoName}`
  );

  return getRepositoryFromUrl(
    currentUrl
  );
}

/* =========================================================
   SETUP REPOSITORY NOTIFICATIONS
========================================================= */

async function setupNotifications(
  repository,
  emails
) {

  const settingsUrl =
    `https://github.com/${encodeURIComponent(
      repository.username
    )}/${encodeURIComponent(
      repository.repoName
    )}/settings/notifications/edit`;

  state.status =
    "setting-up-notifications";

  log(
    `Opening notification settings for ${repository.username}/${repository.repoName}`
  );

  await openSamePage(settingsUrl);

  const addressSelector =
    "#hook_config_attributes_address";

  await waitForSelector(
    addressSelector,
    30000
  );

  log(
    "Notification email field detected"
  );

  await fillInput(
    addressSelector,
    emails.join(" ")
  );

  log(
    `Notification emails filled: ${emails.join(", ")}`
  );

  const setupButton =
    await findButtonByText(
      "Setup notifications",
      30000
    );

  try {
    await Promise.all([
      page.waitForNavigation({
        waitUntil: "domcontentloaded",
        timeout: 15000
      }),
      setupButton.click()
    ]);
  } catch (error) {
    const isNavigationTimeout =
      error.message.includes(
        "Navigation timeout"
      );

    if (
      !isNavigationTimeout &&
      !isNavigationContextError(error)
    ) {
      throw error;
    }
  }

  await waitForPageStable();

  log(
    "Setup notifications clicked; waiting for completion"
  );

  const completionStart = Date.now();
  let completionMessage = "";
  let completed = false;

  while (
    Date.now() - completionStart < 20000
  ) {
      await waitForResume();

    try {
      completionMessage =
        await page.$$eval(
          [
            '[role="alert"]',
            ".flash-notice",
            ".flash-error",
            ".js-flash-alert",
            '[data-testid="error-message"]'
          ].join(","),
          nodes =>
            nodes
              .map(node =>
                (node.innerText || node.textContent || "")
                  .trim()
              )
              .filter(Boolean)
              .join(" | ")
        );
    } catch {}

    if (
      /can't|cannot|error|failed|invalid|not allowed|unable/i.test(
        completionMessage
      )
    ) {
      throw new Error(
        `Notification setup failed: ${completionMessage}`
      );
    }

    const currentUrl = page.url();
    const leftEditPage =
      !currentUrl.includes(
        "/settings/notifications/edit"
      );

    const hasSuccessMessage =
      /success|successful|saved|set up|configured/i.test(
        completionMessage
      );

    if (leftEditPage || hasSuccessMessage) {
      completed = true;
      break;
    }

    await sleep(50);
  }

  if (!completed) {
    throw new Error(
      "Notification setup did not complete within 20 seconds"
    );
  }

  state.status =
    "notifications-configured";

  log(
    `Notifications setup completed for ${repository.username}/${repository.repoName}`
  );
}

/* =========================================================
   CREATE AND COMMIT GITHUB ACTIONS WORKFLOW
========================================================= */

async function setupWorkflow(
  repository,
  workflow
) {
  const actionsUrl =
    `https://github.com/${encodeURIComponent(
      repository.username
    )}/${encodeURIComponent(
      repository.repoName
    )}/actions/new`;

  state.status =
    "setting-up-workflow";

  log(
    `Opening Actions workflow page for ${repository.username}/${repository.repoName}`
  );

  await openSamePage(actionsUrl);

  const configureLink =
    await findLinkByText(
      "configure",
      30000
    );

  log(
    "Simple workflow Configure link detected"
  );

  try {
    await Promise.all([
      page.waitForNavigation({
        waitUntil: "domcontentloaded",
        timeout: 15000
      }),
      (async () => {
        /*
         * GitHub can re-render the suggested workflow card
         * after the link was found. Resolve it again in the
         * current DOM, scroll it into view, then activate it.
         */
        try {
          await configureLink.evaluate(
            element => {
              element.scrollIntoView({
                block: "center",
                inline: "center"
              });
            }
          );
        } catch {}

        try {
          await page.evaluate(() => {
            const link = [
              ...document.querySelectorAll("a")
            ].find(element => {
              const label = (
                element.innerText ||
                element.textContent ||
                ""
              )
                .trim()
                .toLowerCase();
              const href =
                element.getAttribute("href") || "";

              return (
                label.includes("configure") &&
                href.includes("/new/main")
              );
            });

            if (!link) {
              throw new Error(
                "Configure workflow link disappeared"
              );
            }

            link.scrollIntoView({
              block: "center",
              inline: "center"
            });
            link.click();
          });
        } catch (error) {
          if (!isNavigationContextError(error)) {
            throw error;
          }
        }
      })()
    ]);
  } catch (error) {
    const isNavigationTimeout =
      error.message.includes(
        "Navigation timeout"
      );

    if (
      !isNavigationTimeout &&
      !isNavigationContextError(error)
    ) {
      throw error;
    }
  }

  await waitForPageStable();

  const fileNameSelector =
    'input[aria-label="File name"]';

  await waitForSelector(
    fileNameSelector,
    30000
  );

  log(
    "Workflow editor opened"
  );

  await fillInput(
    fileNameSelector,
    workflow.fileName
  );

  log(
    `Workflow file name filled: ${workflow.fileName}`
  );

  const openCommitButton =
    await findButtonByText(
      "Commit changes...",
      30000,
      true
    );

  await openCommitButton.click();

  const commitMessageSelector =
    "#commit-message-input";
  const descriptionSelector =
    "#commit-description-input";

  await waitForSelector(
    commitMessageSelector,
    30000
  );

  await waitForSelector(
    descriptionSelector,
    30000
  );

  log(
    "Commit dialog opened"
  );

  await fillInput(
    commitMessageSelector,
    workflow.commitMessage
  );

  await fillInput(
    descriptionSelector,
    workflow.description
  );

  log(
    "Commit message and extended description filled"
  );

  const finalCommitButton =
    await findButtonByText(
      "Commit changes",
      30000,
      true
    );

  const pageBeforeCommit =
    page.url();

  try {
    await Promise.all([
      page.waitForNavigation({
        waitUntil: "domcontentloaded",
        timeout: 15000
      }),
      finalCommitButton.click()
    ]);
  } catch (error) {
    const isNavigationTimeout =
      error.message.includes(
        "Navigation timeout"
      );

    if (
      !isNavigationTimeout &&
      !isNavigationContextError(error)
    ) {
      throw error;
    }
  }

  await waitForPageStable();

  const currentUrl = page.url();

  if (
    currentUrl === pageBeforeCommit ||
    currentUrl.includes("/new/main")
  ) {
    let formError = "";

    try {
      formError =
        await page.$$eval(
          [
            '[role="alert"]',
            ".flash-error",
            ".js-flash-alert",
            '[data-testid="error-message"]'
          ].join(","),
          nodes =>
            nodes
              .map(node =>
                (node.innerText || node.textContent || "")
                  .trim()
              )
              .filter(Boolean)
              .join(" | ")
        );
    } catch {}

    throw new Error(
      formError
        ? `Workflow commit failed: ${formError}`
        : "Workflow commit was not completed."
    );
  }

  state.status =
    "workflow-committed";

  log(
    `Workflow committed successfully: ${workflow.fileName}`
  );
}

async function runRecipientBatch(
  pair,
  workflow,
  batchNumber,
  totalBatches,
  account
) {
  const maxAttempts = 5;
  const maxBrowserAttempts = 3;
  const maxGitHubActionAttempts = 5;
  let repository = null;
  let notificationsConfigured = false;

  for (
    let attempt = 1;
    attempt <= maxAttempts;
    attempt++
  ) {
    await waitForResume();

    try {
      if (!repository) {
        repository =
          await createRepository();
      }

      if (!notificationsConfigured) {
        await setupNotifications(
          repository,
          pair
        );

        notificationsConfigured = true;
      }

      await setupWorkflow(
        repository,
        workflow
      );

      return repository;
    } catch (error) {
      const browserFailure =
        isBrowserLifecycleError(error);
      const navigationFailure =
        isNavigationContextError(error);
      const temporaryGitHubActionFailure =
        isTemporaryGitHubActionError(error);
      const retryLimit =
        temporaryGitHubActionFailure
          ? maxGitHubActionAttempts
          : maxBrowserAttempts;

      if (
        (
          !browserFailure &&
          !navigationFailure &&
          !temporaryGitHubActionFailure
        ) ||
        attempt >= retryLimit
      ) {
        throw error;
      }

      state.status =
        temporaryGitHubActionFailure
          ? "retrying-github-action"
          : browserFailure
            ? "recovering-browser"
            : "recovering-navigation";

      if (temporaryGitHubActionFailure) {
        log(
          `GitHub temporarily rejected the workflow commit for batch ${batchNumber}/${totalBatches}; keeping the same account and repository, then retrying immediately (${attempt + 1}/${maxGitHubActionAttempts})...`
        );

        await waitForResume();
        await waitForResume();
        continue;
      }

      log(
        browserFailure
          ? `Google Chrome closed during batch ${batchNumber}/${totalBatches}; reopening the same account (${attempt + 1}/${maxBrowserAttempts})...`
          : `Page navigation/context failed during batch ${batchNumber}/${totalBatches}; reopening the same account (${attempt + 1}/${maxBrowserAttempts})...`
      );

      if (browserFailure || navigationFailure) {
        await recoverBrowser(account);
      } else {
        await sleep(attempt * 1000);
      }
    }
  }

  throw new Error(
    `Batch ${batchNumber}/${totalBatches} could not be completed.`
  );
}

/* =========================================================
   START AUTOMATION
========================================================= */

app.post(
  "/api/automation/jobs",
  (req, res) => {
    if (state.running) {
      return res.status(409).json({
        success: false,
        error: "Automation already running"
      });
    }

    let jobs;

    try {
      jobs = getBatchJobs(
        req.body && req.body.jobs
      );
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: error.message
      });
    }

    state.queuedJobs.push(...jobs);

    res.json({
      success: true,
      queued: state.queuedJobs.length
    });
  }
);

app.post(
  "/api/automation/start",
  async (req, res) => {
    if (state.running) {
      return res.status(409).json({
        success: false,
        error:
          "Automation already running"
      });
    }

    let account;
    let recipients;
    let workflow;
    let startBatchIndex = 0;
    let batchSize = 2;
    let jobs;
    let totalBatches = 0;

    try {
      account = getAccount(
        req.body && req.body.account
      );

      batchSize = getBatchSize(
        req.body && req.body.batchSize
      );

      if (state.queuedJobs.length > 0) {
        jobs = state.queuedJobs;
        totalBatches =
          Number(req.body && req.body.totalBatches) ||
          jobs.length;
      } else if (
        req.body &&
        Array.isArray(req.body.jobs)
      ) {
        jobs = getBatchJobs(
          req.body.jobs,
          batchSize
        );
        totalBatches =
          Number(req.body.totalBatches) ||
          jobs.length;
      } else {
        recipients = getRecipients(
          req.body && req.body.recipients
        );
      }

      workflow = getWorkflow(
        req.body && req.body.workflow
      );

      startBatchIndex = Math.max(
        0,
        Math.floor(
          Number(
            req.body && req.body.startBatchIndex || 0
          )
        )
      );
    } catch (error) {
      if (
        req.body &&
        Array.isArray(req.body.jobs)
      ) {
        try {
          jobs = getBatchJobs(
            req.body.jobs,
            batchSize
          );
          totalBatches =
            Number(req.body.totalBatches) ||
            jobs.length;
        } catch (jobError) {
          return res.status(400).json({
            success: false,
            error: jobError.message
          });
        }
      }

      return res.status(400).json({
        success: false,
        error: error.message
      });
    }

    state.queuedJobs = [];
    state.running = true;
    state.paused = false;
    state.loggedIn = false;
    state.status = "starting";

    res.json({
      success: true,
      message:
        "Automation started"
    });

    try {
      await launchBrowser();

      await login(account);

      if (state.loggedIn) {
        const allEmailPairs =
          jobs ||
          groupNotificationEmails(
            recipients,
            batchSize
          ).map((pair, index) => ({
            index,
            recipients: pair
          }));

        totalBatches =
          totalBatches || allEmailPairs.length;

        log(
          `Recipient batches to process: ${allEmailPairs.length} of ${totalBatches} total`
        );

        for (const job of allEmailPairs) {
          await waitForResume();

          if (!state.running) {
            break;
          }

          log(
            `Starting recipient batch ${job.index + 1}/${totalBatches}`
          );

          const repository =
            await runRecipientBatch(
              job.recipients,
              workflow,
              job.index + 1,
                totalBatches,
                account
            );

          log(
            `Recipient batch completed ${job.index + 1}/${totalBatches}: ${repository.username}/${repository.repoName}`
          );
        }
      }

      if (state.running) {
        state.status = "finished";
        state.running = false;

        log(
          "Automation completed successfully"
        );
      }

    } catch (error) {
      state.running = false;
      state.status = "error";

      log(
        `Automation failed: ${error.message}`
      );
    }
  }
);

/* =========================================================
   STOP
========================================================= */

app.post(
  "/api/automation/pause",
  (req, res) => {
    if (!state.running) {
      return res.status(409).json({
        success: false,
        error: "Automation is not running"
      });
    }

    state.paused = true;
    log("Automation paused");

    res.json({
      success: true,
      paused: true
    });
  }
);

app.post(
  "/api/automation/resume",
  (req, res) => {
    if (!state.running) {
      return res.status(409).json({
        success: false,
        error: "Automation is not running"
      });
    }

    state.paused = false;
    log("Automation resumed");

    res.json({
      success: true,
      paused: false
    });
  }
);

app.post(
  "/api/automation/stop",
  async (req, res) => {
    state.running = false;
    state.paused = false;
    state.status = "stopped";

    log(
      "Automation stopped"
    );

    res.json({
      success: true
    });
  }
);

/* =========================================================
   STATUS
========================================================= */

app.get(
  "/api/automation/status",
  (req, res) => {
    res.json({
      running:
        state.running,

      loggedIn:
        state.loggedIn,

      status:
        state.status,

      paused:
        state.paused,

      currentUrl:
        page
          ? page.url()
          : null
    });
  }
);

/* =========================================================
   LOGS
========================================================= */

app.get(
  "/api/automation/logs",
  (req, res) => {
    res.json({
      logs:
        state.logs
    });
  }
);

/* =========================================================
   ROOT
========================================================= */

app.get(
  "/",
  (req, res) => {
    res.json({
      ok: true,
      service:
        "UI Automation Backend",
      status:
        state.status
    });
  }
);

/* =========================================================
   SERVER
========================================================= */

const server =
  app.listen(
    PORT,
    "127.0.0.1",
    () => {
      console.log("");
      console.log(
        "===================================="
      );
      console.log(
        " UI AUTOMATION BACKEND"
      );
      console.log(
        "===================================="
      );
      console.log(
        `Server: http://localhost:${PORT}`
      );
      console.log("");
    }
  );

server.on(
  "error",
  error => {
    console.error(
      "SERVER ERROR:",
      error.message
    );
  }
);

/* =========================================================
   GRACEFUL SHUTDOWN
========================================================= */

async function shutdownRunner(signal) {
  log(`Runner received ${signal}`);
  try {
    if (browser && browser.connected) {
      await browser.close().catch(() => {});
    }
  } finally {
    browser = null;
    page = null;
    await cleanupChromeProfile();
    process.exit(0);
  }
}

process.once("SIGTERM", () => { void shutdownRunner("SIGTERM"); });
process.once("SIGINT", () => { void shutdownRunner("SIGINT"); });

/* =========================================================
   PROCESS ERRORS
========================================================= */

process.on(
  "uncaughtException",
  error => {
    console.error(
      "UNCAUGHT EXCEPTION:",
      error
    );
  }
);

process.on(
  "unhandledRejection",
  error => {
    console.error(
      "UNHANDLED REJECTION:",
      error
    );
  }
);