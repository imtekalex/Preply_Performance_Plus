# Preply Performance Plus

Chrome extension that augments `https://preply.com/de/performance` with income analytics, monthly projection, lifetime totals, and student benchmarking.

## Install locally

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder.
5. Open or reload `https://preply.com/de/performance`.

## How data is collected

The extension first tries to fetch Preply's own earnings report endpoint in the page context, once per page load:

`/tutor/download-earnings-report?timestampStart=YYYY-MM-DD&timestampEnd=YYYY-MM-DD&format=csv`

That keeps the request authenticated with the existing Preply session and avoids opening the report dialog. To avoid unnecessary traffic, the automatic fetch requests only one CSV range, then derives month-to-date, previous-month, year-to-date, and student ranking locally where the CSV contains dates and student names. If Preply blocks the request, changes the endpoint, or returns a non-CSV response, the panel falls back to the numbers already visible on the performance page.

The parser explicitly supports Preply CSV columns such as `Schüler`, `Datum der Einheit`, `Type`, `Earning, USD`, and `Lesson Price` / `Lesson Price, USD`. It intentionally uses `Earning, USD` for tutor income and also derives current student price points, trial conversion, unused lesson pipeline, churn risk, and price-increase candidates.

The panel always shows an update timestamp in German, for example:

`Echtzeit-Kennzahlen aktualisiert: 7. Juni, 11:43 Uhr.`

## Current metrics

- Current month income
- Monthly income breakdown for the last 12 available CSV months
- Year navigation for monthly income tables when multiple years are available
- Projected month income
- Total income
- Average income per lesson
- Average hourly rate when the CSV includes an actual duration/hour column
- Average payout per paid lesson
- Average lessons per week when hour columns are unavailable
- Active students and total lifetime students
- Average weekly hours when the CSV includes an actual duration/hour column
- Average bookings per month
- Trial-to-paid conversion and student pipeline analysis
- Pricepoint breakdown by student groups
- Churn-risk category counts
- Recommended price increases for eligible students
- Top 10 student ranking by income, bookings, average per lesson, and hourly rate when the CSV includes the required columns

## Next data check

If the student ranking stays empty, open DevTools on the Preply performance page and run:

```js
fetch('/tutor/download-earnings-report?timestampStart=2026-01-01&timestampEnd=2026-06-07&format=csv', { credentials: 'include' })
  .then(r => r.text())
  .then(t => console.log(t.slice(0, 1000)))
```

The first CSV header line is enough to adjust the column inference in `src/content.js`.
