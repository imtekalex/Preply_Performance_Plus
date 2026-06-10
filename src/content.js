(() => {
  const ROOT_ID = "preply-plus-root";
  const MESSAGE_REQUEST = "PREPLY_PLUS_FETCH_REPORTS";
  const MESSAGE_RESPONSE = "PREPLY_PLUS_REPORTS_RESULT";
  const STUDENT_MESSAGE_REQUEST = "PREPLY_PLUS_FETCH_STUDENTS";
  const STUDENT_MESSAGE_RESPONSE = "PREPLY_PLUS_STUDENTS_RESULT";
  const DAY_MS = 24 * 60 * 60 * 1000;
  const CACHE_KEY = "preplyPlusTransactionCache";
  const STUDENT_CACHE_KEY = "preplyPlusStudentCache";
  const CACHE_VERSION = 2;
  const STUDENT_CACHE_VERSION = 3;
  const DEFAULT_HISTORY_START = "2000-01-01";
  const STUDENT_PAGE_SIZE = 20;
  const STUDENT_MANAGEMENT_QUERY = `query TutorStudentManagement($offset: Int!, $count: Int!, $archivedByTutor: Boolean, $orderField: TutoringSortFieldsEnum!, $orderDirection: CommonSortDirectionsEnum!, $includeOngoing: Boolean!, $clientName: String, $statuses: [TutoringStatusEnum!], $smartFilter: TutoringSmartFilter) {
  currentUser {
    id
    tutor {
      id
      studentManagementTutorings(offset: $offset, count: $count, archivedByTutor: $archivedByTutor, statuses: $statuses, smartFilter: $smartFilter, orderBy: {field: $orderField, direction: $orderDirection}, clientName: $clientName) {
        totalCount
        nodes {
          id
          clientName
          hasHoursToScheduleLesson
          client {
            id
            user {
              id
              firstName
              fullName
              __typename
            }
            __typename
          }
          status
          balanceUtilisation {
            totalHours
            utilisedHours
            __typename
          }
          nextLesson(includeOngoing: $includeOngoing) {
            id
            datetime
            __typename
          }
          refill {
            id
            billingFrequency
            nextSubscription
            __typename
          }
          __typename
        }
        __typename
      }
      __typename
    }
    __typename
  }
}`;

  let lastState = null;
  let pendingRequest = null;
  let pendingStudentRequest = null;
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

  const rateFormatter = new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2
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
      if (event.source !== window) {
        return;
      }

      if (event.data?.type === MESSAGE_RESPONSE) {
        if (!pendingRequest || event.data.requestId !== pendingRequest.requestId) {
          return;
        }
        pendingRequest.resolve(event.data);
        pendingRequest = null;
        return;
      }

      if (event.data?.type === STUDENT_MESSAGE_RESPONSE) {
        if (!pendingStudentRequest || event.data.requestId !== pendingStudentRequest.requestId) {
          return;
        }
        pendingStudentRequest.resolve(event.data);
        pendingStudentRequest = null;
      }
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

  async function refreshAnalytics({ force = false, fetchLatest = false, statusMessage = "Aktualisiere Kennzahlen ..." } = {}) {
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
    setStatus(statusMessage);

    try {
      const visible = scrapeVisibleMetrics();
      const transactionCache = await loadTransactionCache();
      const studentCache = await loadStudentCache();
      activeReportRanges = buildRanges(transactionCache, {
        fetchLatest,
        historyStart: visible.memberSinceStart || DEFAULT_HISTORY_START
      });
      let reportResult = { reports: [], errors: [] };

      if (activeReportRanges.length) {
        try {
          reportResult = await requestReports();
        } catch (error) {
          reportResult = await requestReportsDirect(error);
        }
      }

      reportResult = await mergeReportResultWithCache(transactionCache, reportResult);
      const studentResult = await getActiveStudentsWithCache(studentCache, { force: fetchLatest });
      lastState = buildState(visible, reportResult, studentResult);
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
          <h2>Geschäftskennzahlen</h2>
          <p id="pp-updated">Echtzeit-Kennzahlen werden geladen ...</p>
        </div>
        <div class="pp-actions">
          <button id="pp-refresh" type="button" title="Kennzahlen aktualisieren" aria-label="Kennzahlen aktualisieren">
            <span aria-hidden="true">↻</span>
          </button>
        </div>
      </div>
      <div id="pp-status" class="pp-status"></div>
      <div id="pp-content" class="pp-content" aria-live="polite"></div>
    `;

    anchor.insertAdjacentElement("afterend", root);
    root.querySelector("#pp-refresh").addEventListener("click", () => {
      scheduleRefresh(0, {
        force: true,
        fetchLatest: true,
        statusMessage: "Aktualisiere Kennzahlen: hole aktuelle CSV-Daten und Lernendenliste neu, gespeicherte Historie bleibt erhalten ..."
      });
    });
  }

  async function confirmAndClearCache() {
    const confirmed = window.confirm(
      "Gespeicherte CSV- und Lernenden-Daten löschen? Danach lädt Preply Performance Plus den kompletten Einnahmenbericht seit Beginn und die aktuelle Lernendenliste neu."
    );
    if (!confirmed) {
      return;
    }

    await clearAllCaches();
    hasAutoLoaded = false;
    selectedMonthYear = null;
    scheduleRefresh(0, {
      force: true,
      statusMessage: "Gespeicherte Daten gelöscht. Lade Einnahmenbericht seit Beginn und aktuelle Lernendenliste neu ..."
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

  async function requestActiveStudents() {
    const nodes = [];
    const errors = [];
    let totalCount = null;

    for (let offset = 0; offset < 1000; offset += STUDENT_PAGE_SIZE) {
      try {
        const page = await requestActiveStudentsPage(offset, STUDENT_PAGE_SIZE);
        totalCount = page.totalCount;
        nodes.push(...page.nodes);

        if (nodes.length >= totalCount || page.nodes.length === 0) {
          break;
        }
      } catch (error) {
        errors.push({
          id: "TutorStudentManagement",
          message: error instanceof Error ? error.message : String(error)
        });
        break;
      }
    }

    const students = nodes.map(normalizeManagedStudent);
    if (students.length && students.every((student) => !student.hasBalanceData)) {
      errors.push({
        id: "TutorStudentManagement.balanceUtilisation",
        message: "Preply liefert die aktuelle Lernendenliste, aber keine balanceUtilisation-Werte. Für Genutzt/Gesamt brauche ich eine anonymisierte node aus der TutorStudentManagement-Antwort."
      });
    }

    return {
      source: nodes.length ? "studentManagement" : "fallback",
      totalCount: totalCount ?? nodes.length,
      students,
      errors
    };
  }

  async function requestActiveStudentsPage(offset, count) {
    const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        if (pendingStudentRequest?.requestId === requestId) {
          pendingStudentRequest = null;
        }
        reject(new Error("Preply student request timed out"));
      }, 20000);

      pendingStudentRequest = {
        requestId,
        resolve: (value) => {
          window.clearTimeout(timeout);
          if (value.error) {
            reject(new Error(value.error));
            return;
          }
          resolve({
            totalCount: value.totalCount || 0,
            nodes: value.nodes || []
          });
        }
      };

      window.postMessage({
        type: STUDENT_MESSAGE_REQUEST,
        requestId,
        operationName: "TutorStudentManagement",
        variables: {
          offset,
          count,
          includeOngoing: true,
          orderField: "next_lesson_date",
          orderDirection: "asc",
          archivedByTutor: false
        },
        query: STUDENT_MANAGEMENT_QUERY
      }, window.location.origin);
    });
  }

  function normalizeManagedStudent(node) {
    const rawTotalHours = node.balanceUtilisation?.totalHours;
    const rawUtilisedHours = node.balanceUtilisation?.utilisedHours;
    const hasBalanceData = rawTotalHours != null || rawUtilisedHours != null;
    const totalHours = Number(rawTotalHours || 0);
    const utilisedHours = Number(rawUtilisedHours || 0);
    const outstandingHours = hasBalanceData ? Math.max(0, totalHours - utilisedHours) : null;
    const names = [
      node.clientName,
      node.client?.user?.fullName,
      node.client?.user?.firstName
    ].map((name) => cleanStudentName(name || "")).filter(Boolean);
    const fullName = names[0] || "";

    return {
      id: node.id,
      name: fullName,
      key: normalizeStudentKey(fullName),
      keys: [...new Set(names.map(normalizeStudentKey).filter(Boolean))],
      status: node.status || "",
      hasHoursToScheduleLesson: Boolean(node.hasHoursToScheduleLesson),
      hasBalanceData,
      outstandingHours,
      totalHours,
      utilisedHours,
      nextLessonDate: parseDate(node.nextLesson?.datetime || ""),
      nextSubscriptionDate: parseDate(node.refill?.nextSubscription || ""),
      billingFrequency: node.refill?.billingFrequency || ""
    };
  }

  function buildRanges(cache, { fetchLatest = false, historyStart = DEFAULT_HISTORY_START } = {}) {
    const { today } = getDateBoundaries();
    const todayISO = toISODate(today);
    const cachedEnd = cache?.end || "";

    if (cachedEnd && cachedEnd >= todayISO && !fetchLatest) {
      return [];
    }

    return [
      { id: "sinceBeginning", start: fetchLatest && cachedEnd ? todayISO : cachedEnd || historyStart, end: todayISO }
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
        if (!cache || cache.version !== CACHE_VERSION || !Array.isArray(cache.transactions)) {
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
          version: CACHE_VERSION,
          start: cache.start,
          end: cache.end,
          updatedAt: cache.updatedAt,
          transactions: cache.transactions.map(serializeTransaction)
        }
      }, resolve);
    });
  }

  function loadStudentCache() {
    return new Promise((resolve) => {
      chrome.storage.local.get(STUDENT_CACHE_KEY, (result) => {
        const cache = result?.[STUDENT_CACHE_KEY];
        if (!cache || cache.version !== STUDENT_CACHE_VERSION || !Array.isArray(cache.students)) {
          resolve({ students: [], totalCount: 0, updatedAt: null });
          return;
        }

        resolve({
          totalCount: cache.totalCount || cache.students.length,
          updatedAt: cache.updatedAt || null,
          students: cache.students.map(deserializeManagedStudent).filter(Boolean)
        });
      });
    });
  }

  function saveStudentCache(result) {
    return new Promise((resolve) => {
      chrome.storage.local.set({
        [STUDENT_CACHE_KEY]: {
          version: STUDENT_CACHE_VERSION,
          totalCount: result.totalCount || result.students?.length || 0,
          updatedAt: new Date().toISOString(),
          students: (result.students || []).map(serializeManagedStudent)
        }
      }, resolve);
    });
  }

  function clearAllCaches() {
    return new Promise((resolve) => chrome.storage.local.remove([CACHE_KEY, STUDENT_CACHE_KEY], resolve));
  }

  async function getActiveStudentsWithCache(cache, { force = false } = {}) {
    if (!force && isToday(cache.updatedAt) && cache.students.length) {
      return {
        source: "studentManagementCache",
        totalCount: cache.totalCount || cache.students.length,
        students: cache.students,
        errors: []
      };
    }

    const result = await requestActiveStudents();
    if (result.students.length) {
      await saveStudentCache(result);
      return result;
    }

    if (cache.students.length) {
      return {
        source: "studentManagementStaleCache",
        totalCount: cache.totalCount || cache.students.length,
        students: cache.students,
        errors: result.errors || []
      };
    }

    return result;
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
      lessonPrice: transaction.lessonPrice,
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

  function serializeManagedStudent(student) {
    return {
      ...student,
      nextLessonDate: student.nextLessonDate ? student.nextLessonDate.toISOString() : null,
      nextSubscriptionDate: student.nextSubscriptionDate ? student.nextSubscriptionDate.toISOString() : null
    };
  }

  function deserializeManagedStudent(student) {
    if (!student || typeof student !== "object") {
      return null;
    }

    return {
      ...student,
      nextLessonDate: student.nextLessonDate ? new Date(student.nextLessonDate) : null,
      nextSubscriptionDate: student.nextSubscriptionDate ? new Date(student.nextSubscriptionDate) : null
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
      currentLessonPrice: parseMoney(primaryMetricText('[data-qa-id="success-driver-price_per_lesson"]')),
      totalEarnings: parseMoney(primaryMetricText('[data-qa-id="lifetime-performance-total-earnings"]')),
      lifetimeLessons: parseNumber(primaryMetricText('[data-qa-id="lifetime-performance-lessons-taught"]')),
      lifetimeHours: parseNumber(primaryMetricText('[data-qa-id="lifetime-performance-hours-taught"]')),
      lifetimeStudents: parseNumber(primaryMetricText('[data-qa-id="lifetime-performance-total-students"]')),
      memberSinceStart: scrapeMemberSinceStartDate()
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

  function scrapeMemberSinceStartDate() {
    const text = document.body?.innerText || "";
    const match = text.match(/seit\s+du\s+im\s+([A-Za-zÄÖÜäöüß]+)\s+(\d{4})\s+beigetreten\s+bist/i);
    if (!match) {
      return null;
    }

    const month = parseGermanMonth(match[1]);
    const year = Number(match[2]);
    if (!month || !year) {
      return null;
    }

    return toISODate(new Date(year, month - 1, 1));
  }

  function parseGermanMonth(value) {
    const normalized = value.toLocaleLowerCase("de-DE");
    const months = {
      januar: 1,
      februar: 2,
      märz: 3,
      maerz: 3,
      april: 4,
      mai: 5,
      juni: 6,
      juli: 7,
      august: 8,
      september: 9,
      oktober: 10,
      november: 11,
      dezember: 12
    };

    return months[normalized] || 0;
  }

  function buildState(visible, reportResult, studentResult = { students: [], errors: [] }) {
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
    const trailingThreeMonthStart = new Date(boundaries.today.getFullYear(), boundaries.today.getMonth() - 2, 1);
    const trailingThreeMonths = summarizeTransactions(filterTransactionsByDate(
      allTransactions,
      trailingThreeMonthStart,
      boundaries.today
    ));
    const source = allTime.transactions.length ? "report" : "visible";
    const totalIncome = allTime.income || visible.totalEarnings || yearToDate.income || visible.chartEarnings || visible.overviewEarnings;
    const monthlyIncome = currentMonth.income || visible.chartEarnings || visible.overviewEarnings;
    const monthlyLessons = currentMonth.lessons || (source === "visible" ? visible.overviewLessons : 0);
    const managedStudentMap = buildManagedStudentMap(studentResult.students || []);
    const activeStudents = studentResult.totalCount || visible.activeStudents || currentMonth.students || allTime.students;
    const projectedIncome = projectMonth(monthlyIncome);
    const monthlyHours = currentMonth.hours;
    const avgPayoutLastThreeMonths = trailingThreeMonths.paidLessons ? trailingThreeMonths.income / trailingThreeMonths.paidLessons : 0;
    const avgHourlyRate = monthlyHours ? monthlyIncome / monthlyHours : 0;
    const students = rankStudents(allTime.transactions.length ? allTime.transactions : currentMonth.transactions);
    const activeStudentsForBenchmark = filterActiveStudents(students, managedStudentMap);
    const priceBenchmark = buildPriceBenchmark(activeStudentsForBenchmark, visible.currentLessonPrice);
    const monthlyBreakdown = buildMonthlyBreakdown(allTransactions);
    const avgWeeklyHours = calculateAverageWeeklyHours(allTime.hours, reportRange);
    const avgWeeklyLessons = calculateAverageWeeklyLessons(allTime.lessons, reportRange);
    const avgMonthlyLessons = calculateAverageMonthlyLessons(monthlyBreakdown);

    return {
      visible,
      reports,
      errors: [...(reportResult.errors || []), ...(studentResult.errors || [])],
      studentSource: studentResult.source || "fallback",
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
        avgPayoutLastThreeMonths,
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
      topStudents: activeStudentsForBenchmark,
      managedStudents: studentResult.students || [],
      priceBenchmark,
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
    const lessonCount = parseLessonCount(lessonEntry?.[1] || "", Boolean(dateEntry || typeEntry));
    const durationHours = parseDurationHours(durationEntry?.[1] || "", lessonCount);
    const lessonPrice = parseLessonPrice(lessonPriceEntry?.[1] || "");
    const fingerprint = Object.values(row).join("|");

    return {
      amount: parseMoney(amountEntry?.[1] || ""),
      student: cleanStudentName(studentEntry?.[1] || ""),
      date: parseDate(dateEntry?.[1] || ""),
      type: typeEntry?.[1] || "",
      lessonCount,
      durationHours,
      lessonPrice,
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
          priceWeightedSum: 0,
          priceLessonCount: 0,
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
      if (transaction.amount > 0 && transaction.lessonPrice > 0) {
        month.priceWeightedSum += transaction.lessonPrice * (transaction.lessonCount || 1);
        month.priceLessonCount += transaction.lessonCount || 1;
      }
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
          avgLessonPrice: month.priceLessonCount ? month.priceWeightedSum / month.priceLessonCount : 0,
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
          currentPrice: 0,
          currentPriceDate: null,
          firstPrice: 0,
          firstPriceDate: null,
          firstLessonDate: null,
          lastLessonDate: null,
          lastPaidDate: null,
          recentLessons: 0,
          transactions: 0
        });
      }
      const item = ranking.get(student);
      if (transaction.date) {
        if (!item.firstLessonDate || transaction.date < item.firstLessonDate) {
          item.firstLessonDate = transaction.date;
        }
        if (!item.lastLessonDate || transaction.date > item.lastLessonDate) {
          item.lastLessonDate = transaction.date;
        }
      }
      item.income += transaction.amount;
      item.lessons += transaction.lessonCount;
      item.hours += transaction.durationHours;
      item.lessonRows += transaction.hasLessonCount ? 1 : 0;
      item.durationRows += transaction.hasDuration ? 1 : 0;
      item.paidTransactions += transaction.amount > 0 ? 1 : 0;
      item.paidLessons += transaction.amount > 0 ? transaction.lessonCount : 0;
      if (transaction.amount > 0 && transaction.date && (!item.lastPaidDate || transaction.date > item.lastPaidDate)) {
        item.lastPaidDate = transaction.date;
      }
      if (transaction.amount > 0 && transaction.lessonPrice > 0) {
        const transactionDate = transaction.date || new Date(0);
        if (!item.firstPriceDate || transactionDate <= item.firstPriceDate) {
          item.firstPrice = transaction.lessonPrice;
          item.firstPriceDate = transactionDate;
        }
        if (!item.currentPriceDate || transactionDate >= item.currentPriceDate) {
          item.currentPrice = transaction.lessonPrice;
          item.currentPriceDate = transactionDate;
        }
      }
      if (transaction.date && transaction.amount > 0 && daysBetween(transaction.date, new Date()) <= 30) {
        item.recentLessons += transaction.lessonCount || 1;
      }
      item.transactions += 1;
    }

    return [...ranking.values()]
      .filter((item) => item.income > 0)
      .map((item) => {
        const lessons = item.lessonRows ? item.lessons : 0;
        const hours = item.durationRows ? item.hours : 0;
        const activeMonths = calculateActiveMonths(item.firstLessonDate, item.lastLessonDate);
        return {
          ...item,
          lessons,
          hours,
          activeMonths,
          avgLessonsPerMonth: activeMonths ? lessons / activeMonths : lessons,
          currentPrice: item.currentPrice,
          firstPrice: item.firstPrice,
          priceAgeDays: item.currentPriceDate ? daysBetween(item.currentPriceDate, new Date()) : null,
          bookingRate: item.paidTransactions ? item.income / item.paidTransactions : 0,
          hourlyRate: hours ? item.income / hours : 0,
          lessonRate: item.paidLessons ? item.income / item.paidLessons : 0
        };
      })
      .sort((a, b) => b.income - a.income);
  }

  function buildPriceBenchmark(students, targetPrice = 0) {
    const normalizedTargetPrice = Number(targetPrice) || 0;
    const groups = new Map();

    const enrichedStudents = students
      .map((student) => {
        const priceStatus = getPriceStatus(student, normalizedTargetPrice);
        return {
          ...student,
          targetPrice: normalizedTargetPrice,
          priceGap: calculatePriceGap(student.currentPrice, normalizedTargetPrice),
          priceGapPercent: calculatePriceGapPercent(student.currentPrice, normalizedTargetPrice),
          priceStatus
        };
      });

    for (const student of enrichedStudents) {
      const key = student.currentPrice ? String(Math.round(student.currentPrice * 100)) : "unbekannt";
      if (!groups.has(key)) {
        groups.set(key, {
          price: student.currentPrice || 0,
          label: student.currentPrice ? rateMoney(student.currentPrice) : "unbekannt",
          students: [],
          income: 0,
          lessons: 0,
          paidLessons: 0,
          hasBalanceData: false,
          outstandingHours: 0,
          totalHours: 0,
          utilisedHours: 0,
          maxPriority: 0
        });
      }

      const group = groups.get(key);
      group.students.push(student);
      group.income += student.income;
      group.lessons += student.lessons || student.transactions;
      group.paidLessons += student.paidLessons || 0;
      group.hasBalanceData = group.hasBalanceData || student.hasBalanceData;
      group.outstandingHours += student.outstandingHours || 0;
      group.totalHours += student.totalHours || 0;
      group.utilisedHours += student.utilisedHours || 0;
      group.maxPriority = Math.max(group.maxPriority, student.priceStatus?.priority || 0);
    }

    return [...groups.values()]
      .map((group) => ({
        ...group,
        avgEarning: group.paidLessons ? group.income / group.paidLessons : 0,
        studentCount: group.students.length,
        students: group.students.sort(comparePriceStudents)
      }))
      .sort((a, b) => {
        if (!a.price) {
          return 1;
        }
        if (!b.price) {
          return -1;
        }
        return b.price - a.price;
      });
  }

  function comparePriceStudents(a, b) {
    const priorityDelta = (b.priceStatus?.priority || 0) - (a.priceStatus?.priority || 0);
    if (priorityDelta) {
      return priorityDelta;
    }

    const incomeDelta = b.income - a.income;
    if (incomeDelta) {
      return incomeDelta;
    }

    const lessonDelta = (b.lessons || b.transactions) - (a.lessons || a.transactions);
    if (lessonDelta) {
      return lessonDelta;
    }

    return a.student.localeCompare(b.student, "de");
  }

  function buildManagedStudentMap(students) {
    const map = new Map();

    for (const student of students) {
      for (const key of student.keys?.length ? student.keys : [student.key]) {
        if (key) {
          map.set(key, student);
        }
      }
    }

    return map;
  }

  function filterActiveStudents(students, managedStudentMap) {
    if (!managedStudentMap.size) {
      return students.filter((student) => student.recentLessons > 0);
    }

    return students
      .map((student) => {
        const managedStudent = managedStudentMap.get(normalizeStudentKey(student.student));
        return managedStudent && isCurrentManagedStudent(managedStudent)
          ? {
              ...student,
              managedStatus: managedStudent.status,
              hasHoursToScheduleLesson: managedStudent.hasHoursToScheduleLesson,
              hasBalanceData: managedStudent.hasBalanceData,
              outstandingHours: managedStudent.outstandingHours,
              totalHours: managedStudent.totalHours,
              utilisedHours: managedStudent.utilisedHours,
              nextLessonDate: managedStudent.nextLessonDate,
              nextSubscriptionDate: managedStudent.nextSubscriptionDate,
              billingFrequency: managedStudent.billingFrequency
            }
          : null;
      })
      .filter(Boolean);
  }

  function isCurrentManagedStudent(student) {
    const status = String(student.status || "").toUpperCase();
    if (!status) {
      return true;
    }

    if (/CANCEL|ARCHIV|INACTIVE|FINISHED|ENDED/.test(status)) {
      return false;
    }

    if (status === "ACTIVE_SUBSCRIPTION" || status === "PACKAGE") {
      return true;
    }

    return Boolean(student.hasHoursToScheduleLesson || student.nextLessonDate || student.hasBalanceData);
  }

  function normalizeStudentKey(value) {
    return cleanStudentName(value)
      .toLocaleLowerCase("de-DE")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  }

  function getPriceStatus(student, targetPrice) {
    if (!targetPrice) {
      return {
        action: "unbekannt",
        reason: "aktueller Preply-Preis konnte nicht gelesen werden",
        priority: 0
      };
    }

    if (!student.currentPrice) {
      return {
        action: "unbekannt",
        reason: `kein Lesson Price in der CSV, Zielpreis ${rateMoney(targetPrice)}`,
        priority: 0
      };
    }

    const gapPercent = calculatePriceGapPercent(student.currentPrice, targetPrice);
    if (!gapPercent || gapPercent <= 0.100001) {
      return {
        action: "ok",
        reason: `maximal 10% unter aktuellem Preis ${rateMoney(targetPrice)}`,
        priority: 0
      };
    }

    if (gapPercent <= 0.200001) {
      return {
        action: "prüfen",
        reason: `${formatPriceGap(student.currentPrice, targetPrice)} unter aktuellem Preis ${rateMoney(targetPrice)}`,
        priority: 2
      };
    }

    return {
      action: "dringend",
      reason: `${formatPriceGap(student.currentPrice, targetPrice)} unter aktuellem Preis ${rateMoney(targetPrice)}`,
      priority: 3
    };
  }

  function calculatePriceGap(currentPrice, targetPrice) {
    if (!currentPrice || !targetPrice || currentPrice >= targetPrice) {
      return 0;
    }

    return targetPrice - currentPrice;
  }

  function calculatePriceGapPercent(currentPrice, targetPrice) {
    if (!currentPrice || !targetPrice || currentPrice >= targetPrice) {
      return 0;
    }

    return (targetPrice - currentPrice) / targetPrice;
  }

  function formatPriceGap(currentPrice, targetPrice) {
    const gap = calculatePriceGapPercent(currentPrice, targetPrice);
    return gap ? `${Math.round(gap * 100)}%` : "0%";
  }

  function calculateActiveMonths(start, end) {
    if (!start || !end) {
      return 0;
    }

    return Math.max(1, ((startOfDay(end) - startOfDay(start)) / DAY_MS + 1) / 30.4375);
  }

  function daysBetween(start, end) {
    return Math.max(0, Math.round((startOfDay(end) - startOfDay(start)) / DAY_MS));
  }

  function daysUntil(date) {
    if (!date || Number.isNaN(date.getTime())) {
      return null;
    }

    return Math.round((startOfDay(date) - startOfDay(new Date())) / DAY_MS);
  }

  function render(state) {
    const updated = document.getElementById("pp-updated");
    const status = document.getElementById("pp-status");
    const content = document.getElementById("pp-content");

    if (!updated || !status || !content) {
      return;
    }

    updated.textContent = `Echtzeit-Kennzahlen aktualisiert: ${dateFormatter.format(state.updatedAt)}, ${timeFormatter.format(state.updatedAt)} Uhr.`;
    const studentSourceText = formatStudentSource(state.studentSource);
    status.innerHTML = state.source === "report"
      ? `Datenquelle: CSV-Einnahmenbericht ${formatISODate(state.reportRange.start)} - ${formatISODate(state.reportRange.end)}.${studentSourceText} <button id="pp-clear-cache-link" class="pp-clear-link" type="button">Löschen</button>`
      : "Datenquelle: sichtbare Preply-Kennzahlen. Der CSV-Bericht konnte noch nicht gelesen werden.";

    content.innerHTML = `
      <div class="pp-grid">
        ${metricCard("Einnahmen gesamt", money(state.metrics.totalIncome), "seit Beginn")}
        ${metricCard("Ø Auszahlung", money(state.metrics.avgPayoutLastThreeMonths), "pro bezahlter Einheit in den letzten 3 Monaten")}
        ${metricCard("Prognose Monat", money(state.metrics.projectedIncome), "hochgerechnet bis Monatsende")}
        ${metricCard("Monatseinnahmen", money(state.metrics.monthlyIncome), deltaText(state.metrics.monthDelta))}
      </div>
      <div class="pp-panel pp-wide-panel">
        <div class="pp-panel-heading">
          <h3>Jahresübersicht ${getSelectedMonthYear(state.monthlyBreakdown)}</h3>
          ${renderMonthPager(state.monthlyBreakdown)}
        </div>
        ${renderMonthlyBreakdown(state.monthlyBreakdown)}
      </div>
      <div class="pp-split">
        <div class="pp-panel">
          <h3>Lernenden-Ranking</h3>
          ${renderStudentTable(state.topStudents)}
        </div>
        <div class="pp-panel">
          <h3>Weitere Kennzahlen</h3>
          <div class="pp-insights">
            ${insight("Ø Einheiten pro Monat", number(state.metrics.avgMonthlyLessons), "seit Beginn")}
            ${state.metrics.avgWeeklyHours
              ? insight("Ø Wochenstunden", `${number(state.metrics.avgWeeklyHours)} h`, "seit Beginn")
              : insight("Ø Einheiten pro Woche", number(state.metrics.avgWeeklyLessons), "seit Beginn")}
            ${insight("Lernende insgesamt", number(state.metrics.totalStudents), "seit Beginn")}
            ${insight("Aktive Lernende", number(state.metrics.activeStudents), "aktuell")}
          </div>
        </div>
      </div>
      <div class="pp-panel pp-wide-panel">
        <h3>Preisvergleich aktiver Lernender</h3>
        ${renderPriceBenchmark(state.priceBenchmark)}
      </div>
      ${state.errors.length ? `<details class="pp-debug"><summary>Hinweise zur Datenerfassung</summary><pre>${escapeHtml(JSON.stringify(state.errors, null, 2))}</pre></details>` : ""}
    `;
    bindMonthPager();
    bindPriceGroups();
    bindRankingToggle();
    document.getElementById("pp-clear-cache-link")?.addEventListener("click", confirmAndClearCache);
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
            ${hasHours ? "<th>Stunden</th><th>Ø pro Stunde</th>" : ""}
            <th>Ø Preis</th>
            <th>Ø Lohn</th>
          </tr>
        </thead>
        <tbody>
          ${yearMonths.map((month) => `
            <tr>
              <td>${escapeHtml(formatMonth(month.date))}</td>
              <td>${money(month.income)}</td>
              <td>${number(month.lessons || month.transactions)}</td>
              ${hasHours ? `<td>${number(month.hours)}</td><td>${rateOrNA(month.hourlyRate)}</td>` : ""}
              <td>${rateOrNA(month.avgLessonPrice)}</td>
              <td>${rateOrNA(month.lessonRate || month.bookingRate)}</td>
            </tr>
          `).join("")}
          <tr class="pp-summary-row">
            <td>Durchschnitt</td>
            <td>${money(summary.avgIncome)}</td>
            <td>${number(summary.avgLessons)}</td>
            ${hasHours ? `<td>${number(summary.avgHours)}</td><td>${rateOrNA(summary.avgHourlyRate)}</td>` : ""}
            <td>${rateOrNA(summary.avgLessonPrice)}</td>
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
    const priceWeightedSum = months.reduce((total, month) => total + month.priceWeightedSum, 0);
    const priceLessonCount = months.reduce((total, month) => total + month.priceLessonCount, 0);
    const hours = months.reduce((total, month) => total + month.hours, 0);

    return {
      monthCount,
      income,
      avgIncome: monthCount ? income / monthCount : 0,
      avgTransactions: monthCount ? transactions / monthCount : 0,
      avgLessons: monthCount ? lessons / monthCount : 0,
      avgHours: monthCount ? hours / monthCount : 0,
      avgLessonPrice: priceLessonCount ? priceWeightedSum / priceLessonCount : 0,
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
      return `<p class="pp-empty">Noch keine Lernenden-Daten gefunden. Öffne einmal den Einnahmenbericht als CSV oder prüfe im Debug-Hinweis, ob Preply die Spaltennamen geändert hat.</p>`;
    }

    const hasHours = students.some((student) => student.hours > 0);

    return `
      <table class="pp-table pp-student-table pp-with-rank ${hasHours ? "pp-has-hours" : "pp-no-hours"}">
        ${renderStudentColgroup(hasHours)}
        <thead>
          ${renderStudentHeader(hasHours)}
        </thead>
        <tbody>
          ${renderStudentRows(students.slice(0, 5), hasHours)}
          ${students.length > 5 ? `
            <tr class="pp-ranking-toggle-row">
              <td colspan="${hasHours ? 9 : 7}">
                <button class="pp-ranking-toggle" type="button" data-pp-ranking-toggle aria-expanded="false">${number(students.length - 5)} weitere Lernende anzeigen</button>
              </td>
            </tr>
            ${renderStudentRows(students.slice(5), hasHours, 5, true)}
          ` : ""}
        </tbody>
      </table>
    `;
  }

  function renderStudentColgroup(hasHours, includeRank = true) {
    return `
      <colgroup>
        ${includeRank ? '<col class="pp-col-rank">' : ""}
        <col class="pp-col-student">
        <col class="pp-col-income">
        <col class="pp-col-lessons">
        <col class="pp-col-balance">
        ${hasHours ? '<col class="pp-col-hours"><col class="pp-col-hourly">' : ""}
        <col class="pp-col-price">
        <col class="pp-col-wage">
      </colgroup>
    `;
  }

  function renderStudentHeader(hasHours, includeRank = true) {
    return `
      <tr>
        ${includeRank ? "<th>Rang</th>" : ""}
        <th>Lernende</th>
        <th>Einnahmen</th>
        <th>Einheiten</th>
        <th>Abo</th>
        ${hasHours ? "<th>Stunden</th><th>Ø pro Stunde</th>" : ""}
        <th title="Lesson Price">Preis</th>
        <th title="Earning, USD pro bezahlter Einheit">Lohn</th>
      </tr>
    `;
  }

  function renderStudentRows(students, hasHours, offset = 0, hidden = false, includeRank = true) {
    return students.map((student, index) => `
      <tr${hidden ? ' class="pp-ranking-extra-row pp-hidden"' : ""}>
        ${includeRank ? `<td class="pp-cell-rank">${offset + index + 1}</td>` : ""}
        <td class="pp-cell-student">${escapeHtml(student.student)}</td>
        <td class="pp-cell-income">${money(student.income)}</td>
        <td class="pp-cell-lessons">${number(student.lessons || student.transactions)}</td>
        <td class="pp-cell-balance">${renderBalanceProgress(student)}</td>
        ${hasHours ? `<td class="pp-cell-hours">${number(student.hours)}</td><td class="pp-cell-hourly">${rateOrNA(student.hourlyRate)}</td>` : ""}
        <td class="pp-cell-price">${rateOrNA(student.currentPrice)}</td>
        <td class="pp-cell-wage">${rateOrNA(student.lessonRate)}</td>
      </tr>
    `).join("");
  }

  function bindRankingToggle() {
    const button = document.querySelector("[data-pp-ranking-toggle]");
    if (!button) {
      return;
    }

    const hiddenCount = document.querySelectorAll(".pp-ranking-extra-row").length;
    button.addEventListener("click", () => {
      const isOpen = button.getAttribute("aria-expanded") === "true";
      document.querySelectorAll(".pp-ranking-extra-row").forEach((row) => {
        row.classList.toggle("pp-hidden", isOpen);
      });
      button.setAttribute("aria-expanded", isOpen ? "false" : "true");
      button.textContent = isOpen
        ? `${number(hiddenCount)} weitere Lernende anzeigen`
        : "Weitere Lernende ausblenden";
    });
  }

  function renderPriceBenchmark(groups) {
    if (!groups.length) {
      return `<p class="pp-empty">Noch keine Preisdaten gefunden. Dafür braucht die CSV die Spalte Lesson Price, USD.</p>`;
    }

    const targetPrice = groups.find((group) => group.students.some((student) => student.targetPrice))?.students.find((student) => student.targetPrice)?.targetPrice || 0;
    return `
      <p class="pp-section-note">Aktueller Preply-Preis: ${targetPrice ? rateMoney(targetPrice) : "unbekannt"}</p>
      <table class="pp-table pp-price-table">
        <thead>
          <tr>
            <th title="Lesson Price">Preis</th>
            <th title="Earning, USD pro bezahlter Einheit">Lohn</th>
            <th>Details</th>
            <th>Status</th>
            <th>Einnahmen</th>
            <th>Einheiten</th>
          </tr>
        </thead>
        <tbody>
          ${groups.map((group, index) => renderPriceGroup(group, index)).join("")}
        </tbody>
      </table>
    `;
  }

  function renderPriceGroup(group, index) {
    const isOpen = false;
    const groupId = `pp-price-group-${index}`;
    const hasHours = group.students.some((student) => student.hours > 0);
    return `
      <tr class="pp-price-group-row ${group.maxPriority ? `pp-priority-row pp-priority-row-${group.maxPriority}` : ""}" data-pp-group="${groupId}" role="button" tabindex="0" aria-expanded="${isOpen ? "true" : "false"}">
        <td><span class="pp-row-caret" aria-hidden="true"></span>${escapeHtml(group.label)}</td>
        <td>${rateOrNA(group.avgEarning)}</td>
        <td>${number(group.studentCount)} Lernende</td>
        <td>${renderGroupPriceStatus(group)}</td>
        <td>${money(group.income)}</td>
        <td>${number(group.lessons)} Einheiten</td>
      </tr>
      <tr class="pp-price-detail-row ${isOpen ? "" : "pp-hidden"}" data-pp-group-details="${groupId}">
        <td colspan="6">
          <table class="pp-table pp-student-table pp-without-rank ${hasHours ? "pp-has-hours" : "pp-no-hours"} pp-price-detail-table">
            ${renderStudentColgroup(hasHours, false)}
            <thead>
              ${renderStudentHeader(hasHours, false)}
            </thead>
            <tbody>
              ${renderStudentRows(group.students, hasHours, 0, false, false)}
            </tbody>
          </table>
        </td>
      </tr>
    `;
  }

  function bindPriceGroups() {
    document.querySelectorAll("[data-pp-group]").forEach((row) => {
      const toggle = () => {
        const groupId = row.getAttribute("data-pp-group");
        const detailRow = document.querySelector(`[data-pp-group-details="${groupId}"]`);
        if (!detailRow) {
          return;
        }

        const isOpen = row.getAttribute("aria-expanded") === "true";
        row.setAttribute("aria-expanded", isOpen ? "false" : "true");
        detailRow.classList.toggle("pp-hidden", isOpen);
      };

      row.addEventListener("click", toggle);
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          toggle();
        }
      });
    });
  }

  function renderGroupPriceStatus(group) {
    const status = getGroupPriceStatus(group);
    const representative = group.students
      .find((student) => (student.priceStatus?.priority || 0) === status.priority)
      || group.students[0]
      || {};
    const details = [
      representative.priceStatus?.reason,
      representative.targetPrice ? `Zielpreis: ${rateMoney(representative.targetPrice)}` : "",
      representative.priceGap ? `Abstand: ${rateMoney(representative.priceGap)} (${formatPercent(representative.priceGapPercent)})` : ""
    ].filter(Boolean);

    return `
      <div class="pp-status-cell">
        <span class="pp-badge pp-badge-${status.priority || 0}">${escapeHtml(status.action)}</span>
        ${details.map((detail) => `<small>${escapeHtml(detail)}</small>`).join("")}
      </div>
    `;
  }

  function getGroupPriceStatus(group) {
    if (group.maxPriority >= 3) {
      return { label: "dringend", priority: 3 };
    }

    if (group.maxPriority === 2) {
      return { label: "prüfen", priority: 2 };
    }

    if (group.students.every((student) => student.priceStatus?.action === "unbekannt")) {
      return { label: "unbekannt", priority: 0 };
    }

    return { label: "ok", priority: 0 };
  }

  function formatSubscription(student) {
    if (!student.nextSubscriptionDate) {
      return student.billingFrequency ? escapeHtml(student.billingFrequency) : "n/a";
    }

    const days = daysUntil(student.nextSubscriptionDate);
    const prefix = days >= 0 && days <= 14 ? "bald · " : "";
    return `${prefix}${formatShortDate(student.nextSubscriptionDate)}`;
  }

  function renderBalanceProgress(item, { showSubscription = false } = {}) {
    if (!item?.hasBalanceData) {
      return showSubscription && item ? `<span>n/a</span><small class="pp-muted">${formatSubscription(item)}</small>` : "n/a";
    }

    const total = Number(item.totalHours || 0);
    const used = Number(item.utilisedHours || 0);
    const percent = total ? Math.max(0, Math.min(100, (used / total) * 100)) : 0;
    return `
      <div class="pp-progress-cell" title="${escapeHtml(formatBalance(item))}">
        <div class="pp-progress" role="progressbar" aria-label="Abo-Einheiten ${escapeHtml(formatBalance(item))}" aria-valuenow="${used}" aria-valuemin="0" aria-valuemax="${total}">
          <span style="width: ${percent}%"></span>
        </div>
        <span>${formatBalance(item)}</span>
        ${showSubscription ? `<small class="pp-muted">${formatSubscription(item)}</small>` : ""}
      </div>
    `;
  }

  function formatBalance(item) {
    if (!item?.hasBalanceData) {
      return "n/a";
    }

    return `${number(item.utilisedHours)} / ${number(item.totalHours)}`;
  }

  function formatShortDate(date) {
    if (!date || Number.isNaN(date.getTime())) {
      return "n/a";
    }

    return dateFormatter.format(date);
  }

  function formatStudentSource(source) {
    if (source === "studentManagement") {
      return " Lernendenliste: live geladen.";
    }

    if (source === "studentManagementCache") {
      return " Lernendenliste: heute gespeichert.";
    }

    if (source === "studentManagementStaleCache") {
      return " Lernendenliste: gespeicherter Snapshot.";
    }

    return "";
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

  function rateMoney(value) {
    return rateFormatter.format(value || 0);
  }

  function rateOrNA(value) {
    return value ? rateMoney(value) : "n/a";
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

  function isToday(value) {
    if (!value) {
      return false;
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return false;
    }

    return toISODate(date) === toISODate(new Date());
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
