(() => {
  const ROOT_ID = "preply-plus-root";
  const MESSAGE_REQUEST = "PREPLY_PLUS_FETCH_REPORTS";
  const MESSAGE_RESPONSE = "PREPLY_PLUS_REPORTS_RESULT";
  const DAY_MS = 24 * 60 * 60 * 1000;

  let lastState = null;
  let pendingRequest = null;
  let refreshTimer = null;
  let hasAutoLoaded = false;
  let isRefreshing = false;
  let selectedMonthYear = null;

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
      let reportResult = null;

      try {
        reportResult = await requestReports();
      } catch (error) {
        reportResult = await requestReportsDirect(error);
      }

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
        <button id="pp-refresh" type="button" title="Kennzahlen aktualisieren" aria-label="Kennzahlen aktualisieren">
          <span aria-hidden="true">↻</span>
        </button>
      </div>
      <div id="pp-status" class="pp-status"></div>
      <div id="pp-content" class="pp-content" aria-live="polite"></div>
    `;

    anchor.insertAdjacentElement("afterend", root);
    root.querySelector("#pp-refresh").addEventListener("click", () => scheduleRefresh(0, { force: true }));
  }

  function setStatus(text) {
    const node = document.getElementById("pp-status");
    if (node) {
      node.textContent = text;
    }
  }

  function requestReports() {
    const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const ranges = buildRanges();

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

    for (const range of buildRanges()) {
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

  function buildRanges() {
    const { today, trailingStart } = getDateBoundaries();

    return [
      { id: "trailingYear", start: toISODate(trailingStart), end: toISODate(today) }
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
      (reportResult.reports || []).map((report) => [report.id, parseReport(report)])
    );

    const trailingYear = summarizeTransactions(reports.trailingYear?.transactions || []);
    const reportRange = reports.trailingYear
      ? { start: reports.trailingYear.start, end: reports.trailingYear.end }
      : buildRanges()[0];
    const boundaries = getDateBoundaries();
    const trailingTransactions = reports.trailingYear?.transactions || [];
    const currentMonth = summarizeTransactions(filterTransactionsByDate(
      trailingTransactions,
      boundaries.currentMonthStart,
      boundaries.today
    ));
    const previousMonth = summarizeTransactions(filterTransactionsByDate(
      trailingTransactions,
      boundaries.previousMonthStart,
      boundaries.previousMonthEnd
    ));
    const yearToDate = summarizeTransactions(filterTransactionsByDate(
      trailingTransactions,
      boundaries.yearStart,
      boundaries.today
    ));
    const source = trailingYear.transactions.length ? "report" : "visible";
    const totalIncome = visible.totalEarnings || trailingYear.income || yearToDate.income || visible.chartEarnings || visible.overviewEarnings;
    const monthlyIncome = currentMonth.income || visible.chartEarnings || visible.overviewEarnings;
    const monthlyLessons = currentMonth.lessons || (source === "visible" ? visible.overviewLessons : 0);
    const activeStudents = visible.activeStudents || currentMonth.students || trailingYear.students;
    const projectedIncome = projectMonth(monthlyIncome);
    const monthlyHours = currentMonth.hours;
    const avgPerLesson = monthlyLessons ? monthlyIncome / monthlyLessons : 0;
    const avgHourlyRate = monthlyHours ? monthlyIncome / monthlyHours : 0;
    const topStudents = rankStudents(trailingYear.transactions.length ? trailingYear.transactions : currentMonth.transactions);
    const monthlyBreakdown = buildMonthlyBreakdown(trailingTransactions);
    const studentAnalysis = analyzeStudents(trailingTransactions);
    const pricePointStats = buildPricePointStats(studentAnalysis.students);
    const avgWeeklyHours = calculateAverageWeeklyHours(trailingYear.hours, reportRange);
    const avgWeeklyLessons = calculateAverageWeeklyLessons(trailingYear.lessons, reportRange);
    const avgMonthlyBookings = calculateAverageMonthlyBookings(monthlyBreakdown);

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
        avgPerLesson,
        avgHourlyRate,
        monthlyHours,
        avgWeeklyHours,
        avgWeeklyLessons,
        avgMonthlyBookings,
        monthlyLessons,
        activeStudents,
        newStudents: visible.newStudents,
        lifetimeHours: visible.lifetimeHours,
        lifetimeLessons: visible.lifetimeLessons,
        lifetimeStudents: visible.lifetimeStudents
      },
      topStudents,
      studentAnalysis,
      pricePointStats,
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
    const lessonPriceEntry = findEntryByHeader(entries, /(lesson price|price per lesson|price.*lesson|lesson.*price)/i);
    const confirmationDateEntry = findEntryByHeader(entries, /(confirmation date|bestätigung|bestätigungsdatum|confirmed at|confirmed on)/i);
    const lessonCount = parseLessonCount(lessonEntry?.[1] || "", Boolean(dateEntry || typeEntry));
    const durationHours = parseDurationHours(durationEntry?.[1] || "", lessonCount);
    const lessonPrice = parseLessonPrice(lessonPriceEntry?.[1] || "");
    const kind = normalizeTransactionKind(typeEntry?.[1] || "", lessonPrice, amountEntry?.[1] || "");

    return {
      amount: parseMoney(amountEntry?.[1] || ""),
      student: cleanStudentName(studentEntry?.[1] || ""),
      date: parseDate(dateEntry?.[1] || ""),
      type: typeEntry?.[1] || "",
      kind,
      lessonCount,
      durationHours,
      lessonPrice,
      confirmationDate: parseDate(confirmationDateEntry?.[1] || ""),
      hasLessonCount: lessonCount > 0,
      hasDuration: durationHours > 0,
      raw: row
    };
  }

  function normalizeTransactionKind(type, lessonPrice, amountValue) {
    const text = String(type || "").trim().toLowerCase();
    if (/unused lesson/i.test(type) || /unused/i.test(text)) {
      return "unused";
    }
    if (/trial/i.test(type) || /probefahrt|probe.*lesson|probe/i.test(text)) {
      return "trial";
    }
    if (/non[- ]trial|lesson/i.test(text) || (lessonPrice > 0 && /lesson/i.test(type))) {
      return "paid";
    }
    const amount = parseMoney(amountValue);
    if (amount > 0) {
      return "paid";
    }
    return "other";
  }

  function parseLessonPrice(value) {
    if (!value) {
      return 0;
    }

    const amount = parseNumber(value);
    if (!amount) {
      return 0;
    }

    if (amount >= 1000 && amount % 100 === 0) {
      return amount / 100;
    }

    return amount;
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

    for (const transaction of transactions) {
      income += transaction.amount;
      lessons += transaction.lessonCount;
      hours += transaction.durationHours;
      lessonRows += transaction.hasLessonCount ? 1 : 0;
      durationRows += transaction.hasDuration ? 1 : 0;
      if (transaction.student) {
        students.add(transaction.student);
      }
    }

    return {
      income,
      lessons: lessonRows ? lessons : 0,
      hours: durationRows ? hours : 0,
      transactionCount: transactions.length,
      students: students.size,
      transactions
    };
  }

  function analyzeStudents(transactions) {
    const students = new Map();
    const today = startOfDay(new Date());

    for (const transaction of transactions) {
      const name = transaction.student || "Unbekannt";
      if (!students.has(name)) {
        students.set(name, {
          student: name,
          income: 0,
          paidLessons: 0,
          trialLessons: 0,
          unusedLessons: 0,
          pipelineValue: 0,
          paidTransactions: 0,
          trialTransactions: 0,
          unusedTransactions: 0,
          transactionCount: 0,
          firstLessonDate: null,
          firstPaidDate: null,
          lastPaidDate: null,
          lastLessonDate: null,
          latestPaidPrice: 0,
          latestPaidPriceDate: null,
          lessonPriceObservations: []
        });
      }

      const student = students.get(name);
      student.transactionCount += 1;

      if (transaction.date) {
        if (!student.firstLessonDate || transaction.date < student.firstLessonDate) {
          student.firstLessonDate = transaction.date;
        }
        if (!student.lastLessonDate || transaction.date > student.lastLessonDate) {
          student.lastLessonDate = transaction.date;
        }
      }

      if (transaction.kind === "trial") {
        student.trialTransactions += 1;
        student.trialLessons += transaction.lessonCount;
      }

      if (transaction.kind === "paid") {
        student.paidTransactions += 1;
        student.paidLessons += transaction.lessonCount;
        student.income += transaction.amount;

        if (!student.firstPaidDate || (transaction.date && transaction.date < student.firstPaidDate)) {
          student.firstPaidDate = transaction.date;
        }
        if (!student.lastPaidDate || (transaction.date && transaction.date > student.lastPaidDate)) {
          student.lastPaidDate = transaction.date;
        }

        const price = transaction.lessonPrice || (transaction.lessonCount ? transaction.amount / transaction.lessonCount : 0);
        if (price > 0) {
          student.lessonPriceObservations.push({ price, date: transaction.date });
          if (!student.latestPaidPriceDate || (transaction.date && transaction.date > student.latestPaidPriceDate)) {
            student.latestPaidPriceDate = transaction.date;
            student.latestPaidPrice = price;
          }
        }
      }

      if (transaction.kind === "unused") {
        student.unusedTransactions += 1;
        student.unusedLessons += transaction.lessonCount;
        student.pipelineValue += transaction.lessonPrice * transaction.lessonCount || 0;
      }
    }

    let totalTrialStudents = 0;
    let convertedStudents = 0;
    let totalUnusedLessons = 0;
    let totalPipelineValue = 0;

    const studentSummaries = [...students.values()].map((student) => {
      student.hasPaid = student.paidTransactions > 0;
      student.converted = student.trialTransactions > 0 && student.hasPaid;
      student.trialConversion = student.trialTransactions ? (student.converted ? 1 : 0) : null;
      student.currentPricePoint = student.latestPaidPrice || (student.paidLessons ? student.income / student.paidLessons : 0);
      student.studentSince = student.firstLessonDate;
      student.lastActiveDate = student.lastLessonDate;
      const daysSinceLastPaid = student.lastPaidDate ? Math.round((today - startOfDay(student.lastPaidDate)) / DAY_MS) : null;
      if (!student.hasPaid) {
        student.churnRisk = student.trialTransactions ? "unsicher" : "neue/inaktive";
      } else if (daysSinceLastPaid === null) {
        student.churnRisk = "unbekannt";
      } else if (daysSinceLastPaid > 90) {
        student.churnRisk = "hoch";
      } else if (daysSinceLastPaid > 60) {
        student.churnRisk = "mittel";
      } else {
        student.churnRisk = "niedrig";
      }
      const isActive = student.lastLessonDate && (today - startOfDay(student.lastLessonDate)) / DAY_MS <= 60;
      student.priceIncreaseRecommendation = null;
      student.priceIncreaseTarget = null;
      const roundedPrice = Math.round(student.currentPricePoint);
      if (isActive && student.hasPaid && (today - startOfDay(student.studentSince || today)) / DAY_MS > 30) {
        if (roundedPrice === 19 && student.paidLessons >= 8) {
          student.priceIncreaseRecommendation = "Erhöhe auf $23";
          student.priceIncreaseTarget = 23;
        } else if (roundedPrice === 23 && student.paidLessons >= 10 && student.paidLessons <= 12) {
          student.priceIncreaseRecommendation = "Erhöhe auf $25";
          student.priceIncreaseTarget = 25;
        } else if (roundedPrice === 25 && student.paidLessons >= 12 && student.paidLessons <= 15) {
          student.priceIncreaseRecommendation = "Erhöhe auf $27";
          student.priceIncreaseTarget = 27;
        }
      }

      if (student.trialTransactions) {
        totalTrialStudents += 1;
        if (student.converted) {
          convertedStudents += 1;
        }
      }

      totalUnusedLessons += student.unusedLessons;
      totalPipelineValue += student.pipelineValue;
      return student;
    });

    const churnRiskCounts = studentSummaries.reduce(
      (counts, student) => {
        counts[student.churnRisk] = (counts[student.churnRisk] || 0) + 1;
        return counts;
      },
      { niedrig: 0, mittel: 0, hoch: 0, unsicher: 0, "neue/inaktive": 0, unbekannt: 0 }
    );

    return {
      students: studentSummaries.sort((a, b) => b.income - a.income),
      trialStudents: totalTrialStudents,
      convertedStudents,
      trialConversion: totalTrialStudents ? convertedStudents / totalTrialStudents : 0,
      unusedLessons: totalUnusedLessons,
      pipelineValue: totalPipelineValue,
      churnRiskCounts,
      priceRecommendations: studentSummaries.filter((student) => student.priceIncreaseRecommendation)
    };
  }

  function buildPricePointStats(students) {
    const points = new Map();

    for (const student of students) {
      const key = student.currentPricePoint ? String(Math.round(student.currentPricePoint)) : "unbekannt";
      if (!points.has(key)) {
        points.set(key, {
          pricePoint: key,
          studentCount: 0,
          income: 0,
          paidLessons: 0
        });
      }
      const item = points.get(key);
      item.studentCount += 1;
      item.income += student.income;
      item.paidLessons += student.paidLessons;
    }

    return [...points.values()].sort((a, b) => Number(b.pricePoint) - Number(a.pricePoint));
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
      .sort((a, b) => b.date - a.date)
      .slice(0, 12);
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
      ? `Datenquelle: automatisch geladener CSV-Einnahmenbericht (${formatISODate(state.reportRange.start)} - ${formatISODate(state.reportRange.end)}).`
      : "Datenquelle: sichtbare Preply-Kennzahlen. Der CSV-Bericht konnte noch nicht gelesen werden.";

    content.innerHTML = `
      <div class="pp-grid">
        ${metricCard("Monatseinnahmen", money(state.metrics.monthlyIncome), deltaText(state.metrics.monthDelta))}
        ${metricCard("Prognose Monat", money(state.metrics.projectedIncome), "hochgerechnet bis Monatsende")}
        ${metricCard("Einnahmen gesamt", money(state.metrics.totalIncome), state.metrics.yearToDateIncome ? `${money(state.metrics.yearToDateIncome)} seit Jahresbeginn` : "aus Preply-Lifetime-Kachel")}
        ${state.metrics.avgHourlyRate
          ? metricCard("Stundensatz", money(state.metrics.avgHourlyRate), `${number(state.metrics.monthlyHours)} h im Monat`)
          : metricCard("Ø Auszahlung", money(calculateCurrentMonthBookingRate(state.monthlyBreakdown)), "pro bezahlter Einheit im aktuellen Monat")}
        ${metricCard("Trial → Paid", state.studentAnalysis.trialStudents ? formatPercent(state.studentAnalysis.trialConversion) : "n/a", `${state.studentAnalysis.convertedStudents}/${state.studentAnalysis.trialStudents}`)}
        ${metricCard("Pipeline-Wert", money(state.studentAnalysis.pipelineValue), `${number(state.studentAnalysis.unusedLessons)} ungenutzte Einheiten`)}
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
              ? insight("Ø Wochenstunden", `${number(state.metrics.avgWeeklyHours)} h`, "im geladenen CSV-Zeitraum")
              : insight("Ø Einheiten/Woche", number(state.metrics.avgWeeklyLessons), "im geladenen CSV-Zeitraum")}
            ${insight("Schüler insgesamt", number(state.metrics.lifetimeStudents), "seit Start auf Preply")}
            ${insight("Aktive Schüler", number(state.metrics.activeStudents), "aktuell")}
            ${insight("Ø Buchungen/Monat", number(state.metrics.avgMonthlyBookings), "im geladenen CSV-Zeitraum")}
            ${insight("Churn-Risiko hoch/mittel", `${state.studentAnalysis.churnRiskCounts.hoch}/${state.studentAnalysis.churnRiskCounts.mittel}`, "letzte 60/90 Tage")}
          </div>
        </div>
      </div>
      <div class="pp-split">
        <div class="pp-panel pp-wide-panel">
          <h3>Preispoint-Analyse</h3>
          ${renderPricePointTable(state.pricePointStats)}
        </div>
      </div>
      <div class="pp-panel pp-wide-panel">
        <h3>Empfohlene Preiserhöhungen</h3>
        ${renderRecommendationTable(state.studentAnalysis.priceRecommendations)}
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
              <td>${number(month.transactions)}</td>
              ${hasHours ? `<td>${number(month.hours)}</td><td>${rateOrNA(month.hourlyRate)}</td>` : ""}
              <td>${formatPercent(summary.income ? month.income / summary.income : 0)}</td>
              <td>${rateOrNA(month.lessonRate || month.bookingRate)}</td>
            </tr>
          `).join("")}
          <tr class="pp-summary-row">
            <td>Durchschnitt</td>
            <td>${money(summary.avgIncome)}</td>
            <td>${number(summary.avgTransactions)}</td>
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
    const paidLessons = months.reduce((total, month) => total + month.paidLessons, 0);
    const paidTransactions = months.reduce((total, month) => total + month.paidTransactions, 0);
    const hours = months.reduce((total, month) => total + month.hours, 0);

    return {
      monthCount,
      income,
      avgIncome: monthCount ? income / monthCount : 0,
      avgTransactions: monthCount ? transactions / monthCount : 0,
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

  function calculateAverageMonthlyBookings(months) {
    if (!months.length) {
      return 0;
    }

    const totalBookings = months.reduce((total, month) => total + month.transactions, 0);
    return totalBookings / months.length;
  }

  function calculateCurrentMonthBookingRate(months) {
    return months[0]?.bookingRate || 0;
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

    const hasLessons = students.some((student) => student.lessons > 0);
    const hasHours = students.some((student) => student.hours > 0);

    return `
      <table class="pp-table">
        <thead>
          <tr>
            <th>Rang</th>
            <th>Lernende</th>
            <th>Einnahmen</th>
            <th>Buchungen</th>
            ${hasLessons ? "<th>Einheiten</th>" : ""}
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
              <td>${number(student.transactions)}</td>
              ${hasLessons ? `<td>${number(student.lessons)}</td>` : ""}
              ${hasHours ? `<td>${number(student.hours)}</td><td>${rateOrNA(student.hourlyRate)}</td>` : ""}
              <td>${rateOrNA(student.lessonRate || student.bookingRate)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `;
  }

  function renderPricePointTable(points) {
    if (!points.length) {
      return `<p class="pp-empty">Keine Preispoint-Daten gefunden. Die CSV braucht dafür mindestens eine Lesson Price- oder Lesson Amount-Spalte.</p>`;
    }

    return `
      <table class="pp-table">
        <thead>
          <tr>
            <th>Preispoint</th>
            <th>Schüler</th>
            <th>Einnahmen</th>
            <th>Bezahlte Einheiten</th>
          </tr>
        </thead>
        <tbody>
          ${points.map((point) => `
            <tr>
              <td>${escapeHtml(point.pricePoint === "unbekannt" ? "unbekannt" : `$${point.pricePoint}`)}</td>
              <td>${number(point.studentCount)}</td>
              <td>${money(point.income)}</td>
              <td>${number(point.paidLessons)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `;
  }

  function renderRecommendationTable(recommendations) {
    if (!recommendations.length) {
      return `<p class="pp-empty">Keine klaren Empfehlungskandidaten für Preiserhöhungen gefunden.</p>`;
    }

    return `
      <table class="pp-table">
        <thead>
          <tr>
            <th>Schüler</th>
            <th>Aktueller Preis</th>
            <th>Bezahlte Einheiten</th>
            <th>Empfehlung</th>
            <th>Risiko</th>
          </tr>
        </thead>
        <tbody>
          ${recommendations.slice(0, 10).map((student) => `
            <tr>
              <td>${escapeHtml(student.student)}</td>
              <td>${student.currentPricePoint ? `$${number(student.currentPricePoint)}` : "unbekannt"}</td>
              <td>${number(student.paidLessons)}</td>
              <td>${escapeHtml(student.priceIncreaseRecommendation)}</td>
              <td>${escapeHtml(student.churnRisk)}</td>
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
