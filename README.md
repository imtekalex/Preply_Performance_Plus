# Preply Performance Plus

Chrome extension that augments `https://preply.com/de/performance` with income analytics, monthly projection, cached lifetime totals, student benchmarking, and price benchmarking.

## Install locally

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder.
5. Open or reload `https://preply.com/de/performance`.

## How data is collected

The extension first tries to fetch Preply's own earnings report endpoint in the page context:

`/tutor/download-earnings-report?timestampStart=YYYY-MM-DD&timestampEnd=YYYY-MM-DD&format=csv`

That keeps the request authenticated with the existing Preply session and avoids opening the report dialog. To avoid unnecessary traffic, the extension stores parsed CSV transactions in `chrome.storage.local`. The first successful run requests the full available history; later page loads only request the missing date range. If the cache already reaches today, no CSV request is made on page load. The refresh button only fetches the current day and merges it into the existing cache. The trash button asks for confirmation, deletes the stored CSV data, and rebuilds the history from scratch.

The parser explicitly supports Preply CSV columns such as `Schüler`, `Datum der Einheit`, `Type`, `Earning, USD`, and `Lesson Price, USD`. It intentionally uses `Earning, USD` for tutor income and `Lesson Price, USD` for the current student price in the ranking.

The panel always shows an update timestamp in German, for example:

`Echtzeit-Kennzahlen aktualisiert: 7. Juni, 11:43 Uhr.`

## Current metrics

- Total income since the first cached CSV transaction
- Average payout pro paid lesson for the current month
- Average payout pro paid lesson since the first cached CSV transaction
- Current month income
- Monthly income breakdown by year
- Year navigation for monthly income tables when multiple years are available
- Projected month income
- Average hourly rate when the CSV includes an actual duration column
- Average lessons pro week when hour columns are unavailable
- Active students and total students
- Average weekly hours when the CSV includes an actual duration column
- Average units pro month
- Top 10 student ranking by income, units, current price, and hourly rate when the CSV includes the required columns
- Price benchmarking by current student price, including which students are billed at each price point
- Price recommendation hints based on current price, total units, recent 30-day units, average units pro month, and the median student price

Price recommendation hints are intentionally conservative. They infer possible price conversations from CSV history only; they do not know your real availability, message demand, student context, or relationship quality.

## Next data check

If the student ranking stays empty, open DevTools on the Preply performance page and run:

```js
fetch('/tutor/download-earnings-report?timestampStart=2026-01-01&timestampEnd=2026-06-07&format=csv', { credentials: 'include' })
  .then(r => r.text())
  .then(t => console.log(t.slice(0, 1000)))
```

The first CSV header line is enough to adjust the column inference in `src/content.js`.
