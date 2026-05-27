/**
 * ============================================================
 *  COMPANY SENTIMENT LEADERBOARD — DATA PIPELINE ENGINE v2.0
 *  scraper.js  |  Node.js ESM  |  Puppeteer headless browser
 * ============================================================
 *  Pipeline:
 *    1. Launch headless Chromium (looks like a real browser)
 *    2. Navigate to deshimula.com/company-summary
 *    3. Auto-scroll to load ALL companies (infinite scroll / lazy load)
 *    4. Parse every company card from the rendered DOM
 *    5. Run global Bayesian math engine
 *    6. Diff vs existing data.json — only write if changed
 * ============================================================
 */

import puppeteer from "puppeteer";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { createHash } from "crypto";

// ─────────────────────────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────────────────────────
const OUTPUT_FILE  = "data.json";
const SCRAPE_URL   = "https://deshimula.com/company-summary";
const PAGE_TIMEOUT = 60_000;   // 60s max for initial page load
const SCROLL_PAUSE = 1800;     // ms to wait between scrolls
const MAX_SCROLLS  = 80;       // safety cap (~800 companies at ~10/scroll)
const MIN_COMPANIES_FOR_NORMALIZATION = 3;

// ─────────────────────────────────────────────────────────────
//  REAL FALLBACK DATASET  (extracted from live screenshot)
//  Used ONLY when scrape fails AND no data.json exists yet.
// ─────────────────────────────────────────────────────────────
const FALLBACK_DATASET = [
  { name: "TechnoNe><t Ltd",                                                 positive: 6,  negative: 64, mixed: 5  },
  { name: "Betopi@ / BdCa11ing / $parktech / S0ftv3nce / $M Tech / B@ckventure", positive: 5, negative: 58, mixed: 5 },
  { name: "Opt!m!zely",                                                       positive: 14, negative: 15, mixed: 15 },
  { name: "We11Dev",                                                           positive: 4,  negative: 23, mixed: 15 },
  { name: "M!r InfO Systems Ltd",                                              positive: 0,  negative: 36, mixed: 5  },
  { name: "Ther@p BD",                                                         positive: 2,  negative: 32, mixed: 7  },
  { name: "Mogoj Station 23",                                                  positive: 6,  negative: 20, mixed: 9  },
  { name: "Cef@lo",                                                            positive: 13, negative: 13, mixed: 7  },
  { name: "A11 Gen3ratIon Tech",                                               positive: 3,  negative: 23, mixed: 6  },
  { name: "AkIj iB0s",                                                         positive: 0,  negative: 30, mixed: 1  },
  { name: "2SL Wireless",                                                       positive: 0,  negative: 29, mixed: 2  },
  { name: "WWW Engineers Ltd",                                                  positive: 7,  negative: 24, mixed: 0  },
  { name: "8RAC IT",                                                            positive: 1,  negative: 22, mixed: 2  },
  { name: "Ech0lOgyx Ltd",                                                      positive: 1,  negative: 20, mixed: 4  },
  { name: "Viv@soft",                                                           positive: 8,  negative: 7,  mixed: 9  },
  { name: "N3xt Ventur3s",                                                      positive: 0,  negative: 23, mixed: 1  },
  { name: "Inter@ctive Cares",                                                  positive: 5,  negative: 14, mixed: 3  },
  { name: "BgIT",                                                               positive: 3,  negative: 15, mixed: 3  },
];

// ─────────────────────────────────────────────────────────────
//  UTILITY: sleep
// ─────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────
//  UTILITY: MD5 hash for diff detection
// ─────────────────────────────────────────────────────────────
function hashString(str) {
  return createHash("md5").update(str).digest("hex");
}

