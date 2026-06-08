(() => {
  const ROOT_ID = "preply-plus-root";
  const MESSAGE_REQUEST = "PREPLY_PLUS_FETCH_REPORTS";
  const MESSAGE_RESPONSE = "PREPLY_PLUS_REPORTS_RESULT";
  const DAY_MS = 24 * 60 * 60 * 1000;
  const CACHE_KEY = "preplyPlusTransactionCache";
  const DEFAULT_HISTORY_START = "2000-01-01";

  let lastState = null;
  let pendingRequest = null;
  let refreshTimer = null;
  let hasAutoLoaded = false;
  let isRefreshing = false;
  let selectedMonthYear = null;
  let activeReportRanges = [];

  const moneyFormatter = new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0
  });

  const numberFormatter = new Intl.NumberFormat("de-DE", {
    maximumFractionDigits: 1
  });

  const dateFormatter = new Intl.DateTimeFormat("de-DE", {
    day: "numeric",
    month: "long"
  });

  const fullDateFormatter = new Intl.DateTimeFormat("de-DE", {
    day: "numeric",
    month: "long",
    year: "numeric"
  });

  const timeFormatter = new Intl.DateTimeFormat("de-DE", {
    hour: "2-digit",
    minute: "2-digit"
  });

  const monthFormatter = new Intl.DateTimeFormat("de-DE", {
    month: "short",
    year: "numeric"
  });

  function boot() {
    injectPageBridge();
    installListeners();
    waitForPerformancePage();
  }

  function injectPageBridge() {
    if (document.getElementById("preply-plus-injected")) {
      return;
    }

    const script = document.createElement("script");
    script.id = "preply-plus-injected";
    script.src = chrome.runtime.getURL("src/injected.js");
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);
  }

  function installListeners() {
    window.addEventListener("message", (event) => {
      if (event.source !== window || event.data?.type !== MESSAGE_RESPONSE) {
        return;
      }
      if (!pendingRequest || event.data.requestId !== pendingRequest.requestId) {
        return;
      }
      pendingRequest.resolve(event.data);
      pendingRequest = null;
    });
  }

  function waitForPerformancePage(attempt = 0) {
    if (findInsertionAnchor()) {
      scheduleRefresh(250);
      return;
    }

    if (attempt < 40) {
      window.setTimeout(() => waitForPerformancePage(attempt + 1), 250);
    }
  }

  function scheduleRefresh(delay, options = {}) {
    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => refreshAnalytics(options), delay);
  }

  async function refreshAnalytics({ force = false } = {}) {
    if (isRefreshing) {
      return;
    }

    if (hasAutoLoaded && !force) {
      return;
    }

    const anchor = findInsertionAnchor();
    if (!anchor) {
      return;
    }

    isRefreshing = true;
    renderShell(anchor);
    setStatus("Aktualisiere Kennzahlen ...");

    try {
      const visible = scrapeVisibleMetrics();
      const cache = await loadTransactionCache();
      activeReportRanges = buildRanges(cache);
      let reportResult = { reports: [], errors: [] };

      if (activeReportRanges.length) {
        try {
          reportResult = await requestReports();
        } catch (error) {
          reportResult = await requestReportsDirect(error);
        }
      }

      reportResult = await mergeReportResultWithCache(cache, reportResult);
      lastState = buildState(visible, reportResult);
      render(lastState);
      if (!force) {
        hasAutoLoaded = true;
      }
    } finally {
      isRefreshing = false;
    }
  }

  function findInsertionAnchor() {
    return (
      document.querySelector('[data-qa-id="tutor-performance-overview"]') ||
      document.querySelector('[data-qa-id="tutor-performance-page"]')
    );
  }

  function renderShell(anchor) {
    if (document.getElementById(ROOT_ID)) {
      return;
    }

    const root = document.createElement("section");
    root.id = ROOT_ID;
    root.className = "preply-plus";
    root.innerHTML = `
      <div class="pp-header">
        <div>
          <h2>Business-Kennzahlen</h2>
          <p id="pp-updated">Echtzeit-Kennzahlen werden geladen ...</p>
        </div>
        <div class="pp-actions">
          <button id="pp-clear-cache" type="button" title="Gespeicherte CSV-Daten löschen" aria-label="Gespeicherte CSV-Daten löschen">
            <span aria-hidden="true">⌫</span>
          </button>
          <button id="pp-refresh" type="button" title="Kennzahlen aktualisieren" aria-label="Kennzahlen aktualisieren">
            <span aria-hidden="true">↻</span>
          </button>
        </div>
      </div>
      <div id="pp-status" class="pp-status"></div>
      <div id="pp-content" class="pp-content" aria-live="polite"></div>
    `;

    anchor.insertAdjacentElement("afterend", root);
    root.querySelector("#pp-refresh").addEventListener("click", () => scheduleRefresh(0, { force: true }));
    root.querySelector("#pp-clear-cache").addEventListener("click", async () => {
      await clearTransactionCache();
      hasAutoLoaded = false;
      selectedMonthYear = null;
      setStatus("Gespeicherte CSV-Daten gelöscht. Lade Kennzahlen neu ...");
      scheduleRefresh(0, { force: true });
    });
  }

  function setStatus(text) {
    const node = document.getElementById("pp-status");
    if (node) {
      node.textContent = text;
    }
  }

  function requestReports() {
    const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const ranges = activeReportRanges;

    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        if (pendingRequest?.requestId === requestId) {
          pendingRequest = null;
        }
        reject(new Error("Preply report request timed out"));
      }, 20000);

      pendingRequest = {
        requestId,
        resolve: (value) => {
          window.clearTimeout(timeout);
          resolve(value);
        }
      };

      window.postMessage({ type: MESSAGE_REQUEST, requestId, ranges }, window.location.origin);
    });
  }

  async function requestReportsDirect(originalError) {
    const reports = [];
    const errors = [
      {
        id: "pageBridge",
        message: originalError instanceof Error ? originalError.message : String(originalError)
      }
    ];

    for (const range of activeReportRanges) {
      try {
        const url = new URL("/tutor/download-earnings-report", window.location.origin);
        url.searchParams.set("timestampStart", range.start);
        url.searchParams.set("timestampEnd", range.end);
        url.searchParams.set("format", "csv");

        const response = await fetch(url.toString(), {
          credentials: "include",
          headers: { Accept: "text/csv,application/csv,text/plain,*/*" }
        });
        const text = await response.text();

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${text.slice(0, 160)}`);
        }

        reports.push({
          id: range.id,
          start: range.start,
          end: range.end,
          contentType: response.headers.get("content-type") || "",
          text
        });
      } catch (error) {
        errors.push({
          id: range.id,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }

    return { reports, errors };
  }

  function buildRanges(cache) {
    const { today } = getDateBoundaries();
    const todayISO = toISODate(today);
    const cachedEnd = cache?.end || "";

    if (cachedEnd && cachedEnd >= todayISO) {
      return [];
    }

    return [
      { id: "sinceBeginning", start: cachedEnd || DEFAULT_HISTORY_START, end: todayISO }
    ];
  }

  function getDateBoundaries() {
    const today = startOfDay(new Date());
    return {
      today,
      currentMonthStart: new Date(today.getFullYear(), today.getMonth(), 1),
      previousMonthStart: new Date(today.getFullYear(), today.getMonth() - 1, 1),
      previousMonthEnd: new Date(today.getFullYear(), today.getMonth(), 0),
      yearStart: new Date(today.getFullYear(), 0, 1),
      trailingStart: new Date(today.getTime() - 365 * DAY_MS)
    };
  }

  function loadTransactionCache() {
    return new Promise((resolve) => {
      chrome.storage.local.get(CACHE_KEY, (result) => {
        const cache = result?.[CACHE_KEY];
        if (!cache || !Array.isArray(cache.transactions)) {
          resolve({ transactions: [], start: null, end: null, updatedAt: null });
          return;
        }

        resolve({
          start: cache.start || null,
          end: cache.end || null,
          updatedAt: cache.updatedAt || null,
          transactions: cache.transactions.map(deserializeTransaction).filter(Boolean)
        });
      });
    });
  }

  function saveTransactionCache(cache) {
    return new Promise((resolve) => {
      chrome.storage.local.set({
        [CACHE_KEY]: {
          start: cache.start,
          end: cache.end,
          updatedAt: cache.updatedAt,
          transactions: cache.transactions.map(serializeTransaction)
        }
      }, resolve);
    });
  }

  function clearTransactionCache() {
    return new Promise((resolve) => chrome.storage.local.remove(CACHE_KEY, resolve));
  }

  async function mergeReportResultWithCache(cache, reportResult) {
    const reports = (reportResult.reports || []).map(parseReport);
    const freshTransactions = reports.flatMap((report) => report.transactions);
    const mergedTransactions = dedupeTransactions([...(cache.transactions || []), ...freshTransactions]);
    const rangeStart = minISODate([cache.start, earliestTransactionDate(mergedTransactions)])
      || reports[0]?.start
      || DEFAULT_HISTORY_START;
    const rangeEnd = maxISODate([cache.end, ...reports.map((report) => report.end), latestTransactionDate(mergedTransactions)]);
    const mergedCache = {
      start: rangeStart,
      end: rangeEnd,
      updatedAt: new Date().toISOString(),
      transactions: mergedTransactions
    };

    if (freshTransactions.length || activeReportRanges.length) {
      await saveTransactionCache(mergedCache);
    }

    return {
      ...reportResult,
      parsedReports: reports,
      cachedTransactions: mergedTransactions,
      cacheRange: { start: mergedCache.start, end: mergedCache.end }
    };
  }

  function serializeTransaction(transaction) {
    return {
      amount: transaction.amount,
      student: transaction.student,
      date: transaction.date ? transaction.date.toISOString() : null,
      type: transaction.type,
      lessonCount: transaction.lessonCount,
      durationHours: transaction.durationHours,
      hasLessonCount: transaction.hasLessonCount,
      hasDuration: transaction.hasDuration,
      fingerprint: transaction.fingerprint
    };
  }

  function deserializeTransaction(transaction) {
    if (!transaction || typeof transaction !== "object") {
      return null;
    }

    return {
      ...transaction,
      date: transaction.date ? new Date(transaction.date) : null
    };
  }

  function dedupeTransactions(transactions) {
    const seen = new Set();
    const unique = [];

    for (const transaction of transactions) {
      const key = transactionKey(transaction);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      unique.push(transaction);
    }

    return unique.sort((a, b) => {
      const dateA = a.date ? a.date.getTime() : 0;
      const dateB = b.date ? b.date.getTime() : 0;
      return dateA - dateB;
    });
  }

  function transactionKey(transaction) {
    const rawValues = transaction.fingerprint || (transaction.raw ? Object.values(transaction.raw).join("|") : "");
    return [
      transaction.date ? transaction.date.toISOString() : "",
      transaction.student || "",
      transaction.type || "",
      transaction.amount || 0,
      transaction.lessonCount || 0,
      rawValues
    ].join("::");
  }

  function earliestTransactionDate(transactions) {
    return minISODate(transactions.map((transaction) => transaction.date && toISODate(transaction.date)));
  }

  function latestTransactionDate(transactions) {
    return maxISODate(transactions.map((transaction) => transaction.date && toISODate(transaction.date)));
  }

  function minISODate(values) {
    return values.filter(Boolean).sort()[0] || null;
  }

  function maxISODate(values) {
    return values.filter(Boolean).sort().at(-1) || null;
  }

  function scrapeVisibleMetrics() {
    return {
      overviewEarnings: parseMoney(primaryMetricText('[data-qa-id="overview-chip-earnings"]')),
      overviewLessons: parseNumber(primaryMetricText('[data-qa-id="overview-chip-lessons"]')),
      activeStudents: parseNumber(primaryMetricText('[data-qa-id="overview-chip-activeStudents"]')),
      newStudents: parseNumber(primaryMetricText('[data-qa-id="overview-chip-newStudents"]')),
      chartEarnings: parseMoney(textOf('[data-qa-id="earnings-amount"]')),
      totalEarnings: parseMoney(primaryMetricText('[data-qa-id="lifetime-performance-total-earnings"]')),
      lifetimeLessons: parseNumber(primaryMetricText('[data-qa-id="lifetime-performance-lessons-taught"]')),
      lifetimeHours: parseNumber(primaryMetricText('[data-qa-id="lifetime-performance-hours-taught"]')),
      lifetimeStudents: parseNumber(primaryMetricText('[data-qa-id="lifetime-performance-total-students"]'))
    };
  }

  function textOf(selector) {
    return document.querySelector(selector)?.textContent?.trim() || "";
  }

  function primaryMetricText(selector) {
    const root = document.querySelector(selector);
    if (!root) {
      return "";
    }

    return root.querySelector("h1, h2, h3, [data-preply-ds-component='Heading']")?.textContent?.trim() || root.textContent?.trim() || "";
  }

  function buildState(visible, reportResult) {
    const reports = Object.fromEntries(
      (reportResult.parsedReports || []).map((report) => [report.id, report])
    );

    const allTransactions = reportResult.cachedTransactions || reports.sinceBeginning?.transactions || [];
    const allTime = summarizeTransactions(allTransactions);
    const reportRange = reportResult.cacheRange || reports.sinceBeginning || activeReportRanges[0] || null;
    const boundaries = getDateBoundaries();
    const currentMonth = summarizeTransactions(filterTransactionsByDate(
      allTransactions,
      boundaries.currentMonthStart,
      boundaries.today
    ));
    const previousMonth = summarizeTransactions(filterTransactionsByDate(
      allTransactions,
      boundaries.previousMonthStart,
      boundaries.previousMonthEnd
    ));
    const yearToDate = summarizeTransactions(filterTransactionsByDate(
      allTransactions,
      boundaries.yearStart,
      boundaries.today
    ));
    const source = allTime.transactions.length ? "report" : "visible";
    const totalIncome = allTime.income || visible.totalEarnings || yearToDate.income || visible.chartEarnings || visible.overviewEarnings;
    const monthlyIncome = currentMonth.income || visible.chartEarnings || visible.overviewEarnings;
    const monthlyLessons = currentMonth.lessons || (source === "visible" ? visible.overviewLessons : 0);
    const activeStudents = visible.activeStudents || currentMonth.students || allTime.students;
    const projectedIncome = projectMonth(monthlyIncome);
    const monthlyHours = currentMonth.hours;
    const avgPayoutCurrentMonth = currentMonth.paidLessons ? currentMonth.income / currentMonth.paidLessons : 0;
    const avgPayoutAllTime = allTime.paidLessons ? allTime.income / allTime.paidLessons : 0;
    const avgHourlyRate = monthlyHours ? monthlyIncome / monthlyHours : 0;
    const topStudents = rankStudents(allTime.transactions.length ? allTime.transactions : currentMonth.transactions);
    const monthlyBreakdown = buildMonthlyBreakdown(allTransactions);
    const avgWeeklyHours = calculateAverageWeeklyHours(allTime.hours, reportRange);
    const avgWeeklyLessons = calculateAverageWeeklyLessons(allTime.lessons, reportRange);
    const avgMonthlyLessons = calculateAverageMonthlyLessons(monthlyBreakdown);

    return {
      visible,
      reports,
      errors: reportResult.errors || [],
      source,
      reportRange,
      updatedAt: new Date(),
      metrics: {
        monthlyIncome,
        previousMonthIncome: previousMonth.income,
        monthDelta: previousMonth.income ? (monthlyIncome - previousMonth.income) / previousMonth.income : null,
        projectedIncome,
        totalIncome,
        yearToDateIncome: yearToDate.income,
        avgPayoutCurrentMonth,
        avgPayoutAllTime,
        avgHourlyRate,
        monthlyHours,
        avgWeeklyHours,
        avgWeeklyLessons,
        avgMonthlyLessons,
        monthlyLessons,
        activeStudents,
        newStudents: visible.newStudents,
        lifetimeHours: visible.lifetimeHours,
        lifetimeLessons: visible.lifetimeLessons,
        lifetimeStudents: visible.lifetimeStudents || allTime.students,
        totalStudents: allTime.students || visible.lifetimeStudents
      },
      topStudents,
      monthlyBreakdown
    };
  }

  function parseReport(report) {
    const rows = parseCsv(report.text);
    const transactions = rows.map(normalizeRow).filter((row) => row.amount !== 0 || row.student || row.date);
    return { ...report, rows, transactions };
  }

  function parseCsv(text) {
    if (!text || /^\s*</.test(text)) {
      return [];
    }

    const delimiter = detectDelimiter(text);
    const rows = [];
    let current = "";
    let row = [];
    let quoted = false;

    for (let i = 0; i < text.length; i += 1) {
      const char = text[i];
      const next = text[i + 1];

      if (char === '"' && quoted && next === '"') {
        current += '"';
        i += 1;
      } else if (char === '"') {
        quoted = !quoted;
      } else if (char === delimiter && !quoted) {
        row.push(current);
        current = "";
      } else if ((char === "\n" || char === "\r") && !quoted) {
        if (char === "\r" && next === "\n") {
          i += 1;
        }
        row.push(current);
        if (row.some((cell) => cell.trim())) {
          rows.push(row);
        }
        row = [];
        current = "";
      } else {
        current += char;
      }
    }

    row.push(current);
    if (row.some((cell) => cell.trim())) {
      rows.push(row);
    }

    if (rows.length < 2) {
      return [];
    }

    const headers = rows[0].map((header) => header.trim());
    return rows.slice(1).map((cells) => {
      const object = {};
      headers.forEach((header, index) => {
        object[header || `column_${index + 1}`] = (cells[index] || "").trim();
      });
      return object;
    });
  }

  function detectDelimiter(text) {
    const firstLine = text.split(/\r?\n/, 1)[0] || "";
    const candidates = [",", ";", "\t"];
    return candidates
      .map((delimiter) => ({ delimiter, count: firstLine.split(delimiter).length }))
      .sort((a, b) => b.count - a.count)[0].delimiter;
  }

  function normalizeRow(row) {
    const entries = Object.entries(row);
    const amountEntry =
      findEntryByHeader(entries, /^(earning|einnahmen|verdienst|auszahlung|payout)(,|\s|$)/i) ||
      findEntryByHeader(entries, /(earning|einnahmen|verdienst|auszahlung|payout).*usd/i) ||
      findEntryByHeader(entries, /(amount|income|total|paid|betrag|einnah|umsatz|summe|wert)/i);
    const studentEntry = findEntryByHeader(entries, /(student|learner|pupil|name|lern|schuel|schül)/i);
    const dateEntry =
      findEntryByHeader(entries, /datum der einheit/i) ||
      findEntryByHeader(entries, /(lesson date|date of lesson|date|datum|time|zeit|created)/i);
    const typeEntry = findEntryByHeader(entries, /^(type|typ)$/i);
    const lessonEntry = findEntryByHeader(entries, /(lesson count|lessons|units|classes|einheiten|stunden|anzahl)/i);
    const durationEntry = findEntryByHeader(entries, /(duration|hour|hours|minutes|mins|dauer|minuten|stunden)/i);
    const lessonCount = parseLessonCount(lessonEntry?.[1] || "", Boolean(dateEntry || typeEntry));
    const durationHours = parseDurationHours(durationEntry?.[1] || "", lessonCount);
    const fingerprint = Object.values(row).join("|");

    return {
      amount: parseMoney(amountEntry?.[1] || ""),
      student: cleanStudentName(studentEntry?.[1] || ""),
      date: parseDate(dateEntry?.[1] || ""),
      type: typeEntry?.[1] || "",
      lessonCount,
      durationHours,
      hasLessonCount: lessonCount > 0,
      hasDuration: durationHours > 0,
      fingerprint,
      raw: row
    };
  }

  function findEntryByHeader(entries, pattern) {
    return entries.find(([key]) => pattern.test(key));
  }

  function cleanStudentName(value) {
    return value.replace(/\s+/g, " ").trim();
  }

  function summarizeTransactions(transactions) {
    const students = new Set();
    let income = 0;
    let lessons = 0;
    let hours = 0;
    let lessonRows = 0;
    let durationRows = 0;
    let paidLessons = 0;
    let paidTransactions = 0;

    for (const transaction of transactions) {
      income += transaction.amount;
      lessons += transaction.lessonCount;
      hours += transaction.durationHours;
      lessonRows += transaction.hasLessonCount ? 1 : 0;
      durationRows += transaction.hasDuration ? 1 : 0;
      paidTransactions += transaction.amount > 0 ? 1 : 0;
      paidLessons += transaction.amount > 0 ? transaction.lessonCount : 0;
      if (transaction.student) {
        students.add(transaction.student);
      }
    }

    return {
      income,
      lessons: lessonRows ? lessons : 0,
      hours: durationRows ? hours : 0,
      transactionCount: transactions.length,
      paidTransactions,
      paidLessons: lessonRows ? paidLessons : paidTransactions,
      students: students.size,
      transactions
    };
  }

  function filterTransactionsByDate(transactions, start, end) {
    return transactions.filter((transaction) => {
      if (!transaction.date) {
        return false;
      }

      const date = startOfDay(transaction.date);
      return date >= start && date <= end;
    });
  }

  function buildMonthlyBreakdown(transactions) {
    const months = new Map();

    for (const transaction of transactions) {
      if (!transaction.date) {
        continue;
      }

      const date = startOfDay(transaction.date);
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
      if (!months.has(key)) {
        months.set(key, {
          key,
          date: new Date(date.getFullYear(), date.getMonth(), 1),
          income: 0,
          lessons: 0,
          hours: 0,
          lessonRows: 0,
          durationRows: 0,
          paidTransactions: 0,
          paidLessons: 0,
          students: new Set(),
          transactions: 0
        });
      }

      const month = months.get(key);
      month.income += transaction.amount;
      month.lessons += transaction.lessonCount;
      month.hours += transaction.durationHours;
      month.lessonRows += transaction.hasLessonCount ? 1 : 0;
      month.durationRows += transaction.hasDuration ? 1 : 0;
      month.paidTransactions += transaction.amount > 0 ? 1 : 0;
      month.paidLessons += transaction.amount > 0 ? transaction.lessonCount : 0;
      month.transactions += 1;
      if (transaction.student) {
        month.students.add(transaction.student);
      }
    }

    return [...months.values()]
      .map((month) => {
        const lessons = month.lessonRows ? month.lessons : 0;
        const hours = month.durationRows ? month.hours : 0;
        return {
          ...month,
          lessons,
          hours,
          activeStudents: month.students.size,
          bookingRate: month.paidTransactions ? month.income / month.paidTransactions : 0,
          hourlyRate: hours ? month.income / hours : 0,
          lessonRate: month.paidLessons ? month.income / month.paidLessons : 0
        };
      })
      .sort((a, b) => b.date - a.date);
  }

  function rankStudents(transactions) {
    const ranking = new Map();

    for (const transaction of transactions) {
      const student = transaction.student || "Unbekannt";
      if (!ranking.has(student)) {
        ranking.set(student, {
          student,
          income: 0,
          lessons: 0,
          hours: 0,
          lessonRows: 0,
          durationRows: 0,
          paidTransactions: 0,
          paidLessons: 0,
          transactions: 0
        });
      }
      const item = ranking.get(student);
      item.income += transaction.amount;
      item.lessons += transaction.lessonCount;
      item.hours += transaction.durationHours;
      item.lessonRows += transaction.hasLessonCount ? 1 : 0;
      item.durationRows += transaction.hasDuration ? 1 : 0;
      item.paidTransactions += transaction.amount > 0 ? 1 : 0;
      item.paidLessons += transaction.amount > 0 ? transaction.lessonCount : 0;
      item.transactions += 1;
    }

    return [...ranking.values()]
      .filter((item) => item.income > 0)
      .map((item) => {
        const lessons = item.lessonRows ? item.lessons : 0;
        const hours = item.durationRows ? item.hours : 0;
        return {
          ...item,
          lessons,
          hours,
          bookingRate: item.paidTransactions ? item.income / item.paidTransactions : 0,
          hourlyRate: hours ? item.income / hours : 0,
          lessonRate: item.paidLessons ? item.income / item.paidLessons : 0
        };
      })
      .sort((a, b) => b.income - a.income)
      .slice(0, 10);
  }

  function render(state) {
    const updated = document.getElementById("pp-updated");
    const status = document.getElementById("pp-status");
    const content = document.getElementById("pp-content");

    if (!updated || !status || !content) {
      return;
    }

    updated.textContent = `Echtzeit-Kennzahlen aktualisiert: ${dateFormatter.format(state.updatedAt)}, ${timeFormatter.format(state.updatedAt)} Uhr.`;
    status.textContent = state.source === "report"
      ? `Datenquelle: CSV-Einnahmenbericht ${formatISODate(state.reportRange.start)} - ${formatISODate(state.reportRange.end)}.`
      : "Datenquelle: sichtbare Preply-Kennzahlen. Der CSV-Bericht konnte noch nicht gelesen werden.";

    content.innerHTML = `
      <div class="pp-grid">
        ${metricCard("Einnahmen gesamt", money(state.metrics.totalIncome), "seit Beginn")}
        ${metricCard("Ø Auszahlung", money(state.metrics.avgPayoutCurrentMonth), "pro bezahlter Einheit im aktuellen Monat")}
        ${metricCard("Ø Auszahlung", money(state.metrics.avgPayoutAllTime), "pro bezahlter Einheit seit Beginn")}
        ${metricCard("Prognose Monat", money(state.metrics.projectedIncome), "hochgerechnet bis Monatsende")}
        ${metricCard("Monatseinnahmen", money(state.metrics.monthlyIncome), deltaText(state.metrics.monthDelta))}
      </div>
      <div class="pp-panel pp-wide-panel">
        <div class="pp-panel-heading">
          <h3>Monatseinnahmen</h3>
          ${renderMonthPager(state.monthlyBreakdown)}
        </div>
        ${renderMonthlyBreakdown(state.monthlyBreakdown)}
      </div>
      <div class="pp-split">
        <div class="pp-panel">
          <h3>Student Benchmarking</h3>
          ${renderStudentTable(state.topStudents)}
        </div>
        <div class="pp-panel">
          <h3>Weitere Kennzahlen</h3>
          <div class="pp-insights">
            ${state.metrics.avgWeeklyHours
              ? insight("Ø Wochenstunden", `${number(state.metrics.avgWeeklyHours)} h`, "seit Beginn")
              : insight("Ø Einheiten/Woche", number(state.metrics.avgWeeklyLessons), "seit Beginn")}
            ${insight("Schüler insgesamt", number(state.metrics.totalStudents), "seit Beginn")}
            ${insight("Aktive Schüler", number(state.metrics.activeStudents), "aktuell")}
            ${insight("Ø Einheiten pro Monat", number(state.metrics.avgMonthlyLessons), "seit Beginn")}
          </div>
        </div>
      </div>
      ${state.errors.length ? `<details class="pp-debug"><summary>Hinweise zur Datenerfassung</summary><pre>${escapeHtml(JSON.stringify(state.errors, null, 2))}</pre></details>` : ""}
    `;
    bindMonthPager();
  }

  function renderMonthPager(months) {
    const years = getAvailableYears(months);
    if (years.length <= 1) {
      return "";
    }

    const selectedYear = getSelectedMonthYear(months);
    const index = years.indexOf(selectedYear);
    const canGoNewer = index > 0;
    const canGoOlder = index < years.length - 1;

    return `
      <div class="pp-pager" aria-label="Jahr auswählen">
        <button id="pp-month-older" type="button" title="Älteres Jahr" aria-label="Älteres Jahr" ${canGoOlder ? "" : "disabled"}>
          <span aria-hidden="true">‹</span>
        </button>
        <span>${selectedYear}</span>
        <button id="pp-month-newer" type="button" title="Neueres Jahr" aria-label="Neueres Jahr" ${canGoNewer ? "" : "disabled"}>
          <span aria-hidden="true">›</span>
        </button>
      </div>
    `;
  }

  function bindMonthPager() {
    const newer = document.getElementById("pp-month-newer");
    const older = document.getElementById("pp-month-older");

    newer?.addEventListener("click", () => shiftSelectedMonthYear(-1));
    older?.addEventListener("click", () => shiftSelectedMonthYear(1));
  }

  function shiftSelectedMonthYear(direction) {
    if (!lastState) {
      return;
    }

    const years = getAvailableYears(lastState.monthlyBreakdown);
    const selectedYear = getSelectedMonthYear(lastState.monthlyBreakdown);
    const index = years.indexOf(selectedYear);
    const nextYear = years[index + direction];

    if (!nextYear) {
      return;
    }

    selectedMonthYear = nextYear;
    render(lastState);
  }

  function renderMonthlyBreakdown(months) {
    if (!months.length) {
      return `<p class="pp-empty">Noch keine Monatsaufschlüsselung verfügbar. Dafür braucht die CSV mindestens ein Datumsfeld und eine Einnahmenspalte.</p>`;
    }

    const selectedYear = getSelectedMonthYear(months);
    const yearMonths = months
      .filter((month) => month.date.getFullYear() === selectedYear)
      .sort((a, b) => a.date - b.date);
    const summary = summarizeMonths(yearMonths);
    const hasHours = yearMonths.some((month) => month.hours > 0);

    return `
      <table class="pp-table pp-month-table">
        <thead>
          <tr>
            <th>Monat</th>
            <th>Einnahmen</th>
            <th>Einheiten</th>
            ${hasHours ? "<th>Stunden</th><th>Ø Stunde</th>" : ""}
            <th>Anteil</th>
            <th>Ø Auszahlung</th>
          </tr>
        </thead>
        <tbody>
          ${yearMonths.map((month) => `
            <tr>
              <td>${escapeHtml(formatMonth(month.date))}</td>
              <td>${money(month.income)}</td>
              <td>${number(month.lessons || month.transactions)}</td>
              ${hasHours ? `<td>${number(month.hours)}</td><td>${rateOrNA(month.hourlyRate)}</td>` : ""}
              <td>${formatPercent(summary.income ? month.income / summary.income : 0)}</td>
              <td>${rateOrNA(month.lessonRate || month.bookingRate)}</td>
            </tr>
          `).join("")}
          <tr class="pp-summary-row">
            <td>Durchschnitt</td>
            <td>${money(summary.avgIncome)}</td>
            <td>${number(summary.avgLessons)}</td>
            ${hasHours ? `<td>${number(summary.avgHours)}</td><td>${rateOrNA(summary.avgHourlyRate)}</td>` : ""}
            <td>${summary.monthCount ? formatPercent(1 / summary.monthCount) : "0%"}</td>
            <td>${rateOrNA(summary.avgPayout)}</td>
          </tr>
        </tbody>
      </table>
    `;
  }

  function summarizeMonths(months) {
    const monthCount = months.length;
    const income = months.reduce((total, month) => total + month.income, 0);
    const transactions = months.reduce((total, month) => total + month.transactions, 0);
    const lessons = months.reduce((total, month) => total + (month.lessons || month.transactions), 0);
    const paidLessons = months.reduce((total, month) => total + month.paidLessons, 0);
    const paidTransactions = months.reduce((total, month) => total + month.paidTransactions, 0);
    const hours = months.reduce((total, month) => total + month.hours, 0);

    return {
      monthCount,
      income,
      avgIncome: monthCount ? income / monthCount : 0,
      avgTransactions: monthCount ? transactions / monthCount : 0,
      avgLessons: monthCount ? lessons / monthCount : 0,
      avgHours: monthCount ? hours / monthCount : 0,
      avgHourlyRate: hours ? income / hours : 0,
      avgPayout: paidLessons ? income / paidLessons : paidTransactions ? income / paidTransactions : 0
    };
  }

  function getAvailableYears(months) {
    return [...new Set(months.map((month) => month.date.getFullYear()))].sort((a, b) => b - a);
  }

  function getSelectedMonthYear(months) {
    const years = getAvailableYears(months);
    if (!years.length) {
      return new Date().getFullYear();
    }

    if (!selectedMonthYear || !years.includes(selectedMonthYear)) {
      selectedMonthYear = years[0];
    }

    return selectedMonthYear;
  }

  function calculateAverageWeeklyHours(hours, range) {
    if (!hours || !range?.start || !range?.end) {
      return 0;
    }

    const start = parseISODate(range.start);
    const end = parseISODate(range.end);
    if (!start || !end || end < start) {
      return 0;
    }

    const weeks = Math.max(1, ((end - start) / DAY_MS + 1) / 7);
    return hours / weeks;
  }

  function calculateAverageWeeklyLessons(lessons, range) {
    if (!lessons || !range?.start || !range?.end) {
      return 0;
    }

    const start = parseISODate(range.start);
    const end = parseISODate(range.end);
    if (!start || !end || end < start) {
      return 0;
    }

    const weeks = Math.max(1, ((end - start) / DAY_MS + 1) / 7);
    return lessons / weeks;
  }

  function calculateAverageMonthlyLessons(months) {
    if (!months.length) {
      return 0;
    }

    const totalLessons = months.reduce((total, month) => total + (month.lessons || month.transactions), 0);
    return totalLessons / months.length;
  }

  function metricCard(label, value, detail) {
    return `
      <article class="pp-card">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(value)}</strong>
        <small>${escapeHtml(detail || "")}</small>
      </article>
    `;
  }

  function renderStudentTable(students) {
    if (!students.length) {
      return `<p class="pp-empty">Noch keine Studentendaten gefunden. Öffne einmal den Einnahmenbericht als CSV oder prüfe im Debug-Hinweis, ob Preply die Spaltennamen geändert hat.</p>`;
    }

    const hasHours = students.some((student) => student.hours > 0);

    return `
      <table class="pp-table">
        <thead>
          <tr>
            <th>Rang</th>
            <th>Lernende</th>
            <th>Einnahmen</th>
            <th>Einheiten</th>
            ${hasHours ? "<th>Stunden</th><th>Ø Stunde</th>" : ""}
            <th>Ø Auszahlung</th>
          </tr>
        </thead>
        <tbody>
          ${students.map((student, index) => `
            <tr>
              <td>${index + 1}</td>
              <td>${escapeHtml(student.student)}</td>
              <td>${money(student.income)}</td>
              <td>${number(student.lessons || student.transactions)}</td>
              ${hasHours ? `<td>${number(student.hours)}</td><td>${rateOrNA(student.hourlyRate)}</td>` : ""}
              <td>${rateOrNA(student.lessonRate || student.bookingRate)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `;
  }

  function insight(label, value, detail = "") {
    return `
      <div class="pp-insight">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(String(value || "n/a"))}</strong>
        <small>${escapeHtml(detail)}</small>
      </div>
    `;
  }

  function projectMonth(currentIncome) {
    const today = new Date();
    const day = today.getDate();
    const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
    return day ? (currentIncome / day) * daysInMonth : currentIncome;
  }

  function deltaText(delta) {
    if (delta === null || Number.isNaN(delta)) {
      return "kein Vormonat zum Vergleich";
    }
    const percent = Math.round(delta * 100);
    return `${percent >= 0 ? "+" : ""}${percent}% vs. Vormonat`;
  }

  function parseMoney(value) {
    if (!value) {
      return 0;
    }

    const match = String(value).replace(/\s/g, "").match(/-?[\d.,]+/);
    if (!match) {
      return 0;
    }

    const raw = match[0];
    const commaIndex = raw.lastIndexOf(",");
    const dotIndex = raw.lastIndexOf(".");
    let decimalSeparator = commaIndex > dotIndex ? "," : ".";

    if (commaIndex === -1 && dotIndex !== -1 && /^\d+\.\d{3}$/.test(raw)) {
      decimalSeparator = "";
    }
    if (dotIndex === -1 && commaIndex !== -1 && /^\d+,\d{3}$/.test(raw)) {
      decimalSeparator = "";
    }

    if (!decimalSeparator) {
      return Number.parseFloat(raw.replace(/[.,]/g, "")) || 0;
    }

    const normalized = raw
      .replace(new RegExp(`\\${decimalSeparator === "," ? "." : ","}`, "g"), "")
      .replace(decimalSeparator, ".");

    return Number.parseFloat(normalized) || 0;
  }

  function parseNumber(value) {
    if (!value) {
      return 0;
    }
    const match = String(value).replace(/\s/g, "").match(/-?[\d.,]+/);
    if (!match) {
      return 0;
    }
    return Number.parseFloat(match[0].replace(",", ".")) || 0;
  }

  function parseLessonCount(value, hasLessonRow = false) {
    if (!value) {
      return hasLessonRow ? 1 : 0;
    }

    const number = parseNumber(value);
    return number > 0 && number < 100 ? number : hasLessonRow ? 1 : 0;
  }

  function parseDurationHours(value, lessonCount) {
    if (!value) {
      return 0;
    }

    const text = String(value).toLowerCase();
    const number = parseNumber(text);
    if (!number) {
      return 0;
    }

    if (/min|minute|minuten/.test(text)) {
      return number / 60;
    }

    if (/hour|hours|std|stunde|stunden|h\b/.test(text)) {
      return number;
    }

    return number > 10 ? number / 60 : number;
  }

  function parseDate(value) {
    if (!value) {
      return null;
    }

    const germanMatch = String(value).trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (germanMatch) {
      return new Date(
        Number(germanMatch[3]),
        Number(germanMatch[2]) - 1,
        Number(germanMatch[1])
      );
    }

    const isoDateTimeMatch = String(value).trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (isoDateTimeMatch) {
      return new Date(
        Number(isoDateTimeMatch[1]),
        Number(isoDateTimeMatch[2]) - 1,
        Number(isoDateTimeMatch[3]),
        Number(isoDateTimeMatch[4] || 0),
        Number(isoDateTimeMatch[5] || 0),
        Number(isoDateTimeMatch[6] || 0)
      );
    }

    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  function money(value) {
    return moneyFormatter.format(value || 0);
  }

  function rateOrNA(value) {
    return value ? money(value) : "n/a";
  }

  function number(value) {
    return numberFormatter.format(value || 0);
  }

  function formatMonth(date) {
    return monthFormatter.format(date).replace(".", "");
  }

  function formatISODate(value) {
    if (!value) {
      return "unbekannt";
    }

    const date = parseISODate(value);
    if (!date) {
      return value;
    }

    return fullDateFormatter.format(date);
  }

  function parseISODate(value) {
    const [year, month, day] = value.split("-").map(Number);
    if (!year || !month || !day) {
      return null;
    }

    return new Date(year, month - 1, day);
  }

  function formatPercent(value) {
    if (!value) {
      return "0%";
    }

    return `${Math.round(value * 100)}%`;
  }

  function startOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }

  function toISODate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  boot();
})();
