# Preply Performance Plus

Chrome extension that augments `https://preply.com/de/performance` with income analytics, monthly projection, cached lifetime totals, yearly income views, student benchmarking, and price benchmarking.

## Install locally

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder.
5. Open or reload `https://preply.com/de/performance`.

## How data is collected

The extension first tries to fetch Preply's own earnings report endpoint in the page context:

`/tutor/download-earnings-report?timestampStart=YYYY-MM-DD&timestampEnd=YYYY-MM-DD&format=csv`

That keeps the request authenticated with the existing Preply session and avoids opening the report dialog. To avoid unnecessary traffic, the extension stores parsed CSV transactions and the latest current-student snapshot in `chrome.storage.local`. The first successful run reads the membership month from the performance page text, for example `seit du im November 2025 beigetreten bist`, and requests CSV data from the first day of that month. If that text is unavailable, it falls back to `2000-01-01`. Later page loads only request the missing CSV date range. If the cache already reaches today, no CSV request is made on page load. The current-student snapshot is reused for the rest of the local day. The refresh button fetches the current CSV day, merges it into the existing history, and reloads the full current-student list. The `Löschen` link asks for confirmation, deletes stored CSV and student data, and rebuilds both from scratch.

The parser explicitly supports Preply CSV columns such as `Schüler`, `Datum der Einheit`, `Type`, `Earning, USD`, and `Lesson Price, USD`. It intentionally uses `Earning, USD` for tutor income and `Lesson Price, USD` for the current student price in the ranking.

The extension also queries Preply's `TutorStudentManagement` GraphQL operation from a small page-context bridge at `/graphql/v2/TutorStudentManagement`. That provides the current-student list, status, next lesson, and balance utilisation. The request includes Apollo CSRF preflight headers because Preply's GraphQL endpoint blocks ambiguous browser requests. When this request is available, active-student ranking and price benchmarking use Preply's current-student list instead of the CSV-only recent-lessons fallback.

The panel always shows an update timestamp in German, for example:

`Echtzeit-Kennzahlen aktualisiert: 7. Juni, 11:43 Uhr.`

## Current metrics

- Total income since the first cached CSV transaction
- Average payout pro paid lesson across the last three calendar months
- Current month income
- Yearly overview with monthly rows
- Year navigation for yearly overview tables when multiple years are available
- Projected month income
- Average hourly rate when the CSV includes an actual duration column
- Average lessons pro week when hour columns are unavailable
- Active students and total students
- Average weekly hours when the CSV includes an actual duration column
- Average units pro month
- Top 10 currently active-student ranking by income, units, used/total balance, current price, tutor wage, and hourly rate when the CSV includes the required columns
- Price benchmarking for currently active students by current student price, including tutor wage, used/total balance, subscription timing, names per price segment, and integrated price-review hints
- Price review hints based on current price, price age, total units, remaining balance, recent 30-day units, average units pro month, subscription timing, and the median student price

Price review hints are intentionally conservative. They infer possible price conversations from CSV history plus Preply's current-student balance and subscription data when available; they do not know your real availability, message demand, student context, or relationship quality.

## Next data check

If the student ranking stays empty, open DevTools on the Preply performance page and run:

```js
fetch('/tutor/download-earnings-report?timestampStart=2026-01-01&timestampEnd=2026-06-07&format=csv', { credentials: 'include' })
  .then(r => r.text())
  .then(t => console.log(t.slice(0, 1000)))
```

The first CSV header line is enough to adjust the column inference in `src/content.js`.