// ─────────────────────────────────────────────────────────────
//  STEP 1 — PUPPETEER SCRAPER
//  Launches a real headless Chromium browser, navigates to the
//  target page, scrolls through all companies, and extracts data.
// ─────────────────────────────────────────────────────────────
async function scrapeWithPuppeteer() {
  console.log(`\n[SCRAPER] Launching headless browser...`);

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--disable-gpu",
        "--window-size=1280,900",
      ],
    });

    const page = await browser.newPage();

    // ── Stealth: spoof a real browser fingerprint ──────────────
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    );
    await page.setViewport({ width: 1280, height: 900 });
    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      "Referer": "https://deshimula.com/",
    });

    console.log(`[SCRAPER] Navigating to: ${SCRAPE_URL}`);
    await page.goto(SCRAPE_URL, {
      waitUntil: "networkidle2",
      timeout: PAGE_TIMEOUT,
    });

    // ── Wait for company cards to appear in the DOM ────────────
    // Try multiple possible selectors for the card container.
    const CARD_SELECTORS = [
      '[class*="company"]',
      '[class*="card"]',
      '[class*="Company"]',
      '[class*="Card"]',
      "article",
      "section > div > div",
    ];

    let cardSelector = null;
    for (const sel of CARD_SELECTORS) {
      try {
        await page.waitForSelector(sel, { timeout: 8000 });
        const count = await page.$$eval(sel, (els) => els.length);
        if (count >= 2) {
          cardSelector = sel;
          console.log(`[SCRAPER] Found card selector: "${sel}" (${count} elements)`);
          break;
        }
      } catch (_) { /* try next */ }
    }

    if (!cardSelector) {
      throw new Error("Could not identify company card elements on the page.");
    }

    // ── Auto-scroll to trigger lazy loading / infinite scroll ──
    console.log(`[SCRAPER] Scrolling to load all companies...`);
    let previousHeight = 0;
    let scrollCount    = 0;
    let stableRounds   = 0;

    while (scrollCount < MAX_SCROLLS) {
      const currentHeight = await page.evaluate(() => document.body.scrollHeight);

      if (currentHeight === previousHeight) {
        stableRounds++;
        if (stableRounds >= 3) {
          console.log(`[SCRAPER] Page fully loaded after ${scrollCount} scrolls.`);
          break;
        }
      } else {
        stableRounds = 0;
      }

      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await sleep(SCROLL_PAUSE);

      // Also click any "Load More" / "Show More" buttons if present
      try {
        const loadMoreBtn = await page.$('[class*="load-more"], [class*="LoadMore"], button[class*="more"], button[class*="More"]');
        if (loadMoreBtn) {
          await loadMoreBtn.click();
          await sleep(SCROLL_PAUSE);
          console.log(`[SCRAPER] Clicked "Load More" button.`);
        }
      } catch (_) { /* no button, that's fine */ }

      previousHeight = currentHeight;
      scrollCount++;
    }

    // ── Extract company data from the fully rendered DOM ───────
    console.log(`[SCRAPER] Extracting company data from DOM...`);

    const companies = await page.evaluate(() => {
      const results = [];

      // ── Strategy 1: Parse the visible card structure ──────────
      // We look for elements that contain a number labeled "Positive",
      // a number labeled "Negative", and a number labeled "Mixed".
      // This is layout-agnostic and works regardless of class names.
      const allElements = Array.from(document.querySelectorAll("*"));

      // Find all elements whose text content is exactly "Positive", "Negative", "Mixed"
      const positiveLabels = allElements.filter(
        (el) => el.children.length === 0 && el.textContent.trim() === "Positive"
      );

      for (const positiveLabel of positiveLabels) {
        try {
          // Walk up to find the container that holds all three labels
          let container = positiveLabel.parentElement;
          for (let i = 0; i < 5; i++) {
            if (!container) break;
            const text = container.textContent;
            if (
              text.includes("Positive") &&
              text.includes("Negative") &&
              text.includes("Mixed")
            ) {
              break;
            }
            container = container.parentElement;
          }
          if (!container) continue;

          // Walk up further to find the card that also has the company name + post count
          let card = container.parentElement;
          for (let i = 0; i < 6; i++) {
            if (!card) break;
            const text = card.textContent;
            if (text.includes("posts") || text.includes("post")) break;
            card = card.parentElement;
          }
          if (!card) continue;

          // Extract numbers labeled Positive / Negative / Mixed
          const allChildren = Array.from(card.querySelectorAll("*"));

          let positive = 0, negative = 0, mixed = 0;
          for (const el of allChildren) {
            if (el.children.length > 0) continue;
            const label = el.textContent.trim();
            if (label === "Positive" || label === "positive") {
              const numEl = el.parentElement?.querySelector("*");
              const val = parseInt(numEl?.textContent?.trim() ?? el.previousElementSibling?.textContent?.trim(), 10);
              if (!isNaN(val)) positive = val;
            }
            if (label === "Negative" || label === "negative") {
              const numEl = el.parentElement?.querySelector("*");
              const val = parseInt(numEl?.textContent?.trim() ?? el.previousElementSibling?.textContent?.trim(), 10);
              if (!isNaN(val)) negative = val;
            }
            if (label === "Mixed" || label === "mixed") {
              const numEl = el.parentElement?.querySelector("*");
              const val = parseInt(numEl?.textContent?.trim() ?? el.previousElementSibling?.textContent?.trim(), 10);
              if (!isNaN(val)) mixed = val;
            }
          }

          // Extract company name — the first meaningful heading/link text in the card
          let name = "";
          const headings = card.querySelectorAll("h1, h2, h3, h4, h5, a, [class*='name'], [class*='Name'], [class*='title'], [class*='Title']");
          for (const h of headings) {
            const t = h.textContent.trim();
            // Skip "posts" counts, navigation links, etc.
            if (t && t.length > 1 && !/^\d+\s*(posts?)?$/i.test(t) && !/^(positive|negative|mixed|overall|sentiment)$/i.test(t)) {
              name = t;
              break;
            }
          }
          // Fallback: first non-numeric text node in card
          if (!name) {
            const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
            let node;
            while ((node = walker.nextNode())) {
              const t = node.textContent.trim();
              if (t.length > 2 && !/^\d+\s*(posts?)?$/i.test(t) && !/^(positive|negative|mixed|overall|sentiment|:)$/i.test(t)) {
                name = t;
                break;
              }
            }
          }

          if (name && (positive + negative + mixed) > 0) {
            // De-duplicate by name
            if (!results.find((r) => r.name === name)) {
              results.push({ name, positive, negative, mixed });
            }
          }
        } catch (_) { /* skip malformed card */ }
      }

      // ── Strategy 2: Numeric sibling scan ─────────────────────
      // If Strategy 1 found nothing, try finding numbers next to
      // "Positive" / "Negative" / "Mixed" sibling elements.
      if (results.length === 0) {
        const cards = document.querySelectorAll(
          '[class*="company"],[class*="card"],[class*="Company"],[class*="Card"],article'
        );
        for (const card of cards) {
          const text = card.textContent;
          if (!text.includes("Positive") || !text.includes("Negative") || !text.includes("Mixed")) continue;

          const nums = (text.match(/\d+/g) || []).map(Number);
          if (nums.length < 3) continue;

          const name = card.querySelector("h1,h2,h3,h4,h5,a")?.textContent?.trim() ?? "";
          if (!name || results.find((r) => r.name === name)) continue;

          results.push({
            name,
            positive: nums[0] ?? 0,
            negative: nums[1] ?? 0,
            mixed:    nums[2] ?? 0,
          });
        }
      }

      return results;
    });

    await browser.close();

    if (companies.length === 0) {
      throw new Error("DOM parsed but zero companies extracted. Selectors may need updating.");
    }

    console.log(`[SCRAPER] ✓ Successfully extracted ${companies.length} companies.`);
    return companies;

  } catch (err) {
    if (browser) {
      try { await browser.close(); } catch (_) {}
    }
    console.error(`[SCRAPER] ✗ Scrape failed: ${err.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
//  STEP 2 — BAYESIAN MATH ENGINE
// ─────────────────────────────────────────────────────────────
function runBayesianMath(rawCompanies) {
  console.log(`\n[MATH] Running Bayesian engine on ${rawCompanies.length} companies...`);

  const totals = rawCompanies.map((c) => c.positive + c.negative + c.mixed);
  const C = totals.reduce((a, b) => a + b, 0) / totals.length;

  const satisfactionRatios = rawCompanies.map((c, i) => {
    if (totals[i] === 0) return 0;
    return (c.positive + 0.5 * c.mixed) / totals[i];
  });
  const m = satisfactionRatios.reduce((a, b) => a + b, 0) / satisfactionRatios.length;

  console.log(`[MATH]   C (avg volume)       = ${C.toFixed(2)}`);
  console.log(`[MATH]   m (avg satisfaction) = ${(m * 100).toFixed(2)}%`);

  // S = ((P + 0.5×M) + C×m) / (V + C)
  const scored = rawCompanies.map((c, i) => {
    const V = totals[i];
    const S = (c.positive + 0.5 * c.mixed + C * m) / (V + C);
    return { ...c, total_posts: V, bayesian_score: S };
  });

  const maxS = Math.max(...scored.map((c) => c.bayesian_score));

  const normalized = scored.map((c) => {
    const rating_score =
      scored.length >= MIN_COMPANIES_FOR_NORMALIZATION
        ? c.bayesian_score / maxS
        : c.bayesian_score;

    return {
      name:           c.name,
      total_posts:    c.total_posts,
      positive_count: c.positive,
      negative_count: c.negative,
      mixed_count:    c.mixed,
      bayesian_score: parseFloat(c.bayesian_score.toFixed(6)),
      rating_score:   parseFloat(rating_score.toFixed(6)),
      percentage:     parseFloat((rating_score * 100).toFixed(2)),
      letter_grade:   getLetterGrade(rating_score),
    };
  });

  normalized.sort((a, b) => b.rating_score - a.rating_score);
  console.log(`[MATH] ✓ Top company: "${normalized[0].name}" @ ${normalized[0].percentage}%`);
  return normalized;
}

// ─────────────────────────────────────────────────────────────
//  STEP 3 — LETTER GRADE LOOKUP
// ─────────────────────────────────────────────────────────────
function getLetterGrade(R) {
  if (R >= 0.90) return "A+";
  if (R >= 0.80) return "A";
  if (R >= 0.70) return "A-";
  if (R >= 0.60) return "B+";
  if (R >= 0.50) return "B";
  if (R >= 0.40) return "C";
  if (R >= 0.30) return "D";
  return "F";
}

// ─────────────────────────────────────────────────────────────
//  STEP 4 — WRITE OUTPUT (only if data changed)
// ─────────────────────────────────────────────────────────────
function writeOutputIfChanged(companies) {
  const totalPosts    = companies.reduce((a, c) => a + c.total_posts, 0);
  const avgSatisfaction = parseFloat(
    (companies.reduce((a, c) => a + c.rating_score, 0) / companies.length * 100).toFixed(2)
  );

  const output = {
    schema_version:  "2.0",
    generated_at:    new Date().toISOString(),
    total_companies: companies.length,
    global_stats: {
      total_posts_all:  totalPosts,
      avg_volume:       parseFloat((totalPosts / companies.length).toFixed(2)),
      avg_satisfaction: avgSatisfaction,
    },
    companies,
  };

  const newJson = JSON.stringify(output, null, 2);

  // Compare company data only (strip timestamps before hashing)
  const extractComparableData = (json) => {
    try {
      const obj = JSON.parse(json);
      return JSON.stringify(obj.companies || []);
    } catch {
      return json;
    }
  };

  if (existsSync(OUTPUT_FILE)) {
    const existing = readFileSync(OUTPUT_FILE, "utf8");
    if (hashString(extractComparableData(newJson)) === hashString(extractComparableData(existing))) {
      console.log("\n[OUTPUT] No data change detected. Skipping write. ✓");
      return false;
    }
  }

  writeFileSync(OUTPUT_FILE, newJson, "utf8");
  console.log(`\n[OUTPUT] ✓ data.json updated — ${companies.length} companies @ ${output.generated_at}`);
  return true;
}

// ─────────────────────────────────────────────────────────────
//  MAIN PIPELINE
// ─────────────────────────────────────────────────────────────
async function main() {
  console.log("════════════════════════════════════════════════");
  console.log("  SENTIMENT LEADERBOARD PIPELINE v2.0 START");
  console.log("════════════════════════════════════════════════");

  // 1. Try live scrape
  let rawCompanies = await scrapeWithPuppeteer();

  // 2. Fallback: keep existing data.json
  if (!rawCompanies) {
    if (existsSync(OUTPUT_FILE)) {
      console.log("\n[FALLBACK] Live scrape failed. Keeping existing data.json intact.");
      console.log("════════════════════════════════════════════════\n");
      process.exit(0);
    }
    // Last resort: use screenshot-derived fallback
    console.log("\n[FALLBACK] No existing data.json found. Using screenshot-derived fallback dataset.");
    rawCompanies = FALLBACK_DATASET;
  }

  // 3. Run Bayesian math
  let companies;
  try {
    companies = runBayesianMath(rawCompanies);
  } catch (err) {
    console.error(`\n[MATH] ✗ Fatal: ${err.message}`);
    process.exit(1);
  }

  // 4. Write if changed
  writeOutputIfChanged(companies);

  console.log("\n[PIPELINE] ✓ Done.");
  console.log("════════════════════════════════════════════════\n");
}

main().catch((err) => {
  console.error("[PIPELINE] ✗ Unhandled error:", err);
  process.exit(1);
});